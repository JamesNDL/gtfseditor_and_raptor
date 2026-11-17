package gtfseditor.router.core;

import java.util.List;

/**
 * How full one ride of a journey is, for showing beside it. See section 4.3 of docs/router-plan.md.
 *
 * @param peakLoad    the most passengers aboard on any part of the ride, as the loads now stand
 * @param capacity    what the vehicle holds
 * @param placeholder whether that capacity is a placeholder figure, not a sourced one
 * @param skippedFull trips of the same line passed over because they were full: those that left
 *                    the boarding stop between when the passenger could first board there and when
 *                    they did
 */
public record Crowding(int peakLoad, int capacity, boolean placeholder, int skippedFull) {

    /** The peak load as a share of capacity. */
    public double peakFactor() {
        return capacity <= 0 ? 0 : (double) peakLoad / capacity;
    }

    /**
     * @param leg      which leg of the journey; it must be a ride
     * @param capacity the loads and group the journey was planned with
     */
    public static Crowding of(Timetable t, Query q, Journey journey, int leg, Capacity capacity) {
        List<Leg> legs = journey.legs();
        Leg ride = legs.get(leg);
        LoadState loads = capacity.loads();
        int trip = ride.trip();
        int peak = 0;
        for (int position = ride.boardPosition(); position < ride.alightPosition(); position++) {
            peak = Math.max(peak, loads.load(trip, position));
        }

        // When the passenger could first have boarded here.
        int ready;
        Leg before = leg == 0 ? null : legs.get(leg - 1);
        if (before == null) {
            ready = q.depart();
        } else if (before.kind() == Leg.Kind.WALK) {
            ready = q.depart() + before.arrive() - before.depart();
        } else if (before.kind() == Leg.Kind.TRANSFER) {
            ready = before.arrive();
        } else {
            ready = ride.stayAboard() ? Integer.MAX_VALUE : before.arrive() + q.changeSecs();
        }
        int skipped = 0;
        int pattern = t.tripPattern[trip];
        int limit = Capacity.limit(t, trip, capacity.fullAt());
        for (int other = t.patternTripOffset[pattern]; other < trip; other++) {
            if (t.depart[t.tripTimeIndex(other, ride.boardPosition())] >= ready
                    && loads.load(other, ride.boardPosition()) + capacity.group() > limit) {
                skipped++;
            }
        }
        return new Crowding(peak, t.tripCapacity[trip],
                (t.tripCapacityFlags[trip] & Timetable.CAPACITY_PLACEHOLDER) != 0, skipped);
    }
}
