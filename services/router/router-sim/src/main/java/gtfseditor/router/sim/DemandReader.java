package gtfseditor.router.sim;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;

/**
 * Reads a demand file: a CSV with a header row, one journey to a row. The format is section 3.1 of
 * docs/simulator-plan.md.
 *
 * <p>A row that cannot be used is refused and counted in the report; the others are still read. A
 * file without one of the four required columns is not read at all. A value may be in double
 * quotes, with a quote inside it doubled, but may not hold a line break.
 */
public final class DemandReader {

    /** The latest start the router will plan from: 36:00:00. */
    public static final int LATEST_START = 36 * 3600;

    /** The rows that could be used, and what became of the others. */
    public record Read(Demand demand, DemandReport report) {}

    private DemandReader() {}

    /** Reads a file; one whose name ends in {@code .gz} is unpacked on the way. */
    public static Read read(Path file) throws IOException {
        try (InputStream in = Files.newInputStream(file)) {
            InputStream plain = file.getFileName().toString().endsWith(".gz") ? new GZIPInputStream(in, 1 << 16) : in;
            return read(new InputStreamReader(plain, StandardCharsets.UTF_8));
        }
    }

    /** @throws IllegalArgumentException if the header lacks a required column */
    public static Read read(Reader source) throws IOException {
        BufferedReader lines = new BufferedReader(source, 1 << 16);
        String header = lines.readLine();
        if (header == null) {
            throw new IllegalArgumentException("the demand file is empty");
        }
        if (header.startsWith("﻿")) {
            header = header.substring(1);
        }
        List<String> names = new ArrayList<>();
        split(header, names);
        names.replaceAll(String::strip);
        int userAt = required(names, "user_id");
        int startAt = required(names, "start_time");
        int originAt = required(names, "origin_stop");
        int destinationAt = required(names, "destination_stop");
        int originLatAt = names.indexOf("origin_lat");
        int originLonAt = names.indexOf("origin_lon");
        int destinationLatAt = names.indexOf("destination_lat");
        int destinationLonAt = names.indexOf("destination_lon");
        int journeyAt = names.indexOf("journey_id");
        int peopleAt = names.indexOf("people");

        Demand.Builder builder = new Demand.Builder();
        DemandReport report = new DemandReport();
        List<String> values = new ArrayList<>();
        double[] position = new double[2];
        long line = 1;
        for (String text = lines.readLine(); text != null; text = lines.readLine()) {
            line++;
            if (text.isBlank()) {
                continue;
            }
            report.read();
            String where = "line " + line;
            values.clear();
            split(text, values);

            String userId = value(values, userAt);
            if (userId.isEmpty()) {
                report.refuse("no user_id", where);
                continue;
            }
            int start = Clock.parse(value(values, startAt));
            if (start < 0) {
                report.refuse("a start_time that cannot be read", where + ": '" + value(values, startAt) + "'");
                continue;
            }
            if (start > LATEST_START) {
                report.refuse("a start_time after 36:00:00, outside the service day", where);
                continue;
            }
            int people = 1;
            String count = value(values, peopleAt);
            if (!count.isEmpty()) {
                people = Clock.parse(count.contains(":") ? "" : count);
                if (people < 1) {
                    report.refuse("people is not a whole number above 0", where + ": '" + count + "'");
                    continue;
                }
            }
            String origin = value(values, originAt);
            String destination = value(values, destinationAt);
            if (!position(values, originLatAt, originLonAt, position)) {
                report.refuse("an origin position that cannot be read", where);
                continue;
            }
            double originLat = position[0];
            double originLon = position[1];
            if (!position(values, destinationLatAt, destinationLonAt, position)) {
                report.refuse("a destination position that cannot be read", where);
                continue;
            }
            if ((origin.isEmpty() && Double.isNaN(originLat)) || (destination.isEmpty() && Double.isNaN(position[0]))) {
                report.refuse("no stop id and no position for one end", where);
                continue;
            }
            String journey = value(values, journeyAt);
            // A row with no id of its own is known by its number among the rows of the file.
            builder.add(userId, journey.isEmpty() ? Long.toString(report.rowsRead()) : journey, start, origin,
                    originLat, originLon, destination, position[0], position[1], people);
        }
        return new Read(builder.build(), report);
    }

    private static int required(List<String> names, String name) {
        int at = names.indexOf(name);
        if (at < 0) {
            throw new IllegalArgumentException("the demand file has no " + name
                    + " column; it needs user_id, start_time, origin_stop and destination_stop");
        }
        return at;
    }

    private static String value(List<String> values, int at) {
        return at < 0 || at >= values.size() ? "" : values.get(at).strip();
    }

    /**
     * Reads a latitude and longitude into {@code into}; both NaN if neither is given.
     *
     * @return false if only one is given, or either is not a number or not on the globe
     */
    private static boolean position(List<String> values, int latAt, int lonAt, double[] into) {
        String lat = value(values, latAt);
        String lon = value(values, lonAt);
        into[0] = Double.NaN;
        into[1] = Double.NaN;
        if (lat.isEmpty() && lon.isEmpty()) {
            return true;
        }
        try {
            double y = Double.parseDouble(lat);
            double x = Double.parseDouble(lon);
            if (!(y >= -90 && y <= 90 && x >= -180 && x <= 180)) {
                return false;
            }
            into[0] = y;
            into[1] = x;
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** Splits one line of CSV into its values. */
    static void split(String line, List<String> into) {
        StringBuilder value = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (quoted) {
                if (c != '"') {
                    value.append(c);
                } else if (i + 1 < line.length() && line.charAt(i + 1) == '"') {
                    value.append('"');
                    i++;
                } else {
                    quoted = false;
                }
            } else if (c == '"') {
                quoted = true;
            } else if (c == ',') {
                into.add(value.toString());
                value.setLength(0);
            } else {
                value.append(c);
            }
        }
        into.add(value.toString());
    }
}
