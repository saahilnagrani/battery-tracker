#!/data/data/com.termux/files/usr/bin/bash
# Appends one battery reading to a CSV that the Battery Tracker app can import.
#
# Requires: the Termux and Termux:API apps, plus `pkg install termux-api jq`.
#
#   ./battery-logger.sh            log one reading
#   ./battery-logger.sh schedule   log every 15 minutes in the background (survives app close)
#   ./battery-logger.sh unschedule stop background logging
set -euo pipefail

OUT="${BATTERY_LOG:-$HOME/storage/shared/Documents/battery-log.csv}"
SELF="$(realpath "$0")"

case "${1:-}" in
  schedule)
    termux-job-scheduler --job-id 4242 --period-ms 900000 --persisted true --script "$SELF"
    echo "Logging every 15 min to $OUT"
    exit 0 ;;
  unschedule)
    termux-job-scheduler --cancel --job-id 4242
    exit 0 ;;
esac

mkdir -p "$(dirname "$OUT")"
[ -s "$OUT" ] || echo "timestamp,percentage,status,plugged,temperature,current,health" > "$OUT"

termux-battery-status | jq -r --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '[$ts, .percentage, .status, .plugged, .temperature, .current, .health] | @csv' \
  | tr -d '"' >> "$OUT"
