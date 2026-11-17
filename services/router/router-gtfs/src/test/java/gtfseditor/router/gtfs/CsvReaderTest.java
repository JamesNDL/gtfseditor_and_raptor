package gtfseditor.router.gtfs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class CsvReaderTest {

    private static CsvReader read(String text) throws IOException {
        return new CsvReader(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), "test.txt");
    }

    @Test
    void readsPlainRows() throws IOException {
        CsvReader r = read("a,b,c\n1,two,3.5\n-4,,\n");
        assertTrue(r.next());
        assertEquals(1, r.number(r.column("a"), 0));
        assertEquals("two", r.text(r.column("b")));
        assertEquals(3.5, r.decimal(r.column("c")));
        assertTrue(r.next());
        assertEquals(-4, r.number(0, 0));
        assertTrue(r.isEmpty(1));
        assertEquals(9, r.number(2, 9));
        assertFalse(r.next());
    }

    @Test
    void readsQuotedValues() throws IOException {
        CsvReader r = read("id,name,note\n1,\"Central Station, Platform 1\",\"say \"\"hi\"\"\"\n2,\"two\nlines\",\"\"\n");
        assertTrue(r.next());
        assertEquals("Central Station, Platform 1", r.text(1));
        assertEquals("say \"hi\"", r.text(2));
        assertTrue(r.next());
        assertEquals("two\nlines", r.text(1));
        assertTrue(r.isEmpty(2));
        assertFalse(r.next());
    }

    @Test
    void copesWithWindowsLineEndingsAByteOrderMarkAndBlankLines() throws IOException {
        CsvReader r = read("﻿\"stop_id\",stop_name\r\n\r\nA,Café\r\n\r\nB,Other");
        assertEquals(0, r.column("stop_id"));
        assertTrue(r.next());
        assertEquals("A", r.text(0));
        assertEquals("Café", r.text(1));
        assertTrue(r.next());
        assertEquals("Other", r.text(1));
        assertFalse(r.next());
    }

    @Test
    void aMissingColumnOrShortRowReadsAsEmpty() throws IOException {
        CsvReader r = read("a,b,c\n1\n");
        assertEquals(-1, r.column("nope"));
        assertTrue(r.next());
        assertEquals("", r.text(r.column("nope")));
        assertTrue(r.isEmpty(2));
        assertEquals(7, r.number(2, 7));
        assertEquals(-1, r.seconds(1));
        assertThrows(GtfsException.class, () -> r.require("nope"));
    }

    @Test
    void readsTimesPastMidnight() throws IOException {
        CsvReader r = read("t\n04:05:00\n24:30:15\n 7:01:02 \n\"\"\n");
        assertTrue(r.next());
        assertEquals(4 * 3600 + 5 * 60, r.seconds(0));
        assertTrue(r.next());
        assertEquals(24 * 3600 + 30 * 60 + 15, r.seconds(0));
        assertTrue(r.next());
        assertEquals(7 * 3600 + 62, r.seconds(0));
        assertTrue(r.next());
        assertEquals(-1, r.seconds(0));
    }

    @Test
    void badValuesAreReportedWithTheirRow() throws IOException {
        CsvReader r = read("n,t\nabc,12:61:00\n99999999999,noon\n");
        assertTrue(r.next());
        GtfsException e = assertThrows(GtfsException.class, () -> r.number(0, 0));
        assertTrue(e.getMessage().contains("test.txt row 1"), e.getMessage());
        assertThrows(GtfsException.class, () -> r.seconds(1));
        assertTrue(r.next());
        assertThrows(GtfsException.class, () -> r.number(0, 0));
        assertThrows(GtfsException.class, () -> r.seconds(1));
    }

    @Test
    void comparesAValueWithoutMakingAText() throws IOException {
        CsvReader r = read("trip\nT1.a\n");
        assertTrue(r.next());
        assertTrue(r.matches(0, "T1.a"));
        assertFalse(r.matches(0, "T1.b"));
        assertFalse(r.matches(0, "T1"));
    }

    @Test
    void anEmptyFileOrAnUnclosedQuoteIsAnError() {
        assertThrows(GtfsException.class, () -> read(""));
        assertThrows(GtfsException.class, () -> read("a\n\"never closed\n").next());
    }

    @Test
    void readsRowsLongerThanTheBuffer() throws IOException {
        String big = "x".repeat(200_000);
        CsvReader r = read("a,b\n" + big + ",1\n" + big + ",2\n");
        assertTrue(r.next());
        assertEquals(200_000, r.text(0).length());
        assertTrue(r.next());
        assertEquals(2, r.number(1, 0));
        assertFalse(r.next());
    }
}
