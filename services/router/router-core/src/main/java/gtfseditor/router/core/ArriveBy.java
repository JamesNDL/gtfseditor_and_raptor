package gtfseditor.router.core;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

/**
 * Arrive-by journeys: the latest departure that still arrives by a time (BRD access-analysis
 * FR-21). See the arrive-by section of docs/router-plan.md.
 *
 * <p>Two steps. The backward search ({@link Router#latestDepartures}) finds the latest departure;
 * then the ordinary forward search from that departure plans the journey, so its legs, times and
 * fields are exactly a forward answer's. Of the forward search's journeys only those that arrive
 * in time are kept; the fastest always does, as the backward search found a way, and checking
 * that it does guards the two searches against each other. Loads are not looked at.
 */
public final class ArriveBy {

    /** How many journeys are planned between results in a bulk run, as {@link Assignment} does. */
    private static final int BATCH = 512;

    /** The requests of a bulk run, by number from 0. */
    public interface Requests {
        int count();

        Query query(int i);

        /** The time request {@code i} must arrive by, or -1 to plan it from its query's departure time. */
        int arriveBy(int i);
    }

    private ArriveBy() {}

    /** Plans the journey that leaves latest and still arrives by {@code arriveBy}. The query's departure time is not used. */
    public static Result route(Router router, Query query, int arriveBy, Preferences preferences) {
        long started = System.nanoTime();
        return forward(router, query, router.latestDeparture(query, arriveBy), arriveBy, preferences, started);
    }

    /** The forward search from a latest departure found already, or no journey if there is none (-1). */
    private static Result forward(Router router, Query query, int latest, int arriveBy, Preferences preferences,
            long started) {
        if (latest < 0) {
            return new Result(Result.Status.NO_JOURNEY, List.of(), -1, 0, 0, System.nanoTime() - started);
        }
        Result forward = router.route(query.departingAt(latest), preferences);
        List<Journey> inTime = new ArrayList<>();
        int recommended = -1;
        long lowest = Long.MAX_VALUE;
        for (Journey journey : forward.journeys()) {
            if (journey.arrive() <= arriveBy) {
                long cost = preferences.cost(journey);
                if (cost < lowest) {
                    lowest = cost;
                    recommended = inTime.size();
                }
                inTime.add(journey);
            }
        }
        if (inTime.isEmpty()) {
            throw new IllegalStateException("the backward search found a departure at " + latest + " to arrive by "
                    + arriveBy + ", but the forward search from it arrives later");
        }
        return new Result(Result.Status.OK, inTime, recommended, forward.rounds(), forward.patternsScanned(),
                System.nanoTime() - started);
    }

    /** What makes queries able to share one backward search. */
    private record End(List<Access> egress, int arriveBy, int maxRides, Set<Mode> avoid, int changeSecs, int maxLinkSecs) {

        static End of(Query q, int arriveBy, int routerMaxRides) {
            return new End(q.egress(), arriveBy, Math.min(q.maxRides(), routerMaxRides), q.avoid(), q.changeSecs(),
                    q.maxLinkSecs());
        }
    }

    /**
     * Plans every request and hands each outcome to the sink in the order asked, on the calling
     * thread. Arrive-by requests that share their end, time and limits share one backward search;
     * the searches run on the workers at once, and then every journey is planned forwards.
     * Departure requests are planned as {@link Assignment} does with capacity off.
     *
     * @throws InterruptedException if the calling thread is interrupted while waiting
     */
    public static void run(Router router, Requests requests, Preferences preferences, ExecutorService workers,
            Assignment.Sink sink) throws InterruptedException {
        int count = requests.count();
        Query[] queries = new Query[count];
        int[] latest = new int[count];
        Map<End, List<Integer>> ends = new HashMap<>();
        for (int i = 0; i < count; i++) {
            queries[i] = requests.query(i);
            if (requests.arriveBy(i) >= 0) {
                ends.computeIfAbsent(End.of(queries[i], requests.arriveBy(i), router.maxRides()), k -> new ArrayList<>())
                        .add(i);
            }
        }
        List<Callable<Integer>> searches = new ArrayList<>();
        for (Map.Entry<End, List<Integer>> end : ends.entrySet()) {
            searches.add(() -> {
                List<Integer> which = end.getValue();
                List<Query> sharing = new ArrayList<>(which.size());
                for (int i : which) {
                    sharing.add(queries[i]);
                }
                int[] found = router.latestDepartures(sharing, end.getKey().arriveBy());
                for (int i = 0; i < found.length; i++) {
                    latest[which.get(i)] = found[i];
                }
                return found.length;
            });
        }
        all(workers, searches);

        for (int from = 0; from < count; from += BATCH) {
            List<Callable<Assignment.Outcome>> tasks = new ArrayList<>();
            for (int i = from; i < Math.min(count, from + BATCH); i++) {
                int at = i;
                tasks.add(() -> {
                    long started = System.nanoTime();
                    int arriveBy = requests.arriveBy(at);
                    Result result = arriveBy < 0 ? router.route(queries[at], preferences)
                            : forward(router, queries[at], latest[at], arriveBy, preferences, started);
                    Query asked = arriveBy >= 0 && latest[at] >= 0 ? queries[at].departingAt(latest[at]) : queries[at];
                    return new Assignment.Outcome(asked, result, result.best(), 1);
                });
            }
            List<Assignment.Outcome> outcomes = all(workers, tasks);
            for (int i = 0; i < outcomes.size(); i++) {
                sink.done(from + i, outcomes.get(i));
            }
        }
    }

    /** Runs tasks on the workers and gives their answers in order, passing on what any of them throws. */
    private static <T> List<T> all(ExecutorService workers, List<Callable<T>> tasks) throws InterruptedException {
        List<T> answers = new ArrayList<>(tasks.size());
        for (Future<T> future : workers.invokeAll(tasks)) {
            try {
                answers.add(future.get());
            } catch (ExecutionException e) {
                if (e.getCause() instanceof RuntimeException problem) {
                    throw problem;
                }
                if (e.getCause() instanceof Error error) {
                    throw error;
                }
                throw new IllegalStateException(e.getCause());
            }
        }
        return answers;
    }
}
