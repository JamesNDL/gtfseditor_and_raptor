package gtfseditor.router.sim;

import static gtfseditor.router.sim.Net.demand;
import static gtfseditor.router.sim.Net.row;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Timetable;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Which stops a person uses (section 4.6 of the plan), on hand-made lines.
 *
 * <p>The published network: a person starts at O and goes to D. The slow line runs O to D in 20
 * minutes. O2 is 200 m from O and D2 is 300 m from D.
 */
class StopRuleTest {

    private static final String EVERY_TEN = "07:05 07:15 07:25 07:35 07:45 07:55 08:05 08:15 08:25 08:35 08:45";

    /** The stops everything here is built from. */
    private static Net stops() {
        return new Net().stop("O", 0, 0).stop("O2", 200, 0).stop("D", 10000, 0).stop("D2", 10300, 0)
                .stop("FAR", 20000, 0).stop("FAR2", 25000, 0);
    }

    /** The slow line from the person's own stop, taking this many minutes. */
    private static Net published(int slowMinutes) {
        return stops().line("Slow", 50, "O D", "0 " + slowMinutes, EVERY_TEN);
    }

    /** The same with a quick line from the stop 200 m away: 6 minutes, leaving a minute after the slow one. */
    private static Net withQuickLineNearby(int slowMinutes) {
        return published(slowMinutes).line("Quick", 50, "O2 D", "0 6",
                "07:06 07:16 07:26 07:36 07:46 07:56 08:06 08:16 08:26 08:36 08:46");
    }

    private static Demand onePerson(Timetable published) {
        return demand(published, row("p", "08:00", "O", "D"));
    }

    private static String boardedAt(Timetable t, Net.Settled journey) {
        for (Leg leg : journey.legs()) {
            if (leg.kind() == Leg.Kind.RIDE) {
                return t.stopIds[leg.fromStop()];
            }
        }
        return null;
    }

    private static String leftAt(Timetable t, Net.Settled journey) {
        String stop = null;
        for (Leg leg : journey.legs()) {
            if (leg.kind() == Leg.Kind.RIDE) {
                stop = t.stopIds[leg.toStop()];
            }
        }
        return stop;
    }

    @Test
    void onThePublishedTimetableNobodyChangesStopWhateverIsNearby() {
        Timetable t = withQuickLineNearby(20).build();
        Net.Ran bau = Net.run(t, onePerson(t), new SimSettings(), null);
        Net.Settled journey = bau.journeys().only(0);
        assertEquals("O", boardedAt(t, journey));
        assertEquals(List.of("Slow@08:05"), journey.trips(t));
        assertFalse(bau.plans().near[0]);
        assertEquals(Plans.KEPT, bau.plans().reason[0]);
        // The quick line arrives at 08:12 after a walk of 253 s; the slow one at 08:25.
        // The margin is what that is worth: 13 minutes sooner, less the walk counted again.
        int walk = (int) Math.ceil(200 * 1.3 / 1.03);
        assertEquals(13 * 60 - walk, bau.plans().margin[0], 2);
        assertEquals(Clock.parse("08:25"), bau.plans().ownArrive[0]);
        assertEquals(Clock.parse("08:12"), bau.plans().nearArrive[0]);
    }

    @Test
    void withNothingBetterNearbyTheMarginIsNothing() {
        Timetable t = published(20).build();
        Net.Ran bau = Net.run(t, onePerson(t), new SimSettings(), null);
        assertEquals(0, bau.plans().margin[0]);
    }

    @Test
    void aChangeElsewhereMovesNobody() {
        Timetable published = withQuickLineNearby(20).build();
        Demand d = onePerson(published);
        Net.Ran bau = Net.run(published, d, new SimSettings(), null);
        Timetable changed = withQuickLineNearby(20).line("New", 50, "FAR FAR2", "0 10", "08:00 09:00").build();
        Net.Ran scenario = Net.run(changed, d, new SimSettings(), bau.plans());
        Net.Settled journey = scenario.journeys().only(0);
        assertEquals("O", boardedAt(changed, journey));
        assertEquals(bau.journeys().only(0).arrive(), journey.arrive());
        assertEquals(Plans.KEPT, scenario.plans().reason[0]);
        assertEquals(Plans.OK, journey.status());
    }

