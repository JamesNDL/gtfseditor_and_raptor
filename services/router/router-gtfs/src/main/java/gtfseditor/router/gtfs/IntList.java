package gtfseditor.router.gtfs;

import java.util.Arrays;

/** A growing list of whole numbers, without an object per number. */
final class IntList {

    int[] values;
    int size;

    IntList(int capacity) {
        values = new int[Math.max(1, capacity)];
    }

    void add(int value) {
        if (size == values.length) {
            values = Arrays.copyOf(values, size * 2);
        }
        values[size++] = value;
    }

    int get(int index) {
        return values[index];
    }

    int last() {
        return values[size - 1];
    }

    int[] toArray() {
        return Arrays.copyOf(values, size);
    }
}
