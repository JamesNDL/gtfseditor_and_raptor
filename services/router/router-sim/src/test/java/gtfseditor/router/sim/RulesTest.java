package gtfseditor.router.sim;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Capacity;
import gtfseditor.router.core.Journey;
import gtfseditor.router.core.JourneyChecker;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;

/**
 * Rules that must always hold, on random timetables and demand (section 9 of the plan): a grid of
 * stops 400 m apart, a dozen random lines with small vehicles, and a few hundred journeys.
 */
class RulesTest {

    private static final int SIDE = 5;

    static Timetable randomTimetable(Random random, int lines, int smallest, int largest) {
        Net net = new Net();
        for (int y = 0; y < SIDE; y++) {
            for (int x = 0; x < SIDE; x++) {
                net.stop("s" + (y * SIDE + x), x * 400 + random.nextInt(60), y * 400 + random.nextInt(60));
            }
        }
        for (int line = 0; line < lines; line++) {
            int length = 3 + random.nextInt(5);
            List<Integer> stops = new ArrayList<>();
            int at = random.nextInt(SIDE * SIDE);
            stops.add(at);
            while (stops.size() < length) {
                // A step of one or two stops across the grid, to a stop the line has not been to.
                int x = Math.floorMod(at % SIDE + random.nextInt(5) - 2, SIDE);
                int y = Math.floorMod(at / SIDE + random.nextInt(5) - 2, SIDE);
                if (!stops.contains(y * SIDE + x)) {
                    at = y * SIDE + x;
                    stops.add(at);
                }
            }
            String[] names = new String[length];
            int[] offsets = new int[length];
            for (int i = 0; i < length; i++) {
                names[i] = "s" + stops.get(i);
                offsets[i] = i == 0 ? 0 : offsets[i - 1] + 2 + random.nextInt(4);
            }
            int headway = (4 + random.nextInt(17)) * 60;
            List<Integer> departs = new ArrayList<>();
            for (int time = 6 * 3600 + random.nextInt(headway); time < 10 * 3600; time += headway) {
                departs.add(time + random.nextInt(60)); // odd seconds, so that ties are rare but happen
            }
            departs.sort(null);
            net.line("L" + line, smallest + random.nextInt(largest - smallest + 1), names, offsets,
                    departs.stream().mapToInt(Integer::intValue).toArray());
        }
        return net.build();
    }

    static Demand randomDemand(Random random, Timetable t, int rows, int mostPeople) {
        Demand.Builder builder = new Demand.Builder();
        for (int i = 0; i < rows; i++) {
            int from = random.nextInt(t.stopCount());
            int to = random.nextInt(t.stopCount());
            // A few stop pairs carry most of the demand, as in life, so that plans are shared.
            if (random.nextInt(3) > 0) {
                from = random.nextInt(4);
                to = SIDE * SIDE - 1 - random.nextInt(4);
            }
            builder.add("u" + random.nextInt(rows), null, 6 * 3600 + random.nextInt(3 * 3600), t.stopIds[from],
                    Double.NaN, Double.NaN, t.stopIds[to], Double.NaN, Double.NaN, 1 + random.nextInt(mostPeople));
        }
        return builder.build().located(t, new DemandReport());
    }

    private static SimSettings settings(boolean capacity) {
        SimSettings settings = new SimSettings();
        settings.capacity = capacity;
        settings.threads = 3;
        return settings;
    }

