package gtfseditor.router.gtfs;

import gtfseditor.router.core.Timetable;
import gtfseditor.router.core.TimetableSnapshot;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;

/**
 * Loads a timetable from a saved snapshot when there is one for exactly this zip and these
 * options, and otherwise builds it from the zip and saves a snapshot for next time.
 */
public final class TimetableCache {

    /**
     * @param fromSnapshot whether the timetable was read from a snapshot rather than built
     * @param snapshot     the snapshot file that was read or written
     */
    public record Loaded(Timetable timetable, boolean fromSnapshot, Path snapshot) {}

    private TimetableCache() {}

    public static Loaded load(Path zip, LoadOptions options, Path folder) throws IOException {
        String fingerprint = fingerprint(zip, options);
        String name = zip.getFileName().toString().replaceFirst("\\.zip$", "");
        Path file = folder.resolve(name + "-" + fingerprint.substring(0, 16) + ".timetable");
        Optional<Timetable> saved = TimetableSnapshot.read(file, fingerprint);
        if (saved.isPresent()) {
            return new Loaded(saved.get(), true, file);
        }
        Timetable timetable = GtfsLoader.load(zip, options);
        TimetableSnapshot.write(timetable, fingerprint, file);
        return new Loaded(timetable, false, file);
    }

    /**
     * A SHA-256 over the zip's bytes, the options and the snapshot format. The same zip saved under
     * another name or date gives the same fingerprint.
     */
    static String fingerprint(Path zip, LoadOptions options) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        byte[] buffer = new byte[1 << 20];
        try (InputStream in = Files.newInputStream(zip)) {
            for (int read = in.read(buffer); read >= 0; read = in.read(buffer)) {
                digest.update(buffer, 0, read);
            }
        }
        digest.update((options.fingerprintText() + "|format " + TimetableSnapshot.FORMAT)
                .getBytes(StandardCharsets.UTF_8));
        return HexFormat.of().formatHex(digest.digest());
    }
}
