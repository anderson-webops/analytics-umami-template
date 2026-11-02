const modern = require('minimatch-modern');
const legacy = modern.minimatch;

Object.assign(legacy, modern);

module.exports = legacy;