    @Test
    void someoneWithAMarginNeedsThatMuchMoreBeforeTheyChange() {
        // On the day the quick line was already better by about 9 minutes, and they did not use it.
        Timetable published = withQuickLineNearby(20).build();
        Demand d = onePerson(published);
        Net.Ran bau = Net.run(published, d, new SimSettings(), null);
        int margin = bau.plans().margin[0];
        assertTrue(margin > 5 * 60, "margin " + margin);

        // Slow the slow line by 9 minutes. The quick line is now better by the margin plus 9
        // minutes: more than the 10-minute threshold alone, but not more than margin plus threshold.
        Timetable aLittleWorse = withQuickLineNearby(29).build();
        Net.Ran stays = Net.run(aLittleWorse, d, new SimSettings(), bau.plans());
        assertEquals("O", boardedAt(aLittleWorse, stays.journeys().only(0)));
        assertEquals(Plans.KEPT, stays.plans().reason[0]);
        assertEquals(margin, stays.plans().margin[0], "the margin is the reference's, not worked out again");

        // By 11 minutes: now it is.
        Timetable worse = withQuickLineNearby(31).build();
        Net.Ran moves = Net.run(worse, d, new SimSettings(), bau.plans());
        Net.Settled journey = moves.journeys().only(0);
        assertEquals("O2", boardedAt(worse, journey));
        assertEquals(Plans.BETTER, moves.plans().reason[0]);
        assertTrue(moves.plans().near[0]);
        assertEquals(Leg.Kind.WALK, journey.legs().get(0).kind());
        assertEquals(200, journey.legs().get(0).metres(), 2);

        // With the threshold at one minute, 9 minutes more than the margin is enough.
        SimSettings eager = new SimSettings();
        eager.switchThresholdSecs = 60;
        assertEquals("O2", boardedAt(aLittleWorse,
                Net.run(aLittleWorse, d, eager, bau.plans()).journeys().only(0)));
        assertEquals("O", boardedAt(published, Net.run(published, d, eager, bau.plans()).journeys().only(0)),
                "on an unchanged timetable they stay, whatever the threshold");
    }

    @Test
    void aStopLeftWithAPoorServiceIsLeftForABetterOneNearby() {
        Timetable published = published(20).line("Other", 50, "O2 D", "0 20", EVERY_TEN).build();
        Demand d = onePerson(published);
        Net.Ran bau = Net.run(published, d, new SimSettings(), null);
        assertEquals(0, bau.plans().margin[0], "the other line was no better on the day");

        // Their line is cut to two buses a day; the line 200 m away still runs every ten minutes.
        Timetable cut = stops().line("Slow", 50, "O D", "0 20", "07:05 08:45")
                .line("Other", 50, "O2 D", "0 20", EVERY_TEN).build();
        Net.Ran scenario = Net.run(cut, d, new SimSettings(), bau.plans());
        Net.Settled journey = scenario.journeys().only(0);
        assertEquals("O2", boardedAt(cut, journey));
        assertEquals(Plans.BETTER, scenario.plans().reason[0]);
        assertEquals(Clock.parse("08:25"), journey.arrive());

        // With the walk to another stop at 0 they wait for their own.
        SimSettings noWalk = new SimSettings();
        noWalk.walkMetres = 0;
        Net.Ran bauNoWalk = Net.run(published, d, noWalk, null);
        Net.Settled waits = Net.run(cut, d, noWalk, bauNoWalk.plans()).journeys().only(0);
        assertEquals("O", boardedAt(cut, waits));
        assertEquals(Clock.parse("09:05"), waits.arrive());
    }

    @Test
    void someoneGoingToAStopNothingCallsAtGetsOffNearbyAndWalks() {
        Timetable published = published(20).build();
        Demand d = onePerson(published);
        Net.Ran bau = Net.run(published, d, new SimSettings(), null);

        // The line now ends at D2, 300 m past D. D is still on the map.
        Timetable moved = stops().line("Slow", 50, "O D2", "0 21", EVERY_TEN).build();
        Net.Ran scenario = Net.run(moved, d, new SimSettings(), bau.plans());
        Net.Settled journey = scenario.journeys().only(0);
        assertEquals(Plans.OK, journey.status());
        assertEquals("D2", leftAt(moved, journey));
        assertEquals(Plans.GONE, scenario.plans().reason[0]);
        Leg last = journey.legs().get(journey.legs().size() - 1);
        assertEquals(Leg.Kind.WALK, last.kind());
        assertEquals(300, last.metres(), 2);
        assertEquals(Clock.parse("08:26") + (int) Math.ceil(last.metres() * 1.3 / 1.03), journey.arrive(), 2);

        // The same when the stop is gone from the timetable altogether: its position is what counts.
        Timetable removed = new Net().stop("O", 0, 0).stop("D2", 10300, 0)
                .line("Slow", 50, "O D2", "0 21", EVERY_TEN).build();
        Net.Ran gone = Net.run(removed, d, new SimSettings(), bau.plans());
        assertEquals("D2", leftAt(removed, gone.journeys().only(0)));
        assertEquals(Plans.GONE, gone.plans().reason[0]);

        // With the distance at 0, or nothing within it, they have no journey.
        SimSettings noWalk = new SimSettings();
        noWalk.walkMetres = 0;
        Net.Ran bauNoWalk = Net.run(published, d, noWalk, null);
        Net.Ran stuck = Net.run(moved, d, noWalk, bauNoWalk.plans());
        assertEquals(Plans.NO_JOURNEY, stuck.journeys().only(0).status());
        SimSettings shortWalk = new SimSettings();
        shortWalk.walkMetres = 250;
        Net.Ran bauShort = Net.run(published, d, shortWalk, null);
        Net.Ran tooFar = Net.run(removed, d, shortWalk, bauShort.plans());
        assertEquals(Plans.NO_JOURNEY, tooFar.journeys().only(0).status());
        assertEquals(Plans.NO_STOP, tooFar.plans().why[0]);
        assertEquals(0, tooFar.outcome().counts().totalBoardings());
    }

