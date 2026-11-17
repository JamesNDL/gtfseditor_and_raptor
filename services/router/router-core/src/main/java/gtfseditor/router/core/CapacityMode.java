package gtfseditor.router.core;

import java.util.Locale;

/**
 * How a search treats vehicle loads. See section 4.2 of docs/router-plan.md.
 */
public enum CapacityMode {
    /** Loads are ignored. */
    OFF,
    /** Full trips are skipped; loads are not changed. */
    CHECK,
    /** Full trips are skipped and the routed passenger is added to the loads. */
    ASSIGN;

    /** The name used in requests and responses: {@code off}, {@code check} or {@code assign}. */
    public String wireName() {
        return name().toLowerCase(Locale.ROOT);
    }

    /**
     * Reads a wire name, ignoring case and surrounding spaces.
     *
     * @throws IllegalArgumentException if the text is not one of the three names
     */
    public static CapacityMode parse(String text) {
        if (text == null) {
            throw new IllegalArgumentException("capacity mode is missing");
        }
        return switch (text.strip().toLowerCase(Locale.ROOT)) {
            case "off" -> OFF;
            case "check" -> CHECK;
            case "assign" -> ASSIGN;
            default -> throw new IllegalArgumentException(
                    "unknown capacity mode '" + text + "'; expected off, check or assign");
        };
    }
}
