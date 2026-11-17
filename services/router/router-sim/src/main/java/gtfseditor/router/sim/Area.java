package gtfseditor.router.sim;

import java.util.List;
import java.util.Locale;

/**
 * A box on the map. A run limited to one keeps only the journeys that start and end inside it. See
 * section 4.7 of docs/simulator-plan.md.
 */
public record Area(String name, double south, double north, double west, double east) {

    public Area {
        if (!(south < north) || !(west < east)) {
            throw new IllegalArgumentException("an area needs its south below its north and its west below its east");
        }
    }

    /** Roughly where an Opal card works; the rectangle of section 17 of docs/router-plan.md. */
    public static final Area OPAL = new Area("opal", -34.75, -32.70, 150.10, 151.85);

    /**
     * The four areas the plan provides. Only the Opal rectangle comes from elsewhere; the other
     * three were drawn by eye around the places they are named for.
     */
    public static final List<Area> PROVIDED = List.of(
            OPAL,
            new Area("newcastle", -33.20, -32.70, 151.15, 151.85),
            new Area("sydney", -34.20, -33.40, 150.60, 151.40),
            new Area("wollongong", -34.75, -34.10, 150.60, 151.10));

    public boolean holds(double lat, double lon) {
        return lat >= south && lat <= north && lon >= west && lon <= east;
    }

    /**
     * Reads the name of a provided area, {@code all} (no box: null), or four numbers
     * {@code south,west,north,east}.
     */
    public static Area parse(String text) {
        String wanted = text.strip().toLowerCase(Locale.ROOT);
        if (wanted.equals("all")) {
            return null;
        }
        for (Area area : PROVIDED) {
            if (area.name().equals(wanted)) {
                return area;
            }
        }
        String[] parts = wanted.split(",");
        if (parts.length == 4) {
            try {
                return new Area("box", Double.parseDouble(parts[0]), Double.parseDouble(parts[2]),
                        Double.parseDouble(parts[1]), Double.parseDouble(parts[3]));
            } catch (NumberFormatException e) {
                // reported below
            }
        }
        throw new IllegalArgumentException("unknown area '" + text
                + "'; use all, opal, newcastle, sydney, wollongong or south,west,north,east");
    }

    /** As {@link #parse} reads it. */
    public String text() {
        return name.equals("box") ? south + "," + west + "," + north + "," + east : name;
    }
}
