package gtfseditor.router.road;

import com.graphhopper.GraphHopper;
import com.graphhopper.GraphHopperConfig;
import com.graphhopper.config.Profile;
import com.graphhopper.routing.Path;
import com.graphhopper.routing.ch.CHRoutingAlgorithmFactory;
import com.graphhopper.routing.ev.Subnetwork;
import com.graphhopper.routing.querygraph.QueryGraph;
import com.graphhopper.routing.util.DefaultSnapFilter;
import com.graphhopper.routing.util.EdgeFilter;
import com.graphhopper.storage.RoutingCHGraph;
import com.graphhopper.storage.index.Snap;
import com.graphhopper.util.PMap;
import com.graphhopper.util.PointList;
import com.graphhopper.util.shapes.GHPoint3D;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Road routing with GraphHopper, on a graph folder built by {@link RoadGraphBuilder}. The graph is
 * opened read-only and memory-mapped, so it sits in the operating system's file cache rather than
 * the Java heap (architecture §3.4). Every drive uses the speed-up index. Safe to use from many
 * threads: each request builds its own small query graph over the shared, read-only graph. A
 * table's drives are shared out over a pool of {@link RoadSettings#threads} threads (D17).
 */
public final class GraphHopperRoads implements RoadRouter, AutoCloseable {

    private final GraphHopper hopper;
    private final RoutingCHGraph speedUpGraph;
    private final EdgeFilter carRoads;
    private final double snapMetres;
    private final ExecutorService pool;
    private final GraphHopperTable tables;
    private volatile boolean open = true;

    private GraphHopperRoads(GraphHopper hopper, RoadSettings settings) {
        this.hopper = hopper;
        this.snapMetres = settings.snapMetres();
        this.speedUpGraph = hopper.getCHGraphs().get(RoadGraphBuilder.PROFILE);
        // Daemon threads, so an unclosed router never keeps the process alive.
        this.pool = Executors.newFixedThreadPool(settings.threads(),
                Thread.ofPlatform().daemon().name("road-table-", 1).factory());
        this.tables = new GraphHopperTable(hopper.getBaseGraph(), speedUpGraph, pool, settings.threads());
        Profile car = hopper.getProfile(RoadGraphBuilder.PROFILE);
        // Only roads a car may use, and not in a network left out at build time.
        this.carRoads = new DefaultSnapFilter(hopper.createWeighting(car, new PMap()),
                hopper.getEncodingManager().getBooleanEncodedValue(Subnetwork.key(RoadGraphBuilder.PROFILE)));
    }

    /**
     * Opens a built graph folder.
     *
     * @throws IllegalStateException if the folder holds no graph
     */
    public static GraphHopperRoads open(RoadSettings settings) {
        if (!RoadGraphBuilder.isGraphFolder(settings.graphFolder())) {
            throw new IllegalStateException("No road graph in " + settings.graphFolder()
                    + ": it has no " + RoadGraphBuilder.INFO_FILE);
        }
        GraphHopperConfig config = RoadGraphBuilder.config(settings.graphFolder());
        config.putObject("graph.dataaccess.default_type", "MMAP_RO");
        GraphHopper hopper = new GraphHopper().init(config);
        hopper.setAllowWrites(false);
        if (!hopper.load()) {
            throw new IllegalStateException("Could not open the road graph in " + settings.graphFolder());
        }
        return new GraphHopperRoads(hopper, settings);
    }

    @Override
    public boolean available() {
        return open;
    }

    @Override
    public RoadRoute route(List<LatLon> points, boolean alternatives) {
        if (points.size() < 2) {
            throw new IllegalArgumentException("A drive needs at least two points, not " + points.size());
        }
        List<Snap> snaps = new ArrayList<>(points.size());
        List<Snapped> snapped = new ArrayList<>(points.size());
        int missing = -1;
        for (LatLon point : points) {
            Snap snap = snap(point);
            if (snap == null && missing < 0) {
                missing = snaps.size();
            }
            snaps.add(snap);
            snapped.add(snap == null ? Snapped.NONE : toSnapped(snap));
        }
        if (missing >= 0) {
            return RoadRoute.failed(RoadRoute.Status.NO_ROAD, snapped, "point " + (missing + 1) + " of "
                    + points.size() + " is more than " + Math.round(snapMetres) + " m from a road");
        }
        return drive(snaps, snapped, alternatives && points.size() == 2);
    }

