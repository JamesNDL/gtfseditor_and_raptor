package gtfseditor.router.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

/**
 * Plans many journeys at once, and in {@link CapacityMode#ASSIGN} adds each passenger to the trips
 * they ride so that later passengers find them fuller. See section 4.2 of docs/router-plan.md.
 *
 * <p>Assigning is first come, first served by departure time:
 *
 * <ol>
 *   <li>Requests are taken in order of departure time, in slices of a few minutes.
 *   <li>Within a slice every passenger is routed, many at once, against the loads as they stood
 *       when the slice began.
 *   <li>They are then added to the loads one at a time, in order. Each takes the recommended
 *       journey.
 *   <li>A passenger who no longer fits somewhere along the way is not added. That boarding is
 *       refused them and they are routed again at once, against the loads as they now stand, up
 *       to a number of tries; after that they are stranded.
 * </ol>
 *
 * <p>The same requests give the same answer whatever the number of threads. It is not a simulation:
 * whoever is handled first holds the place, even if someone handled later would in life have
 * boarded further up the line. The counts of re-routed and stranded passengers show how much that
 * matters.
 */
public final class Assignment {

    public static final int DEFAULT_SLICE_SECS = 300;
    public static final int DEFAULT_MAX_TRIES = 3;

    /** How many journeys are planned between results in the modes that add nothing to the loads. */
    private static final int BATCH = 512;

    /** The requests, by number from 0. A query is asked for when it is needed, not kept. */
    public interface Requests {
        int count();

        /** When request {@code i} sets off, in seconds: the same as its query's. */
        int depart(int i);

        /** How many passengers travel together in request {@code i}. */
        int group(int i);

        Query query(int i);

        /**
         * What may stop request {@code i} boarding. The loads, group and share are already in
         * {@code capacity}; a request that has been refused some boardings adds them here.
         */
        default Capacity capacity(int i, Capacity capacity) {
            return capacity;
        }
    }

    /**
     * What became of one request.
     *
     * @param result  the search's answer, from the last try
     * @param journey the journey taken, which in {@code ASSIGN} is the one added to the loads; null
     *                if there is none
     * @param tries   how many times the passenger was routed; more than one means re-routed
     */
    public record Outcome(Query query, Result result, Journey journey, int tries) {

        public Result.Status status() {
            return journey != null ? Result.Status.OK
                    : result.status() == Result.Status.OK ? Result.Status.STRANDED : result.status();
        }
    }

    /** Receives each outcome as it is settled. In {@code ASSIGN} the order is the order of adding. */
    public interface Sink {
        void done(int request, Outcome outcome);
    }

    /**
     * @param loads     the loads to respect, and in {@code ASSIGN} to add to; null for {@code OFF}
     * @param fullAt    the share of its capacity at which a trip counts as full
     * @param sliceSecs length of a slice of departure times in {@code ASSIGN}
     * @param maxTries  most times a passenger is routed in {@code ASSIGN} before being stranded
     */
    public record Settings(CapacityMode mode, LoadState loads, double fullAt, int sliceSecs, int maxTries) {

        public Settings {
            if ((mode != CapacityMode.OFF) != (loads != null)) {
                throw new IllegalArgumentException("loads are needed for check and assign, and only for them");
            }
            if (sliceSecs < 1 || maxTries < 1) {
                throw new IllegalArgumentException("a slice and the number of tries must be at least 1");
            }
        }

        public static Settings off() {
            return new Settings(CapacityMode.OFF, null, 1.0, DEFAULT_SLICE_SECS, DEFAULT_MAX_TRIES);
        }

        public static Settings of(CapacityMode mode, LoadState loads) {
            return new Settings(mode, loads, 1.0, DEFAULT_SLICE_SECS, DEFAULT_MAX_TRIES);
        }
    }

    private Assignment() {}

