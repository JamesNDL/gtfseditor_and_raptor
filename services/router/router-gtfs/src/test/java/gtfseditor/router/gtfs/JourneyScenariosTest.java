package gtfseditor.router.gtfs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Journey;
import gtfseditor.router.core.JourneyChecker;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Place;
import gtfseditor.router.core.Preferences;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Result;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Journeys with known answers on a hand-made feed, loaded from a zip exactly as a real feed is.
 * Each test is one rule from section 10.1 of docs/router-plan.md.
 *
 * <p>The network, north to south, stops about 2 km apart unless said otherwise:
 *
 * <ul>
 *   <li>A, B, C, D: a stopping train (S1 at 08:00, S2 at 09:00) and an express (EXP at 08:05) that
 *       overtakes S1. R runs through B at midday without stopping.
 *   <li>C to E: two short trips, X0 at 08:16 and X1 at 08:25. Z is a slow direct trip from A to E.
 *   <li>C2 is 150 m from C; W runs from C2 to F at 08:24.
 *   <li>D to E: a night trip that arrives after midnight.
 *   <li>F to G to Y: one bus running as two trips, K1 then K2.
 *   <li>L1, L2, L3 and back to L1: a loop.
 *   <li>M1 and M2, 700 m apart: a slow bus from M1 to N and a fast train from M2 to N.
 *   <li>X1 and X2: two platforms of one station, each with a trip to Y; and a trip from Y to X1.
 * </ul>
 */
class JourneyScenariosTest {

    private static Timetable t;
    private static Router router;

    @BeforeAll
    static void load(@TempDir Path folder) throws Exception {
        Feed feed = new Feed().oneDay()
                .file("routes.txt",
                        "route_id,route_short_name,route_type",
                        "TRAIN,T1,2", "BUS,10,3")
                .file("stops.txt",
                        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
                        "A,A,-33.00,151.0,0,", "B,B,-33.02,151.0,0,", "C,C,-33.04,151.0,0,",
                        "D,D,-33.06,151.0,0,", "E,E,-33.08,151.0,0,", "C2,C2,-33.04,151.0016,0,",
                        "F,F,-33.10,151.0,0,", "G,G,-33.12,151.0,0,", "Y,Y,-33.22,151.0,0,",
                        "SX,Station X,-33.20,151.0,1,",
                        "X1,X platform 1,-33.2000,151.0,0,SX", "X2,X platform 2,-33.2002,151.0,0,SX",
                        "L1,L1,-33.30,151.0,0,", "L2,L2,-33.32,151.0,0,", "L3,L3,-33.34,151.0,0,",
                        "M1,M1,-33.40,151.0,0,", "M2,M2,-33.4063,151.0,0,", "N,N,-33.50,151.0,0,")
                .file("trips.txt",
                        "route_id,service_id,trip_id,block_id",
                        "TRAIN,DAY,S1,", "TRAIN,DAY,S2,", "TRAIN,DAY,EXP,", "TRAIN,DAY,R,",
                        "BUS,DAY,X0,", "BUS,DAY,X1,", "BUS,DAY,Z,", "BUS,DAY,W,", "BUS,DAY,N,",
                        "BUS,DAY,K1,BK", "BUS,DAY,K2,BK", "BUS,DAY,LOOP,", "BUS,DAY,LATE,",
                        "TRAIN,DAY,P1,", "TRAIN,DAY,P2,", "TRAIN,DAY,BACK,",
                        "BUS,DAY,MSLOW,", "TRAIN,DAY,MFAST,")
                .file("stop_times.txt",
                        "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
                        "S1,08:00:00,08:00:00,A,1,0,0", "S1,08:10:00,08:10:00,B,2,0,0",
                        "S1,08:20:00,08:20:00,C,3,0,0", "S1,08:30:00,08:30:00,D,4,0,0",
                        "S2,09:00:00,09:00:00,A,1,0,0", "S2,09:10:00,09:10:00,B,2,0,0",
                        "S2,09:20:00,09:20:00,C,3,0,0", "S2,09:30:00,09:30:00,D,4,0,0",
                        "EXP,08:05:00,08:05:00,A,1,0,0", "EXP,08:09:00,08:09:00,B,2,0,0",
                        "EXP,08:14:00,08:14:00,C,3,0,0", "EXP,08:20:00,08:20:00,D,4,0,0",
                        "R,12:00:00,12:00:00,A,1,0,0", "R,12:05:00,12:05:00,B,2,1,1",
                        "R,12:10:00,12:10:00,C,3,0,0",
                        "X0,08:16:00,08:16:00,C,1,0,0", "X0,08:31:00,08:31:00,E,2,0,0",
                        "X1,08:25:00,08:25:00,C,1,0,0", "X1,08:40:00,08:40:00,E,2,0,0",
                        "Z,08:00:00,08:00:00,A,1,0,0", "Z,09:00:00,09:00:00,E,2,0,0",
                        "W,08:24:00,08:24:00,C2,1,0,0", "W,08:35:00,08:35:00,F,2,0,0",
                        "N,23:50:00,23:50:00,D,1,0,0", "N,24:20:00,24:20:00,E,2,0,0",
                        "LATE,09:25:00,09:25:00,C,1,0,0", "LATE,09:40:00,09:40:00,G,2,0,0",
                        "K1,10:00:00,10:00:00,F,1,0,0", "K1,10:10:00,10:10:00,G,2,0,0",
                        "K2,10:12:00,10:12:00,G,1,0,0", "K2,10:30:00,10:30:00,Y,2,0,0",
                        "LOOP,13:00:00,13:00:00,L1,1,0,0", "LOOP,13:10:00,13:10:00,L2,2,0,0",
                        "LOOP,13:20:00,13:20:00,L3,3,0,0", "LOOP,13:30:00,13:30:00,L1,4,0,0",
                        "P1,14:05:00,14:05:00,X1,1,0,0", "P1,14:20:00,14:20:00,Y,2,0,0",
                        "P2,14:00:00,14:00:00,X2,1,0,0", "P2,14:10:00,14:10:00,Y,2,0,0",
                        "BACK,15:00:00,15:00:00,Y,1,0,0", "BACK,15:10:00,15:10:00,X1,2,0,0",
                        "MSLOW,16:10:00,16:10:00,M1,1,0,0", "MSLOW,16:40:00,16:40:00,N,2,0,0",
                        "MFAST,16:20:00,16:20:00,M2,1,0,0", "MFAST,16:30:00,16:30:00,N,2,0,0");
        t = GtfsLoader.load(feed.zip(folder), LoadOptions.defaults());
        router = new Router(t);
    }

