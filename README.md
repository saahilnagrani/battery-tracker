# battery-tracker

A small offline-first web app for tracking the battery on a Galaxy S24 Ultra (it works on any
Android phone running Chrome). It doesn't need a build step or a server, and your data stays on your phone.

## What it shows

- Current level and charging state, with an estimate of time to empty or time to full
- Level history chart (24h / 7d / 30d), with charging periods shaded and the 20–80% band marked
- Average drain rate (%/h), charges per day, equivalent full cycles
- Share of time above 80% and below 20%, the two ranges that wear lithium cells fastest
- Peak temperature and time at 40°C or above (needs Termux data, since browsers don't expose temperature)
- Recent charge and drain sessions with their rates
- A manual health log for the cycle count or Samsung Members diagnostics results

## Setup

1. **Host it.** Push to `main` and enable GitHub Pages (Settings → Pages → Source: *GitHub Actions*).
   The included workflow runs the tests and deploys. Any static HTTPS host works too.
   The Battery API needs HTTPS.
2. **Install it.** Open the site in Chrome on the phone → ⋮ → *Add to home screen*.
3. **Use it.** The app logs a reading every time the level changes or charging starts or stops, and every 5 minutes
   while it's open.

### Logging in the background (recommended)

A web page can't run when it's closed, so the app has gaps. To log around the clock:

1. Install **Termux** and **Termux:API** from F-Droid, then:
   ```sh
   pkg install termux-api jq
   termux-setup-storage
   curl -O https://raw.githubusercontent.com/<you>/battery-tracker/main/termux/battery-logger.sh
   chmod +x battery-logger.sh
   ./battery-logger.sh schedule      # logs every 15 min to Documents/battery-log.csv
   ```
2. Exclude Termux from battery optimization (Settings → Apps → Termux → Battery → *Unrestricted*),
   or One UI will kill the job.
3. Every so often, open the app → **Import CSV / JSON** → pick `Documents/battery-log.csv`.
   Readings that are already stored are skipped.

## Data

Everything is stored in the browser's `localStorage` on that device. Use **Export JSON** for
backups. Importing that file restores readings and health log entries.

## Development

```sh
python3 -m http.server   # then open http://localhost:8000
node --test              # unit tests for the analysis/parsing code
```
