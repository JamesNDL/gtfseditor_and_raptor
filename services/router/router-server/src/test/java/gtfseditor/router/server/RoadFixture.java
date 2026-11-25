package gtfseditor.router.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import gtfseditor.router.road.RoadGraphBuilder;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.Locale;

/**
 * The road tests' shared parts: the hand-made map (router-road's {@code mini-roads.osm}, near
 * Mayfield, Newcastle), places on it, and plain HTTP calls to a server.
 */
final class RoadFixture {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Rows of the map's grid of streets, north to south. */
    private static final double[] ROW_LAT = {-32.8970, -32.8979, -32.8988, -32.8997};

    /** Columns of the grid, west to east. */
    private static final double[] COLUMN_LON = {151.73600, 151.73707, 151.73814, 151.73921};

    /** A corner of the island, a square of streets linked to nothing, as {@code {lat, lon}} JSON. */
    static final String ISLAND = point(-32.9160, 151.73600);

    /** About 650 m north of the grid: further than the 500 m snap limit from any road. */
    static final String FAR_FROM_ROADS = point(-32.8910, 151.73750);

    private RoadFixture() {}

    /** The street corner at this row and column of the grid, as {@code {lat, lon}} JSON. */
    static String corner(int row, int column) {
        return point(ROW_LAT[row], COLUMN_LON[column]);
    }

    static String point(double lat, double lon) {
        return "{\"lat\": " + lat + ", \"lon\": " + lon + "}";
    }

    /** The island's corner as OSRM writes a point: {@code lon,lat}, six places, as roads.ts sends it. */
    static final String OSRM_ISLAND = osrmPoint(-32.9160, 151.73600);

    /** The point far from any road, as OSRM writes it. */
    static final String OSRM_FAR_FROM_ROADS = osrmPoint(-32.8910, 151.73750);

    /** The street corner at this row and column of the grid, as OSRM writes a point. */
    static String osrmCorner(int row, int column) {
        return osrmPoint(ROW_LAT[row], COLUMN_LON[column]);
    }

    /** A point as OSRM writes it, {@code lon,lat} (longitude first), to six places as roads.ts does. */
    static String osrmPoint(double lat, double lon) {
        return String.format(Locale.ROOT, "%.6f,%.6f", lon, lat);
    }

    /** Builds the test map into {@code folder}/graph, keeping every network, and gives the folder. */
    static Path buildGraph(Path folder) {
        Path graph = folder.resolve("graph");
        // The test map is far smaller than GraphHopper's smallest kept network, so keep every one.
        RoadGraphBuilder.build(osmFile(), graph, 0);
        return graph;
    }

    private static Path osmFile() {
        // router-road's test resources are on this module's test path (router-server/build.gradle.kts).
        URL url = RoadFixture.class.getResource("/mini-roads.osm");
        if (url == null) {
            throw new IllegalStateException("mini-roads.osm is not on the test path");
        }
        try {
            return Path.of(url.toURI());
        } catch (URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    /** An answer: its status, and its body read as JSON (null when it is not JSON). */
    record Answer(int status, JsonNode body) {}

    /** Plain HTTP calls to a server on this machine. */
    record Http(HttpClient client, int port) {

        Answer get(String path) throws Exception {
            return send(HttpRequest.newBuilder(uri(path)).GET());
        }

        Answer post(String path, String body) throws Exception {
            return send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body)));
        }

        Answer put(String path, String body) throws Exception {
            return send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
                    .PUT(HttpRequest.BodyPublishers.ofString(body)));
        }

        private URI uri(String path) {
            return URI.create("http://localhost:" + port + path);
        }

        private Answer send(HttpRequest.Builder request) throws Exception {
            HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
            String text = response.body().strip();
            return new Answer(response.statusCode(), text.startsWith("{") ? JSON.readTree(text) : null);
        }
    }
}
