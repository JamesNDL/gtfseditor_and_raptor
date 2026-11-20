package gtfseditor.router.sim;

import gtfseditor.router.core.Geo;
import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Timetable;
import java.util.Random;

/**
 * Makes up a demand set, for use until real journey data exists. See section 3.3 of
 * docs/simulator-plan.md. A made-up set says nothing about real travel: it shows that the
 * simulator works and how fast it is.
 *
 * <p>Each end of a journey is a stop inside the area, picked in proportion to the number of times
 * a vehicle other than a school bus calls there in the day. 30% of journeys start between 06:30
 * and 09:30, 30% between 15:30 and 18:30, and the rest at any time from 05:00 to 22:00: the same
 * draw as the router's test journeys. Six users in ten also travel back, three to ten hours later.
 *
 * <p>Drawn like that, hardly any two journeys share a pair of stops, which real tap data does all
 * the time. {@code focus} raises each stop's weight to a power: at 2 the big stations take most of
 * the journeys, plans are shared and trains fill. {@code people} makes each row stand for several
 * people, so that a hundred thousand rows can load the network like a whole day.
 *
 * <p>A person drawn at a stop would often do better from another stop nearby, and a simulator that
 * lets people change stop would then report a gain that the published timetable already offered.
 * So, given a router, each person is moved to the stops the router recommends for their journey
 * (see {@link #settle}): they start where a sensible traveller would, and their margin is nothing.
 */
public final class DemandGenerator {

    /** Stops further apart than this, in a straight line, are not paired unless asked. */
    public static final double DEFAULT_WITHIN_KM = 25;

    private DemandGenerator() {}

    /**
     * @param area     the box both ends lie in, or null for anywhere
     * @param journeys how many rows to make
     * @param withinKm the furthest apart the two ends may be, or 0 for any distance
     * @throws IllegalArgumentException if the area holds fewer than two stops with a service
     */
    public static Demand generate(Timetable t, Area area, int journeys, long seed, double withinKm) {
        return generate(t, area, journeys, seed, withinKm, 1.0, 1);
    }

    /**
     * @param focus  the power each stop's number of calls is raised to; 1 for in proportion
     * @param people how many people each row stands for
     */
    public static Demand generate(Timetable t, Area area, int journeys, long seed, double withinKm, double focus,
            int people) {
        if (!(focus > 0 && focus <= 4) || people < 1) {
            throw new IllegalArgumentException("focus is above 0 and at most 4, and a row stands for 1 person or more");
        }
        int[] stops = new int[t.stopCount()];
        long[] upTo = new long[t.stopCount()];
        int eligible = 0;
        long total = 0;
        for (int stop = 0; stop < t.stopCount(); stop++) {
            if (area != null && !area.holds(t.stopLat[stop], t.stopLon[stop])) {
                continue;
            }
            long calls = 0;
            for (int j = t.stopPatternOffset[stop]; j < t.stopPatternOffset[stop + 1]; j++) {
                if (t.patternMode[t.stopPatterns[j]] != Mode.SCHOOL_BUS.ordinal()) {
                    calls += t.patternTripCount(t.stopPatterns[j]);
                }
            }
            if (calls > 0) {
                total += focus == 1.0 ? calls : Math.max(1, Math.round(Math.pow(calls, focus)));
                stops[eligible] = stop;
                upTo[eligible] = total;
                eligible++;
            }
        }
        if (eligible < 2) {
            throw new IllegalArgumentException("fewer than two stops with a service are inside the area");
        }
        Random random = new Random(seed);
        Demand.Builder builder = new Demand.Builder();
        int users = 0;
        while (builder.rows() < journeys) {
            int from = pick(random, stops, upTo, eligible, total);
            int to = pick(random, stops, upTo, eligible, total);
            for (int tries = 0; to == from || (withinKm > 0 && Geo.metresBetween(t.stopLat[from], t.stopLon[from],
                    t.stopLat[to], t.stopLon[to]) > withinKm * 1000); tries++) {
                if (tries == 200) {
                    from = pick(random, stops, upTo, eligible, total); // a stop with nothing else near it
                    tries = 0;
                }
                to = pick(random, stops, upTo, eligible, total);
            }
            int kind = random.nextInt(10);
            int start = kind < 3 ? 6 * 3600 + 1800 + random.nextInt(3 * 3600)
                    : kind < 6 ? 15 * 3600 + 1800 + random.nextInt(3 * 3600)
                    : 5 * 3600 + random.nextInt(17 * 3600);
            String user = String.format("u%07d", ++users);
            add(builder, t, user, from, to, start, people);
            int back = start + 3 * 3600 + random.nextInt(7 * 3600);
            if (random.nextInt(10) < 6 && back < 23 * 3600 + 1800 && builder.rows() < journeys) {
                add(builder, t, user, to, from, back, people);
            }
        }
        return builder.build();
    }

