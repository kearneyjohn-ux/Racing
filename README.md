# Race Course Plotter

Drive an off-road course once with GPS and get every corner found, rated and colour-coded by how fast you can take it. Then drive it again with spoken pace notes.

It runs in the phone's browser, so there's nothing to install. You can add it to your home screen and it works offline at the track.

## How to use it

1. **Open the app on your phone** (see [Hosting](#hosting); it must be served over `https://` for GPS to work).
2. **Record a lap.** Recording is the app's main job, so the big red **Record** button is always on the map, one tap from opening the app. Before you start, the button shows your GPS signal ("GPS ready ±4 m"); wait for green if you can. Then:
   - The screen switches to a large recording view: timer, distance, speed, GPS accuracy, and the track drawing on the map.
   - When you pass back by the start line, the phone buzzes and says "Lap complete". Turn on *Settings → Stop recording automatically at the end of the lap* to have it stop there by itself.
   - Stopping takes a **1-second press-and-hold**, so a bump or a stray tap can't end it early.
   - The track is saved every few seconds. If the browser is closed mid-lap, it offers to recover the recording next time you open the app.
   - Keep the app open with the screen on (it keeps the screen awake for you). Phones pause GPS for web apps in the background. If that happens you're warned that part of the track was guessed.
   - If you drive more than one lap, only the first full lap is used (a lap only counts as finished if the course then goes round again, so a course that passes its own start isn't cut short).
   - **If the app stopped mid-lap** and you started again, go to *Course → Join two recordings*, pick part 1 and part 2, and tap **Join**. Any gap between them is filled with a smooth curve (dotted on the map), and corners inside the gap are marked as guesses. If the two parts overlap, the overlap is trimmed instead. The originals are kept.
   - Or **import a file** from a GPS logger, lap timer, sports watch or Strava/Garmin export: GPX, KML, GeoJSON, CSV (with `lat`/`lon` columns) or NMEA.
   - Or tap **Load demo course** to try it at home.
3. **Check the corners.** Each corner gets a rally-style grade and a target speed, and the course is colour-coded on a satellite map:

   | Grade | Colour | Target speed (default settings) |
   |---|---|---|
   | H | deep red | Hairpin: turns 135° or more on a radius under 20 m |
   | 1 | red | under 30 km/h |
   | 2 | orange | 30–45 km/h |
   | 3 | light orange | 45–60 km/h |
   | 4 | yellow | 60–80 km/h |
   | 5 | light green | 80–100 km/h |
   | 6 | green | 100 km/h and up |
   | F | dark green | Flat out: faster than your vehicle's top speed |

   Switch the corner list to **Tightest first** to rank corners by radius, each with its rating and its position on the track in km.

   Notes also say **tightens**, **opens**, **long** (110° or more) and **into** (the next corner follows within 30 m). Tap a corner to see its radius, angle and the speed you actually did. You can override its grade or add a note like "don't cut" or "jump".
4. **Drive with pace notes.** A big colour card shows the next corner, its distance and target speed, plus the corner after it. Notes are read aloud a few seconds before each corner ("left 3 tightens, into right 4"). The target turns red if you're coming in too fast. **Replay lap** plays your recorded lap through drive mode so you can try it from the sofa.
5. **Export**: **GPX** (the track plus every corner and hazard as named waypoints, e.g. "Left 2 tightens", with no numbering; opens in Garmin, OsmAnd, Gaia GPS, Google Earth, and re-imports here with its hazards), KML (colour-coded for Google Earth / My Maps), GeoJSON, or pace notes CSV. Every saved course also has a **GPX** button in the course list. On phones that support it, exports open the share sheet (Save to Files, AirDrop, WhatsApp).

## Compare with a truck log

The **Compare** tab checks the app's corner grades against a file logged in the truck: a **Lowrance .usr** export (Navico waypoints, routes and trails) or a GPX.

- **With corner calls**: each corner is a waypoint named like `L3`, `R 2`, `Left 4` or `3R`. A waypoint naming a run of corners (`R4L3`, `L2 R2`) is split into corners that follow on from each other. Other waypoints (numbered marks, warnings) aren't graded but are shown on the map as grey dots. Calls from other events in the same file are ignored, so a whole season's .usr can be loaded. The truck's trail on this course is picked automatically and drawn dashed blue (or choose one). The calls are taken as correct. Each is matched to the nearest app corner, preferring one turning the same way and allowing for notes dropped up to 100 m before the corner. The app then shows:
  - how many it agrees with (same grade, within one grade, and whether it rates faster or slower on average)
  - every disagreement and every truck corner it didn't find, tappable on the map
  - **recommended changes**, each showing the improvement it would make, applied with one tap:
    - **Learned grade limits**: corner radius limits fitted to your calls (shown in Settings, with a button to go back to speed-based grades)
    - **Grip %**: keeps speed-based grading, scaled to match how you grade
    - **Straight above radius / Ignore bends under**: if the app misses your corners or adds ones you didn't call

  If your log uses 1 for the fastest corners it's detected and flipped. Grade 6 is compared as a 5.
- **Plain track (no waypoints)**: both recordings are analysed the same way and their corner shapes compared, with a recommended GPS smoothing setting.

Nothing changes until you tap **Apply**; the comparison then re-runs with the new setting.

## Drive it in BeamNG.drive

**Corners → Export → BeamNG level** builds a BeamNG.drive mod (.zip) from the course, so you can practise it in the sim:

- **The course is a dirt road** on gently rolling red desert. The track surface drives as dirt and off the track is sand.
- **Start line and spawn:** you spawn just behind the start line, facing the right way. A point-to-point stage also gets a finish line.
- **Map:** the in-game map shows the course coloured by corner grade, like the app.
- **Pace notes** appear on screen as you drive, e.g. "100 m  Left 3 tightens, into Right 4". They use your *Call corners* setting (distance, or time before the corner) and include hazards.
- **Timing:** a loop shows each lap time; a stage shows "Go" at the start line and your time at the finish.

To install: copy the zip to `Documents/BeamNG.drive/mods` (newer versions: `AppData/Local/BeamNG.drive/<version>/mods`), start the game, and pick the course from the map list. The terrain grid is sized to the course: up to about 32 km across (KDR2026 is 29 km). Phone recordings don't carry height, so the ground is gently rolling rather than the real terrain.

The level files follow BeamNG's current format as written by [MapNG](https://github.com/nikkiluzader/mapng) (MIT License, Copyright (c) 2026 Nikki Luzader).

## Settings

- **Surface** sets the grip used for target speeds: tarmac 0.85, hard-packed dirt 0.65, loose gravel 0.55, dry grass 0.45, sand 0.4, wet grass/mud 0.3, snow 0.22.
- **Grip you'll use** (default 80%) is your safety margin. Lower it for a novice, a heavy vehicle or worn tyres.
- **Vehicle top speed**: anything faster is marked **F** (flat).
- **Course type**: auto-detect, loop, or point-to-point stage. **Reverse** analyses the course the other way round.
- **GPS smoothing**: Light for a 10 Hz logger, Normal for a phone, Heavy for poor signal under trees.
- **Straight above radius / Ignore bends under** set how gentle a bend can be before it's ignored.
- **Voice**: Phone default, **American female**, **Indian male**, or any English voice installed on the phone. **Test voice** plays a sample call. Voices come from the phone, so a preset needs a matching voice installed (iPhone: Settings → Accessibility → Spoken Content → Voices; Android: Settings → Text-to-speech → Google → Install voice data). The setting shows which voice is in use.
- **GPX waypoint names**: **Full** ("Left 2 tightens") or **Short** ("L2 T": L/R = left/right, T = tightens, O = opens, HP = hairpin, LG = long) for small chartplotter screens. Short names keep the full wording in each waypoint's description.
- **Call corners**: at a set distance before the corner (default 100 m, also used for hazards) or a set time before it. **Say the distance** adds it to each call, e.g. "100 metres, left 3".

While recording or driving the map follows you. Zoom with pinch or the +/− buttons at any time and the zoom is remembered. Drag the map to look around, and tap **Re-centre** to follow again.

## How the rating works

1. GPS fixes with poor reported accuracy and impossible jumps are dropped, as are stray fixes at either end of a recording (a stale or glitched position that jumps over 100 m to the rest). **Stops are collapsed to a single point**: while parked, GPS wanders a few metres, which would otherwise look like a tangle of tiny corners. A fix counts as stopped when the GPS reports almost no speed, or the vehicle moved less than 8 m in 10 seconds.
2. The track is projected to metres, resampled every 1 m and smoothed. The smoothing adapts to how far apart the fixes are, so fast straights logged at 1 Hz become smooth curves while slow hairpins keep their shape.
3. **Curvature** (1/radius) is measured from the change in heading over an 8 m window. Positive curvature means a left turn.
4. A **corner** starts when the radius drops below 150 m and ends when it rises above 250 m or the direction flips (so an S-bend is two corners). Same-direction pieces less than 12 m apart are merged, and bends turning less than 15° are ignored.
5. Bends tighter than any vehicle can turn (under 2.5 m radius: GPS noise), or taken at walking pace (under 4 km/h) and either tighter than 6 m or where the road barely changes direction 100 m either side (the wobble of crawling into and out of a stop), are not counted as corners.
6. Each corner's **radius** is the mean of its tightest part, and its **angle** is the total heading change.
7. **Target speed** comes from the cornering limit `v = √(μ × grip% × g × r)`, where μ is the surface grip, g = 9.81 m/s² and r the radius. A 50 m radius on loose gravel at 80% grip gives `√(0.55 × 0.8 × 9.81 × 50) ≈ 14.7 m/s ≈ 53 km/h`, a **3**.

## Getting good data

- **Phone GPS** (about ±3–5 m, 1 fix per second) is fine for corner grades. Drive the recording lap a bit slower than race pace so the fixes are closer together in the corners.
- **A 10 Hz GNSS logger** (RaceBox, Garmin Catalyst, Qstarz, Dragy, or any GPS that exports GPX/NMEA) gives noticeably tighter radii and better tightens/opens calls. Import its file and set smoothing to Light.
- Keep the phone high up on the windscreen or dash, not in a pocket or the footwell.
- GPS can't see **crests, jumps, ruts, camber or drops**. Walk the course or do a slow recce lap, and add those as notes on the corners.

> Target speeds are estimates from geometry and an assumed grip level, not a guarantee. Off-road grip changes lap to lap. Build up to them, and always drive within your limits and the event's rules.

## Hosting

It's a static site with no build step:

- **GitHub Pages**: in the repository go to *Settings → Pages* and set *Source* to **GitHub Actions**. Each push to `main` runs the tests and deploys to `https://<user>.github.io/<repo>/`. Open that on your phone.
- **Locally**: `npm start` (or any static file server), then open `http://localhost:8080`. Phones need https for GPS, so use Pages (or a tunnel) for on-car use.

## Development

```
npm test        # unit tests for corner detection, rating and file formats (Node 20+)
npm run demo    # regenerate samples/demo-course.gpx
```

- `js/analysis.js`: smoothing, curvature, corner detection, rating, live positioning (no DOM, runs in Node)
- `js/formats.js`: GPX / KML / GeoJSON / CSV / NMEA / Lowrance .usr import and export
- `js/beamng.js`, `js/beamng-lua.js`: BeamNG.drive level and in-game pace notes; `js/zip.js`: PNG and ZIP writing
- `js/app.js`: map (Leaflet), recording, corner list, settings, drive mode
- `sw.js`: offline cache for the app and any map tiles you've viewed
- `tools/`: synthetic track generator used by the tests and the demo course

## Logo

`assets/` holds the Westlime Motorsport logo as vectors (`westlime-logo.svg` stacked, `westlime-logo-wide.svg` for the app footer) and transparent PNGs for print or social media. The lettering is converted to outlines from Cinzel and Kaushan Script (both SIL Open Font License), so the files don't need any fonts installed.
