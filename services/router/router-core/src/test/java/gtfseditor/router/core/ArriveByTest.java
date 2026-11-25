package gtfseditor.router.core;

import static gtfseditor.router.core.ArriveByNetwork.H;
import static gtfseditor.router.core.ArriveByNetwork.Q;
import static gtfseditor.router.core.ArriveByNetwork.W;
import static gtfseditor.router.core.ArriveByNetwork.Z;
import static gtfseditor.router.core.ArriveByNetwork.at;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Arrive-by journeys (BRD access-analysis FR-21) on the hand-made network of
 * {@link ArriveByNetwork}: the latest departure that still arrives in time, found by the backward
 * search and given back as a real journey with its legs in order.
 */
class ArriveByTest {

    private final Timetable t = ArriveByNetwork.build();
    private final Router router = new Router(t);

    private Query between(int from, int to) {
        return router.query(new Place.Stop(from), new Place.Stop(to), 0, Router.DEFAULT_MAX_RIDES, 1200);
    }

    private Journey best(Query q, int arriveBy) {
        Result result = ArriveBy.route(router, q, arriveBy, Preferences.defaults());
        assertEquals(Result.Status.OK, result.status());
        Journey journey = result.best();
        assertTrue(journey.arrive() <= arriveBy, "arrives after the time asked for: " + journey);
        assertNull(JourneyChecker.problem(t, q.departingAt(journey.depart()), journey));
        return journey;
    }

    @Test
    void theLatestDepartureThatArrivesInTimeIsFound() {
        Journey journey = best(between(H, W), at(8, 0));
        assertEquals(at(7, 20), journey.depart());
        assertEquals(at(7, 45), journey.arrive());
        assertEquals(1, journey.legs().size());
        assertEquals("b2", t.tripIds[journey.legs().get(0).trip()]);
        assertEquals(at(7, 20), router.latestDeparture(between(H, W), at(8, 0)));
    }

    @Test
    void aLaterDepartureThatWouldArriveLateIsNotChosen() {
        // b3 reaches W at 08:05: a minute too late for 08:04, just in time for 08:05.
        assertEquals(at(7, 20), best(between(H, W), at(8, 4)).depart());
        assertEquals(at(7, 40), best(between(H, W), at(8, 5)).depart());
    }

    @Test
    void aJourneyWithAChangeHasItsLegsInOrder() {
        Journey journey = best(between(Q, W), at(8, 0));
        assertEquals(at(7, 0), journey.depart());
        assertEquals(at(7, 45), journey.arrive());
        assertEquals(2, journey.rides());
        assertEquals(1, journey.changes());
        assertEquals("t1", t.tripIds[journey.legs().get(0).trip()]);
        assertEquals("b2", t.tripIds[journey.legs().get(1).trip()]);
        assertTrue(journey.legs().get(0).arrive() <= journey.legs().get(1).depart());
        assertEquals(at(7, 30), best(between(Q, W), at(8, 5)).depart());
    }

    @Test
    void theTimeToChangeIsRespected() {
        // With 15 minutes to change, t2 (M at 07:40) no longer makes b3 (M at 07:50).
        assertEquals(at(7, 0), best(between(Q, W).withChangeSecs(900), at(8, 5)).depart());
    }

    @Test
    void aWalkBetweenTwoRidesIsTakenBackwardsToo() {
        // b2 to W at 07:45, five minutes' walk to X, z1 at 07:55 to Z at 08:05.
        Journey journey = best(between(H, Z), at(8, 10));
        assertEquals(at(7, 20), journey.depart());
        assertEquals(at(8, 5), journey.arrive());
        assertEquals(List.of(Leg.Kind.RIDE, Leg.Kind.TRANSFER, Leg.Kind.RIDE),
                journey.legs().stream().map(Leg::kind).toList());
    }

