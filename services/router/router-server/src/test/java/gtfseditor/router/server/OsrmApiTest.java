package gtfseditor.router.server;

import static gtfseditor.router.server.RoadFixture.OSRM_ISLAND;
import static gtfseditor.router.server.RoadFixture.osrmCorner;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import gtfseditor.router.server.RoadFixture.Answer;
import java.net.http.HttpClient;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The OSRM-shaped endpoints answering the editor's own requests (AA-4; FR-13; architecture §3.3,
 * §3.6; D16). Each request is built exactly as {@code apps/api/src/routing/roads.ts} builds it, and
 * each answer is checked for the fields roads.ts reads and the rest of OSRM's shape.
 */
class OsrmApiTest {

    /** What roads.ts's {@code askRouter} adds to every route request. */
    static final String ROUTE_OPTIONS = "?overview=full&geometries=geojson&steps=false";

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

    static Set<String> keys(JsonNode node) {
        Set<String> keys = new TreeSet<>();
        node.fieldNames().forEachRemaining(keys::add);
        return keys;
    }

    private static Answer ok(String path) throws Exception {
        Answer answer = http.get(path);
        assertEquals(200, answer.status(), path + " " + answer.body());
        assertEquals("Ok", answer.body().get("code").asText());
        return answer;
    }

    /** One OSRM route: the fields roads.ts reads, and the rest of the design's shape. */
    private static void assertRoute(JsonNode route, int legs) {
        assertEquals(Set.of("distance", "duration", "weight", "weight_name", "geometry", "legs"), keys(route));
        assertTrue(route.get("distance").asDouble() > 0, route.toString());
        assertTrue(route.get("duration").asDouble() > 0, route.toString());
        assertEquals(route.get("duration").asDouble(), route.get("weight").asDouble());
        assertEquals("duration", route.get("weight_name").asText());
        assertEquals("LineString", route.get("geometry").get("type").asText());
        JsonNode coordinates = route.get("geometry").get("coordinates");
        assertTrue(coordinates.size() >= 2, "a line of at least two points");
        for (JsonNode lonLat : coordinates) {
            assertEquals(151.737, lonLat.get(0).asDouble(), 0.01, "longitude first");
            assertEquals(-32.898, lonLat.get(1).asDouble(), 0.01, "then latitude");
        }
        assertEquals(legs, route.get("legs").size());
        double sum = 0;
        for (JsonNode leg : route.get("legs")) {
            assertEquals(Set.of("distance", "duration", "summary", "steps"), keys(leg));
            assertEquals("", leg.get("summary").asText());
            assertEquals(0, leg.get("steps").size());
            sum += leg.get("distance").asDouble();
        }
        assertEquals(route.get("distance").asDouble(), sum, 0.5, "the legs add up to the route");
    }

    private static void assertWaypoint(JsonNode waypoint) {
        assertEquals(2, waypoint.get("location").size());
        assertEquals(151.737, waypoint.get("location").get(0).asDouble(), 0.01, "longitude first");
        assertEquals("", waypoint.get("name").asText());
        assertTrue(waypoint.get("distance").asDouble() < 50, waypoint.toString());
    }

    // ---- route (askRouter)

    @Test
    void theRouteRoadsTsAsksForIsOkInOsrmShape() throws Exception {
        String points = osrmCorner(0, 0) + ";" + osrmCorner(3, 3);
        JsonNode body = ok("/route/v1/driving/" + points + ROUTE_OPTIONS).body();
        assertEquals(Set.of("code", "routes", "waypoints"), keys(body));
        assertEquals(1, body.get("routes").size(), "no alternatives unless asked for");
        assertRoute(body.get("routes").get(0), 1);
        // Along the streets: two sides of about 300 m each, not the 424 m diagonal.
        assertTrue(body.get("routes").get(0).get("distance").asDouble() > 550);
        assertEquals(2, body.get("waypoints").size());
        for (JsonNode waypoint : body.get("waypoints")) {
            assertEquals(Set.of("location", "name", "distance"), keys(waypoint));
            assertWaypoint(waypoint);
        }
    }

