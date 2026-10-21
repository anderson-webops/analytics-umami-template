'use strict';

const assertDepth = require('./assert-depth');
const { MAX_LENGTH, MAX_EXPANSIONS, MAX_EXPANSION_BYTES } = require('./constants');
const utils = require('./utils');

const assertBudget = ({ count, bytes }) => {
  if (count > MAX_EXPANSIONS) {
    throw new RangeError('expanded array length exceeds aggregate limit');
  }
  if (bytes > MAX_EXPANSION_BYTES) {
    throw new RangeError('expanded output exceeds aggregate byte limit');
  }
};

const reserve = (budget, size) => {
  for (const value of [budget.count, budget.bytes, size.count, size.bytes]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('expanded output budget must contain nonnegative safe integers');
    }
  }
  assertBudget(size);
  const next = { count: budget.count + size.count, bytes: budget.bytes + size.bytes };
  assertBudget(next);
  budget.count = next.count;
  budget.bytes = next.bytes;
};

const measureValues = values => {
  const size = { count: 0, bytes: 0 };
  for (const value of values) {
    if (Array.isArray(value)) {
      reserve(size, measureValues(value));
    } else {
      reserve(size, { count: 1, bytes: Buffer.byteLength(String(value)) });
    }
  }
  return size;
};

const concatenate = (left, right) => {
  const size = {
    count: left.count * right.count,
    bytes: left.bytes * right.count + right.bytes * left.count,
  };
  assertBudget(size);
  return size;
};

const literal = value => ({ count: 1, bytes: Buffer.byteLength(String(value)) });
const empty = () => ({ count: 1, bytes: 0 });
const numeric = value => value !== '' && Number.isInteger(Number(value));

const measureStringified = (node, options, state, depth = 0) => {
  assertDepth(depth);
  if (++state.visits > MAX_LENGTH * 4) {
    throw new RangeError('expanded AST exceeds node budget');
  }
  if (node.nodes !== undefined && !Array.isArray(node.nodes)) {
    throw new TypeError('expanded AST nodes must be arrays');
  }
  if (node.value !== undefined && typeof node.value !== 'string') {
    throw new TypeError('expanded AST values must be strings');
  }
  if (node.value) {
    const escaped = options.escapeInvalid === true && node.invalid === true && utils.isOpenOrClose(node);
    const size = { count: 1, bytes: Buffer.byteLength(String(node.value)) + (escaped ? 1 : 0) };
    assertBudget(size);
    return size;
  }
  const size = { count: 1, bytes: 0 };
  if (node.nodes) {
    for (const child of node.nodes) {
      size.bytes += measureStringified(child, options, state, depth + (child.nodes ? 1 : 0)).bytes;
      assertBudget(size);
    }
  }
  return size;
};

