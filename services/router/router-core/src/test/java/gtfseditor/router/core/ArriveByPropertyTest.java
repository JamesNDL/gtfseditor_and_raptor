package gtfseditor.router.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;

/**
 * AC-FR-21.2 of BRD access-analysis, checked on thousands of random queries over the random
 * timetables of {@link BruteForceTest}, with fixed seeds so that it runs the same every time.
 *
 * <p>For every arrive-by query: if it gives a departure D, the forward search leaving at D arrives
 * in time, and the forward search leaving even one second later does not, so no later departure
 * works (AC-FR-21.2 asks for 60 s; one second is the stronger check). If it gives no journey, the
 * forward search leaving at the very start of the service day does not arrive in time either.
 */
class ArriveByPropertyTest {

    private static final int MAX_RIDES = 5;

    @Test
    void noLaterDepartureArrivesInTime() {
        int queries = 0;
        int answered = 0;
        int withChanges = 0;
        int stayedAboard = 0;
        for (int seed = 0; seed < 300; seed++) {
            Random random = new Random(seed);
            Timetable t = BruteForceTest.randomTimetable(random);
            Router router = new Router(t, MAX_RIDES);
            for (int i = 0; i < 25; i++) {
                Query q = randomQuery(random, t, randomWalks(random, t));
                int arriveBy = random.nextInt(14_000);
                String where = "seed " + seed + " query " + i + " by " + arriveBy + " " + q;
                Result result = ArriveBy.route(router, q, arriveBy, Preferences.defaults());
                int latest = router.latestDeparture(q, arriveBy);
                queries++;
                if (result.status() != Result.Status.OK) {
                    assertEquals(-1, latest, where);
                    assertTrue(earliestArrival(router, q, 0) > arriveBy, where + ": leaving at 0 arrives in time");
                    continue;
                }
                answered++;
                Journey journey = result.best();
                assertEquals(latest, journey.depart(), where);
                assertTrue(journey.arrive() <= arriveBy, where + " " + journey);
                assertNull(JourneyChecker.problem(t, q.departingAt(latest), journey), where + " " + journey);
                assertTrue(earliestArrival(router, q, latest) <= arriveBy, where);
                assertTrue(earliestArrival(router, q, latest + 1) > arriveBy, where + ": a later departure works");
                withChanges += journey.changes() > 0 ? 1 : 0;
                stayedAboard += journey.legs().stream().anyMatch(Leg::stayAboard) ? 1 : 0;
            }
        }
        assertEquals(7_500, queries);
        assertTrue(answered > 3_000, "only " + answered + " queries had an answer");
        assertTrue(withChanges > 500, "only " + withChanges + " journeys changed vehicle");
        assertTrue(stayedAboard > 30, "only " + stayedAboard + " journeys stayed aboard a vehicle that ran on");
    }

    /** One backward search for many starts gives each the departure its own search would. */
    @Test
    void manyStartsToOneEndAgreeWithOneAtATime() {
        int compared = 0;
        for (int seed = 500; seed < 700; seed++) {
            Random random = new Random(seed);
            Timetable t = BruteForceTest.randomTimetable(random);
            Router router = new Router(t, MAX_RIDES);
            List<Access> egress = randomWalks(random, t);
            Query shape = randomQuery(random, t, egress);
            List<Query> queries = new ArrayList<>();
            for (int i = 0; i < 12; i++) {
                int direct = random.nextInt(10) == 0 ? random.nextInt(4000) : -1;
                queries.add(new Query(randomWalks(random, t), egress, 0, shape.maxRides(), direct, 0, shape.avoid(),
                        shape.changeSecs(), shape.maxLinkSecs()));
            }
            int arriveBy = random.nextInt(14_000);
            int[] latest = router.latestDepartures(queries, arriveBy);
            for (int i = 0; i < queries.size(); i++) {
                assertEquals(router.latestDeparture(queries.get(i), arriveBy), latest[i], "seed " + seed + " start " + i);
                compared += latest[i] >= 0 ? 1 : 0;
            }
        }
        assertTrue(compared > 800, "only " + compared + " starts had a journey");
    }

    /** The forward search's earliest arrival leaving at a time, or MAX_VALUE if there is none. */
    private static int earliestArrival(Router router, Query q, int depart) {
        Result forward = router.route(q.departingAt(depart), Preferences.everything());
        return forward.journeys().isEmpty() ? Integer.MAX_VALUE : forward.journeys().get(0).arrive();
    }

    private static Query randomQuery(Random random, Timetable t, List<Access> egress) {
        List<Access> access = randomWalks(random, t);
        int direct = random.nextInt(10) == 0 ? random.nextInt(4000) : -1;
        int[] changes = {0, 60, 120, 120, 300};
        return new Query(access, egress, 0, 1 + random.nextInt(MAX_RIDES + 2), direct, 0)
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
}
