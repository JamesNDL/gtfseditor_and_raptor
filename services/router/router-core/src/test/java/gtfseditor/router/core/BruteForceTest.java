package gtfseditor.router.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

/**
 * Checks the search against a deliberately simple one on hundreds of small random timetables. The
 * simple search looks at every trip and every pair of stops along it in every round, with no
 * patterns, no marking and no pruning, so it is slow and hard to get wrong. For every query the
 * two must agree on the earliest arrival for each limit on rides, and every journey the real
 * search returns must replay correctly against the timetable.
 */
class BruteForceTest {

    private static final int NONE = Integer.MAX_VALUE;
    private static final int MAX_RIDES = 5;

    @Test
    void theSearchAgreesWithTheSimpleOneOnRandomTimetables() {
        int queries = 0;
        int answered = 0;
        int withChanges = 0;
        int withWalks = 0;
        int stayedAboard = 0;
        for (int seed = 0; seed < 400; seed++) {
            Random random = new Random(seed);
            Timetable t = randomTimetable(random);
            Router router = new Router(t, MAX_RIDES);
            for (int i = 0; i < 25; i++) {
                Query q = randomQuery(random, t);
                int[] expected = simpleSearch(t, q, Capacity.OFF);
                Result result = router.route(q, Preferences.everything());
                String where = "seed " + seed + " query " + i + " " + q;

                int[] found = new int[MAX_RIDES + 1];
                Arrays.fill(found, NONE);
                int previous = -1;
                for (Journey journey : result.journeys()) {
                    assertNull(JourneyChecker.problem(t, q, journey), where + " " + journey);
                    assertTrue(journey.arrive() > previous, where + ": journeys are not fastest first");
                    previous = journey.arrive();
                    for (int rides = journey.rides(); rides <= MAX_RIDES; rides++) {
                        found[rides] = Math.min(found[rides], journey.arrive());
                    }
                    withChanges += journey.rides() > 1 ? 1 : 0;
                    stayedAboard += journey.legs().stream().anyMatch(Leg::stayAboard) ? 1 : 0;
                    withWalks += journey.legs().stream().anyMatch(l -> l.kind() == Leg.Kind.TRANSFER) ? 1 : 0;
                }
                for (int rides = 0; rides <= MAX_RIDES; rides++) {
                    assertEquals(expected[rides], found[rides], where + " with up to " + rides + " rides");
                }
                assertEquals(expected[MAX_RIDES] == NONE, result.status() == Result.Status.NO_JOURNEY, where);
                queries++;
                answered += result.journeys().isEmpty() ? 0 : 1;
            }
        }
        // The random timetables must be connected enough to exercise the search.
        assertEquals(10_000, queries);
        assertTrue(answered > 4_000, "only " + answered + " queries had an answer");
        assertTrue(withChanges > 2_000, "only " + withChanges + " journeys changed vehicle");
        assertTrue(withWalks > 300, "only " + withWalks + " journeys walked between rides");
        assertTrue(stayedAboard > 100, "only " + stayedAboard + " journeys stayed aboard a vehicle that ran on");
    }

