#!/bin/sh
# ELASTICITY TEST — the decisive check on the probe's failure mode.
#
# Question: when a source has ALREADY been compressed, does the probe notice, or does it just
# report "easy content" and flatter the file?
#
# Method: take one clean segment, deliberately degrade it to a ladder of bitrates, then probe
# each degraded copy. If probeBitrate stays flat as the source is wrecked, the probe is honest
# and R tracks real quality. If probeBitrate falls in step with the source, R is blind.
#
# Reads media read-only; writes only to the container's /tmp.
SRC="$1"; T="${2:-2000}"; LEN="${3:-12}"; LABEL="$4"
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nw=1:nk=1 "$SRC" | head -1)
SCALE="scale='min(1280,iw)':-2:flags=lanczos"

probe_of() {  # $1 = file -> prints "kbps block blur"
  O=$(ffmpeg -nostdin -hide_banner -loglevel info -i "$1" \
      -vf "$SCALE,blockdetect,blurdetect" -c:v libx265 -crf 20 -preset medium -an -f null - 2>&1)
  K=$(echo "$O" | sed -n 's/.*encoded [0-9]* frames in [0-9.]*s ([0-9.]* fps), \([0-9.]*\) kb\/s.*/\1/p')
  B=$(echo "$O" | sed -n 's/.*block mean: \([0-9.]*\).*/\1/p' | tail -1)
  L=$(echo "$O" | sed -n 's/.*blur mean: \([0-9.]*\).*/\1/p' | tail -1)
  echo "${K:-?} ${B:-?} ${L:-?}"
}

echo "=== $LABEL  (segment @${T}s, ${LEN}s, native width $W)"
# The undegraded reference segment, remuxed losslessly so every rung probes identical content.
ffmpeg -nostdin -v error -ss "$T" -t "$LEN" -i "$SRC" -c:v copy -an -y /tmp/el_ref.mkv 2>/dev/null \
  || ffmpeg -nostdin -v error -ss "$T" -t "$LEN" -i "$SRC" -c:v libx264 -qp 0 -preset ultrafast -an -y /tmp/el_ref.mkv
REF=$(probe_of /tmp/el_ref.mkv)
printf '  %-14s src=%-8s probe=%s\n' "ORIGINAL" "asis" "$REF"

for BR in 12000 6000 3000 1500 750; do
  ffmpeg -nostdin -v error -i /tmp/el_ref.mkv -c:v libx264 -b:v ${BR}k -maxrate ${BR}k \
         -bufsize $((BR*2))k -preset medium -an -y /tmp/el_${BR}.mkv
  P=$(probe_of /tmp/el_${BR}.mkv)
  printf '  %-14s src=%-8s probe=%s\n' "${BR}kbps" "${BR}" "$P"
  rm -f /tmp/el_${BR}.mkv
done
rm -f /tmp/el_ref.mkv
