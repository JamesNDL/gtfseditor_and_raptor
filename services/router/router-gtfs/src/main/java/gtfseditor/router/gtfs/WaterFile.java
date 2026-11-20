package gtfseditor.router.gtfs;

import gtfseditor.router.core.Water;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Reads the file that says where a straight walk would cross water. It is a CSV with the columns
 * {@code kind}, {@code lat1}, {@code lon1}, {@code lat2}, {@code lon2}:
 *
 * <ul>
 *   <li>{@code water}: one straight piece of a path that ferries sail, from the first position to
 *       the second. The pieces within reach of a wharf, and of a bridge, must already be left out.
 *   <li>{@code bridge}: a place where a bridge that can be walked crosses such a path; the second
 *       position is left empty.
 * </ul>
 *
 * <p>The editor's API writes one from the feed's ferry and bus paths; see the service's README.
 */
public final class WaterFile {

    private WaterFile() {}

    /** @throws GtfsException if the file cannot be understood */
    public static Water read(Path file) throws IOException {
        try (InputStream in = Files.newInputStream(file)) {
            return read(in, file.getFileName().toString());
        }
    }

    /** @throws GtfsException if the text cannot be understood */
    public static Water read(InputStream in, String name) throws IOException {
        DoubleList lines = new DoubleList();
        DoubleList bridges = new DoubleList();
        try (CsvReader r = new CsvReader(in, name)) {
            int cKind = r.require("kind");
            int cLat1 = r.require("lat1");
            int cLon1 = r.require("lon1");
            int cLat2 = r.require("lat2");
            int cLon2 = r.require("lon2");
            while (r.next()) {
                String kind = r.text(cKind);
                if (kind.equals("water")) {
                    lines.add(r.decimal(cLat1));
                    lines.add(r.decimal(cLon1));
                    lines.add(r.decimal(cLat2));
                    lines.add(r.decimal(cLon2));
                } else if (kind.equals("bridge")) {
                    bridges.add(r.decimal(cLat1));
                    bridges.add(r.decimal(cLon1));
                } else {
                    throw new GtfsException(r.where() + ": the kind must be water or bridge, not '" + kind + "'");
                }
            }
        }
        try {
            return new Water(lines.toArray(), bridges.toArray());
        } catch (IllegalArgumentException e) {
            throw new GtfsException(name + ": " + e.getMessage());
        }
    }

    private static final class DoubleList {
        private double[] values = new double[1 << 10];
        private int size;

        void add(double value) {
            if (size == values.length) {
                values = java.util.Arrays.copyOf(values, size * 2);
            }
            values[size++] = value;
        }

        double[] toArray() {
            return java.util.Arrays.copyOf(values, size);
        }
    }
}
