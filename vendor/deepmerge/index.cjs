function isMergeableObject(value) {
  if (!value || typeof value !== 'object') return false;
  const type = Object.prototype.toString.call(value);
  return (
    type !== '[object RegExp]' &&
    type !== '[object Date]' &&
    value.$$typeof !== Symbol.for('react.element')
  );
}

function emptyTarget(value) {
  return Array.isArray(value) ? [] : {};
}

function cloneUnlessOtherwiseSpecified(value, options) {
  return options.clone !== false && options.isMergeableObject(value)
    ? deepmerge(emptyTarget(value), value, options)
    : value;
}

function defaultArrayMerge(target, source, options) {
  return target.concat(source).map(value => cloneUnlessOtherwiseSpecified(value, options));
}

function getMergeFunction(key, options) {
  if (!options.customMerge) return deepmerge;
  const customMerge = options.customMerge(key);
  return typeof customMerge === 'function' ? customMerge : deepmerge;
}

function getKeys(value) {
  const symbols = Object.getOwnPropertySymbols(value).filter(symbol =>
    Object.propertyIsEnumerable.call(value, symbol),
  );
  return Object.keys(value).concat(symbols);
}

function propertyIsOnObject(object, property) {
  try {
    return property in object;
  } catch {
    return false;
  }
}

function isDangerousKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function propertyIsUnsafe(target, key) {
  if (isDangerousKey(key)) return true;
  return (
    propertyIsOnObject(target, key) &&
    !(Object.hasOwn(target, key) && Object.propertyIsEnumerable.call(target, key))
  );
}

function mergeObject(target, source, options) {
  const destination = {};
  if (options.isMergeableObject(target)) {
    for (const key of getKeys(target)) {
      if (!isDangerousKey(key)) {
        destination[key] = cloneUnlessOtherwiseSpecified(target[key], options);
      }
    }
  }
  for (const key of getKeys(source)) {
    if (propertyIsUnsafe(target, key)) continue;
    destination[key] =
      propertyIsOnObject(target, key) && options.isMergeableObject(source[key])
        ? getMergeFunction(key, options)(target[key], source[key], options)
        : cloneUnlessOtherwiseSpecified(source[key], options);
  }
  return destination;
}

function deepmerge(target, source, options = {}) {
  options.arrayMerge ||= defaultArrayMerge;
  options.isMergeableObject ||= isMergeableObject;
  options.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;
  if (Array.isArray(source) !== Array.isArray(target)) {
    return cloneUnlessOtherwiseSpecified(source, options);
  }
  return Array.isArray(source)
    ? options.arrayMerge(target, source, options)
    : mergeObject(target, source, options);
}

deepmerge.all = function mergeAll(values, options) {
  if (!Array.isArray(values)) throw new Error('first argument should be an array');
  return values.reduce((previous, next) => deepmerge(previous, next, options), {});
};

module.exports = deepmerge;
