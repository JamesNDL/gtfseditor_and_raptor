package gtfseditor.router.road;

import java.nio.file.Path;

/**
 * How the road router is set up.
 *
 * @param graphFolder the folder a graph was built into by {@link RoadGraphBuilder}
 * @param snapMetres how far an asked point may be from a road before it has "no road" (D19)
 * @param threads threads for many drives at once (the table, D17); at least one
 */
public record RoadSettings(Path graphFolder, double snapMetres, int threads) {

    /** The snap limit of decision D19. */
    public static final double DEFAULT_SNAP_METRES = 500;

    public RoadSettings {
        if (threads < 1) {
            throw new IllegalArgumentException("The road router needs at least one thread, not " + threads);
        }
    }

    /**
     * The defaults for a graph folder: 500 m snap limit, and one thread per processor less two
     * (leaving room for the rest of the router), but at least one (D17).
     */
    public static RoadSettings defaults(Path graphFolder) {
        return new RoadSettings(graphFolder, DEFAULT_SNAP_METRES,
                Math.max(1, Runtime.getRuntime().availableProcessors() - 2));
    }
}
