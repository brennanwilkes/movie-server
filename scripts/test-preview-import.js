#!/usr/bin/env node
'use strict';
// Live smoke test for previewManualImport (controller/lib/importer.js) — the Audit swap's preflight.
// Must be run with the *arr container names resolvable, i.e. inside the controller's network:
//
//   docker run --rm --network container:controller \
//     -v /home/brennan/movie-server/controller:/c:ro -w /c \
//     -e RADARR_KEY=... -e SONARR_KEY=... movie-server-controller \
//     node /c/../scripts/test-preview-import.js <folder> [radarr|sonarr] [expectedId]
//
// READ-ONLY: previewManualImport only performs the GET listing. It never posts a command, so this
// cannot import, move or delete anything. That is the whole point of having a preflight.
const { previewManualImport } = require('/c/lib/importer');

(async () => {
  const [folder, app = 'radarr', id] = process.argv.slice(2);
  if (!folder) { console.error('usage: test-preview-import.js <folder> [app] [expectedId]'); process.exit(2); }
  const out = await previewManualImport(app, folder, id != null ? Number(id) : null);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
