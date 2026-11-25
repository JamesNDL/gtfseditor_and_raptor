package gtfseditor.router.road;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.graphhopper.GraphHopper;
import com.graphhopper.GraphHopperConfig;
import com.graphhopper.config.CHProfile;
import com.graphhopper.config.Profile;
import com.graphhopper.util.Constants;
import com.graphhopper.util.GHUtility;
import com.graphhopper.util.shapes.BBox;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.stream.Stream;

/**
 * Builds a road graph folder from an OpenStreetMap file ({@code .osm.pbf} or {@code .osm}), and
 * writes {@value #INFO_FILE} beside it saying what it was built from.
 *
 * <p>The graph has one profile, {@value #PROFILE}, from GraphHopper's built-in car model, no turn
 * costs, and the speed-up index (contraction hierarchies) for it (decision D14). It is built in
 * memory and then written to disk; {@link GraphHopperRoads} opens it memory-mapped.
 */
public final class RoadGraphBuilder {

    /** The file in a graph folder that says what the graph was built from. */
    public static final String INFO_FILE = "road-graph.json";

    /** The one profile in the graph. */
    static final String PROFILE = "car";

    /**
     * GraphHopper's own default: networks of fewer edges than this (a car park, a private estate
     * cut off from the rest) are left out when snapping, so a point snaps to the main network.
     */
    public static final int DEFAULT_MIN_NETWORK_SIZE = 200;

    /** The values GraphHopper's car model reads from each road. */
    private static final String ENCODED_VALUES = "car_access, car_average_speed";

    /**
     * Ways no car may use, left out of the graph altogether. GraphHopper insists this is set; for a
     * car-only graph its advice is to leave these out, which makes the graph and the import smaller
     * (NFR-2). A later foot profile would need them back, and a rebuild.
     */
    private static final String IGNORED_HIGHWAYS = "footway,cycleway,path,pedestrian,steps,bridleway";

    private RoadGraphBuilder() {}

    /** Builds with GraphHopper's default smallest kept network. */
    public static void build(Path osmFile, Path graphFolder) {
        build(osmFile, graphFolder, DEFAULT_MIN_NETWORK_SIZE);
    }

    /**
     * Builds a graph folder.
     *
     * @param minNetworkSize networks with fewer edges are left out when snapping; 0 keeps every one
     * @throws IllegalArgumentException if the OpenStreetMap file does not exist
     * @throws IllegalStateException if the folder holds files and is not a graph folder
     */
    public static void build(Path osmFile, Path graphFolder, int minNetworkSize) {
        if (!Files.isRegularFile(osmFile)) {
            throw new IllegalArgumentException("No OpenStreetMap file at " + osmFile);
        }
        Instant started = Instant.now();
        clearGraphFolder(graphFolder);

        GraphHopperConfig config = config(graphFolder);
        config.putObject("datareader.file", osmFile.toString());
        config.putObject("prepare.min_network_size", minNetworkSize);
        config.putObject("graph.dataaccess.default_type", "RAM_STORE");
        GraphHopper hopper = new GraphHopper().init(config);
        hopper.importOrLoad();
        BBox box = hopper.getBaseGraph().getBounds().clone();
        hopper.close();

        writeInfo(osmFile, graphFolder, box, started);
    }

    /** The settings shared by building and opening a graph: where it is and its one profile. */
    static GraphHopperConfig config(Path graphFolder) {
        GraphHopperConfig config = new GraphHopperConfig();
        config.putObject("graph.location", graphFolder.toString());
        config.putObject("graph.encoded_values", ENCODED_VALUES);
        config.putObject("import.osm.ignored_highways", IGNORED_HIGHWAYS);
        config.setProfiles(List.of(new Profile(PROFILE).setCustomModel(GHUtility.loadCustomModelFromJar("car.json"))));
        config.setCHProfiles(List.of(new CHProfile(PROFILE)));
        return config;
    }

    /** Whether a folder holds a graph this class built. */
    public static boolean isGraphFolder(Path folder) {
        return Files.isRegularFile(folder.resolve(INFO_FILE));
    }

    /**
     * Makes the folder ready for a new graph: creates it, or empties an old graph folder. The old
     * {@value #INFO_FILE} is kept until the new one replaces it, so a build that fails part way
     * can be run again. Refuses any other folder with files in it.
     */
    private static void clearGraphFolder(Path folder) {
        try {
            Files.createDirectories(folder);
            List<Path> files;
            try (Stream<Path> listing = Files.list(folder)) {
                files = listing.toList();
            }
            if (files.isEmpty()) {
                return;
            }
            if (!isGraphFolder(folder)) {
                throw new IllegalStateException(folder + " is not empty and has no " + INFO_FILE
                        + ", so it is not a road graph folder; refusing to write into it");
            }
            for (Path file : files) {
                if (Files.isRegularFile(file) && !file.getFileName().toString().equals(INFO_FILE)) {
                    Files.delete(file);
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Writes {@value #INFO_FILE}: the source file, its size and date, the box, the version, the build time. */
    private static void writeInfo(Path osmFile, Path graphFolder, BBox box, Instant started) {
        try {
            Instant finished = Instant.now();
            ObjectMapper json = new ObjectMapper();
            ObjectNode info = json.createObjectNode();
            info.put("sourceFile", osmFile.getFileName().toString());
            info.put("sourceBytes", Files.size(osmFile));
            info.put("sourceModified", Files.getLastModifiedTime(osmFile).toInstant().toString());
            ObjectNode bounds = info.putObject("box");
            bounds.put("minLat", box.minLat);
            bounds.put("minLon", box.minLon);
            bounds.put("maxLat", box.maxLat);
            bounds.put("maxLon", box.maxLon);
            info.put("graphHopperVersion", Constants.VERSION);
            info.put("builtAt", finished.truncatedTo(ChronoUnit.SECONDS).toString());
            info.put("buildSeconds", Duration.between(started, finished).toMillis() / 1000.0);
            json.writerWithDefaultPrettyPrinter().writeValue(graphFolder.resolve(INFO_FILE).toFile(), info);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
