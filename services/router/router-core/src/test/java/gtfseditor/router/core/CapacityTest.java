package gtfseditor.router.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;

/**
 * Full vehicles, and adding passengers to the loads. The line has three stops, A, B and C, and
 * three trips that each hold two passengers: t0 leaves A at 08:00, t1 at 08:10, t2 at 08:20. Each
 * takes ten minutes to B and ten more to C.
 */
class CapacityTest {

    private static final int A = 0;
    private static final int B = 1;
    private static final int C = 2;

    private static Timetable line() {
        Timetable.Builder b = new Timetable.Builder();
        b.serviceDate = 20261117;
        b.stopIds = new String[] {"A", "B", "C"};
        b.stopNames = new String[] {"A", "B", "C"};
        b.stopLat = new double[] {-33.0, -33.02, -33.04};
        b.stopLon = new double[] {151.0, 151.0, 151.0};
        b.stopStation = new int[] {-1, -1, -1};
        b.routeIds = new String[] {"R"};
        b.routeNames = new String[] {"1"};
        b.routeTypes = new int[] {3};
        b.patternStopOffset = new int[] {0, 3};
        b.patternTripOffset = new int[] {0, 3};
        b.patternStops = new int[] {A, B, C};
        b.patternStopFlags = new byte[] {3, 3, 3};
        b.arrive = new int[9];
        b.depart = new int[9];
        for (int trip = 0; trip < 3; trip++) {
            for (int position = 0; position < 3; position++) {
                b.arrive[trip * 3 + position] = at(8, trip * 10 + position * 10);
                b.depart[trip * 3 + position] = at(8, trip * 10 + position * 10);
            }
        }
        b.tripIds = new String[] {"t0", "t1", "t2"};
        b.tripHeadsigns = new String[] {"", "", ""};
        b.tripRoute = new int[3];
        b.tripCapacity = new int[] {2, 2, 2};
        b.tripCapacityFlags = new byte[3];
        b.tripStayAboard = new int[] {-1, -1, -1};
        b.transferOffset = new int[4];
        b.transferTargets = new int[0];
        b.transferSecs = new int[0];
        b.transferMetres = new int[0];
        return b.build();
    }

    private static int at(int hours, int minutes) {
        return hours * 3600 + minutes * 60;
    }

    private static Query query(int from, int to, int depart) {
        return new Query(List.of(new Access(from, 0, 0)), List.of(new Access(to, 0, 0)), depart, 4, -1, 0);
    }

    private static int tripOf(Journey journey) {
        return journey.legs().get(0).trip();
    }

    @Test
    void aFullTripIsPassedOverAndTheNextTaken() {
        Timetable t = line();
        Router router = new Router(t);
        LoadState loads = LoadState.empty(t);
        Query q = query(A, C, at(7, 55));
        assertEquals(0, tripOf(router.route(q, Preferences.defaults(), Capacity.of(loads)).best()));

        loads.set(0, 0, 2);
        Capacity capacity = Capacity.of(loads);
        Result result = router.route(q, Preferences.defaults(), capacity);
        assertEquals(Result.Status.OK, result.status());
        assertEquals(1, tripOf(result.best()));
        assertEquals(at(8, 30), result.best().arrive());
        assertNull(JourneyChecker.problem(t, q, result.best(), capacity));
        // Ignoring the loads still takes the first trip.
        assertEquals(0, tripOf(router.route(q, Preferences.defaults()).best()));

        Crowding crowding = Crowding.of(t, q, result.best(), 0, capacity);
        assertEquals(1, crowding.skippedFull());
        assertEquals(0, crowding.peakLoad());
        assertEquals(2, crowding.capacity());
    }

    @Test
    void aTripIsFullOnlyWhereItIsFull() {
        Timetable t = line();
        Router router = new Router(t);
        LoadState loads = LoadState.empty(t);
        loads.set(0, 0, 2); // t0 is full from A to B, then empties
        Capacity capacity = Capacity.of(loads);
        assertEquals(1, tripOf(router.route(query(A, C, at(7, 55)), Preferences.defaults(), capacity).best()));
        assertEquals(0, tripOf(router.route(query(B, C, at(7, 55)), Preferences.defaults(), capacity).best()));
    }

    @Test
    void aGroupNeedsRoomForAllOfIt() {
        Timetable t = line();
        Router router = new Router(t);
        LoadState loads = LoadState.empty(t);
        loads.set(0, 0, 1);
        Query q = query(A, B, at(7, 55));
        assertEquals(0, tripOf(router.route(q, Preferences.defaults(), Capacity.of(loads, 1.0, 1)).best()));
        assertEquals(1, tripOf(router.route(q, Preferences.defaults(), Capacity.of(loads, 1.0, 2)).best()));
        assertEquals(Result.Status.STRANDED,
                router.route(q, Preferences.defaults(), Capacity.of(loads, 1.0, 3)).status());
        // Counting a trip as full at half its capacity leaves one place on each, and t0's is taken.
        assertEquals(1, tripOf(router.route(q, Preferences.defaults(), Capacity.of(loads, 0.5, 1)).best()));
    }