    /** How many times a person is moved towards the stops the router recommends before being left be. */
    static final int SETTLE_ROUNDS = 4;

    /**
     * Makes a set up and then starts each person at the stops the router recommends: see
     * {@link #settle}. This is what the command and the service use.
     *
     * @param threads searches at once
     */
    public static Demand generate(gtfseditor.router.core.Router router, Area area, int journeys, long seed,
            double withinKm, double focus, int people, int threads) {
        Demand drawn = generate(router.timetable(), area, journeys, seed, withinKm, focus, people);
        SimSettings settings = new SimSettings();
        settings.threads = Math.max(1, threads);
        return settle(router, drawn, area, settings);
    }

    /**
     * Moves each person to the stops the router recommends for their journey, as a default BAU run
     * would judge it: where a journey that may use any stop within the walking distance costs less
     * than the one between the stops drawn, the person's ends become the stops at which that
     * journey boards its first vehicle and leaves its last. That is done again from the new stops,
     * up to {@link #SETTLE_ROUNDS} times, because the walking distance is measured from where the
     * person now stands. Someone with no journey at all, or whose recommended stops lie outside the
     * area, stays where they were drawn. Rows keep their order, users and start times.
     */
    static Demand settle(gtfseditor.router.core.Router router, Demand drawn, Area area, SimSettings settings) {
        Timetable t = router.timetable();
        int rows = drawn.size();
        int[] from = new int[rows];
        int[] to = new int[rows];
        for (int row = 0; row < rows; row++) {
            from[row] = t.stopIndex(drawn.placeStop[drawn.origin[row]]);
            to[row] = t.stopIndex(drawn.placeStop[drawn.destination[row]]);
        }
        int[] pending = new int[rows];
        for (int row = 0; row < rows; row++) {
            pending[row] = row;
        }
        int count = rows;
        for (int round = 0; round < SETTLE_ROUNDS && count > 0; round++) {
            Demand.Builder builder = new Demand.Builder();
            for (int i = 0; i < count; i++) {
                int row = pending[i];
                add(builder, t, drawn.userId(row), from[row], to[row], drawn.start[row], drawn.people[row]);
            }
            Demand asked = builder.build();
            Plans plans;
            try (Simulation simulation = new Simulation(router, asked, settings)) {
                plans = simulation.plan(null, Progress.NONE);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("stopped while making the journeys up", e);
            }
            int moved = 0;
            for (int i = 0; i < count; i++) {
                int row = pending[i];
                int nearFrom = plans.nearFrom[i];
                int nearTo = plans.nearTo[i];
                boolean better = plans.margin[i] > 0 || (plans.ownCost[i] < 0 && plans.nearCost[i] >= 0);
                if (!better || nearFrom < 0 || nearTo < 0 || nearFrom == nearTo
                        || (nearFrom == from[row] && nearTo == to[row])
                        || (area != null && !(area.holds(t.stopLat[nearFrom], t.stopLon[nearFrom])
                                && area.holds(t.stopLat[nearTo], t.stopLon[nearTo])))) {
                    continue;
                }
                from[row] = nearFrom;
                to[row] = nearTo;
                pending[moved++] = row;
            }
            count = moved;
        }
        Demand.Builder builder = new Demand.Builder();
        for (int row = 0; row < rows; row++) {
            add(builder, t, drawn.userId(row), from[row], to[row], drawn.start[row], drawn.people[row]);
        }
        return builder.build();
    }

    private static void add(Demand.Builder builder, Timetable t, String user, int from, int to, int start,
            int people) {
        builder.add(user, null, start, t.stopIds[from], t.stopLat[from], t.stopLon[from], t.stopIds[to],
                t.stopLat[to], t.stopLon[to], people);
    }

    private static int pick(Random random, int[] stops, long[] upTo, int eligible, long total) {
        long wanted = (long) (random.nextDouble() * total);
        int low = 0;
        int high = eligible - 1;
        while (low < high) {
            int middle = (low + high) >>> 1;
            if (upTo[middle] > wanted) {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        return stops[low];
    }
}
