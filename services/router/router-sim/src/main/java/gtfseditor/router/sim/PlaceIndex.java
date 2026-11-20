package gtfseditor.router.sim;

import gtfseditor.router.core.Access;
import gtfseditor.router.core.Geo;
import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicReferenceArray;

/**
 * The places of a demand set as one timetable sees them: which stops count as a person's own, and
 * which are near enough to walk to. See section 4.6 of docs/simulator-plan.md.
 *
 * <ul>
 *   <li><b>Own stops.</b> The stop with the place's id, at no walk, and the other stops under the
 *       same parent stop that the timetable links to it, at that link's walking time. For a station
 *       id, every stop of the station at no walk. None if the timetable does not have the id.
 *   <li><b>Any stop near.</b> Every stop within the walking distance of the place's position, at
 *       the walk from that position, and the own stops as above. A stop across water is left out
 *       unless a bridge keeps the walk within the distance. Where the place is a platform, the
 *       walk to any stop outside its station also takes the platform's time to the street.
 * </ul>
 *
 * <p>Safe to share between threads.
 */
final class PlaceIndex {

    private final Router router;
    private final Timetable t;
    private final Demand demand;
    private final double walkMetres;
    private final int maxRides;
    private final int changeSecs;
    private final Set<Mode> avoid;

    /** Each place's own stops, in stop order; empty if the timetable does not have its id. */
    private final int[][] ownStops;
    private final AtomicReferenceArray<List<Access>> ownAccess;
    private final AtomicReferenceArray<List<Access>> ownEgress;
    private final AtomicReferenceArray<List<Access>> nearAccess;
    private final AtomicReferenceArray<List<Access>> nearEgress;

    PlaceIndex(Router router, Demand demand, SimSettings settings) {
        this.router = router;
        this.t = router.timetable();
        this.demand = demand;
        this.walkMetres = settings.walkMetres;
        this.maxRides = Math.min(settings.maxRides, router.maxRides());
        this.changeSecs = settings.changeSecs;
        this.avoid = settings.schoolBuses ? Set.of() : EnumSet.of(Mode.SCHOOL_BUS);
        int places = demand.placeCount();
        ownAccess = new AtomicReferenceArray<>(places);
        ownEgress = new AtomicReferenceArray<>(places);
        nearAccess = new AtomicReferenceArray<>(places);
        nearEgress = new AtomicReferenceArray<>(places);

        int[] stationStopOffset = new int[t.stationCount() + 1];
        for (int station : t.stopStation) {
            if (station >= 0) {
                stationStopOffset[station + 1]++;
            }
        }
        for (int s = 0; s < t.stationCount(); s++) {
            stationStopOffset[s + 1] += stationStopOffset[s];
        }
        int[] stationStops = new int[stationStopOffset[t.stationCount()]];
        int[] next = stationStopOffset.clone();
        for (int stop = 0; stop < t.stopCount(); stop++) {
            if (t.stopStation[stop] >= 0) {
                stationStops[next[t.stopStation[stop]]++] = stop;
            }
        }

        ownStops = new int[places][];
        for (int place = 0; place < places; place++) {
            String id = demand.placeStop[place];
            Map<Integer, Access> out = new TreeMap<>();
            Map<Integer, Access> in = new TreeMap<>();
            int stop = id.isEmpty() ? -1 : t.stopIndex(id);
            int station = id.isEmpty() || stop >= 0 ? -1 : t.stationIndex(id);
            if (stop >= 0) {
                out.put(stop, new Access(stop, 0, 0));
                in.put(stop, new Access(stop, 0, 0));
                int parent = t.stopStation[stop];
                if (parent >= 0) {
                    for (int j = t.transferOffset[stop]; j < t.transferOffset[stop + 1]; j++) {
                        int other = t.transferTargets[j];
                        if (other != stop && t.stopStation[other] == parent) {
                            offer(out, new Access(other, t.transferSecs[j], t.transferMetres[j]));
                        }
                    }
                    for (int i = stationStopOffset[parent]; i < stationStopOffset[parent + 1]; i++) {
                        int other = stationStops[i];
                        for (int j = t.transferOffset[other]; other != stop && j < t.transferOffset[other + 1]; j++) {
                            if (t.transferTargets[j] == stop) {
                                offer(in, new Access(other, t.transferSecs[j], t.transferMetres[j]));
                            }
                        }
                    }
                }
            } else if (station >= 0) {
                for (int i = stationStopOffset[station]; i < stationStopOffset[station + 1]; i++) {
                    out.put(stationStops[i], new Access(stationStops[i], 0, 0));
                    in.put(stationStops[i], new Access(stationStops[i], 0, 0));
                }
            }
            ownAccess.set(place, List.copyOf(out.values()));
            ownEgress.set(place, List.copyOf(in.values()));
            Set<Integer> either = new java.util.TreeSet<>(out.keySet());
            either.addAll(in.keySet());
            ownStops[place] = either.stream().mapToInt(Integer::intValue).toArray();
        }
    }

