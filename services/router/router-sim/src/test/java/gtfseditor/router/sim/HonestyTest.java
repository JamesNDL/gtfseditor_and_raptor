package gtfseditor.router.sim;

import static gtfseditor.router.sim.Net.demand;
import static gtfseditor.router.sim.Net.row;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.io.IOException;
import java.io.StringWriter;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The rules that keep a run from flattering itself: a wait of half a day is not a journey, made-up
 * people start where a sensible traveller would, and what is written about people who gave up or
 * lost their stop says what happened to them.
 *
 * <p>The network: O to D by a slow line every ten minutes; O2 is 200 m from O with a quick line to
 * D a minute behind the slow one.
 */
class HonestyTest {

    private static final String EVERY_TEN = "07:05 07:15 07:25 07:35 07:45 07:55 08:05 08:15 08:25 08:35 08:45";

    private static Net stops() {
        return new Net().stop("O", 0, 0).stop("O2", 200, 0).stop("D", 10000, 0).stop("D2", 10300, 0);
    }

    private static Net published() {
        return stops().line("Slow", 50, "O D", "0 20", EVERY_TEN)
                .line("Quick", 50, "O2 D", "0 6", "07:06 07:16 07:26 07:36 07:46 07:56 08:06 08:16 08:26 08:36 08:46");
    }

    @Test
    void aJourneyThatNeedsALongerWaitThanTheLimitIsNoJourney() {
        // One bus in the morning and one in the evening. Someone who turns up at 09:00 would wait nine hours.
        Timetable t = stops().line("Slow", 50, "O D", "0 20", "08:05 18:05").build();
        Demand d = demand(t, row("early", "08:00", "O", "D"), row("late", "09:00", "O", "D"),
                row("evening", "15:00", "O", "D"));
        Net.Ran bau = Net.run(t, d, new SimSettings(), null);
        assertEquals(Plans.OK, bau.journeys().only(0).status());
        assertEquals(Plans.NO_JOURNEY, bau.journeys().only(1).status());
        assertEquals(Plans.LONG_WAIT, bau.plans().why[1]);
        assertEquals(Plans.OK, bau.journeys().only(2).status(), "three hours and five minutes is within four hours");

        SimSettings patient = new SimSettings();
        patient.maxWaitSecs = -1;
        Net.Ran waits = Net.run(t, d, patient, null);
        assertEquals(Plans.OK, waits.journeys().only(1).status());
        assertEquals(List.of("Slow@18:05"), waits.journeys().only(1).trips(t));
    }

    @Test
    void madeUpPeopleStartAtTheStopTheRouterRecommends() {
        Timetable t = published().build();
        Router router = new Router(t);
        // Drawn at O, where the quick line from O2 already beats the slow one by more than the walk.
        Demand drawn = demand(t, row("p", "08:00", "O", "D"), row("q", "08:00", "O2", "D"));
        assertTrue(Net.run(t, drawn, new SimSettings(), null).plans().margin[0] > 0);

        Demand settled = DemandGenerator.settle(router, drawn, null, new SimSettings());
        assertEquals(2, settled.size());
        assertEquals("O2", settled.placeStop[settled.origin[0]]);
        assertEquals("D", settled.placeStop[settled.destination[0]]);
        assertEquals(t.stopLat[t.stopIndex("O2")], settled.placeLat[settled.origin[0]]);
        assertEquals("p", settled.userId(0));
        assertEquals(drawn.start[0], settled.start[0]);
        assertEquals("O2", settled.placeStop[settled.origin[1]], "someone already at the better stop stays there");
        Net.Ran bau = Net.run(t, settled, new SimSettings(), null);
        assertEquals(0, bau.plans().margin[0]);
        assertEquals(0, bau.plans().margin[1]);

        // Kept inside the area asked for: O2 is outside this one, so the person stays at O.
        Area west = new Area("box", -34, -32, 150, t.stopLon[t.stopIndex("O")] + 0.0005);
        Demand boxed = DemandGenerator.settle(router, demand(t, row("p", "08:00", "O", "D")), west, new SimSettings());
        assertEquals("O", boxed.placeStop[boxed.origin[0]]);
    }

