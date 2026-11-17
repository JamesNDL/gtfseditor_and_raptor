package gtfseditor.router.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The RAPTOR search and the working memory it needs. One of these belongs to one thread; the
 * {@link Router} hands them out. See section 4.1 of docs/router-plan.md.
 *
 * <p>The search runs in rounds: round k finds the earliest arrival at every stop using exactly k
 * rides. Each stop keeps two arrival times per round, because they allow different next steps:
 *
 * <ul>
 *   <li>arrived on a vehicle: the passenger may walk a link to another stop, walk to the end of the
 *       journey, or board again here;
 *   <li>arrived on foot: the passenger may only board, because two walks in a row are not allowed.
 * </ul>
 *
 * <p>The walking links of a feed do not chain (A to B and B to C does not give A to C), so the two
 * cannot be merged into one number without losing journeys.
 *
 * <p>Changing vehicles at one stop takes the query's {@code changeSecs}; a walk to another stop
 * takes the link's own time. A vehicle that runs on as another trip takes no time at all, and is
 * handled apart from the stops: a trip ridden to its last stop in one round offers its next trip
 * from that trip's first stop in the next round.
 */
final class Search {

    private static final int NONE = Integer.MAX_VALUE;

    // Places within a stop's four numbers in {@link #state}. They sit together so that looking at
    // a stop while scanning a pattern touches one piece of memory, not four.
    private static final int BEST_RIDE = 0; // earliest arrival on a vehicle, any round so far
    private static final int READY = 1;     // when the passenger can board here in this round, or NONE
    private static final int BEST_ANY = 2;  // earliest the passenger can board here, any round so far:
                                            // an arrival on foot, or one on a vehicle plus the time to change
    private static final int ROUNDS = 3;    // one bit per round that wrote an arrival for this stop

    private final Timetable t;
    private final int slots; // rounds a stop keeps arrival times for: 0 (no ride yet) to the most rides

    private final int[] state; // four numbers per stop, see above

    // Five numbers per stop and round in {@link #labels}, starting at (stop * slots + round) * 5.
    // They sit together for the same reason.
    private static final int RIDE_ARRIVE = 0;    // arrival on a vehicle in this round
    private static final int RIDE_TRIP = 1;      // the trip ridden
    private static final int RIDE_POSITIONS = 2; // boarding position * 65536 + alighting position
    private static final int WALK_ARRIVE = 3;    // arrival on foot in this round
    private static final int WALK_FROM = 4;      // the stop walked from, or -1 - (index of the access walk)

    private final int[] labels;

    private final int[] egressSecs;
    private final int[] egressIndex;
    private final int[] egressStops;
    private int egressCount;

    private final boolean[] touched;
    private final int[] touchedStops;
    private int touchedCount;

    private final boolean[] marked;     // reached earlier than before in the current round
    private int[] markedStops;
    private int markedCount;
    private int[] boardingStops;        // the stops marked in the previous round
    private final boolean[] rideMarked; // reached on a vehicle in the current round
    private final int[] rideMarkedStops;
    private int rideMarkedCount;

    private final int[] patternFrom;    // first position to scan a queued pattern from
    private final int[] patternTo;      // last position of a queued pattern the passenger can board at
    private final int[] queue;
    private int queueCount;

    // The earliest trip of each pattern already ridden in this query, and the position it was
    // boarded at. Riding the same trip or a later one from the same stop or further along can only
    // repeat arrivals an earlier round has recorded, so the search does not.
    private final int[] riddenTrip;
    private final int[] riddenFrom;
    private final int[] riddenPatterns;
    private int riddenCount;

    // Trips the passenger can be aboard at their first stop because the vehicle ran on from a trip
    // they rode to its end. Only the first round to offer a trip matters.
    private final int[] aboardRound;   // per trip: the round whose ride ended in it, or NONE
    private final int[] aboardTrip;    // per trip: the trip ridden into it
    private final int[] aboardBoarded; // per trip: where that trip was boarded
    private final int[] aboardTrips;   // every trip with an entry above, for clearing
    private int aboardCount;
    private int[] aboardNow;           // trips offered by the current round
    private int aboardNowCount;
    private int[] aboardBefore;        // trips offered by the round before
    private final int[] patternAboard; // per pattern: the earliest of its trips on offer in this round, or NONE

