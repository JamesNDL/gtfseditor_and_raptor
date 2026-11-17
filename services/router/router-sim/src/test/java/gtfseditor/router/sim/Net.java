package gtfseditor.router.sim;

import gtfseditor.router.core.Geo;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Timetable;
import gtfseditor.router.core.TransferSettings;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds small timetables for tests, in a few words each:
 *
 * <pre>
 * Timetable t = new Net()
 *         .stop("A", 0, 0).stop("B", 5000, 0).stop("C", 10000, 0)   // metres east and north
 *         .line("L", 2, "A B C", "0 10 20", "08:00 08:30")          // capacity, stops, minutes, departures
 *         .build();
 * </pre>
 *
 * Trips are named for their line and departure: {@code L@08:00}. Every line is a bus. Stops within
 * 500 m of each other are linked by a walk at the usual pace, as the loader would link them.
 */
final class Net {

    private static final double LAT = -33.0;
    private static final double LON = 151.0;

    private record Line(String name, int capacity, String[] stops, int[] offsets, int[] departs) {}

    private final List<String> stopIds = new ArrayList<>();
    private final List<double[]> positions = new ArrayList<>();
    private final Map<String, String> parents = new HashMap<>();
    private final List<String> stations = new ArrayList<>();
    private final List<Line> lines = new ArrayList<>();
    private final Map<String, String> runsOn = new HashMap<>();

    /** A stop this many metres east and north of the corner of the map. */
    Net stop(String id, double east, double north) {
        stopIds.add(id);
        positions.add(new double[] {LAT + north / Geo.METRES_PER_DEGREE,
                LON + east / (Geo.METRES_PER_DEGREE * Math.cos(Math.toRadians(LAT)))});
        return this;
    }

    /** Puts stops under one parent stop. */
    Net station(String id, String... stops) {
        stations.add(id);
        for (String stop : stops) {
            parents.put(stop, id);
        }
        return this;
    }

    /**
     * @param stops   the stops in order, separated by spaces
     * @param offsets minutes from the first stop to each stop
     * @param departs when each trip leaves the first stop, as {@code HH:MM}
     */
    Net line(String name, int capacity, String stops, String offsets, String departs) {
        String[] offsetTexts = offsets.split(" ");
        int[] minutes = new int[offsetTexts.length];
        for (int i = 0; i < minutes.length; i++) {
            minutes[i] = Integer.parseInt(offsetTexts[i]);
        }
        String[] departTexts = departs.split(" ");
        int[] times = new int[departTexts.length];
        for (int i = 0; i < times.length; i++) {
            times[i] = Clock.parse(departTexts[i]);
        }
        return line(name, capacity, stops.split(" "), minutes, times);
    }

    /** The same with the times as numbers: minutes to each stop, and departures in seconds. */
    Net line(String name, int capacity, String[] stops, int[] offsetMinutes, int[] departSecs) {
        lines.add(new Line(name, capacity, stops, offsetMinutes, departSecs));
        return this;
    }

    /** The vehicle of one trip runs on as another: passengers may stay aboard. */
    Net runsOn(String trip, String next) {
        runsOn.put(trip, next);
        return this;
    }

    static String tripId(String line, int departSecs) {
        return line + "@" + Clock.text(departSecs).substring(0, 5);
    }

