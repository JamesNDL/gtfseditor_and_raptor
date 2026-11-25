package gtfseditor.router.server;

import static gtfseditor.router.server.RoadFixture.corner;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import gtfseditor.router.server.RoadFixture.Answer;
import java.net.http.HttpClient;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The four ways to run road routing ({@code ROUTER_ROAD}: auto, on, off, only), what health says
 * of each, and the four road settings (AA-3; FR-1, NFR-2; architecture §3.2; D15, D19).
 */
class RoadModesTest {

    private static final String ROUTE = "{\"from\": " + corner(0, 0) + ", \"to\": " + corner(3, 3)
            + ", \"profile\": \"car\"}";

    @TempDir
    static Path folder;

    private static Path graph;
    private static HttpClient client;

    @BeforeAll
    static void build() {
        graph = RoadFixture.buildGraph(folder);
        client = HttpClient.newHttpClient();
    }

    @AfterAll
    static void closeClient() {
        client.close();
    }

    private static RouterServer start(Settings.RoadMode mode, Path roadGraph) {
        return new RouterServer(Settings.defaults(folder.resolve("data")).withPort(0).withRoad(mode, roadGraph))
                .start();
    }

    private static JsonNode road(RouterServer server) throws Exception {
        Answer health = new RoadFixture.Http(client, server.port()).get("/v1/health");
        assertEquals(200, health.status());
        assertEquals("up", health.body().get("status").asText());
        return health.body().get("road");
    }

    // ---- health

    @Test
    void healthDescribesTheGraphWhenRoadRoutingIsOn() throws Exception {
        try (RouterServer server = start(Settings.RoadMode.ON, graph)) {
            JsonNode road = road(server);
            assertTrue(road.get("available").asBoolean());
            assertEquals(graph.toString(), road.get("graph").asText());
            assertEquals("mini-roads.osm", road.get("builtFrom").asText());
            assertFalse(road.get("builtAt").asText().isBlank());
            assertEquals("on", road.get("mode").asText());
        }
    }

    @Test
    void autoIsOnWhenTheGraphIsThere() throws Exception {
        try (RouterServer server = start(Settings.RoadMode.AUTO, graph)) {
            JsonNode road = road(server);
            assertTrue(road.get("available").asBoolean());
            assertEquals("auto", road.get("mode").asText());
            assertEquals(200, new RoadFixture.Http(client, server.port()).post("/v1/road/route", ROUTE).status());
        }
    }

    @Test
    void autoIsOffWhenTheGraphIsMissing() throws Exception {
        try (RouterServer server = start(Settings.RoadMode.AUTO, folder.resolve("no-graph-here"))) {
            JsonNode road = road(server);
            assertFalse(road.get("available").asBoolean());
            assertEquals("auto", road.get("mode").asText());
            Answer answer = new RoadFixture.Http(client, server.port()).post("/v1/road/route", ROUTE);
            assertEquals(503, answer.status());
            assertFalse(answer.body().get("error").asText().isBlank());
        }
    }

    @Test
    void offIsOffEvenWithTheGraph() throws Exception {
        try (RouterServer server = start(Settings.RoadMode.OFF, graph)) {
            JsonNode road = road(server);
            assertFalse(road.get("available").asBoolean());
            assertEquals("off", road.get("mode").asText());
            assertEquals(503, new RoadFixture.Http(client, server.port()).post("/v1/road/table",
                    "{\"sources\": [" + corner(0, 0) + "], \"destinations\": [" + corner(3, 3) + "]}").status());
        }
    }

    // ---- refusing to start

    @Test
    void onWithNoGraphRefusesToStartWithAMessage() {
        Path missing = folder.resolve("missing-graph");
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> start(Settings.RoadMode.ON, missing).close());
        assertTrue(e.getMessage().contains("ROUTER_ROAD"), e.getMessage());
        assertTrue(e.getMessage().contains(missing.toString()), e.getMessage());
    }

    @Test
    void roadsOnlyWithNoGraphRefusesToStart() {
        assertThrows(IllegalStateException.class,
                () -> start(Settings.RoadMode.ONLY, folder.resolve("missing-graph")).close());
    }

    // ---- roads only (A5)

    @Test
    void roadsOnlyAnswers503ForEverythingButRoadsAndHealth() throws Exception {
        try (RouterServer server = start(Settings.RoadMode.ONLY, graph)) {
            RoadFixture.Http http = new RoadFixture.Http(client, server.port());
            List<Answer> refused = List.of(
                    http.post("/v1/journeys", "{\"timetable\": \"b1\"}"),
                    http.post("/v1/journeys/bulk", "{\"queries\": []}"),
                    http.get("/v1/timetables"),
                    http.get("/v1/timetables/b1"),
                    http.put("/v1/timetables/b1", "{\"source\": {\"path\": \"x.zip\"}}"),
                    http.get("/v1/timetables/b1/loads"),
                    http.post("/v1/simulations", "{}"),
                    http.get("/v1/simulations"),
                    http.post("/v1/demand/generate", "{}"));
            for (Answer answer : refused) {
                assertEquals(503, answer.status());
                assertEquals("this router runs roads only", answer.body().get("error").asText());
            }
            assertEquals("ok", http.post("/v1/road/route", ROUTE).body().get("status").asText());
            assertEquals(200, http.post("/v1/road/table", "{\"sources\": [" + corner(0, 0)
                    + "], \"destinations\": [" + corner(3, 3) + "]}").status());
            JsonNode road = road(server);
            assertTrue(road.get("available").asBoolean());
            assertEquals("only", road.get("mode").asText());
        }
    }

    // ---- settings

    @Test
    void roadSettingsHaveDefaults() {
        Settings settings = Settings.from(Map.of());
        assertEquals(Settings.RoadMode.AUTO, settings.road());
        assertEquals(Path.of("data/router/road/opal"), settings.roadGraph());
        assertEquals(500, settings.roadSnapMetres());
        assertEquals(100_000, settings.roadTableLimit());
    }

    @Test
    void roadSettingsAreReadFromTheEnvironment() {
        Settings settings = Settings.from(Map.of("ROUTER_ROAD", " Only ", "ROUTER_ROAD_GRAPH", "elsewhere/roads",
                "ROUTER_ROAD_SNAP_METRES", "250", "ROUTER_ROAD_TABLE_LIMIT", "5000"));
        assertEquals(Settings.RoadMode.ONLY, settings.road());
        assertEquals(Path.of("elsewhere/roads"), settings.roadGraph());
        assertEquals(250, settings.roadSnapMetres());
        assertEquals(5000, settings.roadTableLimit());
        for (String mode : List.of("on", "off", "auto")) {
            assertEquals(mode, Settings.from(Map.of("ROUTER_ROAD", mode)).road().wireName());
        }
    }

    @Test
    void badRoadSettingsAreRejectedByName() {
        Map<String, String> bad = Map.of("ROUTER_ROAD", "sometimes", "ROUTER_ROAD_SNAP_METRES", "9",
                "ROUTER_ROAD_TABLE_LIMIT", "0");
        bad.forEach((name, value) -> {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> Settings.from(Map.of(name, value)));
            assertTrue(e.getMessage().contains(name), e.getMessage());
        });
        assertThrows(IllegalArgumentException.class, () -> Settings.from(Map.of("ROUTER_ROAD_SNAP_METRES", "5001")));
    }
}
