'use strict';

// Vercel needs an explicit function for this nested endpoint; the server
// keeps the parsing and response policy in one place.
module.exports = require('../_handler');