    private static void offer(Map<Integer, Access> reach, Access access) {
        Access known = reach.get(access.stop());
        if (known == null || access.secs() < known.secs()) {
            reach.put(access.stop(), access);
        }
    }

    Timetable timetable() {
        return t;
    }

    Set<Mode> avoid() {
        return avoid;
    }

    /** Whether the timetable has the place's own stop. */
    boolean hasOwn(int place) {
        return ownStops[place].length > 0;
    }

    /** Whether a stop is one of the place's own. */
    boolean isOwn(int place, int stop) {
        return Arrays.binarySearch(ownStops[place], stop) >= 0;
    }

    /** The stops a journey from the place may start at: its own, or any near. */
    List<Access> access(int place, boolean near) {
        return near ? near(place, nearAccess, ownAccess, true) : ownAccess.get(place);
    }

    /** The stops a journey to the place may end at: its own, or any near. */
    List<Access> egress(int place, boolean near) {
        return near ? near(place, nearEgress, ownEgress, false) : ownEgress.get(place);
    }

    private List<Access> near(int place, AtomicReferenceArray<List<Access>> cache,
            AtomicReferenceArray<List<Access>> own, boolean leaving) {
        List<Access> known = cache.get(place);
        if (known != null) {
            return known;
        }
        Map<Integer, Access> reach = new TreeMap<>();
        if (walkMetres > 0) {
            // A place that is a platform is that much further from every stop outside its station.
            int platform = platformSecs(place, leaving);
            int parent = platform > 0 ? t.stopStation[t.stopIndex(demand.placeStop[place])] : -1;
            for (Access access : router.near(demand.placeLat[place], demand.placeLon[place], walkMetres, leaving)) {
                boolean outside = platform > 0 && (parent < 0 || t.stopStation[access.stop()] != parent);
                reach.put(access.stop(), outside
                        ? new Access(access.stop(), access.secs() + platform, access.metres()) : access);
            }
        }
        for (Access access : own.get(place)) {
            offer(reach, access);
        }
        List<Access> found = List.copyOf(reach.values());
        cache.set(place, found); // two threads may both work it out; they get the same answer
        return found;
    }

    /**
     * The time between a place and the street, where the place is a stop of the timetable that
     * takes time to leave or reach and stands where that stop does; otherwise 0.
     */
    private int platformSecs(int place, boolean leaving) {
        String id = demand.placeStop[place];
        int stop = id.isEmpty() ? -1 : t.stopIndex(id);
        if (stop < 0 || Geo.metresBetween(demand.placeLat[place], demand.placeLon[place], t.stopLat[stop],
                t.stopLon[stop]) > 50) {
            return 0;
        }
        return leaving ? t.stopExitSecs[stop] : t.stopEntrySecs[stop];
    }

    /**
     * The question of how to get from one place to another, setting off at a time.
     *
     * @param near false to keep to the person's own stops; true to use any stop near either end,
     *             and to walk the whole way if the two places are within the walking distance
     * @return null if there is no stop to start from or none to end at
     */
    Query query(int from, int to, int depart, boolean near) {
        List<Access> access = access(from, near);
        List<Access> egress = egress(to, near);
        if (access.isEmpty() || egress.isEmpty()) {
            return null;
        }
        int directSecs = -1;
        int directMetres = 0;
        if (near) {
            double metres = router.walkMetres(demand.placeLat[from], demand.placeLon[from], demand.placeLat[to],
                    demand.placeLon[to]);
            if (metres >= 0 && metres <= walkMetres) {
                directSecs = router.pointWalkSecs(metres) + platformSecs(from, true) + platformSecs(to, false);
                directMetres = (int) Math.round(metres);
            }
        }
        return new Query(access, egress, depart, maxRides, directSecs, directMetres, avoid, changeSecs);
    }

    /**
     * The question a person left behind at a stop asks: from where they stand to the same end as
     * before. Where they stand is that stop, or another stop of the same parent at the walk between
     * the two, as for a person's own stop: someone left on a platform may take a train from the
     * next one. They do not walk off to another stop nearby.
     */
    Query queryFromStop(int stop, int to, int depart, boolean near) {
        List<Access> access = new ArrayList<>();
        access.add(new Access(stop, 0, 0));
        int parent = t.stopStation[stop];
        for (int j = t.transferOffset[stop]; parent >= 0 && j < t.transferOffset[stop + 1]; j++) {
            int other = t.transferTargets[j];
            if (other != stop && t.stopStation[other] == parent) {
                access.add(new Access(other, t.transferSecs[j], t.transferMetres[j]));
            }
        }
        return new Query(access, egress(to, near), depart, maxRides, -1, 0, avoid, changeSecs);
    }
}
