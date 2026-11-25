package gtfseditor.router.road;

import java.util.List;

/**
 * One drive through two or more points, in order. Times and distances are free-flow (no traffic).
 *
 * @param status whether a drive was found
 * @param metres length of the whole drive; 0 unless {@code OK}
 * @param seconds free-flow driving time of the whole drive; 0 unless {@code OK}
 * @param path the drive's line as {@code [lon, lat]} pairs; empty unless {@code OK}
 * @param legs one per hop between consecutive points; empty unless {@code OK}
 * @param snapped where each asked point meets the roads, in the order asked
 * @param alternatives other drives between the same two points (empty until AA-2)
 * @param reason why there is no drive, in plain English; empty for {@code OK}
 */
public record RoadRoute(
        Status status,
        double metres,
        double seconds,
        double[][] path,
        List<Leg> legs,
        List<Snapped> snapped,
        List<RoadRoute> alternatives,
        String reason) {

    /** Whether a drive was found, and if not, why. */
    public enum Status {
        /** A drive was found. */
        OK,
        /** Every point has a road nearby, but no road joins them. */
        NO_ROUTE,
        /** A point is further than the snap limit from any road a car may use. */
        NO_ROAD
    }

    /** One hop of the drive, between two consecutive asked points. */
    public record Leg(double metres, double seconds) {}

    /** A drive that could not be made, with the reason. */
    static RoadRoute failed(Status status, List<Snapped> snapped, String reason) {
        return new RoadRoute(status, 0, 0, new double[0][], List.of(), List.copyOf(snapped), List.of(), reason);
    }
}