    /**
     * The same check with vehicles part full and some boardings refused. A trip the passenger may
     * not board at a stop is one the simple search does not let them board there; nothing else
     * about it changes. They may still stay aboard a vehicle that runs on, whatever its load.
     */
    @Test
    void theSearchAgreesWithTheSimpleOneWhenVehiclesAreFull() {
        int queries = 0;
        int answered = 0;
        int later = 0;
        int stranded = 0;
        int stayedAboard = 0;
        for (int seed = 1000; seed < 1600; seed++) {
            Random random = new Random(seed);
            Timetable t = randomTimetable(random);
            Router router = new Router(t, MAX_RIDES);
            LoadState loads = LoadState.empty(t);
            // Capacity is 50 everywhere. Some trips are full from end to end, some for a stretch.
            for (int trip = 0; trip < t.tripCount(); trip++) {
                int length = t.patternLength(t.tripPattern[trip]);
                int kind = random.nextInt(4);
                for (int position = 0; position < length; position++) {
                    int load = kind == 0 ? 50 : kind == 1 ? 0 : random.nextInt(3) == 0 ? 47 + random.nextInt(6)
                            : random.nextInt(40);
                    loads.set(trip, position, load);
                }
            }
            for (int i = 0; i < 25; i++) {
                Query q = randomQuery(random, t);
                Capacity capacity = Capacity.of(random.nextInt(6) == 0 ? null : loads,
                        random.nextInt(4) == 0 ? 0.9 : 1.0, 1 + random.nextInt(3));
                for (int b = random.nextInt(4); b > 0; b--) {
                    int trip = random.nextInt(t.tripCount());
                    capacity = capacity.blocking(t, trip, random.nextInt(t.patternLength(t.tripPattern[trip])));
                }
                int[] expected = simpleSearch(t, q, capacity);
                int[] free = simpleSearch(t, q, Capacity.OFF);
                Result result = router.route(q, Preferences.everything(), capacity);
                String where = "seed " + seed + " query " + i + " " + q;

                int[] found = new int[MAX_RIDES + 1];
                Arrays.fill(found, NONE);
                for (Journey journey : result.journeys()) {
                    assertNull(JourneyChecker.problem(t, q, journey, capacity), where + " " + journey);
                    for (int rides = journey.rides(); rides <= MAX_RIDES; rides++) {
                        found[rides] = Math.min(found[rides], journey.arrive());
                    }
                    stayedAboard += journey.legs().stream().anyMatch(Leg::stayAboard) ? 1 : 0;
                }
                for (int rides = 0; rides <= MAX_RIDES; rides++) {
                    assertEquals(expected[rides], found[rides], where + " with up to " + rides + " rides");
                }
                Result.Status status = expected[MAX_RIDES] != NONE ? Result.Status.OK
                        : free[MAX_RIDES] != NONE ? Result.Status.STRANDED : Result.Status.NO_JOURNEY;
                assertEquals(status, result.status(), where);
                queries++;
                answered += status == Result.Status.OK ? 1 : 0;
                stranded += status == Result.Status.STRANDED ? 1 : 0;
                later += status == Result.Status.OK && expected[MAX_RIDES] > free[MAX_RIDES] ? 1 : 0;
            }
        }
        assertEquals(15_000, queries);
        assertTrue(answered > 5_000, "only " + answered + " queries had an answer");
        assertTrue(later > 1_500, "only " + later + " journeys arrived later because of a full vehicle");
        assertTrue(stranded > 300, "only " + stranded + " queries were stranded");
        assertTrue(stayedAboard > 100, "only " + stayedAboard + " journeys stayed aboard a vehicle that ran on");
    }

    /** With nobody aboard anything, respecting the loads changes no answer. */
    @Test
    void emptyLoadsChangeNothing() {
        for (int seed = 0; seed < 200; seed++) {
            Random random = new Random(seed);
            Timetable t = randomTimetable(random);
            Router router = new Router(t, MAX_RIDES);
            Capacity empty = Capacity.of(LoadState.empty(t));
            for (int i = 0; i < 25; i++) {
                Query q = randomQuery(random, t);
                Result off = router.route(q, Preferences.defaults());
                Result check = router.route(q, Preferences.defaults(), empty);
                assertEquals(off.status(), check.status());
                assertEquals(off.journeys(), check.journeys(), "seed " + seed + " query " + i);
                assertEquals(off.recommended(), check.recommended());
            }
        }
    }

    /** The earliest arrival using at most 0, 1, 2, ... rides; NONE where there is no journey. */
    private static int[] simpleSearch(Timetable t, Query q, Capacity capacity) {
        int stops = t.stopCount();
        int[] canBoardFrom = new int[stops]; // earliest the passenger can be at each stop, by any means
        Arrays.fill(canBoardFrom, NONE);
        for (Access a : q.access()) {
            canBoardFrom[a.stop()] = Math.min(canBoardFrom[a.stop()], q.depart() + a.secs());
        }
        // Trips the passenger could have ridden to the last stop in an earlier round. If the vehicle
        // runs on as another trip, they may be aboard that one at its first stop.
        boolean[] rodeToEnd = new boolean[t.tripCount()];
        int[] best = new int[MAX_RIDES + 1];
        best[0] = q.directWalkSecs() >= 0 ? q.depart() + q.directWalkSecs() : NONE;
        for (int round = 1; round <= MAX_RIDES; round++) {
            // Every ride from where the passenger could be after the previous round.
            int[] byRide = new int[stops];
            Arrays.fill(byRide, NONE);
            boolean[] rodeNow = new boolean[t.tripCount()];
            for (int trip = 0; trip < t.tripCount(); trip++) {
                int pattern = t.tripPattern[trip];
                int base = t.patternStopOffset[pattern];
                int length = t.patternLength(pattern);
                boolean aboard = false;
                for (int before = 0; before < t.tripCount(); before++) {
                    aboard |= t.tripStayAboard[before] == trip && rodeToEnd[before];
                }
                for (int board = 0; board < length; board++) {
                    int from = t.patternStops[base + board];
                    boolean boards = canBoardFrom[from] <= t.depart[t.tripTimeIndex(trip, board)]
                            && capacity.boardable(t, trip, board);
                    if ((t.patternStopFlags[base + board] & Timetable.BOARD) == 0 || (!boards && !(board == 0 && aboard))) {
                        continue;
                    }
                    rodeNow[trip] |= board < length - 1
                            && (t.patternStopFlags[base + length - 1] & Timetable.ALIGHT) != 0;
                    for (int alight = board + 1; alight < length; alight++) {
                        if ((t.patternStopFlags[base + alight] & Timetable.ALIGHT) != 0) {
                            int to = t.patternStops[base + alight];
                            byRide[to] = Math.min(byRide[to], t.arrive[t.tripTimeIndex(trip, alight)]);
                        }
                    }
                }
            }
            best[round] = best[round - 1];
            if (round <= q.maxRides()) {
                for (Access e : q.egress()) {
                    if (byRide[e.stop()] != NONE) {
                        best[round] = Math.min(best[round], byRide[e.stop()] + e.secs());
                    }
                }
            }
            for (int trip = 0; trip < t.tripCount(); trip++) {
                rodeToEnd[trip] |= rodeNow[trip];
            }
            // After a ride the passenger may change where they are, which takes time, or walk one link;
            // then they may board again.
            int[] next = canBoardFrom.clone();
            for (int stop = 0; stop < stops; stop++) {
                if (byRide[stop] == NONE) {
                    continue;
                }
                next[stop] = Math.min(next[stop], byRide[stop] + q.changeSecs());
                for (int j = t.transferOffset[stop]; j < t.transferOffset[stop + 1]; j++) {
                    int to = t.transferTargets[j];
                    if (t.transferSecs[j] <= q.maxLinkSecs()) {
                        next[to] = Math.min(next[to], byRide[stop] + t.transferSecs[j]);
                    }
                }
            }
            canBoardFrom = next;
        }
        return best;
    }