    private static Place stop(String id) {
        return new Place.Stop(t.stopIndex(id));
    }

    private static int at(int hours, int minutes) {
        return hours * 3600 + minutes * 60;
    }

    /** Plans the journey and replays every answer against the timetable before handing it back. */
    private static Result plan(Place from, Place to, int depart) {
        Query query = router.query(from, to, depart, Router.DEFAULT_MAX_RIDES, Router.DEFAULT_MAX_WALK_METRES);
        Result result = router.route(query, Preferences.everything());
        for (Journey journey : result.journeys()) {
            assertNull(JourneyChecker.problem(t, query, journey), journey.toString());
        }
        return result;
    }

    private static Journey fastest(Place from, Place to, int depart) {
        Result result = plan(from, to, depart);
        assertEquals(Result.Status.OK, result.status());
        assertEquals("fastest", result.journeys().get(0).label());
        return result.journeys().get(0);
    }

    private static String trips(Journey journey) {
        StringBuilder text = new StringBuilder();
        for (Leg leg : journey.legs()) {
            text.append(text.isEmpty() ? "" : " ").append(switch (leg.kind()) {
                case RIDE -> t.tripIds[leg.trip()];
                case TRANSFER -> "walk";
                case WALK -> "foot";
            });
        }
        return text.toString();
    }

    @Test
    void aDirectTrip() {
        Journey j = fastest(stop("A"), stop("B"), at(8, 50));
        assertEquals("S2", trips(j));
        // Asked for 08:50, but there is no need to be at the stop before the 09:00 train.
        assertEquals(at(9, 0), j.depart());
        assertEquals(at(9, 10), j.arrive());
        assertEquals(1, j.rides());
        assertEquals(0, j.changes());
        assertEquals(0, j.waitSecs());
        assertEquals(0, j.walkSecs());
    }

    @Test
    void anExpressThatOvertakesIsTaken() {
        Journey j = fastest(stop("A"), stop("D"), at(8, 0));
        assertEquals("EXP", trips(j));
        assertEquals(at(8, 20), j.arrive());
        // Once the express has gone, the next stopping train is the only way.
        assertEquals("S2", trips(fastest(stop("A"), stop("D"), at(8, 6))));
    }

