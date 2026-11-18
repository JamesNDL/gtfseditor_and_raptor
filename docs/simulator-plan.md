# Passenger simulator plan

Written 17 Nov 2026. Phases S0 to S4 are built (18 Nov 2026), which makes the first version usable from the editor: what was found, measured and done differently is in sections 14 to 17. S5 and S6 are not built. The plan joins two things that already existed: the GTFS editor (which exports a timetable with vehicle capacities) and the journey router in `services/router` (which plans journeys on that export). Figures marked "estimate" are not measured. The owner's decisions of 18 Nov are in section 12, and the assumptions to come back to are in section 13.

## 1. Summary

Take a file of journeys (who, from where, to where, setting off when), send every one of them through a day's timetable, and show where the passengers ended up: on which vehicles, at which stops, how long it took them, and who could not get on. A run is started from the editor on the published timetable or on a scenario, and its results are shown in the editor.

Main recommendations:

| Topic | Recommendation |
|---|---|
| What "simulate" means, first version | Vehicles run exactly to the timetable. Passengers plan with the router, then board in true time order. A full vehicle leaves people behind, and they plan again from where they stand. |
| Where it runs | A new Java module, `router-sim`, inside `services/router`, using the router as a library in the same process. No HTTP between simulator and router. |
| How it is started | The editor's Node API prepares the timetable, hands the router service a job, follows its progress and collects the results. |
| Demand | A CSV of journeys between stop ids, uploaded once and kept as a named "demand set", separate from any scenario, so the same people can be sent through the published timetable and through a scenario. |
| Capacity | Off unless asked for. Every run is planned with capacity off; capacity is a second, quick step over the same plans, and is skipped where the plans show nothing would be full (section 4.5). |
| Results | Written by the simulator as files, then copied into PostgreSQL by the Node API so the editor can query them like everything else. |
| In the editor | A short wizard to set up a run (section 7.1), a summary, passengers on the existing line, trip, station and timeline views, how full each vehicle is on the map, one person's journey by `user_id`, and two runs side by side. |
| Not in the first version | Delays caused by crowds, people choosing differently because of crowding, a person's later journeys depending on their earlier ones. |

Estimated size: about 5 to 6 weeks of focused work to the first usable version (phases S0 to S4 in section 10), and 6 to 8 weeks for everything to S6.

## 2. What exists, and what is missing

| Already built | Where |
|---|---|
| Export of one service day, with a scenario's changes and the two vehicle files | `GET /api/baselines/:b/export?s=` |
| The router: loads that zip in about 4 s, plans a journey in 3 to 9 ms, 300 to 700 a second on 6 threads | `services/router` |
| Capacity per trip, and a load state (passengers aboard each trip as it leaves each stop) | `LoadState`, `Capacity` |
| Planning from a given stop at a given time, with named boardings refused | `blocked` on a query |
| A check that replays a journey against the timetable | `JourneyChecker` |
| Bulk assignment, first come first served by departure time | `Assignment`, `POST /v1/journeys/bulk` |

| Missing | Needed for |
|---|---|
| Any link from the editor to the router | Starting a run from the editor |
| A way to tell that a scenario has changed since the router loaded it | Not showing results for an old timetable |
| An export without shapes (the export takes 2 to 5 minutes, most of it shapes) | A run that starts in seconds, not minutes |
| Jobs on the router service (submit, follow, collect) | Runs that take minutes |
| Real demand data, or a generator of made-up demand | Anything to simulate |
| Real vehicle capacities (all 59,014 trips have placeholders) | Believable crowding |
| Anywhere in the editor to show passengers | The results |

The existing bulk assignment is not the simulator. It gives a place to whoever sets off first, even where someone who set off later would board further up the line and get there first. The router plan says so and leaves the proper answer to this plan.

## 3. The demand file

### 3.1 Format

A CSV with a header row. One row is one journey.

| Column | Meaning | Required |
|---|---|---|
| `user_id` | Who is travelling. Any text. One person may have several rows. | Yes |
| `start_time` | When they tapped on at the origin stop: `HH:MM`, `HH:MM:SS` or seconds from the start of the service day. After midnight keep counting (`24:30`). | Yes |
| `origin_stop`, `destination_stop` | GTFS stop or station ids, as in the editor's export. | The columns, yes. A value may be left empty in a row that gives that end's position. |
| `origin_lat`, `origin_lon`, `destination_lat`, `destination_lon` | Where each end is. Used in place of the stop's own position, and needed only for a stop id the published timetable does not have. | No |
| `journey_id` | The caller's own id for the row. Left out, it is the row number. | No |
| `people` | How many people the row stands for. They travel as individuals, not as a group that must fit together. Lets a 10% sample stand for everyone. | No, default 1 |

Journeys are given by stop id (decided 18 Nov). Checked on 18 Nov: the editor's export has an id and a position for every one of its 171,378 stops, in `stops.txt`, and its stop times refer to stops by that id. There is no date column: a run is one service day, as the timetable is.

**Every journey also carries the position of each end.** A scenario can take away the stop or platform a person is going to: a closure, a route cut short, a stop skipped. The stop id then leads nowhere, but the place the person wants to reach has not moved. So when a demand file is uploaded, the Node API looks up each stop's latitude and longitude in the published timetable and stores them with the row; a file that gives its own positions keeps them. The position is what lets a person use another stop nearby when the timetable changes (section 4.6). A row whose stop id is unknown and which gives no position is refused, and counted in the upload report.

### 3.2 Demand sets

- A demand file is uploaded once and kept as a **demand set** with a name. It does not belong to a scenario. The point of the tool is to send the same people through two timetables and compare.
- The file is kept under `data/sim/demand/` (already outside git) with a row in a `demand_sets` table: name, row count, people, how many different users, earliest and latest start.
- On upload the rows are checked and a report is shown: rows that cannot be read, times outside the service day, the busiest hour. Stop ids are looked up in the published timetable at upload, to find their positions. Whether each stop still has a service is checked when a run starts, against the timetable chosen.
- `user_id` is a made-up code, there so that one person can be matched between runs (answered 18 Nov). It needs no special care. Demand files are still kept out of git, for their size.

### 3.3 Demand before real data exists

A generator makes a demand set: stop pairs picked in proportion to how much service each stop has, start times leaning to the two peaks, inside the Opal area by default, to a chosen size and seed. This is the demand generator of phase 5 of the router plan; it is built once, here, and the router's benchmark uses it too. A made-up set says nothing about real travel. It shows that the simulator works and how fast it is.

## 4. The simulation model

### 4.1 Three levels, and which one first

| Level | What it models | Verdict |
|---|---|---|
| 1. Timetable with capacity | Vehicles always on time. Each passenger takes the journey the router recommends. Boarding is in true time order; a full vehicle leaves people at the stop. | **Build first.** |
| 2. Crowds slow vehicles | Time at a stop grows with boardings, vehicles run late, connections are missed. | Later. Needs door counts and boarding rates that the editor does not have. |
| 3. People adapt | Passengers avoid lines they know are crowded; runs repeat until choices settle. | Later. Needs a cost for crowding and many passes over the day. |

Level 1 with the capacity switch off is simply "everyone takes their planned journey". That alone answers most questions about a timetable change (journey times, loads, who loses a connection), and it is the first thing built.

### 4.2 How a run works

**Stage 1: plan.** Every row is planned with the router, capacity off, on all threads, twice: between the person's own stops, and between any stops near them. Section 4.6 says which of the two they take; on the published timetable it is always their own stops. Passengers do not know in advance how full vehicles will be. Each takes the recommended journey of the search chosen. Rows with no journey are reported as `noJourney` with the reason, and people whose journey is now far later than on the published timetable as `gaveUp`; neither is put on a vehicle.

**Stage 2: replay in time order.** One pass through the day, on one thread:

1. Every planned boarding is an event at the time the vehicle leaves that stop. Events are handled in order of time; at one stop and vehicle, whoever reached the stop first is first.
2. Before anyone boards, passengers leaving the vehicle at that stop are taken off.
3. A passenger boards if there is room as the vehicle leaves that stop. Only that stop matters: everyone aboard further along the trip must have boarded at or before this moment, so there is nothing later to check. This is what makes the order right where the bulk assignment's is not.
4. A passenger who boards is counted aboard until their alighting stop, and their next boarding becomes an event. Because vehicles are on time, a passenger who boards always makes the rest of that ride.
5. A passenger who is left behind is planned again from that stop at that time, with that boarding refused. The router may say to wait for the next vehicle of the same line or to go another way. Their new boardings become events.
6. A passenger left behind more than a set number of times (default 5), or with no way left, is `stranded`, with where and when.
7. A passenger on a vehicle that runs on as another trip stays aboard whatever its load, as in the router.

The same demand on the same timetable gives the same result every time, whatever the number of threads.

A row that stands for several people (`people`) boards as individuals: if 10 want to board and 4 fit, 4 ride on and 6 are left behind and planned again together.

With capacity off, stage 2 only counts: nobody is left behind. That is the default (decided 18 Nov).

### 4.3 What a run records

| For | Recorded |
|---|---|
| Each journey | Status (`ok`, `noJourney`, `gaveUp`, `stranded`), asked start, actual departure and arrival, rides, time walking, time waiting, times left behind, and whether the journey taken differs from the one first planned. The reference arrival on the published timetable and the difference from it. The person's margin; whether they changed stop at each end, the stop used, how far they walked, and why |
| Each leg | Walk, change or ride; the trip, line, boarding and alighting stops and times |
| Each trip at each stop | Boardings, alightings, passengers aboard on leaving, passengers left behind |
| Each stop, by quarter hour | Boardings, alightings, changes between vehicles, passengers left behind, the most waiting at once |
| The run | Totals of the above, the settings used, how many capacities were placeholders, time taken |

### 4.4 What the first version does not model

Each of these is a stated limit, shown with the results.

- **Vehicles are never late.** Crowds do not slow them.
- **Everyone with the same origin, destination and start takes the same journey.** Real passengers spread over the alternatives. Busy lines will look busier and their alternatives emptier than they are.
- **Nobody plans around crowding.** A passenger finds out a vehicle is full by being left behind.
- **A person's journeys are independent** (decided 18 Nov, to be revisited: section 13). If the morning journey fails or runs late, the evening one still starts at its stated time. Results are grouped by `user_id` so a person's day can be read together.
- **One service day.** A journey that needs tomorrow's first train finds nothing.
- **Walking is a straight line times 1.3,** as in the router.
- **Capacities are placeholders** until real ones are entered in the fleet screen.

### 4.5 Capacity as a second step

Every run is planned with capacity off, on all threads. Capacity never enters the planning; it is applied afterwards, in the replay of section 4.2, which counts but does not search. That gives three things:

1. **A capacity-off run already says where the pressure is.** Adding up who plans to be aboard each trip as it leaves each stop is one quick pass over the plans. The summary lists the trips planned over their capacity, how far over, and from what time.
2. **Capacity can be switched on afterwards without planning again.** The plans of a run are kept with its results. "Run again with capacity" replays them: seconds, plus planning again for whoever is left behind.
3. **Where no trip is planned over its capacity, capacity changes nothing,** and the run with capacity on is the run with capacity off. Nobody can be refused on a trip that was never going to be full.

Passengers who are left behind plan again without looking at loads (they do not know how full things are; section 4.4), so everyone left behind in the same second is planned again at once on all threads, and those at the same stop going to the same place share one search. The answer stays the same whatever the number of threads.

An idea set aside on 18 Nov: ignoring capacity until a set number of people are on the network. It is not needed, because planning never waits on capacity in this design.

**To measure in S1:** on a made-up demand set, how many trips are planned over capacity, what share of passengers are left behind at least once, and how long the capacity step takes against the planning.

### 4.6 Which stops a person uses

**The principle (decided 18 Nov).** The journey data is what each person did on the day. The simulator measures what a changed timetable does to that person. On the published timetable everyone uses the stops in the data. On a changed timetable they may change stop, but only as far as the change gives them reason to.

**Why a simple rule is not enough.** "Always use the stop in the data" leaves people waiting hours at a stop cut to two buses a day with a good stop 200 m away, and means nobody ever starts a journey at a stop or station a scenario adds. "Use whichever stop is quickest" moves people on the published timetable too, away from what they actually did.

**The rule: people keep the preference they showed on the day.**

Two journeys are planned for each person on each timetable:

- **Own stops:** from the stop they started at to the stop they went to, with no walking to another stop at either end. Another stop under the same parent stop counts as their own (see "Parent stops" below).
- **Any stop near:** from the position of the first to the position of the second, boarding and leaving at any stops within the walking distance, walking the rest. Their own stops are among these, at no walk, so this journey is never worse than the first.

Each journey has a cost, worked out the way the router already does to recommend a journey: arrival time, plus 10 minutes for each vehicle boarded, plus the time walked counted again (accepted 18 Nov; to be adjusted later if needed).

**People do not change vehicles to save a few minutes** (decided 18 Nov). The 10 minutes per vehicle is the owner's figure: a journey with one more change is taken only if it arrives more than 10 minutes sooner. It applies wherever journeys are scored: in choosing each person's recommended journey, on BAU and scenario runs alike, and in comparing their own stops with stops near. The journey planner's own default stays at 5 minutes; the simulator passes its figure with each search.

1. **On the published timetable** the person takes the own-stops journey, because that is what they did. If there is none (nothing runs between their two stops after their start), they have no journey on the published timetable, whatever is nearby: nobody changes stop there. The difference in cost between the two journeys is their **margin**: how much better a nearby stop already was on the day, and they did not use it. It is 0 for most people and it is kept with the reference (below).
2. **On a changed timetable** both are planned again. The person changes stop only if the any-stop-near journey now beats the own-stops journey by more than their margin plus a threshold (10 minutes by default). Otherwise they stay.
3. **If the own-stops journey does not exist** on the changed timetable (the stop is gone, nothing calls there, or nothing from it reaches the destination), they take the any-stop-near journey if there is one.

What this gives:

| Case | What happens |
|---|---|
| The published timetable | Nobody changes stop, by construction. |
| A change that does not touch the person | Both journeys are as before, so they stay. |
| Their stop is removed or loses all service | They use another within the distance, and the walk counts against them. |
| Their stop keeps a poor service (every ten minutes cut to twice a day) | They change to a nearby stop when that is better by more than their margin and the threshold. |
| Their stop is still served but nothing from it reaches the destination | The same as a stop that is gone. |
| A new line, stop or station near them | They change to it when it beats what they have by more than their margin and the threshold. New stops get passengers. |
| A row that is a position and not a stop | No own stop to prefer: the any-stop-near journey, on every timetable. |

**The reference.** The margin and the arrival time of each person's journey on the published timetable are the reference. It comes from a BAU run: a named run on the published timetable, made once and kept. A scenario run is made against a BAU run the owner picks, and takes its reference from it (section 6.4). The published timetable here is the published day the scenario is built on.

**How much worse people will accept.** A person whose journey on the changed timetable arrives more than a set time later than their reference (60 minutes by default) is reported as **`gaveUp`**: they would not make this journey. They are counted, they are not put on any vehicle, and they are left out of the journey-time averages, which a few four-hour waits would otherwise distort. The limit is judged on the planned journey. A person who plans a reasonable journey and is then delayed by full vehicles is not counted here; they show as delayed or `stranded`.

**Settings of a run,** in step 3 of the wizard (section 7.1):

| Setting | Default | Range |
|---|---|---|
| How far people will walk to another stop | 500 m straight line (about 10 minutes; taken as 1.3 times that on the ground, at 1.03 m/s) | 0 to 2,000 m. At 0 nobody changes stop, and a person whose stop is gone cannot travel. |
| How much time one more change of vehicle must save | 10 minutes | 0 to 30 minutes. Set on the BAU run and kept by the scenario runs made against it (section 6.4). |
| How much better another stop must be before they change | 10 minutes | 0 to 30 minutes |
| How much later they will accept arriving before they give up | 60 minutes | 10 minutes upward, or no limit |

What follows, to be clear about:

- **Planning takes about twice as long,** because each person is planned twice. Plans are shared between people with the same stops and times as before (section 5.2). To be measured in S1.
- **Two runs are only comparable on the same people and plans.** The walking distance and the time a change of vehicle must save decide each person's margin, so a scenario run takes them from its BAU run and they cannot differ (section 6.4). The threshold for changing stop, the give-up limit and capacity are chosen for each scenario run; the comparison view notes where two runs differ in them.
- **Parent stops** (answered 18 Nov). Any stop under the same parent stop counts as the person's own stop, so nobody is left on a platform their train no longer uses. The stop in the data is used at no walk; another stop of the same parent is reached at the timetable's walking time between the two. A row that gives a station id may use any of the station's stops at no walk. In this feed 67,179 parents have one stop in use and 9,990 have two (section 15 of the router plan), so for most bus stops this changes nothing, and for some it lets a person use the other stop of the pair. Stops of one parent more than 1 km apart are not treated as one, as in the router.
- **In the middle of a journey** nothing changes: a change between vehicles may walk up to 500 m between stops, and a person left behind by a full vehicle plans again from where they stand. The data says where the journey began and ended, not how it went in between.
- **The margin is one day's evidence.** A person with a large margin (a much better stop nearby that they did not use) most likely lives or works nearer their own stop than its position suggests. The margin stands in for that, which is why it is kept, but it is a single number for a choice with more behind it.
- **What is reported** for each journey: the reference arrival, the arrival now and the difference; the margin; whether they changed stop at each end, the stop used, how far they walked, and why (their stop was gone, or another was better). In the summary: how many people changed stop and for which reason, how many found no other stop within the distance, and how many gave up.

**Change needed in the router.** Today a journey from a stop may begin with a walk to a stop nearby (section 16 of the router plan). The own-stops journey must not. The search already takes its starting and finishing stops as a list, so the simulator builds both lists itself: the one stop with no walk and the other stops of its parent at their walking times, and the stops within the distance of the position. A stop the timetable has dropped is never looked up by id.

### 4.7 The area of a run

A run can be limited to a box on the map (decided 18 Nov). Working on Newcastle should not mean simulating Sydney and the rest of NSW.

**What the box does:**

| To | Rule |
|---|---|
| Journeys | A journey is in the run only if it starts and ends inside the box, judged by the positions stored with the demand set (section 3.1). Journeys with one end inside and journeys wholly outside are left out and counted. |
| The timetable | Only stops inside the box are kept, and each trip keeps only its calls at those stops. A trip left with fewer than two calls is dropped. A Newcastle to Sydney train becomes a train that runs as far as the edge of the box. |
| The edge | The timetable is cut a little wider than the box (2 km by default), so a person near the edge still has the stops just outside it to walk or change to. Journeys are still chosen by the box itself. |

**Where the cut is made: in the editor's export,** as an option beside "without shapes". The router then loads a small zip and needs no change, and the export, which is the slow step before a run, covers a fraction of the day's 2 million stop times. The router knows the cut timetable under its own id (for example `b1-s7-newcastle`), so the whole-network timetable and an area's are never confused.

**The usual way to work.** A whole-network run of 1.7 million journeys is one to three hours of planning and needs more memory than the service has by default (section 5.2). It is worth doing once as a BAU run and for changes that reach across the state. For a local change, a bounded BAU run and scenario runs against it are the practical loop, and the wizard remembers the area used last.

**How the box is chosen,** in step 2 of the wizard (section 7.1): the whole network; a saved area; the part of the map now on screen; or a box dragged on the map. An area can be saved under a name. Four are provided: Newcastle and the Hunter, Sydney, Wollongong and the Illawarra, and the Opal area (the rectangle of section 17 of the router plan).

**Why it is much quicker (estimate, to be measured):** fewer journeys; a smaller export and load; and each search is quicker, because a search costs in proportion to how much of the network can be reached (section 17 of the router plan).

**What the box hides.** Shown with the results of every run that uses one.

- **Journeys across the edge are not simulated.** A change to Newcastle's trains also affects people travelling between Newcastle and Sydney; a Newcastle box does not see them. The count of journeys left out for having one end inside says how many.
- **Vehicles look emptier than they are near the edge.** Passengers who boarded outside the box are not aboard. With capacity on, a train arriving from outside starts empty at the edge.
- **A journey that would leave the box and come back** has to stay inside. Rare for a sensible box; possible for an oddly shaped area.
- **Results from different boxes are not comparable.** A scenario run uses the box of the BAU run it is measured against (section 6.4), so a Newcastle scenario is run against a BAU run bounded to Newcastle.

Later, if wanted: keep journeys with one end inside, which needs whole trips kept and so a larger timetable.

## 5. Where the simulator runs

| Option | For | Against |
|---|---|---|
| **A Java module in `services/router`, same process as the router** | No HTTP or JSON per journey (about 2 ms each, which is a third of the work). Direct use of the timetable arrays and `LoadState`. One service to run. | The simulator and the journey planner share one heap. |
| A separate service calling the router over HTTP | Could be written in any language. | Slower, and a million plans as JSON is a lot of text for no gain. |
| In the Node API | Next to the database. | Wrong language for the arithmetic; the bulk endpoint would have to stream millions of journeys to it. |

**Recommendation: the first.** The simulator in `router-sim` needs only `router-core`, so it is usable as a library; the module also depends on `router-gtfs`, for its command line (`npm run router:simulate`), which has to load a zip. Neither needs the service or the editor. `router-server` exposes it as jobs.

### 5.1 Jobs on the router service

| Method and path | Purpose |
|---|---|
| `POST /v1/simulations` | Start a run: the timetable id and the settings, and one of: where the demand file is (a BAU run), the BAU run to measure against (a scenario run), or the run whose kept plans to replay with capacity on. Answers at once with a run id. |
| `GET /v1/simulations/{id}` | Stage, journeys done of how many, time so far, and at the end the summary. |
| `GET /v1/simulations/{id}/files/{name}` | One result file. |
| `DELETE /v1/simulations/{id}` | Stop a run, or discard a finished one. |

One run at a time; a second waits its turn. A run keeps hold of its timetable, so a reload part-way through does not change it. Results are written under `data/router/sim/<run id>/` as compressed CSV (`journeys`, `legs`, `trip_loads`, `stop_activity`) and `summary.json`. The plans of stage 1 are kept there too, so a run can be started "from the plans of run X, with capacity on" without planning again (section 4.5), as long as the timetable version is the same. This is the "job-based bulk" of phase 8 of the router plan, built here because the simulator needs it first.

### 5.2 Speed and memory (estimates)

The router plans 300 to 700 journeys a second on this machine. A day of real data is about 1.7 million journeys (answered 18 Nov). Planned one by one that is 40 to 95 minutes, and each person is planned twice (section 4.6), so up to twice that. That is too slow for "change the timetable, simulate, look". In order of how much each should help:

1. **Reuse a plan for everyone it fits.** The router returns journeys that leave as late as they can. A search made for a start at 07:40 whose journeys all leave at 07:52 or later is also the answer for anyone on the same pair of places starting between 07:40 and 07:52. (As built, the window ends at the earliest departure among all the journeys the search offers, not only the recommended one: section 14.) Rows are grouped by origin and destination and sorted by time, and one search serves each such window. Real tap data is between a limited set of stop pairs, so this should remove most searches; made-up demand will benefit less. To be measured.
2. **A share of the demand.** Simulate every tenth row with `people` set to 10. Quicker by ten, coarser on quiet lines.
3. **Range RAPTOR** (phase 8 of the router plan): all departures in a window from one origin in one search.
4. Later: after a small edit, plan again only the journeys the edit could touch. This is not exact without care (a new trip can help someone who did not use the old ones), so it is not in the first version.

Stage 2 is cheap: a few million events, each a handful of array operations. With capacity on it also plans again for passengers left behind, in batches on all threads (section 4.5). Seconds, unless a large share of passengers are left behind.

Memory: a planned journey is kept as a few numbers per leg, about 100 bytes (estimate). As built, only the journey a person takes is kept in full, and the other as its arrival and cost, so 1.7 million journeys is about 170 MB at most on top of the timetable's 80 MB, and less where plans are shared. That does not fit comfortably in the service's 768 MB heap beside two timetables and the search threads, so a whole-network run needs the heap raised to about 1.5 GB, an area (section 4.7), or a share of the demand. Results are written as they are settled, not held.