    @Test
    void aRouteThroughSeveralPointsHasALegForEachHop() throws Exception {
        String points = osrmCorner(0, 0) + ";" + osrmCorner(3, 0) + ";" + osrmCorner(3, 3) + ";" + osrmCorner(0, 3);
        JsonNode body = ok("/route/v1/driving/" + points + ROUTE_OPTIONS).body();
        assertRoute(body.get("routes").get(0), 3);
        assertEquals(4, body.get("waypoints").size());
    }

    @Test
    void alternativesGiveOneToThreeRoutes() throws Exception {
        String points = osrmCorner(0, 0) + ";" + osrmCorner(3, 3);
        JsonNode routes = ok("/route/v1/driving/" + points + ROUTE_OPTIONS + "&alternatives=3").body().get("routes");
        assertTrue(routes.size() >= 1 && routes.size() <= 3, routes.toString());
        for (JsonNode route : routes) {
            assertRoute(route, 1);
        }
        JsonNode viaTrue = ok("/route/v1/driving/" + points + ROUTE_OPTIONS + "&alternatives=true").body();
        assertTrue(viaTrue.get("routes").size() <= 3);
        // Only for two points: more give the one route.
        String three = points + ";" + osrmCorner(0, 3);
        assertEquals(1, ok("/route/v1/driving/" + three + ROUTE_OPTIONS + "&alternatives=3").body().get("routes")
                .size());
    }

    @Test
    void overviewFalseLeavesOutTheGeometry() throws Exception {
        String points = osrmCorner(0, 0) + ";" + osrmCorner(3, 3);
        JsonNode route = ok("/route/v1/driving/" + points + "?overview=false").body().get("routes").get(0);
        assertFalse(route.has("geometry"), route.toString());
        assertTrue(route.get("distance").asDouble() > 550);
    }

    // ---- table (askTable)

    @Test
    void theTableRoadsTsAsksForGivesDistancesWithNullWhereThereIsNoWay() throws Exception {
        String points = osrmCorner(0, 0) + ";" + osrmCorner(3, 3) + ";" + OSRM_ISLAND;
        JsonNode body = ok("/table/v1/driving/" + points + "?annotations=distance").body();
        assertEquals(Set.of("code", "distances", "sources", "destinations"), keys(body));
        JsonNode distances = body.get("distances");
        assertEquals(3, distances.size());
        for (int i = 0; i < 3; i++) {
            assertEquals(3, distances.get(i).size());
            assertEquals(0, distances.get(i).get(i).asDouble(), 1, "a point to itself");
        }
        assertTrue(distances.get(0).get(1).asDouble() > 550, distances.toString());
        assertTrue(distances.get(0).get(2).isNull(), "no way to the island");
        assertTrue(distances.get(2).get(0).isNull(), "no way from the island");
        assertEquals(3, body.get("sources").size());
        assertEquals(3, body.get("destinations").size());
        assertWaypoint(body.get("sources").get(0));
    }

    @Test
    void annotationsChooseDurationsDistancesOrBoth() throws Exception {
        String points = osrmCorner(0, 0) + ";" + osrmCorner(3, 3);
        assertEquals(Set.of("code", "durations", "sources", "destinations"),
                keys(ok("/table/v1/driving/" + points).body()), "durations by default, as OSRM");
        assertEquals(Set.of("code", "durations", "sources", "destinations"),
                keys(ok("/table/v1/driving/" + points + "?annotations=duration").body()));
        JsonNode both = ok("/table/v1/driving/" + points + "?annotations=duration,distance").body();
        assertEquals(Set.of("code", "durations", "distances", "sources", "destinations"), keys(both));
        assertTrue(both.get("durations").get(0).get(1).asDouble() > 0);
        assertTrue(both.get("distances").get(0).get(1).asDouble() > 550);
    }

