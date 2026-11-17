package gtfseditor.router.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Plans journeys on one timetable. Safe to share between threads: each thread gets its own working
 * memory the first time it asks.
 *
 * <pre>
 * Router router = new Router(timetable);
 * Result result = router.route(new Place.Stop(a), new Place.Point(lat, lon), 7 * 3600 + 45 * 60);
 * </pre>
 */
public final class Router {

    public static final int DEFAULT_MAX_RIDES = 8;
    /**
     * How far a journey may walk to its first stop or from its last, in a straight line. With the
     * detour that is about 1.5 km on the ground, the longest the TfNSW trip planner offered.
     */
    public static final double DEFAULT_MAX_WALK_METRES = 1200;
    /** Kinds of vehicle a query leaves out unless it says otherwise: school buses. */
    public static final java.util.Set<Mode> DEFAULT_AVOID = java.util.Set.of(Mode.SCHOOL_BUS);

    private final Timetable t;
    private final int maxRides;
    private final int changeSecs;
    private final StopFinder finder;
    private final ThreadLocal<Search> searches;

    // The walking links again, grouped by the stop they lead to.
    private final int[] linkInOffset;
    private final int[] linkInFrom;
    private final int[] linkInSecs;
    private final int[] linkInMetres;

    // The stops of each station.
    private final int[] stationStopOffset;
    private final int[] stationStops;

    public Router(Timetable timetable) {
        this(timetable, DEFAULT_MAX_RIDES);
    }

    /** @param maxRides the most rides any query on this router may ask for */
    public Router(Timetable timetable, int maxRides) {
        this(timetable, maxRides, Query.DEFAULT_CHANGE_SECS);
    }

    /**
     * @param maxRides   the most rides any query on this router may ask for
     * @param changeSecs least time to change vehicles at one stop, for queries this router builds
     */
    public Router(Timetable timetable, int maxRides, int changeSecs) {
        if (maxRides < 1) {
            throw new IllegalArgumentException("a journey needs at least one ride");
        }
        if (changeSecs < 0) {
            throw new IllegalArgumentException("the time to change cannot be negative");
        }
        this.changeSecs = changeSecs;
        this.t = timetable;
        this.maxRides = maxRides;
        this.finder = new StopFinder(timetable);
        this.searches = ThreadLocal.withInitial(() -> new Search(timetable, maxRides));

        int stops = t.stopCount();
        linkInOffset = new int[stops + 1];
        for (int target : t.transferTargets) {
            linkInOffset[target + 1]++;
        }
        for (int s = 0; s < stops; s++) {
            linkInOffset[s + 1] += linkInOffset[s];
        }
        linkInFrom = new int[t.transferCount()];
        linkInSecs = new int[t.transferCount()];
        linkInMetres = new int[t.transferCount()];
        int[] next = linkInOffset.clone();
        for (int from = 0; from < stops; from++) {
            for (int j = t.transferOffset[from]; j < t.transferOffset[from + 1]; j++) {
                int slot = next[t.transferTargets[j]]++;
                linkInFrom[slot] = from;
                linkInSecs[slot] = t.transferSecs[j];
                linkInMetres[slot] = t.transferMetres[j];
            }
        }

        stationStopOffset = new int[t.stationCount() + 1];
        for (int station : t.stopStation) {
            if (station >= 0) {
                stationStopOffset[station + 1]++;
            }
        }
        for (int s = 0; s < t.stationCount(); s++) {
            stationStopOffset[s + 1] += stationStopOffset[s];
        }
        stationStops = new int[stationStopOffset[t.stationCount()]];
        int[] nextStop = stationStopOffset.clone();
        for (int stop = 0; stop < stops; stop++) {
            if (t.stopStation[stop] >= 0) {
                stationStops[nextStop[t.stopStation[stop]]++] = stop;
            }
        }
    }

    public Timetable timetable() {
        return t;
    }

    public int maxRides() {
        return maxRides;
    }

    /** Plans a journey with the default limits on rides and walking. */
    public Result route(Place from, Place to, int depart) {
        return route(query(from, to, depart, maxRides, DEFAULT_MAX_WALK_METRES));
    }

    /** Runs a query with the default preferences. */
    public Result route(Query query) {
        return route(query, Preferences.defaults());
    }

    /** Runs a query, ignoring how full the vehicles are. */
    public Result route(Query query, Preferences preferences) {
        return route(query, preferences, Capacity.OFF);
    }

    /**
     * Runs a query. Its limit on rides is lowered to this router's if it is higher.
     *
     * <p>With loads to respect, or boardings refused, a trip the passenger may not board at a stop
     * is passed over there. If that leaves no journey where there would otherwise be one, the
     * result says {@link Result.Status#STRANDED}.
     */
    public Result route(Query query, Preferences preferences, Capacity capacity) {
        for (Access access : query.access()) {
            checkStop(access.stop());
        }
        for (Access egress : query.egress()) {
            checkStop(egress.stop());
        }
        long started = System.nanoTime();
        Search search = searches.get();
        Result full = search.run(query, preferences, capacity);
        if (full.journeys().isEmpty() && capacity.limited()) {
            Result free = search.run(query, preferences, Capacity.OFF);
            return new Result(free.journeys().isEmpty() ? Result.Status.NO_JOURNEY : Result.Status.STRANDED,
                    List.of(), -1, full.rounds() + free.rounds(), full.patternsScanned() + free.patternsScanned(),
                    System.nanoTime() - started);
        }
        if (preferences.lessWalkEndSecs() <= 0 || full.journeys().isEmpty()
                || walksWithin(full.journeys(), preferences)) {
            return full;
        }
        // Search again with shorter walks, and offer the best of that if it beats everything so far.
        Query shorter = query.withWalksUpTo(preferences.lessWalkEndSecs(), preferences.lessWalkLinkSecs());
        if (shorter.access().isEmpty() || shorter.egress().isEmpty()) {
            return full;
        }
        Result less = search.run(shorter, preferences, capacity);
        Journey found = less.best();
        List<Journey> journeys = full.journeys();
        int recommended = full.recommended();
        if (found != null && found.rides() > 0 && preferences.cost(found) < preferences.cost(full.best())) {
            journeys = new ArrayList<>(journeys);
            journeys.add(found.labelled("lessWalking"));
            recommended = journeys.size() - 1;
        }
        return new Result(full.status(), journeys, recommended, full.rounds() + less.rounds(),
                full.patternsScanned() + less.patternsScanned(), System.nanoTime() - started);
    }