    @Test
    void oneChangeAndTheSlowerDirectTripAreBothOffered() {
        Result result = plan(stop("A"), stop("E"), at(8, 0));
        assertEquals(2, result.journeys().size());
        Journey quick = result.journeys().get(0);
        assertEquals("EXP X0", trips(quick));
        assertEquals(at(8, 31), quick.arrive());
        assertEquals(1, quick.changes());
        assertEquals(120, quick.legs().get(1).depart() - quick.legs().get(0).arrive());
        Journey direct = result.journeys().get(1);
        assertEquals("fewerChanges", direct.label());
        assertEquals("Z", trips(direct));
        assertEquals(at(9, 0), direct.arrive());
    }

    @Test
    void changingAtOneStopTakesTime() {
        // The express reaches C at 08:14 and X0 leaves C at 08:16: just enough at the usual two minutes.
        assertEquals("EXP X0", trips(fastest(stop("A"), stop("E"), at(8, 0))));
        // Ask for three minutes and X0 is missed; the next is X1 at 08:25.
        Router careful = new Router(t, Router.DEFAULT_MAX_RIDES, 180);
        Query query = careful.query(stop("A"), stop("E"), at(8, 0), Router.DEFAULT_MAX_RIDES,
                Router.DEFAULT_MAX_WALK_METRES);
        Journey j = careful.route(query).journeys().get(0);
        assertNull(JourneyChecker.problem(t, query, j));
        assertEquals("X1", trips(j).substring(trips(j).length() - 2));
        assertEquals(at(8, 40), j.arrive());
        // The journey the usual rule gives does not pass the stricter one.
        Journey tight = fastest(stop("A"), stop("E"), at(8, 0));
        assertEquals("leg 1 leaves too soon after the ride before it for a change",
                JourneyChecker.problem(t, query, tight));
    }

    @Test
    void stayingAboardTakesNoTimeHoweverLongAChangeDoes() {
        // K1 reaches G at 10:10 and its bus leaves again as K2 at 10:12.
        Router careful = new Router(t, Router.DEFAULT_MAX_RIDES, 600);
        Query query = careful.query(stop("F"), stop("Y"), at(9, 55), Router.DEFAULT_MAX_RIDES,
                Router.DEFAULT_MAX_WALK_METRES);
        Journey j = careful.route(query).journeys().get(0);
        assertNull(JourneyChecker.problem(t, query, j));
        assertEquals("K1 K2", trips(j));
        assertEquals(at(10, 30), j.arrive());
        assertEquals(0, j.changes());
        assertTrue(j.legs().get(1).stayAboard());
    }

    @Test
    void aJourneyWithLessWalkingIsRecommendedIfTheWalkCostsMoreThanItSaves() {
        // From M1 the fastest way to N is a 700 m walk (about 15 minutes) to the train at M2, which
        // arrives at 16:30. The bus from M1 itself arrives 10 minutes later with no walking.
        Place m1 = new Place.Point(-33.40, 151.0);
        Query query = router.query(m1, stop("N"), at(16, 0), 8, Router.DEFAULT_MAX_WALK_METRES);
        Result result = router.route(query, Preferences.lessWalking());
        assertEquals(2, result.journeys().size());
        assertEquals("foot MFAST", trips(result.journeys().get(0)));
        assertEquals("lessWalking", result.best().label());
        assertEquals("MSLOW", trips(result.best()));
        assertEquals(at(16, 40), result.best().arrive());
        assertNull(JourneyChecker.problem(t, query, result.best()));

        // Without the second search there is only the fastest to offer.
        Result keen = router.route(query);
        assertEquals(1, keen.journeys().size());
        assertEquals("foot MFAST", trips(keen.best()));
    }

    @Test
    void aMissedConnectionMeansTheNextTrip() {
        // The express has just left B. The stopping train reaches C at 08:20, after X0 left at 08:16.
        Journey j = fastest(stop("B"), stop("E"), at(8, 9) + 30);
        assertEquals("S1 X1", trips(j));
        assertEquals(at(8, 40), j.arrive());
    }

    @Test
    void aWalkBetweenTwoStops() {
        Journey j = fastest(stop("A"), stop("F"), at(8, 0));
        assertEquals("EXP walk W", trips(j));
        assertEquals(at(8, 35), j.arrive());
        Leg walk = j.legs().get(1);
        assertEquals(t.stopIndex("C"), walk.fromStop());
        assertEquals(t.stopIndex("C2"), walk.toStop());
        assertEquals(at(8, 14), walk.depart());
        // About 150 m: 189 s at 1.03 m/s with the 1.3 detour, plus the fixed 30 s, plus 60 s to get
        // off the railway platform at C, which has no pathways.
        assertEquals(279, walk.arrive() - walk.depart(), 3);
        assertEquals(150, walk.metres(), 2);
        assertEquals(walk.arrive() - walk.depart(), j.walkSecs());
    }

