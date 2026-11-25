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
