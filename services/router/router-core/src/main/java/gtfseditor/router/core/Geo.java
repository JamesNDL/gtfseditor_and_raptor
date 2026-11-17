package gtfseditor.router.core;

/** Distances on the globe. */
public final class Geo {

    private static final double EARTH_RADIUS = 6_371_008.8;

    /** Metres in one degree of latitude, rounded down so that grids built with it err on the wide side. */
    public static final double METRES_PER_DEGREE = 111_000;

    private Geo() {}

    /** Straight-line distance between two points, in metres. */
    public static double metresBetween(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
    }
}
