package gtfseditor.router.road;

import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Path;

/** The hand-made test map (src/test/resources/mini-roads.osm) and named places on it. */
final class MiniRoads {

    /** Rows of the grid, north to south. */
    static final double[] ROW_LAT = {-32.8970, -32.8979, -32.8988, -32.8997};

    /** Columns of the grid, west to east. */
    static final double[] COLUMN_LON = {151.73600, 151.73707, 151.73814, 151.73921};

    /** A corner of the island, the square of streets linked to nothing. */
    static final LatLon ISLAND = new LatLon(-32.9160, 151.73600);

    /** About 650 m north of the grid's top row: further than the snap limit from any road. */
    static final LatLon FAR_FROM_ROADS = new LatLon(-32.8910, 151.73750);

    /** The middle of the footway, about 50 m from the nearest street. */
    static final LatLon ON_FOOTWAY = new LatLon(-32.89835, 151.737605);

    private MiniRoads() {}

    /** The street corner at this row and column of the grid. */
    static LatLon corner(int row, int column) {
        return new LatLon(ROW_LAT[row], COLUMN_LON[column]);
    }

    /** The map file on disk. */
    static Path osmFile() {
        URL url = MiniRoads.class.getResource("/mini-roads.osm");
        if (url == null) {
            throw new IllegalStateException("mini-roads.osm is missing from the test resources");
        }
        try {
            return Path.of(url.toURI());
        } catch (URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }
}
