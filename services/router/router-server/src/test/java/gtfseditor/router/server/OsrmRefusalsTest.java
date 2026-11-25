package gtfseditor.router.server;

import static gtfseditor.router.server.OsrmApiTest.ROUTE_OPTIONS;
import static gtfseditor.router.server.RoadFixture.OSRM_FAR_FROM_ROADS;
import static gtfseditor.router.server.RoadFixture.OSRM_ISLAND;
import static gtfseditor.router.server.RoadFixture.osrmCorner;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import gtfseditor.router.server.RoadFixture.Answer;
import java.net.http.HttpClient;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * What the OSRM-shaped endpoints refuse, and how (AA-4; FR-13; architecture §3.3): HTTP 400 with
 * {@code {code, message}} as OSRM sends it, which roads.ts reads as an answer of "no route".
 */
class OsrmRefusalsTest {

    private static final String TWO = osrmCorner(0, 0) + ";" + osrmCorner(3, 3);

    @TempDir
    static Path folder;

    private static RouterServer server;
    private static HttpClient client;
    private static RoadFixture.Http http;

    @BeforeAll
    static void start() {
        Path graph = RoadFixture.buildGraph(folder);
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

    private static void assertRefused(String code, String path) throws Exception {
        Answer answer = http.get(path);
        assertEquals(400, answer.status(), path + " " + answer.body());
        assertEquals(Set.of("code", "message"), OsrmApiTest.keys(answer.body()), path);
        assertEquals(code, answer.body().get("code").asText(), path);
        assertFalse(answer.body().get("message").asText().isBlank(), path);
    }

    /** {@code count} street corners, each different from the one before, joined as OSRM lists them. */
    private static String corners(int count) {
        List<String> points = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            points.add(osrmCorner(i % 4, (i / 4) % 4));
        }
        return String.join(";", points);
    }

    @Test
    void noWayByRoadIsNoRoute() throws Exception {
        assertRefused("NoRoute", "/route/v1/driving/" + osrmCorner(0, 0) + ";" + OSRM_ISLAND + ROUTE_OPTIONS);
        assertRefused("NoRoute", "/route/v1/driving/" + osrmCorner(0, 0) + ";" + OSRM_ISLAND + ROUTE_OPTIONS
                + "&alternatives=3");
    }

    @Test
    void aPointWithNoRoadIsNoSegment() throws Exception {
        assertRefused("NoSegment", "/route/v1/driving/" + OSRM_FAR_FROM_ROADS + ";" + osrmCorner(0, 0)
                + ROUTE_OPTIONS);
        assertRefused("NoSegment", "/route/v1/driving/" + TWO + ";" + OSRM_FAR_FROM_ROADS + ROUTE_OPTIONS);
        assertRefused("NoSegment", "/nearest/v1/driving/" + OSRM_FAR_FROM_ROADS + "?number=1");
    }

    @Test
    void badCoordinatesAreInvalidQuery() throws Exception {
        for (String bad : List.of("north,south", "151.737", "151.737,-32.898,4", "181.0,-32.898",
                "151.737,-90.5", "151.737,", ",-32.898", "151.737,-32.898;", "NaN,-32.898")) {
            assertRefused("InvalidQuery", "/route/v1/driving/" + osrmCorner(0, 0) + ";" + bad + ROUTE_OPTIONS);
            assertRefused("InvalidQuery", "/table/v1/driving/" + osrmCorner(0, 0) + ";" + bad
                    + "?annotations=distance");
            assertRefused("InvalidQuery", "/nearest/v1/driving/" + bad + "?number=1");
        }
    }

    @Test
    void optionsTheRouterDoesNotOfferAreInvalidOptions() throws Exception {
        assertRefused("InvalidOptions", "/route/v1/driving/" + TWO + "?overview=full&geometries=polyline&steps=false");
        assertRefused("InvalidOptions", "/route/v1/driving/" + TWO + "?overview=full&geometries=polyline6");
        assertRefused("InvalidOptions", "/route/v1/driving/" + TWO + "?overview=full&geometries=geojson&steps=true");
        assertRefused("InvalidOptions", "/route/v1/driving/" + TWO + "?overview=sometimes&geometries=geojson");
        assertRefused("InvalidOptions", "/route/v1/driving/" + TWO + ROUTE_OPTIONS + "&alternatives=many");
        assertRefused("InvalidOptions", "/route/v1/driving/" + osrmCorner(0, 0) + ROUTE_OPTIONS);
        assertRefused("InvalidOptions", "/table/v1/driving/" + TWO + "?annotations=speed");
        assertRefused("InvalidOptions", "/table/v1/driving/" + TWO + "?sources=0;2");
        assertRefused("InvalidOptions", "/table/v1/driving/" + TWO + "?destinations=first");
        assertRefused("InvalidOptions", "/nearest/v1/driving/" + osrmCorner(0, 0) + "?number=0");
        assertRefused("InvalidOptions", "/nearest/v1/driving/" + TWO + "?number=1");
    }

    @Test
    void routesTakeUpTo500PointsAndNoMore() throws Exception {
        Answer most = http.get("/route/v1/driving/" + corners(500) + "?overview=false");
        assertEquals(200, most.status(), String.valueOf(most.body()));
        assertEquals(499, most.body().get("routes").get(0).get("legs").size());
        assertRefused("TooBig", "/route/v1/driving/" + corners(501) + ROUTE_OPTIONS);
    }

    @Test
    void tablesTakeUpTo100PointsAndNoMore() throws Exception {
        Answer most = http.get("/table/v1/driving/" + corners(100) + "?annotations=distance");
        assertEquals(200, most.status(), String.valueOf(most.body()));
        assertEquals(100, most.body().get("distances").size());
        assertRefused("TooBig", "/table/v1/driving/" + corners(101) + "?annotations=distance");
    }
}
