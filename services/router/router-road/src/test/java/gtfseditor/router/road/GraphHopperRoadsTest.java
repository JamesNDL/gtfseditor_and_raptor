package gtfseditor.router.road;

import static gtfseditor.router.road.MiniRoads.corner;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Geo;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Drives and nearest roads on the hand-made map (AA-1, FR-1). */
class GraphHopperRoadsTest {

    @TempDir
    static Path folder;

    private static GraphHopperRoads roads;

    @BeforeAll
    static void buildAndOpen() throws IOException {
        Path graph = folder.resolve("graph");
        // The test map is far smaller than GraphHopper's smallest kept network, so keep every one.
        RoadGraphBuilder.build(MiniRoads.osmFile(), graph, 0);
        roads = GraphHopperRoads.open(RoadSettings.defaults(graph));
    }

    @AfterAll
    static void close() {
        roads.close();
    }

    @Test
    void isAvailableOnceOpen() {
        assertTrue(roads.available());
    }

    @Test
    void drivesBetweenTwoStreetCorners() {
        LatLon from = corner(0, 0);
        LatLon to = corner(3, 3);
        RoadRoute route = roads.route(List.of(from, to), false);

        assertEquals(RoadRoute.Status.OK, route.status());
        assertTrue(route.metres() > 0, "metres");
        assertTrue(route.seconds() > 0, "seconds");
        double[][] path = route.path();
        assertTrue(path.length >= 2, "a path of at least two points");
        assertTrue(metresTo(path[0], from) < 50, "the path starts near the asked start");
        assertTrue(metresTo(path[path.length - 1], to) < 50, "the path ends near the asked end");
        // Along the streets it is the sum of the two sides (about 300 m each), not the 424 m diagonal.
        assertTrue(route.metres() > 550, "along the streets, not straight across: " + route.metres());
        assertEquals(1, route.legs().size());
        assertEquals(route.metres(), route.legs().getFirst().metres(), 0.01);
        assertEquals(2, route.snapped().size());
        assertTrue(route.snapped().getFirst().found());
        assertTrue(route.alternatives().isEmpty());
    }

    @Test
    void pathIsLonLatPairs() {
        RoadRoute route = roads.route(List.of(corner(0, 0), corner(0, 3)), false);

        assertEquals(RoadRoute.Status.OK, route.status());
        for (double[] point : route.path()) {
            assertEquals(2, point.length);
            assertTrue(point[0] > 151 && point[0] < 152, "longitude first: " + point[0]);
            assertTrue(point[1] < -32 && point[1] > -33, "latitude second: " + point[1]);
        }
    }

    @Test
    void goesThroughEveryPointInOrderWithOneLegPerHop() {
        RoadRoute route = roads.route(List.of(corner(0, 0), corner(0, 3), corner(3, 3)), false);

        assertEquals(RoadRoute.Status.OK, route.status());
        assertEquals(2, route.legs().size());
        double legMetres = route.legs().get(0).metres() + route.legs().get(1).metres();
        double legSeconds = route.legs().get(0).seconds() + route.legs().get(1).seconds();
        assertEquals(route.metres(), legMetres, 0.01);
        assertEquals(route.seconds(), legSeconds, 0.01);
        assertEquals(300, route.legs().get(0).metres(), 30, "first leg along the top row");
        assertEquals(300, route.legs().get(1).metres(), 30, "second leg down the east column");
        assertEquals(3, route.snapped().size());
    }

    @Test
    void neverDrivesTheOneWayStreetTheWrongWay() {
        RoadRoute east = roads.route(List.of(corner(1, 0), corner(1, 3)), false);
        RoadRoute west = roads.route(List.of(corner(1, 3), corner(1, 0)), false);

        assertEquals(RoadRoute.Status.OK, east.status());
        assertEquals(RoadRoute.Status.OK, west.status());
        assertEquals(300, east.metres(), 30, "east along the one-way street");
        // West has to go round by another row: about 300 m plus two 100 m sides.
        assertTrue(west.metres() > 450, "west goes round: " + west.metres());
    }

    @Test
    void neverUsesTheFootway() {
        // The footway joins these two corners directly (about 424 m); by road it is about 600 m.
        RoadRoute route = roads.route(List.of(corner(3, 0), corner(0, 3)), false);

        assertEquals(RoadRoute.Status.OK, route.status());
        assertTrue(route.metres() > 550, "by road, not the footway: " + route.metres());
    }

