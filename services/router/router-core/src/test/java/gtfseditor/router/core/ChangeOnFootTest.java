package gtfseditor.router.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * A change of vehicle takes at least the time to change, whether the next vehicle leaves from the
 * same stop or from one a walk away.
 *
 * <p>Four stops. A trip runs A to B, arriving at 100. B has a 30 s walk to C and a 300 s walk to
 * E. Three trips leave C for D, at 120, 160 and 230, and two leave E for D, at 390 and 410.
 */
class ChangeOnFootTest {

    private static Timetable timetable() {
        Timetable.Builder b = new Timetable.Builder();
        b.serviceDate = 20261117;
        b.stopIds = new String[] {"A", "B", "C", "D", "E"};
        b.stopNames = b.stopIds.clone();
        b.stopLat = new double[] {-33.0, -33.01, -33.011, -33.02, -33.013};
        b.stopLon = new double[] {151.0, 151.0, 151.0, 151.0, 151.0};
        b.stopStation = new int[] {-1, -1, -1, -1, -1};
        b.routeIds = new String[] {"R"};
        b.routeNames = new String[] {"R"};
        b.routeTypes = new int[] {3};
        b.patternStopOffset = new int[] {0, 2, 4, 6};
        b.patternTripOffset = new int[] {0, 1, 4, 6};
        b.patternStops = new int[] {0, 1, 2, 3, 4, 3};
        b.patternStopFlags = new byte[] {3, 3, 3, 3, 3, 3};
        b.arrive = new int[] {0, 100, 120, 500, 160, 600, 230, 700, 390, 800, 410, 900};
        b.depart = b.arrive.clone();
        b.tripIds = new String[] {"ab", "cd1", "cd2", "cd3", "ed1", "ed2"};
        b.tripHeadsigns = new String[] {"", "", "", "", "", ""};
        b.tripRoute = new int[6];
        b.tripCapacity = new int[] {50, 50, 50, 50, 50, 50};
        b.tripCapacityFlags = new byte[6];
        b.tripStayAboard = new int[] {-1, -1, -1, -1, -1, -1};
        b.transferOffset = new int[] {0, 0, 2, 2, 2, 2};
        b.transferTargets = new int[] {2, 4};
        b.transferSecs = new int[] {30, 300};
        b.transferMetres = new int[] {20, 250};
        return b.build();
    }

    private static Journey fastest(Timetable t, int to, int changeSecs) {
        Query q = new Query(List.of(new Access(0, 0, 0)), List.of(new Access(to, 0, 0)), 0, 4, -1, 0)
                .withChangeSecs(changeSecs);
        Result result = new Router(t, 4).route(q, Preferences.everything());
        Journey journey = result.journeys().get(0);
        assertNull(JourneyChecker.problem(t, q, journey));
        return journey;
    }

    @Test
    void aShortWalkStillTakesTheTimeToChange() {
        Timetable t = timetable();
        // The walk ends at 130, but the 160 leaves less than two minutes after the passenger got off.
        Journey j = fastest(t, 3, 120);
        assertEquals(700, j.arrive());
        Leg walk = j.legs().get(1);
        assertEquals(Leg.Kind.TRANSFER, walk.kind());
        assertEquals(100, walk.depart());
        assertEquals(130, walk.arrive(), "the walk itself takes the link's time; the rest is waiting");
        assertEquals(230, j.legs().get(2).depart());
    }

    @Test
    void withNoTimeToChangeTheWalkAloneDecides() {
        assertEquals(600, fastest(timetable(), 3, 0).arrive());
        assertEquals(600, fastest(timetable(), 3, 60).arrive());
    }

    @Test
    void aWalkLongerThanTheTimeToChangeTakesItsOwnTime() {
        Timetable t = timetable().transferSecs[0] == 30 ? withoutShortLink() : null;
        // 300 s of walking ends at 400: too late for the 390, in time for the 410.
        assertEquals(900, fastest(t, 3, 120).arrive());
    }

    /** The same timetable with no trips from C, so the only way on is the long walk to E. */
    private static Timetable withoutShortLink() {
        Timetable full = timetable();
        Timetable.Builder b = new Timetable.Builder();
        b.serviceDate = full.serviceDate;
        b.stopIds = full.stopIds;
        b.stopNames = full.stopNames;
        b.stopLat = full.stopLat;
        b.stopLon = full.stopLon;
        b.stopStation = full.stopStation;
        b.routeIds = full.routeIds;
        b.routeNames = full.routeNames;
        b.routeTypes = full.routeTypes;
        b.patternStopOffset = new int[] {0, 2, 4};
        b.patternTripOffset = new int[] {0, 1, 3};
        b.patternStops = new int[] {0, 1, 4, 3};
        b.patternStopFlags = new byte[] {3, 3, 3, 3};
        b.arrive = new int[] {0, 100, 390, 800, 410, 900};
        b.depart = b.arrive.clone();
        b.tripIds = new String[] {"ab", "ed1", "ed2"};
        b.tripHeadsigns = new String[] {"", "", ""};
        b.tripRoute = new int[3];
        b.tripCapacity = new int[] {50, 50, 50};
        b.tripCapacityFlags = new byte[3];
        b.tripStayAboard = new int[] {-1, -1, -1};
        b.transferOffset = full.transferOffset;
        b.transferTargets = full.transferTargets;
        b.transferSecs = full.transferSecs;
        b.transferMetres = full.transferMetres;
        return b.build();
    }
}
