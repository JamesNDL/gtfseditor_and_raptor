package gtfseditor.router.core;

import java.util.List;

/** Small hand-made timetables for tests. */
final class TestTimetables {

    private TestTimetables() {}

    /**
     * Three stops A, B, C. Pattern 0 runs A, B, C with two trips; pattern 1 runs C, A with one
     * trip, which the second trip of pattern 0 runs on into. One walking link, A to B.
     */
    static Timetable.Builder tiny() {
        Timetable.Builder b = new Timetable.Builder();
        b.feedVersion = "test feed";
        b.serviceDate = 20261117;
        b.capacityFactor = 0.9;
        b.notes = List.of("a note", "another note");
        b.stationIds = new String[] {"S"};
        b.stationNames = new String[] {"Station"};
        b.stopIds = new String[] {"A", "B", "C"};
        b.stopNames = new String[] {"Stop A", "Stop B", "Stop Cé"};
        b.stopLat = new double[] {-33.0, -33.01, -33.02};
        b.stopLon = new double[] {151.0, 151.01, 151.02};
        b.stopStation = new int[] {0, -1, -1};
        b.routeIds = new String[] {"R"};
        b.routeNames = new String[] {"T1"};
        b.routeTypes = new int[] {2};
        b.patternStopOffset = new int[] {0, 3, 5};
        b.patternTripOffset = new int[] {0, 2, 3};
        b.patternStops = new int[] {0, 1, 2, 2, 0};
        b.patternStopFlags = new byte[] {3, 3, 3, 3, 3};
        b.arrive = new int[] {100, 200, 300, 400, 500, 600, 700, 900};
        b.depart = new int[] {100, 210, 300, 400, 510, 600, 700, 900};
        b.tripIds = new String[] {"t0", "t1", "t2"};
        b.tripHeadsigns = new String[] {"To C", "To C", "To A"};
        b.tripRoute = new int[] {0, 0, 0};
        b.tripCapacity = new int[] {1200, 1200, 65};
        b.tripCapacityFlags = new byte[] {1, 1, 2};
        b.tripStayAboard = new int[] {-1, 2, -1};
        b.transferOffset = new int[] {0, 1, 1, 1};
        b.transferTargets = new int[] {1};
        b.transferSecs = new int[] {120};
        b.transferMetres = new int[] {100};
        return b;
    }
}
