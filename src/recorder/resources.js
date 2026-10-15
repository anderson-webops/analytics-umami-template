import { isUrlBearingReplayAttribute } from './url.js';

const SAFE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=]+$/i;
const SAFE_PAINT =
  /^(?:#[a-f\d]{3,8}|[a-z]+|url\(#[a-z\d_-]+\)|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i;
const SAFE_ATTRIBUTES = new Set([
  'accept',
  'align',
  'alt',
  'aria-label',
  'autocomplete',
  'autofocus',
  'checked',
  'class',
  'colspan',
  'contenteditable',
  'cx',
  'cy',
  'd',
  'dir',
  'disabled',
  'draggable',
  'fill-opacity',
  'for',
  'height',
  'hidden',
  'id',
  'lang',
  'max',
  'min',
  'multiple',
  'name',
  'open',
  'opacity',
  'pattern',
  'placeholder',
  'points',
  'preserveaspectratio',
  'r',
  'readonly',
  'rel',
  'required',
  'role',
  'rows',
  'rowspan',
  'rx',
  'ry',
  'scope',
  'selected',
  'spellcheck',
  'step',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'stroke-width',
  'tabindex',
  'title',
  'transform',
  'translate',
  'type',
  'value',
  'viewbox',
  'width',
  'wrap',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
]);
const MAX_CSS_LENGTH = 256 * 1024;

function sanitizeCss(value) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_CSS_LENGTH ||
    /[\\/"'@?=]/.test(value) ||
    /(?:url|image|image-set|cross-fade)\s*\(/i.test(value)
  ) {
    return '';
  }

  return value;
}

function sanitizeUnclassifiedText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return /\\|@import|(?:url|image|image-set|cross-fade)\s*\(|\/\s*[^\s]*[{};:]/i.test(value)
    ? ''
    : value;
}

function sanitizeAttributes(value) {
  const safe = {};

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return safe;
  }

  for (const [name, raw] of Object.entries(value)) {
    const normalized = name.toLowerCase();

    if (normalized === 'style' || normalized === '_csstext') {
      if (typeof raw === 'string') {
        safe[name] = sanitizeCss(raw);
      } else if (normalized === 'style' && raw && typeof raw === 'object') {
        safe[name] = Object.fromEntries(
          Object.entries(raw).flatMap(([property, value]) => {
            if (!/^(?:--)?[a-z][a-z\d-]*$/i.test(property)) {
              return [];
            }

            if (value === false) {
              return [[property, false]];
            }

            const sanitized = sanitizeCss(Array.isArray(value) ? value[0] : value);

            return sanitized
              ? [
                  [
                    property,
                    Array.isArray(value) && value[1] === 'important'
                      ? [sanitized, 'important']
                      : sanitized,
                  ],
                ]
              : [];
          }),
        );
      }
    } else if (['src', 'poster', 'rr_dataurl'].includes(normalized)) {
      if (typeof raw === 'string' && raw.length <= MAX_CSS_LENGTH && SAFE_IMAGE.test(raw)) {
        safe[name] = raw;
      }
    } else if (normalized === 'href' || normalized === 'xlink:href') {
      if (typeof raw === 'string' && /^#[a-z\d_-]+$/i.test(raw)) {
        safe[name] = raw;
      }
    } else if (normalized === 'fill' || normalized === 'stroke') {
      if (typeof raw === 'string' && SAFE_PAINT.test(raw)) {
        safe[name] = raw;
      }
    } else if (
      SAFE_ATTRIBUTES.has(normalized) ||
      normalized.startsWith('aria-') ||
      normalized.startsWith('data-')
    ) {
      if (isUrlBearingReplayAttribute(raw)) continue;
      if (
        (typeof raw === 'string' &&
          (!normalized.startsWith('data-') || /^[a-z\d _.-]{0,128}$/i.test(raw))) ||
        typeof raw === 'number' ||
        typeof raw === 'boolean' ||
        raw === null
      ) {
        safe[name] = raw;
      }
    }
  }

  return safe;
}