    @Test
    void theRulesHoldOnRandomTimetables() {
        long leftBehind = 0;
        long stranded = 0;
        long splits = 0;
        for (int seed = 0; seed < 40; seed++) {
            Random random = new Random(seed);
            Timetable t = randomTimetable(random, 12, 2, 6);
            Demand d = randomDemand(random, t, 250, 3);
            String where = "seed " + seed;
            Net.Ran ran = Net.run(t, d, settings(true), null);
            Counts counts = ran.outcome().counts();
            leftBehind += ran.outcome().leftBehindPeople();

            // No trip ever leaves a stop over capacity (no vehicle here runs on as another trip).
            for (int trip = 0; trip < t.tripCount(); trip++) {
                int first = t.tripTimeIndex(trip, 0);
                int on = 0;
                int off = 0;
                for (int position = 0; position < t.patternLength(t.tripPattern[trip]); position++) {
                    assertTrue(counts.load[first + position] <= t.tripCapacity[trip],
                            where + ": trip " + t.tripIds[trip] + " over capacity at " + position);
                    on += counts.boardings[first + position];
                    off += counts.alightings[first + position];
                    // Those aboard on leaving a stop are those who have boarded less those who have left.
                    assertEquals(on - off, counts.load[first + position], where + ": trip " + t.tripIds[trip]);
                }
                assertEquals(on, off, where + ": boardings and alightings on trip " + t.tripIds[trip]);
            }

            // Everyone is ok, noJourney, gaveUp or stranded, once.
            int[] people = new int[d.size()];
            long rides = 0;
            try (Simulation simulation = new Simulation(new Router(t), d, settings(true))) {
                for (Net.Settled journey : ran.journeys().settled) {
                    people[journey.row()] += journey.people();
                    stranded += journey.status() == Plans.STRANDED ? journey.people() : 0;
                    if (journey.status() == Plans.NO_JOURNEY || journey.status() == Plans.GAVE_UP) {
                        assertTrue(journey.legs().isEmpty(), where + ": someone who did not travel has legs");
                    }
                    int time = d.start[journey.row()];
                    for (Leg leg : journey.legs()) {
                        assertTrue(leg.depart() >= time && leg.arrive() >= leg.depart(), where + ": legs out of order");
                        time = leg.arrive();
                        if (leg.kind() == Leg.Kind.RIDE) {
                            rides += journey.people();
                            assertEquals(t.depart[t.tripTimeIndex(leg.trip(), leg.boardPosition())], leg.depart());
                            assertEquals(t.arrive[t.tripTimeIndex(leg.trip(), leg.alightPosition())], leg.arrive());
                        }
                    }
                    // Every journey taken as planned replays against the timetable.
                    if (journey.status() == Plans.OK && journey.leftBehind() == 0) {
                        Query query = simulation.places().query(d.origin[journey.row()],
                                d.destination[journey.row()], d.start[journey.row()], ran.plans().near[journey.row()]);
                        assertNull(JourneyChecker.problem(t, query, ran.plans().journey[journey.row()], Capacity.OFF),
                                where + " row " + journey.row());
                        assertEquals(ran.plans().journey[journey.row()].legs(), journey.legs());
                    }
                }
            }
            for (int row = 0; row < d.size(); row++) {
                assertEquals(d.people[row], people[row], where + ": row " + row + " is not settled exactly once");
            }
            splits += ran.journeys().settled.size() - d.size();
            // Nobody who gave up or had no journey is aboard anything: the rides are all accounted for.
            assertEquals(rides, counts.totalBoardings(), where);
            assertEquals(ran.outcome().leftBehindPeople(), counts.totalLeftBehind(), where);
        }
        // The test is worth nothing unless the vehicles were actually full.
        assertTrue(leftBehind > 2000, "left behind " + leftBehind);
        assertTrue(stranded > 0 && splits > 100, "stranded " + stranded + ", rows split " + splits);
    }

    @Test
    void withCapacityOffEachJourneyIsTheOneTheRouterGives() throws InterruptedException {
        for (int seed = 0; seed < 15; seed++) {
            Random random = new Random(1000 + seed);
            Timetable t = randomTimetable(random, 12, 2, 6);
            Demand d = randomDemand(random, t, 200, 1);
            SimSettings alone = settings(false);
            alone.reusePlans = false;
            Net.Ran ran = Net.run(t, d, alone, null);
            Router router = new Router(t);
            try (Simulation simulation = new Simulation(router, d, alone)) {
                for (int row = 0; row < d.size(); row++) {
                    Query query = simulation.places().query(d.origin[row], d.destination[row], d.start[row], false);
                    // The router will ride out and back for someone going nowhere; the simulator will not.
                    Journey expected = query == null || d.origin[row] == d.destination[row] ? null
                            : router.route(query, Planner.preferences(alone)).best();
                    assertEquals(expected, ran.plans().journey[row], "seed " + seed + " row " + row);
                    assertEquals(expected == null ? List.of() : expected.legs(), ran.journeys().only(row).legs());
                }
            }
        }
    }

