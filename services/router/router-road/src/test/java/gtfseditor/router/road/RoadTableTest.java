package gtfseditor.router.road;

import static gtfseditor.router.road.MiniRoads.corner;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Many drives at once on the hand-made map (AA-2, FR-2, decision D17). */
class RoadTableTest {

    @TempDir
    static Path folder;

    private static Path graph;
    private static GraphHopperRoads roads;

    @BeforeAll
    static void buildAndOpen() throws IOException {
        graph = folder.resolve("graph");
        // The test map is far smaller than GraphHopper's smallest kept network, so keep every one.
        RoadGraphBuilder.build(MiniRoads.osmFile(), graph, 0);
        roads = GraphHopperRoads.open(RoadSettings.defaults(graph));
    }

    @AfterAll
    static void close() {
        roads.close();
    }

    /** AC-FR-2.1 at fixture scale: 100 starting points and 3 ending points give 300 answers. */
    @Test
    void oneTableGivesEveryPairOfAHundredStartsAndThreeEnds() {
        List<LatLon> sources = spreadOverTheGrid();
        List<LatLon> destinations = threeCorners();

        RoadTable table = roads.table(sources, destinations);

        assertEquals(100, table.seconds().length, "a row per starting point");
        assertEquals(100, table.metres().length, "a row per starting point");
        assertEquals(100, table.sourceSnapMetres().length);
        assertEquals(3, table.destinationSnapMetres().length);
        int answers = 0;
        for (int row = 0; row < 100; row++) {
            assertEquals(3, table.seconds()[row].length, "a column per ending point");
            assertEquals(3, table.metres()[row].length, "a column per ending point");
            for (int column = 0; column < 3; column++) {
                if (Double.isFinite(table.seconds()[row][column]) && Double.isFinite(table.metres()[row][column])) {
                    answers++;
                }
            }
            assertTrue(Double.isFinite(table.sourceSnapMetres()[row]), "every start is near a street");
        }
        assertEquals(300, answers, "every pair on the grid has a drive");
    }

    /** Each value is the single drive's time and distance for the same pair. */
    @Test
    void everyValueMatchesTheSingleDrive() {
        List<LatLon> sources = spreadOverTheGrid();
        List<LatLon> destinations = threeCorners();

        RoadTable table = roads.table(sources, destinations);

        for (int row = 0; row < sources.size(); row++) {
            for (int column = 0; column < destinations.size(); column++) {
                RoadRoute single = roads.route(List.of(sources.get(row), destinations.get(column)), false);
                String pair = "start " + row + " to end " + column;
                assertEquals(RoadRoute.Status.OK, single.status(), pair);
                assertEquals(single.seconds(), table.seconds()[row][column], 1.0, pair + " seconds");
                assertEquals(single.metres(), table.metres()[row][column], 1.0, pair + " metres");
            }
            assertEquals(roads.nearest(sources.get(row)).metres(), table.sourceSnapMetres()[row], 0.5);
        }
        for (int column = 0; column < destinations.size(); column++) {
            assertEquals(roads.nearest(destinations.get(column)).metres(), table.destinationSnapMetres()[column], 0.5);
        }
    }

    /** No way to the island: that pair is NaN, but the island has a road, so its snap is known. */
    @Test
    void aPairWithNoWayIsNaN() {
        RoadTable table = roads.table(List.of(corner(0, 0), corner(3, 3)), List.of(corner(1, 1), MiniRoads.ISLAND));

        for (int row = 0; row < 2; row++) {
            assertTrue(Double.isFinite(table.seconds()[row][0]), "the grid corner can be reached");
            assertTrue(Double.isNaN(table.seconds()[row][1]), "no way to the island, seconds");
            assertTrue(Double.isNaN(table.metres()[row][1]), "no way to the island, metres");
        }
        assertTrue(Double.isFinite(table.destinationSnapMetres()[1]), "the island is next to a street");
    }

