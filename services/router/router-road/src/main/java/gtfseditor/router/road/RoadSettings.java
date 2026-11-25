package gtfseditor.router.road;

import java.nio.file.Path;

/**
 * How the road router is set up.
 *
 * @param graphFolder the folder a graph was built into by {@link RoadGraphBuilder}
 * @param snapMetres how far an asked point may be from a road before it has "no road" (D19)
 * @param threads threads for many drives at once (the table, AA-2)
 */
public record RoadSettings(Path graphFolder, double snapMetres, int threads) {

    /** The snap limit of decision D19. */
    public static final double DEFAULT_SNAP_METRES = 500;

    /** The defaults for a graph folder: 500 m snap limit, one thread per processor. */
    public static RoadSettings defaults(Path graphFolder) {
        return new RoadSettings(graphFolder, DEFAULT_SNAP_METRES, Runtime.getRuntime().availableProcessors());
    }
}
