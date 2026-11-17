package gtfseditor.router.sim;

import static gtfseditor.router.sim.Net.demand;
import static gtfseditor.router.sim.Net.row;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Timetable;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The replay in time order on hand-made lines with known answers (section 9 of the plan). */
class CapacityTest {

    private static SimSettings capacityOn() {
        SimSettings settings = new SimSettings();
        settings.capacity = true;
        settings.threads = 2;
        return settings;
    }

    /** One line, A to B to C, a bus every half hour that holds two. */
    private static Timetable oneLine(int capacity) {
        return new Net().stop("A", 0, 0).stop("B", 5000, 0).stop("C", 10000, 0)
                .line("L", capacity, "A B C", "0 10 20", "08:00 08:30 09:00").build();
    }

    private static int load(Timetable t, Counts counts, String trip, int position) {
        return counts.load[t.tripTimeIndex(t.tripIndex(trip), position)];
    }

    @Test
    void aFullVehicleLeavesPeopleBehindAndTheyTakeTheNext() {
        Timetable t = oneLine(2);
        Demand d = demand(t, row("u1", "07:50", "A", "C"), row("u2", "07:52", "A", "C"), row("u3", "07:55", "A", "C"));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);

        assertTrue(ran.outcome().replayed());
        assertEquals(1, ran.outcome().planned().trips(), "one trip is planned over capacity");
        assertEquals(3, ran.outcome().planned().worst().get(0).peakLoad());
        assertEquals(List.of("L@08:00"), ran.journeys().only(0).trips(t));
        assertEquals(List.of("L@08:00"), ran.journeys().only(1).trips(t));
        // The last to reach the stop is the one left behind.
        Net.Settled late = ran.journeys().only(2);
        assertEquals(Plans.OK, late.status());
        assertEquals(List.of("L@08:30"), late.trips(t));
        assertEquals(1, late.leftBehind());
        assertEquals(Clock.parse("08:50"), late.arrive());
        assertEquals(1, ran.outcome().leftBehindPeople());
        assertEquals(2, load(t, ran.outcome().counts(), "L@08:00", 0));
        assertEquals(1, load(t, ran.outcome().counts(), "L@08:30", 1));
        assertEquals(1, ran.outcome().counts().leftBehind[t.tripTimeIndex(t.tripIndex("L@08:00"), 0)]);
    }

    @Test
    void withCapacityOffNobodyIsLeftBehind() {
        Timetable t = oneLine(2);
        Demand d = demand(t, row("u1", "07:50", "A", "C"), row("u2", "07:52", "A", "C"), row("u3", "07:55", "A", "C"));
        Net.Ran ran = Net.run(t, d, new SimSettings(), null);
        assertFalse(ran.outcome().replayed());
        assertEquals(1, ran.outcome().planned().trips(), "the plans still say where the pressure is");
        assertEquals(3, load(t, ran.outcome().counts(), "L@08:00", 0));
        for (int row = 0; row < 3; row++) {
            assertEquals(List.of("L@08:00"), ran.journeys().only(row).trips(t));
        }
    }

    /**
     * The case first come, first served by departure time gets wrong: whoever boards up the line
     * has the place, even if someone further down set off earlier.
     */
    @Test
    void someoneBoardingUpTheLineGetsThePlaceAheadOfSomeoneDownTheLineWhoSetOffEarlier() {
        Timetable t = oneLine(1);
        Demand d = demand(t, row("down", "07:00", "B", "C"), row("up", "07:55", "A", "C"));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);
        assertEquals(List.of("L@08:00"), ran.journeys().only(1).trips(t), "boards at A at 08:00, before the bus reaches B");
        Net.Settled down = ran.journeys().only(0);
        assertEquals(List.of("L@08:30"), down.trips(t));
        assertEquals(1, down.leftBehind());
    }

    @Test
    void aPassengerWithNoWayLeftIsStranded() {
        Timetable t = new Net().stop("A", 0, 0).stop("C", 10000, 0).line("L", 1, "A C", "0 20", "08:00").build();
        Demand d = demand(t, row("u1", "07:50", "A", "C"), row("u2", "07:55", "A", "C"));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);
        assertEquals(Plans.OK, ran.journeys().only(0).status());
        Net.Settled stuck = ran.journeys().only(1);
        assertEquals(Plans.STRANDED, stuck.status());
        assertEquals(t.stopIndex("A"), stuck.strandedStop());
        assertEquals(Clock.parse("08:00"), stuck.strandedTime());
        assertTrue(stuck.legs().isEmpty(), "they rode nothing");
        assertEquals(1, ran.outcome().counts().totalBoardings());
    }

    @Test
    void aPassengerLeftBehindTooOftenIsStranded() {
        Timetable t = new Net().stop("A", 0, 0).stop("C", 10000, 0)
                .line("L", 1, "A C", "0 20", "08:00 08:10 08:20 08:30 08:40").build();
        Demand d = demand(t, row("u1", "07:50", "A", "C", 1), row("u2", "07:51", "A", "C", 1),
                row("u3", "07:52", "A", "C", 1), row("u4", "07:53", "A", "C", 1));
        SimSettings settings = capacityOn();
        settings.maxLeftBehind = 2;
        Net.Ran ran = Net.run(t, d, settings, null);
        assertEquals(List.of("L@08:10"), ran.journeys().only(1).trips(t));
        assertEquals(List.of("L@08:20"), ran.journeys().only(2).trips(t));
        assertEquals(2, ran.journeys().only(2).leftBehind());
        Net.Settled last = ran.journeys().only(3);
        assertEquals(Plans.STRANDED, last.status(), "left behind a third time, with buses still to come");
        assertEquals(3, last.leftBehind());
        assertEquals(Clock.parse("08:20"), last.strandedTime());
    }

    @Test
    void aPassengerLeftBehindMayGoAnotherWay() {
        // The express is full; the next express is an hour away, but a slow bus leaves in five minutes.
        Timetable t = new Net().stop("A", 0, 0).stop("C", 10000, 0)
                .line("Express", 1, "A C", "0 10", "08:00 09:00")
                .line("Slow", 9, "A C", "0 30", "08:05").build();
        Demand d = demand(t, row("u1", "07:50", "A", "C"), row("u2", "07:55", "A", "C"));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);
        Net.Settled second = ran.journeys().only(1);
        assertEquals(List.of("Slow@08:05"), second.trips(t));
        assertEquals(Clock.parse("08:35"), second.arrive());
    }

    @Test
    void aPassengerOnAVehicleThatRunsOnStaysAboardWhateverItsLoad() {
        // The vehicle of the 08:00 from A runs on from B as a trip to C that somebody else has filled.
        Timetable t = new Net().stop("A", 0, 0).stop("B", 5000, 0).stop("C", 10000, 0)
                .line("In", 5, "A B", "0 10", "08:00")
                .line("On", 1, "B C", "0 10", "08:10 08:40")
                .runsOn("In@08:00", "On@08:10").build();
        Demand d = demand(t, row("through", "07:50", "A", "C"), row("local", "07:00", "B", "C"));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);
        Net.Settled through = ran.journeys().only(0);
        assertEquals(List.of("In@08:00", "On@08:10"), through.trips(t));
        assertTrue(through.legs().get(1).stayAboard());
        assertEquals(0, through.leftBehind());
        // The through passenger has had the one place since 08:00, so the local one waits for the next.
        Counts counts = ran.outcome().counts();
        assertEquals(1, load(t, counts, "On@08:10", 0));
        assertEquals(List.of("On@08:40"), ran.journeys().only(1).trips(t));
        assertEquals(2, counts.totalBoardings(), "staying aboard is not a boarding at the stop");
    }

    /**
     * A bus that leaves two stops in the same second, as many in the real feed do. Someone planned
     * again in that second comes to the earlier stop after the later one has been dealt with, and
     * must not be let on over the person who boarded there.
     */
    @Test
    void aVehicleThatLeavesTwoStopsInOneSecondIsNotOverfilled() {
        Timetable t = new Net().stop("A", 0, 0).stop("B", 3000, 0).stop("C", 10000, 0)
                .line("Express", 1, "A C", "0 8", "08:00")
                .line("Stopper", 1, "A B C", "0 0 10", "08:00").build();
        Demand d = demand(t, row("first", "07:50", "A", "C"), row("second", "07:55", "A", "C"),
                row("atB", "07:50", "B", "C"));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);
        assertEquals(List.of("Express@08:00"), ran.journeys().only(0).trips(t));
        assertEquals(List.of("Stopper@08:00"), ran.journeys().only(2).trips(t));
        // The second person is refused the express, and the stopper's one place is taken from B on.
        Net.Settled second = ran.journeys().only(1);
        assertEquals(Plans.STRANDED, second.status());
        assertEquals(2, second.leftBehind());
        Counts counts = ran.outcome().counts();
        assertEquals(0, load(t, counts, "Stopper@08:00", 0));
        assertEquals(1, load(t, counts, "Stopper@08:00", 1));
    }

    @Test
    void someoneLeftBehindMayCrossToAnotherPlatformButDoesNotWalkToAnotherStop() {
        // P1 and P2 are one station; N is a stop 100 m away that is not part of it.
        Net net = new Net().stop("P1", 0, 0).stop("P2", 0, 50).station("STN", "P1", "P2").stop("N", 100, 0)
                .stop("D", 10000, 0).line("Train", 1, "P1 D", "0 10", "08:00");
        Timetable platforms = net.line("Other", 9, "P2 D", "0 12", "08:10").line("Bus", 9, "N D", "0 10", "08:05")
                .build();
        Demand d = demand(platforms, row("first", "07:50", "P1", "D"), row("second", "07:55", "P1", "D"));
        Net.Settled second = Net.run(platforms, d, capacityOn(), null).journeys().only(1);
        assertEquals(List.of("Other@08:10"), second.trips(platforms), "not the bus from N, though it would arrive sooner");
        assertEquals(1, second.leftBehind());
    }

    @Test
    void aRowOfSeveralPeopleBoardsAsIndividuals() {
        Timetable t = oneLine(4);
        Demand d = demand(t, row("crowd", "07:50", "A", "C", 10));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);
        List<Net.Settled> parts = ran.journeys().of(0);
        assertEquals(3, parts.size(), "4 on the first bus, 4 on the second, 2 on the third");
        int people = 0;
        for (Net.Settled part : parts) {
            people += part.people();
            assertEquals(Plans.OK, part.status());
        }
        assertEquals(10, people);
        assertEquals(4, parts.get(0).people());
        assertEquals(List.of("L@08:00"), parts.get(0).trips(t));
        assertEquals(4, parts.get(1).people());
        assertEquals(List.of("L@08:30"), parts.get(1).trips(t));
        assertEquals(2, parts.get(2).people());
        assertEquals(List.of("L@09:00"), parts.get(2).trips(t));
        assertEquals(2, parts.get(2).leftBehind());
        assertEquals(6 + 2, ran.outcome().leftBehindPeople());
    }

    @Test
    void passengersLeavingAtAStopMakeRoomForThoseBoardingThere() {
        Timetable t = oneLine(1);
        Demand d = demand(t, row("first", "07:50", "A", "B"), row("second", "07:50", "B", "C"));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);
        assertEquals(List.of("L@08:00"), ran.journeys().only(0).trips(t));
        assertEquals(List.of("L@08:00"), ran.journeys().only(1).trips(t));
        assertEquals(0, ran.outcome().leftBehindPeople());
        assertFalse(ran.outcome().replayed(), "nothing is planned over capacity, so there is nothing to replay");
    }

    @Test
    void whereNothingIsPlannedOverCapacityCapacityChangesNothing() {
        Timetable t = oneLine(3);
        Demand d = demand(t, row("u1", "07:50", "A", "C"), row("u2", "07:52", "A", "B"), row("u3", "07:55", "B", "C"));
        Net.Ran on = Net.run(t, d, capacityOn(), null);
        Net.Ran off = Net.run(t, d, new SimSettings(), null);
        assertFalse(on.outcome().replayed());
        assertEquals(off.journeys().settled, on.journeys().settled);
        assertEquals(0, on.outcome().planned().trips());
    }

    @Test
    void aChangeOfVehicleKeepsItsPlaceInTheQueueByWhenItReachedTheStop() {
        // Two people want the one place on the bus from B. The one who has been at B longer gets it.
        Timetable t = new Net().stop("A", 0, 0).stop("B", 5000, 0).stop("C", 10000, 0)
                .line("Feeder", 9, "A B", "0 10", "07:40")
                .line("Main", 1, "B C", "0 10", "08:00 08:30").build();
        Demand d = demand(t, row("walksUp", "07:55", "B", "C"), row("changes", "07:30", "A", "C"));
        Net.Ran ran = Net.run(t, d, capacityOn(), null);
        assertEquals(List.of("Feeder@07:40", "Main@08:00"), ran.journeys().only(1).trips(t), "at B since 07:50");
        assertEquals(List.of("Main@08:30"), ran.journeys().only(0).trips(t));
    }
}