    @Override
    public RoadTable table(List<LatLon> sources, List<LatLon> destinations) {
        double[] sourceSnapMetres = new double[sources.size()];
        double[] destinationSnapMetres = new double[destinations.size()];
        List<Snap> sourceSnaps = snapAll(sources, sourceSnapMetres);
        List<Snap> destinationSnaps = snapAll(destinations, destinationSnapMetres);
        return tables.run(sourceSnaps, destinationSnaps, sourceSnapMetres, destinationSnapMetres);
    }

    @Override
    public Snapped nearest(LatLon point) {
        Snap snap = snap(point);
        return snap == null ? Snapped.NONE : toSnapped(snap);
    }

    /** Closes the graph. Drives cannot be planned afterwards. */
    @Override
    public void close() {
        open = false;
        pool.shutdownNow();
        hopper.close();
    }

    /**
     * Plans each hop between consecutive snapped points on the speed-up index, and joins them.
     * With {@code alternatives} (two points only) it also looks for other drives.
     */
    private RoadRoute drive(List<Snap> snaps, List<Snapped> snapped, boolean alternatives) {
        // Builds virtual nodes where the points meet the roads; updates each snap's closest node.
        QueryGraph queryGraph = QueryGraph.create(hopper.getBaseGraph(), snaps);
        CHRoutingAlgorithmFactory algorithms = new CHRoutingAlgorithmFactory(speedUpGraph, queryGraph);
        List<RoadRoute.Leg> legs = new ArrayList<>(snaps.size() - 1);
        List<double[]> line = new ArrayList<>();
        double metres = 0;
        double seconds = 0;
        for (int hop = 0; hop + 1 < snaps.size(); hop++) {
            Path path = algorithms.createAlgo(new PMap())
                    .calcPath(snaps.get(hop).getClosestNode(), snaps.get(hop + 1).getClosestNode());
            if (!path.isFound()) {
                return RoadRoute.failed(RoadRoute.Status.NO_ROUTE, snapped,
                        "no road joins point " + (hop + 1) + " to point " + (hop + 2));
            }
            double legSeconds = path.getTime() / 1000.0;
            legs.add(new RoadRoute.Leg(path.getDistance(), legSeconds));
            metres += path.getDistance();
            seconds += legSeconds;
            appendPoints(line, path.calcPoints());
        }
        double[][] path = line.toArray(new double[0][]);
        List<RoadRoute> others = alternatives ? GraphHopperAlternatives.find(algorithms, snaps, snapped, path)
                : List.of();
        return new RoadRoute(RoadRoute.Status.OK, metres, seconds, path, List.copyOf(legs),
                List.copyOf(snapped), others, "");
    }

    /** Snaps every point once, noting each one's snap metres (NaN for none); null where none. */
    private List<Snap> snapAll(List<LatLon> points, double[] snapMetresOut) {
        List<Snap> snaps = new ArrayList<>(points.size());
        for (int i = 0; i < points.size(); i++) {
            Snap snap = snap(points.get(i));
            snaps.add(snap);
            snapMetresOut[i] = snap == null ? Double.NaN : snap.getQueryDistance();
        }
        return snaps;
    }

    /** Adds a hop's points to the line, leaving out a first point that repeats the line's last. */
    static void appendPoints(List<double[]> line, PointList points) {
        for (int i = 0; i < points.size(); i++) {
            double[] lonLat = {points.getLon(i), points.getLat(i)};
            if (i == 0 && !line.isEmpty()) {
                double[] last = line.getLast();
                if (last[0] == lonLat[0] && last[1] == lonLat[1]) {
                    continue;
                }
            }
            line.add(lonLat);
        }
    }

    /** Snaps a point to the nearest car road, or null when there is none within the snap limit. */
    private Snap snap(LatLon point) {
        Snap snap = hopper.getLocationIndex().findClosest(point.lat(), point.lon(), carRoads);
        if (!snap.isValid() || snap.getQueryDistance() > snapMetres) {
            return null;
        }
        return snap;
    }

    private static Snapped toSnapped(Snap snap) {
        GHPoint3D onRoad = snap.getSnappedPoint();
        return new Snapped(new LatLon(onRoad.getLat(), onRoad.getLon()), snap.getQueryDistance());
    }
}
