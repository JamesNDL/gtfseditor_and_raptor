package gtfseditor.router.core;

import java.util.List;

/**
 * One way of making the trip.
 *
 * @param label    {@code fastest}, {@code fewerChanges} or {@code walk}
 * @param depart   when the passenger needs to set off: at or after the time asked for, as late as
 *                 still catches the first vehicle
 * @param arrive   when they reach the end
 * @param rides    vehicles ridden, counting a vehicle that runs on as a new trip twice
 * @param changes  times the passenger gets off one vehicle and onto another
 * @param walkSecs time spent walking
 * @param waitSecs time spent waiting at stops after setting off
 */
public record Journey(
        String label,
        int depart,
        int arrive,
        int rides,
        int changes,
        int walkSecs,
        int waitSecs,
        List<Leg> legs) {

    public Journey {
        legs = List.copyOf(legs);
    }

    public int durationSecs() {
        return arrive - depart;
    }

    Journey labelled(String name) {
        return new Journey(name, depart, arrive, rides, changes, walkSecs, waitSecs, legs);
    }

    /** Builds a journey from its legs, working out the totals. It sets off when its first leg does. */
    static Journey of(int asked, List<Leg> legs) {
        int depart = asked;
        int rides = 0;
        int stayed = 0;
        int walking = 0;
        int riding = 0;
        for (Leg leg : legs) {
            if (leg.kind() == Leg.Kind.RIDE) {
                rides++;
                stayed += leg.stayAboard() ? 1 : 0;
                riding += leg.arrive() - leg.depart();
            } else {
                walking += leg.arrive() - leg.depart();
            }
        }
        int arrive = legs.isEmpty() ? depart : legs.get(legs.size() - 1).arrive();
        depart = legs.isEmpty() ? depart : legs.get(0).depart();
        return new Journey("", depart, arrive, rides, Math.max(0, rides - 1 - stayed), walking,
                arrive - depart - walking - riding, legs);
    }
}
