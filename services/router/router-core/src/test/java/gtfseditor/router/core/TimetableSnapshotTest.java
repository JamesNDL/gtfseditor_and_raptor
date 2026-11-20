package gtfseditor.router.core;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TimetableSnapshotTest {

    @TempDir
    Path folder;

    @Test
    void aSavedTimetableReadsBackTheSame() throws Exception {
        Timetable saved = TestTimetables.tiny().build();
        Path file = folder.resolve("deeper/tiny.timetable");
        TimetableSnapshot.write(saved, "abc", file);

        Timetable read = TimetableSnapshot.read(file, "abc").orElseThrow();

        assertEquals(saved.feedVersion, read.feedVersion);
        assertEquals(saved.serviceDate, read.serviceDate);
        assertEquals(saved.transferSettings, read.transferSettings);
        assertEquals(saved.capacityFactor, read.capacityFactor);
        assertEquals(saved.notes, read.notes);
        assertArrayEquals(saved.stationIds, read.stationIds);
        assertArrayEquals(saved.stationNames, read.stationNames);
        assertArrayEquals(saved.stopIds, read.stopIds);
        assertArrayEquals(saved.stopNames, read.stopNames);
        assertArrayEquals(saved.stopLat, read.stopLat);
        assertArrayEquals(saved.stopLon, read.stopLon);
        assertArrayEquals(saved.stopStation, read.stopStation);
        assertArrayEquals(saved.routeIds, read.routeIds);
        assertArrayEquals(saved.routeNames, read.routeNames);
        assertArrayEquals(saved.routeTypes, read.routeTypes);
        assertArrayEquals(saved.patternStopOffset, read.patternStopOffset);
        assertArrayEquals(saved.patternTripOffset, read.patternTripOffset);
        assertArrayEquals(saved.patternTimeOffset, read.patternTimeOffset);
        assertArrayEquals(saved.patternStops, read.patternStops);
        assertArrayEquals(saved.patternStopFlags, read.patternStopFlags);
        assertArrayEquals(saved.arrive, read.arrive);
        assertArrayEquals(saved.depart, read.depart);
        assertArrayEquals(saved.tripIds, read.tripIds);
        assertArrayEquals(saved.tripHeadsigns, read.tripHeadsigns);
        assertArrayEquals(saved.tripRoute, read.tripRoute);
        assertArrayEquals(saved.tripCapacity, read.tripCapacity);
        assertArrayEquals(saved.tripCapacityFlags, read.tripCapacityFlags);
        assertArrayEquals(saved.tripStayAboard, read.tripStayAboard);
        assertArrayEquals(saved.stopPatterns, read.stopPatterns);
        assertArrayEquals(saved.transferOffset, read.transferOffset);
        assertArrayEquals(saved.transferTargets, read.transferTargets);
        assertArrayEquals(saved.transferSecs, read.transferSecs);
        assertArrayEquals(saved.transferMetres, read.transferMetres);
        assertArrayEquals(saved.stopExitSecs, read.stopExitSecs);
        assertArrayEquals(saved.stopEntrySecs, read.stopEntrySecs);
        assertArrayEquals(saved.water.lines, read.water.lines);
        assertArrayEquals(saved.water.bridges, read.water.bridges);
        // Trips with the same headsign share one text.
        assertSame(read.tripHeadsigns[0], read.tripHeadsigns[1]);
    }

    @Test
    void nothingIsLeftBesideTheSnapshot() throws Exception {
        Path file = folder.resolve("tiny.timetable");
        TimetableSnapshot.write(TestTimetables.tiny().build(), "abc", file);
        TimetableSnapshot.write(TestTimetables.tiny().build(), "abc", file);
        try (var files = Files.list(folder)) {
            assertEquals(1, files.count());
        }
    }

    @Test
    void aSnapshotOfSomethingElseIsNotUsed() throws Exception {
        Path file = folder.resolve("tiny.timetable");
        TimetableSnapshot.write(TestTimetables.tiny().build(), "abc", file);
        assertEquals(Optional.empty(), TimetableSnapshot.read(file, "abd"));
    }

    @Test
    void aMissingOrDamagedSnapshotIsNotUsed() throws Exception {
        Path file = folder.resolve("tiny.timetable");
        assertEquals(Optional.empty(), TimetableSnapshot.read(file, "abc"));

        TimetableSnapshot.write(TestTimetables.tiny().build(), "abc", file);
        byte[] whole = Files.readAllBytes(file);
        for (int length : new int[] {0, 3, 20, whole.length / 2, whole.length - 1}) {
            Files.write(file, Arrays.copyOf(whole, length));
            assertEquals(Optional.empty(), TimetableSnapshot.read(file, "abc"), "cut to " + length + " bytes");
        }

        Files.write(file, "not a snapshot at all".getBytes());
        assertEquals(Optional.empty(), TimetableSnapshot.read(file, "abc"));

        Files.write(file, whole);
        assertTrue(TimetableSnapshot.read(file, "abc").isPresent());
    }
}
