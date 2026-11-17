package gtfseditor.router.core;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class TimetableTest {

    @Test
    void countsComeFromTheArrays() {
        Timetable t = TestTimetables.tiny().build();
        assertEquals(3, t.stopCount());
        assertEquals(1, t.stationCount());
        assertEquals(1, t.routeCount());
        assertEquals(2, t.patternCount());
        assertEquals(3, t.tripCount());
        assertEquals(8, t.stopTimeCount());
        assertEquals(1, t.transferCount());
        assertEquals(3, t.patternLength(0));
        assertEquals(2, t.patternTripCount(0));
        assertEquals(2, t.patternLength(1));
    }

    @Test
    void timesAreFoundByPatternTripAndPosition() {
        Timetable t = TestTimetables.tiny().build();
        assertEquals(210, t.depart[t.timeIndex(0, 0, 1)]);
        assertEquals(500, t.arrive[t.timeIndex(0, 1, 1)]);
        assertEquals(900, t.arrive[t.timeIndex(1, 0, 1)]);
        assertEquals(600, t.arrive[t.tripTimeIndex(1, 2)]);
        assertEquals(700, t.depart[t.tripTimeIndex(2, 0)]);
        assertArrayEquals(new int[] {0, 0, 1}, t.tripPattern);
    }

    @Test
    void eachStopListsThePatternsThatCallThere() {
        Timetable t = TestTimetables.tiny().build();
        // A is first in pattern 0 and last in pattern 1; B is only in pattern 0.
        assertArrayEquals(new int[] {0, 2, 3, 5}, t.stopPatternOffset);
        assertArrayEquals(new int[] {0, 1, 0, 0, 1}, t.stopPatterns);
        assertArrayEquals(new int[] {0, 1, 1, 2, 0}, t.stopPatternPositions);
    }

    @Test
    void stopsAndTripsAreFoundById() {
        Timetable t = TestTimetables.tiny().build();
        assertEquals(2, t.stopIndex("C"));
        assertEquals(-1, t.stopIndex("nowhere"));
        assertEquals(1, t.tripIndex("t1"));
        assertEquals(-1, t.tripIndex("t9"));
        assertEquals(Mode.TRAIN, t.tripMode(0));
    }

    @Test
    void statsDescribeTheTimetable() {
        TimetableStats s = TimetableStats.of(TestTimetables.tiny().build());
        assertEquals(100, s.firstDeparture());
        assertEquals(900, s.lastArrival());
        assertEquals(3, s.longestPattern());
        assertEquals(1, s.stayAboardLinks());
        assertEquals(2, s.placeholderCapacity());
        assertEquals(1, s.defaultedCapacity());
        assertEquals(1, s.mostTransfersAtAStop());
        assertTrue(s.estimatedBytes() > 0);
    }

    @Test
    void aTripThatOvertakesIsRejected() {
        Timetable.Builder b = TestTimetables.tiny();
        // The second trip still leaves A after the first, but now reaches C before it.
        for (int i = 3; i <= 5; i++) {
            b.arrive[i] = 100 + i * 20;
            b.depart[i] = 100 + i * 20;
        }
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, b::build);
        assertTrue(e.getMessage().contains("overtakes"), e.getMessage());
    }

    @Test
    void timesThatGoBackwardsAreRejected() {
        Timetable.Builder b = TestTimetables.tiny();
        b.arrive[1] = 90;
        assertThrows(IllegalArgumentException.class, b::build);
    }

    @Test
    void arraysThatDoNotFitAreRejected() {
        Timetable.Builder b = TestTimetables.tiny();
        b.patternStops = new int[] {0, 1, 2, 2, 7};
        assertThrows(IllegalArgumentException.class, b::build);

        Timetable.Builder c = TestTimetables.tiny();
        c.transferTargets = new int[] {1, 2};
        assertThrows(IllegalArgumentException.class, c::build);
    }

    @Test
    void routeTypesMapToTheEditorsModes() {
        assertEquals(Mode.TRAIN, Mode.ofRouteType(2));
        assertEquals(Mode.TRAIN, Mode.ofRouteType(106));
        assertEquals(Mode.METRO, Mode.ofRouteType(401));
        assertEquals(Mode.LIGHT_RAIL, Mode.ofRouteType(900));
        assertEquals(Mode.FERRY, Mode.ofRouteType(4));
        assertEquals(Mode.BUS, Mode.ofRouteType(700));
        assertEquals(Mode.BUS, Mode.ofRouteType(714));
        assertEquals(Mode.SCHOOL_BUS, Mode.ofRouteType(712));
        assertEquals(Mode.COACH, Mode.ofRouteType(204));
        assertEquals(Mode.OTHER, Mode.ofRouteType(1500));
        assertEquals("light_rail", Mode.LIGHT_RAIL.wireName());
    }
}
