package gtfseditor.router.road;

import java.util.List;

/**
 * Road routing for cars, kept behind this small interface so that the rest of the router does not
 * know which engine does it (decision D14). Implementations are safe to call from many threads.
 */
public interface RoadRouter {

    /** Whether drives can be planned. */
    boolean available();

    /**
     * One drive through every point in the order given, with one leg per hop.
     *
     * @param points two or more points
     * @param alternatives whether to also look for other drives; used only for two points, and
     *     gives at most two others, so at most three drives in all
     */
    RoadRoute route(List<LatLon> points, boolean alternatives);

    /**
     * Driving time and distance for every pair of sources and destinations (FR-2). Each point is
     * snapped to the roads once.
     */
    RoadTable table(List<LatLon> sources, List<LatLon> destinations);

    /** The nearest point on a road a car may use, or {@link Snapped#NONE} past the snap limit. */
    Snapped nearest(LatLon point);
}