    @Test
    void walkingTheWholeWayIsAnAnswer() {
        Query q = new Query(List.of(new Access(H, 60, 50)), List.of(new Access(W, 60, 50)), 0, 3, 900, 700);
        Journey journey = best(q, at(6, 0));
        assertEquals(0, journey.rides());
        assertEquals(at(6, 0) - 900, journey.depart());
        assertEquals(at(6, 0), journey.arrive());
    }

    @Test
    void nothingInTimeIsNoJourney() {
        Result early = ArriveBy.route(router, between(H, W), at(7, 24), Preferences.defaults());
        assertEquals(Result.Status.NO_JOURNEY, early.status());
        assertEquals(-1, early.recommended());
        assertTrue(early.journeys().isEmpty());
        assertEquals(-1, router.latestDeparture(between(H, W), at(7, 24)));
        // Nothing runs from W to H at all.
        assertEquals(Result.Status.NO_JOURNEY,
                ArriveBy.route(router, between(W, H), at(12, 0), Preferences.defaults()).status());
    }

    @Test
    void theLimitsOfTheQueryHold() {
        Query twoRides = between(Q, W);
        assertEquals(-1, router.latestDeparture(new Query(twoRides.access(), twoRides.egress(), 0, 1, -1, 0),
                at(9, 0)), "one ride is not enough");
        assertEquals(-1, router.latestDeparture(twoRides.avoiding(Set.of(Mode.TRAIN)), at(9, 0)), "the train is avoided");
        assertEquals(at(7, 30), router.latestDeparture(twoRides, at(9, 0)));
        Query walking = between(H, Z);
        assertEquals(-1, router.latestDeparture(walking.withWalksUpTo(Integer.MAX_VALUE, 299), at(9, 0)),
                "the walk between W and X is 300 s");
        assertEquals(at(7, 40), router.latestDeparture(walking.withWalksUpTo(Integer.MAX_VALUE, 300), at(9, 0)));
    }

    @Test
    void timesPastMidnightAreAsked() {
        // Nothing runs after 08:25, so any later time finds the last bus.
        assertEquals(at(8, 0), best(between(H, W), at(25, 30)).depart());
    }

    @Test
    void aVehicleThatRunsOnIsStayedAboard() {
        // tiny(): t1 leaves B at 510, reaches C at 600 and runs on as t2, leaving C at 700 for A at
        // 900. Changing at C would take until 720, so only staying aboard makes it.
        Timetable tiny = TestTimetables.tiny().build();
        Router small = new Router(tiny);
        Query q = small.query(new Place.Stop(1), new Place.Stop(0), 0, 4, 0);
        Result result = ArriveBy.route(small, q, 900, Preferences.defaults());
        Journey journey = result.best();
        assertEquals(510, journey.depart());
        assertEquals(900, journey.arrive());
        assertTrue(journey.legs().get(1).stayAboard());
        assertEquals(0, journey.changes());
    }

    @Test
    void oneBackwardSearchServesEveryStartThatSharesTheEnd() {
        List<Query> queries = new ArrayList<>();
        for (int from : new int[] {H, Q, ArriveByNetwork.M, W}) {
            queries.add(between(from, W));
        }
        int[] latest = router.latestDepartures(queries, at(8, 5));
        for (int i = 0; i < queries.size(); i++) {
            assertEquals(router.latestDeparture(queries.get(i), at(8, 5)), latest[i], "start " + i);
        }
        assertEquals(at(7, 40), latest[0]);
        assertEquals(at(7, 30), latest[1]);
        assertEquals(at(7, 50), latest[2]);
        // Starting at the end itself is a walk of nothing, so it may leave at the time asked for.
        assertEquals(at(8, 5), latest[3]);
    }

    @Test
    void queriesThatDoNotShareTheirEndCannotShareASearch() {
        boolean refused = false;
        try {
            router.latestDepartures(List.of(between(H, W), between(H, Z)), at(8, 5));
        } catch (IllegalArgumentException e) {
            refused = true;
        }
        assertTrue(refused);
        assertFalse(router.latestDepartures(List.of(), at(8, 5)).length > 0);
    }
}
