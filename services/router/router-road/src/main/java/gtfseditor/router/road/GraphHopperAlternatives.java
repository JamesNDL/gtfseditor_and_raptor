package gtfseditor.router.road;

import com.graphhopper.routing.Path;
import com.graphhopper.routing.ch.CHRoutingAlgorithmFactory;
import com.graphhopper.storage.index.Snap;
import com.graphhopper.util.PMap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Other drives between two points, for {@link GraphHopperRoads#route} (architecture §3.1): the
 * editor's detour search asks for them. Uses GraphHopper's {@code alternative_route} on the
 * speed-up index.
 */
final class GraphHopperAlternatives {

    /** Most drives in all, the plain drive included. */
    static final int MOST_DRIVES = 3;

    private GraphHopperAlternatives() {}

    /**
     * Up to two drives other than the plain one, best first. Each has one leg and no alternatives
     * of its own.
     *
     * @param algorithms the speed-up index over the query graph the plain drive used
     * @param snaps the two snapped points
     * @param snapped where the two asked points meet the roads
     * @param plainPath the plain drive's line, which is left out of the answer
     */
    static List<RoadRoute> find(CHRoutingAlgorithmFactory algorithms, List<Snap> snaps, List<Snapped> snapped,
            double[][] plainPath) {
        PMap hints = new PMap()
                .putObject("algorithm", "alternative_route")
                .putObject("alternative_route.max_paths", MOST_DRIVES);
        List<Path> paths = algorithms.createAlgo(hints)
                .calcPaths(snaps.get(0).getClosestNode(), snaps.get(1).getClosestNode());
        List<RoadRoute> others = new ArrayList<>(MOST_DRIVES - 1);
        for (Path path : paths) {
            if (others.size() == MOST_DRIVES - 1) {
                break;
            }
            if (path.isFound()) {
                RoadRoute other = toRoute(path, snapped);
                // The best of GraphHopper's drives is normally the plain drive itself.
                if (!Arrays.deepEquals(other.path(), plainPath)) {
                    others.add(other);
                }
            }
        }
        return List.copyOf(others);
    }

    private static RoadRoute toRoute(Path path, List<Snapped> snapped) {
        List<double[]> line = new ArrayList<>();
        GraphHopperRoads.appendPoints(line, path.calcPoints());
        double seconds = path.getTime() / 1000.0;
        return new RoadRoute(RoadRoute.Status.OK, path.getDistance(), seconds, line.toArray(new double[0][]),
                List.of(new RoadRoute.Leg(path.getDistance(), seconds)), List.copyOf(snapped), List.of(), "");
    }
}