    @Test
    void aNewStopNearAPersonIsUsedWhenItIsBetterByEnough() {
        Timetable published = published(40).build();
        Demand d = onePerson(published);
        Net.Ran bau = Net.run(published, d, new SimSettings(), null);

        // A new stop 150 m away, with a line that takes 10 minutes where theirs takes 40.
        Timetable changed = published(40).stop("NEW", 0, 150).line("Fast", 50, "NEW D", "0 10", EVERY_TEN).build();
        Net.Ran scenario = Net.run(changed, d, new SimSettings(), bau.plans());
        assertEquals("NEW", boardedAt(changed, scenario.journeys().only(0)));
        assertEquals(Plans.BETTER, scenario.plans().reason[0]);

        // One that saves only 8 minutes is not worth a change of stop.
        Timetable marginal = published(40).stop("NEW", 0, 150).line("Fast", 50, "NEW D", "0 32", EVERY_TEN).build();
        Net.Ran stays = Net.run(marginal, d, new SimSettings(), bau.plans());
        assertEquals("O", boardedAt(marginal, stays.journeys().only(0)));
    }

    @Test
    void someoneWhosePlatformLosesItsTrainsUsesAnotherPlatformOfTheStation() {
        Net base = new Net().stop("P1", 0, 0).stop("P2", 0, 60).station("STN", "P1", "P2").stop("D", 10000, 0);
        Timetable published = base.line("Train", 500, "P1 D", "0 15", EVERY_TEN).build();
        Demand d = demand(published, row("p", "08:00", "P1", "D"));
        SimSettings noWalk = new SimSettings();
        noWalk.walkMetres = 0; // even someone who will not walk to another stop will cross the station
        Net.Ran bau = Net.run(published, d, noWalk, null);
        assertEquals("P1", boardedAt(published, bau.journeys().only(0)));

        Timetable changed = new Net().stop("P1", 0, 0).stop("P2", 0, 60).station("STN", "P1", "P2")
                .stop("D", 10000, 0).line("Train", 500, "P2 D", "0 15", EVERY_TEN).build();
        Net.Ran scenario = Net.run(changed, d, noWalk, bau.plans());
        Net.Settled journey = scenario.journeys().only(0);
        assertEquals(Plans.OK, journey.status());
        assertEquals("P2", boardedAt(changed, journey));
        assertFalse(scenario.plans().near[0], "the other platform is their own stop");
        assertEquals(Plans.KEPT, scenario.plans().reason[0]);
        assertEquals(Leg.Kind.WALK, journey.legs().get(0).kind(), "at the walking time between the platforms");
        assertEquals(bau.journeys().only(0).arrive(), journey.arrive());
    }

    @Test
    void aRowThatIsAPositionWalksToTheStopsAroundIt() {
        Timetable t = published(20).build();
        Demand.Builder builder = new Demand.Builder();
        // 100 m north of O, with no stop id.
        builder.add("p", null, Clock.parse("07:50"), "", t.stopLat[0] + 100 / 111_000.0, t.stopLon[0], "D", Double.NaN,
                Double.NaN, 1);
        Demand d = builder.build().located(t, new DemandReport());
        Net.Ran bau = Net.run(t, d, new SimSettings(), null);
        Net.Settled journey = bau.journeys().only(0);
        assertEquals(Plans.OK, journey.status());
        assertEquals(Plans.POSITION, bau.plans().reason[0]);
        assertEquals("O", boardedAt(t, journey));
        assertEquals(Leg.Kind.WALK, journey.legs().get(0).kind());
        assertEquals(List.of("Slow@07:55"), journey.trips(t));
        assertEquals(Plans.POSITION, Net.run(t, d, new SimSettings(), bau.plans()).plans().reason[0]);
    }

