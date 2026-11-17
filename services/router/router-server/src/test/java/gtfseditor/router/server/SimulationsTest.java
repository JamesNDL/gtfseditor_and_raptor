package gtfseditor.router.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Simulation runs over HTTP (phase S2 of docs/simulator-plan.md), on a hand-made feed: stops A, B,
 * C and D about 2 km apart on one train line, with trains from A at 08:00 and 09:00.
 */
class SimulationsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String DEMAND = """
            user_id,start_time,origin_stop,destination_stop,people
            u1,07:50,A,D,1
            u2,07:55,A,C,2
            u3,08:50,B,D,1
            u1,12:00,D,A,1
            """;

    @TempDir
    Path folder;

    private RouterServer server;
    private HttpClient client;
    private HttpServer other;

    @BeforeEach
    void start() {
        server = new RouterServer(Settings.defaults(folder.resolve("data")).withPort(0)).start();
        client = HttpClient.newHttpClient();
    }

    @AfterEach
    void stop() {
        client.close();
        server.close();
        if (other != null) {
            other.stop(0);
        }
    }

    /** @param firstTrain when the first train leaves A, as HH:MM; it takes ten minutes between stops */
    private Path feed(String name, String firstTrain) throws Exception {
        int hour = Integer.parseInt(firstTrain.substring(0, 2));
        int minute = Integer.parseInt(firstTrain.substring(3));
        StringBuilder times = new StringBuilder("trip_id,arrival_time,departure_time,stop_id,stop_sequence\n");
        String[] stops = {"A", "B", "C", "D"};
        for (int i = 0; i < 4; i++) {
            int at = hour * 60 + minute + i * 10;
            String time = String.format("%02d:%02d:00", at / 60, at % 60);
            times.append("S1,").append(time).append(',').append(time).append(',').append(stops[i]).append(',')
                    .append(i + 1).append('\n');
            times.append(String.format("S2,09:%02d:00,09:%02d:00,%s,%d%n", i * 10, i * 10, stops[i], i + 1));
        }
        Map<String, String> files = Map.of(
                "calendar.txt", """
                        service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
                        DAY,0,1,0,0,0,0,0,20261117,20261117
                        """,
                "routes.txt", """
                        route_id,route_short_name,route_type
                        TRAIN,T1,2
                        """,
                "stops.txt", """
                        stop_id,stop_name,stop_lat,stop_lon
                        A,Stop A,-33.00,151.0
                        B,Stop B,-33.02,151.0
                        C,Stop C,-33.04,151.0
                        D,Stop D,-33.06,151.0
                        """,
                "trips.txt", """
                        route_id,service_id,trip_id,trip_headsign
                        TRAIN,DAY,S1,To D
                        TRAIN,DAY,S2,To D
                        """,
                "stop_times.txt", times.toString());
        Path zip = folder.resolve(name);
        try (OutputStream out = Files.newOutputStream(zip); ZipOutputStream entries = new ZipOutputStream(out)) {
            for (Map.Entry<String, String> file : files.entrySet()) {
                entries.putNextEntry(new ZipEntry(file.getKey()));
                entries.write(file.getValue().getBytes(StandardCharsets.UTF_8));
                entries.closeEntry();
            }
        }
        return zip;
    }

    private record Answer(int status, JsonNode body) {}

    private Answer send(String method, String path, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + server.port() + path))
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body));
        if (body != null) {
            request.header("Content-Type", "application/json");
        }
        HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        String text = response.body();
        return new Answer(response.statusCode(), text.isBlank() || !text.strip().startsWith("{") ? null : JSON.readTree(text));
    }

    private Answer get(String path) throws Exception {
        return send("GET", path, null);
    }

    private void load(String id, Path zip, String version) throws Exception {
        assertEquals(202, send("PUT", "/v1/timetables/" + id, JSON.writeValueAsString(
                Map.of("source", Map.of("path", zip.toString()), "version", version))).status());
        for (int i = 0; i < 400; i++) {
            Answer answer = get("/v1/timetables/" + id);
            if (answer.status() == 200 && !answer.body().has("building")) {
                assertEquals("ready", answer.body().get("status").asText(), answer.body().toString());
                assertEquals(version, answer.body().get("version").asText());
                return;
            }
            Thread.sleep(25);
        }
        fail("timetable " + id + " was still building after ten seconds");
    }

    private Path demandFile() throws Exception {
        Path file = folder.resolve("demand.csv");
        Files.writeString(file, DEMAND);
        return file;
    }

    private Answer submit(Map<String, Object> request) throws Exception {
        return send("POST", "/v1/simulations", JSON.writeValueAsString(request));
    }

    /** Waits for a run to leave the queue and stop running, and hands back how it ended. */
    private JsonNode ended(String id) throws Exception {
        for (int i = 0; i < 800; i++) {
            JsonNode run = get("/v1/simulations/" + id).body();
            String state = run.get("state").asText();
            if (!state.equals("queued") && !state.equals("running")) {
                return run;
            }
            Thread.sleep(25);
        }
        return fail("run " + id + " had not ended after twenty seconds");
    }

    private JsonNode done(Map<String, Object> request) throws Exception {
        Answer accepted = submit(request);
        assertEquals(202, accepted.status(), String.valueOf(accepted.body()));
        JsonNode run = ended(accepted.body().get("id").asText());
        assertEquals("done", run.get("state").asText(), run.toString());
        return run;
    }

    private List<String> lines(String run, String file) throws Exception {
        HttpResponse<byte[]> response = client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + server.port()
                + "/v1/simulations/" + run + "/files/" + file)).build(), HttpResponse.BodyHandlers.ofByteArray());
        assertEquals(200, response.statusCode());
        assertEquals("application/gzip", response.headers().firstValue("Content-Type").orElse(""));
        List<String> lines = new ArrayList<>();
        try (BufferedReader in = new BufferedReader(new InputStreamReader(
                new GZIPInputStream(new ByteArrayInputStream(response.body())), StandardCharsets.UTF_8))) {
            for (String line = in.readLine(); line != null; line = in.readLine()) {
                lines.add(line);
            }
        }
        return lines;
    }

    /** A demand file at a URL that does not answer until told to. */
    private String heldDemand(CountDownLatch asked, CountDownLatch release) throws Exception {
        other = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        other.createContext("/demand.csv", exchange -> {
            asked.countDown();
            try {
                release.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            byte[] body = DEMAND.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        other.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        other.start();
        return "http://localhost:" + other.getAddress().getPort() + "/demand.csv";
    }

    @Test
    void aBauRunIsSubmittedFollowedAndCollected() throws Exception {
        load("b1", feed("published.zip", "08:00"), "v1");
        Answer accepted = submit(Map.of("timetable", "b1", "id", "bau-1", "name", "BAU test",
                "demand", Map.of("path", demandFile().toString()), "settings", Map.of("walkMetres", 400)));
        assertEquals(202, accepted.status(), String.valueOf(accepted.body()));
        assertEquals("bau-1", accepted.body().get("id").asText());
        assertEquals("bau", accepted.body().get("kind").asText());
        assertTrue(List.of("queued", "running", "done").contains(accepted.body().get("state").asText()));

        JsonNode run = ended("bau-1");
        assertEquals("done", run.get("state").asText(), run.toString());
        assertEquals("BAU test", run.get("name").asText());
        assertEquals("b1", run.get("timetable").asText());
        assertEquals("v1", run.get("timetableVersion").asText());
        assertTrue(run.has("startedAt") && run.has("finishedAt") && run.has("elapsedSecs"));
        JsonNode summary = run.get("summary");
        assertEquals("bau", summary.get("kind").asText());
        assertEquals(4, summary.get("people").get("ok").asInt());
        assertEquals(1, summary.get("people").get("noJourney").asInt(), "nothing runs back from D to A");
        assertEquals(400, summary.get("settings").get("walkMetres").asInt());
        assertTrue(run.get("files").toString().contains("journeys.csv.gz"));

        List<String> journeys = lines("bau-1", "journeys.csv.gz");
        assertEquals(5, journeys.size(), "a header and four journeys");
        assertTrue(journeys.get(0).startsWith("journey_id,part,user_id,people,status"));
        assertTrue(lines("bau-1", "trip_loads.csv.gz").size() > 4);
        Answer file = get("/v1/simulations/bau-1/files/summary.json");
        assertEquals(200, file.status());
        assertEquals("BAU test", file.body().get("name").asText());

        JsonNode listed = get("/v1/simulations").body().get("simulations");
        assertEquals(1, listed.size());
        assertEquals("bau-1", listed.get(0).get("id").asText());
        assertEquals(4, listed.get(0).get("people").get("ok").asInt());
        assertFalse(listed.get(0).has("summary"), "the list is short; the summary is at the run's own address");
    }

    @Test
    void aScenarioRunIsMadeAgainstABauRunAndCapacityAddedFromKeptPlans() throws Exception {
        load("b1", feed("published.zip", "08:00"), "v1");
        done(Map.of("timetable", "b1", "id", "bau", "demand", Map.of("path", demandFile().toString())));

        // The first train now leaves half an hour later.
        load("b1-s7", feed("scenario.zip", "08:30"), "s7-head3");
        JsonNode scenario = done(Map.of("timetable", "b1-s7", "id", "s7", "bau", "bau",
                "settings", Map.of("giveUpSecs", 1200)));
        assertEquals("scenario", scenario.get("kind").asText());
        assertEquals("s7-head3", scenario.get("timetableVersion").asText());
        JsonNode against = scenario.get("summary").get("againstBau");
        assertEquals(3, against.get("gaveUp").asInt(), "the three on the 08:00 would arrive 30 minutes later");
        assertEquals(1, against.get("within1Minute").asInt());
        assertFalse(scenario.get("files").toString().contains("demand.csv.gz"), "the demand stays with the BAU run");

        JsonNode patient = done(Map.of("timetable", "b1-s7", "bau", "bau", "settings",
                java.util.Collections.singletonMap("giveUpSecs", null)));
        assertEquals(3, patient.get("summary").get("againstBau").get("later").asInt());
        assertTrue(patient.get("id").asText().startsWith("run-"), "a run is given an id if it brings none");
        assertEquals("b1-s7 against BAU, whole network", patient.get("name").asText());

        JsonNode crowded = done(Map.of("timetable", "b1", "id", "bau-capacity", "fromPlans", "bau"));
        assertEquals("capacity", crowded.get("kind").asText());
        assertEquals(true, crowded.get("summary").get("capacity").asBoolean());
        assertEquals(4, crowded.get("summary").get("people").get("ok").asInt());

        // Kept plans are for the timetable they were made on.
        Answer wrong = submit(Map.of("timetable", "b1-s7", "id", "wrong", "fromPlans", "bau"));
        assertEquals(202, wrong.status());
        JsonNode failed = ended("wrong");
        assertEquals("failed", failed.get("state").asText());
        assertTrue(failed.get("error").asText().contains("different timetable"), failed.toString());
        assertFalse(Files.exists(folder.resolve("data/sim/wrong")), "a run that failed leaves no files");

        // A BAU run that others were made from is not discarded by accident.
        Answer refused = send("DELETE", "/v1/simulations/bau", null);
        assertEquals(409, refused.status());
        assertTrue(refused.body().get("error").asText().contains("s7"), refused.body().toString());
        assertEquals(204, send("DELETE", "/v1/simulations/s7", null).status());
        assertEquals(404, get("/v1/simulations/s7").status());
        assertFalse(Files.exists(folder.resolve("data/sim/s7")));
        assertEquals(204, send("DELETE", "/v1/simulations/bau?force=true", null).status());
        assertEquals(204, send("DELETE", "/v1/simulations/wrong", null).status(), "a failed run is discarded too");
    }

    @Test
    void requestsThatCannotBeRunAreRefusedWithAReason() throws Exception {
        String demand = demandFile().toString();
        assertEquals(400, submit(Map.of("demand", Map.of("path", demand))).status(), "no timetable is loaded");
        load("b1", feed("published.zip", "08:00"), "v1");

        for (Map<String, Object> bad : List.<Map<String, Object>>of(
                Map.of("timetable", "b1"),
                Map.of("timetable", "b1", "demand", Map.of("path", demand), "bau", "x"),
                Map.of("timetable", "b1", "demand", Map.of()),
                Map.of("timetable", "b1", "demand", Map.of("path", folder.resolve("nothing.csv").toString())),
                Map.of("timetable", "b1", "demand", Map.of("url", "ftp://example.org/demand.csv")),
                Map.of("timetable", "b1", "demand", Map.of("path", demand), "id", "not an id"),
                Map.of("timetable", "b1", "demand", Map.of("path", demand), "settings", Map.of("walkMeters", 400)),
                Map.of("timetable", "b1", "demand", Map.of("path", demand), "settings", Map.of("walkMetres", 5000)),
                Map.of("timetable", "b1", "demand", Map.of("path", demand), "settings", Map.of("walkMetres", "far")),
                Map.of("timetable", "b1", "demand", Map.of("path", demand), "settings", Map.of("giveUpSecs", 1200)),
                Map.of("timetable", "b1", "demand", Map.of("path", demand), "settings", Map.of("area", "mars")))) {
            Answer answer = submit(bad);
            assertEquals(400, answer.status(), bad + " " + answer.body());
            assertFalse(answer.body().get("error").asText().isBlank());
        }
        assertEquals(404, submit(Map.of("timetable", "nowhere", "demand", Map.of("path", demand))).status());
        assertEquals(404, submit(Map.of("timetable", "b1", "bau", "no-such-run")).status());
        assertEquals(404, get("/v1/simulations/no-such-run").status());
        assertEquals(404, send("DELETE", "/v1/simulations/no-such-run", null).status());

        done(Map.of("timetable", "b1", "id", "bau", "demand", Map.of("path", demand),
                "settings", Map.of("area", Map.of("south", -34, "west", 150, "north", -32, "east", 152))));
        Answer shared = submit(Map.of("timetable", "b1", "bau", "bau", "settings", Map.of("walkMetres", 300)));
        assertEquals(400, shared.status());
        assertTrue(shared.body().get("error").asText().contains("from its BAU run"), shared.body().toString());
        assertEquals(409, submit(Map.of("timetable", "b1", "id", "bau", "demand", Map.of("path", demand))).status());
        assertEquals(404, get("/v1/simulations/bau/files/run.properties").status());
        assertEquals(404, get("/v1/simulations/bau/files/nothing.csv").status());

        // A demand file that cannot be read fails the run, with the reason.
        Path broken = folder.resolve("broken.csv");
        Files.writeString(broken, "user_id,start_time\nu1,07:50\n");
        assertEquals(202, submit(Map.of("timetable", "b1", "id", "broken", "demand",
                Map.of("path", broken.toString()))).status());
        JsonNode failed = ended("broken");
        assertEquals("failed", failed.get("state").asText());
        assertTrue(failed.get("error").asText().contains("origin_stop"), failed.toString());
        assertEquals(409, get("/v1/simulations/broken/files/journeys.csv.gz").status());
        Answer scenarioOfFailed = submit(Map.of("timetable", "b1", "bau", "broken"));
        assertEquals(409, scenarioOfFailed.status());
    }

    @Test
    void oneRunAtATimeAndARunCanBeStopped() throws Exception {
        load("b1", feed("published.zip", "08:00"), "v1");
        CountDownLatch asked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        String url = heldDemand(asked, release);

        assertEquals(202, submit(Map.of("timetable", "b1", "id", "first", "demand", Map.of("url", url))).status());
        assertTrue(asked.await(10, TimeUnit.SECONDS), "the first run went for its demand file");
        JsonNode first = get("/v1/simulations/first").body();
        assertEquals("running", first.get("state").asText());
        assertEquals("fetch", first.get("progress").get("stage").asText());

        Answer second = submit(Map.of("timetable", "b1", "id", "second", "demand",
                Map.of("path", demandFile().toString())));
        Answer third = submit(Map.of("timetable", "b1", "id", "third", "demand",
                Map.of("path", demandFile().toString())));
        assertEquals("queued", second.body().get("state").asText());
        assertEquals(1, second.body().get("runsAhead").asInt());
        assertEquals(2, third.body().get("runsAhead").asInt());
        Thread.sleep(150);
        assertEquals("queued", get("/v1/simulations/second").body().get("state").asText(), "it waits its turn");

        // Stop the one that is waiting, then the one that is running.
        Answer stoppedThird = send("DELETE", "/v1/simulations/third", null);
        assertEquals(202, stoppedThird.status());
        assertEquals("stopped", stoppedThird.body().get("state").asText());
        assertEquals(202, send("DELETE", "/v1/simulations/first", null).status());
        assertEquals("stopped", ended("first").get("state").asText());
        assertFalse(Files.exists(folder.resolve("data/sim/first")), "a stopped run leaves no files");

        // The second then has its turn; the third never runs.
        assertEquals("done", ended("second").get("state").asText());
        assertEquals("stopped", get("/v1/simulations/third").body().get("state").asText());
        assertEquals(204, send("DELETE", "/v1/simulations/first", null).status(), "a second delete discards it");
        assertEquals(404, get("/v1/simulations/first").status());
        release.countDown();
    }

    @Test
    void aRunKeepsTheTimetableItWasAskedForThroughAReload() throws Exception {
        load("b1", feed("published.zip", "08:00"), "v1");
        CountDownLatch asked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        String url = heldDemand(asked, release);
        assertEquals(202, submit(Map.of("timetable", "b1", "id", "held", "demand", Map.of("url", url))).status());
        assertTrue(asked.await(10, TimeUnit.SECONDS));

        // While the run waits for its demand, the timetable is replaced by one with a later first train.
        load("b1", feed("later.zip", "08:30"), "v2");
        release.countDown();
        JsonNode run = ended("held");
        assertEquals("done", run.get("state").asText(), run.toString());
        assertEquals("v1", run.get("timetableVersion").asText());
        // u1 left A at 07:50 for D: on v1 the 08:00 train arrives at 08:30.
        String first = lines("held", "journeys.csv.gz").get(1);
        assertEquals(String.valueOf(8 * 3600 + 30 * 60), first.split(",", -1)[7], first);
    }

    @Test
    void finishedRunsAreStillThereAfterARestart() throws Exception {
        load("b1", feed("published.zip", "08:00"), "v1");
        done(Map.of("timetable", "b1", "id", "bau", "name", "Kept", "demand", Map.of("path", demandFile().toString())));
        done(Map.of("timetable", "b1", "id", "bau-capacity", "fromPlans", "bau"));
        Files.createDirectories(folder.resolve("data/sim/half-written"));
        server.close();
        server = new RouterServer(Settings.defaults(folder.resolve("data")).withPort(0)).start();

        JsonNode listed = get("/v1/simulations").body().get("simulations");
        assertEquals(2, listed.size(), listed.toString());
        JsonNode run = get("/v1/simulations/bau").body();
        assertEquals("done", run.get("state").asText());
        assertEquals("Kept", run.get("name").asText());
        assertEquals("bau", run.get("kind").asText());
        assertEquals("v1", run.get("timetableVersion").asText());
        assertEquals(4, run.get("summary").get("people").get("ok").asInt());
        assertEquals("capacity", get("/v1/simulations/bau-capacity").body().get("kind").asText());
        assertEquals(5, lines("bau", "journeys.csv.gz").size());

        // A scenario run can be made against it once its timetable is loaded again.
        load("b1-s7", feed("scenario.zip", "08:30"), "s7");
        JsonNode scenario = done(Map.of("timetable", "b1-s7", "bau", "bau"));
        assertEquals(4, scenario.get("summary").get("againstBau").get("compared").asInt());
    }
}