    @Test
    void timesRunPastMidnight() {
        Journey j = fastest(stop("D"), stop("E"), at(23, 45));
        assertEquals("N", trips(j));
        assertEquals(at(24, 20), j.arrive());
        assertEquals(Result.Status.NO_JOURNEY, plan(stop("D"), stop("E"), at(24, 10)).status());
    }

    @Test
    void aRunThroughStopCannotBeUsed() {
        // R is the only trip after midday and does not stop at B.
        assertEquals(Result.Status.NO_JOURNEY, plan(stop("A"), stop("B"), at(11, 55)).status());
        assertEquals(Result.Status.NO_JOURNEY, plan(stop("B"), stop("C"), at(11, 55)).status());
        assertEquals("R", trips(fastest(stop("A"), stop("C"), at(11, 55))));
    }

    @Test
    void stayingAboardIsNotAChange() {
        Journey j = fastest(stop("F"), stop("Y"), at(9, 55));
        assertEquals("K1 K2", trips(j));
        assertEquals(at(10, 30), j.arrive());
        assertEquals(2, j.rides());
        assertEquals(0, j.changes());
        assertFalse(j.legs().get(0).stayAboard());
        assertTrue(j.legs().get(1).stayAboard());
    }

    @Test
    void aLoopCanBeRiddenBackToItsStart() {
        Journey j = fastest(stop("L2"), stop("L1"), at(13, 0));
        assertEquals("LOOP", trips(j));
        assertEquals(1, j.legs().get(0).boardPosition());
        assertEquals(3, j.legs().get(0).alightPosition());
        assertEquals(at(13, 30), j.arrive());
        assertEquals(Result.Status.NO_JOURNEY, plan(stop("L3"), stop("L2"), at(13, 0)).status());
    }

    @Test
    void aStationMeansAnyOfItsPlatforms() {
        Journey j = fastest(new Place.Station(t.stationIndex("SX")), stop("Y"), at(13, 55));
        assertEquals("P2", trips(j));
        assertEquals(at(14, 10), j.arrive());

        Journey back = fastest(stop("Y"), new Place.Station(t.stationIndex("SX")), at(14, 55));
        assertEquals("BACK", trips(back));
        assertEquals(at(15, 10), back.arrive());
    }

    @Test
    void aStopMeansItAndTheStopsOneWalkAway() {
        // From platform 1 the quicker trip leaves platform 2, a minute's walk away.
        Journey j = fastest(stop("X1"), stop("Y"), at(13, 55));
        assertEquals("foot P2", trips(j));
        assertEquals(at(14, 10), j.arrive());
        Leg first = j.legs().get(0);
        assertEquals(-1, first.fromStop());
        assertEquals(t.stopIndex("X2"), first.toStop());
        assertEquals(60, first.arrive() - first.depart());

        // To platform 2 the only trip arrives at platform 1.
        Journey back = fastest(stop("Y"), stop("X2"), at(14, 55));
        assertEquals("BACK foot", trips(back));
        assertEquals(at(15, 11), back.arrive());
    }

    @Test
    void aPointOnTheMapWalksToNearbyStops() {
        // 300 m north of A, and 300 m south of D.
        Journey j = fastest(new Place.Point(-32.9973, 151.0), new Place.Point(-33.0627, 151.0), at(7, 50));
        assertEquals("foot EXP foot", trips(j));
        Leg first = j.legs().get(0);
        assertEquals(300, first.metres(), 2);
        // 379 s of walking and 60 s onto the railway platform at A; the same off the one at D.
        assertEquals(439, first.arrive() - first.depart(), 3);
        assertEquals(at(8, 20) + (first.arrive() - first.depart()), j.arrive(), 3);

        // Nothing within walking distance.
        assertEquals(Result.Status.NO_JOURNEY,
                plan(new Place.Point(-32.5, 151.0), stop("D"), at(7, 50)).status());
    }