export function createReplayResourceRedactor() {
  const styleIds = new Set();
  const styleTextIds = new Set();

  function registerStyleNodes(node) {
    if (
      node?.type === 2 &&
      Number.isInteger(node.id) &&
      typeof node.tagName === 'string' &&
      node.tagName.toLowerCase() === 'style'
    ) {
      styleIds.add(node.id);
    }

    if (Array.isArray(node?.childNodes)) {
      node.childNodes.forEach(registerStyleNodes);
    }
  }

  function sanitizeNode(node, inStyle = false) {
    if (!node || typeof node !== 'object') {
      return node;
    }

    const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
    const isStyle = tagName === 'style' || (tagName === 'link' && node.attributes?._cssText);

    if (node.type !== 0 && node.type !== 2) {
      if (inStyle || node.isStyle) {
        styleTextIds.add(node.id);
      }

      return {
        ...node,
        textContent:
          inStyle || node.isStyle
            ? sanitizeCss(node.textContent)
            : sanitizeUnclassifiedText(node.textContent),
      };
    }

    if (isStyle && Number.isInteger(node.id)) {
      styleIds.add(node.id);
    }

    return {
      ...node,
      ...(node.type === 2 && { attributes: sanitizeAttributes(node.attributes) }),
      childNodes: Array.isArray(node.childNodes)
        ? node.childNodes.map(child => sanitizeNode(child, Boolean(isStyle)))
        : [],
    };
  }

  return event => {
    if (!event || typeof event !== 'object') {
      return null;
    }

    if (event.type === 2) {
      styleIds.clear();
      styleTextIds.clear();
      return {
        ...event,
        data: { ...event.data, node: sanitizeNode(event.data?.node) },
      };
    }

    if (event.type !== 3) {
      return [0, 1, 4, 5].includes(event.type) ? event : null;
    }

    const data = event.data;

    if (!data || typeof data !== 'object') {
      return null;
    }

    if (data.source === 0) {
      const adds = Array.isArray(data.adds) ? data.adds : [];
      for (const add of adds) {
        registerStyleNodes(add?.node);
      }
      return {
        ...event,
        data: {
          ...data,
          adds: adds.map(add => ({
            ...add,
            node: sanitizeNode(add.node, styleIds.has(add.parentId)),
          })),
          attributes: Array.isArray(data.attributes)
            ? data.attributes.map(change => ({
                ...change,
                attributes: sanitizeAttributes(change.attributes),
              }))
            : [],
          texts: Array.isArray(data.texts)
            ? data.texts.map(change => ({
                ...change,
                value: styleTextIds.has(change.id)
                  ? sanitizeCss(change.value)
                  : sanitizeUnclassifiedText(change.value),
              }))
            : [],
        },
      };
    }

    if (data.source === 8) {
      return {
        ...event,
        data: {
          ...data,
          adds: Array.isArray(data.adds)
            ? data.adds.map(add => ({ ...add, rule: sanitizeCss(add.rule) }))
            : [],
          ...(typeof data.replace === 'string' && { replace: sanitizeCss(data.replace) }),
          ...(typeof data.replaceSync === 'string' && {
            replaceSync: sanitizeCss(data.replaceSync),
          }),
        },
      };
    }

    if (data.source === 13) {
      return {
        ...event,
        data: {
          ...data,
          ...(data.set && { set: { ...data.set, value: sanitizeCss(data.set.value) } }),
        },
      };
    }

    if (data.source === 15) {
      return {
        ...event,
        data: {
          ...data,
          styles: Array.isArray(data.styles)
            ? data.styles
                .filter(style => style && typeof style === 'object')
                .map(style => ({
                  ...style,
                  rules: Array.isArray(style.rules)
                    ? style.rules.map(rule => ({ ...rule, rule: sanitizeCss(rule.rule) }))
                    : [],
                }))
            : [],
        },
      };
    }

    return event;
  };
}
