package gtfseditor.router.server;

import static gtfseditor.router.server.RoadFixture.FAR_FROM_ROADS;
import static gtfseditor.router.server.RoadFixture.ISLAND;
import static gtfseditor.router.server.RoadFixture.corner;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import gtfseditor.router.server.RoadFixture.Answer;
import java.net.http.HttpClient;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code POST /v1/road/route} and {@code POST /v1/road/table} on the hand-made map (AA-3; FR-1,
 * FR-2; architecture §3.3): the exact answer shapes, and the requests that are refused.
 */
class RoadApiTest {

    @TempDir
    static Path folder;

    private static Path graph;
    private static RouterServer server;
    private static HttpClient client;
    private static RoadFixture.Http http;

    @BeforeAll
    static void start() {
        graph = RoadFixture.buildGraph(folder);
        server = new RouterServer(Settings.defaults(folder.resolve("data")).withPort(0)
                .withRoad(Settings.RoadMode.ON, graph)).start();
        client = HttpClient.newHttpClient();
        http = new RoadFixture.Http(client, server.port());
    }

    @AfterAll
    static void stop() {
        client.close();
        server.close();
    }

    private static Answer route(String from, String to) throws Exception {
        return http.post("/v1/road/route", "{\"from\": " + from + ", \"to\": " + to + ", \"profile\": \"car\"}");
    }

    private static Set<String> keys(JsonNode node) {
        Set<String> keys = new TreeSet<>();
        node.fieldNames().forEachRemaining(keys::add);
        return keys;
    }

    // ---- one drive (FR-1)

    @Test
    void aDriveIsOkWithExactlyTheFieldsOfTheDesign() throws Exception {
        Answer answer = route(corner(0, 0), corner(3, 3));
        assertEquals(200, answer.status(), String.valueOf(answer.body()));
        JsonNode body = answer.body();
        assertEquals(new TreeSet<>(List.of("status", "profile", "freeFlow", "metres", "durationSecs", "geometry",
                "snapMetres", "computeMicros")), keys(body));
        assertEquals("ok", body.get("status").asText());
        assertEquals("car", body.get("profile").asText());
        assertTrue(body.get("freeFlow").asBoolean());
        // Along the streets: two sides of about 300 m each, not the 424 m diagonal.
        assertTrue(body.get("metres").asDouble() > 550, body.toString());
        assertTrue(body.get("durationSecs").asDouble() > 0, body.toString());
        JsonNode geometry = body.get("geometry");
        assertTrue(geometry.size() >= 2, "a line of at least two points");
        for (JsonNode lonLat : geometry) {
            assertEquals(2, lonLat.size());
            assertEquals(151.737, lonLat.get(0).asDouble(), 0.01, "longitude first");
            assertEquals(-32.898, lonLat.get(1).asDouble(), 0.01, "then latitude");
        }
        assertEquals(Set.of("from", "to"), keys(body.get("snapMetres")));
        assertTrue(body.get("snapMetres").get("from").asDouble() < 50);
        assertTrue(body.get("snapMetres").get("to").asDouble() < 50);
        assertTrue(body.get("computeMicros").isIntegralNumber());
    }

    @Test
    void aProfileLeftOutMeansCar() throws Exception {
        Answer answer = http.post("/v1/road/route", "{\"from\": " + corner(0, 0) + ", \"to\": " + corner(0, 3) + "}");
        assertEquals(200, answer.status());
        assertEquals("car", answer.body().get("profile").asText());
    }

    @Test
    void viaPointsAreDrivenThroughInOrder() throws Exception {
        double direct = route(corner(0, 0), corner(0, 3)).body().get("metres").asDouble();
        Answer answer = http.post("/v1/road/route", "{\"from\": " + corner(0, 0) + ", \"to\": " + corner(0, 3)
                + ", \"via\": [" + corner(3, 0) + ", " + corner(3, 3) + "], \"profile\": \"car\"}");
        assertEquals("ok", answer.body().get("status").asText());
        // Down the west side, along the bottom and back up: well over twice the direct drive.
        assertTrue(answer.body().get("metres").asDouble() > 2 * direct, answer.body().toString());
    }

    @Test
    void noWayByRoadIsNoRouteWithAReason() throws Exception {
        Answer answer = route(corner(0, 0), ISLAND);
        assertEquals(200, answer.status());
        assertEquals("noRoute", answer.body().get("status").asText());
        assertFalse(answer.body().get("reason").asText().isBlank());
        assertTrue(answer.body().get("metres").isNull());
        assertTrue(answer.body().get("durationSecs").isNull());
        assertEquals(0, answer.body().get("geometry").size());
        assertTrue(answer.body().get("snapMetres").get("to").isNumber(), "the island has a road");
    }

    @Test
    void anEndWithNoRoadNearbyIsNoRoadAndTheReasonSaysWhichEnd() throws Exception {
        Answer fromFar = route(FAR_FROM_ROADS, corner(0, 0));
        assertEquals("noRoad", fromFar.body().get("status").asText());
        assertTrue(fromFar.body().get("reason").asText().contains("start"), fromFar.body().toString());
        assertTrue(fromFar.body().get("snapMetres").get("from").isNull());
        assertTrue(fromFar.body().get("snapMetres").get("to").isNumber());

        Answer toFar = route(corner(0, 0), FAR_FROM_ROADS);
        assertEquals("noRoad", toFar.body().get("status").asText());
        assertTrue(toFar.body().get("reason").asText().contains("end"), toFar.body().toString());
        assertTrue(toFar.body().get("snapMetres").get("to").isNull());
    }

    // ---- many drives (FR-2)