    @Test
    void twoEndsOneWalkApartCanSimplyBeWalked() {
        Result near = plan(new Place.Point(-33.5, 151.0), new Place.Point(-33.5018, 151.0), at(9, 0));
        assertEquals(List.of("walk"), near.journeys().stream().map(Journey::label).toList());
        assertEquals(200, near.journeys().get(0).legs().get(0).metres(), 2);

        Result platforms = plan(stop("X1"), stop("X2"), at(9, 0));
        assertEquals("walk", platforms.journeys().get(0).label());
        assertEquals(at(9, 1), platforms.journeys().get(0).arrive());

        Result same = plan(stop("A"), stop("A"), at(9, 0));
        assertEquals(at(9, 0), same.journeys().get(0).arrive());
    }

    @Test
    void theJourneyLeavesAsLateAsItCan() {
        // S1 reaches C at 08:20 and S2 at 09:20; LATE leaves C at 09:25. The search rides S1, the
        // first train it can; the answer rides S2, which makes the same connection.
        Journey j = fastest(stop("B"), stop("G"), at(8, 9) + 30);
        assertEquals("S2 LATE", trips(j));
        assertEquals(at(9, 10), j.depart());
        assertEquals(at(9, 40), j.arrive());
        assertEquals(300, j.waitSecs());

        // From a point, the walk to the first stop is timed to meet the train.
        Journey walked = fastest(new Place.Point(-32.9973, 151.0), stop("D"), at(7, 0));
        assertEquals("foot EXP", trips(walked));
        assertEquals(at(8, 5), walked.legs().get(0).arrive());
        assertEquals(walked.legs().get(0).depart(), walked.depart());
        assertEquals(0, walked.waitSecs());
    }

    @Test
    void alternativesThatAreMuchSlowerAreNotOffered() {
        Query query = router.query(stop("A"), stop("E"), at(8, 0), 8, Router.DEFAULT_MAX_WALK_METRES);
        // Z arrives 29 minutes after the two-ride journey and saves one change: offered, and with
        // five minutes charged per vehicle it is not the one recommended.
        Result usual = router.route(query);
        assertEquals(2, usual.journeys().size());
        assertEquals(0, usual.recommended());
        assertEquals("EXP X0", trips(usual.best()));
        // Allow only 20 minutes per ride saved, and Z is not worth showing.
        assertEquals(1, router.route(query, new Preferences(300, 1200)).journeys().size());
        // Charge half an hour per vehicle, and Z becomes the one to take.
        Result patient = router.route(query, new Preferences(1800, 1800));
        assertEquals("Z", trips(patient.best()));
        assertEquals(1, patient.recommended());
    }

    @Test
    void aKindOfVehicleCanBeLeftOut() {
        Query query = router.query(stop("A"), stop("E"), at(8, 0), 8, Router.DEFAULT_MAX_WALK_METRES);
        // Without buses there is no way from C or A to E.
        assertEquals(Result.Status.NO_JOURNEY, router.route(query.avoiding(Set.of(Mode.BUS))).status());
        // Without trains only the slow direct bus is left.
        Result noTrains = router.route(query.avoiding(Set.of(Mode.TRAIN)));
        assertEquals("Z", trips(noTrains.best()));
        assertNull(JourneyChecker.problem(t, query.avoiding(Set.of(Mode.TRAIN)), noTrains.best()));
    }

    @Test
    void theLimitOnRidesIsRespected() {
        Query oneRide = router.query(stop("A"), stop("E"), at(8, 0), 1, Router.DEFAULT_MAX_WALK_METRES);
        Result result = router.route(oneRide);
        assertEquals(1, result.journeys().size());
        assertEquals("Z", trips(result.journeys().get(0)));
        assertEquals("fastest", result.journeys().get(0).label());
    }

    @Test
    void oneRouterServesManyThreadsAtOnce() throws Exception {
        Thread[] threads = new Thread[4];
        String[] answers = new String[threads.length];
        for (int i = 0; i < threads.length; i++) {
            int index = i;
            threads[i] = new Thread(() -> {
                StringBuilder all = new StringBuilder();
                for (int n = 0; n < 200; n++) {
                    all.append(trips(router.route(stop("A"), stop("E"), at(8, 0)).journeys().get(0)));
                    all.append(trips(router.route(stop("A"), stop("F"), at(8, 0)).journeys().get(0)));
                }
                answers[index] = all.toString();
            });
            threads[i].start();
        }
        for (Thread thread : threads) {
            thread.join();
        }
        for (String answer : answers) {
            assertEquals("EXP X0EXP walk W".repeat(200), answer);
        }
    }
}