    /** An end with no road nearby: its whole row or column is NaN, and so is its snap metres. */
    @Test
    void anEndWithNoRoadIsNaNWithNoSnapMetres() {
        LatLon far = MiniRoads.FAR_FROM_ROADS;
        RoadTable table = roads.table(List.of(corner(0, 0), far), List.of(corner(3, 3), far));

        assertTrue(Double.isFinite(table.seconds()[0][0]), "the two corners are joined");
        assertTrue(Double.isNaN(table.seconds()[0][1]), "to the point with no road");
        assertTrue(Double.isNaN(table.metres()[0][1]), "to the point with no road");
        assertTrue(Double.isNaN(table.seconds()[1][0]), "from the point with no road");
        assertTrue(Double.isNaN(table.metres()[1][0]), "from the point with no road");
        assertTrue(Double.isNaN(table.seconds()[1][1]), "both ends with no road");
        assertTrue(Double.isFinite(table.sourceSnapMetres()[0]));
        assertTrue(Double.isNaN(table.sourceSnapMetres()[1]), "a start with no road has no snap metres");
        assertTrue(Double.isFinite(table.destinationSnapMetres()[0]));
        assertTrue(Double.isNaN(table.destinationSnapMetres()[1]), "an end with no road has no snap metres");
    }

    @Test
    void theSamePointAsStartAndEndIsNoDrive() {
        RoadTable table = roads.table(List.of(corner(2, 2)), List.of(corner(2, 2)));

        assertEquals(0, table.seconds()[0][0], 1.0);
        assertEquals(0, table.metres()[0][0], 1.0);
    }

    @Test
    void anEmptyListGivesAnEmptyTable() {
        RoadTable noStarts = roads.table(List.of(), threeCorners());
        RoadTable noEnds = roads.table(List.of(corner(0, 0)), List.of());

        assertEquals(0, noStarts.seconds().length);
        assertEquals(3, noStarts.destinationSnapMetres().length);
        assertEquals(1, noEnds.seconds().length);
        assertEquals(0, noEnds.seconds()[0].length);
    }

    /** The answer does not depend on how many threads share the work (NFR-4). */
    @Test
    void oneThreadAndManyThreadsGiveTheSameTable() {
        List<LatLon> sources = spreadOverTheGrid();
        List<LatLon> destinations = threeCorners();
        RoadTable many = roads.table(sources, destinations);

        try (GraphHopperRoads oneThread = GraphHopperRoads.open(
                new RoadSettings(graph, RoadSettings.DEFAULT_SNAP_METRES, 1))) {
            RoadTable one = oneThread.table(sources, destinations);
            for (int row = 0; row < sources.size(); row++) {
                assertArrayEquals(one.seconds()[row], many.seconds()[row], 0.001, "seconds, row " + row);
                assertArrayEquals(one.metres()[row], many.metres()[row], 0.001, "metres, row " + row);
            }
        }
    }

    /** D17: the default leaves two processors free, but always has at least one thread. */
    @Test
    void theDefaultThreadsAreProcessorsLessTwo() {
        int expected = Math.max(1, Runtime.getRuntime().availableProcessors() - 2);
        assertEquals(expected, RoadSettings.defaults(graph).threads());
    }

    /** 100 points in a 10 by 10 spread over the grid's blocks, between and on the streets. */
    private static List<LatLon> spreadOverTheGrid() {
        double north = MiniRoads.ROW_LAT[0];
        double south = MiniRoads.ROW_LAT[3];
        double west = MiniRoads.COLUMN_LON[0];
        double east = MiniRoads.COLUMN_LON[3];
        List<LatLon> points = new ArrayList<>(100);
        for (int i = 0; i < 10; i++) {
            for (int j = 0; j < 10; j++) {
                points.add(new LatLon(north + (south - north) * i / 9.0, west + (east - west) * j / 9.0));
            }
        }
        return points;
    }

    private static List<LatLon> threeCorners() {
        return List.of(corner(0, 0), corner(3, 3), corner(1, 2));
    }
}