    private int changeSecs; // the query's
    private Capacity capacity; // what may stop the passenger boarding
    private boolean limited;   // whether anything may
    private int[] loads;       // the capacity's numbers, or null: passengers aboard, in step with the stop times
    private int[] refused;     // the capacity's refused boardings: places in the stop times, in order
    private int group;
    private double fullAt;

    // With loads, a pattern any of whose vehicles runs on as another trip needs more care: see scan.
    private final boolean[] runsOn;        // per pattern
    private final int[] readyPositions;    // where along the pattern being scanned the passenger could board
    private int target; // earliest arrival at the end of the journey found so far

    Search(Timetable t, int maxRides) {
        if (maxRides > 30) {
            throw new IllegalArgumentException("the search keeps at most 30 rides");
        }
        for (int p = 0; p < t.patternCount(); p++) {
            if (t.patternLength(p) > 0xffff) {
                throw new IllegalArgumentException("a pattern has more stops than the search can number");
            }
        }
        this.t = t;
        this.slots = maxRides + 1;
        int stops = t.stopCount();
        state = new int[stops * 4];
        for (int stop = 0; stop < stops; stop++) {
            state[stop * 4 + BEST_RIDE] = NONE;
            state[stop * 4 + READY] = NONE;
            state[stop * 4 + BEST_ANY] = NONE;
        }
        labels = new int[stops * slots * 5];
        for (int slot = 0; slot < stops * slots; slot++) {
            labels[slot * 5 + RIDE_ARRIVE] = NONE;
            labels[slot * 5 + WALK_ARRIVE] = NONE;
        }
        egressSecs = filled(stops);
        egressIndex = new int[stops];
        egressStops = new int[stops];
        touched = new boolean[stops];
        touchedStops = new int[stops];
        marked = new boolean[stops];
        markedStops = new int[stops];
        boardingStops = new int[stops];
        rideMarked = new boolean[stops];
        rideMarkedStops = new int[stops];
        patternFrom = filled(t.patternCount());
        patternTo = new int[t.patternCount()];
        queue = new int[t.patternCount()];
        riddenTrip = filled(t.patternCount());
        riddenFrom = new int[t.patternCount()];
        riddenPatterns = new int[t.patternCount()];
        aboardRound = filled(t.tripCount());
        aboardTrip = new int[t.tripCount()];
        aboardBoarded = new int[t.tripCount()];
        aboardTrips = new int[t.tripCount()];
        aboardNow = new int[t.tripCount()];
        aboardBefore = new int[t.tripCount()];
        patternAboard = filled(t.patternCount());
        runsOn = new boolean[t.patternCount()];
        int longest = 0;
        for (int p = 0; p < t.patternCount(); p++) {
            longest = Math.max(longest, t.patternLength(p));
        }
        for (int trip = 0; trip < t.tripCount(); trip++) {
            runsOn[t.tripPattern[trip]] |= t.tripStayAboard[trip] >= 0;
        }
        readyPositions = new int[longest];
    }

    private static int[] filled(int length) {
        int[] array = new int[length];
        Arrays.fill(array, NONE);
        return array;
    }

    Result run(Query q, Preferences preferences) {
        return run(q, preferences, Capacity.OFF);
    }