    /**
     * One search serves every later start it fits. The reused answer must be a journey the later
     * person can make, arriving when a search of their own would.
     */
    @Test
    void reusingAPlanChangesNoArrival() {
        long saved = 0;
        long searches = 0;
        long sameLegs = 0;
        long journeys = 0;
        for (int seed = 0; seed < 25; seed++) {
            Random random = new Random(2000 + seed);
            Timetable t = randomTimetable(random, 12, 2, 6);
            Demand d = randomDemand(random, t, 300, 1);
            SimSettings each = settings(false);
            each.reusePlans = false;
            Net.Ran fresh = Net.run(t, d, each, null);
            Net.Ran reused = Net.run(t, d, settings(false), null);
            saved += reused.plans().reused;
            searches += reused.plans().searches;
            assertEquals(0, fresh.plans().reused);
            try (Simulation simulation = new Simulation(new Router(t), d, each)) {
                for (int row = 0; row < d.size(); row++) {
                    String where = "seed " + seed + " row " + row;
                    assertEquals(fresh.plans().status[row], reused.plans().status[row], where);
                    assertEquals(fresh.plans().arrive[row], reused.plans().arrive[row], where);
                    assertEquals(fresh.plans().ownCost[row], reused.plans().ownCost[row], where);
                    assertEquals(fresh.plans().nearCost[row], reused.plans().nearCost[row], where);
                    assertEquals(fresh.plans().margin[row], reused.plans().margin[row], where);
                    Journey journey = reused.plans().journey[row];
                    if (journey != null) {
                        journeys++;
                        sameLegs += journey.legs().equals(fresh.plans().journey[row].legs()) ? 1 : 0;
                        Query query = simulation.places().query(d.origin[row], d.destination[row], d.start[row],
                                reused.plans().near[row]);
                        assertNull(JourneyChecker.problem(t, query, journey), where);
                    }
                }
            }
        }
        assertTrue(saved > searches / 4, "searches " + searches + ", saved " + saved);
        // Where two ways of making a journey tie on arrival and cost, the two may differ.
        assertTrue(sameLegs >= journeys * 0.99, sameLegs + " of " + journeys + " journeys are leg for leg the same");
    }

    @Test
    void theAnswerIsTheSameEveryTimeWhateverTheNumberOfThreads() {
        for (int seed = 0; seed < 6; seed++) {
            Random random = new Random(3000 + seed);
            Timetable t = randomTimetable(random, 12, 2, 5);
            Demand d = randomDemand(random, t, 400, 3);
            SimSettings one = settings(true);
            one.threads = 1;
            SimSettings eight = settings(true);
            eight.threads = 8;
            Net.Ran first = Net.run(t, d, one, null);
            Net.Ran second = Net.run(t, d, eight, null);
            Net.Ran third = Net.run(t, d, eight, null);
            assertTrue(first.outcome().replayed());
            assertEquals(first.journeys().settled, second.journeys().settled, "seed " + seed);
            assertEquals(second.journeys().settled, third.journeys().settled, "seed " + seed);
            assertEquals(java.util.Arrays.hashCode(first.outcome().counts().load),
                    java.util.Arrays.hashCode(second.outcome().counts().load));
        }
    }

    /** Nothing is lost by switching capacity on when nothing is full: the replay itself, not the short cut. */
    @Test
    void withVeryLargeVehiclesTheReplayGivesWhatCountingGives() throws InterruptedException {
        for (int seed = 0; seed < 8; seed++) {
            Random random = new Random(4000 + seed);
            Timetable t = randomTimetable(random, 12, 100_000, 100_000);
            Demand d = randomDemand(random, t, 300, 3);
            SimSettings settings = settings(true);
            Router router = new Router(t);
            try (Simulation simulation = new Simulation(router, d, settings)) {
                Plans plans = simulation.plan(null, Progress.NONE);
                Net.Collector counted = new Net.Collector();
                Replay count = new Replay(router, d, simulation.places(), plans, settings, counted);
                count.count(Progress.NONE);
                Net.Collector replayed = new Net.Collector();
                Replay replay = new Replay(router, d, simulation.places(), plans, settings, replayed);
                java.util.concurrent.ExecutorService workers = java.util.concurrent.Executors.newFixedThreadPool(2);
                try {
                    replay.run(workers, Progress.NONE);
                } finally {
                    workers.shutdownNow();
                }
                assertEquals(0, replay.leftBehindPeople);
                assertEquals(new java.util.HashSet<>(counted.settled), new java.util.HashSet<>(replayed.settled));
                assertEquals(counted.settled.size(), replayed.settled.size());
                assertTrue(java.util.Arrays.equals(count.counts.load, replay.counts.load));
                assertTrue(java.util.Arrays.equals(count.counts.boardings, replay.counts.boardings));
                assertTrue(java.util.Arrays.equals(count.counts.changes, replay.counts.changes));
                java.io.StringWriter a = new java.io.StringWriter();
                java.io.StringWriter b = new java.io.StringWriter();
                try {
                    count.counts.writeStopActivity(a);
                    replay.counts.writeStopActivity(b);
                } catch (java.io.IOException e) {
                    throw new AssertionError(e);
                }
                assertEquals(a.toString(), b.toString(), "waiting at stops, seed " + seed);
            }
        }
    }

