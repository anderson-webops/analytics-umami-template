'use strict';

const assertDepth = require('./assert-depth');
const { MAX_LENGTH } = require('./constants');
const { assertBudget } = require('./expansion-budget');
const utils = require('./utils');

module.exports = (ast, options = {}) => {
  const budget = { bytes: 0, visits: 0 };
  const account = value => {
    budget.bytes += Buffer.byteLength(value);
    assertBudget({ count: 1, bytes: budget.bytes });
    return value;
  };
  const stringify = (node, parent = {}, depth = 0) => {
    assertDepth(depth);
    if (++budget.visits > MAX_LENGTH * 4) {
      throw new RangeError('stringified AST exceeds node budget');
    }
    if (node.value !== undefined && typeof node.value !== 'string') {
      throw new TypeError('stringified AST values must be strings');
    }
    const invalidBlock = options.escapeInvalid && utils.isInvalidBrace(parent);
    const invalidNode = node.invalid === true && options.escapeInvalid === true;
    let output = '';

    if (node.value) {
      if ((invalidBlock || invalidNode) && utils.isOpenOrClose(node)) {
        return account('\\' + node.value);
      }
      return account(node.value);
    }

    if (node.nodes) {
      for (const child of node.nodes) {
        output += stringify(child, undefined, depth + (child.nodes ? 1 : 0));
      }
    }
    return output;
  };

  return stringify(ast);
};
