package gtfseditor.router.gtfs;

import gtfseditor.router.core.Mode;
import gtfseditor.router.core.TransferSettings;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

/**
 * How to turn a feed into a timetable.
 *
 * @param serviceDate     the day to load, as a number such as 20261117; 0 means "the feed's only
 *                        day", which works for the editor's export
 * @param transfers       how walking links are generated
 * @param capacityFactor  every capacity is multiplied by this
 * @param defaultCapacity capacity for a trip the feed names no vehicle for, by mode
 */
public record LoadOptions(
        int serviceDate,
        TransferSettings transfers,
        double capacityFactor,
        Map<Mode, Integer> defaultCapacity) {

    public LoadOptions {
        if (serviceDate < 0) {
            throw new IllegalArgumentException("the service date cannot be negative");
        }
        if (!(capacityFactor > 0)) {
            throw new IllegalArgumentException("the capacity factor must be above 0");
        }
        EnumMap<Mode, Integer> all = new EnumMap<>(Mode.class);
        for (Mode mode : Mode.values()) {
            Integer capacity = defaultCapacity.get(mode);
            if (capacity == null || capacity <= 0) {
                throw new IllegalArgumentException("no default capacity for " + mode.wireName());
            }
            all.put(mode, capacity);
        }
        defaultCapacity = Collections.unmodifiableMap(all);
    }

    /**
     * The feed's only day, the default transfer settings, and capacities taken from the editor's
     * placeholder vehicle types (seated plus standing).
     */
    public static LoadOptions defaults() {
        EnumMap<Mode, Integer> capacity = new EnumMap<>(Mode.class);
        capacity.put(Mode.TRAIN, 1200);
        capacity.put(Mode.METRO, 1100);
        capacity.put(Mode.LIGHT_RAIL, 300);
        capacity.put(Mode.FERRY, 400);
        capacity.put(Mode.BUS, 65);
        capacity.put(Mode.COACH, 50);
        capacity.put(Mode.SCHOOL_BUS, 70);
        capacity.put(Mode.OTHER, 65);
        return new LoadOptions(0, TransferSettings.defaults(), 1.0, capacity);
    }

    public LoadOptions withServiceDate(int date) {
        return new LoadOptions(date, transfers, capacityFactor, defaultCapacity);
    }

    public LoadOptions withTransfers(TransferSettings settings) {
        return new LoadOptions(serviceDate, settings, capacityFactor, defaultCapacity);
    }

    public LoadOptions withCapacityFactor(double factor) {
        return new LoadOptions(serviceDate, transfers, factor, defaultCapacity);
    }

    /** Every setting as one line of text. Two options with the same text build the same timetable. */
    public String fingerprintText() {
        return serviceDate + "|" + transfers + "|" + capacityFactor + "|" + defaultCapacity;
    }
}
