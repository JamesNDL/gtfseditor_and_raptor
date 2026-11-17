package gtfseditor.router.sim;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Timetable;
import java.io.IOException;
import java.io.StringReader;
import java.io.StringWriter;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The demand file: format, checks, positions, the area's share and the generator (phase S0). */
class DemandTest {

    private static Timetable timetable() {
        return new Net()
                .stop("A", 0, 0).stop("B", 5000, 0).stop("P1", 9000, 0).stop("P2", 9000, 100)
                .station("S", "P1", "P2")
                .line("L", 50, "A B P1", "0 10 20", "06:00 07:00 08:00 17:00")
                .line("M", 50, "P2 A", "0 30", "09:00")
                .build();
    }

    private static DemandReader.Read read(String csv) throws IOException {
        return DemandReader.read(new StringReader(csv));
    }

    @Test
    void readsEveryFormOfARow() throws IOException {
        DemandReader.Read read = read("﻿user_id,start_time,origin_stop,destination_stop,people,journey_id,"
                + "origin_lat,origin_lon,destination_lat,destination_lon\r\n"
                + "u1,07:45,A,B,,,,,,\r\n"
                + "\"Smith, J\",07:45:30,A,B,3,trip-9,,,,\r\n"
                + "u1,27000,B,A,,,,,,\r\n"
                + "\r\n"
                + "u3,24:30,,B,1,77,-33.5,151.25,,\r\n");
        Demand d = read.demand();
        assertEquals(4, d.size());
        assertEquals(4, read.report().rowsRead());
        assertEquals(0, read.report().rowsRefused());
        assertArrayEquals(new int[] {7 * 3600 + 45 * 60, 7 * 3600 + 45 * 60 + 30, 27000, 24 * 3600 + 1800}, d.start);
        assertArrayEquals(new int[] {1, 3, 1, 1}, d.people);
        assertEquals("Smith, J", d.userId(1));
        assertEquals(d.user[0], d.user[2], "one user, two rows");
        assertEquals(3, d.userCount());
        // A row with no id of its own is known by its number in the file.
        assertEquals("1", d.journeyId(0));
        assertEquals("trip-9", d.journeyId(1));
        assertEquals("3", d.journeyId(2));
        assertEquals("77", d.journeyId(3));
        assertEquals(d.origin[0], d.origin[1], "the same stop is the same place");
        assertEquals("", d.placeStop[d.origin[3]]);
        assertEquals(-33.5, d.placeLat[d.origin[3]]);
        assertTrue(Double.isNaN(d.placeLat[d.origin[0]]), "a stop's position is not known until it is looked up");
        assertEquals(6, d.totalPeople());
    }

    @Test
    void refusesRowsItCannotUseAndSaysWhy() throws IOException {
        DemandReader.Read read = read("user_id,start_time,origin_stop,destination_stop,people,origin_lat,origin_lon\n"
                + "u1,07:45,A,B,,,\n"
                + ",07:45,A,B,,,\n"
                + "u2,quarter to eight,A,B,,,\n"
                + "u3,37:00,A,B,,,\n"
                + "u4,07:45,A,B,0,,\n"
                + "u5,07:45,A,B,two,,\n"
                + "u6,07:45,A,B,,-33.5,\n"
                + "u7,07:45,A,B,,-133.5,151\n"
                + "u8,07:45,,B,,,\n"
                + "u9,07:61,A,B,,,\n");
        assertEquals(1, read.demand().size());
        assertEquals(10, read.report().rowsRead());
        assertEquals(9, read.report().rowsRefused());
        assertEquals(1, read.report().refused().get("no user_id"));
        assertEquals(2, read.report().refused().get("a start_time that cannot be read"));
        assertEquals(1, read.report().refused().get("a start_time after 36:00:00, outside the service day"));
        assertEquals(2, read.report().refused().get("people is not a whole number above 0"));
        assertEquals(2, read.report().refused().get("an origin position that cannot be read"));
        assertEquals(1, read.report().refused().get("no stop id and no position for one end"));
        assertTrue(read.report().examples().get(0).startsWith("line 3"), read.report().examples().toString());
    }

