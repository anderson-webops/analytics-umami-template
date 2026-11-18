function* tokens(source) {
  let escaped = false
  let bracket = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      yield {
        character,
        index,
        escaped: true,
        bracket,
      }
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[' && !bracket) {
      bracket = true
      yield { character, index, bracket: true }
      continue
    }
    if (character === ']' && bracket) {
      yield { character, index, bracket: true }
      bracket = false
      continue
    }
    yield { character, index, bracket }
  }
  if (escaped) {
    yield {
      character: '\\',
      index: source.length - 1,
      incomplete: true,
      bracket,
    }
  }
}

function closingGroup(source) {
  let depth = 0
  for (const token of tokens(source)) {
    if (token.escaped || token.bracket)
      continue
    if (token.character === '(')
      depth += 1
    if (token.character === ')' && --depth === 0)
      return token.index
  }
  return -1
}

function unwrap(source) {
  while (source.startsWith('(') && (!source.startsWith('(?') || source.startsWith('(?:'))) {
    if (closingGroup(source) !== source.length - 1)
      break
    source = source.slice(source.startsWith('(?:')
      ? 3
      : 1, -1)
  }
  return source
}

function variableQuantity(token, source) {
  if ('*+'.includes(token.character))
    return true
  if (token.character === '?' && source[token.index - 1] !== '(')
    return true
  return token.character === '{' && /^\{\d+,\}/u.test(source.slice(token.index))
}

function inspectOutput(source) {
  const result = {
    unsafe: false,
    alternation: false,
    literalOnly: true,
    branches: [''],
  }
  for (const token of tokens(source)) {
    if (token.bracket || token.incomplete) {
      result.literalOnly = false
      continue
    }
    if (token.escaped) {
      result.literalOnly &&= '\\^$.*+?()[]{}|/-'.includes(token.character)
      result.branches[result.branches.length - 1] += token.character
      continue
    }
    if (variableQuantity(token, source))
      return { ...result, unsafe: true }
    if (token.character === '|') {
      result.alternation = true
      result.branches.push('')
      continue
    }
    result.literalOnly &&= !'(){}.^$'.includes(token.character)
    result.branches[result.branches.length - 1] += token.character
  }
  return result
}

function prefixCollision(branches, flags) {
  return branches.some((branch, index) => {
    const prefix = flags.includes('i')
      ? new RegExp(`^(?:${branch.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')})`, flags)
      : null
    return branches.some((other, otherIndex) => {
      if (index === otherIndex)
        return false
      if (!prefix)
        return other.startsWith(branch)
      prefix.lastIndex = 0
      return prefix.test(other)
    })
  })
}

module.exports = (source, options) => {
  const result = inspectOutput(unwrap(source))
  if (result.unsafe)
    return true
  if (!result.alternation)
    return false
  if (!result.literalOnly || result.branches.some(branch => branch.length === 0))
    return true
  try {
    return prefixCollision(result.branches, options.flags || (options.nocase ? 'i' : ''))
  }
  catch {
    return true
  }
}
