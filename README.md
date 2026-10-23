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
   - If you drive more than one lap, only the first full lap is used.
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

   Notes also say **tightens**, **opens**, **long** (110° or more) and **into** (the next corner follows within 30 m). Tap a corner to see its radius, angle and the speed you actually did. You can override its grade or add a note like "don't cut" or "jump".
4. **Drive with pace notes.** A big colour card shows the next corner, its distance and target speed, plus the corner after it. Notes are read aloud a few seconds before each corner ("left 3 tightens, into right 4"). The target turns red if you're coming in too fast. **Replay lap** plays your recorded lap through drive mode so you can try it from the sofa.
5. **Export**: **GPX** (the track plus every corner and hazard as named waypoints, e.g. "Left 2 tightens", with no numbering; opens in Garmin, OsmAnd, Gaia GPS, Google Earth, and re-imports here with its hazards), KML (colour-coded for Google Earth / My Maps), GeoJSON, or pace notes CSV. Every saved course also has a **GPX** button in the course list. On phones that support it, exports open the share sheet (Save to Files, AirDrop, WhatsApp).

## Settings

- **Surface** sets the grip used for target speeds: tarmac 0.85, hard-packed dirt 0.65, loose gravel 0.55, dry grass 0.45, sand 0.4, wet grass/mud 0.3, snow 0.22.
- **Grip you'll use** (default 80%) is your safety margin. Lower it for a novice, a heavy vehicle or worn tyres.
- **Vehicle top speed**: anything faster is marked **F** (flat).
- **Course type**: auto-detect, loop, or point-to-point stage. **Reverse** analyses the course the other way round.
- **GPS smoothing**: Light for a 10 Hz logger, Normal for a phone, Heavy for poor signal under trees.
- **Straight above radius / Ignore bends under** set how gentle a bend can be before it's ignored.
- **Voice**: Phone default, **American female**, **Indian male**, or any English voice installed on the phone. **Test voice** plays a sample call. Voices come from the phone, so a preset needs a matching voice installed (iPhone: Settings → Accessibility → Spoken Content → Voices; Android: Settings → Text-to-speech → Google → Install voice data). The setting shows which voice is in use.
- **Call corners**: at a set distance before the corner (default 100 m, also used for hazards) or a set time before it. **Say the distance** adds it to each call, e.g. "100 metres, left 3".

While recording or driving the map follows you. Zoom with pinch or the +/− buttons at any time and the zoom is remembered. Drag the map to look around, and tap **Re-centre** to follow again.

## How the rating works

1. GPS fixes with poor reported accuracy, stationary jitter and impossible jumps are dropped.
2. The track is projected to metres, resampled every 1 m and smoothed. The smoothing adapts to how far apart the fixes are, so fast straights logged at 1 Hz become smooth curves while slow hairpins keep their shape.
3. **Curvature** (1/radius) is measured from the change in heading over an 8 m window. Positive curvature means a left turn.
4. A **corner** starts when the radius drops below 150 m and ends when it rises above 250 m or the direction flips (so an S-bend is two corners). Same-direction pieces less than 12 m apart are merged, and bends turning less than 15° are ignored.
5. Each corner's **radius** is the mean of its tightest part, and its **angle** is the total heading change.
6. **Target speed** comes from the cornering limit `v = √(μ × grip% × g × r)`, where μ is the surface grip, g = 9.81 m/s² and r the radius. A 50 m radius on loose gravel at 80% grip gives `√(0.55 × 0.8 × 9.81 × 50) ≈ 14.7 m/s ≈ 53 km/h`, a **3**.

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
- `js/formats.js`: GPX / KML / GeoJSON / CSV / NMEA import and export
- `js/app.js`: map (Leaflet), recording, corner list, settings, drive mode
- `sw.js`: offline cache for the app and any map tiles you've viewed
- `tools/`: synthetic track generator used by the tests and the demo course

## Logo

`assets/` holds the Westlime Motorsport logo as vectors (`westlime-logo.svg` stacked, `westlime-logo-wide.svg` for the app footer) and transparent PNGs for print or social media. The lettering is converted to outlines from Cinzel and Kaushan Script (both SIL Open Font License), so the files don't need any fonts installed.
