package gtfseditor.router.core;

import static gtfseditor.router.core.BackwardTimes.NONE;

import java.util.Arrays;
import java.util.List;

/**
 * The backward RAPTOR search behind arrive-by journeys. One of these belongs to one thread; the
 * {@link Router} hands them out. See the arrive-by section of docs/router-plan.md.
 *
 * <p>It is {@link Search} run the other way: from the end of the journey back in time, latest
 * first. Round k finds, for every stop, the latest time the passenger may board there and still
 * arrive by the time asked for using at most k rides. It keeps two times per stop
 * ({@link BackwardTimes}), mirroring the forward search's two arrivals:
 *
 * <ul>
 *   <li>the latest time to get off a vehicle there: from the walk to the end of the journey, or
 *       from a later boarding there or one walking link away, less the time to change;
 *   <li>the latest time to board there: from a ride to a stop whose time to get off it makes.
 * </ul>
 *
 * <p>The rules are the forward search's: the time to change, at one stop or with a walk, the
 * longest walk between stops, the kinds of vehicle avoided, and staying aboard a vehicle that runs
 * on as another trip. Loads are not looked at. It finds the departure only; the journey itself is
 * then planned forwards from it ({@link ArriveBy}).
 *
 * <p>Many queries that share their end and settings share one search: each takes the latest
 * boarding time at its own first stops less its walk to them. The search stops looking at a stop
 * once its time is no later than every query's best departure so far.
 */
final class BackwardSearch {

    private final Timetable t;
    private final BackwardLinks links;
    private final int maxRides;
    private final BackwardTimes times;
    private final RunOnOffers offers;

    private final int[] patternFrom;   // lowest position of a queued pattern to get off at, or -1
    private final int[] patternTo;     // highest such position
    private final int[] patternAboard; // per pattern: the latest of its trips on offer this round, or -1
    private final int[] queue;
    private int queueCount;

    private int changeSecs;
    private int floor; // the earliest of the queries' best departures so far, or NONE

    BackwardSearch(Timetable t, BackwardLinks links, int maxRides) {
        this.t = t;
        this.links = links;
        this.maxRides = maxRides;
        times = new BackwardTimes(t.stopCount());
        offers = new RunOnOffers(t.tripCount());
        patternFrom = new int[t.patternCount()];
        Arrays.fill(patternFrom, -1);
        patternTo = new int[t.patternCount()];
        patternAboard = new int[t.patternCount()];
        Arrays.fill(patternAboard, -1);
        queue = new int[t.patternCount()];
    }

    /**
     * The latest departure of each query that arrives by {@code arriveBy}, or -1 where there is
     * none. The queries must share their egress, rides, kinds of vehicle avoided, time to change
     * and longest walk; the caller has checked. Their departure times are not looked at.
     */
    int[] run(List<Query> queries, int arriveBy) {
        times.reset();
        offers.reset();
        Query shape = queries.get(0);
        int rounds = Math.min(shape.maxRides(), maxRides);
        changeSecs = shape.changeSecs();
        int avoid = 0;
        for (Mode mode : shape.avoid()) {
            avoid |= 1 << mode.ordinal();
        }
        int[] best = new int[queries.size()];
        for (int i = 0; i < best.length; i++) {
            int direct = queries.get(i).directWalkSecs();
            best[i] = direct >= 0 ? arriveBy - direct : NONE;
        }
        floor = lowest(best);
        for (Access e : shape.egress()) {
            times.improveAlight(e.stop(), arriveBy - e.secs(), floor);
        }

        for (int round = 1; round <= rounds && (times.alightImproved() || offers.pending()); round++) {
            queuePatterns();
            for (int i = 0; i < queueCount; i++) {
                int pattern = queue[i];
                if ((avoid >> t.patternMode[pattern] & 1) == 0) {
                    scan(pattern);
                }
                patternFrom[pattern] = -1;
                patternAboard[pattern] = -1;
            }
            queueCount = 0;
            times.endRides();
            walkBack(shape.maxLinkSecs());
            for (int i = 0; i < best.length; i++) {
                for (Access a : queries.get(i).access()) {
                    if (times.board[a.stop()] != NONE) {
                        best[i] = Math.max(best[i], times.board[a.stop()] - a.secs());
                    }
                }
            }
            floor = lowest(best);
        }
        for (int i = 0; i < best.length; i++) {
            best[i] = best[i] == NONE || best[i] < 0 ? -1 : best[i];
        }
        return best;
    }

    private static int lowest(int[] values) {
        int lowest = Integer.MAX_VALUE;
        for (int value : values) {
            lowest = Math.min(lowest, value);
        }
        return values.length == 0 ? NONE : lowest;
    }

    /**
     * Queues every pattern that passes a stop whose time to get off improved in the last round
     * (and is still worth looking at), from the highest such position along it, and every pattern
     * with a trip on offer to stay aboard.
     */
    private void queuePatterns() {
        int count = times.startRound(floor);
        for (int i = 0; i < count; i++) {
            int stop = times.alighting(i);
            if (times.ready[stop] == NONE) {
                continue; // nothing through here can beat a departure every query has already
            }
            for (int j = t.stopPatternOffset[stop]; j < t.stopPatternOffset[stop + 1]; j++) {
                int pattern = t.stopPatterns[j];
                int position = t.stopPatternPositions[j];
                if (position > 0 && (t.patternStopFlags[t.patternStopOffset[pattern] + position] & Timetable.ALIGHT) != 0) {
                    queue(pattern, position);
                }
            }
        }
        int offered = offers.take();
        for (int i = 0; i < offered; i++) {
            int trip = offers.taken(i);
            int pattern = t.tripPattern[trip];
            queue(pattern, t.patternLength(pattern) - 1);
            patternAboard[pattern] = Math.max(patternAboard[pattern], trip - t.patternTripOffset[pattern]);
        }
    }