## 6. Starting a run from the editor

The browser talks only to the Node API, as now. The Node API talks to the router service.

### 6.1 What the Node API gains

| Route | Purpose |
|---|---|
| `POST /api/demand`, `GET /api/demand`, `DELETE /api/demand/:id` | Upload, list and remove demand sets. `POST /api/demand/generate` makes one up (section 3.3). |
| `POST /api/sim-runs` | Start a run: demand set, baseline, optional scenario (`?s=` as everywhere else), settings. |
| `GET /api/sim-runs`, `GET /api/sim-runs/:id` | Runs with their state and progress. |
| `DELETE /api/sim-runs/:id` | Stop or remove a run and its results. |
| `GET /api/sim-runs/:id/...` | Results for the views in section 7. |

New tables: `demand_sets`, `sim_runs` (demand set, baseline, scenario, the scenario's version key, settings, state, progress, summary), and the result tables of section 6.3.

### 6.2 What happens when "Simulate" is pressed

1. Work out the timetable's id and version key: for a scenario, its id, its `head` and the time of the edit numbered `head` (section 6.5 of the router plan; `head` alone is reused after an undo).
2. Ask the router whether it holds that version. If not, export the day (without shapes, and cut to the run's area if it has one; both new options) and have the router load it. A scenario run reads its reference from the BAU run chosen in the wizard (section 6.4); nothing is run on the published timetable. With shapes left out the export should take well under a minute (to be measured).
3. Start the job, giving the router the demand file's path.
4. Follow progress; the panel shows the stage and a count.
5. On finish, copy the result files into PostgreSQL, turning GTFS ids into the editor's own ids, and store the summary.

A run belongs to the timetable version it ran on. When the scenario is edited afterwards, the run is marked **out of date** and stays viewable with that label; its figures are not drawn on trips that have since changed.

The router is still started separately, not by `npm run dev`. If it is not running, the panel says so and how to start it.

### 6.3 Where results are kept

| Option | For | Against |
|---|---|---|
| **Copy into PostgreSQL** | One place to query; joins to lines, trips and stops; survives a router restart. | A big run is several million rows (a million journeys is about 3 million legs and up to 2 million trip-stop rows). |
| Leave as files and read them through the router | Nothing to copy. | Every view would need its own code to dig through files; nothing can be joined. |

**Recommendation: PostgreSQL**, with one set of tables keyed by run (`sim_journeys`, `sim_legs`, `sim_trip_loads`, `sim_stop_activity`), loaded with `COPY`. Runs are kept until someone removes them; nothing is removed automatically (section 6.5). The result files stay on disk too, as the download.

### 6.4 BAU runs, and choosing what a scenario is compared with

A run on the published timetable is a **BAU run** (business as usual). It is made on purpose, given a name, and kept. A scenario run does not make one for itself: the owner picks which BAU run it is measured against (decided 18 Nov). Nothing on the published timetable is ever run twice unless the owner asks for it.

**A BAU run** is an ordinary run that can be opened and looked at. It keeps everything: each person's planned journey, the arrival and cost of the journey they did not take, their margin and reference arrival (section 4.6), the journeys, the loads on every trip, the stop figures and the summary. It has a name, suggested from its choices and editable: "BAU, whole network", "BAU bounded Newcastle". There can be as many as are wanted, for different areas, demand sets or walking distances.

**A scenario run is made against one BAU run,** chosen in the wizard (section 7.1). The BAU run supplies the reference: who the people are, what they did on the published timetable, and how strongly each prefers their own stop. So the scenario run takes these from it and the wizard does not ask for them again:

| Taken from the BAU run | Why it cannot differ |
|---|---|
| The demand set | The same people. |
| The area (section 4.7) | The same journeys, on a timetable cut the same way. |
| The walking distance | It decides the any-stop-near journey, and so each person's margin. |
| How much time a change of vehicle must save | It decides which journey each person takes, and their margin. |
| School buses in or out; how much of the demand | They change the plans. |

Chosen freely for each scenario run: the scenario, the threshold for changing stop, the give-up limit, and capacity. Capacity on a BAU run replays its kept plans (section 4.5), the first time it is wanted, and is then kept too.

**Which BAU runs are offered.** Those made on the published day the scenario is built on. Each is listed with its name, demand set, area, walking distance, number of journeys and date. If there is none, the wizard says so and offers to make one; it does not make one unasked.

**Comparing afterwards.** A scenario run always shows its figures against its BAU run. In the results, "Compare with" also offers any other run made against the same BAU run, so two scenarios can be set side by side on the same people (section 7, "Two runs"). Runs made against different BAU runs are not offered to each other: their people, area, walking distance or another of the shared settings above differ.

**Keeping and removing:**

- Like every run, a BAU run is kept until someone removes it (section 6.5). It is listed with its size and the number of scenario runs that depend on it.
- Removing a BAU run that scenario runs depend on asks first. Those scenario runs stay viewable but lose their against-BAU figures.
- A BAU run is marked out of date, not removed, when the published day is imported again; a new one must be made for the new timetable. When vehicle capacities are edited in the fleet screen, only its capacity results are thrown away; the plans do not depend on capacity.

**Not in the first version: reusing the BAU plans inside a scenario run.** Most people's journeys are untouched by a small edit, and in principle their plans could be copied from the BAU run. That is only safe where the scenario takes services away: a person whose journey used none of the removed trips keeps exactly their plan, because removing a service cannot make another journey better. Where a scenario adds or retimes services, anyone might benefit, and deciding who is the hard part. It is the largest saving left and is first on the list after the first version; the area of section 4.7 gets most of the way there for local work.

### 6.5 The simulation library

Every run, BAU or scenario, is kept in one library that everyone using the editor sees (decided 18 Nov). An earlier draft kept only the 5 newest runs to save space; that is dropped. Nothing is removed unless someone removes it.

**Shared.** Runs, demand sets and saved areas live in the editor's database, not in a browser, so anyone who opens the editor sees the same list. A BAU run made by one person is there for another to run a scenario against. Each run records who made it and when.

- The editor has no logins yet (phase 6 of `PLAN.md`). Until it does, "who" is a name typed once in the wizard and remembered by the browser; it is a label, not a permission. With logins it becomes the account.
- Anyone can open any run. Renaming, moving and removing are open to everyone until logins exist; after that, to the person who made the run and to administrators.
- A run made on someone's scenario can be opened by others, as scenarios can.
- Because the library is shared, so is the lookup of one person's journeys by `user_id`. That is fine: the id is a made-up code (answered 18 Nov).

**Organised by folder and by date.**

| | |
|---|---|
| Folders | A run sits in one folder, or in "Unfiled". Folders can hold folders (for example `Newcastle / Light rail extension`). Created, renamed and moved in the library; an empty folder can be removed. |
| Where a new run goes | The folder is chosen in the last step of the wizard. Already chosen: for a scenario run, the folder of its BAU run; for a BAU run, the folder used last. |
| By date | The library can be switched from folders to a list by the date a run was made: today, this week, each earlier month. Every run shows its date and maker in either view. |
| BAU and scenario runs together | A scenario run is listed under the BAU run it was made against, wherever each is filed, so it is always plain what was compared with what. |
| Finding a run | Search by name. Filter by kind (BAU, scenario), area, demand set, published day, who made it, and "out of date". |

**Space.** A big run is several million rows, so the library shows the size of each run and of the whole, and warns when the disk is getting full. Two ways to give space back, both by hand:

- **Archive a run:** its journeys and legs come out of the database and stay as the compressed files on disk. The summary, the loads on trips and the figures at stops stay, so it still opens and compares; only the lookup of one person and the person-by-person comparison need it restored, which is one click and a short wait.
- **Remove a run:** gone, files and all. Removing a BAU run that scenario runs depend on asks first (section 6.4).

## 7. Showing results in the editor

A run is chosen in the Simulate panel. While one is chosen, the existing views gain passenger figures; nothing changes when none is.

| Where | What is shown |
|---|---|
| **Simulate panel** (new, left side) | "New simulation" opens the wizard of section 7.1. Below it: the run in progress, and the simulation library (section 6.5): every run, shared between users, by folder or by date, with scenario runs listed under their BAU run and "out of date" where it applies. |
| **Summary** (in the panel) | People, journeys completed, no journey, gave up, stranded. Median and 90th percentile journey time; average wait, walk and rides. Against the published timetable: how many arrive sooner, later and by how much; how many changed stop, and whether because theirs was gone or another was better. Trips planned over capacity, how far over and from what time, with a "Run again with capacity" button that reuses the plans. With capacity on: times passengers were left behind, the ten fullest lines and the ten stops that left most people behind. A plain note of the limits in section 4.4 and of placeholder capacities. |
| **Line panel** | The hourly chart gains passengers against places. Passengers a day, the fullest stretch and hour, trips over 100% and over 80%. |
| **Trip panel** | Passengers aboard along the trip's stops, against its capacity, with boardings and alightings at each. |
| **Station panel** | Boardings, alightings and changes by hour; people left behind; the most waiting at once. |
| **Timelines** | The trip diagram and the vehicle chart can colour each trip by how full it is. |
| **Map** | Vehicles coloured by how full they are at the clock's time. Lines drawn thicker by passengers in the chosen hour. Stops sized by boardings. This also closes "capacity on the map" from `PLAN.md`. |
| **One person** | Type a `user_id`: their journeys are listed and drawn on the map, leg by leg, with where they waited or were left behind. |
| **Two runs** | A scenario run opens compared with its BAU run. "Compare with" offers any other run made against the same BAU run, so two scenarios can be set side by side (section 6.4). The comparison is person by person, matched on `user_id` and journey: journey times before and after; how many people are quicker, slower, newly unable to travel or newly served; how many lost their stop and how far they now walk; the lines whose loads changed most; and on the map, where the people who lost time start from. It notes where the two runs used a different threshold, give-up limit or capacity setting. |

### 7.1 The wizard

Four short steps, each with a sensible choice already made. Back is always available and nothing starts until the last step. The first step decides which of two paths the rest takes.

| Step | A BAU run (the published timetable) | A scenario run |
|---|---|---|
| 1. What to simulate | Chosen here: "The published timetable (BAU)" or "The scenario on screen". Already chosen: the scenario if one is open, otherwise BAU. | The same step. |
| 2. Who and where | **Who is travelling:** pick a demand set, upload a CSV, or make one up (size and seed). After an upload: the check report (rows read, rows refused and why, users, busiest hour). **The area** (section 4.7): the whole network, a saved area, what is on screen now, or a box dragged on the map, with the count of journeys inside it. | **Compare with:** pick a BAU run from the list (section 6.4). Its demand set, area, walking distance, time a change of vehicle must save, school buses and share of demand are shown and used as they are. If no BAU run exists for this published day: "Make a BAU run first", which goes to the other path. |
| 3. How people travel | How far people will walk to another stop (0 to 2,000 m, with the minutes on foot beside it). How much time one more change of vehicle must save. School buses in or out. How much of the demand: all, or 1 in 2, 5, 10. Capacity: off, or on. | How much better another stop must be before they change. How much later they will accept arriving before they give up. Capacity: off, or on. |
| 4. Check and run | A name for the run, suggested from the choices ("BAU bounded Newcastle"), and the folder it goes in (section 6.5). A plain summary: the number of journeys in the run and the number left out by the area (wholly outside, and one end inside), a rough time, and warnings. | A name ("Scenario 7 against BAU bounded Newcastle") and a folder, the BAU run's unless changed. The same summary, plus how many people's stop has no service in this scenario and how many of those have another within the walking distance. |

Already chosen in step 3: 500 m; 10 minutes for a change of vehicle; school buses out; all of the demand; 10 minutes; 60 minutes; capacity off. With capacity on, two more: what counts as full (all places, or seats only; all places unless changed), and how many times someone may be left behind before they give up (5).

- Warnings in step 4: stop ids the timetable does not have, placeholder capacities if capacity is on, the router not running, and how long preparing the timetable should take if the router does not hold it.
- The rough time comes from the journeys per second of earlier runs on this machine; the first run says it has nothing to go on.
- The choices of the last run are remembered, including the BAU run compared with, so repeating a scenario run after an edit is two clicks.
- Step 3 holds every setting of how people behave. A setting added later (spreading over alternatives, a person's journeys in sequence) goes there.

Vehicle loads for the map are sent as one block of numbers lined up with the vehicle data the map already has, not as JSON per trip; a weekday is about 2 million numbers.

## 8. What changes elsewhere

| Thing | Change |
|---|---|
| Editor export | An option to leave out `shapes.txt`, and an option to cut the export to a box (section 4.7). |
| Database | Saved areas (`sim_areas`: name and box). `sim_runs` records each run's name and area, whether it is a BAU run, for a scenario run the BAU run it is measured against, its folder, who made it and when, its size, and whether it is archived. `sim_folders` holds the folders (name and parent). |
| Node API | `ROUTER_SERVICE_URL` (the journey router; `ROUTER_URL` is already the road-routing server and keeps its meaning). The version key. The routes in 6.1. |
| Router plan, phase 5 | The demand generator is built here. The benchmark harness stays there and uses it. |
| Router plan, phase 7 | The Node-to-router link and the staleness check are built here. The journey-planning panel is still phase 7. |
| Router plan, phase 6 (road routing) | Not needed by the simulator. |
| `PLAN.md` | "The passenger simulator" moves from "later" to planned, with a pointer to this file. |

Real vehicle capacities are not part of this plan but decide how much the crowding results mean. Entering them in the fleet screen for trains, metro and the common bus types would be worth doing before anyone reads a crowding figure.

## 9. Testing

| Test | What it proves |
|---|---|
| Hand-made lines with known answers | A full vehicle leaves people behind and they take the next; someone boarding up the line gets the place ahead of someone down the line who set off earlier (the case bulk assignment gets wrong); a passenger with no way left is stranded; staying aboard a vehicle that runs on. |
| Rules that must always hold, on random timetables and demand | No trip ever leaves a stop over capacity. Boardings equal alightings on every trip. Everyone is `ok`, `noJourney`, `gaveUp` or `stranded`, once. Nobody who gave up or had no journey is aboard anything. Every journey taken replays against the timetable (`JourneyChecker`). |
| Capacity off equals the router | With capacity off, each journey is the one the router recommends when asked the simulator's own question: between the person's own stops, with 10 minutes per vehicle. (It is not what `POST /v1/journeys/bulk` gives, which lets a journey begin with a walk to a nearby stop and counts 5 minutes per vehicle.) |
| Very large capacity equals capacity off | Nothing is lost by switching capacity on when nothing is full. |
| Which stops a person uses (section 4.6), on hand-made lines | On the published timetable nobody changes stop, whatever is nearby. A change elsewhere moves nobody. A person going to a stop nothing calls at gets off at a served stop within the distance and walks; with the distance at 0, or nothing within it, they have no journey. A person whose stop keeps a poor service changes when the nearby one is better by more than margin plus threshold, and not when it is better by less. A person with a margin of 10 minutes needs 20. A new stop near a person is used when it is better by enough. A person whose platform loses its trains uses another platform of the same station. A row that is a position and not a stop walks to the stops around it. A person arriving later than the limit gave up and is on no vehicle. |
| The same, on the real weekday | A BAU run changes nobody's stop. Close a stretch in a scenario: people bound for the closed stops still arrive, on foot from a stop near it. Add a line: some people near it use it. |
| The area (section 4.7) | Only journeys with both ends inside are run, and the counts left out add up to the demand set. No stop outside the widened box is in the cut export; every trip in it has two or more calls and times that run forwards. A journey well inside the box is the same on the cut timetable as on the whole one. |
| The library (section 6.5) | A run made in one browser is listed in another. A run can be filed, moved and found by name, folder, date and maker; a scenario run is listed under its BAU run. Nothing is removed without being asked. An archived run still opens and compares in total, and comes back whole when restored. |
| BAU runs (section 6.4) | A scenario run plans nothing on the published timetable, and takes its demand set, area, walking distance and the other shared settings of section 6.4 from the BAU run chosen. Two scenario runs against one BAU run can be compared; runs against different BAU runs are not offered to each other. A scenario on another published day is not offered the BAU run. Capacity on a BAU run replays the kept plans. Removing a BAU run with scenario runs depending on it asks first. |
| Plan reuse changes nothing that matters | With reuse on and off: the same status, arrival, costs and margin for every row, and every reused journey replays for the person it is given to. The legs may differ where two ways of making a journey tie. |
| Planned loads tell the truth (section 4.5) | Where no trip is planned over capacity, a run with capacity on leaves nobody behind and equals the run with capacity off. Where some are, nobody whose journey ends before the first overloaded departure is affected. |
| Capacity from kept plans | A capacity run started from the plans of a capacity-off run equals a capacity run made from scratch. |
| Same answer every time | One thread and eight; two runs in a row. |
| The real weekday | A made-up demand set of 100,000 runs end to end from the editor; the counts in the database equal those in the summary. |
| In the browser | `npm run test:ui` gains: generate a small demand set, run it, see the summary, open a line and a trip with passenger figures, look up one `user_id`. |

A useful measurement, not a test: the same demand through the simulator and through the router's bulk `assign`, to see how far apart the two are.

## 10. Build order

Sizes are rough days of focused work.

| Phase | What is built | Ends with | Size |
|---|---|---|---|
| S0. Demand | The CSV format, reader and checks; the generator | A demand file of any size for the weekday | 2 |
| S1. Simulator core | Stage 1 with plan reuse, the two searches and the stop rule of section 4.6, the reference and giving up, planned loads, stage 2 with batched re-planning, kept plans, result files, the command line, the tests of section 9, the measurements of section 4.5 | A run from the command line, with results as files | 9 to 10 |
| S2. Jobs | The four endpoints, progress, stop, one at a time | A run started and collected over HTTP | 2 to 3 |
| S3. Editor back end | Export without shapes and cut to a box, saved areas, version key, demand sets, runs, named BAU runs and scenario runs made against them, folders, who made a run, archiving, copying results in, out-of-date marking | A run started through the Node API with results in the database | 7 to 8 |
| S4. Editor panels | Simulate panel, the library (folders, by date, search and filters), the wizard with the box drawn on the map, summary, figures on the line, trip and station panels, one person by `user_id` | **First usable version: run from the editor, read the results** | 6 to 7 |
| S5. Map and timelines | Vehicles by how full, lines by passengers, stops by boardings, trips coloured in the timelines | Passengers visible on the map | 3 to 4 |
| S6. Two runs | The comparison of section 7 | Published against scenario, side by side | 3 |
| Later, in rough order | Passengers spread over alternatives; a person's journeys in sequence; crowds slowing vehicles (level 2); crowding as discomfort and repeated runs (level 3); planning again only what an edit touched; several days | | Not sized |

S0 to S2 need nothing from the editor except one exported zip. S3 is the first work that touches the Node API.

## 11. Risks

| Risk | Effect | What to do |
|---|---|---|
| Placeholder capacities | Every "left behind" and "stranded" figure is illustrative. | Say so on every crowding figure; capacity off is always available; enter real capacities. |
| Planning 1.7 million journeys twice takes one to three hours | Too slow to use while editing. | Plan reuse; BAU runs made once (section 6.4); an area (section 4.7); a share of the demand; measure on a made-up set in S1 before building the editor side. |
| An area hides what crosses its edge | A local change looks smaller than it is, and vehicles near the edge look emptier. | The count of journeys left out is shown with every result; the whole network is always a choice. |
| No real demand data yet | The size and the stop ids are answered (section 12); how journeys are spread over stop pairs, which decides how much plan reuse saves, is not known. | A made-up set until a real file arrives; measure reuse again on the first real file. |
| Everyone takes the one recommended journey | Loads are lumpier than life. | Stated with the results; spreading over alternatives is first on the later list. |
| Memory on the development machine | The router, PostgreSQL, the dev servers and a run may not fit together. | An area or a share of the demand fits in the usual 768 MB heap; results are streamed to disk. Only a whole-network run needs the heap raised to about 1.5 GB (section 5.2). |
| Results fill the database | Several million rows a run. | Nothing is removed automatically. The library shows sizes and warns when the disk is filling; a run can be archived (its bulk moved out of the database) or removed, each in one statement (tables partitioned by run). An area keeps runs small. |
| Results shown against an edited timetable | Wrong figures on changed trips. | The version key and the out-of-date mark. |
| The export, even without shapes, is slow | Minutes before every run on a changed scenario. | Measure in S3; the database reader of the router plan's phase 8 is the fix. |

## 12. Questions for the owner

### Decided (18 Nov 2026)

| Topic | Decision |
|---|---|
| Origins and destinations | Stop ids, with each stop's position stored beside it (section 3.1). |
| What the data is | What each person did on the day. A changed timetable is measured by its effect on that person, so they keep their own stops. |
| BAU runs | A run on the published timetable is a named BAU run, made on purpose and kept. Each scenario run is made against a BAU run picked in the wizard; nothing on the published timetable is re-run for it (section 6.4). A bounded area gets its own BAU run, for example "BAU bounded Newcastle". |
| The area of a run | A box on the map: only journeys that start and end inside it, on a timetable cut to it (section 4.7). |
| The simulation library | Every run is kept until removed by hand, shared between users, and organised in folders or by date (section 6.5). The limit of 5 runs is dropped. |
| Which stops a person uses | Their own on the published timetable. On a changed one they keep the preference they showed on the day, and change to a stop within walking distance only when it is better by more than that preference plus a threshold (section 4.6). 500 m and 10 minutes by default, changed in the wizard. |
| How much worse people accept | Arriving more than 60 minutes later than on the published timetable, they give up and are counted as such. Changed in the wizard. |
| Setting up a run | A short wizard (section 7.1). |
| Capacity | Off by default. |
| A full vehicle | People plan again from where they stand. |
| One person's journeys | Independent of each other for now; to be revisited (section 13). |
| Capacity and threads | The idea of ignoring capacity until enough people are travelling is dropped; capacity is a second step over the same plans (section 4.5). |

### Answered (18 Nov 2026)

| Topic | Answer |
|---|---|
| Stop ids in the real journey data | The same ids as the feed's. |
| Journeys in a day | About 1.7 million. Section 5.2 is sized for that. |
| `start_time` | The time the person tapped on at the origin stop. |
| How much better another stop must be before a person changes | 10 minutes by default, set in the wizard. |
| How much later a person accepts arriving before giving up | 60 minutes by default, set in the wizard. |
| Changing vehicles | People take a journey with one more change only if it saves more than 10 minutes; set in the wizard (section 4.6). |
| How journeys are scored | Arrival time, plus 10 minutes per vehicle boarded, plus the time walked counted again. Accepted; to be adjusted later if needed. |
| The area | Whole-network runs are long (section 5.2), so a bounded area is the usual way to work (section 4.7). |
| A person's own stop | Any stop under the same parent stop counts as their own. |
| Crowding | People do not know about it before they travel, for now. |
| Which journey | Everyone takes the recommended journey. |
| Vehicles always on time | Accepted for the first version. |
| School buses and school children | School buses are left out of the timetable. School children are already absent from the journey data, so every row is simulated. |
| Who made a run | A typed name is enough until there are logins. |
| `user_id` | A made-up code that lets one person's journeys be matched between runs. Not personal data; no special care. |
| After the summary | The map (S5), then comparing two runs (S6). |

### Still open

None. Every question asked of the owner has an answer above.

## 13. Assumptions to come back to

Made to get a first version working. Each is wrong in a known way.

| Assumption | Why it is wrong | What revisiting it would take |
|---|---|---|
| **One person's journeys are independent** (decided 18 Nov) | Someone whose morning journey is stranded or an hour late does not start the evening journey from the planned place at the planned time. Return trips and chains (home, school, work) are tied together. | Order each user's rows by time; start a journey no earlier than the one before it ended; decide what a stranded person does next. The replay already runs in time order, so a later journey can be released when the earlier one ends. Needs to know whether real data marks which journeys form a chain. |
| Origins and destinations are stops | People start from addresses, not stops. The walking distance of section 4.6 is measured from the stop they used, not from their door, so it reaches too far on one side and not far enough on the other. | Real origins and destinations in the demand file's position columns, which are already read. |
| A person's preference for their stop is one number from one day | The margin of section 4.6 stands in for everything behind the choice of stop: where their door is, a hill, a habit, a seat. It is measured on one journey and assumed to hold on any timetable. | More days of data per person; real origins; a margin per kind of vehicle. |
| People who give up vanish | Someone who would not make the journey by public transport drives, goes later, or goes elsewhere. The simulator only counts them. | Road routing (phase 6 of the router plan) for the drive; a rule for re-timing. |
| People keep their recorded start time | With a less frequent service people leave earlier to arrive on time. The simulator starts them when the data says and lets them arrive late. | Plan to arrive by the reference arrival (needs arrive-by search, which the router does not have). |
| One walking distance for everyone | Some people will walk further than others, and further to a train than to a bus. | A distance per row, or per kind of vehicle. |
| Everyone takes the recommended journey | Real passengers spread over alternatives. | A rule for sharing people among the journeys the router offers. |
| People do not know about crowding | Regular travellers avoid the full train. | Level 3 of section 4.1. |
| Vehicles are always on time | Crowds slow boarding; late vehicles break connections. | Level 2 of section 4.1; door counts and boarding rates in the vehicle catalogue. |
| Capacity is seated plus standing, from placeholders | The figures are round numbers. | Real capacities in the fleet screen. |

## 14. S0 and S1 findings (18 Nov 2026)

S0 and S1 are built as a new module, `services/router/router-sim`. A demand file can be checked or made up (`npm run router:demand`), and a run made from the command line with its results as files (`npm run router:simulate`): a BAU run, a scenario run against one, or capacity added to either from its kept plans. How to use them is in `services/router/README.md`. 48 tests cover section 9's rows for these two phases. (S2, the HTTP service, followed: section 15. Nothing is in the editor yet; that is S3.)

### Measured on the published weekday

One run each on the development machine, 10 threads, the usual 768 MB heap, other programs running. Demand is made up, so the figures say how the simulator behaves, not how people travel. Every capacity is a placeholder.

| Measure | Plan's estimate | Measured |
|---|---|---|
| Planning, whole network, 100,000 journeys in the Opal area | 300 to 700 journeys a second, halved by planning twice | 186 s: 538 journeys a second, which is 1,076 searches a second. Other runs: 602, 649 and 794 a second. |
| 1.7 million journeys at that rate | one to three hours | 35 to 55 minutes, if real data shares no plans at all |
| Planning bounded to Newcastle (6,383 of those journeys; 93,313 wholly outside and 304 with one end inside left out) | "much quicker" | 3.8 s: 1,686 journeys a second, three times the whole-network rate, on the whole timetable. The cut of the timetable itself comes with S3. |
| Capacity off: putting 100,000 planned journeys on the vehicles | cheap | 3.9 s, and 6 s to write 100,000 journeys, 517,705 legs, 1.2 million trip-stop rows and 321,292 stop-quarter rows |
| Searches saved by reuse | "most", on real data | 1 of 200,000 on the made-up set, and 62 with the demand concentrated on busy stops. Made-up journeys do not share stop pairs. In the tests, where a few pairs carry most journeys, reuse saves over a quarter. **Still to be measured on real data.** |
| Trips planned over capacity, 100,000 single journeys | not estimated | None. The capacity step is skipped, as section 4.5 says. |
| The same journeys with each row standing for 17 people (1.7 million people) | not estimated | 15,424 trips planned over capacity. 48% of people left behind at least once; 230,111 stranded. |
| The capacity step against planning, on that run | "seconds, unless a large share are left behind" | 113 s of replay against 154 s of planning: 177,423 searches for those left behind. A set concentrated on busy stops gave the same 113 s (53% left behind). This is a deliberately overloaded set, with people in lumps of 17 and bus capacities of 65. |
| Loading the timetable for a run | 4 s | Under 1 s from the snapshot |

### Checked on the published weekday

| Check | Result |
|---|---|
| A BAU run changes nobody's stop | 0 of 100,000, with capacity off and on. |
| A scenario run on the same timetable as its BAU run (Newcastle, 6,383 journeys) | Nobody changes stop, nobody gains or loses a journey, and all 5,615 arrivals are within a minute of the reference. |
| A stand-in scenario: every call at the three busiest destination stops in Newcastle removed (717 stop times) | Everyone who travelled on the BAU run still arrives. 74 people change stop because theirs is gone and 31 because another is now better by more than their margin and the threshold; 64 arrive later, by 12 minutes on average. Nobody gives up. This zip was made by a script, not by the editor; a real scenario export is the test once S3 exists. |
| A capacity run's files, read back by a separate script | No trip leaves any stop over capacity; boardings equal alightings on every trip; the legs file and the trip loads agree. |

### What differs from the plan

- **A bus that leaves two stops in the same second could be overfilled.** Section 4.2 says only the boarding stop's load matters. That fails where a vehicle has the same time at consecutive stops, which is common in this feed: someone planned again in that second boards at the earlier stop after the later one has been dealt with. The first real run had 127 departures over capacity. A boarding now needs room along the whole ride, which is the same test in every other case. Found by reading the result files back, not by the tests; a test now covers it.
- **Someone left behind plans again from the stop they are at, or another stop of the same parent.** A first version let them walk to any linked stop, and a BAU run with capacity then showed 199,771 people "changing stop", against section 4.6. They no longer walk off to another stop.
- **Someone with no journey on the published timetable is not handed one by an unchanged timetable.** Rule 3 of section 4.6 as written gave them the any-stop-near journey in any scenario, so a scenario identical to the published timetable "newly served" 3,749 of 100,000 made-up journeys. They now take it only if the scenario has made it better than it was on the published timetable by more than the threshold. Real journeys were all made, so this should be rare on real data.
- **Plan reuse is a little narrower than section 5.2 described, and not leg-for-leg exact.** One search answers later starts up to the earliest departure among all the journeys it offers, because the recommended journey is chosen by cost and a later start can lose a competitor. Status, arrival, costs and margin are then the same as a fresh search; where two ways tie, the legs can differ (under 1% of journeys in the tests). A search that offers walking the whole way is never reused.
- **Only the journey a person takes is kept in full;** the other is kept as its arrival and cost. That is all the margin and the results need, and it halves the memory.
- **A row split by a full vehicle has several lines** in the journeys and legs files, told apart by a `part` column.
- **"Seats only" is not available.** The timetable holds one capacity per trip (seated plus standing). A run takes `--full-at`, the share of capacity that counts as full; the editor will have to supply the seated share for the wizard's "seats only" (section 7.1).
- **The area filters journeys only** from the command line. Cutting the timetable to the box is an option of the editor's export, in S3.
- **Positions are looked up by the BAU run,** which keeps the located demand in its folder; scenario runs read it from there. In S3 the Node API does this at upload (section 3.1).
- **The generator has two options the plan did not ask for:** `--focus`, to concentrate journeys on busy stops, and `--people`, to make each row stand for several. Both exist to give the measurements above something to measure. The router's own test journeys (`RouteCli --random`) still use their own copy of the same draw.
- **The router gained one public method,** `Router.near`, so that the simulator can list the stops near a position. Nothing else in the router changed.

### Not done

- The two real-weekday rows of section 9 that need an editor scenario ("close a stretch", "add a line") were stood in for by the scripted zip above.
- A whole-network run of 1.7 million rows was not made. The 100,000-row runs fit in 768 MB.
- Speeding up the capacity step when many are left behind. Searches for them run together only when they fall in the same second, so it is far less parallel than planning. Worth doing only if real loads with real capacities leave many behind.

## 15. S2 findings (18 Nov 2026)

S2 is built: the router service runs simulations as jobs. The four endpoints of section 5.1 are there, with a fifth that lists every run. How to call them is in `services/router/README.md`. Six tests drive them over HTTP on a hand-made feed.

The owner confirmed on 18 Nov that comparisons are only valid on the same demand, and that this is how runs will be made. That is how a scenario run already works: it has no demand of its own, and reads the journeys its BAU run kept (section 6.4). The service refuses a scenario run that tries to set anything its BAU run decides.

### Tried on the published weekday

One service with the weekday and the closed-stops stand-in of section 14 both loaded, driven over HTTP.

| Tried | Result |
|---|---|
| A BAU run bounded to Newcastle | Done in 6 s; the same figures as from the command line (5,615 of 6,383 travel). |
| A scenario run against it and capacity from its plans, asked for together | The second waited behind the first; both finished, with the same figures as section 14. |
| A whole-network run stopped while planning | Stopped at once, and left no files. |
| Discarding the BAU run while the other two exist | Refused, naming them. |
| Runs made earlier from the command line into `data/router/sim` | Listed when the service started. |

### What differs from the plan

- **Finished runs outlive a restart.** Section 5.1 did not say. A scenario run needs its BAU run, so the service lists again every finished run it finds in its folder. A run that failed or was stopped leaves nothing.
- **A fifth endpoint,** `GET /v1/simulations`, lists the runs.
- **Stop and discard are one call,** as planned, but a run stopped while waiting or running stays listed as `stopped` until it is deleted a second time, so that whoever is following it can see what became of it.
- **A run others were made from is not discarded** without `?force=true`. Section 6.4 has the editor ask first; the service makes that hard to get wrong.
- **A run holds its timetable from the moment it is asked for,** not from when it starts, so a run waiting in the queue is not changed by a reload either.
- **The caller may choose the run's id.** The Node API can then use its own.
- **A stop is an interrupt.** Planning gives up at the next pair of stops and the replay at the next second of the day; neither waits for the stage to end.

### Not done

- The service still runs in the 768 MB heap. A whole-network run of 1.7 million journeys will need it raised (section 5.2); nothing checks before starting, and a run that runs out of memory fails with a message saying so.
- A demand file given as a URL is fetched whole before it is read; nothing is streamed.

## 16. S3 findings (18 Nov 2026)

S3 is built: the editor's API keeps demand sets, saved areas, folders and runs, gets the right timetable into the router, starts and follows the job, and copies the results into PostgreSQL. The routes are listed in the root `README.md`. `npm run test:sim` drives all of it against the running API and router. There are still no panels in the web app; that is S4.

### Measured on the published weekday

| Measure | Plan's estimate | Measured |
|---|---|---|
| Export without shapes | "well under a minute" | 14 s and 25 MB, against 2 to 5 minutes and 179 MB with them |
| Export cut to Newcastle | not estimated | 6 s and 2 MB |
| Getting a scenario's timetable into the router (export, fetch, load) | minutes before every run was the risk | 22 s for the whole network |
| A BAU run of 100,000 made-up journeys, whole network, started through the API | | Done; the API was restarted while it was planning and picked the run up again |
| Rows copied into the database for that run | "several million" for a million journeys | 2,138,703: 100,000 journeys, 517,705 legs, 1,199,706 trip-stop rows, 321,292 stop-quarter rows. Each count equals the summary's. Every trip and stop was matched to the editor's own. 246 MB. |
| A scenario run against it: Scenario 7, which adds two stops and a light rail line | | 19 people ride the new line and 3 board at its new stops; 6 change stop because another is now better; 12 arrive sooner, by 19 minutes on average, and nobody later |

That scenario run is the "add a line: some people near it use it" check of section 9, now on a real export from the editor. The "close a stretch" check has still only been done on the scripted zip of section 14.

### What differs from the plan

- **The router checks demand files, not the API.** Section 3.2 had the Node API check the rows and look up positions. The reader already exists in the router, so the API hands the upload to a new router call (`POST /v1/demand/check`) and keeps its report. Positions are looked up by the BAU run, as section 14 said. The API does keep how many journey ends name each stop id, and says which ids a day's published timetable does not have. An upload therefore needs the router running.
- **Making demand up needs the published timetable in the router,** so the first time it waits for an export; the set shows as `generating` until it is ready.
- **Capacity added to a run is a run of its own** in the library, listed under the run whose plans it uses, not a second set of results on the same run.
- **Out of date is worked out when a run is read,** by comparing the version it was made on with the scenario as it is now. Nothing has to be marked when a scenario is edited, and undoing the edit brings the run back into date. The version is the published day as imported, the scenario's `head`, and the time of that edit.
- **Vehicle capacities are part of the version the router holds** but not of the plans' version, so editing a capacity reloads the timetable and marks only capacity results out of date, as section 6.4 wants.
- **A run records its own copy of its box,** so removing a saved area changes no run.
- **Removing a demand set that runs were made from asks first,** like removing a BAU run.
- **The demand file is handed to the router by path** when both are on one machine, which is the usual case, and by URL otherwise (`ROUTER_SHARES_FILES=0`).

### Not done

- **Size on disk.** 246 MB for 100,000 journeys is about 4 GB for a whole day of 1.7 million, most of it the trip-stop rows and the legs. Archiving takes out the journeys and legs only. Nothing warns when the disk is filling yet; that belongs with the library panel in S4, which shows sizes.
- **"Seats only"** is still not offered: the export gives seated and standing per vehicle type, but the router adds them into one figure.
- **Who may rename or remove** is open to everyone, as section 6.5 says until there are logins.
- The check in the browser (`npm run test:ui`) has nothing to drive until S4.

## 17. S4 findings (18 Nov 2026)

S4 is built: the simulator can be used from the editor. This is the first usable version of section 10. `npm run test:ui` sets up and runs a BAU run and a scenario run through the interface, with the router running.

### What is in the editor

| Where | What |
|---|---|
| Simulation panel, left column | "New simulation" and "Library". The run in progress with its stage, a count and Stop. A chooser of finished runs. The chosen run's summary: who travels, journey times, against the published timetable, who changed stop, trips planned over capacity, crowding where capacity is on, the note on placeholder capacities and the limits of section 4.4. "Run again with capacity". One person by `user_id`, listed and drawn on the map. |
| Wizard | The four steps of section 7.1, both paths. Upload a CSV and see its check report, or make journeys up. The area: whole network, a saved area, what is on screen, or a box dragged on the map, which can be saved under a name. The last step names the run, files it, and warns. The choices of the last run are remembered in the browser, as is the name typed for "who". |
| Library | Every run of the chosen day, by folder or by date, with scenario runs and capacity runs listed under the run they were made from. Search by name; filter by kind, maker and "out of date". Open, rename, move, archive and restore, stop, remove (two clicks, and it says when other runs depend on it). Folders are made, renamed and removed there. Each run's size, and the total. |
| Line panel | Passengers a day, trips full and over 80%, the fullest point with its time, and passengers against places by hour for each direction. |
| Trip panel | Passengers aboard along the trip's stops against its capacity, with boardings, alightings and anyone left behind. |
| Station panel | Boardings, alightings and changes, left behind, the most waiting at once, and boardings and alightings by hour. |
| Links | `&sim=<run id>` in the address names the run whose figures to show. |

### What differs from the plan

- **The wizard counts journey ends inside an area, not journeys.** Section 7.1 asks for "the count of journeys inside it". The API knows how many journey ends name each stop, not which pairs go together, so before a run the wizard says what share of journey ends are inside the box and estimates the journeys from that. The exact counts (inside, across the edge, outside) are in the run's summary, as before.
- **Capacity added afterwards is its own entry** in the library and in the chooser, under the run it came from, as section 16 said. "Run again with capacity" makes it.
- **Figures show only on the timetable the run was made on.** With a BAU run chosen and a scenario open, the panel says so and offers to open the published timetable. Trips a scenario has changed since a run have no figures, because an edited trip is a new trip.
- **The rough time** is the number of journeys over the average planning rate of earlier runs. It does not allow for a smaller area being quicker per journey, so it errs on the long side for bounded runs.
- **"Who" is a name typed in the wizard's last step** and kept by the browser, as section 6.5 says until there are logins.
- **The panel is in the left column, folded to its heading** until it is opened or a run is going or chosen; the left column is short of room with the scenario panel above it.

### Not done

- Step 3's extra capacity settings (what counts as full, how many times someone may be left behind) are not in the wizard; the defaults are used. The API takes both.
- The wizard's last step does not say how long preparing the timetable will take beyond "up to half a minute".
- Nothing warns when the disk is filling. The library shows each run's size and the total.
- The map and timelines are S5 (vehicles coloured by how full, lines by passengers, stops by boardings). The side-by-side comparison of two runs is S6; until then a scenario run's summary shows its figures against its BAU run.
