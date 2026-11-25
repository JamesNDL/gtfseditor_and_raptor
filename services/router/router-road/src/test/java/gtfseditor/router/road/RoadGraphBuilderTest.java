package gtfseditor.router.road;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Building a graph folder from an OpenStreetMap file, and the import command (AA-1, FR-3). */
class RoadGraphBuilderTest {

    @TempDir
    Path folder;

    @Test
    void writesRoadGraphJsonBesideTheGraph() throws IOException {
        Path osm = MiniRoads.osmFile();
        Path graph = folder.resolve("graph");

        RoadGraphBuilder.build(osm, graph, 0);

        Path infoFile = graph.resolve(RoadGraphBuilder.INFO_FILE);
        assertTrue(Files.isRegularFile(infoFile), "road-graph.json is written");
        JsonNode info = new ObjectMapper().readTree(infoFile.toFile());
        assertEquals("mini-roads.osm", info.get("sourceFile").asText());
        assertEquals(Files.size(osm), info.get("sourceBytes").asLong());
        assertEquals(Files.getLastModifiedTime(osm).toInstant(),
                Instant.parse(info.get("sourceModified").asText()));
        assertEquals("11.1", info.get("graphHopperVersion").asText());
        Instant builtAt = Instant.parse(info.get("builtAt").asText());
        assertTrue(builtAt.isAfter(Instant.now().minusSeconds(600)), "built just now");
        assertTrue(info.get("buildSeconds").asDouble() >= 0);

        JsonNode box = info.get("box");
        // The box holds the grid (north-west corner 1) and the island (south).
        assertTrue(box.get("maxLat").asDouble() >= -32.8971, "north edge");
        assertTrue(box.get("minLat").asDouble() <= -32.9168, "south edge takes in the island");
        assertTrue(box.get("minLon").asDouble() <= 151.7350, "west edge");
        assertTrue(box.get("maxLon").asDouble() >= 151.7402, "east edge");
    }

    @Test
    void importBuildsIntoAFolderThatDoesNotExistYet() {
        Path graph = folder.resolve("new-graph");

        int code = RoadImport.run(new String[] {MiniRoads.osmFile().toString(), graph.toString()});

        assertEquals(0, code);
        assertTrue(Files.isRegularFile(graph.resolve(RoadGraphBuilder.INFO_FILE)));
    }

    @Test
    void importRebuildsAnExistingGraphFolder() throws IOException {
        Path graph = folder.resolve("graph");
        RoadGraphBuilder.build(MiniRoads.osmFile(), graph, 0);
        Instant first = Instant.parse(readInfo(graph).get("builtAt").asText());

        int code = RoadImport.run(new String[] {MiniRoads.osmFile().toString(), graph.toString()});

        assertEquals(0, code);
        Instant second = Instant.parse(readInfo(graph).get("builtAt").asText());
        assertFalse(second.isBefore(first), "built again");
    }

    @Test
    void importRefusesAFolderThatIsNotAGraphFolder() throws IOException {
        Path other = Files.createDirectories(folder.resolve("other"));
        Path keep = Files.writeString(other.resolve("notes.txt"), "not a graph");

        int code = RoadImport.run(new String[] {MiniRoads.osmFile().toString(), other.toString()});

        assertNotEquals(0, code);
        assertEquals("not a graph", Files.readString(keep), "the folder is left alone");
        assertFalse(Files.exists(other.resolve(RoadGraphBuilder.INFO_FILE)));
    }

    @Test
    void importRefusesAMissingOsmFile() {
        Path graph = folder.resolve("graph");

        int code = RoadImport.run(new String[] {folder.resolve("missing.osm").toString(), graph.toString()});

        assertNotEquals(0, code);
    }

    @Test
    void importNeedsTwoArguments() {
        assertNotEquals(0, RoadImport.run(new String[] {MiniRoads.osmFile().toString()}));
    }

    private static JsonNode readInfo(Path graph) throws IOException {
        return new ObjectMapper().readTree(graph.resolve(RoadGraphBuilder.INFO_FILE).toFile());
    }
}
