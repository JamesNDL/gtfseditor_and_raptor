package gtfseditor.router.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class CapacityModeTest {

    @Test
    void wireNamesRoundTrip() {
        for (CapacityMode mode : CapacityMode.values()) {
            assertEquals(mode, CapacityMode.parse(mode.wireName()));
        }
    }

    @Test
    void parseIgnoresCaseAndSpaces() {
        assertEquals(CapacityMode.CHECK, CapacityMode.parse(" Check "));
    }

    @Test
    void parseRejectsUnknownAndMissingNames() {
        assertThrows(IllegalArgumentException.class, () -> CapacityMode.parse("full"));
        assertThrows(IllegalArgumentException.class, () -> CapacityMode.parse(null));
    }
}
