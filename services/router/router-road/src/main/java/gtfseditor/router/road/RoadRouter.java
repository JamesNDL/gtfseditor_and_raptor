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
     * @param alternatives whether to also look for other drives between two points (AA-2; for
     *     now the list of alternatives is always empty)
     */
    RoadRoute route(List<LatLon> points, boolean alternatives);

    /** The nearest point on a road a car may use, or {@link Snapped#NONE} past the snap limit. */
    Snapped nearest(LatLon point);
}