    private static Query randomQuery(Random random, Timetable t) {
        List<Access> access = randomWalks(random, t);
        List<Access> egress = randomWalks(random, t);
        int direct = random.nextInt(10) == 0 ? random.nextInt(4000) : -1;
        int[] changes = {0, 60, 120, 120, 300};
        return new Query(access, egress, random.nextInt(5000), 1 + random.nextInt(MAX_RIDES + 2), direct, 0)
                .withChangeSecs(changes[random.nextInt(changes.length)])
                .withWalksUpTo(Integer.MAX_VALUE, random.nextInt(3) == 0 ? random.nextInt(600) : Integer.MAX_VALUE);
    }

    private static List<Access> randomWalks(Random random, Timetable t) {
        List<Access> walks = new ArrayList<>();
        int count = 1 + random.nextInt(3);
        for (int i = 0; i < count; i++) {
            walks.add(new Access(random.nextInt(t.stopCount()), random.nextInt(3) == 0 ? 0 : random.nextInt(400), 0));
        }
        return walks;
    }

    /**
     * A handful of stops, a few lines each with a few trips, and some one-way walking links. Lines
     * may visit a stop twice, skip boarding or alighting at a stop, share stops with faster lines,
     * and have trips that leave at the same time. Some vehicles run on as another trip.
     */
    static Timetable randomTimetable(Random random) {
        Timetable.Builder b = new Timetable.Builder();
        int stops = 5 + random.nextInt(12);
        b.serviceDate = 20261117;
        b.stopIds = new String[stops];
        b.stopNames = new String[stops];
        b.stopLat = new double[stops];
        b.stopLon = new double[stops];
        b.stopStation = new int[stops];
        for (int s = 0; s < stops; s++) {
            b.stopIds[s] = "s" + s;
            b.stopNames[s] = "Stop " + s;
            b.stopLat[s] = -33 - random.nextDouble();
            b.stopLon[s] = 151 + random.nextDouble();
            b.stopStation[s] = -1;
        }
        b.routeIds = new String[] {"R"};
        b.routeNames = new String[] {"R"};
        b.routeTypes = new int[] {3};

        int patterns = 6 + random.nextInt(10);
        List<Integer> patternStops = new ArrayList<>();
        List<Integer> flags = new ArrayList<>();
        List<Integer> arrive = new ArrayList<>();
        List<Integer> depart = new ArrayList<>();
        b.patternStopOffset = new int[patterns + 1];
        b.patternTripOffset = new int[patterns + 1];
        for (int p = 0; p < patterns; p++) {
            int length = 2 + random.nextInt(5);
            int previous = -1;
            for (int i = 0; i < length; i++) {
                int stop = random.nextInt(stops);
                while (stop == previous) {
                    stop = random.nextInt(stops);
                }
                previous = stop;
                patternStops.add(stop);
                flags.add(random.nextInt(8) == 0 ? random.nextInt(4) : Timetable.BOARD | Timetable.ALIGHT);
            }
            int trips = 2 + random.nextInt(6);
            int[] tripArrive = new int[length];
            int[] tripDepart = new int[length];
            int clock = random.nextInt(7200);
            for (int i = 0; i < length; i++) {
                tripArrive[i] = clock + (i == 0 ? 0 : 60 + random.nextInt(900));
                tripDepart[i] = tripArrive[i] + (random.nextBoolean() ? 0 : random.nextInt(120));
                clock = tripDepart[i];
            }
            for (int trip = 0; trip < trips; trip++) {
                if (trip > 0) {
                    // Later everywhere than the trip before, by an amount that only grows along the line.
                    int later = random.nextInt(3) == 0 ? 0 : random.nextInt(1800);
                    for (int i = 0; i < length; i++) {
                        later += random.nextInt(4) == 0 ? random.nextInt(120) : 0;
                        tripArrive[i] += later;
                        tripDepart[i] += later;
                    }
                }
                for (int i = 0; i < length; i++) {
                    arrive.add(tripArrive[i]);
                    depart.add(tripDepart[i]);
                }
            }
            b.patternStopOffset[p + 1] = patternStops.size();
            b.patternTripOffset[p + 1] = b.patternTripOffset[p] + trips;
        }
        b.patternStops = patternStops.stream().mapToInt(Integer::intValue).toArray();
        b.patternStopFlags = new byte[flags.size()];
        for (int i = 0; i < flags.size(); i++) {
            b.patternStopFlags[i] = (byte) (int) flags.get(i);
        }
        b.arrive = arrive.stream().mapToInt(Integer::intValue).toArray();
        b.depart = depart.stream().mapToInt(Integer::intValue).toArray();

        int trips = b.patternTripOffset[patterns];
        b.tripIds = new String[trips];
        b.tripHeadsigns = new String[trips];
        b.tripRoute = new int[trips];
        b.tripCapacity = new int[trips];
        b.tripCapacityFlags = new byte[trips];
        b.tripStayAboard = new int[trips];
        for (int trip = 0; trip < trips; trip++) {
            b.tripIds[trip] = "t" + trip;
            b.tripHeadsigns[trip] = "";
            b.tripCapacity[trip] = 50;
            b.tripStayAboard[trip] = -1;
        }
        // Some trips run on as the soonest trip to leave the stop they end at.
        int[] firstTime = new int[trips];
        int[] lastTime = new int[trips];
        int[] firstStop = new int[trips];
        int[] lastStop = new int[trips];
        for (int p = 0, trip = 0, time = 0; p < patterns; p++) {
            int length = b.patternStopOffset[p + 1] - b.patternStopOffset[p];
            for (; trip < b.patternTripOffset[p + 1]; trip++, time += length) {
                firstTime[trip] = time;
                lastTime[trip] = time + length - 1;
                firstStop[trip] = b.patternStops[b.patternStopOffset[p]];
                lastStop[trip] = b.patternStops[b.patternStopOffset[p + 1] - 1];
            }
        }
        for (int trip = 0; trip < trips; trip++) {
            if (random.nextInt(2) == 0) {
                continue;
            }
            for (int other = 0; other < trips; other++) {
                if (other != trip && firstStop[other] == lastStop[trip]
                        && b.depart[firstTime[other]] >= b.arrive[lastTime[trip]]
                        && (b.tripStayAboard[trip] < 0
                                || b.depart[firstTime[other]] < b.depart[firstTime[b.tripStayAboard[trip]]])) {
                    b.tripStayAboard[trip] = other;
                }
            }
        }

        // One-way links, so that A to B does not imply B to A, and links do not chain.
        TreeMap<Long, Integer> links = new TreeMap<>();
        int wanted = random.nextInt(stops * 2);
        for (int i = 0; i < wanted; i++) {
            int from = random.nextInt(stops);
            int to = random.nextInt(stops);
            if (from != to) {
                links.put((long) from * stops + to, random.nextInt(5) == 0 ? 0 : random.nextInt(600));
            }
        }
        b.transferOffset = new int[stops + 1];
        b.transferTargets = new int[links.size()];
        b.transferSecs = new int[links.size()];
        b.transferMetres = new int[links.size()];
        int at = 0;
        for (var link : links.entrySet()) {
            int from = (int) (link.getKey() / stops);
            b.transferOffset[from + 1]++;
            b.transferTargets[at] = (int) (link.getKey() % stops);
            b.transferSecs[at] = link.getValue();
            b.transferMetres[at] = link.getValue();
            at++;
        }
        for (int s = 0; s < stops; s++) {
            b.transferOffset[s + 1] += b.transferOffset[s];
        }
        return b.build();
    }
}
