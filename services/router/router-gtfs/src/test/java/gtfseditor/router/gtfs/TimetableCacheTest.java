package gtfseditor.router.gtfs;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.TransferSettings;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TimetableCacheTest {

    @TempDir
    Path folder;

    private static Feed feed(String departure) {
        return new Feed().oneDay()
                .file("routes.txt", "route_id,route_short_name,route_type", "R,1,3")
                .file("trips.txt", "route_id,service_id,trip_id", "R,DAY,T")
                .file("stops.txt", "stop_id,stop_name,stop_lat,stop_lon", "A,A,-33.0,151.0", "B,B,-33.1,151.0")
                .file("stop_times.txt",
                        "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
                        "T," + departure + "," + departure + ",A,1",
                        "T,09:00:00,09:00:00,B,2");
    }

    @Test
    void theSecondLoadComesFromTheSnapshot() throws Exception {
        Path zip = feed("08:00:00").zip(folder);
        Path snapshots = folder.resolve("snapshots");

        TimetableCache.Loaded first = TimetableCache.load(zip, LoadOptions.defaults(), snapshots);
        assertFalse(first.fromSnapshot());
        assertTrue(Files.isRegularFile(first.snapshot()));

        TimetableCache.Loaded second = TimetableCache.load(zip, LoadOptions.defaults(), snapshots);
        assertTrue(second.fromSnapshot());
        assertEquals(first.snapshot(), second.snapshot());
        assertArrayEquals(first.timetable().depart, second.timetable().depart);
        assertEquals(first.timetable().notes, second.timetable().notes);
    }

    @Test
    void aCopyOfTheZipUsesTheSameSnapshot() throws Exception {
        Path zip = feed("08:00:00").zip(folder);
        Path copy = Files.copy(zip, folder.resolve("copy.zip"));
        assertEquals(TimetableCache.fingerprint(zip, LoadOptions.defaults()),
                TimetableCache.fingerprint(copy, LoadOptions.defaults()));
    }

    @Test
    void aDifferentZipOrDifferentOptionsBuildsAgain() throws Exception {
        Path snapshots = folder.resolve("snapshots");
        Path zip = feed("08:00:00").zip(folder);
        TimetableCache.load(zip, LoadOptions.defaults(), snapshots);

        Path edited = feed("08:30:00").zip(folder);
        assertNotEquals(TimetableCache.fingerprint(zip, LoadOptions.defaults()),
                TimetableCache.fingerprint(edited, LoadOptions.defaults()));
        TimetableCache.Loaded other = TimetableCache.load(edited, LoadOptions.defaults(), snapshots);
        assertFalse(other.fromSnapshot());
        assertEquals(8 * 3600 + 1800, other.timetable().depart[0]);

        LoadOptions wider = LoadOptions.defaults().withTransfers(TransferSettings.defaults().withRadiusMetres(900));
        assertFalse(TimetableCache.load(zip, wider, snapshots).fromSnapshot());
        assertTrue(TimetableCache.load(zip, wider, snapshots).fromSnapshot());
        assertTrue(TimetableCache.load(zip, LoadOptions.defaults(), snapshots).fromSnapshot());
    }
}
