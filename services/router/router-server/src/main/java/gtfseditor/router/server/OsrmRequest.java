package gtfseditor.router.server;

import gtfseditor.router.road.LatLon;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

/**
 * Reading the OSRM-shaped requests (architecture §3.3; FR-13): points written {@code lon,lat}
 * and separated by {@code ;}, and the options OSRM takes. A request that cannot be read is a
 * {@link Refusal} with OSRM's own code, {@code InvalidQuery} for points and {@code InvalidOptions}
 * for options.
 */
final class OsrmRequest {

    /** OSRM's code for a request whose points cannot be read. */
    static final String INVALID_QUERY = "InvalidQuery";

    /** OSRM's code for an option that is not offered or cannot be read. */
    static final String INVALID_OPTIONS = "InvalidOptions";

    /** What a table may hold, from {@code annotations}. */
    enum Annotation {
        DURATION,
        DISTANCE
    }

    /** A request OSRM would refuse: HTTP 400 with {@code {code, message}}. */
    static final class Refusal extends RuntimeException {

        private static final long serialVersionUID = 1L;

        private final String code;

        Refusal(String code, String message) {
            super(message);
            this.code = code;
        }

        String code() {
            return code;
        }
    }

    private OsrmRequest() {}

    /** Reads the points of the path, {@code lon,lat;lon,lat;…}, longitude first as OSRM has it. */
    static List<LatLon> points(String text) {
        String[] parts = text.split(";", -1);
        List<LatLon> points = new ArrayList<>(parts.length);
        for (String part : parts) {
            points.add(point(part));
        }
        return points;
    }

    private static LatLon point(String text) {
        String[] lonLat = text.split(",", -1);
        if (lonLat.length != 2) {
            throw new Refusal(INVALID_QUERY, "'" + text + "' is not a point: write it lon,lat");
        }
        double lon = number(lonLat[0], text);
        double lat = number(lonLat[1], text);
        if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
            throw new Refusal(INVALID_QUERY, "'" + text + "' is not a place on the globe: lon must be -180 to 180"
                    + " and lat -90 to 90");
        }
        return new LatLon(lat, lon);
    }

    private static double number(String text, String point) {
        try {
            return Double.parseDouble(text.strip());
        } catch (NumberFormatException e) {
            throw new Refusal(INVALID_QUERY, "'" + point + "' is not a point: lon and lat must be numbers");
        }
    }

    /** {@code true} or {@code false}; left out gives {@code byDefault}. */
    static boolean flag(String value, String name, boolean byDefault) {
        if (value == null) {
            return byDefault;
        }
        return switch (value) {
            case "true" -> true;
            case "false" -> false;
            default -> throw new Refusal(INVALID_OPTIONS, name + " must be true or false, not '" + value + "'");
        };
    }

    /**
     * How many other drives to look for: {@code alternatives=true} gives {@code most}, a number
     * that many but no more than {@code most}, and {@code false} or left out none.
     */
    static int alternatives(String value, int most) {
        if (value == null || value.equals("false")) {
            return 0;
        }
        if (value.equals("true")) {
            return most;
        }
        // A number: OSRM's "look for up to this many others".
        return Math.min(count(value, "alternatives", 0), most);
    }

    /** A whole number of at least {@code least}. */
    static int count(String value, String name, int least) {
        try {
            int number = Integer.parseInt(value);
            if (number >= least) {
                return number;
            }
        } catch (NumberFormatException e) {
            // Refused below, as a number out of range is.
        }
        throw new Refusal(INVALID_OPTIONS, name + " must be a whole number of at least " + least + ", not '"
                + value + "'");
    }

    /**
     * Which points a table's rows or columns are: indexes separated by {@code ;}, or {@code all}
     * (also when left out).
     */
    static int[] indexes(String value, String name, int points) {
        if (value == null || value.equals("all")) {
            int[] all = new int[points];
            for (int i = 0; i < points; i++) {
                all[i] = i;
            }
            return all;
        }
        String[] parts = value.split(";", -1);
        int[] picked = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            int index = count(parts[i], name, 0);
            if (index >= points) {
                throw new Refusal(INVALID_OPTIONS, name + " names point " + index + ", but there are only " + points
                        + " (counting from 0)");
            }
            picked[i] = index;
        }
        return picked;
    }

    /** What a table holds: {@code duration} (the default, as OSRM), {@code distance}, or both. */
    static Set<Annotation> annotations(String value) {
        if (value == null) {
            return EnumSet.of(Annotation.DURATION);
        }
        Set<Annotation> wanted = EnumSet.noneOf(Annotation.class);
        for (String part : value.split(",", -1)) {
            switch (part) {
                case "duration" -> wanted.add(Annotation.DURATION);
                case "distance" -> wanted.add(Annotation.DISTANCE);
                default -> throw new Refusal(INVALID_OPTIONS, "annotations may be duration, distance or both, not '"
                        + value + "'");
            }
        }
        return wanted;
    }
}