    /**
     * @param capacity the loads to respect and the boardings refused. A trip the passenger may not
     *                 board at a stop is passed over there, and the next one with room is taken.
     */
    Result run(Query q, Preferences preferences, Capacity capacity) {
        long started = System.nanoTime();
        reset();
        this.capacity = capacity;
        this.limited = capacity.limited();
        this.loads = capacity.loads() == null ? null : capacity.loads().array();
        this.refused = capacity.blocked();
        this.group = capacity.group();
        this.fullAt = capacity.fullAt();
        int rounds = Math.min(q.maxRides(), slots - 1);
        int depart = q.depart();
        changeSecs = q.changeSecs();
        int maxLink = q.maxLinkSecs();
        target = q.directWalkSecs() >= 0 ? depart + q.directWalkSecs() : NONE;
        int avoid = 0;
        for (Mode mode : q.avoid()) {
            avoid |= 1 << mode.ordinal();
        }

        List<Access> egress = q.egress();
        for (int i = 0; i < egress.size(); i++) {
            Access e = egress.get(i);
            if (e.secs() < egressSecs[e.stop()]) {
                if (egressSecs[e.stop()] == NONE) {
                    egressStops[egressCount++] = e.stop();
                }
                egressSecs[e.stop()] = e.secs();
                egressIndex[e.stop()] = i;
            }
        }
        List<Access> access = q.access();
        for (int i = 0; i < access.size(); i++) {
            Access a = access.get(i);
            int time = depart + a.secs();
            if (time < state[a.stop() * 4 + BEST_ANY]) {
                touch(a.stop(), 0);
                labels[(a.stop() * slots) * 5 + WALK_ARRIVE] = time;
                labels[(a.stop() * slots) * 5 + WALK_FROM] = -1 - i;
                state[a.stop() * 4 + BEST_ANY] = time;
                mark(a.stop());
            }
        }

        int[] endStop = new int[rounds + 1]; // the stop the best journey of each round ends its last ride at
        Arrays.fill(endStop, -1);
        int ran = 0;
        int scanned = 0;
        for (int round = 1; round <= rounds && (markedCount > 0 || aboardNowCount > 0); round++) {
            ran = round;
            // The stops reached earlier in the last round are the only ones worth boarding at: at any
            // other stop the passenger would catch the trips an earlier round already rode. Queue
            // every pattern through one of them, from the first such stop along it.
            int[] swap = boardingStops;
            boardingStops = markedStops;
            markedStops = swap;
            int boardingCount = markedCount;
            markedCount = 0;
            for (int i = 0; i < boardingCount; i++) {
                int stop = boardingStops[i];
                marked[stop] = false;
                if (state[stop * 4 + BEST_ANY] >= target) {
                    continue; // a quicker way to the end has turned up since; nothing from here can beat it
                }
                int ready = state[stop * 4 + BEST_ANY];
                state[stop * 4 + READY] = ready;
                for (int j = t.stopPatternOffset[stop] * 2; j < t.stopPatternOffset[stop + 1] * 2; j += 2) {
                    if (t.stopVisitLastDepart[j >> 1] < ready) {
                        continue; // the pattern's last trip has left here already, or nobody boards here
                    }
                    int pattern = t.stopVisits[j];
                    int position = t.stopVisits[j + 1];
                    int known = riddenTrip[pattern];
                    if (known != NONE && riddenFrom[pattern] <= position && !(limited && runsOn[pattern])
                            && (known == 0 || t.departByPosition[t.patternHead[pattern * 4 + 1]
                                    + position * t.patternHead[pattern * 4 + 3] + known - 1] < ready)) {
                        // The trip to catch here is one an earlier round rode from here or before, or
                        // a later one. The scan would pass it over, so the stop need not queue it.
                        continue;
                    }
                    int first = patternFrom[pattern];
                    if (first == NONE) {
                        queue[queueCount++] = pattern;
                        patternFrom[pattern] = position;
                        patternTo[pattern] = position;
                    } else if (position < first) {
                        patternFrom[pattern] = position;
                    } else if (position > patternTo[pattern]) {
                        patternTo[pattern] = position;
                    }
                }
            }

            // And every pattern with a trip the passenger is already aboard.
            int[] swapAboard = aboardBefore;
            aboardBefore = aboardNow;
            aboardNow = swapAboard;
            int aboardBeforeCount = aboardNowCount;
            aboardNowCount = 0;
            for (int i = 0; i < aboardBeforeCount; i++) {
                int trip = aboardBefore[i];
                int pattern = t.tripPattern[trip];
                if (t.depart[t.tripTimeIndex(trip, 0)] >= target) {
                    continue;
                }
                if (patternFrom[pattern] == NONE) {
                    queue[queueCount++] = pattern;
                    patternTo[pattern] = 0;
                }
                patternFrom[pattern] = 0;
                patternAboard[pattern] = Math.min(patternAboard[pattern], trip - t.patternTripOffset[pattern]);
            }

            for (int i = 0; i < queueCount; i++) {
                int pattern = queue[i];
                if ((avoid >> t.patternMode[pattern] & 1) == 0) {
                    int end = scan(pattern, patternFrom[pattern], patternTo[pattern], round);
                    if (end >= 0) {
                        endStop[round] = end;
                    }
                    scanned++;
                }
                patternFrom[pattern] = NONE;
                patternAboard[pattern] = NONE;
            }
            queueCount = 0;
            for (int i = 0; i < boardingCount; i++) {
                state[boardingStops[i] * 4 + READY] = NONE;
            }

            // One walk onward from each stop reached on a vehicle in this round.
            for (int i = 0; i < rideMarkedCount; i++) {
                int stop = rideMarkedStops[i];
                rideMarked[stop] = false;
                int arrived = labels[(stop * slots + round) * 5 + RIDE_ARRIVE];
                if (arrived >= target) {
                    continue;
                }
                for (int j = t.transferOffset[stop] * 2; j < t.transferOffset[stop + 1] * 2; j += 2) {
                    int to = t.transferLinks[j];
                    int secs = t.transferLinks[j + 1];
                    if (secs > maxLink) {
                        continue;
                    }
                    int time = arrived + secs;
                    if (time < state[to * 4 + BEST_ANY] && time < target) {
                        touch(to, round);
                        labels[(to * slots + round) * 5 + WALK_ARRIVE] = time;
                        labels[(to * slots + round) * 5 + WALK_FROM] = stop;
                        state[to * 4 + BEST_ANY] = time;
                        mark(to);
                    }
                }
            }
            rideMarkedCount = 0;
        }

        List<Journey> found = new ArrayList<>();
        if (q.directWalkSecs() >= 0) {
            found.add(Journey.of(depart, List.of(Leg.walk(Leg.Kind.WALK, -1, -1, depart,
                    depart + q.directWalkSecs(), q.directWalkMetres()))));
        }
        for (int round = 1; round <= ran; round++) {
            if (endStop[round] >= 0) {
                found.add(journey(q, endStop[round], round));
            }
        }
        // Each round's journey arrives earlier than every one before it, so the last is the fastest.
        Collections.reverse(found);
        return choose(found, preferences, ran, scanned, started);
    }

