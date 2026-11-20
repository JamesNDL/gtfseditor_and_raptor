package gtfseditor.router.core;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Where a straight walk would cross water. The router has no map of the land, so this is worked
 * out from what a timetable's source can supply: the paths ferries sail (water lines), and the
 * places where a bridge that can be walked crosses one (bridges).
 *
 * <p>A walk is over water when its straight line comes within {@link #MARGIN_METRES} of a water
 * line. It may then go by a bridge instead: to the bridge in a straight line and on from it in
 * another, if neither of those is over water. Whoever supplies the lines leaves a gap in them at
 * each bridge and round each wharf, so that walks onto a bridge or up to a wharf are not refused.
 *
 * <p>Water that no ferry sails is not known about, and a walk across it is still offered.
 *
 * <p>Never changes after it is built, so it can be shared between threads.
 */
public final class Water {

    /** A walk whose straight line comes this close to a water line is over water. */
    public static final double MARGIN_METRES = 20;

    private static final double CELL_DEGREES = 0.005; // about 550 m north to south

    /** Knows of no water: every walk is the straight line. */
    public static final Water NONE = new Water(new double[0], new double[0]);

    /** Four numbers per piece of water line: latitude and longitude of one end, then of the other. */
    public final double[] lines;
    /** Two numbers per bridge: latitude, longitude. */
    public final double[] bridges;

    private final Map<Long, int[]> cells = new HashMap<>();

    public Water(double[] lines, double[] bridges) {
        if (lines.length % 4 != 0 || bridges.length % 2 != 0) {
            throw new IllegalArgumentException("water lines come in fours and bridges in twos");
        }
        for (double number : lines) {
            if (!Double.isFinite(number)) {
                throw new IllegalArgumentException("a water line has a position that is not a number");
            }
        }
        for (double number : bridges) {
            if (!Double.isFinite(number)) {
                throw new IllegalArgumentException("a bridge has a position that is not a number");
            }
        }
        this.lines = lines;
        this.bridges = bridges;
        Map<Long, List<Integer>> building = new HashMap<>();
        for (int i = 0; i < lines.length; i += 4) {
            int south = row(Math.min(lines[i], lines[i + 2]));
            int north = row(Math.max(lines[i], lines[i + 2]));
            int west = row(Math.min(lines[i + 1], lines[i + 3]));
            int east = row(Math.max(lines[i + 1], lines[i + 3]));
            if ((long) (north - south + 1) * (east - west + 1) > 10_000) {
                throw new IllegalArgumentException("a piece of water line is too long; cut it into shorter pieces");
            }
            for (int y = south; y <= north; y++) {
                for (int x = west; x <= east; x++) {
                    building.computeIfAbsent(cell(y, x), k -> new ArrayList<>()).add(i);
                }
            }
        }
        for (Map.Entry<Long, List<Integer>> entry : building.entrySet()) {
            cells.put(entry.getKey(), entry.getValue().stream().mapToInt(Integer::intValue).toArray());
        }
    }

    /** Whether there is nothing to test against. */
    public boolean isEmpty() {
        return lines.length == 0;
    }

    public int lineCount() {
        return lines.length / 4;
    }

    public int bridgeCount() {
        return bridges.length / 2;
    }

    private static int row(double degrees) {
        return (int) Math.floor(degrees / CELL_DEGREES);
    }

    private static long cell(int y, int x) {
        return ((long) y << 32) | (x & 0xffffffffL);
    }

    /**
     * How far it is on foot between two points, as straight lines: the one straight line, or by
     * way of the bridge that makes the shortest walk when that line is over water.
     *
     * @return metres, or -1 if the line is over water and no bridge gets round it
     */
    public double walkMetres(double lat1, double lon1, double lat2, double lon2) {
        double straight = Geo.metresBetween(lat1, lon1, lat2, lon2);
        if (lines.length == 0 || !overWater(lat1, lon1, lat2, lon2)) {
            return straight;
        }
        double best = -1;
        for (int i = 0; i < bridges.length; i += 2) {
            double first = Geo.metresBetween(lat1, lon1, bridges[i], bridges[i + 1]);
            double second = Geo.metresBetween(bridges[i], bridges[i + 1], lat2, lon2);
            // No bridge is worth more than a few times the straight line; the caller has its own limit too.
            if ((best >= 0 && first + second >= best) || first + second > straight * 3 + 2000) {
                continue;
            }
            if (!overWater(lat1, lon1, bridges[i], bridges[i + 1]) && !overWater(bridges[i], bridges[i + 1], lat2, lon2)) {
                best = first + second;
            }
        }
        return best;
    }

    /** Whether the straight line between two points comes within the margin of a water line. */
    public boolean overWater(double lat1, double lon1, double lat2, double lon2) {
        if (lines.length == 0) {
            return false;
        }
        double reachLat = MARGIN_METRES / Geo.METRES_PER_DEGREE;
        double middle = (lat1 + lat2) / 2;
        double east = Math.max(0.01, Math.cos(Math.toRadians(middle))); // metres per degree of longitude, as a share
        double reachLon = reachLat / east;
        int south = row(Math.min(lat1, lat2) - reachLat);
        int north = row(Math.max(lat1, lat2) + reachLat);
        int west = row(Math.min(lon1, lon2) - reachLon);
        int eastCell = row(Math.max(lon1, lon2) + reachLon);
        // Flat metres measured from the walk's first point: good to well under a metre over the few
        // kilometres a walk can be.
        double bx = (lon2 - lon1) * east * Geo.METRES_PER_DEGREE;
        double by = (lat2 - lat1) * Geo.METRES_PER_DEGREE;
        for (int y = south; y <= north; y++) {
            for (int x = west; x <= eastCell; x++) {
                int[] pieces = cells.get(cell(y, x));
                if (pieces == null) {
                    continue;
                }
                for (int i : pieces) {
                    double cx = (lines[i + 1] - lon1) * east * Geo.METRES_PER_DEGREE;
                    double cy = (lines[i] - lat1) * Geo.METRES_PER_DEGREE;
                    double dx = (lines[i + 3] - lon1) * east * Geo.METRES_PER_DEGREE;
                    double dy = (lines[i + 2] - lat1) * Geo.METRES_PER_DEGREE;
                    if (apart(0, 0, bx, by, cx, cy, dx, dy) <= MARGIN_METRES) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /** The least distance between two straight pieces, A to B and C to D, on a flat sheet. */
    static double apart(double ax, double ay, double bx, double by, double cx, double cy, double dx, double dy) {
        if (crosses(ax, ay, bx, by, cx, cy, dx, dy)) {
            return 0;
        }
        return Math.min(Math.min(fromPoint(ax, ay, cx, cy, dx, dy), fromPoint(bx, by, cx, cy, dx, dy)),
                Math.min(fromPoint(cx, cy, ax, ay, bx, by), fromPoint(dx, dy, ax, ay, bx, by)));
    }

    private static boolean crosses(double ax, double ay, double bx, double by, double cx, double cy, double dx,
            double dy) {
        double d1 = side(cx, cy, dx, dy, ax, ay);
        double d2 = side(cx, cy, dx, dy, bx, by);
        double d3 = side(ax, ay, bx, by, cx, cy);
        double d4 = side(ax, ay, bx, by, dx, dy);
        return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    }

    /** Which side of the line from A to B the point P is on: above 0 one side, below 0 the other. */
    private static double side(double ax, double ay, double bx, double by, double px, double py) {
        return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    }

    /** The distance from the point P to the straight piece from A to B. */
    private static double fromPoint(double px, double py, double ax, double ay, double bx, double by) {
        double lx = bx - ax;
        double ly = by - ay;
        double length = lx * lx + ly * ly;
        double along = length == 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * lx + (py - ay) * ly) / length));
        return Math.hypot(px - (ax + along * lx), py - (ay + along * ly));
    }
}
