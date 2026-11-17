package gtfseditor.router.core;

import java.util.Locale;

/**
 * The kind of vehicle a route uses. The names match the editor's mode ids.
 */
public enum Mode {
    TRAIN,
    METRO,
    LIGHT_RAIL,
    FERRY,
    BUS,
    COACH,
    SCHOOL_BUS,
    OTHER;

    private static final Mode[] VALUES = values();

    /** The name used in requests, responses and the editor's files, for example {@code light_rail}. */
    public String wireName() {
        return name().toLowerCase(Locale.ROOT);
    }

    /** The mode with this position in the declaration order. */
    public static Mode of(int ordinal) {
        return VALUES[ordinal];
    }

    /**
     * The mode for a GTFS {@code route_type}, basic or extended. The extended values follow the
     * editor's own table: 712 is a school bus, 2xx a coach, 4xx a metro, 9xx light rail.
     */
    public static Mode ofRouteType(int routeType) {
        switch (routeType) {
            case 0, 5:
                return LIGHT_RAIL;
            case 1:
                return METRO;
            case 2:
                return TRAIN;
            case 3, 11:
                return BUS;
            case 4:
                return FERRY;
            case 712:
                return SCHOOL_BUS;
            default:
                break;
        }
        return switch (routeType / 100) {
            case 1 -> TRAIN;
            case 2 -> COACH;
            case 4 -> METRO;
            case 7, 8 -> BUS;
            case 9 -> LIGHT_RAIL;
            case 10, 12 -> FERRY;
            default -> OTHER;
        };
    }
}
