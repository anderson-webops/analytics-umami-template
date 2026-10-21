const STRUCTURAL_FIELDS = new Set([
  'type',
  'timestamp',
  'data',
  'source',
  'node',
  'id',
  'rootId',
  'parentId',
  'nextId',
  'previousId',
  'childNodes',
  'tagName',
  'isSVG',
  'isShadow',
  'attributes',
  'textContent',
  'adds',
  'removes',
  'texts',
  'value',
  'text',
  'href',
  'payload',
  'x',
  'y',
  'width',
  'height',
  'left',
  'top',
  'scrollLeft',
  'scrollTop',
  'positions',
  'timeOffset',
  'isTouch',
  'index',
  'initialOffset',
]);

const SAFE_TAGS = new Set([
  'html',
  'head',
  'body',
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'img',
  'button',
  'input',
  'form',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'label',
  'textarea',
  'select',
  'option',
  'svg',
  'path',
  'g',
  'rect',
  'circle',
  'style',
  'link',
  'br',
  'hr',
]);

function maskValue(value, field) {
  if (field === 'tagName') {
    return typeof value === 'string' && SAFE_TAGS.has(value.toLowerCase())
      ? value.toLowerCase()
      : 'div';
  }

  if (field === 'attributes') {
    return {};
  }

  if (field === 'value' || field === 'text' || field === 'textContent') {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(item => maskValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => STRUCTURAL_FIELDS.has(key))
        .map(([key, child]) => [key, maskValue(child, key)]),
    );
  }

  if (typeof value === 'string') {
    return '';
  }

  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}

export function maskStrictReplayEvents(events) {
  return events.map(event => maskValue(event));
}
