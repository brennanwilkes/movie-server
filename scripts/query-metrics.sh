#!/usr/bin/env bash
# ── Metrics & event log query tool ──────────────────────────────────
# Reads from /config/metrics/*.jsonl directly (not via the API).
# Usage:
#   ./scripts/query-metrics.sh                        # list available streams
#   ./scripts/query-metrics.sh system                 # last 50 system points
#   ./scripts/query-metrics.sh system --last 200      # last 200 points
#   ./scripts/query-metrics.sh system --since 3600    # last hour
#   ./scripts/query-metrics.sh events --type grab      # grab events only
#   ./scripts/query-metrics.sh events --type search_outcome  # search result summaries
#   ./scripts/query-metrics.sh events --type svc_down  # service outages
#   ./scripts/query-metrics.sh events --stats          # event type counts
#   ./scripts/query-metrics.sh system --stats cpu      # cpu stats (min/max/avg)
#   ./scripts/query-metrics.sh system --chart cpu      # ASCII sparkline
#   ./scripts/query-metrics.sh dl --chart spB          # download speed chart

set -euo pipefail
METRICS_DIR="/opt/appdata/controller/metrics"
[[ -d "$METRICS_DIR" ]] || { echo "Metrics directory $METRICS_DIR not found (is the controller running?)"; exit 1; }
JQ="jq -r"

help() {
  grep '^# Usage' "$0" | head -5
  echo
  echo "Streams: $(ls "$METRICS_DIR" 2>/dev/null | tr '\n' ' ' || echo '(no metrics yet)')"
  exit 0
}

stream="$1"; shift || help
[[ "$stream" == "-h" || "$stream" == "--help" ]] && help

# List available streams
if [[ ! -d "$METRICS_DIR/$stream" ]]; then
  echo "Available streams:"
  ls "$METRICS_DIR" 2>/dev/null || echo "(no metrics directory found at $METRICS_DIR)"
  exit 1
fi

last=50
since=""
type_filter=""
do_stats=""
stat_field=""
do_chart=""
chart_field=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --last) last="$2"; shift 2 ;;
    --since) since="$2"; shift 2 ;;
    --type) type_filter="$2"; shift 2 ;;
    --stats) do_stats=1; stat_field="$2"; shift 2 ;;
    --chart) do_chart=1; chart_field="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

files=()
if [[ -n "$since" ]]; then
  # Find files from since seconds ago
  cutoff=$(date -d "@$(( $(date +%s) - since ))" +%Y-%m-%d 2>/dev/null || echo "yesterday")
  for f in "$METRICS_DIR/$stream"/*.jsonl; do
    [[ -f "$f" ]] || continue
    base=$(basename "$f" .jsonl)
    if [[ "$base" > "$cutoff" || "$base" == "$cutoff" ]]; then
      files+=("$f")
    fi
  done
else
  # Last N files
  files=($(ls -t "$METRICS_DIR/$stream"/*.jsonl 2>/dev/null | head -5))
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No data for stream '$stream'"
  exit 0
fi

# ── Stats mode ──
if [[ -n "$do_stats" ]]; then
  if [[ -z "$stat_field" ]]; then
    echo "Usage: --stats <field>  (e.g. cpu, mem, temp, spB, dl)"
    exit 1
  fi
  $JQ "select(.$stat_field != null) | .$stat_field" "${files[@]}" |
    awk '{
      if (NR==1) { min=max=sum=$1 }
      sum+=$1; if($1>max) max=$1; if($1<min) min=$1; n++
    } END {
      printf "Field: %s\n", "'"$stat_field"'"
      printf "Points: %d\n", n
      printf "Min:    %.1f\n", min
      printf "Max:    %.1f\n", max
      printf "Avg:    %.1f\n", sum/n
      printf "Range:  %.1f\n", max-min
    }'
  exit 0
fi

# ── Chart mode (ASCII sparkline) ──
if [[ -n "$do_chart" ]]; then
  if [[ -z "$chart_field" ]]; then
    echo "Usage: --chart <field>"
    exit 1
  fi
  values=$($JQ "select(.$chart_field != null) | .$chart_field" "${files[@]}" | tail -$last)
  [[ -z "$values" ]] && { echo "No data for $chart_field"; exit 0; }
  width=60
  min=$(echo "$values" | awk 'NR==1{min=$1} $1<min{min=$1} END{print min}')
  max=$(echo "$values" | awk 'NR==1{max=$1} $1>max{max=$1} END{print max}')
  range=$(echo "$max - $min" | bc 2>/dev/null || echo "1")
  [[ $(echo "$range == 0" | bc) -eq 1 ]] && range=1
  echo "Sparkline: $chart_field (min=$min max=$max last $last points)"
  echo "$values" | while read v; do
    bar=$(echo "scale=0; ($v - $min) * $width / $range" | bc 2>/dev/null || echo "0")
    printf "%.0f %s\n" "$v" "$(printf '█%.0s' $(seq 1 $bar 2>/dev/null || seq 1 $(( bar > 0 ? bar : 1 )) 2>/dev/null))"
  done | head -$last
  exit 0
fi

# ── Default: show data points ──
if [[ -n "$type_filter" ]]; then
  $JQ "select(.e == \"$type_filter\") | [.t, .e, (.ti // \"\"), (.ap // \"\"), (.kind // .reason // .reasonClass // \"\"), (.mode // \"\"), (.summary // .error // (if .best then (.best + \" (\" + ((.seeders // \"\")|tostring) + \"se, \" + ((.upstreamHealthy // \"\")|tostring) + \" upstream)\") else \"\" end) // \"\"), ((.queries // .fails // \"\")|tostring), ((.hits // \"\")|tostring), ((.errors // \"\")|tostring), ((.indexers // []) | join(\"|\")), ((.indexerErrors // []) | map((.indexer // \"\") + \":\" + (.reason // \"\")) | join(\"|\"))] | @tsv" "${files[@]}" |
    awk -F'\t' '{ cmd="date -d @"$1" +%H:%M:%S"; cmd | getline d; close(cmd); print d, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 }' |
    tail -"$last"
else
  # Show raw JSON lines, one per line with timestamp
  for f in "${files[@]}"; do
    basename "$f" .jsonl
    if [[ "$stream" == "events" ]]; then
      $JQ '[.t, .e, (.ti // ""), (.ap // ""), (.kind // .reason // .reasonClass // ""), (.mode // ""), (.summary // .error // (if .best then (.best + " (" + ((.seeders // "")|tostring) + "se, " + ((.upstreamHealthy // "")|tostring) + " upstream)") else "" end) // ""), ((.queries // .fails // "")|tostring), ((.hits // "")|tostring), ((.errors // "")|tostring), ((.indexers // []) | join("|")), ((.indexerErrors // []) | map((.indexer // "") + ":" + (.reason // "")) | join("|"))] | @tsv' "$f" 2>/dev/null |
        awk -F'\t' '{ cmd="date -d @"$1" +%H:%M:%S"; cmd | getline d; close(cmd); print d, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 }' |
        tail -"$last" | head -"$last"
    else
      $JQ -c '.' "$f" 2>/dev/null | tail -"$last"
    fi
  done
fi
