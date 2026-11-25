package gtfseditor.router.road;

/**
 * Driving times and distances for every pair of a list of starting points (sources) and a list
 * of ending points (destinations), free-flow (FR-2). Rows are sources, columns destinations.
 *
 * @param seconds free-flow driving seconds; NaN where there is no way, or either end has no road
 * @param metres driving metres; NaN where {@code seconds} is
 * @param sourceSnapMetres for each source, metres from the asked point to the road; NaN for none
 * @param destinationSnapMetres for each destination, metres to the road; NaN for none
 */
public record RoadTable(
        double[][] seconds, double[][] metres, double[] sourceSnapMetres, double[] destinationSnapMetres) {}
