package gtfseditor.router.core;

/**
 * How many passengers are aboard every trip as it leaves every stop: a sheet of numbers laid over
 * a timetable, which itself never changes. See section 4.2 of docs/router-plan.md.
 *
 * <p>Changes are made one at a time. A search reads the numbers without waiting, so a search that
 * runs while passengers are being added may see some of them and not others; a bulk assignment
 * never searches and adds at the same moment.
 */
public final class LoadState {

    /**
     * What a load state holds.
     *
     * @param passengers    passengers added by {@link LoadState#add}, counting each once
     * @param loadedCalls   departures from a stop with anyone aboard
     * @param fullCalls     departures from a stop at or over the trip's capacity
     * @param tripsWithLoad trips with anyone aboard anywhere
     * @param fullTrips     trips at or over capacity somewhere
     * @param peakFactor    the highest load as a share of capacity
     */
    public record Summary(long passengers, int loadedCalls, int fullCalls, int tripsWithLoad, int fullTrips,
            double peakFactor) {}

    private final Timetable t;
    private final int[] loads; // in step with the timetable's arrive and depart
    private long passengers;

    private LoadState(Timetable t) {
        this.t = t;
        this.loads = new int[t.stopTimeCount()];
    }

    /** A load state with nobody aboard anything. */
    public static LoadState empty(Timetable timetable) {
        return new LoadState(timetable);
    }

    public Timetable timetable() {
        return t;
    }

    /** The numbers themselves, for the search to read. */
    int[] array() {
        return loads;
    }

    /** Passengers aboard a trip as it leaves the stop at a position along it. */
    public int load(int trip, int position) {
        return loads[index(trip, position)];
    }

    /** Sets the passengers aboard a trip as it leaves a position, for loads that come from elsewhere. */
    public synchronized void set(int trip, int position, int load) {
        if (load < 0) {
            throw new IllegalArgumentException("a load cannot be negative");
        }
        loads[index(trip, position)] = load;
    }

    private int index(int trip, int position) {
        if (trip < 0 || trip >= t.tripCount() || position < 0 || position >= t.patternLength(t.tripPattern[trip])) {
            throw new IllegalArgumentException("there is no position " + position + " on trip " + trip);
        }
        return t.tripTimeIndex(trip, position);
    }

    /**
     * Adds the passengers of one journey to every trip they ride, from each stop they leave aboard
     * it; but only if they fit everywhere. If they do not, nothing changes.
     *
     * @param group  how many passengers travel together
     * @param fullAt the share of its capacity at which a trip counts as full
     * @return -1 if they were added; otherwise which leg of the journey has no room
     */
    public synchronized int add(Journey journey, int group, double fullAt) {
        if (group < 1) {
            throw new IllegalArgumentException("a group is at least one passenger");
        }
        for (int i = 0; i < journey.legs().size(); i++) {
            Leg leg = journey.legs().get(i);
            if (leg.kind() != Leg.Kind.RIDE) {
                continue;
            }
            int limit = Capacity.limit(t, leg.trip(), fullAt);
            int first = t.tripTimeIndex(leg.trip(), 0);
            for (int position = leg.boardPosition(); position < leg.alightPosition(); position++) {
                if (loads[first + position] + group > limit) {
                    return i;
                }
            }
        }
        for (Leg leg : journey.legs()) {
            if (leg.kind() == Leg.Kind.RIDE) {
                int first = t.tripTimeIndex(leg.trip(), 0);
                for (int position = leg.boardPosition(); position < leg.alightPosition(); position++) {
                    loads[first + position] += group;
                }
            }
        }
        passengers += group;
        return -1;
    }

    public synchronized Summary summary() {
        int loadedCalls = 0;
        int fullCalls = 0;
        int tripsWithLoad = 0;
        int fullTrips = 0;
        double peak = 0;
        for (int trip = 0; trip < t.tripCount(); trip++) {
            int first = t.tripTimeIndex(trip, 0);
            int length = t.patternLength(t.tripPattern[trip]);
            int capacity = t.tripCapacity[trip];
            boolean any = false;
            boolean full = false;
            for (int position = 0; position < length; position++) {
                int load = loads[first + position];
                if (load > 0) {
                    loadedCalls++;
                    any = true;
                    if (load >= capacity) {
                        fullCalls++;
                        full = true;
                    }
                    if (capacity > 0) {
                        peak = Math.max(peak, (double) load / capacity);
                    }
                }
            }
            tripsWithLoad += any ? 1 : 0;
            fullTrips += full ? 1 : 0;
        }
        return new Summary(passengers, loadedCalls, fullCalls, tripsWithLoad, fullTrips, peak);
    }
}