    private void queue(int pattern, int position) {
        if (patternFrom[pattern] < 0) {
            queue[queueCount++] = pattern;
            patternFrom[pattern] = position;
            patternTo[pattern] = position;
        } else {
            patternFrom[pattern] = Math.min(patternFrom[pattern], position);
            patternTo[pattern] = Math.max(patternTo[pattern], position);
        }
    }

    /**
     * Rides back along one pattern from its highest queued position, keeping the latest trip that
     * gets the passenger to a stop ahead in time, and recording where boarding it is later than
     * anything before.
     */
    private void scan(int pattern) {
        int stopBase = t.patternStopOffset[pattern];
        int timeBase = t.patternTimeOffset[pattern];
        int tripCount = t.patternTripCount(pattern);
        int length = t.patternLength(pattern);
        int from = patternFrom[pattern];
        int trip = -1; // the trip the passenger is on, as its place in the pattern
        for (int position = patternTo[pattern]; position >= 0; position--) {
            if (position < from && trip < 0) {
                break; // no stop below to get off at, and no trip to board
            }
            int call = t.patternCalls[stopBase + position];
            int stop = call >> 2;
            if (trip >= 0 && (call & Timetable.BOARD) != 0) {
                int depart = t.depart[timeBase + trip * length + position];
                if (depart > floor) {
                    times.improveBoard(stop, depart);
                    if (position == 0 && links.patternRunsOn()[pattern]) {
                        offerRunsFrom(pattern, trip, depart);
                    }
                }
            }
            if (position > 0 && (call & Timetable.ALIGHT) != 0) {
                int ready = times.ready[stop];
                if (ready != NONE) {
                    trip = latestTrip(timeBase, length, tripCount, position, ready, trip);
                }
                if (position == length - 1 && patternAboard[pattern] > trip) {
                    trip = patternAboard[pattern];
                }
            }
        }
    }

    /**
     * The latest of a pattern's trips after {@code after} that reaches a position by a time, or
     * {@code after} if none does. Trips in a pattern never overtake, so their arrivals at any one
     * stop are in order.
     */
    private int latestTrip(int timeBase, int length, int tripCount, int position, int by, int after) {
        int low = after + 1;
        int high = tripCount - 1;
        if (low > high || t.arrive[timeBase + low * length + position] > by) {
            return after;
        }
        while (low < high) {
            int middle = (low + high + 1) >>> 1;
            if (t.arrive[timeBase + middle * length + position] <= by) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return low;
    }

    /**
     * The passenger boards trip {@code trip} at the pattern's first stop, at {@code depart}. They
     * could instead already be aboard: on a trip whose vehicle runs on into this one, or into an
     * earlier trip of the pattern, which gets them everywhere sooner. Those are offered to the next
     * round. A trip that reaches its last stop by {@code depart} less the time to change need not
     * be: getting off and boarding again there is already allowed for. This mirrors the forward
     * search, and relies on what the loader guarantees of a vehicle that runs on: it does so from
     * the stop where it ends, and leaves no sooner than it arrives.
     */
    private void offerRunsFrom(int pattern, int trip, int depart) {
        int tripBase = t.patternTripOffset[pattern];
        int timeBase = t.patternTimeOffset[pattern];
        int length = t.patternLength(pattern);
        int[] offset = links.runsFromOffset();
        for (int earlier = trip; earlier >= 0; earlier--) {
            int leaves = t.depart[timeBase + earlier * length];
            if (earlier < trip && (leaves <= depart - changeSecs || leaves <= floor)) {
                break;
            }
            for (int k = offset[tripBase + earlier]; k < offset[tripBase + earlier + 1]; k++) {
                int before = links.runsFrom()[k];
                int last = t.patternStopOffset[t.tripPattern[before] + 1] - 1;
                if ((t.patternStopFlags[last] & Timetable.ALIGHT) != 0) {
                    offers.offer(before);
                }
            }
        }
    }

    /**
     * From each stop boarded later in this round: the passenger may have got off a vehicle at the
     * same stop the time to change before, or at a stop one walking link away the walk (and never
     * less than the time to change) before.
     */
    private void walkBack(int maxLink) {
        for (int i = 0; i < times.boardedCount(); i++) {
            int stop = times.boarded(i);
            int board = times.board[stop];
            times.improveAlight(stop, board - changeSecs, floor);
            for (int j = links.linkInOffset()[stop]; j < links.linkInOffset()[stop + 1]; j++) {
                int secs = links.linkInSecs()[j];
                if (secs <= maxLink) {
                    times.improveAlight(links.linkInFrom()[j], board - Math.max(secs, changeSecs), floor);
                }
            }
        }
        times.clearBoarded();
    }
}
