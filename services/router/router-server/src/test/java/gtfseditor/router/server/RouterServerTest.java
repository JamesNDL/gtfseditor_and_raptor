package gtfseditor.router.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
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
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The service over HTTP, on a hand-made feed: stops A, B, C and D about 2 km apart on one train
 * line (trip S1 leaves A at 08:00, S2 at 09:00), and a bus from C to E (X1 at 08:25).
 */
class RouterServerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path folder;

    private RouterServer server;
    private HttpClient client;

    @BeforeEach
    void start() {
        server = new RouterServer(Settings.defaults(folder.resolve("data")).withPort(0)).start();
        client = HttpClient.newHttpClient();
    }

    @AfterEach
    void stop() {
        client.close();
        server.close();
    }

    // ---- the feed

    /** @param firstTrain when S1 leaves A, as HH:MM; the feed's other times do not change */
    private Path feed(String name, String firstTrain) throws Exception {
        Map<String, String> files = Map.of(
                "calendar.txt", """
                        service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
                        DAY,0,1,0,0,0,0,0,20261117,20261117
                        """,
                "routes.txt", """
                        route_id,route_short_name,route_type
                        TRAIN,T1,2
                        BUS,10,3
                        """,
                "stops.txt", """
                        stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station
                        A,Stop A,-33.00,151.0,0,
                        B,Stop B,-33.02,151.0,0,
                        C,Stop C,-33.04,151.0,0,
                        D,Stop D,-33.06,151.0,0,
                        E,Stop E,-33.08,151.0,0,
                        SX,Station X,-33.20,151.0,1,
                        X1,X platform 1,-33.2000,151.0,0,SX
                        Y,Stop Y,-33.22,151.0,0,
                        """,
                "trips.txt", """
                        route_id,service_id,trip_id,trip_headsign
                        TRAIN,DAY,S1,To D
                        TRAIN,DAY,S2,To D
                        BUS,DAY,X1,To E
                        TRAIN,DAY,P1,To Y
                        """,
                "stop_times.txt", """
                        trip_id,arrival_time,departure_time,stop_id,stop_sequence
                        S1,%1$s:00,%1$s:00,A,1
                        S1,08:10:00,08:10:00,B,2
                        S1,08:20:00,08:20:00,C,3
                        S1,08:30:00,08:30:00,D,4
                        S2,09:00:00,09:00:00,A,1
                        S2,09:10:00,09:10:00,B,2
                        S2,09:20:00,09:20:00,C,3
                        S2,09:30:00,09:30:00,D,4
                        X1,08:25:00,08:25:00,C,1
                        X1,08:40:00,08:40:00,E,2
                        P1,14:05:00,14:05:00,X1,1
                        P1,14:20:00,14:20:00,Y,2
                        """.formatted(firstTrain));
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

    // ---- requests

    private record Answer(int status, JsonNode body) {}

    private Answer send(String method, String path, String contentType, HttpRequest.BodyPublisher body)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + server.port() + path))
                .method(method, body);
        if (contentType != null) {
            request.header("Content-Type", contentType);
        }
        HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        String text = response.body();
        return new Answer(response.statusCode(), text.isBlank() || !text.strip().startsWith("{") ? null : JSON.readTree(text));
    }

    private Answer get(String path) throws Exception {
        return send("GET", path, null, HttpRequest.BodyPublishers.noBody());
    }

    private Answer json(String method, String path, String body) throws Exception {
        return send(method, path, "application/json", HttpRequest.BodyPublishers.ofString(body));
    }

    private Answer loadPath(String id, Path zip, String version) throws Exception {
        return json("PUT", "/v1/timetables/" + id, JSON.writeValueAsString(
                Map.of("source", Map.of("path", zip.toString()), "version", version)));
    }

    /** Waits for a build to end, and hands back the metadata. */
    private JsonNode settled(String id) throws Exception {
        for (int i = 0; i < 400; i++) {
            Answer answer = get("/v1/timetables/" + id);
            if (answer.status() == 200 && !answer.body().has("building")) {
                return answer.body();
            }
            Thread.sleep(25);
        }
        return fail("timetable " + id + " was still building after ten seconds");
    }

    private JsonNode loaded(String id, Path zip, String version) throws Exception {
        assertEquals(202, loadPath(id, zip, version).status());
        JsonNode metadata = settled(id);
        assertEquals("ready", metadata.get("status").asText(), metadata.toString());
        return metadata;
    }

    private Answer journey(String body) throws Exception {
        return json("POST", "/v1/journeys", body);
    }

    // ---- health and metadata

    @Test
    void healthReportsUpWithNothingLoaded() throws Exception {
        Answer answer = get("/v1/health");
        assertEquals(200, answer.status());
        assertEquals("up", answer.body().get("status").asText());
        assertEquals(0, answer.body().get("timetables").size());
        assertFalse(answer.body().get("road").get("available").asBoolean());
        assertEquals(0, get("/v1/timetables").body().get("timetables").size());
    }

    @Test
    void aLoadedTimetableIsListedWithItsCounts() throws Exception {
        Answer accepted = loadPath("b1", feed("feed.zip", "08:00"), "v1");
        assertEquals(202, accepted.status());
        assertEquals("v1", accepted.body().get("building").get("version").asText());

        JsonNode metadata = settled("b1");
        assertEquals("ready", metadata.get("status").asText());
        assertEquals("v1", metadata.get("version").asText());
        assertEquals("2026-11-17", metadata.get("serviceDate").asText());
        assertEquals("path", metadata.get("source").get("kind").asText());
        assertEquals(4, metadata.get("counts").get("trips").asInt());
        assertEquals(12, metadata.get("counts").get("stopTimes").asInt());
        assertEquals(7, metadata.get("counts").get("stops").asInt());
        assertEquals(8 * 3600, metadata.get("service").get("firstDeparture").asInt());
        assertEquals(500, metadata.get("transferSettings").get("radiusMetres").asInt());
        assertEquals("school_bus", metadata.get("journeyDefaults").get("avoid").get(0).asText());
        assertEquals(0, metadata.get("capacity").get("placeholderTrips").asInt());
        assertEquals(4, metadata.get("capacity").get("defaultedTrips").asInt());

        assertEquals("b1", get("/v1/health").body().get("timetables").get(0).asText());
        JsonNode listed = get("/v1/timetables").body().get("timetables");
        assertEquals(1, listed.size());
        assertEquals("ready", listed.get(0).get("status").asText());
        assertFalse(listed.get(0).has("notes"));
    }

    @Test
    void anUnknownTimetableIsNotFound() throws Exception {
        assertEquals(404, get("/v1/timetables/none").status());
        assertEquals(404, send("DELETE", "/v1/timetables/none", null, HttpRequest.BodyPublishers.noBody()).status());
        Answer answer = journey("{\"timetable\":\"none\",\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":0}");
        assertEquals(404, answer.status());
        assertTrue(answer.body().get("error").asText().contains("none"));
    }

    // ---- journeys

    @Test
    void aJourneyWithOneChange() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        Answer answer = journey("""
                {"timetable":"b1","from":{"stop":"A"},"to":{"stop":"E"},"depart":"07:45:00"}""");
        assertEquals(200, answer.status(), String.valueOf(answer.body()));
        JsonNode body = answer.body();
        assertEquals("ok", body.get("status").asText());
        assertEquals("b1", body.get("timetable").get("id").asText());
        assertEquals("v1", body.get("timetable").get("version").asText());
        assertEquals("off", body.get("capacityMode").asText());
        assertEquals(0, body.get("recommended").asInt());

        JsonNode j = body.get("journeys").get(0);
        assertEquals("fastest", j.get("label").asText());
        assertTrue(j.get("recommended").asBoolean());
        assertEquals(8 * 3600, j.get("depart").asInt());
        assertEquals(8 * 3600 + 40 * 60, j.get("arrive").asInt());
        assertEquals(2, j.get("rides").asInt());
        assertEquals(1, j.get("changes").asInt());
        assertEquals(2, j.get("legs").size());

        JsonNode train = j.get("legs").get(0);
        assertEquals("ride", train.get("type").asText());
        assertEquals("S1", train.get("trip").asText());
        assertEquals("T1", train.get("route").asText());
        assertEquals("train", train.get("mode").asText());
        assertEquals("To D", train.get("headsign").asText());
        assertEquals("A", train.get("board").get("stop").asText());
        assertEquals("Stop A", train.get("board").get("name").asText());
        assertEquals(8 * 3600, train.get("board").get("time").asInt());
        assertEquals("C", train.get("alight").get("stop").asText());
        assertEquals(2, train.get("alight").get("position").asInt());
        assertEquals(3, train.get("stops").size());
        assertEquals("B", train.get("stops").get(1).get("stop").asText());
        assertEquals(8 * 3600 + 600, train.get("stops").get(1).get("arrive").asInt());
        assertEquals(-33.02, train.get("stops").get(1).get("lat").asDouble(), 1e-9);
        assertFalse(train.get("stayAboard").asBoolean());
        assertEquals("X1", j.get("legs").get(1).get("trip").asText());
        assertEquals("bus", j.get("legs").get(1).get("mode").asText());
    }

    @Test
    void aSummaryLeavesOutTheStopsPassed() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        // With only one timetable loaded, it need not be named. The time may be given in seconds.
        Answer answer = journey("{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"D\"},\"depart\":28800,\"detail\":\"summary\"}");
        assertEquals(200, answer.status(), String.valueOf(answer.body()));
        JsonNode leg = answer.body().get("journeys").get(0).get("legs").get(0);
        assertEquals("S1", leg.get("trip").asText());
        assertEquals("D", leg.get("alight").get("stop").asText());
        assertFalse(leg.has("stops"));
    }

    @Test
    void aJourneyFromAPointToAStation() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        // About 220 m north of A.
        Answer answer = journey("""
                {"timetable":"b1","from":{"lat":-32.998,"lon":151.0},"to":{"stop":"B"},"depart":"07:00"}""");
        assertEquals(200, answer.status(), String.valueOf(answer.body()));
        JsonNode legs = answer.body().get("journeys").get(0).get("legs");
        assertEquals("walk", legs.get(0).get("type").asText());
        assertEquals(-32.998, legs.get(0).get("from").get("lat").asDouble(), 1e-9);
        assertEquals("A", legs.get(0).get("to").get("stop").asText());
        assertEquals(8 * 3600, legs.get(0).get("arrive").asInt());
        assertTrue(legs.get(0).get("metres").asInt() > 200 && legs.get(0).get("metres").asInt() < 240);
        assertEquals("S1", legs.get(1).get("trip").asText());

        // A station may be named as a station, or as a stop.
        for (String from : List.of("{\"station\":\"SX\"}", "{\"stop\":\"SX\"}")) {
            Answer fromStation = journey("{\"from\":" + from + ",\"to\":{\"stop\":\"Y\"},\"depart\":\"14:00\"}");
            assertEquals(200, fromStation.status(), String.valueOf(fromStation.body()));
            assertEquals("P1", fromStation.body().get("journeys").get(0).get("legs").get(0).get("trip").asText());
        }
    }

    @Test
    void noJourneyIsAnAnswerNotAnError() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        Answer late = journey("{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"E\"},\"depart\":\"23:00\"}");
        assertEquals(200, late.status());
        assertEquals("noJourney", late.body().get("status").asText());
        assertEquals(0, late.body().get("journeys").size());
        assertEquals(-1, late.body().get("recommended").asInt());
        assertTrue(late.body().get("reason").asText().contains("Nothing gets there"));

        Answer far = journey("{\"from\":{\"lat\":-30.0,\"lon\":150.0},\"to\":{\"stop\":\"E\"},\"depart\":\"07:00\"}");
        assertEquals("noJourney", far.body().get("status").asText());
        assertTrue(far.body().get("reason").asText().contains("walking distance"));
    }

    @Test
    void requestsThatCannotBeReadAreRefusedWithAReason() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        String ends = "\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"}";
        Map<String, String> wrong = Map.of(
                "{" + ends + "}", "depart",
                "{" + ends + ",\"depart\":\"37:00:00\"}", "depart",
                "{" + ends + ",\"depart\":\"08:61\"}", "depart",
                "{\"from\":{\"stop\":\"NOPE\"},\"to\":{\"stop\":\"B\"},\"depart\":0}", "NOPE",
                "{\"from\":{\"stop\":\"A\"},\"depart\":0}", "'to'",
                "{\"from\":{\"lat\":95,\"lon\":0},\"to\":{\"stop\":\"B\"},\"depart\":0}", "'from'",
                "{" + ends + ",\"depart\":0,\"maxRides\":0}", "maxRides",
                "{" + ends + ",\"depart\":0,\"avoid\":[\"tram\"]}", "tram",
                "{" + ends + ",\"depart\":0,\"detail\":\"everything\"}", "detail",
                "{ not json", "JSON");
        for (Map.Entry<String, String> request : wrong.entrySet()) {
            Answer answer = journey(request.getKey());
            assertEquals(400, answer.status(), request.getKey());
            assertTrue(answer.body().get("error").asText().contains(request.getValue()),
                    request.getKey() + " gave: " + answer.body());
        }
        // Respecting loads needs a load state, and one that exists.
        assertEquals(400, journey("{" + ends + ",\"depart\":0,\"capacity\":{\"mode\":\"check\"}}").status());
        assertEquals(400, journey("{" + ends + ",\"depart\":0,\"capacity\":{\"mode\":\"full\"}}").status());
        assertEquals(404, journey("{" + ends + ",\"depart\":0,\"capacity\":{\"mode\":\"check\",\"loads\":\"none\"}}").status());
        assertEquals(200, journey("{" + ends + ",\"depart\":0,\"capacity\":{\"mode\":\"off\"}}").status());
    }

    @Test
    void manyJourneysAtOnce() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        try (ExecutorService callers = Executors.newFixedThreadPool(16)) {
            List<Future<Answer>> answers = new ArrayList<>();
            for (int i = 0; i < 200; i++) {
                Callable<Answer> call = () -> journey("{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"E\"},\"depart\":\"07:45\"}");
                answers.add(callers.submit(call));
            }
            for (Future<Answer> answer : answers) {
                assertEquals(200, answer.get().status());
                assertEquals(8 * 3600 + 40 * 60, answer.get().body().get("journeys").get(0).get("arrive").asInt());
            }
        }
    }

    // ---- loading, reloading and unloading

    @Test
    void aReloadSwapsInTheNewTimetable() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        String ask = "{\"timetable\":\"b1\",\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":\"07:00\"}";
        assertEquals(8 * 3600, journey(ask).body().get("journeys").get(0).get("depart").asInt());

        JsonNode metadata = loaded("b1", feed("later.zip", "08:03"), "v2");
        assertEquals("v2", metadata.get("version").asText());
        Answer after = journey(ask);
        assertEquals("v2", after.body().get("timetable").get("version").asText());
        assertEquals(8 * 3600 + 180, after.body().get("journeys").get(0).get("depart").asInt());
    }

    @Test
    void journeysKeepBeingAnsweredWhileTheTimetableIsReloaded() throws Exception {
        Path early = feed("feed.zip", "08:00");
        Path later = feed("later.zip", "08:03");
        loaded("b1", early, "v0");
        String ask = "{\"timetable\":\"b1\",\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":\"07:00\"}";
        java.util.concurrent.atomic.AtomicBoolean reloading = new java.util.concurrent.atomic.AtomicBoolean(true);
        try (ExecutorService callers = Executors.newFixedThreadPool(4)) {
            List<Future<Integer>> counts = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                Callable<Integer> call = () -> {
                    int asked = 0;
                    while (reloading.get()) {
                        Answer answer = journey(ask);
                        assertEquals(200, answer.status(), String.valueOf(answer.body()));
                        // Each answer is whole: the time belongs to the version it names.
                        boolean even = answer.body().get("timetable").get("version").asText().endsWith("0");
                        assertEquals(8 * 3600 + (even ? 0 : 180),
                                answer.body().get("journeys").get(0).get("depart").asInt());
                        asked++;
                    }
                    return asked;
                };
                counts.add(callers.submit(call));
            }
            try {
                for (int round = 1; round <= 12; round++) {
                    loaded("b1", round % 2 == 0 ? early : later, "v" + round % 2);
                }
            } finally {
                reloading.set(false);
            }
            for (Future<Integer> count : counts) {
                assertTrue(count.get() > 0);
            }
        }
    }

    @Test
    void aReloadThatFailsLeavesTheOldTimetableInPlace() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        Path broken = folder.resolve("broken.zip");
        Files.writeString(broken, "this is not a zip");
        assertEquals(202, loadPath("b1", broken, "v2").status());

        JsonNode metadata = settled("b1");
        assertEquals("ready", metadata.get("status").asText());
        assertEquals("v1", metadata.get("version").asText());
        assertEquals("v2", metadata.get("lastFailure").get("version").asText());
        assertFalse(metadata.get("lastFailure").get("message").asText().isBlank());
        assertEquals(200, journey("{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":0}").status());

        // A first load that fails leaves nothing to plan on, and says why.
        assertEquals(202, loadPath("b2", broken, "v1").status());
        assertEquals("failed", settled("b2").get("status").asText());
        Answer answer = journey("{\"timetable\":\"b2\",\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":0}");
        assertEquals(503, answer.status());
        assertTrue(answer.body().get("error").asText().contains("could not be loaded"));

        // A good reload clears the failure.
        assertFalse(loaded("b1", feed("later.zip", "08:03"), "v3").has("lastFailure"));
    }

    @Test
    void aZipCanBeUploaded() throws Exception {
        Answer accepted = send("PUT", "/v1/timetables/up?version=u1", "application/zip",
                HttpRequest.BodyPublishers.ofFile(feed("feed.zip", "08:00")));
        assertEquals(202, accepted.status(), String.valueOf(accepted.body()));
        JsonNode metadata = settled("up");
        assertEquals("ready", metadata.get("status").asText(), metadata.toString());
        assertEquals("u1", metadata.get("version").asText());
        assertEquals("upload", metadata.get("source").get("kind").asText());
        assertEquals(4, metadata.get("counts").get("trips").asInt());
        assertTrue(Files.isRegularFile(folder.resolve("data/zips/up.zip")));

        // A second upload under the same id replaces the zip, and the first one's snapshot goes.
        assertEquals(202, send("PUT", "/v1/timetables/up?version=u2", "application/zip",
                HttpRequest.BodyPublishers.ofFile(feed("later.zip", "08:03"))).status());
        assertEquals("u2", settled("up").get("version").asText());
        try (var snapshots = Files.list(folder.resolve("data/snapshots"))) {
            assertEquals(1, snapshots.count());
        }
    }

    @Test
    void aZipCanBeFetchedFromAUrl() throws Exception {
        byte[] zip = Files.readAllBytes(feed("feed.zip", "08:00"));
        HttpServer editor = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        editor.createContext("/export", exchange -> {
            exchange.sendResponseHeaders(200, zip.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(zip);
            }
        });
        editor.start();
        try {
            String base = "http://localhost:" + editor.getAddress().getPort();
            Answer accepted = json("PUT", "/v1/timetables/b1",
                    "{\"source\":{\"url\":\"" + base + "/export\"},\"version\":\"v1\"}");
            assertEquals(202, accepted.status(), String.valueOf(accepted.body()));
            JsonNode metadata = settled("b1");
            assertEquals("ready", metadata.get("status").asText(), metadata.toString());
            assertEquals("url", metadata.get("source").get("kind").asText());
            assertEquals(4, metadata.get("counts").get("trips").asInt());

            // An address that answers 404 is a failed build, and the timetable stays.
            assertEquals(202, json("PUT", "/v1/timetables/b1",
                    "{\"source\":{\"url\":\"" + base + "/missing\"},\"version\":\"v2\"}").status());
            JsonNode after = settled("b1");
            assertEquals("v1", after.get("version").asText());
            assertTrue(after.get("lastFailure").get("message").asText().contains("404"));
        } finally {
            editor.stop(0);
        }
    }

    @Test
    void loadRequestsThatCannotBeReadAreRefused() throws Exception {
        assertEquals(400, json("PUT", "/v1/timetables/b1", "{}").status());
        assertEquals(400, json("PUT", "/v1/timetables/b1", "{\"source\":{\"path\":\"no/such/file.zip\"}}").status());
        assertEquals(400, json("PUT", "/v1/timetables/b1", "{\"source\":{\"url\":\"ftp://example.org/x.zip\"}}").status());
        assertEquals(400, json("PUT", "/v1/timetables/bad%20id", "{}").status());
        assertEquals(415, send("PUT", "/v1/timetables/b1", "text/plain", HttpRequest.BodyPublishers.ofString("x")).status());
        // None of those left anything behind.
        assertEquals(404, get("/v1/timetables/b1").status());
    }

    @Test
    void unloadingForgetsATimetable() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        assertEquals(204, send("DELETE", "/v1/timetables/b1", null, HttpRequest.BodyPublishers.noBody()).status());
        assertEquals(404, get("/v1/timetables/b1").status());
        assertEquals(0, get("/v1/health").body().get("timetables").size());
    }

    @Test
    void theTimetableUsedLongestAgoIsDroppedToMakeRoom() throws Exception {
        Path zip = feed("feed.zip", "08:00");
        loaded("one", zip, "v1");
        loaded("two", zip, "v1");
        // Use "one", so that "two" is the one used longest ago.
        assertEquals(200, journey("{\"timetable\":\"one\",\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":0}").status());
        loaded("three", zip, "v1");

        assertEquals(404, get("/v1/timetables/two").status());
        assertEquals("ready", get("/v1/timetables/one").body().get("status").asText());
        assertEquals(2, get("/v1/health").body().get("timetables").size());
    }

    // ---- load states and capacity. A train holds 1,200 and a bus 65: the defaults by kind of vehicle.

    private Answer delete(String path) throws Exception {
        return send("DELETE", path, null, HttpRequest.BodyPublishers.noBody());
    }

    private void loads(String name, String... rows) throws Exception {
        Answer made = rows.length == 0 ? json("POST", "/v1/timetables/b1/loads", "{\"name\":\"" + name + "\"}")
                : send("POST", "/v1/timetables/b1/loads?name=" + name, "text/csv",
                        HttpRequest.BodyPublishers.ofString("trip_id,position,load\n" + String.join("\n", rows) + "\n"));
        assertEquals(201, made.status(), String.valueOf(made.body()));
    }

    private String text(String path) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + server.port() + path)).build();
        return client.send(request, HttpResponse.BodyHandlers.ofString()).body();
    }

    /** Sends a bulk request and hands back its lines. */
    private List<JsonNode> bulk(String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + server.port() + "/v1/journeys/bulk"))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), response.body());
        assertTrue(response.headers().firstValue("Content-Type").orElse("").startsWith("application/x-ndjson"));
        List<JsonNode> lines = new ArrayList<>();
        for (String line : response.body().split("\n")) {
            lines.add(JSON.readTree(line));
        }
        return lines;
    }

    @Test
    void loadStatesAreMadeListedAndDeleted() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        loads("empty");
        loads("peak", "S1,0,1200", "S1,1,900", "X1,0,65");
        assertEquals(409, json("POST", "/v1/timetables/b1/loads", "{\"name\":\"peak\"}").status());
        assertEquals(400, json("POST", "/v1/timetables/b1/loads", "{\"name\":\"not a name\"}").status());
        assertEquals(400, json("POST", "/v1/timetables/b1/loads", "{}").status());
        assertEquals(404, json("POST", "/v1/timetables/none/loads", "{\"name\":\"x\"}").status());

        JsonNode peak = get("/v1/timetables/b1/loads/peak").body();
        assertEquals("peak", peak.get("name").asText());
        assertEquals(2, peak.get("tripsWithLoad").asInt());
        assertEquals(2, peak.get("fullTrips").asInt());
        assertEquals(3, peak.get("loadedCalls").asInt());
        assertEquals(2, peak.get("fullCalls").asInt());
        assertEquals(1.0, peak.get("peakFactor").asDouble(), 1e-9);
        assertEquals("trip_id,position,stop_id,load\nS1,0,A,1200\nS1,1,B,900\nX1,0,C,65\n",
                text("/v1/timetables/b1/loads/peak?format=csv"));

        assertEquals(2, get("/v1/timetables/b1/loads").body().get("loads").size());
        assertEquals("empty", get("/v1/timetables/b1").body().get("loads").get(0).asText());
        assertEquals(204, delete("/v1/timetables/b1/loads/empty").status());
        assertEquals(404, get("/v1/timetables/b1/loads/empty").status());
        assertEquals(404, delete("/v1/timetables/b1/loads/empty").status());
        assertEquals(1, get("/v1/timetables/b1/loads").body().get("loads").size());
    }

    @Test
    void aLoadsFileThatCannotBeReadIsRefusedByRow() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        Map<String, String> wrong = Map.of(
                "trip_id,load\nS1,5\n", "position",
                "trip_id,position,load\nNOPE,0,5\n", "row 2",
                "trip_id,position,load\nS1,0,5\nS1,9,5\n", "row 3",
                "trip_id,position,load\nS1,0,many\n", "whole numbers",
                "trip_id,position,load\nS1,0,-1\n", "row 2");
        for (Map.Entry<String, String> file : wrong.entrySet()) {
            Answer answer = send("POST", "/v1/timetables/b1/loads?name=x", "text/csv",
                    HttpRequest.BodyPublishers.ofString(file.getKey()));
            assertEquals(400, answer.status(), file.getKey());
            assertTrue(answer.body().get("error").asText().contains(file.getValue()), String.valueOf(answer.body()));
        }
        assertEquals(0, get("/v1/timetables/b1/loads").body().get("loads").size());
    }

    @Test
    void checkingPassesOverAFullTripAndSaysSo() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        loads("peak", "S1,0,1200");
        String ask = "\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":\"07:45\"";
        assertEquals("S1", journey("{" + ask + "}").body().get("journeys").get(0).get("legs").get(0).get("trip").asText());

        Answer answer = journey("{" + ask + ",\"capacity\":{\"mode\":\"check\",\"loads\":\"peak\"}}");
        assertEquals(200, answer.status(), String.valueOf(answer.body()));
        assertEquals("check", answer.body().get("capacityMode").asText());
        assertEquals("peak", answer.body().get("loads").asText());
        JsonNode leg = answer.body().get("journeys").get(0).get("legs").get(0);
        assertEquals("S2", leg.get("trip").asText());
        assertEquals(1, leg.get("skippedFullTrips").asInt());
        assertEquals(0, leg.get("crowding").get("peakLoad").asInt());
        assertEquals(1200, leg.get("crowding").get("capacity").asInt());
        assertFalse(answer.body().has("tries"));
        // Checking adds nobody.
        assertEquals(0, get("/v1/timetables/b1/loads/peak").body().get("passengers").asInt());

        // A group of two fits S1 when it has two places left, and not when it counts as full at 99%.
        loads("nearly", "S1,0,1198");
        String nearly = "{" + ask + ",\"group\":2,\"capacity\":{\"mode\":\"check\",\"loads\":\"nearly\"%s}}";
        assertEquals("S1", journey(nearly.formatted("")).body().get("journeys").get(0).get("legs").get(0).get("trip").asText());
        assertEquals("S2", journey(nearly.formatted(",\"fullAt\":0.99")).body().get("journeys").get(0).get("legs").get(0)
                .get("trip").asText());
    }

    @Test
    void aPassengerWithNoRoomAnywhereIsStranded() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        loads("peak", "X1,0,65");
        Answer answer = journey("{\"from\":{\"stop\":\"C\"},\"to\":{\"stop\":\"E\"},\"depart\":\"08:00\","
                + "\"capacity\":{\"mode\":\"check\",\"loads\":\"peak\"}}");
        assertEquals(200, answer.status());
        assertEquals("stranded", answer.body().get("status").asText());
        assertEquals(0, answer.body().get("journeys").size());
        assertTrue(answer.body().get("reason").asText().contains("no room"));
    }

    @Test
    void aRefusedBoardingIsNotOffered() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        String ask = "\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":\"07:45\"";
        Answer answer = journey("{" + ask + ",\"blocked\":[{\"trip\":\"S1\",\"stop\":\"A\"}]}");
        assertEquals("S2", answer.body().get("journeys").get(0).get("legs").get(0).get("trip").asText());
        assertEquals(400, journey("{" + ask + ",\"blocked\":[{\"trip\":\"NOPE\",\"stop\":\"A\"}]}").status());
    }

    @Test
    void assigningAddsThePassengerToTheLoads() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        loads("run", "S1,0,1199");
        String ask = "{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"C\"},\"depart\":\"07:45\","
                + "\"capacity\":{\"mode\":\"assign\",\"loads\":\"run\"}}";
        Answer first = journey(ask);
        assertEquals(200, first.status(), String.valueOf(first.body()));
        assertEquals("S1", first.body().get("journeys").get(0).get("legs").get(0).get("trip").asText());
        assertEquals(0, first.body().get("assigned").asInt());
        assertEquals(1, first.body().get("tries").asInt());
        // The loads reported are those after the passenger was added.
        assertEquals(1200, first.body().get("journeys").get(0).get("legs").get(0).get("crowding").get("peakLoad").asInt());

        Answer second = journey(ask);
        assertEquals("S2", second.body().get("journeys").get(0).get("legs").get(0).get("trip").asText());
        assertEquals(1, second.body().get("journeys").get(0).get("legs").get(0).get("skippedFullTrips").asInt());

        assertEquals(2, get("/v1/timetables/b1/loads/run").body().get("passengers").asInt());
        String csv = text("/v1/timetables/b1/loads/run?format=csv");
        assertTrue(csv.contains("S1,0,A,1200\nS1,1,B,1\n"), csv);
        assertTrue(csv.contains("S2,0,A,1\nS2,1,B,1\n"), csv);
    }

    // ---- many journeys at once

    @Test
    void aBulkRequestAnswersALineForEachJourneyAndThenTheTotals() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        List<JsonNode> lines = bulk("""
                {"timetable":"b1","queries":[
                  {"id":"a","from":{"stop":"A"},"to":{"stop":"E"},"depart":"07:45"},
                  {"id":"b","from":{"stop":"NOPE"},"to":{"stop":"E"},"depart":"07:45"},
                  {"id":"c","from":{"stop":"A"},"to":{"stop":"E"},"depart":"23:00"},
                  {"id":"d","from":{"stop":"A"},"to":{"stop":"B"}},
                  {"from":{"lat":-32.998,"lon":151.0},"to":{"station":"SX"},"depart":28800}
                ]}""");
        assertEquals(6, lines.size());
        // The journeys that cannot be read or placed come first, then the rest in the order asked.
        assertEquals("b", lines.get(0).get("id").asText());
        assertEquals("error", lines.get(0).get("status").asText());
        assertTrue(lines.get(0).get("error").asText().contains("NOPE"));
        assertEquals("d", lines.get(1).get("id").asText());
        assertTrue(lines.get(1).get("error").asText().contains("depart"));

        assertEquals("a", lines.get(2).get("id").asText());
        assertEquals("ok", lines.get(2).get("status").asText());
        JsonNode journey = lines.get(2).get("journey");
        assertEquals(8 * 3600 + 40 * 60, journey.get("arrive").asInt());
        assertEquals("S1", journey.get("legs").get(0).get("trip").asText());
        assertEquals("C", journey.get("legs").get(0).get("alight").get("stop").asText());
        assertFalse(journey.get("legs").get(0).has("stops"));
        assertFalse(lines.get(2).has("tries"));

        assertEquals("c", lines.get(3).get("id").asText());
        assertEquals("noJourney", lines.get(3).get("status").asText());
        assertFalse(lines.get(4).has("id"));
        assertEquals("noJourney", lines.get(4).get("status").asText());

        JsonNode summary = lines.get(5).get("summary");
        assertEquals(5, summary.get("queries").asInt());
        assertEquals(1, summary.get("ok").asInt());
        assertEquals(2, summary.get("noJourney").asInt());
        assertEquals(0, summary.get("stranded").asInt());
        assertEquals(2, summary.get("errors").asInt());
        assertEquals("off", summary.get("capacityMode").asText());
        assertEquals("v1", summary.get("timetable").get("version").asText());

        // The stops each ride passes are there for the asking.
        List<JsonNode> full = bulk("{\"detail\":\"legs\",\"queries\":[{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"D\"},\"depart\":0}]}");
        assertEquals(4, full.get(0).get("journey").get("legs").get(0).get("stops").size());
        // No journeys is a request too.
        assertEquals(0, bulk("{\"queries\":[]}").get(0).get("summary").get("queries").asInt());
    }

    @Test
    void aBulkAssignmentHandlesPassengersInOrderOfDeparture() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        loads("run", "S1,0,1198"); // two places left from A to B
        String body = """
                {"capacity":{"mode":"assign","loads":"run"},"queries":[
                  {"id":"p1","from":{"stop":"A"},"to":{"stop":"B"},"depart":"07:42"},
                  {"id":"p2","from":{"stop":"A"},"to":{"stop":"B"},"depart":"07:40"},
                  {"id":"p3","from":{"stop":"A"},"to":{"stop":"B"},"depart":"07:41"},
                  {"id":"p4","from":{"stop":"C"},"to":{"stop":"E"},"depart":"08:00","group":66}
                ]}""";
        List<JsonNode> lines = bulk(body);
        assertEquals(5, lines.size());
        assertEquals(List.of("p2", "p3", "p1", "p4"), lines.subList(0, 4).stream().map(l -> l.get("id").asText()).toList());
        assertEquals("S1", lines.get(0).get("journey").get("legs").get(0).get("trip").asText());
        assertEquals("S1", lines.get(1).get("journey").get("legs").get(0).get("trip").asText());
        assertEquals(1, lines.get(1).get("tries").asInt());
        // All three set off within five minutes, so all were first routed onto S1. The last to set
        // off finds it full when their turn comes, and is routed again.
        assertEquals("S2", lines.get(2).get("journey").get("legs").get(0).get("trip").asText());
        assertEquals(2, lines.get(2).get("tries").asInt());
        assertEquals(1, lines.get(2).get("journey").get("legs").get(0).get("skippedFullTrips").asInt());
        // A group too big for the only bus.
        assertEquals("stranded", lines.get(3).get("status").asText());
        assertFalse(lines.get(3).has("journey"));

        JsonNode summary = lines.get(4).get("summary");
        assertEquals(3, summary.get("ok").asInt());
        assertEquals(1, summary.get("stranded").asInt());
        assertEquals(1, summary.get("rerouted").asInt());
        assertEquals("run", summary.get("loads").asText());
        assertEquals(3, get("/v1/timetables/b1/loads/run").body().get("passengers").asInt());

        // The same passengers again find the loads the first run left: S1 is full for all of them.
        List<JsonNode> again = bulk(body);
        for (int i = 0; i < 3; i++) {
            assertEquals("S2", again.get(i).get("journey").get("legs").get(0).get("trip").asText());
            assertEquals(1, again.get(i).get("tries").asInt());
        }
    }

    @Test
    void bulkRequestsThatCannotBeAnsweredAreRefusedBeforeAnythingIsSent() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        String one = "{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":0}";
        assertEquals(400, json("POST", "/v1/journeys/bulk", "[]").status());
        assertEquals(400, json("POST", "/v1/journeys/bulk", "{\"queries\":{}}").status());
        assertEquals(400, json("POST", "/v1/journeys/bulk", "{\"queries\":[" + one + "]").status());
        assertEquals(400, json("POST", "/v1/journeys/bulk", "{\"detail\":\"all\",\"queries\":[" + one + "]}").status());
        assertEquals(404, json("POST", "/v1/journeys/bulk", "{\"timetable\":\"none\",\"queries\":[" + one + "]}").status());
        assertEquals(400, json("POST", "/v1/journeys/bulk",
                "{\"capacity\":{\"mode\":\"assign\"},\"queries\":[" + one + "]}").status());
        assertEquals(404, json("POST", "/v1/journeys/bulk",
                "{\"capacity\":{\"mode\":\"assign\",\"loads\":\"none\"},\"queries\":[" + one + "]}").status());
    }

    @Test
    void aBulkRequestMayHoldOnlySoManyJourneys() throws Exception {
        try (RouterServer small = new RouterServer(Settings.defaults(folder.resolve("small")).withPort(0)
                .withBulkLimit(2)).start()) {
            String one = "{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":0}";
            HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + small.port() + "/v1/journeys/bulk"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"queries\":[" + one + "," + one + "," + one + "]}")).build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            assertEquals(413, response.statusCode());
            assertTrue(response.body().contains("at most 2"));
        }
    }

    @Test
    void aBulkRunWhoseCallerGoesAwayLeavesTheServiceWorking() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        loads("run");
        StringBuilder queries = new StringBuilder();
        for (int i = 0; i < 20_000; i++) {
            queries.append(i == 0 ? "" : ",").append("{\"id\":\"").append(i)
                    .append("\",\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"E\"},\"depart\":\"07:45\"}");
        }
        byte[] body = ("{\"detail\":\"legs\",\"capacity\":{\"mode\":\"assign\",\"loads\":\"run\"},\"queries\":["
                + queries + "]}").getBytes(StandardCharsets.UTF_8);
        try (java.net.Socket socket = new java.net.Socket("localhost", server.port())) {
            OutputStream out = socket.getOutputStream();
            out.write(("POST /v1/journeys/bulk HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
                    + "Content-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(body);
            out.flush();
            assertTrue(socket.getInputStream().read() >= 0); // the answer has begun
        }
        // The run ends or is abandoned, and the load state is free for the next one.
        String one = "{\"capacity\":{\"mode\":\"assign\",\"loads\":\"run\"},\"queries\":["
                + "{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"B\"},\"depart\":0}]}";
        int status = 0;
        for (int i = 0; i < 400 && status != 200; i++) {
            status = json("POST", "/v1/journeys/bulk", one).status();
            if (status != 200) {
                assertEquals(409, status);
                Thread.sleep(25);
            }
        }
        assertEquals(200, status);
        assertEquals("up", get("/v1/health").body().get("status").asText());
    }

    @Test
    void aReloadDiscardsTheLoadStatesAndSaysSo() throws Exception {
        loaded("b1", feed("feed.zip", "08:00"), "v1");
        loads("run");
        Answer accepted = loadPath("b1", feed("later.zip", "08:03"), "v2");
        assertEquals(202, accepted.status());
        assertTrue(accepted.body().get("note").asText().contains("load states"));
        JsonNode metadata = settled("b1");
        assertEquals("v2", metadata.get("version").asText());
        assertEquals(0, metadata.get("loads").size());
        assertEquals(404, get("/v1/timetables/b1/loads/run").status());
    }

    // ---- settings

    @Test
    void settingsHaveDefaults() {
        Settings settings = Settings.from(Map.of());
        assertEquals(3002, settings.port());
        assertEquals(2, settings.maxTimetables());
        assertEquals(Path.of("data/router"), settings.data());
        assertTrue(settings.threads() >= 1);
        assertTrue(settings.preload().isEmpty());
    }

    @Test
    void settingsAreReadFromTheEnvironment() {
        Settings settings = Settings.from(Map.of("ROUTER_PORT", " 4000 ", "ROUTER_THREADS", "3",
                "ROUTER_MAX_TIMETABLES", "4", "ROUTER_DATA", "somewhere",
                "ROUTER_LOAD", "b1=data/a.zip; b1-s7=data/b.zip"));
        assertEquals(4000, settings.port());
        assertEquals(3, settings.threads());
        assertEquals(4, settings.maxTimetables());
        assertEquals(Path.of("somewhere/zips"), settings.zips());
        assertEquals(Path.of("data/b.zip"), settings.preload().get("b1-s7"));
        assertNotEquals(null, settings.preload().get("b1"));
    }

    @Test
    void badSettingsAreRejectedByName() {
        for (String port : List.of("abc", "0", "70000")) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> Settings.from(Map.of("ROUTER_PORT", port)));
            assertTrue(e.getMessage().contains("ROUTER_PORT"));
        }
        assertThrows(IllegalArgumentException.class, () -> Settings.from(Map.of("ROUTER_THREADS", "0")));
        assertThrows(IllegalArgumentException.class, () -> Settings.from(Map.of("ROUTER_LOAD", "just-a-path.zip")));
    }
}