    @Test
    void aPassengerIsStrandedWhenEverythingIsFull() {
        Timetable t = line();
        Router router = new Router(t);
        LoadState loads = LoadState.empty(t);
        for (int trip = 0; trip < 3; trip++) {
            loads.set(trip, 0, 2);
        }
        Result result = router.route(query(A, C, at(7, 55)), Preferences.defaults(), Capacity.of(loads));
        assertEquals(Result.Status.STRANDED, result.status());
        assertTrue(result.journeys().isEmpty());
        // After the last trip there is no journey, full or not.
        assertEquals(Result.Status.NO_JOURNEY,
                router.route(query(A, C, at(9, 0)), Preferences.defaults(), Capacity.of(loads)).status());
    }

    @Test
    void aRefusedBoardingIsNotTakenAgain() {
        Timetable t = line();
        Router router = new Router(t);
        Capacity refused = Capacity.OFF.blocking(t, 0, 0).blocking(t, 1, 0);
        assertEquals(2, tripOf(router.route(query(A, C, at(7, 55)), Preferences.defaults(), refused).best()));
        // The refusal is of one boarding, not of the trip.
        assertEquals(0, tripOf(router.route(query(B, C, at(7, 55)), Preferences.defaults(), refused).best()));
    }

    private static Assignment.Requests requests(List<Query> queries, int group) {
        return new Assignment.Requests() {
            @Override
            public int count() {
                return queries.size();
            }

            @Override
            public int depart(int i) {
                return queries.get(i).depart();
            }

            @Override
            public int group(int i) {
                return group;
            }

            @Override
            public Query query(int i) {
                return queries.get(i);
            }
        };
    }

    private static Assignment.Outcome[] run(Router router, List<Query> queries, int group, Assignment.Settings settings,
            int threads) throws InterruptedException {
        Assignment.Outcome[] outcomes = new Assignment.Outcome[queries.size()];
        try (ExecutorService workers = Executors.newFixedThreadPool(threads)) {
            Assignment.run(router, requests(queries, group), Preferences.defaults(), settings, workers,
                    (request, outcome) -> {
                        assertNull(outcomes[request], "request " + request + " was settled twice");
                        outcomes[request] = outcome;
                    });
        }
        return outcomes;
    }

    @Test
    void assigningFillsTripsInTurnAndStrandsTheRest() throws InterruptedException {
        Timetable t = line();
        Router router = new Router(t);
        LoadState loads = LoadState.empty(t);
        List<Query> queries = new ArrayList<>();
        for (int i = 0; i < 7; i++) {
            queries.add(query(A, C, at(7, 55)));
        }
        Assignment.Outcome[] outcomes = run(router, queries, 1, Assignment.Settings.of(CapacityMode.ASSIGN, loads), 4);

        // Two on each trip, in the order asked, and the seventh has nowhere to go.
        for (int i = 0; i < 6; i++) {
            assertEquals(Result.Status.OK, outcomes[i].status(), "request " + i);
            assertEquals(i / 2, tripOf(outcomes[i].journey()), "request " + i);
        }
        // Everyone was first routed onto t0, which was empty when the slice began. Those who did not
        // fit were routed again against the loads as they then stood, so once was enough.
        assertEquals(1, outcomes[0].tries());
        assertEquals(2, outcomes[2].tries());
        assertEquals(2, outcomes[4].tries());
        assertEquals(2, outcomes[6].tries());
        assertEquals(Result.Status.STRANDED, outcomes[6].status());
        assertNull(outcomes[6].journey());
        for (int trip = 0; trip < 3; trip++) {
            assertEquals(2, loads.load(trip, 0));
            assertEquals(2, loads.load(trip, 1));
            assertEquals(0, loads.load(trip, 2)); // everyone is off at C
        }
        assertEquals(6, loads.summary().passengers());
        assertEquals(3, loads.summary().fullTrips());
    }

