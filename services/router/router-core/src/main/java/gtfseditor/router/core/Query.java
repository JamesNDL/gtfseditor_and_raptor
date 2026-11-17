package gtfseditor.router.core;

import java.util.EnumSet;
import java.util.List;
import java.util.Set;

/**
 * One journey question in the form the search works on. {@link Router#query} builds one from two
 * places; the simulator can build one directly to start from a given stop at a given time.
 *
 * <p>A journey is: one walk from {@code access}, then rides with at most one walking link between
 * consecutive rides, then one walk from {@code egress}. An entry with 0 seconds means the journey
 * starts or ends at that stop.
 *
 * @param access          the stops the journey may start from and the walk to each
 * @param egress          the stops the journey may end at and the walk from each
 * @param depart          when the passenger sets off, in seconds from the start of the service day
 * @param maxRides        most vehicles the passenger will board
 * @param directWalkSecs  time to walk the whole way with no ride, or -1 if that is not on offer
 * @param directWalkMetres straight-line distance of that walk
 * @param avoid           kinds of vehicle the passenger will not board
 * @param changeSecs      least time between getting off one vehicle and the next leaving from the
 *                        same stop. A walk to another stop takes the link's own time instead, and
 *                        staying aboard a vehicle that runs on as another trip takes none.
 * @param maxLinkSecs     the longest walk between two stops the passenger will make
 */
public record Query(
        List<Access> access,
        List<Access> egress,
        int depart,
        int maxRides,
        int directWalkSecs,
        int directWalkMetres,
        Set<Mode> avoid,
        int changeSecs,
        int maxLinkSecs) {

    /**
     * Two minutes. In 769 changes at one stop offered by the TfNSW trip planner for the test
     * journeys of section 18 of the plan, none was shorter.
     */
    public static final int DEFAULT_CHANGE_SECS = 120;

    public Query {
        access = List.copyOf(access);
        egress = List.copyOf(egress);
        avoid = avoid.isEmpty() ? Set.of() : Set.copyOf(EnumSet.copyOf(avoid));
        if (depart < 0) {
            throw new IllegalArgumentException("the departure time cannot be negative");
        }
        if (maxRides < 1) {
            throw new IllegalArgumentException("a journey needs at least one ride");
        }
        if (changeSecs < 0 || maxLinkSecs < 0) {
            throw new IllegalArgumentException("the time to change and the longest walk cannot be negative");
        }
    }

    /** A query that will walk any link between two stops. */
    public Query(List<Access> access, List<Access> egress, int depart, int maxRides, int directWalkSecs,
            int directWalkMetres, Set<Mode> avoid, int changeSecs) {
        this(access, egress, depart, maxRides, directWalkSecs, directWalkMetres, avoid, changeSecs,
                Integer.MAX_VALUE);
    }

    /** A query with the usual time to change. */
    public Query(List<Access> access, List<Access> egress, int depart, int maxRides, int directWalkSecs,
            int directWalkMetres, Set<Mode> avoid) {
        this(access, egress, depart, maxRides, directWalkSecs, directWalkMetres, avoid, DEFAULT_CHANGE_SECS);
    }

    /** A query that avoids no kind of vehicle. */
    public Query(List<Access> access, List<Access> egress, int depart, int maxRides, int directWalkSecs,
            int directWalkMetres) {
        this(access, egress, depart, maxRides, directWalkSecs, directWalkMetres, Set.of());
    }

    /** The same query, refusing these kinds of vehicle. */
    public Query avoiding(Set<Mode> modes) {
        return new Query(access, egress, depart, maxRides, directWalkSecs, directWalkMetres, modes, changeSecs, maxLinkSecs);
    }

    /** The same query with a different least time to change at one stop. */
    public Query withChangeSecs(int secs) {
        return new Query(access, egress, depart, maxRides, directWalkSecs, directWalkMetres, avoid, secs, maxLinkSecs);
    }

    /**
     * The same query with shorter walks: none to the first stop or from the last longer than
     * {@code endSecs}, and none between two stops longer than {@code linkSecs}.
     */
    public Query withWalksUpTo(int endSecs, int linkSecs) {
        return new Query(access.stream().filter(a -> a.secs() <= endSecs).toList(),
                egress.stream().filter(a -> a.secs() <= endSecs).toList(), depart, maxRides,
                directWalkSecs <= endSecs ? directWalkSecs : -1, directWalkMetres, avoid, changeSecs,
                Math.min(linkSecs, maxLinkSecs));
    }
}
