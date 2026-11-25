package gtfseditor.router.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import gtfseditor.router.server.RoadFixture.Answer;
import java.io.OutputStream;
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
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Arrive-by over HTTP (BRD access-analysis FR-21): {@code arriveBy} in place of {@code depart} on
 * one journey and in bulk. The feed is a train A, B, C, D (S1 leaves A at 08:00, S2 at 09:00, ten
 * minutes between stops) and a bus from C to E (X1, 08:25 to 08:40).
 */
class ArriveByApiTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    static Path folder;

    private static RouterServer server;
    private static HttpClient client;
    private static RoadFixture.Http http;

    @BeforeAll
    static void start() throws Exception {
        server = new RouterServer(Settings.defaults(folder.resolve("data")).withPort(0)).start();
        client = HttpClient.newHttpClient();
        http = new RoadFixture.Http(client, server.port());
        Answer accepted = http.put("/v1/timetables/b1", JSON.writeValueAsString(
                Map.of("source", Map.of("path", feed().toString()), "version", "v1")));
        assertEquals(202, accepted.status());
        for (int i = 0; i < 400; i++) {
            Answer answer = http.get("/v1/timetables/b1");
            if (answer.status() == 200 && !answer.body().has("building")) {
                assertEquals("ready", answer.body().get("status").asText());
                return;
            }
            Thread.sleep(25);
        }
        fail("the timetable was still building after ten seconds");
    }

    @AfterAll
    static void stop() {
        client.close();
        server.close();
    }

    private static Path feed() throws Exception {
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
                        stop_id,stop_name,stop_lat,stop_lon
                        A,Stop A,-33.00,151.0
                        B,Stop B,-33.02,151.0
                        C,Stop C,-33.04,151.0
                        D,Stop D,-33.06,151.0
                        E,Stop E,-33.08,151.0
                        """,
                "trips.txt", """
                        route_id,service_id,trip_id,trip_headsign
                        TRAIN,DAY,S1,To D
                        TRAIN,DAY,S2,To D
                        BUS,DAY,X1,To E
                        """,
                "stop_times.txt", """
                        trip_id,arrival_time,departure_time,stop_id,stop_sequence
                        S1,08:00:00,08:00:00,A,1
                        S1,08:10:00,08:10:00,B,2
                        S1,08:20:00,08:20:00,C,3
                        S1,08:30:00,08:30:00,D,4
                        S2,09:00:00,09:00:00,A,1
                        S2,09:10:00,09:10:00,B,2
                        S2,09:20:00,09:20:00,C,3
                        S2,09:30:00,09:30:00,D,4
                        X1,08:25:00,08:25:00,C,1
                        X1,08:40:00,08:40:00,E,2
                        """);
        Path zip = folder.resolve("feed.zip");
        try (OutputStream out = Files.newOutputStream(zip); ZipOutputStream entries = new ZipOutputStream(out)) {
            for (Map.Entry<String, String> file : files.entrySet()) {
                entries.putNextEntry(new ZipEntry(file.getKey()));
                entries.write(file.getValue().getBytes(StandardCharsets.UTF_8));
                entries.closeEntry();
            }
        }
        return zip;
    }

    private static Answer journey(String body) throws Exception {
        return http.post("/v1/journeys", body);
    }

    /** Sends a bulk request and hands back its lines. */
    private static List<JsonNode> bulk(String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + server.port() + "/v1/journeys/bulk"))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), response.body());
        List<JsonNode> lines = new ArrayList<>();
        for (String line : response.body().split("\n")) {
            lines.add(JSON.readTree(line));
        }
        return lines;
    }

    @Test
    void oneJourneyLeavesAsLateAsStillArrivesInTime() throws Exception {
        Answer answer = journey("""
                {"from":{"stop":"A"},"to":{"stop":"E"},"arriveBy":"08:45"}""");
        assertEquals(200, answer.status(), String.valueOf(answer.body()));
        JsonNode body = answer.body();
        assertEquals("ok", body.get("status").asText());
        assertEquals(8 * 3600 + 45 * 60, body.get("arriveBy").asInt());
        JsonNode j = body.get("journeys").get(0);
        assertEquals(8 * 3600, j.get("depart").asInt());
        assertEquals(8 * 3600 + 40 * 60, j.get("arrive").asInt());
        assertEquals(8 * 3600 + 45 * 60, j.get("arriveBy").asInt());
        assertEquals(300, j.get("earlyWait").asInt());
        // The legs are the forward answer's, in order and of the same shape.
        assertEquals("S1", j.get("legs").get(0).get("trip").asText());
        assertEquals("X1", j.get("legs").get(1).get("trip").asText());
        assertEquals("A", j.get("legs").get(0).get("board").get("stop").asText());
        assertEquals(3, j.get("legs").get(0).get("stops").size());
        assertEquals("bus", j.get("legs").get(1).get("mode").asText());
    }

    @Test
    void nothingInTimeIsNoJourney() throws Exception {
        Answer answer = journey("{\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"E\"},\"arriveBy\":\"08:39\"}");
        assertEquals(200, answer.status());
        assertEquals("noJourney", answer.body().get("status").asText());
        assertEquals(0, answer.body().get("journeys").size());
        assertTrue(answer.body().get("reason").asText().contains("by that time"), answer.body().toString());
    }

    @Test
    void exactlyOneOfDepartAndArriveByIsGiven() throws Exception {
        String ends = "\"from\":{\"stop\":\"A\"},\"to\":{\"stop\":\"E\"}";
        Answer both = journey("{" + ends + ",\"depart\":\"08:00\",\"arriveBy\":\"09:00\"}");
        assertEquals(400, both.status());
        assertTrue(both.body().get("error").asText().contains("not both"), both.body().toString());
        Answer neither = journey("{" + ends + "}");
        assertEquals(400, neither.status());
        assertTrue(neither.body().get("error").asText().contains("arriveBy"), neither.body().toString());
        Answer late = journey("{" + ends + ",\"arriveBy\":\"36:01\"}");
        assertEquals(400, late.status());
        assertTrue(late.body().get("error").asText().contains("arriveBy"), late.body().toString());
        // Arrive-by takes no account of how full vehicles are.
        Answer full = journey("{" + ends + ",\"arriveBy\":\"09:00\",\"capacity\":{\"mode\":\"check\",\"loads\":\"x\"}}");
        assertEquals(400, full.status());
        assertTrue(full.body().get("error").asText().contains("capacity"), full.body().toString());
        // A departure time alone still works as before.
        assertEquals(200, journey("{" + ends + ",\"depart\":\"08:00\"}").status());
    }

    @Test
    void aBulkRequestPlansArriveByJourneysInTheOrderAsked() throws Exception {
        List<JsonNode> lines = bulk("""
                {"timetable":"b1","queries":[
                  {"id":"a","from":{"stop":"A"},"to":{"stop":"E"},"arriveBy":"08:45"},
                  {"id":"b","from":{"stop":"B"},"to":{"stop":"E"},"arriveBy":"08:45"},
                  {"id":"c","from":{"stop":"A"},"to":{"stop":"D"},"arriveBy":"09:30"},
                  {"id":"d","from":{"stop":"A"},"to":{"stop":"E"},"arriveBy":"08:00"},
                  {"id":"e","from":{"stop":"A"},"to":{"stop":"D"},"depart":"08:30"},
                  {"id":"f","from":{"stop":"A"},"to":{"stop":"D"},"depart":"08:30","arriveBy":"09:30"}
                ]}""");
        assertEquals(7, lines.size());
        assertEquals("f", lines.get(0).get("id").asText());
        assertEquals("error", lines.get(0).get("status").asText());

        JsonNode a = lines.get(1);
        assertEquals("a", a.get("id").asText());
        assertEquals("ok", a.get("status").asText());
        assertEquals(8 * 3600 + 45 * 60, a.get("arriveBy").asInt());
        assertEquals(8 * 3600, a.get("journey").get("depart").asInt());
        assertEquals(300, a.get("journey").get("earlyWait").asInt());
        assertFalse(a.get("journey").get("legs").get(0).has("stops"));

        JsonNode b = lines.get(2);
        assertEquals("b", b.get("id").asText());
        assertEquals(8 * 3600 + 10 * 60, b.get("journey").get("depart").asInt());
        JsonNode c = lines.get(3);
        assertEquals(9 * 3600, c.get("journey").get("depart").asInt());
        assertEquals(0, c.get("journey").get("earlyWait").asInt());
        JsonNode d = lines.get(4);
        assertEquals("noJourney", d.get("status").asText());
        assertEquals(8 * 3600, d.get("arriveBy").asInt());
        // A departure time in the same request is planned as before, with no arrive-by fields.
        JsonNode e = lines.get(5);
        assertEquals("e", e.get("id").asText());
        assertEquals(9 * 3600 + 30 * 60, e.get("journey").get("arrive").asInt());
        assertFalse(e.has("arriveBy"));
        assertFalse(e.get("journey").has("earlyWait"));

        JsonNode summary = lines.get(6).get("summary");
        assertEquals(6, summary.get("queries").asInt());
        assertEquals(4, summary.get("ok").asInt());
        assertEquals(1, summary.get("noJourney").asInt());
        assertEquals(1, summary.get("errors").asInt());
    }

    @Test
    void aBulkArriveByRequestRefusesCapacity() throws Exception {
        Answer answer = http.post("/v1/journeys/bulk", """
                {"capacity":{"mode":"check","loads":"x"},"queries":[
                  {"from":{"stop":"A"},"to":{"stop":"E"},"arriveBy":"08:45"}]}""");
        assertEquals(400, answer.status());
        assertTrue(answer.body().get("error").asText().contains("capacity"), answer.body().toString());
    }
}