    /** Whether no journey walks further than the second search would allow, so that it would find nothing new. */
    private static boolean walksWithin(List<Journey> journeys, Preferences preferences) {
        for (Journey journey : journeys) {
            for (Leg leg : journey.legs()) {
                int secs = leg.arrive() - leg.depart();
                if ((leg.kind() == Leg.Kind.WALK && secs > preferences.lessWalkEndSecs())
                        || (leg.kind() == Leg.Kind.TRANSFER && secs > preferences.lessWalkLinkSecs())) {
                    return false;
                }
            }
        }
        return true;
    }

    private void checkStop(int stop) {
        if (stop >= t.stopCount()) {
            throw new IllegalArgumentException("there is no stop numbered " + stop);
        }
    }

    /**
     * Turns two places into a query: which stops the journey may start and end at, and the walk to
     * and from each.
     *
     * <ul>
     *   <li>A stop: that stop, and every stop one walking link away.
     *   <li>A station: the same for each of its stops.
     *   <li>A point: every stop within {@code maxWalkMetres} in a straight line, walked at the
     *       timetable's walking speed and detour factor.
     * </ul>
     */
    public Query query(Place from, Place to, int depart, int maxRides, double maxWalkMetres) {
        Map<Integer, Access> access = reach(from, true, maxWalkMetres);
        Map<Integer, Access> egress = reach(to, false, maxWalkMetres);

        // Walking the whole way is on offer when the two ends are one walk apart.
        int directSecs = -1;
        int directMetres = 0;
        if (from instanceof Place.Point a && to instanceof Place.Point b) {
            double metres = Geo.metresBetween(a.lat(), a.lon(), b.lat(), b.lon());
            if (metres <= maxWalkMetres) {
                directSecs = pointWalkSecs(metres);
                directMetres = (int) Math.round(metres);
            }
        } else {
            for (Access in : access.values()) {
                Access out = egress.get(in.stop());
                if (out != null && (in.secs() == 0 || out.secs() == 0)
                        && (directSecs < 0 || in.secs() + out.secs() < directSecs)) {
                    directSecs = in.secs() + out.secs();
                    directMetres = in.metres() + out.metres();
                }
            }
        }
        return new Query(new ArrayList<>(access.values()), new ArrayList<>(egress.values()), depart,
                Math.min(maxRides, this.maxRides), directSecs, directMetres, DEFAULT_AVOID, changeSecs);
    }

    private int pointWalkSecs(double metres) {
        TransferSettings s = t.transferSettings;
        return (int) Math.ceil(metres * s.detourFactor() / s.walkMetresPerSec());
    }

    /** The stops a place gives access to, by stop number, each with its quickest walk. */
    private Map<Integer, Access> reach(Place place, boolean leaving, double maxWalkMetres) {
        Map<Integer, Access> reach = new TreeMap<>();
        switch (place) {
            case Place.Stop s -> {
                if (s.stop() < 0 || s.stop() >= t.stopCount()) {
                    throw new IllegalArgumentException("there is no stop numbered " + s.stop());
                }
                reachStop(reach, s.stop(), leaving);
            }
            case Place.Station s -> {
                if (s.station() < 0 || s.station() >= t.stationCount()) {
                    throw new IllegalArgumentException("there is no station numbered " + s.station());
                }
                for (int i = stationStopOffset[s.station()]; i < stationStopOffset[s.station() + 1]; i++) {
                    reachStop(reach, stationStops[i], leaving);
                }
            }
            case Place.Point p -> {
                for (StopFinder.Near near : finder.near(p.lat(), p.lon(), maxWalkMetres)) {
                    offer(reach, new Access(near.stop(), pointWalkSecs(near.metres()),
                            (int) Math.round(near.metres())));
                }
            }
        }
        return reach;
    }

    private void reachStop(Map<Integer, Access> reach, int stop, boolean leaving) {
        offer(reach, new Access(stop, 0, 0));
        if (leaving) {
            for (int j = t.transferOffset[stop]; j < t.transferOffset[stop + 1]; j++) {
                offer(reach, new Access(t.transferTargets[j], t.transferSecs[j], t.transferMetres[j]));
            }
        } else {
            for (int j = linkInOffset[stop]; j < linkInOffset[stop + 1]; j++) {
                offer(reach, new Access(linkInFrom[j], linkInSecs[j], linkInMetres[j]));
            }
        }
    }

    private static void offer(Map<Integer, Access> reach, Access access) {
        Access known = reach.get(access.stop());
        if (known == null || access.secs() < known.secs()) {
            reach.put(access.stop(), access);
        }
    }
}