    Timetable build() {
        Timetable.Builder b = new Timetable.Builder();
        b.serviceDate = 20261117;
        int stops = stopIds.size();
        b.stationIds = stations.toArray(new String[0]);
        b.stationNames = stations.toArray(new String[0]);
        b.stopIds = stopIds.toArray(new String[0]);
        b.stopNames = stopIds.toArray(new String[0]);
        b.stopLat = new double[stops];
        b.stopLon = new double[stops];
        b.stopStation = new int[stops];
        Map<String, Integer> stopNumber = new HashMap<>();
        for (int s = 0; s < stops; s++) {
            b.stopLat[s] = positions.get(s)[0];
            b.stopLon[s] = positions.get(s)[1];
            b.stopStation[s] = stations.indexOf(parents.get(stopIds.get(s)));
            stopNumber.put(stopIds.get(s), s);
        }
        int routes = lines.size();
        b.routeIds = new String[routes];
        b.routeNames = new String[routes];
        b.routeTypes = new int[routes];
        b.patternStopOffset = new int[routes + 1];
        b.patternTripOffset = new int[routes + 1];
        List<Integer> patternStops = new ArrayList<>();
        List<Integer> times = new ArrayList<>();
        List<String> tripIds = new ArrayList<>();
        List<Integer> tripRoute = new ArrayList<>();
        List<Integer> tripCapacity = new ArrayList<>();
        for (int r = 0; r < routes; r++) {
            Line line = lines.get(r);
            b.routeIds[r] = line.name();
            b.routeNames[r] = line.name();
            b.routeTypes[r] = 3;
            for (String stop : line.stops()) {
                Integer number = stopNumber.get(stop);
                if (number == null) {
                    throw new IllegalArgumentException("line " + line.name() + " calls at unknown stop " + stop);
                }
                patternStops.add(number);
            }
            for (int depart : line.departs()) {
                tripIds.add(tripId(line.name(), depart));
                tripRoute.add(r);
                tripCapacity.add(line.capacity());
                for (int offset : line.offsets()) {
                    times.add(depart + offset * 60);
                }
            }
            b.patternStopOffset[r + 1] = patternStops.size();
            b.patternTripOffset[r + 1] = tripIds.size();
        }
        b.patternStops = patternStops.stream().mapToInt(Integer::intValue).toArray();
        b.patternStopFlags = new byte[b.patternStops.length];
        java.util.Arrays.fill(b.patternStopFlags, (byte) (Timetable.BOARD | Timetable.ALIGHT));
        b.arrive = times.stream().mapToInt(Integer::intValue).toArray();
        b.depart = b.arrive.clone();
        b.tripIds = tripIds.toArray(new String[0]);
        b.tripHeadsigns = tripIds.toArray(new String[0]);
        b.tripRoute = tripRoute.stream().mapToInt(Integer::intValue).toArray();
        b.tripCapacity = tripCapacity.stream().mapToInt(Integer::intValue).toArray();
        b.tripCapacityFlags = new byte[tripIds.size()];
        b.tripStayAboard = new int[tripIds.size()];
        java.util.Arrays.fill(b.tripStayAboard, -1);
        runsOn.forEach((trip, next) -> b.tripStayAboard[tripIds.indexOf(trip)] = tripIds.indexOf(next));

        TransferSettings walking = TransferSettings.defaults();
        b.transferSettings = walking;
        b.transferOffset = new int[stops + 1];
        List<int[]> links = new ArrayList<>();
        for (int from = 0; from < stops; from++) {
            for (int to = 0; to < stops; to++) {
                double metres = Geo.metresBetween(b.stopLat[from], b.stopLon[from], b.stopLat[to], b.stopLon[to]);
                boolean together = b.stopStation[from] >= 0 && b.stopStation[from] == b.stopStation[to];
                if (from != to && (metres <= walking.radiusMetres() || (together && metres <= walking.stationMaxMetres()))) {
                    links.add(new int[] {to, Math.max(walking.walkSecs(metres), together ? walking.stationMinSecs() : 0),
                            (int) Math.round(metres)});
                }
            }
            b.transferOffset[from + 1] = links.size();
        }
        b.transferTargets = links.stream().mapToInt(link -> link[0]).toArray();
        b.transferSecs = links.stream().mapToInt(link -> link[1]).toArray();
        b.transferMetres = links.stream().mapToInt(link -> link[2]).toArray();
        return b.build();
    }

    /** One settled journey, as a {@link Sink} hears it. */
    record Settled(int row, int people, byte status, List<Leg> legs, int leftBehind, int strandedStop,
            int strandedTime) {

        /** The ids of the trips ridden, in order. */
        List<String> trips(Timetable t) {
            List<String> ids = new ArrayList<>();
            for (Leg leg : legs) {
                if (leg.kind() == Leg.Kind.RIDE) {
                    ids.add(t.tripIds[leg.trip()]);
                }
            }
            return ids;
        }

        int arrive() {
            return legs.get(legs.size() - 1).arrive();
        }
    }

    /** A sink that keeps everything it hears. */
    static final class Collector implements Sink {
        final List<Settled> settled = new ArrayList<>();

        @Override
        public void settled(int row, int people, byte status, List<Leg> legs, int leftBehind, int strandedStop,
                int strandedTime) {
            settled.add(new Settled(row, people, status, List.copyOf(legs), leftBehind, strandedStop, strandedTime));
        }

        /** Everything settled for one row. */
        List<Settled> of(int row) {
            return settled.stream().filter(s -> s.row() == row).toList();
        }

        /** The one journey of a row that was not split. */
        Settled only(int row) {
            List<Settled> parts = of(row);
            if (parts.size() != 1) {
                throw new AssertionError("row " + row + " was settled " + parts.size() + " times");
            }
            return parts.get(0);
        }
    }

    /** A run in memory: its plans, what happened, and every settled journey. */
    record Ran(Plans plans, Simulation.Outcome outcome, Collector journeys) {}

    /** Plans and travels. {@code reference} null makes it a BAU run. */
    static Ran run(Timetable t, Demand demand, SimSettings settings, Plans reference) {
        try (Simulation simulation = new Simulation(new gtfseditor.router.core.Router(t), demand, settings)) {
            Plans plans = simulation.plan(reference, Progress.NONE);
            Collector collector = new Collector();
            return new Ran(plans, simulation.travel(plans, collector, Progress.NONE), collector);
        } catch (InterruptedException e) {
            throw new AssertionError(e);
        }
    }

    /** A demand set from rows of {@code user, start, from, to, people}, located on a timetable. */
    static Demand demand(Timetable published, Object[]... rows) {
        Demand.Builder builder = new Demand.Builder();
        for (Object[] row : rows) {
            builder.add((String) row[0], null, Clock.parse((String) row[1]), (String) row[2], Double.NaN, Double.NaN,
                    (String) row[3], Double.NaN, Double.NaN, row.length > 4 ? (Integer) row[4] : 1);
        }
        return builder.build().located(published, new DemandReport());
    }

    static Object[] row(Object... values) {
        return values;
    }
}
