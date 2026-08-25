# CRF probe — raw measurements, 2026-08-01

Scripts: probe-proto.sh (R + detectors), elasticity.sh (degradation ladder).
Run inside the controller container, which has ffmpeg and /data mounted read-only.

## Ten-film probe (8 x 4s samples, scale=min(1280,iw):-2, x265 CRF20 preset medium)
```
Movie Mode ON
SRCBITRATE 1940900
Toy Story (1995) Bluray-1080p.mp4
  src 1920x1080 h264 23.976 fps | probe 1280x720
  probeBitrate = 1516482 bps (1.52 Mbps)
  probeBpp     = 0.06863  (bps / (1280*720*23.976))
  wall 104s for 8 x 4s samples (13.0 s/sample)
  block: 1.0673430 1.1098295 1.5514048 1.3792048 1.3112977 1.2508882 1.4988957 1.1565552
  blur:  5.9695256 4.3402788 6.8294546 7.4305096 5.3648446 5.4619100 4.3442714 4.6606958

SRCBITRATE 3974551
Spirited.Away.2001.1080p.bdrip.x265.5.1.AAC-FINKLEROY.mkv
  src 1920x1080 hevc 23.976 fps | probe 1280x720
  probeBitrate = 1677159 bps (1.68 Mbps)
  probeBpp     = 0.07590  (bps / (1280*720*23.976))
  wall 95s for 8 x 4s samples (11.9 s/sample)
  block: 2.5201441 2.1926799 2.3169799 2.3342662 2.2714773 2.6586228 2.4538233 2.5361151
  blur:  4.2636857 4.4045973 4.4368715 4.4620970 5.1755207 3.8632360 4.0980953 4.1220017

SRCBITRATE 16705006
Casablanca (1943) Bluray-1080p.mkv
  src 1480x1080 h264 23.976 fps | probe 1280x934
  probeBitrate = 4628215 bps (4.63 Mbps)
  probeBpp     = 0.16147  (bps / (1280*934*23.976))
  wall 178s for 8 x 4s samples (22.2 s/sample)
  block: 1.0323982 1.0474295 1.0464382 1.0628749 1.0529451 1.0468729 1.0421719 1.0678410
  blur:  5.8886958 7.4958362 6.1058190 8.5662980 6.1147330 6.9759655 6.7651320 5.1307342

SRCBITRATE 16612937
Lawrence of Arabia (1962) Bluray-1080p.MKV
  src 1920x1080 h264 23.976 fps | probe 1280x720
  probeBitrate = 2015829 bps (2.02 Mbps)
  probeBpp     = 0.09123  (bps / (1280*720*23.976))
  wall 103s for 8 x 4s samples (12.9 s/sample)
  block: 1.8378867 2.0163580 2.3101576 2.3385334 1.8031651 1.6521107 2.3003782 2.2790472
  blur:  5.3958087 4.2760459 4.9086858 4.7781697 4.8133401  5.2792101 6.2262878

SRCBITRATE 10535298
Blade.Runner.2049.2017.1080p.BluRay.x264-SPARKS.mkv
  src 1920x800 h264 23.976 fps | probe 1280x532
  probeBitrate = 803372 bps (0.80 Mbps)
  probeBpp     = 0.04921  (bps / (1280*532*23.976))
  wall 79s for 8 x 4s samples (9.9 s/sample)
  block: 1.1507160 1.0567980 1.0832885 1.1271525 1.0854495 1.1227253 1.2438538 1.3267243
  blur:  9.8748933 6.9144887 7.7822422 5.4056047 6.7080641 7.4031841  10.3026077

SRCBITRATE 2193877
Mad.Max.Fury.Road.2015.1080p.BluRay.x264.YIFY.mp4
  src 1920x800 h264 23.976 fps | probe 1280x532
  probeBitrate = 2157030 bps (2.16 Mbps)
  probeBpp     = 0.13212  (bps / (1280*532*23.976))
  wall 96s for 8 x 4s samples (12.0 s/sample)
  block: 1.1863095 1.1284312 1.2919070 1.4978559 1.0818474 1.2479868 1.0545080 1.0434518
  blur:  8.5896405 6.2782407 5.9362494 4.1410305 6.9219254 4.4553346 5.4357748 6.0436389

SRCBITRATE 3086917
Akira (1988) Bluray-1080p Proper.mp4
  src 1920x1036 h264 23.976 fps | probe 1280x690
  probeBitrate = 2291249 bps (2.29 Mbps)
  probeBpp     = 0.10820  (bps / (1280*690*23.976))
  wall 115s for 8 x 4s samples (14.4 s/sample)
  block: 1.2477896 1.1371485 1.3216653 1.1071434 1.0949742 1.0729463 1.0756717 1.0849123
  blur:  5.4517692 4.7258812 5.2104819 5.5032956 4.9481708 5.1045740 5.2109215 4.8683600

```

## Elasticity ladder (probe= "kbps blockmean blurmean")
```
=== CASABLANCA (grainy B&W, probe 4.63M)  (segment @2400s, 12s, native width 1480)
  ORIGINAL       src=asis     probe=2836.18 1.0651389 8.7120789
  12000kbps      src=12000    probe=2590.15 1.0514941 8.8047276
  6000kbps       src=6000     probe=2270.03 1.0536381 8.9685684
  3000kbps       src=3000     probe=1931.39 1.0674848 9.1543139
  1500kbps       src=1500     probe=1752.70 1.0718455 9.3912846
  750kbps        src=750      probe=1771.26 1.0854514 9.6539852
=== BLADE RUNNER 2049 (clean digital, probe 0.80M)  (segment @3600s, 12s, native width 1920)
  ORIGINAL       src=asis     probe=543.93 1.2307465 6.1854690
  12000kbps      src=12000    probe=547.67 1.3517983 6.2014018
  6000kbps       src=6000     probe=549.79 1.3269444 6.2166384
  3000kbps       src=3000     probe=547.01 1.4160718 6.2902916
  1500kbps       src=1500     probe=524.05 1.4161475 6.4379464
  750kbps        src=750      probe=538.42 1.4383673 6.6637053
```