    @Test
    void aPassengerWhoDoesNotFitFurtherAlongIsRoutedAgain() throws InterruptedException {
        Timetable t = line();
        Router router = new Router(t);
        LoadState loads = LoadState.empty(t);
        loads.set(0, 1, 2); // t0 has room at A but is full from B to C
        Assignment.Outcome[] outcomes = run(router, List.of(query(A, C, at(7, 55))), 1,
                Assignment.Settings.of(CapacityMode.ASSIGN, loads), 1);
        assertEquals(1, tripOf(outcomes[0].journey()));
        assertEquals(2, outcomes[0].tries());
        assertEquals(0, loads.load(0, 0));
        assertEquals(1, loads.load(1, 0));

        // Checking only looks at the loads; it adds nobody.
        LoadState.Summary before = loads.summary();
        run(router, List.of(query(A, B, at(7, 55))), 1, Assignment.Settings.of(CapacityMode.CHECK, loads), 1);
        assertEquals(before, loads.summary());
    }

    @Test
    void laterDeparturesAreHandledLaterWhateverTheOrderAsked() throws InterruptedException {
        Timetable t = line();
        Router router = new Router(t);
        LoadState loads = LoadState.empty(t);
        // Asked for in reverse: the passenger who sets off first is still first onto t0.
        List<Query> queries = List.of(query(A, C, at(7, 58)), query(A, C, at(7, 50)), query(A, C, at(7, 40)));
        Assignment.Outcome[] outcomes = run(router, queries, 2, Assignment.Settings.of(CapacityMode.ASSIGN, loads), 2);
        assertEquals(2, tripOf(outcomes[0].journey()));
        assertEquals(1, tripOf(outcomes[1].journey()));
        assertEquals(0, tripOf(outcomes[2].journey()));
    }

    @Test
    void assigningIsTheSameOnOneThreadAndOnEightAndNeverOverfills() throws InterruptedException {
        int assigned = 0;
        int rerouted = 0;
        int stranded = 0;
        for (int seed = 0; seed < 40; seed++) {
            Random random = new Random(seed);
            Timetable t = BruteForceTest.randomTimetable(random); // every trip holds 50
            Router router = new Router(t, 5);
            List<Query> queries = new ArrayList<>();
            for (int i = 0; i < 600; i++) {
                queries.add(new Query(List.of(new Access(random.nextInt(t.stopCount()), 0, 0)),
                        List.of(new Access(random.nextInt(t.stopCount()), 0, 0)), random.nextInt(7000), 5, -1, 0));
            }
            LoadState one = LoadState.empty(t);
            LoadState eight = LoadState.empty(t);
            Assignment.Outcome[] onOne = run(router, queries, 3,
                    new Assignment.Settings(CapacityMode.ASSIGN, one, 1.0, 300, 3), 1);
            Assignment.Outcome[] onEight = run(router, queries, 3,
                    new Assignment.Settings(CapacityMode.ASSIGN, eight, 1.0, 300, 3), 8);
            for (int i = 0; i < queries.size(); i++) {
                assertEquals(onOne[i].journey(), onEight[i].journey(), "seed " + seed + " request " + i);
                assertEquals(onOne[i].status(), onEight[i].status());
                assertEquals(onOne[i].tries(), onEight[i].tries());
                if (onOne[i].journey() != null) {
                    assertNull(JourneyChecker.problem(t, queries.get(i), onOne[i].journey()));
                }
                assigned += onOne[i].journey() != null && onOne[i].journey().rides() > 0 ? 1 : 0;
                rerouted += onOne[i].tries() > 1 ? 1 : 0;
                stranded += onOne[i].status() == Result.Status.STRANDED ? 1 : 0;
            }
            for (int trip = 0; trip < t.tripCount(); trip++) {
                for (int position = 0; position < t.patternLength(t.tripPattern[trip]); position++) {
                    assertEquals(one.load(trip, position), eight.load(trip, position));
                    assertTrue(one.load(trip, position) <= t.tripCapacity[trip],
                            "seed " + seed + ": trip " + trip + " is over capacity at " + position);
                }
            }
        }
        assertTrue(assigned > 5_000, "only " + assigned + " passengers were assigned");
        assertTrue(rerouted > 300, "only " + rerouted + " passengers were routed again");
        assertTrue(stranded > 50, "only " + stranded + " passengers were stranded");
    }

    @Test
    void settingsThatMakeNoSenseAreRejected() {
        Timetable t = line();
        assertThrows(IllegalArgumentException.class,
                () -> new Assignment.Settings(CapacityMode.CHECK, null, 1.0, 300, 3));
        assertThrows(IllegalArgumentException.class,
                () -> new Assignment.Settings(CapacityMode.OFF, LoadState.empty(t), 1.0, 300, 3));
        assertThrows(IllegalArgumentException.class, () -> Capacity.of(LoadState.empty(t), 0, 1));
        assertThrows(IllegalArgumentException.class, () -> Capacity.of(LoadState.empty(t), 1.0, 0));
        assertThrows(IllegalArgumentException.class, () -> LoadState.empty(t).set(0, 3, 1));
    }
}
