# Access analysis: the owner's check (AA-26)

Taken on 26 Nov 2026 by `npm run test:access` in real mode: the NSW feed `nsw-complete-20261112-1750.zip`, the owner's day (Saturday 21 Nov 2026) imported into a throwaway database, the journey router with the Opal-area road data, headless browser. Analysis: zone over Mayfield, 08:00, 250 m spacing, points of interest Newcastle city centre and Westfield Kotara, starting settings otherwise. The full review is `docs/reviews/access-analysis-review.md`.

- `01-zone.png`: the Mayfield zone drawn on the map, a square over Mayfield, Mayfield West, North and East, and Waratah, with Waratah Station inside.
- `02-pois.png`: Newcastle city centre and Westfield Kotara placed and ticked; the setup says 121 sample points, 242 journeys and 242 drives.
- `03-setup.png`: the rest of the setup: walk and journey limits, modes (school buses off), parking allowance, traffic factors by part of the day, the name.
- `04-running.png`: the analysis in the list while it loads the timetable, with Cancel and Delete.
- `05-city-centre.png`: results for Newcastle city centre: coloured bands and labelled lines of equal access ratio over the zone, the summary (median 2.68; 91 of 121 points between 2 and 3), the legend, the settings line and the OpenStreetMap credit.
- `06-kotara.png`: the same for Westfield Kotara: mostly 3 to 4 and 4 or more (median 3.96), better along the railway on the west side.
- `07-point-detail.png`: one sample point to Kotara: public transport 44 min (walk 13, wait 1, bus 11 for 31), car 16 min (8 min drive × 1.4 traffic + 5 min parking), ratio 2.71, with the journey and drive on the map.
- `08-legend.png`: the legend on its own.

**Timing.** The whole check took about 3 minutes (import 112 s). The speed run (`--speed`): a 7 × 7 km Newcastle zone at 100 m, 4,900 sample points × 3 points of interest, 14,700 drives and journeys, finished in 18.6 s, well inside the 5 minutes of NFR-1.

**Judgement: it works, and the map is a good one.** The zone is over Mayfield and both points of interest are in the right places. Each results map is clear: bands, labelled lines, legend, summary and credit. The ratios look right by eye. The city centre is the easier place to reach from Mayfield (median 2.68 against 3.96 for Kotara), and a ratio between 2 and 3 fits a 7-minute drive against a Saturday-morning bus or train trip that counts the wait from 08:00. Small things for later: the results shots frame the zone, so the points of interest are out of view; the "2 to 3" and "3 to 4" colours are close on the dark map; a few short dark strokes show inside the "4 or more" area in `06`; and the Saturday day uses the weekday morning-peak traffic factor.

## The map editor and basemaps (26 Nov 2026)

Taken by `npm run test:access -- --fixture` (the small test feed over central Sydney and the fake router, headless browser), on the branch `feature/aa-map-editor`. The map tiles are real (OpenFreeMap and Esri). `01` to `08` above were taken before this change, so their side panel still shows the old "Draw a zone" and "Add a point of interest" buttons; the next real-data run of the check retakes them.

- `09-basemap-streets.png`: the Streets basemap (OpenFreeMap liberty) under the zone and both pins: building outlines, street and place names. The basemap button sits beside the zoom buttons, bottom left.
- `10-basemap-satellite.png`: the Satellite basemap (Esri World Imagery, with place names over it). The lines, pins and zone handles stay readable; the credit reads "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community".
- `11-drawing-zone.png`: Draw zone in use (lit up in the tool bar on the map): three corners placed, a fainter line on to the pointer at the fourth, and the hint with Undo corner, Finish and Cancel.
- `12-naming-zone.png`: the outline closed on its first corner, and the name box on the map just above it, with the keyboard in it.
- `13-naming-point.png`: Place point of interest in use: the pin dropped at Circular Quay and its name box above it, the name typed.
- `14-reshape-zone.png`: the saved zone after one corner was dragged out (north-east); corner handles are solid, the handles in the middle of each side (drag to add a corner) are hollow. The setup's count line follows the new outline.

## Rides along their vehicles' paths (D39)

- `15-ride-follows-route.png`: taken on 26 Nov 2026 by `npm run test:access -- --fixture` (the small test feed and the fake router, told to ride a real bus of the feed). Sample point 32 near Town Hall to North Sydney: walk 3 min, Bus 333 from Elizabeth St near Hunter St to Oxford St at Taylor Square (10 min), walk 3 min. The bus is drawn along its own path, down Elizabeth St and out along Oxford St, through its bends, not as one straight line; the walks stay dotted straight lines. Before this change the same ride was a straight line from Hunter St to Taylor Square.

## Arrive-by (D40)

Taken on 26 Nov 2026 by `npm run test:access -- --fixture` (the small test feed and the fake router, which rides the same real 333 bus as `15`, reaching Taylor Square at 08:14), on the branch `feature/aa-arrive-by-app`. After the depart-at run, the check makes a second analysis of the same zone and points of interest with the switch on Arrive by, at 09:00.

- `16-arrive-by-setup.png`: the setup with the "Depart at / Arrive by" switch above the time box, Arrive by lit; the box is named "Arrive-by time" and holds 09:00, and the note on traffic factors says the factor is for the part of the day the arrive-by time falls in (the morning peak).
- `17-arrive-by-point.png`: sample point 32 to North Sydney, arriving by 09:00. Public transport 60 min: the time split shows walk 5 min, wait under 1 min, ride 10 min and a violet "Early wait 46 min"; the journey list ends "Arrive 08:14, 46 min before 09:00". The heading and the legend's settings line say "Arrive by 09:00". The fake router has only that one bus, so every point waits long; on real data the early wait is the gap to the last service in time.