const rangeSize = (node, options, state) => {
  if ((options.transform !== undefined && options.transform !== null && options.transform !== false) || options.toRegex === true) {
    throw new TypeError('range transforms and regex output are not supported in expansion mode');
  }

  const args = node.nodes.filter(child => child.type === 'text').map(child => child.value);
  if (args.length < 2 || args.length > 3 || args.some(value => typeof value !== 'string')) {
    throw new TypeError('expanded range AST must have two or three string arguments');
  }
  const [start, end] = args;

  const requestedStep = args[2] || options.step || 1;
  if (typeof requestedStep === 'object' || typeof requestedStep === 'function') {
    throw new TypeError('non-primitive range steps are not supported in expansion mode');
  }
  if (!numeric(requestedStep)) return measureStringified(node, options, state);
  const step = Number(requestedStep);
  if (!Number.isSafeInteger(step)) {
    throw new RangeError('expanded array length exceeds aggregate limit');
  }

  let first;
  let last;
  let paddedWidth = 0;
  let numericRange = false;
  if (numeric(start) && numeric(end)) {
    numericRange = true;
    first = Number(start);
    last = Number(end);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
      throw new RangeError('expanded array length exceeds aggregate limit');
    }
    const rangeValues = [start, end, requestedStep].map(String);
    const padded = rangeValues.some(value => {
      const unsigned = value.startsWith('-') ? value.slice(1) : value;
      return unsigned !== '0' && unsigned.startsWith('0');
    });
    if (padded) paddedWidth = Math.max(...rangeValues.map(value => value.length));
  } else {
    if ((!numeric(start) && start.length > 1) || (!numeric(end) && end.length > 1)) {
      return measureStringified(node, options, state);
    }
    first = String(start).charCodeAt(0);
    last = String(end).charCodeAt(0);
    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      return measureStringified(node, options, state);
    }
  }

  const distance = BigInt(first) - BigInt(last);
  const magnitude = distance < 0n ? -distance : distance;
  const stepSize = BigInt(Math.max(Math.abs(step), 1));
  const count = magnitude / stepSize + 1n;
  const rangeLimit = options.rangeLimit === undefined ? 1000 : options.rangeLimit;
  const numericLimit = Number(rangeLimit);
  if (rangeLimit !== false && Number.isFinite(numericLimit) && count > BigInt(Math.floor(Math.max(numericLimit, 0)))) {
    throw new RangeError('expanded array length exceeds range limit. Use options.rangeLimit to increase or disable the limit.');
  }
  if (count > BigInt(MAX_EXPANSIONS)) {
    throw new RangeError('expanded array length exceeds aggregate limit');
  }
  let bytes = 0;
  const direction = first <= last ? 1n : -1n;
  for (let index = 0; index < Number(count); index++) {
    const value = Number(BigInt(first) + direction * stepSize * BigInt(index));
    bytes += numericRange
      ? Math.max(paddedWidth, String(value).length)
      : Buffer.byteLength(String.fromCharCode(value));
  }
  const size = { count: Number(count), bytes };
  assertBudget(size);
  return size;
};

const summarize = (node, options, depth = 0, state = { visits: 0 }) => {
  assertDepth(depth);
  if (++state.visits > MAX_LENGTH * 4) {
    throw new RangeError('expanded AST exceeds node budget');
  }
  if (node.nodes !== undefined && !Array.isArray(node.nodes)) {
    throw new TypeError('expanded AST nodes must be arrays');
  }
  if (node.value !== undefined && typeof node.value !== 'string') {
    throw new TypeError('expanded AST values must be strings');
  }
  if (node.invalid || node.dollar) return measureStringified(node, options, state);
  if (node.type === 'brace' && node.nodes.length === 2) return literal('{}');
  if (node.nodes && node.ranges > 0) return rangeSize(node, options, state);
  if (!node.nodes) {
    return node.value && node.type !== 'open' && node.type !== 'close'
      ? literal(node.value)
      : empty();
  }

  let result = empty();
  let alternatives = { count: 0, bytes: 0 };
  let sawComma = false;
  for (let index = 0; index < node.nodes.length; index++) {
    const child = node.nodes[index];
    if (child.value !== undefined && typeof child.value !== 'string') {
      throw new TypeError('expanded AST values must be strings');
    }
    if (child.type === 'comma' && node.type === 'brace') {
      if (index === 1 && node.nodes[0]?.type !== 'open') {
        throw new TypeError('expanded AST comma requires an opening brace');
      }
      sawComma = true;
      reserve(alternatives, result);
      result = empty();
    } else if (child.type === 'close') {
      if (node.type !== 'brace' || index !== node.nodes.length - 1) {
        throw new TypeError('expanded AST close node must end a brace');
      }
    } else {
      if (child.value && child.type !== 'open') {
        result = concatenate(result, literal(child.value));
      } else if (child.nodes) {
        result = concatenate(result, summarize(child, options, depth + 1, state));
      }
    }
  }

  if (node.type === 'brace' && sawComma) {
    reserve(alternatives, result);
    result = alternatives;
  }
  if (node.type === 'brace' && (node.commas >> 0) === 0) {
    result = { count: result.count, bytes: result.bytes + result.count * 2 };
    assertBudget(result);
  }
  return result;
};

module.exports = { assertBudget, concatenate, measureValues, rangeSize, reserve, summarize };
