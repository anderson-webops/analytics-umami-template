'use strict';

const { MAX_DEPTH } = require('./constants');

module.exports = depth => {
  if (depth > MAX_DEPTH) {
    throw new SyntaxError(`Brace pattern exceeds maximum nesting depth (${MAX_DEPTH})`);
  }
};
