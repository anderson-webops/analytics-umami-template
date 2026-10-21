'use strict';

const fill = require('fill-range');
const assertDepth = require('./assert-depth');
const { MAX_LENGTH } = require('./constants');
const { assertBudget, rangeSize } = require('./expansion-budget');
const utils = require('./utils');

const compile = (ast, options = {}) => {
  const budget = { bytes: 0, visits: 0 };
  const account = value => {
    budget.bytes += Buffer.byteLength(value);
    assertBudget({ count: 1, bytes: budget.bytes });
    return value;
  };
  const walk = (node, parent = {}, depth = 0) => {
    assertDepth(depth);
    if (++budget.visits > MAX_LENGTH * 4) {
      throw new RangeError('compiled AST exceeds node budget');
    }
    if (node.value !== undefined && typeof node.value !== 'string') {
      throw new TypeError('compiled AST values must be strings');
    }
    const invalidBlock = utils.isInvalidBrace(parent);
    const invalidNode = node.invalid === true && options.escapeInvalid === true;
    const invalid = invalidBlock === true || invalidNode === true;
    const prefix = options.escapeInvalid === true ? '\\' : '';
    let output = '';

    if (node.isOpen === true) {
      return account(prefix + node.value);
    }

    if (node.isClose === true) {
      return account(prefix + node.value);
    }

    if (node.type === 'open') {
      return account(invalid ? prefix + node.value : '(');
    }

    if (node.type === 'close') {
      return account(invalid ? prefix + node.value : ')');
    }

    if (node.type === 'comma') {
      return account(node.prev.type === 'comma' ? '' : invalid ? node.value : '|');
    }

    if (node.value) {
      return account(node.value);
    }

    if (node.nodes && node.ranges > 0) {
      if (!Array.isArray(node.nodes) || node.nodes.length > MAX_LENGTH * 4) {
        throw new RangeError('compiled AST exceeds node budget');
      }
      const rangeValues = node.nodes.filter(child => child.type === 'text').map(child => child.value);
      const requestedStep = rangeValues[2] || options.step || 1;
      if (typeof requestedStep === 'object' || typeof requestedStep === 'function' || Math.max(Math.abs(Number(requestedStep)), 1) !== 1) {
        if (options.transform && !rangeValues.slice(0, 2).every(value => value !== '' && Number.isInteger(Number(value)))) {
          throw new TypeError('range transforms are not supported for materialized compiled letter ranges');
        }
        rangeSize(node, { ...options, transform: undefined, toRegex: false, rangeLimit: false }, { visits: 0 });
      }
      const args = utils.reduce(node.nodes);
      const range = fill(...args, { ...options, wrap: false, toRegex: true, strictZeros: true });

      if (range.length !== 0) {
        return account(args.length > 1 && range.length > 1 ? `(${range})` : range);
      }
    }

    if (node.nodes) {
      for (const child of node.nodes) {
        output += walk(child, node, depth + (child.nodes ? 1 : 0));
      }
    }

    return output;
  };

  return walk(ast);
};

module.exports = compile;