    /** Drops alternatives that are too much slower, names the rest and picks the one to recommend. */
    private static Result choose(List<Journey> found, Preferences preferences, int ran, int scanned, long started) {
        List<Journey> journeys = new ArrayList<>();
        int recommended = -1;
        long lowest = Long.MAX_VALUE;
        for (Journey journey : found) {
            if (!journeys.isEmpty()) {
                Journey fastest = journeys.get(0);
                long allowed = (long) preferences.maxExtraSecsPerRideSaved() * (boardings(fastest) - boardings(journey));
                // A journey that saves no boarding, because the fastest stays aboard a vehicle that runs
                // on, has nothing to offer; it goes unless everything was asked for.
                if (journey.arrive() - fastest.arrive() > allowed && !preferences.keepsEverything()) {
                    continue;
                }
            }
            long cost = preferences.cost(journey);
            if (cost < lowest) {
                lowest = cost;
                recommended = journeys.size();
            }
            journeys.add(journey.labelled(journey.rides() == 0 ? "walk" : journeys.isEmpty() ? "fastest" : "fewerChanges"));
        }
        return new Result(journeys.isEmpty() ? Result.Status.NO_JOURNEY : Result.Status.OK, journeys, recommended,
                ran, scanned, System.nanoTime() - started);
    }

    /** How many times the passenger gets onto a vehicle; staying aboard a vehicle that runs on is not one. */
    private static int boardings(Journey journey) {
        return journey.rides() == 0 ? 0 : journey.changes() + 1;
    }

