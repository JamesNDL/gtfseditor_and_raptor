package gtfseditor.router.core;

/**
 * For the {@link BackwardSearch}: trips the passenger may be aboard at their last stop because the
 * vehicle runs on into a trip they board at its first stop. A round offers them, and the next
 * round starts from them. Only the first round to offer a trip matters, since a later one would
 * use more rides for the same thing.
 */
final class RunOnOffers {

    private final boolean[] offered;  // per trip: offered in any round of this query
    private final int[] offeredTrips; // every trip offered, for clearing
    private int offeredCount;
    private int[] now;                // offered by the current round
    private int nowCount;
    private int[] before;             // offered by the round before, being taken up now

    RunOnOffers(int trips) {
        offered = new boolean[trips];
        offeredTrips = new int[trips];
        now = new int[trips];
        before = new int[trips];
    }

    /** Offers a trip to the next round, unless a round has already. */
    void offer(int trip) {
        if (!offered[trip]) {
            offered[trip] = true;
            offeredTrips[offeredCount++] = trip;
            now[nowCount++] = trip;
        }
    }

    /** Whether the current round has offered anything. */
    boolean pending() {
        return nowCount > 0;
    }

    /** Hands the current round's offers over to the next round: how many, read with {@link #taken}. */
    int take() {
        int[] swap = before;
        before = now;
        now = swap;
        int count = nowCount;
        nowCount = 0;
        return count;
    }

    /** One of the offers last handed over. */
    int taken(int i) {
        return before[i];
    }

    /** Clears what the last query offered, and only that. */
    void reset() {
        for (int i = 0; i < offeredCount; i++) {
            offered[offeredTrips[i]] = false;
        }
        offeredCount = 0;
        nowCount = 0;
    }
}