    @Test
    void noRouteToTheIsland() {
        RoadRoute route = roads.route(List.of(corner(0, 0), MiniRoads.ISLAND), false);

        assertEquals(RoadRoute.Status.NO_ROUTE, route.status());
        assertEquals(0, route.path().length);
    }

    @Test
    void noRoadForAPointFarFromAnyRoad() {
        RoadRoute route = roads.route(List.of(corner(0, 0), MiniRoads.FAR_FROM_ROADS), false);

        assertEquals(RoadRoute.Status.NO_ROAD, route.status());
        assertTrue(route.reason().contains("2"), "names the second point: " + route.reason());
        assertTrue(route.snapped().getFirst().found());
        assertFalse(route.snapped().get(1).found());
    }

    /** AA-2: two points with alternatives give 1 to 3 drives, the first being the plain drive. */
    @Test
    void alternativesComeAfterThePlainDrive() {
        List<LatLon> points = List.of(corner(0, 0), corner(3, 3));
        RoadRoute plain = roads.route(points, false);
        RoadRoute route = roads.route(points, true);

        assertEquals(RoadRoute.Status.OK, route.status());
        assertEquals(plain.metres(), route.metres(), 0.01, "the first drive is the plain drive");
        assertEquals(plain.seconds(), route.seconds(), 0.01, "the first drive is the plain drive");
        int drives = 1 + route.alternatives().size();
        assertTrue(drives >= 1 && drives <= 3, "1 to 3 drives in all, not " + drives);
        // Across the grid there are other ways of about the same length, through other blocks.
        assertFalse(route.alternatives().isEmpty(), "at least one other way across the grid");
        for (RoadRoute other : route.alternatives()) {
            assertEquals(RoadRoute.Status.OK, other.status());
            assertTrue(other.seconds() >= plain.seconds() - 1, "no faster than the plain drive");
            assertTrue(other.path().length >= 2, "a path");
            assertFalse(samePath(other.path(), plain.path()), "a different way");
            assertEquals(1, other.legs().size());
            assertEquals(2, other.snapped().size());
            assertTrue(other.alternatives().isEmpty(), "alternatives have none of their own");
        }
    }

    @Test
    void alternativesAreIgnoredForMoreThanTwoPoints() {
        RoadRoute route = roads.route(List.of(corner(0, 0), corner(0, 3), corner(3, 3)), true);

        assertEquals(RoadRoute.Status.OK, route.status());
        assertTrue(route.alternatives().isEmpty());
    }

    @Test
    void noAlternativesWhenThereIsNoWay() {
        RoadRoute route = roads.route(List.of(corner(0, 0), MiniRoads.ISLAND), true);

        assertEquals(RoadRoute.Status.NO_ROUTE, route.status());
        assertTrue(route.alternatives().isEmpty());
    }

    @Test
    void nearestGivesAPointOnAStreetWithItsDistance() {
        // About 30 m north of the top row, between columns 1 and 2.
        Snapped snapped = roads.nearest(new LatLon(-32.89673, 151.73760));

        assertTrue(snapped.found());
        assertEquals(MiniRoads.ROW_LAT[0], snapped.point().lat(), 0.00005);
        assertEquals(151.73760, snapped.point().lon(), 0.00005);
        assertEquals(30, snapped.metres(), 3);
    }

    @Test
    void nearestNeverSnapsToTheFootway() {
        Snapped snapped = roads.nearest(MiniRoads.ON_FOOTWAY);

        assertTrue(snapped.found());
        assertTrue(snapped.metres() > 40, "to a street, not the footway: " + snapped.metres());
    }

    @Test
    void nearestGivesNoneFurtherThanTheSnapLimit() {
        assertFalse(roads.nearest(MiniRoads.FAR_FROM_ROADS).found());
    }

    private static boolean samePath(double[][] a, double[][] b) {
        return Arrays.deepEquals(a, b);
    }

    private static double metresTo(double[] lonLat, LatLon point) {
        return Geo.metresBetween(lonLat[1], lonLat[0], point.lat(), point.lon());
    }
}
