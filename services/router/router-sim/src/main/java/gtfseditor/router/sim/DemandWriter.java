package gtfseditor.router.sim;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.GZIPOutputStream;

/** Writes a demand set as the CSV that {@link DemandReader} reads. */
public final class DemandWriter {

    private DemandWriter() {}

    /** Opens a text file for writing; one whose name ends in {@code .gz} is packed on the way. */
    static Writer open(Path file) throws IOException {
        if (file.toAbsolutePath().getParent() != null) {
            Files.createDirectories(file.toAbsolutePath().getParent());
        }
        OutputStream out = Files.newOutputStream(file);
        if (file.getFileName().toString().endsWith(".gz")) {
            out = new GZIPOutputStream(out, 1 << 16);
        }
        return new BufferedWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8), 1 << 16);
    }

    public static void write(Demand demand, Path file) throws IOException {
        try (Writer out = open(file)) {
            write(demand, out);
        }
    }

    /** Every row with its id, its people and, where known, the position of each end. */
    public static void write(Demand demand, Writer out) throws IOException {
        out.write("user_id,start_time,origin_stop,destination_stop,origin_lat,origin_lon,"
                + "destination_lat,destination_lon,journey_id,people\n");
        StringBuilder line = new StringBuilder(160);
        for (int row = 0; row < demand.size(); row++) {
            line.setLength(0);
            int from = demand.origin[row];
            int to = demand.destination[row];
            quoted(line, demand.userId(row)).append(',').append(Clock.text(demand.start[row])).append(',');
            quoted(line, demand.placeStop[from]).append(',');
            quoted(line, demand.placeStop[to]).append(',');
            position(line, demand.placeLat[from], demand.placeLon[from]).append(',');
            position(line, demand.placeLat[to], demand.placeLon[to]).append(',');
            quoted(line, demand.journeyId(row)).append(',').append(demand.people[row]).append('\n');
            out.write(line.toString());
        }
    }

    private static StringBuilder position(StringBuilder line, double lat, double lon) {
        if (Double.isNaN(lat)) {
            return line.append(',');
        }
        return line.append(lat).append(',').append(lon);
    }

    /** A value as CSV writes it: in quotes only if it needs them. */
    static StringBuilder quoted(StringBuilder line, String value) {
        if (value.indexOf(',') < 0 && value.indexOf('"') < 0 && value.indexOf('\n') < 0
                && value.indexOf('\r') < 0) {
            return line.append(value);
        }
        return line.append('"').append(value.replace("\"", "\"\"")).append('"');
    }
}