    @Test
    void theGeneratorWithARouterLeavesNobodyAtABeatenStop() {
        Timetable t = published().build();
        Demand made = DemandGenerator.generate(new Router(t), null, 300, 7, 0, 1.0, 1, 2);
        assertEquals(300, made.size());
        Net.Ran bau = Net.run(t, made, new SimSettings(), null);
        assertEquals(0, Arrays.stream(bau.plans().margin).filter(margin -> margin > 0).count());
        assertTrue(DemandReport.figures(made).madeUpIds());
    }

    @Test
    void whatIsWrittenSaysWhatHappenedToThoseWhoGaveUpOrLostTheirStop() throws IOException {
        Timetable t = stops().line("Slow", 50, "O D", "0 20", EVERY_TEN).build();
        Demand d = demand(t, row("p", "08:00", "O", "D"), row("q", "08:00", "O", "D"));
        Net.Ran bau = Net.run(t, d, new SimSettings(), null);

        // The stop O is taken away and the line starts from O2 instead, 200 m off.
        Timetable moved = new Net().stop("O2", 200, 0).stop("D", 10000, 0).stop("D2", 10300, 0)
                .line("Slow", 50, "O2 D", "0 20", EVERY_TEN).build();
        String[] lines = written(moved, d, new SimSettings(), bau.plans());
        assertEquals("1", column(lines, 1, "origin_changed"), "their own stop is gone, so they use another");
        assertEquals("gone", column(lines, 1, "change_reason"));
        assertEquals("0", column(lines, 1, "destination_changed"));

        // Only the 07:05 and the 09:45 are left: both would arrive 100 minutes later, and give up.
        Timetable cut = stops().line("Slow", 50, "O D", "0 20", "07:05 09:45").build();
        lines = written(cut, d, new SimSettings(), bau.plans());
        assertEquals("gaveUp", column(lines, 1, "status"));
        assertEquals("6000", column(lines, 1, "later_secs"), "how much later the journey they turned down would be");
        assertEquals("", column(lines, 1, "arrive"));
    }

    @Test
    void theCheckWarnsAboutSmallHoursAndKnowsAMadeUpSet() {
        Timetable t = published().build();
        Demand real = demand(t, row("card 1", "00:20", "O", "D"), row("card 2", "08:00", "O", "D"));
        DemandReport.Figures figures = DemandReport.figures(real);
        assertEquals(1, figures.rowsBefore4am());
        assertEquals(1, figures.warnings().size());
        assertTrue(figures.warnings().get(0).contains("24:20"), figures.warnings().get(0));
        assertFalse(figures.madeUpIds());
        assertTrue(DemandReport.figures(demand(t, row("card 2", "08:00", "O", "D"))).warnings().isEmpty());
        assertTrue(DemandReport.figures(demand(t, row("u0000001", "08:00", "O", "D"))).madeUpIds());
    }

    /** The journeys file of a scenario run, as lines. */
    private static String[] written(Timetable t, Demand demand, SimSettings settings, Plans reference)
            throws IOException {
        StringWriter journeys = new StringWriter();
        StringWriter legs = new StringWriter();
        try (Simulation simulation = new Simulation(new Router(t), demand, settings)) {
            Plans plans = simulation.plan(reference, Progress.NONE);
            ResultWriter writer = new ResultWriter(t, demand, plans, reference, simulation.places(), journeys, legs);
            simulation.travel(plans, writer, Progress.NONE);
        } catch (InterruptedException e) {
            throw new AssertionError(e);
        }
        return journeys.toString().split("\n");
    }

    private static String column(String[] lines, int row, String name) {
        int at = Arrays.asList(lines[0].split(",")).indexOf(name);
        String[] fields = lines[row].split(",", -1);
        return fields[at];
    }
}
