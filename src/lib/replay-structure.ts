export const MAX_REPLAY_STRUCTURE_UNITS = 100_000;
const MAX_REPLAY_STRUCTURE_DEPTH = 256;

export function countReplayStructureUnits(
  value: unknown,
  limit = MAX_REPLAY_STRUCTURE_UNITS,
  maxDepth = MAX_REPLAY_STRUCTURE_DEPTH,
) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let units = 0;

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current) {
      return null;
    }
    units += 1;

    if (units > limit || current.depth > maxDepth) {
      return null;
    }

    if (Array.isArray(current.value)) {
      units += current.value.length;

      if (units > limit) {
        return null;
      }

      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    } else if (current.value && typeof current.value === 'object') {
      const entries = Object.entries(current.value);
      units += entries.length;

      if (units > limit) {
        return null;
      }

      for (const [, item] of entries) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }

  return units;
}

export function hasBoundedReplayJsonStructure(
  value: string,
  maxDepth = MAX_REPLAY_STRUCTURE_DEPTH,
) {
  let depth = 0;
  let units = 0;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];

    if (character === '"') {
      let escaped = false;

      for (index += 1; index < value.length; index++) {
        const next = value[index];

        if (escaped) {
          escaped = false;
        } else if (next === '\\') {
          escaped = true;
        } else if (next === '"') {
          break;
        }
      }

      if (index >= value.length) {
        return false;
      }

      let nextIndex = index + 1;

      while (nextIndex < value.length && /\s/.test(value[nextIndex])) {
        nextIndex += 1;
      }

      if (value[nextIndex] === ':') {
        continue;
      }
    } else if (character === '{' || character === '[') {
      units += depth === 0 ? 1 : 2;

      if (units > MAX_REPLAY_STRUCTURE_UNITS || depth > maxDepth) {
        return false;
      }

      depth += 1;
      continue;
    } else if (character === '}' || character === ']') {
      depth -= 1;

      if (depth < 0) {
        return false;
      }

      continue;
    } else if (character === '-' || /[0-9tfn]/.test(character)) {
      while (index + 1 < value.length && !/[\s,}\]]/.test(value[index + 1])) {
        index += 1;
      }
    } else {
      continue;
    }

    units += depth === 0 ? 1 : 2;

    if (units > MAX_REPLAY_STRUCTURE_UNITS || depth > maxDepth) {
      return false;
    }
  }

  return depth === 0;
}
