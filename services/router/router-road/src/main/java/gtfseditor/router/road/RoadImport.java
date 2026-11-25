package gtfseditor.router.road;

import java.io.UncheckedIOException;
import java.nio.file.Path;

/**
 * The road import command, run by the {@code roadImport} Gradle task:
 * {@code -ProadArgs="<osm file> <graph folder>"}. Builds a road graph folder from an OpenStreetMap
 * file. Rebuilds a folder that already holds a road graph; refuses any other folder with files in
 * it, so a mistyped path cannot wipe something else.
 */
public final class RoadImport {

    private RoadImport() {}

    public static void main(String[] args) {
        int code = run(args);
        if (code != 0) {
            System.exit(code);
        }
    }

    /** Runs the command and gives the exit code: 0 when the graph was built. */
    static int run(String[] args) {
        if (args.length != 2) {
            System.err.println("Usage: roadImport <osm file> <graph folder>");
            return 2;
        }
        Path osmFile = Path.of(args[0]);
        Path graphFolder = Path.of(args[1]);
        try {
            System.out.println("Building the road graph from " + osmFile + " into " + graphFolder);
            RoadGraphBuilder.build(osmFile, graphFolder);
            System.out.println("Done: " + graphFolder.resolve(RoadGraphBuilder.INFO_FILE));
            return 0;
        } catch (IllegalArgumentException | IllegalStateException | UncheckedIOException e) {
            System.err.println("Road import failed: " + e.getMessage());
            return 1;
        }
    }
}
