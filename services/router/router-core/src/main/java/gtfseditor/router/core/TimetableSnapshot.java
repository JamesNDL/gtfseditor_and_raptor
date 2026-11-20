package gtfseditor.router.core;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Saves a built timetable to a file and reads it back, so a restart does not have to read the
 * GTFS zip again. The file is a cache: anything wrong with it means "not there".
 */
public final class TimetableSnapshot {

    /** Raise this whenever the file layout or the meaning of a stored value changes. */
    public static final int FORMAT = 5;

    private static final int MAGIC = 0x52545442; // "RTTB"
    private static final int END = 0x454e4421;   // "END!"
    private static final int CHUNK = 1 << 14;

    private TimetableSnapshot() {}

    /**
     * Writes the timetable beside the target and moves it into place, so a reader never sees half
     * a file.
     *
     * @param fingerprint identifies what the timetable was built from; {@link #read} checks it
     */
    public static void write(Timetable t, String fingerprint, Path file) throws IOException {
        Path folder = file.toAbsolutePath().getParent();
        Files.createDirectories(folder);
        Path partial = Files.createTempFile(folder, file.getFileName().toString(), ".part");
        try {
            try (DataOutputStream out = new DataOutputStream(
                    new BufferedOutputStream(Files.newOutputStream(partial), 1 << 16))) {
                out.writeInt(MAGIC);
                out.writeInt(FORMAT);
                writeText(out, fingerprint);
                writeText(out, t.feedVersion);
                out.writeInt(t.serviceDate);
                TransferSettings s = t.transferSettings;
                out.writeDouble(s.radiusMetres());
                out.writeDouble(s.walkMetresPerSec());
                out.writeDouble(s.detourFactor());
                out.writeInt(s.fixedSecs());
                out.writeInt(s.stationMinSecs());
                out.writeDouble(s.stationMaxMetres());
                out.writeInt(s.maxPerStop());
                out.writeInt(s.defaultPathwaySecs());
                out.writeInt(s.maxPathwaySecs());
                out.writeInt(s.platformSecs());
                out.writeDouble(t.capacityFactor);
                writeTexts(out, t.notes.toArray(String[]::new));
                writeTexts(out, t.stationIds);
                writeTexts(out, t.stationNames);
                writeTexts(out, t.stopIds);
                writeTexts(out, t.stopNames);
                writeDoubles(out, t.stopLat);
                writeDoubles(out, t.stopLon);
                writeInts(out, t.stopStation);
                writeTexts(out, t.routeIds);
                writeTexts(out, t.routeNames);
                writeInts(out, t.routeTypes);
                writeInts(out, t.patternStopOffset);
                writeInts(out, t.patternTripOffset);
                writeInts(out, t.patternStops);
                writeBytes(out, t.patternStopFlags);
                writeInts(out, t.arrive);
                writeInts(out, t.depart);
                writeTexts(out, t.tripIds);
                writeTexts(out, t.tripHeadsigns);
                writeInts(out, t.tripRoute);
                writeInts(out, t.tripCapacity);
                writeBytes(out, t.tripCapacityFlags);
                writeInts(out, t.tripStayAboard);
                writeInts(out, t.transferOffset);
                writeInts(out, t.transferTargets);
                writeInts(out, t.transferSecs);
                writeInts(out, t.transferMetres);
                writeInts(out, t.stopExitSecs);
                writeInts(out, t.stopEntrySecs);
                writeDoubles(out, t.water.lines);
                writeDoubles(out, t.water.bridges);
                out.writeInt(END);
            }
            try {
                Files.move(partial, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(partial, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(partial);
        }
    }

    /**
     * Reads a snapshot.
     *
     * @return the timetable, or empty if the file is missing, damaged, from another format, or was
     *     built from something with a different fingerprint
     */
    public static Optional<Timetable> read(Path file, String fingerprint) {
        if (!Files.isRegularFile(file)) {
            return Optional.empty();
        }
        try (DataInputStream in = new DataInputStream(
                new BufferedInputStream(Files.newInputStream(file), 1 << 16))) {
            Reader r = new Reader(in, Files.size(file));
            if (in.readInt() != MAGIC || in.readInt() != FORMAT || !r.text().equals(fingerprint)) {
                return Optional.empty();
            }
            Timetable.Builder b = new Timetable.Builder();
            b.feedVersion = r.text();
            b.serviceDate = in.readInt();
            b.transferSettings = new TransferSettings(in.readDouble(), in.readDouble(), in.readDouble(),
                    in.readInt(), in.readInt(), in.readDouble(), in.readInt(), in.readInt(), in.readInt(),
                    in.readInt());
            b.capacityFactor = in.readDouble();
            b.notes = List.of(r.texts(false));
            b.stationIds = r.texts(false);
            b.stationNames = r.texts(false);
            b.stopIds = r.texts(false);
            b.stopNames = r.texts(false);
            b.stopLat = r.doubles();
            b.stopLon = r.doubles();
            b.stopStation = r.ints();
            b.routeIds = r.texts(false);
            b.routeNames = r.texts(false);
            b.routeTypes = r.ints();
            b.patternStopOffset = r.ints();
            b.patternTripOffset = r.ints();
            b.patternStops = r.ints();
            b.patternStopFlags = r.bytes();
            b.arrive = r.ints();
            b.depart = r.ints();
            b.tripIds = r.texts(false);
            b.tripHeadsigns = r.texts(true);
            b.tripRoute = r.ints();
            b.tripCapacity = r.ints();
            b.tripCapacityFlags = r.bytes();
            b.tripStayAboard = r.ints();
            b.transferOffset = r.ints();
            b.transferTargets = r.ints();
            b.transferSecs = r.ints();
            b.transferMetres = r.ints();
            b.stopExitSecs = r.ints();
            b.stopEntrySecs = r.ints();
            b.waterLines = r.doubles();
            b.waterBridges = r.doubles();
            if (in.readInt() != END) {
                return Optional.empty();
            }
            return Optional.of(b.build());
        } catch (IOException | RuntimeException e) {
            return Optional.empty();
        }
    }

    private static void writeText(DataOutputStream out, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        out.writeInt(bytes.length);
        out.write(bytes);
    }

    private static void writeTexts(DataOutputStream out, String[] texts) throws IOException {
        out.writeInt(texts.length);
        for (String text : texts) {
            writeText(out, text);
        }
    }

    private static void writeBytes(DataOutputStream out, byte[] values) throws IOException {
        out.writeInt(values.length);
        out.write(values);
    }

    private static void writeDoubles(DataOutputStream out, double[] values) throws IOException {
        out.writeInt(values.length);
        for (double value : values) {
            out.writeDouble(value);
        }
    }

    private static void writeInts(DataOutputStream out, int[] values) throws IOException {
        out.writeInt(values.length);
        ByteBuffer bytes = ByteBuffer.allocate(CHUNK * 4);
        for (int at = 0; at < values.length; at += CHUNK) {
            int count = Math.min(CHUNK, values.length - at);
            bytes.clear();
            bytes.asIntBuffer().put(values, at, count);
            out.write(bytes.array(), 0, count * 4);
        }
    }

    /** Reads the pieces back, refusing lengths the file could not possibly hold. */
    private static final class Reader {
        private final DataInputStream in;
        private final long fileBytes;

        Reader(DataInputStream in, long fileBytes) {
            this.in = in;
            this.fileBytes = fileBytes;
        }

        private int length(int bytesEach) throws IOException {
            int length = in.readInt();
            if (length < 0 || (long) length * bytesEach > fileBytes) {
                throw new IOException("snapshot is damaged");
            }
            return length;
        }

        String text() throws IOException {
            byte[] bytes = new byte[length(1)];
            in.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        }

        /** @param shared whether equal texts should become one object (many trips share a headsign) */
        String[] texts(boolean shared) throws IOException {
            String[] texts = new String[length(4)];
            Map<String, String> seen = shared ? new HashMap<>() : null;
            for (int i = 0; i < texts.length; i++) {
                String text = text();
                if (seen != null) {
                    String first = seen.putIfAbsent(text, text);
                    text = first == null ? text : first;
                }
                texts[i] = text;
            }
            return texts;
        }

        byte[] bytes() throws IOException {
            byte[] values = new byte[length(1)];
            in.readFully(values);
            return values;
        }

        double[] doubles() throws IOException {
            double[] values = new double[length(8)];
            for (int i = 0; i < values.length; i++) {
                values[i] = in.readDouble();
            }
            return values;
        }

        int[] ints() throws IOException {
            int[] values = new int[length(4)];
            byte[] chunk = new byte[CHUNK * 4];
            for (int at = 0; at < values.length; at += CHUNK) {
                int count = Math.min(CHUNK, values.length - at);
                in.readFully(chunk, 0, count * 4);
                ByteBuffer.wrap(chunk, 0, count * 4).asIntBuffer().get(values, at, count);
            }
            return values;
        }
    }
}
