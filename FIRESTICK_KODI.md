# Firestick + Kodi (Jellyfin front-end on the TV)

Why this exists: the stock Fire TV UI is unusable, and the official Jellyfin Android-TV
app can't show our custom collection "shelves" as home rows (that's a web-client-only
plugin — see the research thread). The plan is to run **Kodi** on the Firestick as the
front-end, pointed at our Jellyfin server, so we can build Netflix-style rows from our
collections. This doc records the device, how we reached it, what's installed, and how to
manage/redo it later.

> Status: **Kodi installed and launching. Jellyfin add-on + skin + shelves NOT yet configured.**
> This was a **one-time manual setup over ADB — it is NOT part of provision.sh / IaC.**
> Nothing here runs automatically; redo by hand using the commands below.

---

## 1. The device

| Property | Value |
|---|---|
| Product | **Fire TV Stick (2nd gen, 2017)** — codename "tank" |
| Model | `AFTT` (`ro.product.name=full_tank`) |
| Serial | `G070QQ1294420JBD` |
| OS | **Fire OS 5.2.9.5 = Android 5.1.1 (API 22)** |
| CPU ABI | **`armeabi-v7a` — 32-bit only** |
| RAM | ~1 GB (underpowered — this is why the stock UI feels awful) |

**Consequences of the old OS/CPU:**
- **Modern Kodi will not install.** Kodi 20/21/22 require Android 7.0+. The newest build
  this stick can run is **Kodi 19.5 "Matrix" (armeabi-v7a)** — that's what we installed.
- **Heavy "Netflix" skins (Titan Bingie, etc.) will stutter.** On this hardware prefer the
  default **Estuary** or a light skin (Arctic Zephyr). Don't fight it with animation-heavy skins.
- If this ever gets frustrating, the real fix is a newer stick (Fire TV Stick 4K Max =
  64-bit, Android 11+) which would run current Kodi + fancy skins smoothly.

---

## 2. Network / how we connect (the troubleshooting saga)

The movie-server (`192.168.1.74`, wired `eno1`) talks to the Firestick over the LAN via ADB.

**Gotchas we hit, so we don't repeat them:**
- The Firestick has **two MACs**: WiFi = `7C:D5:66:AB:E0:7C` (Amazon OUI), **Ethernet adapter
  = `8C:2A:85:CD:7B:A6`** (the adapter's own MAC — looks like an "Apple" OUI, which threw us).
- On **WiFi** it was unreachable: DHCP had handed its `.72` lease to another device
  (IP conflict), and it wasn't in our ARP table. Chasing the WiFi IP was a dead end.
- **Fix: use the wired Ethernet adapter.** Once on Ethernet it came up clean at
  **`192.168.1.77`**, pingable, with ADB port 5555 open. Wired = same L2 segment as the
  server, no WiFi isolation, no conflict.
- **DHCP is dynamic** — the `.77` address can change on reboot. If ADB "can't connect"
  later, the IP moved. Find it again by its **Ethernet MAC** (see §5), or set a **DHCP
  reservation** for `8C:2A:85:CD:7B:A6` on the TELUS router (`192.168.1.254`) to pin it.
- To confirm the current IP on the device itself: **Settings → My Fire TV → About → Network**.

**Prereqs on the Firestick (already enabled):**
- Settings → My Fire TV → **Developer Options → ADB debugging = ON**
- (Developer Options is hidden until you click the device name 7× in About.)
- First ADB connection pops **"Allow USB debugging?"** on the TV → check *Always allow* → OK.

**Prereqs on the server (already done):**
- `sudo apt-get install -y android-tools-adb` (installed at `/usr/lib/android-sdk/platform-tools/adb`).

---

## 3. What we installed

- **Kodi 19.5 "Matrix" (armeabi-v7a)**, package id **`org.xbmc.kodi`**.
- Source: official mirror `https://mirrors.kodi.tv/releases/android/arm/kodi-19.5-Matrix-armeabi-v7a.apk`
- Method: downloaded to the server, `adb install -r`. Verified `Success` + `pm list packages | grep kodi`.

---

## 4. Still TODO (not done yet)

1. **Jellyfin for Kodi add-on** — connect Kodi to the server:
   - Repo source: `https://kodi.jellyfin.org` → zip `repository.jellyfin.kodi.zip`
   - Install add-on: *Kodi Jellyfin Add-ons → Video add-ons → Jellyfin*
   - Server: `http://192.168.1.74:8096`, user `brennan` / pass `brennan`, **Add-on mode**,
     sync Movies + TV. (2-way watched/resume sync; media streams, only metadata syncs locally.)
   - Alternative lighter add-on with no local DB: **JellyCon**.
2. **Skin** — keep **Estuary** (fast) on this hardware, or a light skin. Enable fanart
   backgrounds so Jellyfin backdrops show fullscreen (the look Brennan wants).
3. **Custom shelves as home rows** — after sync, our Jellyfin collections arrive as Kodi
   movie sets / library nodes; wire each as a home-menu **widget** in the skin.
   Note: these are **static** — the controller's 10-min shelf rotation does NOT carry over.

---

## 5. Managing / redoing it later (ADB cheat-sheet)

Run these from the movie-server. Replace the IP if DHCP moved it.

```bash
FIRE=192.168.1.77:5555

# Find the stick if the IP changed (hunt by Ethernet MAC):
for i in $(seq 1 254); do ping -c1 -W1 192.168.1.$i >/dev/null 2>&1 & done; wait
ip neigh | grep -i '8c:2a:85:cd:7b:a6'      # -> shows its current IP

# Connect (accept the prompt on the TV the first time):
adb connect $FIRE
adb devices -l                               # should show 'device', not 'unauthorized'

# Device facts:
adb -s $FIRE shell getprop ro.product.model
adb -s $FIRE shell getprop ro.product.cpu.abi

# See the screen (we drive Kodi this way):
adb -s $FIRE shell screencap -p /sdcard/s.png && adb -s $FIRE pull /sdcard/s.png

# Send remote input (D-pad / select / back / home):
adb -s $FIRE shell input keyevent 22   # right (19 up,20 down,21 left,22 right,23 select,4 back,3 home)
adb -s $FIRE shell input text 'hello'  # type into a focused text field

# Launch / stop / reinstall Kodi:
adb -s $FIRE shell monkey -p org.xbmc.kodi -c android.intent.category.LAUNCHER 1
adb -s $FIRE shell am force-stop org.xbmc.kodi
adb -s $FIRE install -r kodi-19.5.apk

# Kodi userdata lives here on the device (config, add-ons, databases):
#   /sdcard/Android/data/org.xbmc.kodi/files/.kodi/
```

**Reconnect note:** ADB-over-network drops when the stick sleeps/reboots. Just
`adb connect` again (and re-approve on TV if it forgot). Keep the stick awake during setup.

**Full undo:** `adb -s $FIRE uninstall org.xbmc.kodi` — the Jellyfin app + server are untouched.

---

## 6. Server side (unchanged by any of this)

Jellyfin: `http://192.168.1.74:8096` · admin `brennan`/`brennan`. Kodi is just another
client — none of the controller automation, collections sweep, or DLNA config is affected.
