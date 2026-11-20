package gtfseditor.router.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * A channel runs east to west along latitude -33.2009, with a gap in the line 50 m either side of
 * a bridge at longitude 151.001.
 */
class WaterTest {

    private static final double CHANNEL = -33.2009;

    private static Water channel(boolean bridge) {
        double[] lines = {CHANNEL, 150.99, CHANNEL, 151.0005, CHANNEL, 151.0015, CHANNEL, 151.01};
        return new Water(lines, bridge ? new double[] {CHANNEL, 151.001} : new double[0]);
    }

    @Test
    void aWalkAcrossTheLineIsOverWater() {
        Water water = channel(false);
        assertTrue(water.overWater(-33.2000, 151.0, -33.2018, 151.0));
        assertEquals(-1, water.walkMetres(-33.2000, 151.0, -33.2018, 151.0));
    }

    @Test
    void aWalkThatStaysOnOneSideIsNot() {
        Water water = channel(false);
        assertFalse(water.overWater(-33.2000, 151.0, -33.2000, 151.004));
        assertEquals(Geo.metresBetween(-33.2000, 151.0, -33.1973, 151.0),
                water.walkMetres(-33.2000, 151.0, -33.1973, 151.0));
    }

    @Test
    void aWalkThatEndsWithinTheMarginOfTheLineIsOverWater() {
        // 10 m short of the line, and alongside it rather than across it.
        Water water = channel(false);
        assertTrue(water.overWater(-33.2000, 151.0, -33.20081, 151.0));
        assertTrue(water.overWater(-33.20081, 150.995, -33.20081, 151.0));
        assertFalse(water.overWater(-33.2000, 151.0, -33.2006, 151.0), "30 m short is clear of it");
    }

    @Test
    void aBridgeIsWalkedToAndOnFrom() {
        Water water = channel(true);
        double straight = Geo.metresBetween(-33.2000, 151.0, -33.2018, 151.0);
        double byBridge = water.walkMetres(-33.2000, 151.0, -33.2018, 151.0);
        assertEquals(Geo.metresBetween(-33.2000, 151.0, CHANNEL, 151.001)
                + Geo.metresBetween(CHANNEL, 151.001, -33.2018, 151.0), byBridge, 0.001);
        assertTrue(byBridge > straight + 50);
        // Straight over the bridge is not over water at all.
        assertEquals(Geo.metresBetween(-33.2000, 151.001, -33.2018, 151.001),
                water.walkMetres(-33.2000, 151.001, -33.2018, 151.001));
    }

    @Test
    void noWaterMeansTheStraightLine() {
        assertTrue(Water.NONE.isEmpty());
        assertFalse(Water.NONE.overWater(-33.2, 151.0, -33.3, 151.0));
        assertEquals(Geo.metresBetween(-33.2, 151.0, -33.3, 151.0), Water.NONE.walkMetres(-33.2, 151.0, -33.3, 151.0));
    }

    @Test
    void piecesMeetingEndToEndAreFoundFromEitherSide() {
        assertEquals(0, Water.apart(0, 0, 10, 10, 0, 10, 10, 0));
        assertEquals(5, Water.apart(0, 0, 10, 0, 0, 5, 10, 5), 1e-9);
        assertEquals(5, Water.apart(0, 0, 10, 0, 15, 0, 20, 0), 1e-9);
    }

    @Test
    void numbersThatDoNotMakeLinesAreRefused() {
        assertThrows(IllegalArgumentException.class, () -> new Water(new double[] {1, 2, 3}, new double[0]));
        assertThrows(IllegalArgumentException.class, () -> new Water(new double[0], new double[] {1}));
        assertThrows(IllegalArgumentException.class,
                () -> new Water(new double[] {-33, 151, Double.NaN, 151}, new double[0]));
    }
}
