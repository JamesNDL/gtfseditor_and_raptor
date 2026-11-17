package gtfseditor.router.gtfs;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Reads one GTFS text file a row at a time. The row is kept as bytes and a value becomes a number
 * or a text only when asked for, so two million stop times do not become two million objects.
 *
 * <p>Handles quoted values, doubled quotes, line breaks inside quotes, Windows line endings, a
 * byte-order mark and blank lines. A column the file does not have reads as empty.
 */
final class CsvReader implements Closeable {

    private static final int PLAIN = 0;
    private static final int QUOTED = 1;
    private static final int QUOTE_SEEN = 2;

    private final InputStream in;
    private final String file;
    private final byte[] buffer = new byte[1 << 16];
    private int position;
    private int limit;

    private byte[] row = new byte[256];
    private int[] ends = new int[16];
    private int fields;
    private long rowNumber;
    private final Map<String, Integer> columns = new HashMap<>();

    CsvReader(InputStream in, String file) throws IOException {
        this.in = in;
        this.file = file;
        limit = in.readNBytes(buffer, 0, buffer.length);
        if (limit >= 3 && (buffer[0] & 0xff) == 0xEF && (buffer[1] & 0xff) == 0xBB && (buffer[2] & 0xff) == 0xBF) {
            position = 3;
        }
        if (!readRow()) {
            throw new GtfsException(file + " is empty");
        }
        for (int i = 0; i < fields; i++) {
            columns.putIfAbsent(text(i).strip(), i);
        }
        rowNumber = 0;
    }

    /** The position of a column, or -1 if the file does not have it. */
    int column(String name) {
        return columns.getOrDefault(name, -1);
    }

    /** The position of a column the file must have. */
    int require(String name) {
        int column = column(name);
        if (column < 0) {
            throw new GtfsException(file + " has no " + name + " column");
        }
        return column;
    }

    /** Moves to the next row. Returns false at the end of the file. */
    boolean next() throws IOException {
        return readRow();
    }

    boolean isEmpty(int column) {
        return column < 0 || column >= fields || start(column) == ends[column];
    }

    /** The value as text; empty if the column or the value is missing. */
    String text(int column) {
        if (column < 0 || column >= fields) {
            return "";
        }
        int start = start(column);
        return new String(row, start, ends[column] - start, StandardCharsets.UTF_8);
    }

    /** Whether the value is exactly this text. Only for text in plain ASCII. */
    boolean matches(int column, String text) {
        if (column < 0 || column >= fields) {
            return text.isEmpty();
        }
        int start = start(column);
        int length = ends[column] - start;
        if (length != text.length()) {
            return false;
        }
        for (int i = 0; i < length; i++) {
            if (row[start + i] != text.charAt(i)) {
                return false;
            }
        }
        return true;
    }

    /** The value as a whole number, or the fallback if it is missing. */
    int number(int column, int fallback) {
        if (column < 0 || column >= fields) {
            return fallback;
        }
        int start = start(column);
        int end = ends[column];
        while (start < end && row[start] == ' ') {
            start++;
        }
        while (end > start && row[end - 1] == ' ') {
            end--;
        }
        if (start == end) {
            return fallback;
        }
        boolean negative = row[start] == '-';
        if (negative) {
            start++;
        }
        if (start == end) {
            throw bad(column, "a whole number");
        }
        long value = 0;
        for (int i = start; i < end; i++) {
            int digit = row[i] - '0';
            if (digit < 0 || digit > 9 || value > Integer.MAX_VALUE) {
                throw bad(column, "a whole number");
            }
            value = value * 10 + digit;
        }
        if (value > Integer.MAX_VALUE) {
            throw bad(column, "a whole number");
        }
        return (int) (negative ? -value : value);
    }

    /** The value as a decimal number. */
    double decimal(int column) {
        try {
            return Double.parseDouble(text(column).strip());
        } catch (NumberFormatException e) {
            throw bad(column, "a number");
        }
    }

    /**
     * A time written as {@code H:MM:SS}, in seconds. Hours may pass 24. Returns -1 if the value is
     * missing.
     */
    int seconds(int column) {
        if (isEmpty(column)) {
            return -1;
        }
        int start = start(column);
        int end = ends[column];
        while (start < end && row[start] == ' ') {
            start++;
        }
        while (end > start && row[end - 1] == ' ') {
            end--;
        }
        if (start == end) {
            return -1;
        }
        int[] parts = new int[3];
        int part = 0;
        int digits = 0;
        for (int i = start; i < end; i++) {
            byte b = row[i];
            if (b == ':') {
                if (digits == 0 || ++part > 2) {
                    throw bad(column, "a time");
                }
                digits = 0;
            } else if (b >= '0' && b <= '9' && digits < 4) {
                parts[part] = parts[part] * 10 + (b - '0');
                digits++;
            } else {
                throw bad(column, "a time");
            }
        }
        if (part != 2 || digits == 0 || parts[1] > 59 || parts[2] > 59) {
            throw bad(column, "a time");
        }
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    /** Where the current row is, for error messages. */
    String where() {
        return file + " row " + rowNumber;
    }

    @Override
    public void close() throws IOException {
        in.close();
    }

    private int start(int column) {
        return column == 0 ? 0 : ends[column - 1];
    }

    private GtfsException bad(int column, String wanted) {
        return new GtfsException(where() + ": '" + text(column) + "' is not " + wanted);
    }

    private boolean readRow() throws IOException {
        fields = 0;
        int length = 0;
        int fieldStart = 0;
        int state = PLAIN;
        boolean any = false;
        while (true) {
            if (position == limit) {
                limit = in.readNBytes(buffer, 0, buffer.length);
                position = 0;
                if (limit == 0) {
                    if (state == QUOTED) {
                        throw new GtfsException(file + ": a quoted value is never closed");
                    }
                    if (!any) {
                        return false;
                    }
                    break;
                }
            }
            byte b = buffer[position++];
            if (state == QUOTED) {
                if (b == '"') {
                    state = QUOTE_SEEN;
                    continue;
                }
            } else {
                if (state == QUOTE_SEEN) {
                    state = PLAIN;
                    if (b == '"') {
                        state = QUOTED; // a doubled quote is one quote character
                    }
                }
                if (state == PLAIN) {
                    if (b == ',') {
                        endField(length);
                        fieldStart = length;
                        any = true;
                        continue;
                    }
                    if (b == '\n') {
                        if (any) {
                            break;
                        }
                        continue;
                    }
                    if (b == '\r') {
                        continue;
                    }
                    if (b == '"' && length == fieldStart) {
                        state = QUOTED;
                        any = true;
                        continue;
                    }
                }
            }
            if (length == row.length) {
                row = Arrays.copyOf(row, length * 2);
            }
            row[length++] = b;
            any = true;
        }
        endField(length);
        rowNumber++;
        return true;
    }

    private void endField(int end) {
        if (fields == ends.length) {
            ends = Arrays.copyOf(ends, fields * 2);
        }
        ends[fields++] = end;
    }
}
