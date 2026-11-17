package gtfseditor.router.sim;

import gtfseditor.router.core.Journey;
import gtfseditor.router.core.Preferences;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Result;
import gtfseditor.router.core.Router;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Stage 1: plans every row with the router, capacity off, and decides which stops each person
 * uses. See sections 4.2, 4.6 and 5.2 of docs/simulator-plan.md.
 *
 * <p>Each person is planned twice: between their own stops, and between any stops near them.
 *
 * <ul>
 *   <li>With no reference (a BAU run) they take the own-stops journey, and how much lower the cost
 *       of the other was is kept as their margin.
 *   <li>With a reference (a scenario run) they change to the any-stop-near journey only if it is
 *       better by more than that margin plus the threshold, or if there is no own-stops journey.
 *       One who would arrive later than the reference by more than the limit gives up.
 * </ul>
 *
 * <p><b>Reuse.</b> Rows are grouped by their two places and taken in order of start time. The
 * router's journeys leave as late as they can, so one search answers every later start up to the
 * earliest departure among the journeys it found: from any such start each of those journeys can
 * still be made, and nothing that leaves earlier is lost. The reused answer has the same arrival
 * for each number of rides as a fresh search; where two ways of making a journey tie on arrival a
 * fresh search may pick the other. Groups are whole units of work, so the result does not depend
 * on the number of threads.
 */
final class Planner {

    private static final Result NOTHING = new Result(Result.Status.NO_JOURNEY, List.of(), -1, 0, 0, 0);

    private final Router router;
    private final Demand demand;
    private final PlaceIndex places;
    private final SimSettings settings;
    private final Plans reference;
    private final Preferences preferences;
    private final Plans plans;
    private final int[] order; // rows, by origin, destination and start
    private final int[] groupStart;
    private final AtomicLong searches = new AtomicLong();
    private final AtomicLong reused = new AtomicLong();
    private final AtomicLong done = new AtomicLong();

    private Planner(Router router, Demand demand, PlaceIndex places, SimSettings settings, Plans reference) {
        this.router = router;
        this.demand = demand;
        this.places = places;
        this.settings = settings;
        this.reference = reference;
        this.preferences = preferences(settings);
        this.plans = new Plans(demand.size());

        int rows = demand.size();
        long[] keys = new long[rows];
        Integer[] sorted = new Integer[rows];
        for (int row = 0; row < rows; row++) {
            keys[row] = ((long) demand.origin[row] << 32) | demand.destination[row];
            sorted[row] = row;
        }
        Arrays.parallelSort(sorted, (a, b) -> {
            int byPlaces = Long.compare(keys[a], keys[b]);
            if (byPlaces != 0) {
                return byPlaces;
            }
            int byStart = Integer.compare(demand.start[a], demand.start[b]);
            return byStart != 0 ? byStart : Integer.compare(a, b);
        });
        order = new int[rows];
        int[] starts = new int[rows + 1];
        int groups = 0;
        for (int i = 0; i < rows; i++) {
            order[i] = sorted[i];
            if (i == 0 || keys[order[i]] != keys[order[i - 1]]) {
                starts[groups++] = i;
            }
        }
        starts[groups] = rows;
        groupStart = Arrays.copyOf(starts, groups + 1);
    }

    /** How the simulator scores journeys: the owner's ten minutes per vehicle, and walking counted twice. */
    static Preferences preferences(SimSettings settings) {
        Preferences usual = Preferences.defaults();
        return new Preferences(settings.changePenaltySecs, usual.maxExtraSecsPerRideSaved(), usual.walkCostPercent(),
                0, 0);
    }

    /**
     * @param reference the plans of the BAU run this run is measured against, row for row, or null
     *                  if this is a BAU run
     */
    static Plans plan(Router router, Demand demand, PlaceIndex places, SimSettings settings, Plans reference,
            ExecutorService workers, Progress progress) throws InterruptedException {
        if (reference != null && reference.size() != demand.size()) {
            throw new IllegalArgumentException("the reference has " + reference.size() + " rows and the demand "
                    + demand.size() + "; a scenario run uses the demand set of its BAU run");
        }
        long started = System.nanoTime();
        Planner planner = new Planner(router, demand, places, settings, reference);
        int groups = planner.groupStart.length - 1;
        AtomicInteger next = new AtomicInteger();
        Future<?>[] running = new Future<?>[settings.threads];
        for (int i = 0; i < running.length; i++) {
            running[i] = workers.submit(() -> {
                // A run that is stopped interrupts its threads; each gives up at its next group.
                for (int group = next.getAndIncrement(); group < groups && !Thread.currentThread().isInterrupted();
                        group = next.getAndIncrement()) {
                    planner.planGroup(planner.groupStart[group], planner.groupStart[group + 1]);
                }
            });
        }
        try {
            for (Future<?> worker : running) {
                while (true) {
                    try {
                        worker.get(2, TimeUnit.SECONDS);
                        break;
                    } catch (TimeoutException e) {
                        progress.at("plan", planner.done.get(), demand.size());
                    }
                }
            }
        } catch (ExecutionException e) {
            for (Future<?> worker : running) {
                worker.cancel(true);
            }
            throw new IllegalStateException("planning failed: " + e.getCause(), e.getCause());
        }
        progress.at("plan", demand.size(), demand.size());
        planner.plans.searches = planner.searches.get();
        planner.plans.reused = planner.reused.get();
        planner.plans.planSecs = (System.nanoTime() - started) / 1e9;
        return planner.plans;
    }