    @Test
    void sourcesAndDestinationsPickRowsAndColumns() throws Exception {
        String points = osrmCorner(0, 0) + ";" + osrmCorner(3, 3) + ";" + osrmCorner(0, 3) + ";" + osrmCorner(3, 0);
        JsonNode body = ok("/table/v1/driving/" + points + "?annotations=distance&sources=0;1&destinations=2;3;0")
                .body();
        JsonNode distances = body.get("distances");
        assertEquals(2, distances.size(), "a row per source");
        assertEquals(3, distances.get(0).size(), "a column per destination");
        assertEquals(0, distances.get(0).get(2).asDouble(), 1, "point 0 to point 0");
        assertEquals(2, body.get("sources").size());
        assertEquals(3, body.get("destinations").size());
        JsonNode all = ok("/table/v1/driving/" + points + "?sources=1&destinations=all").body();
        assertEquals(1, all.get("durations").size());
        assertEquals(4, all.get("durations").get(0).size());
    }

    // ---- nearest (nearestRoad)

    @Test
    void theNearestRoadsTsAsksForGivesOnePointOnARoad() throws Exception {
        // Inside a block of the grid, about 22 m south of the nearest street.
        String between = RoadFixture.osrmPoint(-32.8972, 151.73650);
        JsonNode body = ok("/nearest/v1/driving/" + between + "?number=1").body();
        assertEquals(Set.of("code", "waypoints"), keys(body));
        assertEquals(1, body.get("waypoints").size());
        JsonNode waypoint = body.get("waypoints").get(0);
        assertEquals(Set.of("location", "distance", "name", "nodes"), keys(waypoint));
        assertWaypoint(waypoint);
        assertTrue(waypoint.get("distance").asDouble() > 1, "the point is off the road");
        assertEquals(List.of(0, 0), List.of(waypoint.get("nodes").get(0).asInt(), waypoint.get("nodes").get(1).asInt()));
        assertEquals(1, ok("/nearest/v1/driving/" + between + "?number=3").body().get("waypoints").size(),
                "more than one asked for still gives one");
    }

    // ---- road only (A5)

    @Test
    void roadsOnlyAnswersTheSame() throws Exception {
        List<String> asked = List.of(
                "/route/v1/driving/" + osrmCorner(0, 0) + ";" + osrmCorner(3, 3) + ROUTE_OPTIONS,
                "/route/v1/driving/" + osrmCorner(0, 0) + ";" + osrmCorner(3, 3) + ROUTE_OPTIONS + "&alternatives=3",
                "/table/v1/driving/" + osrmCorner(0, 0) + ";" + osrmCorner(3, 3) + "?annotations=distance",
                "/nearest/v1/driving/" + osrmCorner(1, 1) + "?number=1",
                "/route/v1/driving/" + osrmCorner(0, 0) + ";" + OSRM_ISLAND + ROUTE_OPTIONS);
        try (RouterServer only = new RouterServer(Settings.defaults(folder.resolve("only")).withPort(0)
                .withRoad(Settings.RoadMode.ONLY, graph)).start()) {
            RoadFixture.Http onlyHttp = new RoadFixture.Http(client, only.port());
            for (String path : asked) {
                Answer normal = http.get(path);
                Answer roadsOnly = onlyHttp.get(path);
                assertTrue(roadsOnly.body() != null && roadsOnly.body().has("code"), "an OSRM answer: " + path);
                assertEquals(normal.status(), roadsOnly.status(), path);
                assertEquals(normal.body(), roadsOnly.body(), path);
            }
        }
    }

    @Test
    void withRoadRoutingOffTheyAreUnavailable() throws Exception {
        try (RouterServer off = new RouterServer(Settings.defaults(folder.resolve("off")).withPort(0)
                .withRoad(Settings.RoadMode.OFF, graph)).start()) {
            Answer answer = new RoadFixture.Http(client, off.port())
                    .get("/nearest/v1/driving/" + osrmCorner(1, 1) + "?number=1");
            assertEquals(503, answer.status());
        }
    }
}
