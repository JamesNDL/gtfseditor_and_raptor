package gtfseditor.router.core;

/**
 * One part of a journey.
 *
 * @param kind           a walk to or from the network, a ride, or a walk between two rides
 * @param fromStop       where the leg starts, or -1 for the journey's own starting point
 * @param toStop         where the leg ends, or -1 for the journey's own end point
 * @param depart         seconds from the start of the service day
 * @param arrive         seconds from the start of the service day
 * @param metres         straight-line distance of a walk; 0 for a ride
 * @param trip           the trip ridden, or -1
 * @param boardPosition  the boarding stop's place in the trip's pattern, or -1
 * @param alightPosition the alighting stop's place in the trip's pattern, or -1
 * @param stayAboard     the passenger was already on this vehicle: it ran on from the previous
 *                       ride's trip, so this is not a change
 */
public record Leg(
        Kind kind,
        int fromStop,
        int toStop,
        int depart,
        int arrive,
        int metres,
        int trip,
        int boardPosition,
        int alightPosition,
        boolean stayAboard) {

    public enum Kind { WALK, RIDE, TRANSFER }

    static Leg walk(Kind kind, int fromStop, int toStop, int depart, int arrive, int metres) {
        return new Leg(kind, fromStop, toStop, depart, arrive, metres, -1, -1, -1, false);
    }

    Leg asStayAboard() {
        return new Leg(kind, fromStop, toStop, depart, arrive, metres, trip, boardPosition, alightPosition, true);
    }
}
