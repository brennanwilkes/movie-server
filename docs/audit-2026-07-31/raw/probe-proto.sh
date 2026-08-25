#!/bin/sh
# Throwaway CRF-probe prototype — measurement only, run inside the controller.
# Reads media read-only (/data is mounted :ro) and writes nothing but stdout.
# Usage: probe-proto.sh <file> [nsamples] [seclen] [crf] [preset]
F="$1"; N="${2:-8}"; L="${3:-4}"; CRF="${4:-20}"; PRE="${5:-medium}"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$F" | cut -d. -f1)
[ -z "$DUR" ] && { echo "no duration"; exit 1; }
pv() { ffprobe -v error -select_streams v:0 -show_entries "stream=$1" -of default=nw=1:nk=1 "$F" | head -1; }
W=$(pv width); H=$(pv height); CODEC=$(pv codec_name); FPSR=$(pv avg_frame_rate)
FPS=$(echo "$FPSR" | awk -F/ '{ if (NF==2 && $2>0) printf "%.4f", $1/$2; else printf "%.4f", $1 }')

# Sample window: skip first and last 5%
S=$(( DUR * 5 / 100 )); E=$(( DUR * 95 / 100 )); SPAN=$(( E - S ))

TOTBITS=0; TOTSEC=0; i=0; BLOCKS=""; BLURS=""
START=$(date +%s)
while [ "$i" -lt "$N" ]; do
  T=$(( S + SPAN * i / N ))
  OUT=$(ffmpeg -nostdin -hide_banner -loglevel info \
        -ss "$T" -t "$L" -i "$F" \
        -vf "scale='min(1280,iw)':-2:flags=lanczos,blockdetect,blurdetect" \
        -c:v libx265 -crf "$CRF" -preset "$PRE" -an -f null - 2>&1)
  KBPS=$(echo "$OUT" | sed -n 's/.*encoded \([0-9]*\) frames in [0-9.]*s ([0-9.]* fps), \([0-9.]*\) kb\/s.*/\2/p')
  FRAMES=$(echo "$OUT" | sed -n 's/.*encoded \([0-9]*\) frames in.*/\1/p')
  BLK=$(echo "$OUT" | sed -n 's/.*block mean: \([0-9.]*\).*/\1/p' | tail -1)
  BLR=$(echo "$OUT" | sed -n 's/.*blur mean: \([0-9.]*\).*/\1/p' | tail -1)
  [ -n "$KBPS" ] && TOTBITS=$(echo "$TOTBITS $KBPS $FRAMES $FPS" | awk '{printf "%.0f", $1 + $2*1000*($3/$4)}')
  [ -n "$FRAMES" ] && TOTSEC=$(echo "$TOTSEC $FRAMES $FPS" | awk '{printf "%.3f", $1 + $2/$3}')
  BLOCKS="$BLOCKS $BLK"; BLURS="$BLURS $BLR"
  printf '  sample %d @%ds: %s kb/s  block=%s blur=%s\n' "$i" "$T" "${KBPS:-?}" "${BLK:-?}" "${BLR:-?}"
  i=$(( i + 1 ))
done
WALL=$(( $(date +%s) - START ))

# probe dims = what we actually encoded
PW=$(echo "$W" | awk '{print ($1>1280)?1280:$1}')
PH=$(echo "$W $H $PW" | awk '{printf "%.0f", int($3*$2/$1/2)*2}')

echo "$F" | sed 's#.*/##'
echo "$TOTBITS $TOTSEC $PW $PH $FPS $WALL $N $L $CODEC $W $H" | awk '{
  bps=$1/$2;
  printf "  src %sx%s %s %.3f fps | probe %sx%s\n", $10,$11,$9,$5,$3,$4;
  printf "  probeBitrate = %.0f bps (%.2f Mbps)\n", bps, bps/1e6;
  printf "  probeBpp     = %.5f  (bps / (%d*%d*%.3f))\n", bps/($3*$4*$5), $3,$4,$5;
  printf "  wall %ds for %d x %ds samples (%.1f s/sample)\n", $6,$7,$8,$6/$7;
}'
echo "  block:$BLOCKS"
echo "  blur: $BLURS"