    @Test
    void someoneWhoWouldArriveTooMuchLaterGivesUpAndIsOnNoVehicle() {
        Timetable published = published(20).build();
        Demand d = demand(published, row("p", "08:00", "O", "D"), row("q", "08:40", "O", "D"));
        Net.Ran bau = Net.run(published, d, new SimSettings(), null);

        // Only the 07:05 and the 09:45 are left: the first person arrives 100 minutes later, the second 60.
        Timetable cut = stops().line("Slow", 50, "O D", "0 20", "07:05 09:45").build();
        Net.Ran scenario = Net.run(cut, d, new SimSettings(), bau.plans());
        Net.Settled first = scenario.journeys().only(0);
        assertEquals(Plans.GAVE_UP, first.status());
        assertTrue(first.legs().isEmpty());
        assertEquals(Clock.parse("10:05"), scenario.plans().arrive[0], "the journey they would not make is still known");
        assertEquals(Plans.OK, scenario.journeys().only(1).status(), "60 minutes later is the limit, not over it");
        assertEquals(1, scenario.outcome().counts().totalBoardings());

        SimSettings patient = new SimSettings();
        patient.giveUpSecs = -1;
        assertEquals(Plans.OK, Net.run(cut, d, patient, bau.plans()).journeys().only(0).status());
    }

    @Test
    void peopleDoNotChangeVehiclesToSaveAFewMinutes() {
        // Direct in 30 minutes, or two vehicles in 22: eight minutes is not worth a change.
        Net net = new Net().stop("O", 0, 0).stop("X", 5000, 0).stop("D", 10000, 0)
                .line("Direct", 50, "O D", "0 30", "08:05")
                .line("First", 50, "O X", "0 8", "08:05");
        Timetable t = net.line("Second", 50, "X D", "0 9", "08:18").build();
        Demand d = demand(t, row("p", "08:00", "O", "D"));
        assertEquals(List.of("Direct@08:05"), Net.run(t, d, new SimSettings(), null).journeys().only(0).trips(t));

        // Saving twelve is.
        Timetable quicker = new Net().stop("O", 0, 0).stop("X", 5000, 0).stop("D", 10000, 0)
                .line("Direct", 50, "O D", "0 30", "08:05")
                .line("First", 50, "O X", "0 8", "08:05")
                .line("Second", 50, "X D", "0 5", "08:18").build();
        assertEquals(List.of("First@08:05", "Second@08:18"),
                Net.run(quicker, d, new SimSettings(), null).journeys().only(0).trips(quicker));
    }

    @Test
    void anUnchangedTimetableChangesNothingEvenForSomeoneWithNoJourney() {
        // Nothing runs from O to FAR, but a line from O2, 200 m away, does. On the published
        // timetable they keep their own stop and so have no journey.
        Timetable published = published(20).line("Away", 50, "O2 FAR", "0 30", EVERY_TEN).build();
        Demand d = demand(published, row("p", "08:00", "O", "FAR"));
        Net.Ran bau = Net.run(published, d, new SimSettings(), null);
        assertEquals(Plans.NO_JOURNEY, bau.journeys().only(0).status());
        assertEquals(Plans.NO_JOURNEY, Net.run(published, d, new SimSettings(), bau.plans()).journeys().only(0).status(),
                "the same timetable again gives the same answer");

        // Make that line 15 minutes quicker and it is worth the walk.
        Timetable quicker = published(20).line("Away", 50, "O2 FAR", "0 15", EVERY_TEN).build();
        Net.Ran scenario = Net.run(quicker, d, new SimSettings(), bau.plans());
        assertEquals(Plans.OK, scenario.journeys().only(0).status());
        assertEquals("O2", boardedAt(quicker, scenario.journeys().only(0)));
    }

    @Test
    void someoneWithNoJourneyOnThePublishedTimetableMayGainOne() {
        Timetable published = published(20).build();
        Demand d = demand(published, row("p", "08:00", "D", "FAR"));
        Net.Ran bau = Net.run(published, d, new SimSettings(), null);
        assertEquals(Plans.NO_JOURNEY, bau.journeys().only(0).status());
        assertEquals(Plans.NOTHING_RUNS, bau.plans().why[0]);

        Timetable changed = published(20).line("New", 50, "D FAR", "0 10", "08:30").build();
        Net.Ran scenario = Net.run(changed, d, new SimSettings(), bau.plans());
        assertEquals(Plans.OK, scenario.journeys().only(0).status(), "with no reference there is nothing to give up against");
    }
}