    /**
     * Plans every request and hands each outcome to the sink, on the calling thread.
     *
     * @param workers the threads to plan on; planning on more of them does not change the answer
     * @throws InterruptedException if the calling thread is interrupted while waiting
     */
    public static void run(Router router, Requests requests, Preferences preferences, Settings settings,
            ExecutorService workers, Sink sink) throws InterruptedException {
        if (settings.mode() == CapacityMode.ASSIGN) {
            assign(router, requests, preferences, settings, workers, sink);
            return;
        }
        for (int from = 0; from < requests.count(); from += BATCH) {
            int[] batch = new int[Math.min(BATCH, requests.count() - from)];
            for (int i = 0; i < batch.length; i++) {
                batch[i] = from + i;
            }
            Capacity[] capacity = new Capacity[batch.length];
            for (int i = 0; i < batch.length; i++) {
                capacity[i] = requests.capacity(batch[i], settings.loads() == null ? Capacity.OFF
                        : Capacity.of(settings.loads(), settings.fullAt(), requests.group(batch[i])));
            }
            Outcome[] routed = route(router, requests, null, preferences, batch, capacity, workers);
            for (int i = 0; i < batch.length; i++) {
                sink.done(batch[i], routed[i]);
            }
        }
    }

    private static void assign(Router router, Requests requests, Preferences preferences, Settings settings,
            ExecutorService workers, Sink sink) throws InterruptedException {
        Timetable t = router.timetable();
        LoadState loads = settings.loads();
        Integer[] order = new Integer[requests.count()];
        for (int i = 0; i < order.length; i++) {
            order[i] = i;
        }
        // By departure time; requests that leave together keep the order they were given in.
        Arrays.sort(order, (a, b) -> requests.depart(a) != requests.depart(b)
                ? Integer.compare(requests.depart(a), requests.depart(b)) : Integer.compare(a, b));

        for (int start = 0; start < order.length; ) {
            int window = requests.depart(order[start]) / settings.sliceSecs();
            int end = start;
            while (end < order.length && requests.depart(order[end]) / settings.sliceSecs() == window) {
                end++;
            }
            int[] slice = new int[end - start];
            Capacity[] capacity = new Capacity[slice.length];
            for (int i = 0; i < slice.length; i++) {
                slice[i] = order[start + i];
                capacity[i] = requests.capacity(slice[i],
                        Capacity.of(loads, settings.fullAt(), requests.group(slice[i])));
            }
            Outcome[] routed = route(router, requests, null, preferences, slice, capacity, workers);
            for (int i = 0; i < slice.length; i++) {
                Query query = routed[i].query();
                Result result = routed[i].result();
                for (int tries = 1; ; tries++) {
                    Journey journey = result.best();
                    if (journey == null) {
                        sink.done(slice[i], new Outcome(query, result, null, tries));
                        break;
                    }
                    int noRoom = loads.add(journey, requests.group(slice[i]), settings.fullAt());
                    if (noRoom < 0 || tries == settings.maxTries()) {
                        sink.done(slice[i], new Outcome(query, result, noRoom < 0 ? journey : null, tries));
                        break;
                    }
                    // Refuse them the place where they got onto that vehicle. If they were aboard it
                    // already, as an earlier trip, that is where the earlier trip was boarded.
                    int leg = noRoom;
                    while (journey.legs().get(leg).stayAboard()) {
                        leg--;
                    }
                    Leg refused = journey.legs().get(leg);
                    capacity[i] = capacity[i].blocking(t, refused.trip(), refused.boardPosition());
                    result = route(router, requests, new Query[] {query}, preferences, new int[] {slice[i]},
                            new Capacity[] {capacity[i]}, workers)[0].result();
                }
            }
            start = end;
        }
    }

    /** Routes some requests at once. The loads must not change while this runs. */
    private static Outcome[] route(Router router, Requests requests, Query[] known, Preferences preferences,
            int[] which, Capacity[] capacity, ExecutorService workers) throws InterruptedException {
        List<Callable<Outcome>> tasks = new ArrayList<>(which.length);
        for (int i = 0; i < which.length; i++) {
            int at = i;
            tasks.add(() -> {
                Query query = known != null && known[at] != null ? known[at] : requests.query(which[at]);
                Result result = router.route(query, preferences, capacity[at]);
                return new Outcome(query, result, result.best(), 1);
            });
        }
        Outcome[] routed = new Outcome[which.length];
        List<Future<Outcome>> futures = workers.invokeAll(tasks);
        for (int i = 0; i < routed.length; i++) {
            try {
                routed[i] = futures.get(i).get();
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
        return routed;
    }
}