    /**
     * Rides along one pattern from a position, boarding the earliest trip that can be caught at
     * each stop and recording where it gets the passenger sooner than anything before.
     *
     * @param lastBoarding the last position at which the passenger may board in this round
     * @return the stop at which this scan found the best end of the whole journey so far, or -1
     */
    private int scan(int pattern, int from, int lastBoarding, int round) {
        int stopBase = t.patternHead[pattern * 4];
        int timeBase = t.patternHead[pattern * 4 + 1];
        int tripBase = t.patternHead[pattern * 4 + 2];
        int tripCount = t.patternHead[pattern * 4 + 3];
        int length = t.patternHead[pattern * 4 + 4] - stopBase;
        int trip = -1;     // the trip the passenger is on, as its place in the pattern
        int tripTimes = 0; // where that trip's times start
        int boarded = -1;  // the position they boarded at
        int end = -1;
        // Without loads, a trip the passenger could board at one stop they could board at every
        // later one, and whatever an earlier round rode need not be ridden again. With loads
        // neither holds for a vehicle that runs on: a later trip may have room only further along,
        // and staying aboard it may be the only way onto a full trip. For those patterns nothing is
        // skipped, and every place the passenger could board is kept for offerNextTrips.
        boolean wide = limited && runsOn[pattern];
        int readyCount = 0;
        for (int position = from; position < length; position++) {
            // Past the last stop worth boarding at, the passenger stays on the trip they are on. If
            // they are on none, or it is already too late to be of use, the rest cannot matter:
            // a trip only gets later as it goes.
            if (position > lastBoarding && (trip < 0 || t.arrive[tripTimes + position] >= target)) {
                break;
            }
            int call = t.patternCalls[stopBase + position];
            int flags = call & 3;
            int at = call - flags; // the stop's place in the state: stop * 4
            int stop = at >> 2;
            if (trip >= 0 && (flags & Timetable.ALIGHT) != 0) {
                int time = t.arrive[tripTimes + position];
                if (time < state[at + BEST_RIDE] && time < target) {
                    touch(stop, round);
                    int slot = stop * slots + round;
                    labels[(slot) * 5 + RIDE_ARRIVE] = time;
                    labels[(slot) * 5 + RIDE_TRIP] = tripBase + trip;
                    labels[(slot) * 5 + RIDE_POSITIONS] = (boarded << 16) | position;
                    state[at + BEST_RIDE] = time;
                    if (!rideMarked[stop]) {
                        rideMarked[stop] = true;
                        rideMarkedStops[rideMarkedCount++] = stop;
                    }
                    if (time + changeSecs < state[at + BEST_ANY]) {
                        state[at + BEST_ANY] = time + changeSecs;
                        mark(stop);
                    }
                    if (egressSecs[stop] != NONE && time + egressSecs[stop] < target) {
                        target = time + egressSecs[stop];
                        end = stop;
                    }
                }
            }
            if (position == length - 1) {
                if (trip >= 0 && (flags & Timetable.ALIGHT) != 0) {
                    offerNextTrips(tripBase, timeBase, tripCount, length, trip, boarded, round,
                            wide ? readyCount : -1, stopBase);
                }
                break;
            }
            if (position == 0 && patternAboard[pattern] != NONE && (flags & Timetable.BOARD) != 0) {
                // The passenger is on this vehicle already: it ran on from the trip they were riding.
                int aboard = patternAboard[pattern];
                int known = riddenTrip[pattern];
                if (wide || known > aboard || riddenFrom[pattern] > 0) {
                    trip = aboard;
                    tripTimes = timeBase + trip * length;
                    boarded = 0;
                    if (known == NONE) {
                        riddenPatterns[riddenCount++] = pattern;
                    }
                    if (known == NONE || trip <= known) {
                        riddenTrip[pattern] = trip;
                        riddenFrom[pattern] = 0;
                    }
                }
            }
            int ready = state[at + READY];
            if (ready != NONE && (flags & Timetable.BOARD) != 0) {
                if (wide) {
                    readyPositions[readyCount++] = position;
                }
                // Only trips before the current one are worth looking at.
                int limit = trip < 0 ? tripCount : trip;
                int column = timeBase + position * tripCount;
                int earliest = limit > 0 && t.departByPosition[column + limit - 1] >= ready
                        ? earliestTrip(column, limit, ready) : limit;
                if (limited) {
                    // Pass over trips with no room here, or that this passenger has been refused.
                    while (earliest < limit
                            && !boardable(tripBase + earliest, timeBase + earliest * length + position)) {
                        earliest++;
                    }
                }
                if (earliest < limit) {
                    int known = riddenTrip[pattern];
                    if (!wide && known <= earliest && riddenFrom[pattern] <= position) {
                        // An earlier round rode this trip, or one before it, through here. Every stop
                        // ahead already has that arrival, with fewer rides.
                        trip = -1;
                    } else {
                        trip = earliest;
                        tripTimes = timeBase + trip * length;
                        boarded = position;
                        if (known == NONE) {
                            riddenPatterns[riddenCount++] = pattern;
                            riddenTrip[pattern] = trip;
                            riddenFrom[pattern] = position;
                        } else if (trip <= known && position <= riddenFrom[pattern]) {
                            riddenTrip[pattern] = trip;
                            riddenFrom[pattern] = position;
                        }
                    }
                }
            }
        }
        return end;
    }