    /**
     * Planned loads tell the truth (section 4.5): nobody whose journey ends before the first
     * departure that is planned over capacity is affected by capacity.
     */
    @Test
    void nobodyWhoArrivesBeforeTheFirstOverloadedDepartureIsAffected() {
        int checked = 0;
        for (int seed = 0; seed < 20; seed++) {
            Random random = new Random(5000 + seed);
            Timetable t = randomTimetable(random, 12, 4, 9);
            Demand d = randomDemand(random, t, 150, 2);
            Net.Ran off = Net.run(t, d, settings(false), null);
            Net.Ran on = Net.run(t, d, settings(true), null);
            int[] planned = Replay.plannedLoads(t, d, off.plans());
            int firstOver = Integer.MAX_VALUE;
            for (int trip = 0; trip < t.tripCount(); trip++) {
                int first = t.tripTimeIndex(trip, 0);
                for (int position = 0; position < t.patternLength(t.tripPattern[trip]); position++) {
                    if (planned[first + position] > t.tripCapacity[trip]) {
                        firstOver = Math.min(firstOver, t.depart[first + position]);
                    }
                }
            }
            for (int row = 0; row < d.size(); row++) {
                if (off.plans().status[row] == Plans.OK && off.plans().arrive[row] < firstOver) {
                    assertEquals(off.journeys().only(row), on.journeys().only(row), "seed " + seed + " row " + row);
                    checked++;
                }
            }
        }
        assertTrue(checked > 300, "checked " + checked);
    }

    @Test
    void stopActivityAddsUpToTheJourneys() throws java.io.IOException {
        Random random = new Random(77);
        Timetable t = randomTimetable(random, 12, 3, 6);
        Demand d = randomDemand(random, t, 300, 2);
        Net.Ran ran = Net.run(t, d, settings(true), null);
        java.io.StringWriter out = new java.io.StringWriter();
        long rows = ran.outcome().counts().writeStopActivity(out);
        String[] lines = out.toString().split("\n");
        assertEquals(rows + 1, lines.length);
        long boardings = 0;
        long alightings = 0;
        long changes = 0;
        long left = 0;
        int mostWaiting = 0;
        for (int i = 1; i < lines.length; i++) {
            String[] cells = lines[i].split(",");
            boardings += Long.parseLong(cells[2]);
            alightings += Long.parseLong(cells[3]);
            changes += Long.parseLong(cells[4]);
            left += Long.parseLong(cells[5]);
            mostWaiting = Math.max(mostWaiting, Integer.parseInt(cells[6]));
            assertTrue(Integer.parseInt(cells[6]) >= 0);
        }
        long expectedBoardings = 0;
        long expectedChanges = 0;
        for (Net.Settled journey : ran.journeys().settled) {
            int ridden = 0;
            for (Leg leg : journey.legs()) {
                ridden += leg.kind() == Leg.Kind.RIDE ? 1 : 0;
            }
            expectedBoardings += (long) ridden * journey.people();
            expectedChanges += (long) Math.max(0, ridden - 1) * journey.people();
        }
        assertEquals(expectedBoardings, boardings);
        assertEquals(expectedBoardings, alightings);
        assertEquals(expectedChanges, changes);
        assertEquals(ran.outcome().leftBehindPeople(), left);
        assertTrue(mostWaiting > 3, "most waiting at one stop " + mostWaiting);

        java.io.StringWriter loads = new java.io.StringWriter();
        long loadRows = ran.outcome().counts().writeTripLoads(loads);
        assertEquals(loadRows + 1, loads.toString().split("\n").length);
    }
}
