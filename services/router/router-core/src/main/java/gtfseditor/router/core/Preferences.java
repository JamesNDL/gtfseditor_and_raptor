package gtfseditor.router.core;

/**
 * How to choose among the journeys a search finds. The search itself finds the earliest arrival for
 * each number of rides; these settings decide which of those are worth showing and which one to
 * recommend. None of the figures is sourced; they are settings.
 *
 * <p>The recommended journey is the one with the lowest cost: its arrival time, plus
 * {@code changePenaltySecs} for each vehicle boarded, plus {@code walkCostPercent} per cent of the
 * time spent walking.
 *
 * <p>The earliest arrival often walks a long way to a faster line. So that there is something with
 * less walking to choose, the router can search a second time with shorter walks allowed, and offer
 * the best of that search if its cost is lower than anything from the first. That is off unless
 * asked for ({@link #lessWalking()}), because it slows queries.
 *
 * @param changePenaltySecs        an extra vehicle is worth boarding only if it gets the passenger
 *                                 there at least this much sooner
 * @param maxExtraSecsPerRideSaved a journey with fewer rides is offered only if it arrives no more
 *                                 than this much later for each ride it saves
 * @param walkCostPercent          extra cost of walking, as a percentage of the time walked: at 100
 *                                 a minute on foot counts as two
 * @param lessWalkEndSecs          the longest walk to the first stop or from the last in the second
 *                                 search; 0 for no second search
 * @param lessWalkLinkSecs         the longest walk between two stops in the second search
 */
public record Preferences(
        int changePenaltySecs,
        int maxExtraSecsPerRideSaved,
        int walkCostPercent,
        int lessWalkEndSecs,
        int lessWalkLinkSecs) {

    public Preferences {
        if (changePenaltySecs < 0 || maxExtraSecsPerRideSaved < 0 || walkCostPercent < 0 || lessWalkEndSecs < 0
                || lessWalkLinkSecs < 0) {
            throw new IllegalArgumentException("preferences cannot be negative");
        }
    }

    /** Preferences that do not care how much a journey walks. */
    public Preferences(int changePenaltySecs, int maxExtraSecsPerRideSaved) {
        this(changePenaltySecs, maxExtraSecsPerRideSaved, 0, 0, 0);
    }

    /**
     * Five minutes per extra vehicle; alternatives up to thirty minutes later per ride saved; a
     * minute on foot counts as two. One search: the second would make queries about half as slow
     * again.
     */
    public static Preferences defaults() {
        return new Preferences(300, 1800, 100, 0, 0);
    }

    /**
     * The defaults, and a second search that walks at most ten minutes at each end and four between
     * stops.
     */
    public static Preferences lessWalking() {
        return new Preferences(300, 1800, 100, 600, 240);
    }

    /** Every journey the one search finds, and the fastest recommended. */
    public static Preferences everything() {
        return new Preferences(0, Integer.MAX_VALUE / 16);
    }

    /** Whether these are the settings of {@link #everything()}, which drop no journey at all. */
    boolean keepsEverything() {
        return maxExtraSecsPerRideSaved == Integer.MAX_VALUE / 16;
    }

    /** What a journey costs under these preferences, in seconds. The lowest is recommended. */
    public long cost(Journey journey) {
        // Staying aboard a vehicle that runs on is not a boarding.
        int boardings = journey.rides() == 0 ? 0 : journey.changes() + 1;
        return journey.arrive() + (long) changePenaltySecs * boardings
                + (long) walkCostPercent * journey.walkSecs() / 100;
    }
}