    /**
     * The passenger has ridden a trip to its last stop. If its vehicle runs on as another trip, they
     * may stay aboard, whatever the time to change. The same goes for the later trips of the pattern,
     * which they could have caught instead; only those arriving within the time to change need
     * noting, because the trips that later ones run on as can be boarded in the ordinary way.
     */
    private void offerNextTrips(int tripBase, int timeBase, int tripCount, int length, int trip, int boarded,
            int round, int readyCount, int stopBase) {
        int last = timeBase + length - 1;
        offer(tripBase + trip, boarded, round);
        if (readyCount < 0) {
            int within = t.arrive[last + trip * length] + changeSecs;
            for (int x = trip + 1; x < tripCount && t.arrive[last + x * length] < within; x++) {
                offer(tripBase + x, boarded, round);
            }
            return;
        }
        // With loads, the trip a later one runs on as may have no room for anyone boarding it in the
        // ordinary way, so every later trip that can still be of use matters, however much later.
        // But the passenger must have been able to get onto it: at a stop where they could board in
        // this round and it had room, or because they were aboard it from the start.
        for (int x = trip + 1; x < tripCount && t.arrive[last + x * length] < target; x++) {
            int next = t.tripStayAboard[tripBase + x];
            if (next < 0 || aboardRound[next] != NONE) {
                continue;
            }
            if (aboardRound[tripBase + x] == round - 1) {
                offer(tripBase + x, 0, round);
                continue;
            }
            for (int i = 0; i < readyCount; i++) {
                int position = readyPositions[i];
                int ready = state[(t.patternCalls[stopBase + position] & ~3) + READY];
                if (t.departByPosition[timeBase + position * tripCount + x] >= ready
                        && boardable(tripBase + x, timeBase + x * length + position)) {
                    offer(tripBase + x, position, round);
                    break;
                }
            }
        }
    }

    /**
     * Whether the passenger may board a trip at a place in the stop times: the same answer as
     * {@link Capacity#boardable}, for the scan, which already knows the place.
     */
    private boolean boardable(int trip, int index) {
        if (refused.length > 0 && Arrays.binarySearch(refused, index) >= 0) {
            return false;
        }
        return loads == null || loads[index] + group <= (fullAt == 1.0 ? t.tripCapacity[trip]
                : (int) Math.floor(t.tripCapacity[trip] * fullAt));
    }

    /** Notes that the passenger can be aboard the trip this one's vehicle runs on as, if there is one. */
    private void offer(int trip, int boarded, int round) {
        int next = t.tripStayAboard[trip];
        if (next >= 0 && aboardRound[next] == NONE
                && (t.patternStopFlags[t.patternStopOffset[t.tripPattern[next]]] & Timetable.BOARD) != 0) {
            aboardRound[next] = round;
            aboardTrip[next] = trip;
            aboardBoarded[next] = boarded;
            aboardTrips[aboardCount++] = next;
            aboardNow[aboardNowCount++] = next;
        }
    }