    @Test
    void aFileWithoutARequiredColumnIsNotRead() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> read("user_id,start_time,origin_stop\nu1,07:45,A\n"));
        assertTrue(e.getMessage().contains("destination_stop"), e.getMessage());
        assertThrows(IllegalArgumentException.class, () -> read(""));
    }

    @Test
    void stopsGetTheirPositionsFromThePublishedTimetable() throws IOException {
        Timetable t = timetable();
        DemandReader.Read read = read("user_id,start_time,origin_stop,destination_stop,destination_lat,destination_lon\n"
                + "u1,07:45,A,B,,\n"          // both looked up
                + "u2,07:45,A,S,,\n"          // a station: the middle of its stops
                + "u3,07:45,A,NOWHERE,,\n"    // unknown and no position: refused
                + "u4,07:45,A,NOWHERE,-33.2,151.3\n" // unknown with a position: kept
                + "u5,07:45,A,B,-33.2,151.3\n");     // a file's own position is kept
        Demand d = read.demand().located(t, read.report());
        assertEquals(4, d.size());
        assertEquals(1, read.report().refused().get("a stop id the timetable does not have, and no position given"));
        assertEquals(t.stopLat[t.stopIndex("A")], d.placeLat[d.origin[0]]);
        assertEquals(t.stopLon[t.stopIndex("B")], d.placeLon[d.destination[0]]);
        double middle = (t.stopLat[t.stopIndex("P1")] + t.stopLat[t.stopIndex("P2")]) / 2;
        assertEquals(middle, d.placeLat[d.destination[1]], 1e-12);
        assertEquals("u4", d.userId(2));
        assertEquals(-33.2, d.placeLat[d.destination[2]]);
        assertEquals(-33.2, d.placeLat[d.destination[3]]);
        assertNotEquals(d.destination[0], d.destination[3], "the same stop at another position is another place");
    }

    @Test
    void whatIsWrittenReadsBackTheSame(@TempDir Path folder) throws IOException {
        Timetable t = timetable();
        Demand made = DemandGenerator.generate(t, null, 500, 3, 0);
        Path file = folder.resolve("demand.csv.gz");
        DemandWriter.write(made, file);
        Demand back = DemandReader.read(file).demand();
        StringWriter first = new StringWriter();
        StringWriter second = new StringWriter();
        DemandWriter.write(made, first);
        DemandWriter.write(back, second);
        assertEquals(first.toString(), second.toString());
        assertEquals(500, back.size());

        Demand odd = read("user_id,start_time,origin_stop,destination_stop,journey_id\n"
                + "\"a \"\"quoted\"\" user, with a comma\",07:45,A,B,007\n").demand();
        StringWriter written = new StringWriter();
        DemandWriter.write(odd, written);
        Demand again = read(written.toString()).demand();
        assertEquals("a \"quoted\" user, with a comma", again.userId(0));
        assertEquals("007", again.journeyId(0), "an id that is not a plain number is kept as text");
    }

    @Test
    void theGeneratorIsRepeatableAndStaysInsideItsArea() {
        Timetable t = timetable();
        Demand one = DemandGenerator.generate(t, null, 2000, 11, 0);
        Demand same = DemandGenerator.generate(t, null, 2000, 11, 0);
        Demand other = DemandGenerator.generate(t, null, 2000, 12, 0);
        assertEquals(2000, one.size());
        assertArrayEquals(one.start, same.start);
        assertArrayEquals(one.origin, same.origin);
        assertTrue(!java.util.Arrays.equals(one.start, other.start), "another seed, another set");
        assertTrue(one.userCount() < 2000 && one.userCount() > 1000, "some users travel back: " + one.userCount());
        DemandReport.Figures f = DemandReport.figures(one);
        assertTrue(f.earliest() >= 5 * 3600 && f.latest() < 24 * 3600);
        for (int row = 0; row < one.size(); row++) {
            assertNotEquals(one.origin[row], one.destination[row]);
        }

        // Only A and B are in the western half of the map.
        Area west = new Area("box", -34, -32, 150, t.stopLon[t.stopIndex("B")] + 0.001);
        Demand boxed = DemandGenerator.generate(t, west, 300, 1, 0);
        for (int place = 0; place < boxed.placeCount(); place++) {
            assertTrue(boxed.placeStop[place].equals("A") || boxed.placeStop[place].equals("B"));
        }
        // With focus, the stop with most service takes a larger share; with people, a row stands for several.
        Demand focused = DemandGenerator.generate(t, null, 2000, 11, 0, 3.0, 17);
        assertEquals(2000 * 17, focused.totalPeople());
        assertTrue(endsAt(focused, "A") > endsAt(one, "A"), "A has the most calls");
        assertThrows(IllegalArgumentException.class, () -> DemandGenerator.generate(t, null, 10, 1, 0, 0, 1));

        Area empty = new Area("box", 10, 11, 10, 11);
        assertThrows(IllegalArgumentException.class, () -> DemandGenerator.generate(t, empty, 10, 1, 0));
    }

    private static int endsAt(Demand demand, String stop) {
        int ends = 0;
        for (int row = 0; row < demand.size(); row++) {
            ends += demand.placeStop[demand.origin[row]].equals(stop) ? 1 : 0;
            ends += demand.placeStop[demand.destination[row]].equals(stop) ? 1 : 0;
        }
        return ends;
    }

    @Test
    void aShareOfTheDemandStandsForAllOfIt() {
        Demand all = DemandGenerator.generate(timetable(), null, 1000, 5, 0);
        Demand tenth = all.share(10);
        assertEquals(100, tenth.size());
        assertEquals(1000, tenth.totalPeople());
        assertEquals(all.journeyId(990), tenth.journeyId(99));
        assertEquals(all, all.share(1));
    }

    @Test
    void timesReadAsThePlanSays() {
        assertEquals(27900, Clock.parse("07:45"));
        assertEquals(27930, Clock.parse("07:45:30"));
        assertEquals(27900, Clock.parse("27900"));
        assertEquals(88200, Clock.parse("24:30"));
        assertEquals(-1, Clock.parse("7.45"));
        assertEquals(-1, Clock.parse("07:60"));
        assertEquals(-1, Clock.parse(""));
        assertEquals(-1, Clock.parse("07:45:"));
        assertEquals("24:30:00", Clock.text(88200));
    }

    @Test
    void anAreaIsABoxWithAName() {
        assertEquals(Area.OPAL, Area.parse("opal"));
        assertEquals(null, Area.parse("all"));
        Area box = Area.parse("-33.2,151.1,-32.7,151.9");
        assertTrue(box.holds(-32.93, 151.78) && !box.holds(-33.87, 151.21));
        assertEquals(box, Area.parse(box.text()));
        assertThrows(IllegalArgumentException.class, () -> Area.parse("mars"));
        assertThrows(IllegalArgumentException.class, () -> Area.parse("-32,151,-33,152"));
    }
}
