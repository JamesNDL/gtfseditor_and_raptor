package gtfseditor.router.core;

/**
 * A small hand-made network for the arrive-by tests. Six stops: H (home), M, W (work), X, Q, Z.
 *
 * <ul>
 *   <li>Bus 10 runs H, M, W: leaving H at 07:00, 07:20, 07:40 and 08:00, M ten minutes later and
 *       reaching W 25 minutes after H (07:25, 07:45, 08:05, 08:25).
 *   <li>Train T runs Q, M: leaving Q at 07:00 and 07:30, reaching M ten minutes later.
 *   <li>Bus 30 runs X, Z: leaving X at 07:55 and 08:15, reaching Z ten minutes later.
 *   <li>W and X are a 300 s walk apart, both ways.
 * </ul>
 */
final class ArriveByNetwork {

    static final int H = 0;
    static final int M = 1;
    static final int W = 2;
    static final int X = 3;
    static final int Q = 4;
    static final int Z = 5;

    private ArriveByNetwork() {}

    /** Seconds from the start of the service day. */
    static int at(int hours, int minutes) {
        return hours * 3600 + minutes * 60;
    }

    static Timetable build() {
        Timetable.Builder b = new Timetable.Builder();
        b.serviceDate = 20261117;
        b.stopIds = new String[] {"H", "M", "W", "X", "Q", "Z"};
        b.stopNames = new String[] {"Home", "Middle", "Work", "Cross", "Quay", "Zoo"};
        b.stopLat = new double[] {-32.90, -32.91, -32.92, -32.921, -32.93, -32.94};
        b.stopLon = new double[] {151.70, 151.71, 151.72, 151.722, 151.73, 151.74};
        b.stopStation = new int[] {-1, -1, -1, -1, -1, -1};
        b.routeIds = new String[] {"R10", "RT", "R30"};
        b.routeNames = new String[] {"10", "T", "30"};
        b.routeTypes = new int[] {3, 2, 3};
        b.patternStopOffset = new int[] {0, 3, 5, 7};
        b.patternTripOffset = new int[] {0, 4, 6, 8};
        b.patternStops = new int[] {H, M, W, Q, M, X, Z};
        b.patternStopFlags = new byte[] {3, 3, 3, 3, 3, 3, 3};
        int[] times = new int[4 * 3 + 2 * 2 + 2 * 2];
        int i = 0;
        for (int leave : new int[] {at(7, 0), at(7, 20), at(7, 40), at(8, 0)}) {
            times[i++] = leave;
            times[i++] = leave + 600;
            times[i++] = leave + 1500;
        }
        for (int leave : new int[] {at(7, 0), at(7, 30)}) {
            times[i++] = leave;
            times[i++] = leave + 600;
        }
        for (int leave : new int[] {at(7, 55), at(8, 15)}) {
            times[i++] = leave;
            times[i++] = leave + 600;
        }
        b.arrive = times;
        b.depart = times.clone();
        b.tripIds = new String[] {"b1", "b2", "b3", "b4", "t1", "t2", "z1", "z2"};
        b.tripHeadsigns = new String[] {"W", "W", "W", "W", "M", "M", "Z", "Z"};
        b.tripRoute = new int[] {0, 0, 0, 0, 1, 1, 2, 2};
        b.tripCapacity = new int[] {50, 50, 50, 50, 500, 500, 50, 50};
        b.tripCapacityFlags = new byte[8];
        b.tripStayAboard = new int[] {-1, -1, -1, -1, -1, -1, -1, -1};
        b.transferOffset = new int[] {0, 0, 0, 1, 2, 2, 2};
        b.transferTargets = new int[] {X, W};
        b.transferSecs = new int[] {300, 300};
        b.transferMetres = new int[] {230, 230};
        return b.build();
    }
}