    /**
     * The first of a pattern's trips, among those before {@code limit}, that leaves a position at
     * or after a time. {@code column} is where that position's departures start. The caller has checked there is one. Trips in a pattern never overtake, so
     * their departures from any one stop are in order.
     */
    private int earliestTrip(int column, int limit, int ready) {
        int low = 0;
        int high = limit - 1;
        while (low < high) {
            int middle = (low + high) >>> 1;
            if (t.departByPosition[column + middle] >= ready) {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        return low;
    }

    /** Walks back from the end of a round's best journey to its start and returns it in order. */
    private Journey journey(Query q, int lastStop, int lastRound) {
        List<Leg> legs = new ArrayList<>();
        int stop = lastStop;
        int round = lastRound;
        Access out = q.egress().get(egressIndex[stop]);
        int arrived = labels[(stop * slots + round) * 5 + RIDE_ARRIVE];
        if (out.secs() > 0 || out.metres() > 0) {
            legs.add(Leg.walk(Leg.Kind.WALK, stop, -1, arrived, arrived + out.secs(), out.metres()));
        }
        int trip = labels[(stop * slots + round) * 5 + RIDE_TRIP];
        int boardPosition = labels[(stop * slots + round) * 5 + RIDE_POSITIONS] >>> 16;
        int alightPosition = labels[(stop * slots + round) * 5 + RIDE_POSITIONS] & 0xffff;
        while (true) {
            // A ride, made in this round.
            int stopBase = t.patternStopOffset[t.tripPattern[trip]];
            int boardStop = t.patternStops[stopBase + boardPosition];
            int boardTime = t.depart[t.tripTimeIndex(trip, boardPosition)];
            legs.add(new Leg(Leg.Kind.RIDE, boardStop, t.patternStops[stopBase + alightPosition], boardTime,
                    t.arrive[t.tripTimeIndex(trip, alightPosition)], 0, trip, boardPosition, alightPosition, false));

            // How the passenger came to be at the boarding stop in time: the latest earlier round
            // that had them there early enough.
            int earlier = round - 1;
            int base = boardStop * slots;
            while (earlier >= 0 && labels[(base + earlier) * 5 + RIDE_ARRIVE] > boardTime - changeSecs
                    && labels[(base + earlier) * 5 + WALK_ARRIVE] > boardTime) {
                earlier--;
            }
            if (earlier < 0 || (limited && !capacity.boardable(t, trip, boardPosition))) {
                // No round did, or there was no room to board: they were aboard already, on the trip
                // this one's vehicle ran on from.
                if (boardPosition != 0 || aboardRound[trip] != round - 1) {
                    throw new IllegalStateException("the search lost track of how trip " + t.tripIds[trip] + " was boarded");
                }
                boardPosition = aboardBoarded[trip];
                trip = aboardTrip[trip];
                alightPosition = t.patternLength(t.tripPattern[trip]) - 1;
                round--;
                continue;
            }
            if (labels[(base + earlier) * 5 + RIDE_ARRIVE] <= boardTime - changeSecs) {
                stop = boardStop; // changed vehicles at the one stop
            } else {
                int from = labels[(base + earlier) * 5 + WALK_FROM];
                int walked = labels[(base + earlier) * 5 + WALK_ARRIVE];
                if (from < 0) {
                    Access in = q.access().get(-1 - from);
                    if (in.secs() > 0 || in.metres() > 0) {
                        legs.add(Leg.walk(Leg.Kind.WALK, -1, boardStop, q.depart(), walked, in.metres()));
                    }
                    break;
                }
                int left = labels[(from * slots + earlier) * 5 + RIDE_ARRIVE];
                legs.add(Leg.walk(Leg.Kind.TRANSFER, from, boardStop, left, walked, transferMetres(from, boardStop)));
                stop = from;
            }
            round = earlier;
            trip = labels[(stop * slots + round) * 5 + RIDE_TRIP];
            boardPosition = labels[(stop * slots + round) * 5 + RIDE_POSITIONS] >>> 16;
            alightPosition = labels[(stop * slots + round) * 5 + RIDE_POSITIONS] & 0xffff;
        }
        Collections.reverse(legs);
        leaveLater(legs);

        // A vehicle that runs on as a new trip from the stop where its last trip ended is not a change.
        for (int i = 1; i < legs.size(); i++) {
            if (runsOn(legs.get(i - 1), legs.get(i))) {
                legs.set(i, legs.get(i).asStayAboard());
            }
        }
        return Journey.of(q.depart(), legs);
    }

    /** Whether the second leg is the vehicle of the first, running on as its next trip. */
    private boolean runsOn(Leg first, Leg second) {
        return first.kind() == Leg.Kind.RIDE && second.kind() == Leg.Kind.RIDE
                && t.tripStayAboard[first.trip()] == second.trip() && second.boardPosition() == 0
                && first.alightPosition() == t.patternLength(t.tripPattern[first.trip()]) - 1;
    }

    /**
     * The search takes the first vehicle it can at every step, which can mean arriving somewhere
     * early only to wait. Working back from the last ride, this moves each earlier ride to the
     * latest trip of the same pattern that still makes the connection, and the first walk to just
     * in time. The journey arrives when it did; the passenger sets off later and waits less.
     */
    private void leaveLater(List<Leg> legs) {
        int deadline = NONE; // the latest the leg being looked at may end
        for (int i = legs.size() - 1; i >= 0; i--) {
            Leg leg = legs.get(i);
            switch (leg.kind()) {
                case RIDE -> {
                    // A ride on a vehicle that runs on, into this trip or out of it, is left alone:
                    // moving it would turn staying aboard into a change.
                    if (deadline != NONE && !runsOn(leg, legs.get(i + 1))
                            && !(i > 0 && runsOn(legs.get(i - 1), leg))) {
                        int pattern = t.tripPattern[leg.trip()];
                        int inPattern = leg.trip() - t.patternTripOffset[pattern];
                        int later = inPattern;
                        // Changing at the one stop takes time; a walk has taken its own off already.
                        int latest = legs.get(i + 1).kind() == Leg.Kind.RIDE ? deadline - changeSecs : deadline;
                        for (int x = inPattern + 1; x < t.patternTripCount(pattern)
                                && t.arrive[t.timeIndex(pattern, x, leg.alightPosition())] <= latest; x++) {
                            if (!limited || capacity.boardable(t, t.patternTripOffset[pattern] + x, leg.boardPosition())) {
                                later = x;
                            }
                        }
                        if (later != inPattern) {
                            leg = new Leg(Leg.Kind.RIDE, leg.fromStop(), leg.toStop(),
                                    t.depart[t.timeIndex(pattern, later, leg.boardPosition())],
                                    t.arrive[t.timeIndex(pattern, later, leg.alightPosition())], 0,
                                    t.patternTripOffset[pattern] + later, leg.boardPosition(),
                                    leg.alightPosition(), false);
                            legs.set(i, leg);
                        }
                    }
                    deadline = leg.depart();
                }
                case TRANSFER -> deadline -= leg.arrive() - leg.depart();
                case WALK -> {
                    if (i == 0 && deadline != NONE) {
                        legs.set(0, Leg.walk(Leg.Kind.WALK, -1, leg.toStop(), deadline - (leg.arrive() - leg.depart()),
                                deadline, leg.metres()));
                    }
                }
            }
        }
        // A walk between rides starts when the ride before it ends.
        for (int i = 1; i < legs.size(); i++) {
            Leg leg = legs.get(i);
            if (leg.kind() == Leg.Kind.TRANSFER && leg.depart() != legs.get(i - 1).arrive()) {
                int starts = legs.get(i - 1).arrive();
                legs.set(i, Leg.walk(Leg.Kind.TRANSFER, leg.fromStop(), leg.toStop(), starts,
                        starts + leg.arrive() - leg.depart(), leg.metres()));
            }
        }
    }

    private int transferMetres(int from, int to) {
        for (int j = t.transferOffset[from]; j < t.transferOffset[from + 1]; j++) {
            if (t.transferTargets[j] == to) {
                return t.transferMetres[j];
            }
        }
        return 0;
    }

    /** Notes that a round is writing an arrival for a stop, so that the next query can clear it. */
    private void touch(int stop, int round) {
        state[stop * 4 + ROUNDS] |= 1 << round;
        if (!touched[stop]) {
            touched[stop] = true;
            touchedStops[touchedCount++] = stop;
        }
    }

    private void mark(int stop) {
        if (!marked[stop]) {
            marked[stop] = true;
            markedStops[markedCount++] = stop;
        }
    }

    /** Clears what the last query wrote, and only that: far cheaper than clearing every array. */
    private void reset() {
        for (int i = 0; i < touchedCount; i++) {
            int stop = touchedStops[i];
            touched[stop] = false;
            marked[stop] = false;
            rideMarked[stop] = false;
            int at = stop * 4;
            for (int rounds = state[at + ROUNDS]; rounds != 0; rounds &= rounds - 1) {
                int slot = stop * slots + Integer.numberOfTrailingZeros(rounds);
                labels[slot * 5 + RIDE_ARRIVE] = NONE;
                labels[slot * 5 + WALK_ARRIVE] = NONE;
            }
            state[at + BEST_RIDE] = NONE;
            state[at + READY] = NONE;
            state[at + BEST_ANY] = NONE;
            state[at + ROUNDS] = 0;
        }
        touchedCount = 0;
        for (int i = 0; i < riddenCount; i++) {
            riddenTrip[riddenPatterns[i]] = NONE;
        }
        riddenCount = 0;
        for (int i = 0; i < aboardCount; i++) {
            aboardRound[aboardTrips[i]] = NONE;
        }
        aboardCount = 0;
        aboardNowCount = 0;
        for (int i = 0; i < egressCount; i++) {
            egressSecs[egressStops[i]] = NONE;
        }
        egressCount = 0;
        markedCount = 0;
        rideMarkedCount = 0;
    }
}
