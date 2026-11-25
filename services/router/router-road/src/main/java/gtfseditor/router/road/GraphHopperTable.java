package gtfseditor.router.road;

import com.graphhopper.routing.Path;
import com.graphhopper.routing.ch.CHRoutingAlgorithmFactory;
import com.graphhopper.routing.querygraph.QueryGraph;
import com.graphhopper.storage.BaseGraph;
import com.graphhopper.storage.RoutingCHGraph;
import com.graphhopper.storage.index.Snap;
import com.graphhopper.util.PMap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

/**
 * Many drives at once for {@link GraphHopperRoads#table} (decision D17): one speed-up-index drive
 * per pair, with the rows of starting points shared out over a pool of threads. Kept apart from
 * {@link GraphHopperRoads} so each file stays short.
 */
final class GraphHopperTable {

    /** Rows are cut into about this many pieces per thread, so a slow piece does not hold up the rest. */
    private static final int PIECES_PER_THREAD = 4;

    private final BaseGraph baseGraph;
    private final RoutingCHGraph speedUpGraph;
    private final ExecutorService pool;
    private final int threads;

    GraphHopperTable(BaseGraph baseGraph, RoutingCHGraph speedUpGraph, ExecutorService pool, int threads) {
        this.baseGraph = baseGraph;
        this.speedUpGraph = speedUpGraph;
        this.pool = pool;
        this.threads = threads;
    }

    /**
     * Drives between every pair of snapped points.
     *
     * @param sources one snap per starting point, null where it has no road
     * @param destinations one snap per ending point, null where it has no road
     * @param sourceSnapMetres passed through to the answer
     * @param destinationSnapMetres passed through to the answer
     */
    RoadTable run(List<Snap> sources, List<Snap> destinations, double[] sourceSnapMetres,
            double[] destinationSnapMetres) {
        double[][] seconds = filledWithNaN(sources.size(), destinations.size());
        double[][] metres = filledWithNaN(sources.size(), destinations.size());
        List<Integer> rows = withRoad(sources);
        List<Integer> columns = withRoad(destinations);
        if (!rows.isEmpty() && !columns.isEmpty()) {
            // One query graph holds every snapped point. It is built here, on one thread, as building
            // it moves each snap's closest node; afterwards the threads only read it.
            List<Snap> all = new ArrayList<>(rows.size() + columns.size());
            rows.forEach(row -> all.add(sources.get(row)));
            columns.forEach(column -> all.add(destinations.get(column)));
            QueryGraph queryGraph = QueryGraph.create(baseGraph, all);
            List<Callable<Void>> pieces = new ArrayList<>();
            int pieceSize = Math.max(1, Math.ceilDiv(rows.size(), threads * PIECES_PER_THREAD));
            for (int start = 0; start < rows.size(); start += pieceSize) {
                List<Integer> piece = rows.subList(start, Math.min(rows.size(), start + pieceSize));
                pieces.add(() -> {
                    drivePiece(queryGraph, piece, columns, sources, destinations, seconds, metres);
                    return null;
                });
            }
            runAll(pieces);
        }
        return new RoadTable(seconds, metres, sourceSnapMetres, destinationSnapMetres);
    }

    /** Fills in the given rows. Each piece writes only its own rows, so pieces never clash. */
    private void drivePiece(QueryGraph queryGraph, List<Integer> piece, List<Integer> columns,
            List<Snap> sources, List<Snap> destinations, double[][] seconds, double[][] metres) {
        // The speed-up index seen through the query graph; one per piece, as it is not shared safely.
        CHRoutingAlgorithmFactory algorithms = new CHRoutingAlgorithmFactory(speedUpGraph, queryGraph);
        for (int row : piece) {
            int from = sources.get(row).getClosestNode();
            for (int column : columns) {
                Path path = algorithms.createAlgo(new PMap())
                        .calcPath(from, destinations.get(column).getClosestNode());
                if (path.isFound()) {
                    seconds[row][column] = path.getTime() / 1000.0;
                    metres[row][column] = path.getDistance();
                }
            }
        }
    }

    /** Runs every piece on the pool and waits for them all. */
    private void runAll(List<Callable<Void>> pieces) {
        try {
            for (Future<Void> done : pool.invokeAll(pieces)) {
                done.get();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("The road table was interrupted", e);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof RuntimeException cause) {
                throw cause;
            }
            throw new IllegalStateException("A drive in the road table failed", e.getCause());
        }
    }

    /** The places in the list that have a road (a snap that is not null). */
    private static List<Integer> withRoad(List<Snap> snaps) {
        List<Integer> places = new ArrayList<>(snaps.size());
        for (int i = 0; i < snaps.size(); i++) {
            if (snaps.get(i) != null) {
                places.add(i);
            }
        }
        return places;
    }

    private static double[][] filledWithNaN(int rows, int columns) {
        double[][] grid = new double[rows][columns];
        for (double[] row : grid) {
            Arrays.fill(row, Double.NaN);
        }
        return grid;
    }
}
