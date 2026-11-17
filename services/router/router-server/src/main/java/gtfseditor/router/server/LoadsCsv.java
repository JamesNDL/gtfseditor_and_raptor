package gtfseditor.router.server;

import gtfseditor.router.core.LoadState;
import gtfseditor.router.core.Timetable;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Loads as a CSV file: {@code trip_id}, {@code position} and {@code load}, one row for the
 * passengers aboard a trip as it leaves a stop. The position is the stop's place in the trip,
 * counting from 0; the timetable does not keep GTFS's {@code stop_sequence}. What is written also
 * has a {@code stop_id} column, for reading by eye; it is ignored when read back.
 */
final class LoadsCsv {

    private LoadsCsv() {}

    /**
     * Reads loads laid over a timetable. A place the file does not mention has nobody aboard.
     *
     * @throws ApiException if the file cannot be read, naming the row
     */
    static LoadState read(Timetable t, InputStream in) throws IOException {
        LoadState state = LoadState.empty(t);
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        String header = reader.readLine();
        if (header == null) {
            throw ApiException.bad("the CSV is empty; it needs the columns trip_id, position and load");
        }
        List<String> names = fields(header.startsWith("﻿") ? header.substring(1) : header);
        int tripColumn = names.indexOf("trip_id");
        int positionColumn = names.indexOf("position");
        int loadColumn = names.indexOf("load");
        if (tripColumn < 0 || positionColumn < 0 || loadColumn < 0) {
            throw ApiException.bad("the CSV needs the columns trip_id, position and load; it has " + names);
        }
        int most = Math.max(tripColumn, Math.max(positionColumn, loadColumn));
        int row = 1;
        for (String line = reader.readLine(); line != null; line = reader.readLine()) {
            row++;
            if (line.isBlank()) {
                continue;
            }
            List<String> values = fields(line);
            if (values.size() <= most) {
                throw ApiException.bad("row " + row + " of the CSV has too few values");
            }
            int trip = t.tripIndex(values.get(tripColumn));
            if (trip < 0) {
                throw ApiException.bad("row " + row + " of the CSV: there is no trip '" + values.get(tripColumn)
                        + "' in this timetable");
            }
            try {
                state.set(trip, Integer.parseInt(values.get(positionColumn)), Integer.parseInt(values.get(loadColumn)));
            } catch (NumberFormatException e) {
                throw ApiException.bad("row " + row + " of the CSV: position and load must be whole numbers");
            } catch (IllegalArgumentException e) {
                throw ApiException.bad("row " + row + " of the CSV: " + e.getMessage() + " ("
                        + values.get(tripColumn) + "), or the load is negative");
            }
        }
        return state;
    }

    /** Writes every place where anyone is aboard. */
    static void write(LoadState state, OutputStream out) throws IOException {
        Timetable t = state.timetable();
        Writer writer = new BufferedWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8));
        writer.write("trip_id,position,stop_id,load\n");
        for (int trip = 0; trip < t.tripCount(); trip++) {
            int first = t.patternStopOffset[t.tripPattern[trip]];
            for (int position = 0; position < t.patternLength(t.tripPattern[trip]); position++) {
                int load = state.load(trip, position);
                if (load > 0) {
                    writer.write(quoted(t.tripIds[trip]) + "," + position + ","
                            + quoted(t.stopIds[t.patternStops[first + position]]) + "," + load + "\n");
                }
            }
        }
        writer.flush();
    }

    private static String quoted(String text) {
        return text.indexOf(',') < 0 && text.indexOf('"') < 0 ? text : '"' + text.replace("\"", "\"\"") + '"';
    }

    /** Splits one line. A value may be in double quotes, with a quote inside it written twice. */
    static List<String> fields(String line) {
        List<String> fields = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (quoted) {
                if (c == '"' && i + 1 < line.length() && line.charAt(i + 1) == '"') {
                    field.append('"');
                    i++;
                } else if (c == '"') {
                    quoted = false;
                } else {
                    field.append(c);
                }
            } else if (c == '"') {
                quoted = true;
            } else if (c == ',') {
                fields.add(field.toString().strip());
                field.setLength(0);
            } else {
                field.append(c);
            }
        }
        fields.add(field.toString().strip());
        return fields;
    }
}
