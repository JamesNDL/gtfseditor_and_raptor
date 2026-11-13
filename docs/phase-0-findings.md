# Phase 0 findings: TfNSW feed audit

Feed audited: TfNSW "complete" GTFS bundle published 12 Nov 2026 (`nsw-complete-20261112-1750`), for the service day Tuesday 17 Nov 2026. Reproduce with `npm run feed:audit`.

## Summary

| Question | Answer | Effect on the design |
|---|---|---|
| Is one day small enough to work with? | Yes: 59,014 trips and about 2.0 million stop times | One-day-at-a-time scope is comfortable for PostgreSQL |
| Does `block_id` give vehicle days? | No, for any mode | Vehicle days must be built by the importer (see below) |
| Do train trip IDs carry set type and cars? | Yes for Sydney Trains and most intercity trips | Vehicle catalogue can be pre-filled for 94% of train trips |
| Are platforms in the feed? | Yes for trains; partly for metro, light rail and ferry | Platform conflicts work for trains from day one |
| Is there transfer data? | No `transfers.txt`; 7,031 in-station pathways | Stop-to-stop transfers must be generated |
| Is the baseline free of platform conflicts? | Nearly: 18 train pairs, 6 light rail, 201 ferry | Baseline conflicts need a "known, ignore" state |

## Size

| | Whole feed | One Tuesday |
|---|---|---|
| Trips | 205,218 | 59,014 |
| Stop times | 5,704,258 | about 2,000,000 |
| Routes | 10,215 | about 9,800 active |
| Stops (all location types) | 171,378 | about 122,000 used |
| Shapes / shape points | 22,152 / 14,726,218 | |

- The zip is 295 MB; extracted it is 1.4 GB, of which shapes are 983 MB and stop times 448 MB.
- The feed covers 13 Nov 2026 to 11 Feb 2027, with 2,380 service patterns.
- Times run to 34:25:00, so service days extend well past midnight.
- Buses dominate: 41,247 regular bus trips and 11,386 school bus trips on the day, against 3,237 train trips.

## Modes present

| route_type | Mode | Routes | Trips on the day |
|---|---|---|---|
| 700 | Bus | 1,171 | 41,247 |
| 712 | School bus | 8,649 | 11,386 |
| 2 | Train (Sydney Trains and intercity) | 17 | 3,237 |
| 900 | Light rail | 6 | 1,395 |
| 4 | Ferry | 24 | 1,129 |
| 401 | Metro | 1 | 433 |
| 204 | Regional coach | 163 | 89 |
| 714 | Temporary (rail replacement) bus | 51 | 54 |
| 205 | Temporary coach | 106 | 25 |
| 106 | Regional train | 27 | 19 |

The editor needs a mode table mapping these extended route types to its own modes and rule sets.

## Vehicle continuity

`block_id` does not describe a vehicle's day in this feed.

- **Trains:** 1,824 of 3,237 trips have a `block_id`, and every block contains exactly two trips. It marks through-running, where passengers stay aboard as the train changes line (for example a T2 arriving at Central platform 17 at 06:28 becomes a T8 departing at 06:29). It is a "stay on board" link, not a vehicle day.
- **Buses:** 172 of 41,247 trips have one. Effectively absent.
- **Metro, light rail, regional:** none. Ferries: 154 of 1,129 trips.

Suburban train vehicle days can be recovered from the trip ID instead. The first three characters of the trip name are the run number, and the fourth is a letter that advances with each trip (`1--B`, `1--C`, `1--D` ...). Grouping T-line trips by run number gives 238 runs. Of 2,480 consecutive-trip links, 2,442 (98.5%) start at the station where the previous trip ended, with no time overlaps. The other 38 jump stations, which is consistent with empty repositioning runs that are not in a passenger timetable.

Intercity trip names (`N412`, `W420`, `K409`) are trip numbers, not run numbers, so this does not work for them.

**Design change:** the editor keeps two separate ideas.

1. **Vehicle day:** which physical vehicle runs which trips, in order. Built by the importer:
   - suburban trains: from run numbers;
   - everything else: inferred by chaining trips that end and start at the same place with a plausible layover, marked "inferred" and editable.
2. **Stay-aboard link:** passengers can remain on the vehicle between two trips. Imported from `block_id`, and exported back to it.

Empty repositioning runs need to exist as a trip type in the editor, since a vehicle day with a station jump is otherwise physically invalid.

## Vehicle types

Sydney Trains trip IDs have seven dot-separated parts, for example `1--B.860.117.60.B.8.92804105`. Part 5 is the set type and part 6 the number of cars.

| Set type | Cars | Trips | Lines |
|---|---|---|---|
| A | 8 | 1,065 | T1 T2 T3 T5 T8 T9 |
| B | 8 | 627 | T1 T2 T3 T5 T7 T8 T9 |
| T | 8 | 483 | T1 T4 T5 T9 SCO |
| M | 4 | 362 | T5 T6 T7 |
| H | 8 | 186 | T1 T4 T5 T9 CCN SCO |
| D | 4, 6, 8 or 10 | 234 | CCN BMT SCO |
| M | 8 | 69 | T2 T3 T5 T8 |
| H | 4 | 13 | T4 SCO |

- 3,045 of 3,237 train trips (94%) carry a set type and car count.
- The exceptions are the Hunter line (100 trips), Southern Highlands (49), and some Blue Mountains and South Coast trips, which use a different ID format.
- Metro, light rail, ferry and bus trips carry no vehicle information. They start on the mode default, marked "assumed".
- The catalogue needs seated and standing capacity for each set type and car count. Those numbers are not in the feed and must be sourced separately.

## Stations and platforms

- Every stop used on the day has a parent station.
- **Trains:** 683 of 684 stops have a platform code.
- **Regional trains:** 89 of 97.
- **Metro:** 46 of 62. **Light rail:** 29 of 126. **Ferry:** 27 of 95.
- **Buses:** none, as expected.

Where a platform code is missing, each stop ID is still a distinct physical platform or wharf, so the conflict rule can key on stop ID and use the platform code only for display.

## Transfers and walking links

- There is no `transfers.txt`.
- `pathways.txt` has 7,031 links inside stations (walkways, stairs, escalators, lifts, fare gates) with traversal times, and `levels.txt` describes station levels.
- For the simulator, transfers between nearby stops (for example bus stop to station entrance) must be generated from distance, then made editable.

## Baseline conflicts

Counting pairs of trips whose arrival-to-departure windows overlap at the same stop:

| Mode | Overlapping pairs | Stops affected |
|---|---|---|
| Train | 18 | 4 |
| Light rail | 6 | 2 |
| Ferry | 201 | 33 |

- The train and light rail baseline is almost clean, so the platform rule will not drown users in false alarms. The causes of the 18 train pairs have not been investigated.
- Ferry wharves show many overlaps. Wharves probably serve more than one vessel at once, so the wharf rule needs a berth count per wharf (default one, editable). This has not been verified.
- Conflicts already in the baseline should be shown differently from conflicts the user introduces.

## Other notes

- The feed's download name is `full_greater_sydney_gtfs_static`, but it does include regional trains and coaches. Whether it covers every regional bus operator has not been checked.
- Routes carry an `exact_times` column and trips a `route_direction` and `trip_note`; stop times carry a `stop_note` referencing `notes.txt`. These are TfNSW additions and must be preserved through export.
- `frequencies.txt` is absent: every trip is individually timetabled.
