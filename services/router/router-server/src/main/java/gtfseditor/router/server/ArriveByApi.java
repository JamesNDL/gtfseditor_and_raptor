package gtfseditor.router.server;

import com.fasterxml.jackson.databind.node.ObjectNode;
import gtfseditor.router.core.ArriveBy;
import gtfseditor.router.core.Assignment;
import gtfseditor.router.core.CapacityMode;
import gtfseditor.router.core.Journey;
import gtfseditor.router.core.Place;
import gtfseditor.router.core.Preferences;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Result;
import gtfseditor.router.core.Router;
import java.util.function.IntUnaryOperator;

/**
 * Arrive-by journeys over HTTP: a request that gives {@code arriveBy} in place of {@code depart}
 * gets the journey that leaves latest and still arrives by then (BRD access-analysis FR-21). The
 * answer is the forward one, with {@code arriveBy} and {@code earlyWait} added to each journey.
 * {@link JourneyApi} reads the requests and writes the answers; this plans them.
 */
final class ArriveByApi {

    private ArriveByApi() {}

    /** Arrive-by takes no account of how full vehicles are, so it is refused anything that does. */
    private static void check(JourneyApi.Options options, boolean blocked) {
        if (options.mode() != CapacityMode.OFF || blocked) {
            throw ApiException.bad("arriveBy works with capacity off only, and with nothing blocked");
        }
    }

    private static Preferences preferences(JourneyApi.Options options) {
        return options.lessWalking() ? Preferences.lessWalking() : Preferences.defaults();
    }

    /**
     * Plans one arrive-by journey.
     *
     * @param blocked whether the request refuses the passenger any boardings
     */
    static Assignment.Outcome single(Router router, JourneyApi.Options options, boolean blocked, Place from, Place to,
            int arriveBy) {
        check(options, blocked);
        Query query = JourneyApi.query(router, options, from, to, arriveBy);
        Result result = ArriveBy.route(router, query, arriveBy, preferences(options));
        Journey best = result.best();
        return new Assignment.Outcome(best == null ? query : query.departingAt(best.depart()), result, best, 1);
    }

    /**
     * Plans a bulk request in which at least one journey is asked for by the time to arrive by;
     * the rest are planned from their departure times as usual. Outcomes reach the sink in the
     * order asked.
     *
     * @param arriveBy the time each request must arrive by, or -1 for one that sets off at its time
     * @param begun    run once everything that can refuse the request has been checked
     */
    static void bulk(Timetables.Loaded loaded, JourneyApi.Options options, Assignment.Requests requests,
            IntUnaryOperator arriveBy, Runnable begun, Assignment.Sink sink) {
        check(options, false);
        begun.run();
        ArriveBy.Requests asked = new ArriveBy.Requests() {
            @Override
            public int count() {
                return requests.count();
            }

            @Override
            public Query query(int i) {
                return requests.query(i);
            }

            @Override
            public int arriveBy(int i) {
                return arriveBy.applyAsInt(i);
            }
        };
        try {
            ArriveBy.run(loaded.router(), asked, preferences(options), loaded.workers(), sink);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ApiException(503, "the service is stopping");
        }
    }

    /** Adds the time asked to arrive by, and the wait between arriving and then, to an arrive-by journey. */
    static void mark(ObjectNode journey, Journey found, int arriveBy) {
        if (arriveBy >= 0) {
            journey.put("arriveBy", arriveBy);
            journey.put("earlyWait", arriveBy - found.arrive());
        }
    }
}
