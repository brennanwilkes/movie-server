'use strict';
// The device-compatibility severity rule. Brennan, 2026-07-30: "We shouldnt offer upgrades that are
// significant downgrades like device compat. Slight device compatibility downgrade (ps4 green to
// orange, web green to orange for example is OK) but nuc green to red is not."
//
// Worth its own suite because the refusal itself lives inside verifyRow, behind a live indexer
// search — so devNuc, the mapping it hinges on, is the only part that can be pinned cheaply. If this
// drifts from devicesFor() in web/js/audit.js, the UI paints a red NUC pill on a candidate the
// server was happy to offer, which is exactly the disagreement the shared helper exists to prevent.
const { devNuc } = require('../controller/lib/audit');

let pass = 0; let fail = 0;
const ok = (c, why) => { if (c) pass++; else { fail++; console.log(`FAIL  ${why}`); } };

// Tier 3 is "10-bit, or depth unverified" — beyond the Iris 540's hardware decoder.
ok(devNuc(1) === 'ok', 'tier 1 (H.264 8-bit) hardware-decodes');
ok(devNuc(2) === 'ok', 'tier 2 (HEVC 8-bit) hardware-decodes');
ok(devNuc(3) === 'no', 'tier 3 (10-bit / unverified) does NOT — software decode');
ok(devNuc(4) === 'no', 'anything above tier 3 is also refused');

// The refusal predicate as the candidate filter applies it: current ok AND candidate no.
const refuses = (curTier, candTier) => devNuc(curTier) === 'ok' && devNuc(candTier) === 'no';

// MUST REFUSE — the case Brennan named. A fine copy replaced by one the NUC cannot decode.
ok(refuses(1, 3), 'H.264 8-bit → 10-bit is refused (NUC green → red)');
ok(refuses(2, 3), 'HEVC 8-bit → 10-bit is refused (NUC green → red)');

// MUST NOT REFUSE — these are the "slight" downgrades that stay labelled tradeoffs, plus every
// improvement. Over-refusing here would empty the Upgrade tab, so the negatives matter more.
ok(!refuses(1, 2), 'H.264 → HEVC 8-bit allowed: PS4/Web go amber, the NUC stays green');
ok(!refuses(1, 1), 'lateral H.264 allowed');
ok(!refuses(2, 2), 'lateral HEVC 8-bit allowed');
ok(!refuses(3, 3), 'already 10-bit → 10-bit is lateral, NOT a new regression');
ok(!refuses(3, 1), 'ESCAPING 10-bit must always be allowed — this is the fix, not the problem');
ok(!refuses(3, 2), '10-bit → HEVC 8-bit is an improvement for the NUC');
ok(!refuses(2, 1), 'HEVC 8-bit → H.264 allowed');

// A library ALREADY in the bad state must never be frozen there: every candidate that keeps it at
// tier 3 is permitted, so the row can still be acted on.
ok(!refuses(3, 4), 'a bad current copy does not block a lateral move');

console.log(`\nnuc-compat: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
