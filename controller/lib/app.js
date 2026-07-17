'use strict';
// Shared Express application instance. Middleware (compression/json/static) is
// applied by server.js BEFORE any route module is required, so requiring this
// module and registering routes at module load is always safe. Owns no state.
const express = require('express');
const app = express();
module.exports = app;
