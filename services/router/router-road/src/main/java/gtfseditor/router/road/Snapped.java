package gtfseditor.router.road;

/**
 * Where an asked point meets the road network: the nearest point on a road a car may use, and
 * how far it is from the asked point. "None" when no such road is within the snap limit.
 *
 * @param point the point on the road, or null for none
 * @param metres straight-line metres from the asked point to {@code point}, or NaN for none
 */
public record Snapped(LatLon point, double metres) {

    /** No road within the snap limit. */
    public static final Snapped NONE = new Snapped(null, Double.NaN);

    /** Whether a road was found within the snap limit. */
    public boolean found() {
        return point != null;
    }
}
