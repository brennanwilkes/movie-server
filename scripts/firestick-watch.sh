#!/usr/bin/env bash
# firestick-watch.sh — sample the Fire Stick's memory over adb during a watch session.
#
# Why: 2026-09-29, White Chicks jittered for 80 min and was killed by the kernel's low-memory
# killer. The in-app telemetry only sees the app itself; this sees the WHOLE stick — how much the
# system had left, how much of the app was in zram swap, how fast the LMK was killing things, and
# the app's GPU memory rows — which is what separated "the app leaks" from "the stick is full".
#
# Usage:  scripts/firestick-watch.sh [hours=4] [ip=192.168.1.72]      (Ctrl-C to stop)
#         nohup scripts/firestick-watch.sh 4 >/dev/null 2>&1 &
# Output: /opt/appdata/controller/firestick-watch/<date>.tsv  (~100 KB a night)
#
# Read-only on the stick: dumpsys / cat /proc / logcat -d. It never kills, clears or installs.
# `dumpsys meminfo <pkg>` costs the app a few ms of smaps reading every 30s — invisible at that rate.
set -u
HOURS=${1:-4}
IP=${2:-192.168.1.72}
PKG=org.jellyfin.androidtv.debug
EVERY=30
OUT_DIR=/opt/appdata/controller/firestick-watch
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$(date +%F).tsv"
A=(adb -s "$IP:5555")

adb connect "$IP:5555" >/dev/null 2>&1
[ -s "$OUT" ] || printf 'time\tscreen\tsysAvailMB\tswapUsedMB\tlmkKills\tappPid\tappPssMB\tdalvikMB\tnativeMB\tglMB\tappSwapMB\n' > "$OUT"
echo "firestick-watch: $IP every ${EVERY}s for ${HOURS}h -> $OUT"

end=$(( $(date +%s) + HOURS * 3600 ))
last_kernel_ts=""
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(date +%T)
  if ! "${A[@]}" get-state >/dev/null 2>&1; then
    adb connect "$IP:5555" >/dev/null 2>&1
    printf '%s\tunreachable\n' "$now" >> "$OUT"; sleep "$EVERY"; continue
  fi
  screen=$("${A[@]}" shell dumpsys power 2>/dev/null | awk -F= '/Display Power: state/{print $2}' | tr -d '\r')
  read -r avail swapused < <("${A[@]}" shell cat /proc/meminfo 2>/dev/null | tr -d '\r' |
    awk '/MemAvailable/{a=$2} /SwapTotal/{t=$2} /SwapFree/{f=$2} END{printf "%d %d\n", a/1024, (t-f)/1024}')
  # LMK kills since the previous sample: the kernel buffer is tiny, so count only lines newer
  # than the last timestamp we saw rather than trusting totals.
  kern=$("${A[@]}" logcat -b kernel -d -v time 2>/dev/null | grep "lowmemorykiller: Killing")
  if [ -n "$last_kernel_ts" ]; then
    kills=$(printf '%s\n' "$kern" | awk -v t="$last_kernel_ts" '$1" "$2 > t' | grep -c . )
  else
    kills=0
  fi
  lt=$(printf '%s\n' "$kern" | tail -1 | awk '{print $1" "$2}'); [ -n "$lt" ] && last_kernel_ts=$lt
  pid=$("${A[@]}" shell pidof "$PKG" 2>/dev/null | tr -d '\r')
  [ -z "$pid" ] && pid=$("${A[@]}" shell ps 2>/dev/null | awk -v p="$PKG" '$NF==p{print $2}' | tr -d '\r')
  if [ -n "$pid" ]; then
    # Columns: name... PssTotal PrivDirty PrivClean SwapPssDirty ...  (Fire OS 5 layout)
    read -r pss dalvik native gl aswap < <("${A[@]}" shell dumpsys meminfo "$PKG" 2>/dev/null | tr -d '\r' | awk '
      /^ *Native Heap /{n=$3} /^ *Dalvik Heap /{d=$3}
      /mtrack/{g+=$3} /Gfx dev/{g+=$3}
      /^ *TOTAL /{t=$2; s=$5}
      END{printf "%d %d %d %d %d\n", t/1024, d/1024, n/1024, g/1024, s/1024}')
  else
    pss=; dalvik=; native=; gl=; aswap=
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "${screen:-?}" "$avail" "$swapused" "$kills" \
    "${pid:--}" "$pss" "$dalvik" "$native" "$gl" "$aswap" >> "$OUT"
  sleep "$EVERY"
done
echo "firestick-watch: done"