    /** Plans the rows at these places in {@link #order}: one pair of places, in order of start. */
    private void planGroup(int from, int to) {
        int origin = demand.origin[order[from]];
        int destination = demand.destination[order[from]];
        boolean hasOwn = places.hasOwn(origin) && places.hasOwn(destination);
        boolean searchNear = settings.walkMetres > 0;
        Result own = null;
        Result near = null;
        int ownUntil = -1;
        int nearUntil = -1;
        long ran = 0;
        long saved = 0;
        for (int i = from; i < to; i++) {
            int row = order[i];
            int start = demand.start[row];
            if (origin == destination) {
                none(row, Plans.SAME_PLACE);
                continue;
            }
            if (hasOwn) {
                if (own == null || start > ownUntil) {
                    own = route(origin, destination, start, false);
                    ownUntil = goodUntil(own, start);
                    ran++;
                } else {
                    saved++;
                }
            }
            if (searchNear) {
                if (near == null || start > nearUntil) {
                    near = route(origin, destination, start, true);
                    nearUntil = goodUntil(near, start);
                    ran++;
                } else {
                    saved++;
                }
            }
            decide(row, hasOwn, own == null ? null : own.best(), near == null ? null : near.best());
        }
        searches.addAndGet(ran);
        reused.addAndGet(saved);
        done.addAndGet(to - from);
    }

    private Result route(int origin, int destination, int start, boolean near) {
        Query query = places.query(origin, destination, start, near);
        return query == null ? NOTHING : router.route(query, preferences);
    }

    /** The latest start this answer is also the answer for. */
    private int goodUntil(Result result, int start) {
        if (!settings.reusePlans) {
            return -1;
        }
        if (result.journeys().isEmpty()) {
            return Integer.MAX_VALUE; // nothing from here on: a later start finds nothing either
        }
        int until = Integer.MAX_VALUE;
        for (Journey journey : result.journeys()) {
            // Walking the whole way takes as long whenever it starts, so it arrives later for a later start.
            until = Math.min(until, journey.rides() == 0 ? start : journey.depart());
        }
        return until;
    }

    private void none(int row, byte why) {
        plans.status[row] = Plans.NO_JOURNEY;
        plans.why[row] = why;
        plans.arrive[row] = -1;
        plans.ownArrive[row] = -1;
        plans.ownCost[row] = -1;
        plans.nearArrive[row] = -1;
        plans.nearCost[row] = -1;
        plans.margin[row] = reference == null ? 0 : reference.margin[row];
    }

    /**
     * Chooses between the own-stops journey and the one that may use any stop near.
     *
     * @param own  the own-stops journey, or null
     * @param near the best the any-stop-near search found, or null
     */
    private void decide(int row, boolean hasOwn, Journey own, Journey near) {
        // The own stops are among the stops near, so the own-stops journey is always on offer to
        // someone who may use any stop; the search prefers an earlier arrival and may not show it.
        Journey any = near;
        if (own != null && (any == null || preferences.cost(own) <= preferences.cost(any))) {
            any = own;
        }
        plans.ownArrive[row] = own == null ? -1 : own.arrive();
        plans.ownCost[row] = own == null ? -1 : (int) preferences.cost(own);
        plans.nearArrive[row] = any == null ? -1 : any.arrive();
        plans.nearCost[row] = any == null ? -1 : (int) preferences.cost(any);

        Journey chosen;
        byte reason = Plans.KEPT;
        if (reference == null) {
            // The published timetable: what they did on the day.
            chosen = hasOwn ? own : any;
            reason = hasOwn || chosen == null ? Plans.KEPT : Plans.POSITION;
            plans.margin[row] = own == null || any == null ? 0 : (int) (preferences.cost(own) - preferences.cost(any));
        } else {
            int margin = reference.margin[row];
            plans.margin[row] = margin;
            if (own == null) {
                // Someone who had no journey on the published timetable, though a stop nearby had
                // one, did not use it there; an unchanged timetable must leave them as they were.
                // They take it only if the change has made it better by more than the threshold.
                boolean passedOver = reference.status[row] == Plans.NO_JOURNEY && reference.nearCost[row] >= 0
                        && any != null
                        && reference.nearCost[row] - preferences.cost(any) <= settings.switchThresholdSecs;
                chosen = passedOver ? null : any;
                reason = chosen == null ? Plans.KEPT
                        : reference.reason[row] == Plans.POSITION ? Plans.POSITION : Plans.GONE;
            } else if (any != own
                    && preferences.cost(own) - preferences.cost(any) > (long) margin + settings.switchThresholdSecs) {
                chosen = any;
                reason = Plans.BETTER;
            } else {
                chosen = own;
            }
        }
        plans.journey[row] = chosen;
        plans.near[row] = chosen != null && chosen != own;
        plans.reason[row] = reason;
        if (chosen == null) {
            plans.status[row] = Plans.NO_JOURNEY;
            plans.arrive[row] = -1;
            boolean stops = places.query(demand.origin[row], demand.destination[row], demand.start[row],
                    reference != null || !hasOwn) != null;
            plans.why[row] = stops ? Plans.NOTHING_RUNS : Plans.NO_STOP;
            return;
        }
        plans.arrive[row] = chosen.arrive();
        boolean tooLate = reference != null && settings.giveUpSecs >= 0 && reference.status[row] == Plans.OK
                && chosen.arrive() - reference.arrive[row] > settings.giveUpSecs;
        plans.status[row] = tooLate ? Plans.GAVE_UP : Plans.OK;
    }
}
