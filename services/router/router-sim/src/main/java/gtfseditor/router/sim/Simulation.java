package gtfseditor.router.sim;

import gtfseditor.router.core.Router;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * One run of the simulator, in memory: plan every journey, then put the passengers on the
 * vehicles. See section 4 of docs/simulator-plan.md. {@link SimRun} is the same with files.
 *
 * <pre>
 * try (Simulation bau = new Simulation(new Router(published), demand, settings)) {
 *     Plans plans = bau.plan(null, Progress.NONE);              // a BAU run: everyone keeps their stops
 *     Simulation.Outcome outcome = bau.travel(plans, sink, Progress.NONE);
 * }
 * try (Simulation scenario = new Simulation(new Router(changed), demand, settings)) {
 *     Plans plans = scenario.plan(bauPlans, Progress.NONE);     // measured against the BAU run
 *     scenario.travel(plans, sink, Progress.NONE);
 * }
 * </pre>
 */
public final class Simulation implements AutoCloseable {

    /** How many of the trips furthest over capacity are listed. */
    static final int WORST_TRIPS = 20;

    /**
     * @param counts           who was where
     * @param planned          the trips that would be over capacity if everyone rode what they planned
     * @param replayed         whether the time-ordered replay ran; false with capacity off, and with
     *                         capacity on where no trip is planned over capacity
     * @param leftBehindPeople times anyone was left behind by a full vehicle
     * @param replanSearches   searches made for passengers left behind
     * @param seconds          time this stage took
     */
    public record Outcome(Counts counts, Counts.Pressure planned, boolean replayed, long leftBehindPeople,
            long replanSearches, double seconds) {}

    private final Router router;
    private final Demand demand;
    private final SimSettings settings;
    private final PlaceIndex places;
    private final ExecutorService workers;

    /**
     * @param demand the journeys, each end with a position (see {@link Demand#located})
     * @throws IllegalArgumentException if a setting is out of range
     */
    public Simulation(Router router, Demand demand, SimSettings settings) {
        settings.check();
        this.router = router;
        this.demand = demand;
        this.settings = settings.copy();
        this.places = new PlaceIndex(router, demand, this.settings);
        this.workers = Executors.newFixedThreadPool(this.settings.threads, task -> {
            Thread thread = new Thread(task, "simulator");
            thread.setDaemon(true);
            return thread;
        });
    }

    PlaceIndex places() {
        return places;
    }

    /**
     * Stage 1: plans every row, capacity off.
     *
     * @param reference the plans of the BAU run to measure against, row for row with the demand; or
     *                  null, which makes this a BAU run: everyone keeps their own stops
     */
    public Plans plan(Plans reference, Progress progress) throws InterruptedException {
        return Planner.plan(router, demand, places, settings, reference, workers, progress);
    }

    /**
     * Stage 2: puts the planned journeys on the vehicles, and with capacity on leaves behind those
     * who do not fit.
     *
     * @param plans made by {@link #plan} for this demand on this timetable, now or earlier
     */
    public Outcome travel(Plans plans, Sink sink, Progress progress) throws InterruptedException {
        if (plans.size() != demand.size()) {
            throw new IllegalArgumentException("the plans are for " + plans.size() + " rows, not " + demand.size());
        }
        Replay replay = new Replay(router, demand, places, plans, settings, sink);
        Counts.Pressure planned;
        boolean replayed = false;
        if (!settings.capacity) {
            replay.count(progress);
            planned = Counts.pressure(router.timetable(), replay.counts.load, settings.fullAt, WORST_TRIPS);
        } else {
            // Capacity never enters the planning. Where nothing is planned over capacity nobody can
            // be refused, and the run with capacity on is the run with capacity off.
            planned = Counts.pressure(router.timetable(), Replay.plannedLoads(router.timetable(), demand, plans),
                    settings.fullAt, WORST_TRIPS);
            if (planned.trips() == 0) {
                replay.count(progress);
            } else {
                replay.run(workers, progress);
                replayed = true;
            }
        }
        return new Outcome(replay.counts, planned, replayed, replay.leftBehindPeople, replay.replanSearches,
                replay.seconds);
    }

    @Override
    public void close() {
        workers.shutdownNow();
    }
}
