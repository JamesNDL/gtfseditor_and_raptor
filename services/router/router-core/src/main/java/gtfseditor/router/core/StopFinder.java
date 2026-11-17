package gtfseditor.router.core;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Finds the stops near a point, using a grid laid over the map. */
final class StopFinder {

    /** A stop and its straight-line distance from the point asked about. */
    record Near(int stop, double metres) {}

    private static final double CELL_DEGREES = 0.005; // about 550 m north to south

    private final Timetable t;
    private final Map<Long, int[]> cells = new HashMap<>();

    StopFinder(Timetable t) {
        this.t = t;
        Map<Long, List<Integer>> building = new HashMap<>();
        for (int stop = 0; stop < t.stopCount(); stop++) {
            building.computeIfAbsent(cell(row(t.stopLat[stop]), row(t.stopLon[stop])), k -> new ArrayList<>())
                    .add(stop);
        }
        for (Map.Entry<Long, List<Integer>> entry : building.entrySet()) {
            cells.put(entry.getKey(), entry.getValue().stream().mapToInt(Integer::intValue).toArray());
        }
    }

    private static int row(double degrees) {
        return (int) Math.floor(degrees / CELL_DEGREES);
    }

    private static long cell(int y, int x) {
        return ((long) y << 32) | (x & 0xffffffffL);
    }

    /** Every stop within a distance of a point, in stop order. */
    List<Near> near(double lat, double lon, double radiusMetres) {
        double reachLat = radiusMetres / Geo.METRES_PER_DEGREE;
        double reachLon = reachLat / Math.max(0.01, Math.cos(Math.toRadians(lat)));
        List<Near> found = new ArrayList<>();
        for (int y = row(lat - reachLat); y <= row(lat + reachLat); y++) {
            for (int x = row(lon - reachLon); x <= row(lon + reachLon); x++) {
                int[] stops = cells.get(cell(y, x));
                if (stops == null) {
                    continue;
                }
                for (int stop : stops) {
                    double metres = Geo.metresBetween(lat, lon, t.stopLat[stop], t.stopLon[stop]);
                    if (metres <= radiusMetres) {
                        found.add(new Near(stop, metres));
                    }
                }
            }
        }
        found.sort((a, b) -> Integer.compare(a.stop(), b.stop()));
        return found;
    }
}