    @Test
    void aTableHasRowsForSourcesAndNullWhereThereIsNoWay() throws Exception {
        Answer answer = http.post("/v1/road/table", "{\"sources\": [" + corner(0, 0) + ", " + corner(3, 3)
                + "], \"destinations\": [" + corner(1, 1) + ", " + ISLAND + ", " + FAR_FROM_ROADS
                + "], \"profile\": \"car\"}");
        assertEquals(200, answer.status(), String.valueOf(answer.body()));
        JsonNode body = answer.body();
        assertEquals(new TreeSet<>(List.of("profile", "freeFlow", "durationsSecs", "metres", "sourceSnapMetres",
                "destinationSnapMetres", "computeMicros")), keys(body));
        assertEquals("car", body.get("profile").asText());
        assertTrue(body.get("freeFlow").asBoolean());
        for (String name : List.of("durationsSecs", "metres")) {
            JsonNode rows = body.get(name);
            assertEquals(2, rows.size(), name);
            for (JsonNode row : rows) {
                assertEquals(3, row.size(), name);
                assertTrue(row.get(0).asDouble() > 0, name + " to a street corner");
                assertTrue(row.get(1).isNull(), name + ": no way to the island");
                assertTrue(row.get(2).isNull(), name + ": no road near the end");
            }
        }
        assertEquals(2, body.get("sourceSnapMetres").size());
        assertTrue(body.get("sourceSnapMetres").get(0).isNumber());
        assertTrue(body.get("destinationSnapMetres").get(1).isNumber(), "the island has a road");
        assertTrue(body.get("destinationSnapMetres").get(2).isNull(), "no road near the far point");
        assertTrue(body.get("computeMicros").isIntegralNumber());
    }

    /** AC-FR-2.1: 100 starting points and 3 ending points give 300 times and distances at once. */
    @Test
    void aHundredSourcesAndThreeDestinationsGiveThreeHundredDrives() throws Exception {
        List<String> sources = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            sources.add(RoadFixture.point(-32.8970 - 0.0027 * (i % 10) / 9.0, 151.7360 + 0.0032 * (i / 10) / 9.0));
        }
        Answer answer = http.post("/v1/road/table", "{\"sources\": [" + String.join(", ", sources)
                + "], \"destinations\": [" + corner(0, 0) + ", " + corner(1, 2) + ", " + corner(3, 3)
                + "], \"profile\": \"car\"}");
        assertEquals(200, answer.status(), String.valueOf(answer.body()));
        int times = 0;
        for (JsonNode row : answer.body().get("durationsSecs")) {
            for (JsonNode cell : row) {
                times += cell.isNumber() ? 1 : 0;
            }
        }
        assertEquals(300, times);
    }

    // ---- refused requests

    private static void assertRefused(String path, String body) throws Exception {
        Answer answer = http.post(path, body);
        assertEquals(400, answer.status(), body);
        assertEquals(Set.of("error"), keys(answer.body()), body);
        assertFalse(answer.body().get("error").asText().isBlank());
    }

    @Test
    void aProfileOtherThanCarIsRefused() throws Exception {
        assertRefused("/v1/road/route", "{\"from\": " + corner(0, 0) + ", \"to\": " + corner(0, 3)
                + ", \"profile\": \"bike\"}");
        assertRefused("/v1/road/table", "{\"sources\": [" + corner(0, 0) + "], \"destinations\": ["
                + corner(0, 3) + "], \"profile\": \"foot\"}");
    }

    @Test
    void badCoordinatesAreRefused() throws Exception {
        for (String bad : List.of("{\"lat\": 95, \"lon\": 151.7}", "{\"lat\": -32.9, \"lon\": 181}",
                "{\"lat\": \"north\", \"lon\": 151.7}", "{\"lon\": 151.7}", "[151.7, -32.9]", "null")) {
            assertRefused("/v1/road/route", "{\"from\": " + bad + ", \"to\": " + corner(0, 3) + "}");
            assertRefused("/v1/road/table", "{\"sources\": [" + bad + "], \"destinations\": [" + corner(0, 3) + "]}");
        }
        assertRefused("/v1/road/route", "{\"from\": " + corner(0, 0) + "}");
        assertRefused("/v1/road/route", "{\"from\": " + corner(0, 0) + ", \"to\": " + corner(0, 3)
                + ", \"via\": " + corner(1, 1) + "}");
        assertRefused("/v1/road/table", "{\"sources\": [], \"destinations\": [" + corner(0, 3) + "]}");
        assertRefused("/v1/road/table", "{\"sources\": [" + corner(0, 0) + "]}");
        assertRefused("/v1/road/route", "not json");
    }

    @Test
    void moreTablePairsThanTheLimitAreRefused() throws Exception {
        try (RouterServer small = new RouterServer(Settings.defaults(folder.resolve("small")).withPort(0)
                .withRoad(Settings.RoadMode.ON, graph).withRoadTableLimit(4)).start()) {
            RoadFixture.Http smallHttp = new RoadFixture.Http(client, small.port());
            String two = corner(0, 0) + ", " + corner(3, 3);
            String three = two + ", " + corner(1, 1);
            Answer atLimit = smallHttp.post("/v1/road/table", "{\"sources\": [" + two + "], \"destinations\": ["
                    + two + "]}");
            assertEquals(200, atLimit.status(), "2 × 2 is the limit of 4");
            Answer over = smallHttp.post("/v1/road/table", "{\"sources\": [" + three + "], \"destinations\": ["
                    + two + "]}");
            assertEquals(400, over.status(), "3 × 2 is over the limit of 4");
            assertTrue(over.body().get("error").asText().contains("4"), over.body().toString());
        }
    }
}
