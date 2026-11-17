package gtfseditor.router.core;

import java.util.Arrays;

/**
 * What stops a passenger boarding in one search: how full the vehicles are, and boardings this
 * passenger has been refused. See sections 4.2 and 4.4 of docs/router-plan.md.
 *
 * <p>A trip is passed over at a stop when the passengers already aboard as it leaves, plus this
 * group, would be more than it holds; the search takes the next trip with room. A passenger who
 * is aboard a vehicle that runs on as another trip stays aboard whatever that trip's load.
 */
public final class Capacity {

    /** Loads are ignored and nothing is blocked. */
    public static final Capacity OFF = new Capacity(null, 1.0, 1, new int[0]);

    private final LoadState loads;
    private final double fullAt;
    private final int group;
    private final int[] blocked; // places in the timetable's stop times, in order

    private Capacity(LoadState loads, double fullAt, int group, int[] blocked) {
        if (!(fullAt > 0) || fullAt > 10) {
            throw new IllegalArgumentException("fullAt must be above 0, and is usually 1");
        }
        if (group < 1) {
            throw new IllegalArgumentException("a group is at least one passenger");
        }
        this.loads = loads;
        this.fullAt = fullAt;
        this.group = group;
        this.blocked = blocked;
    }

    /** One passenger, and a trip is full when it holds its capacity. */
    public static Capacity of(LoadState loads) {
        return new Capacity(loads, 1.0, 1, new int[0]);
    }

    /**
     * @param loads  the loads to respect, or null to respect none
     * @param fullAt the share of its capacity at which a trip counts as full; for example the share
     *               that is seats, to plan as if nobody stands
     * @param group  how many passengers travel together
     */
    public static Capacity of(LoadState loads, double fullAt, int group) {
        return new Capacity(loads, fullAt, group, new int[0]);
    }

    /** The same, with one more boarding refused: this trip at this position along it. */
    public Capacity blocking(Timetable t, int trip, int position) {
        int index = t.tripTimeIndex(trip, position);
        if (Arrays.binarySearch(blocked, index) >= 0) {
            return this;
        }
        int[] more = Arrays.copyOf(blocked, blocked.length + 1);
        more[blocked.length] = index;
        Arrays.sort(more);
        return new Capacity(loads, fullAt, group, more);
    }

    public LoadState loads() {
        return loads;
    }

    public double fullAt() {
        return fullAt;
    }

    public int group() {
        return group;
    }

    /** Whether this can stop anyone boarding anything. */
    public boolean limited() {
        return loads != null || blocked.length > 0;
    }

    int[] blocked() {
        return blocked;
    }

    /** Whether this group may board a trip at a position along it. */
    public boolean boardable(Timetable t, int trip, int position) {
        int index = t.tripTimeIndex(trip, position);
        if (blocked.length > 0 && Arrays.binarySearch(blocked, index) >= 0) {
            return false;
        }
        return loads == null || loads.array()[index] + group <= limit(t, trip, fullAt);
    }

    /** The most passengers a trip may carry when it counts as full at a share of its capacity. */
    public static int limit(Timetable t, int trip, double fullAt) {
        return fullAt == 1.0 ? t.tripCapacity[trip] : (int) Math.floor(t.tripCapacity[trip] * fullAt);
    }
}
