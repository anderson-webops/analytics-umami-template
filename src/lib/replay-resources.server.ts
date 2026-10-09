import { transform, transformStyleAttribute } from 'lightningcss';

const MAX_CSS_BYTES = 256 * 1024;
const EMPTY_IMAGE = 'data:,';
const EMPTY_STYLESHEET = 'data:text/css,';
const SAFE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=]+$/i;
const SAFE_SVG_PAINT =
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
const INERT_TAGS = new Set(['base', 'embed', 'meta', 'object', 'script']);

function sanitizeCss(value: unknown, styleAttribute = false): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CSS_BYTES) {
    return '';
  }

  try {
    const code = Buffer.from(value);
    const result = styleAttribute
      ? transformStyleAttribute({ code, analyzeDependencies: true })
      : transform({ filename: 'replay.css', code, analyzeDependencies: { preserveImports: true } });

    if (result.warnings.length) {
      return '';
    }

    let css = Buffer.from(result.code).toString('utf8');

    for (const dependency of Array.isArray(result.dependencies) ? result.dependencies : []) {
      if (dependency.type !== 'url' && dependency.type !== 'import') {
        return '';
      }

      css = css.replaceAll(
        dependency.placeholder,
        dependency.type === 'import' ? EMPTY_STYLESHEET : EMPTY_IMAGE,
      );
    }

    const verified = styleAttribute
      ? transformStyleAttribute({ code: Buffer.from(css), analyzeDependencies: true })
      : transform({
          filename: 'replay.css',
          code: Buffer.from(css),
          analyzeDependencies: { preserveImports: true },
        });

    if (
      verified.warnings.length ||
      (Array.isArray(verified.dependencies) ? verified.dependencies : []).some(
        dependency =>
          (dependency.type !== 'url' && dependency.type !== 'import') ||
          (dependency.url !== EMPTY_IMAGE && dependency.url !== EMPTY_STYLESHEET),
      )
    ) {
      return '';
    }

    return css;
  } catch {
    return '';
  }
}

function sanitizeStyleValue(property: string, value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:--)?[a-z][a-z\d-]*$/i.test(property)) {
    return null;
  }

  const css = sanitizeCss(`${property}: ${value};`, true);
  const separator = css.indexOf(':');

  return separator < 0
    ? null
    : css
        .slice(separator + 1)
        .trim()
        .replace(/;$/, '')
        .trim();
}

function sanitizeStyleMutation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return Object.create(null);
  }

  const safe = Object.create(null);

  for (const [property, raw] of Object.entries(value)) {
    if (raw === false) {
      safe[property] = false;
      continue;
    }

    const priorityValue = Array.isArray(raw) ? raw[0] : raw;
    const sanitized = sanitizeStyleValue(property, priorityValue);

    if (sanitized !== null) {
      safe[property] =
        Array.isArray(raw) && raw[1] === 'important' ? [sanitized, 'important'] : sanitized;
    }
  }

  return safe;
}

function sanitizeAttributes(value: unknown) {
  const safe = Object.create(null);

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return safe;
  }

  for (const [name, raw] of Object.entries(value)) {
    const normalized = name.toLowerCase();

    if (normalized === 'style') {
      safe[name] = typeof raw === 'string' ? sanitizeCss(raw, true) : sanitizeStyleMutation(raw);
    } else if (normalized === '_csstext') {
      safe[name] = sanitizeCss(raw);
    } else if (normalized === 'src' || normalized === 'poster' || normalized === 'rr_dataurl') {
      if (typeof raw === 'string' && raw.length <= MAX_CSS_BYTES && SAFE_IMAGE.test(raw)) {
        safe[name] = raw;
      }
    } else if (normalized === 'href' || normalized === 'xlink:href') {
      if (typeof raw === 'string' && /^#[a-z\d_-]+$/i.test(raw)) {
        safe[name] = raw;
      }
    } else if (normalized === 'fill' || normalized === 'stroke') {
      if (typeof raw === 'string' && SAFE_SVG_PAINT.test(raw)) {
        safe[name] = raw;
      }
    } else if (
      (SAFE_ATTRIBUTES.has(normalized) ||
        normalized.startsWith('aria-') ||
        normalized.startsWith('data-')) &&
      (typeof raw === 'string' ||
        typeof raw === 'number' ||
        typeof raw === 'boolean' ||
        raw === null)
    ) {
      safe[name] = raw;
    }
  }

  return safe;
}

function isRenderedStyleNode(value: any) {
  const tagName = typeof value?.tagName === 'string' ? value.tagName.toLowerCase() : '';

  return (
    tagName === 'style' || (tagName === 'link' && typeof value.attributes?._cssText === 'string')
  );
}

function registerStyleNodes(value: any, styleIds: Set<number>) {
  if (value?.type === 2 && Number.isInteger(value.id) && isRenderedStyleNode(value)) {
    styleIds.add(value.id);
  }

  if (Array.isArray(value?.childNodes)) {
    for (const child of value.childNodes) {
      registerStyleNodes(child, styleIds);
    }
  }
}

function sanitizeNode(
  value: any,
  inStyle: boolean,
  styleIds: Set<number>,
  styleTextIds: Set<number>,
): any {
  const id = Number.isInteger(value?.id) ? value.id : -1;

  if (value?.type !== 0 && value?.type !== 2) {
    if (inStyle || value?.isStyle) {
      styleTextIds.add(id);
    } else {
      styleTextIds.delete(id);
    }

    return {
      ...value,
      id,
      textContent: inStyle || value?.isStyle ? sanitizeCss(value?.textContent) : value?.textContent,
    };
  }

  const tagName = typeof value.tagName === 'string' ? value.tagName.toLowerCase() : 'span';
  const isStyle = isRenderedStyleNode(value);

  if (isStyle) {
    styleIds.add(id);
  } else {
    styleIds.delete(id);
  }

  return {
    ...value,
    id,
    ...(value.type === 2 && {
      tagName: INERT_TAGS.has(tagName) ? 'span' : tagName,
      attributes: INERT_TAGS.has(tagName) ? {} : sanitizeAttributes(value.attributes),
    }),
    childNodes: Array.isArray(value.childNodes)
      ? value.childNodes.map((child: any) => sanitizeNode(child, isStyle, styleIds, styleTextIds))
      : [],
  };
}

function sanitizeStyleSheetRule(value: unknown) {
  const css = sanitizeCss(value);

  return css || ':root {}';
}

export function sanitizeReplayResourceEvents(events: any[]): any[] {
  const styleIds = new Set<number>();
  const styleTextIds = new Set<number>();
  const safeEvents: any[] = [];

  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue;
    }

    if (event.type === 2) {
      if (event.data?.node?.type !== 0 || !Array.isArray(event.data.node.childNodes)) {
        continue;
      }

      styleIds.clear();
      styleTextIds.clear();
      safeEvents.push({
        ...event,
        data: { ...event.data, node: sanitizeNode(event.data.node, false, styleIds, styleTextIds) },
      });
      continue;
    }

    if (event.type === 3) {
      const data = event.data;

      if (!data || typeof data !== 'object') {
        continue;
      }

      if (data.source === 0) {
        const rawAdds = Array.isArray(data.adds) ? data.adds.filter((add: any) => add?.node) : [];

        for (const add of rawAdds) {
          registerStyleNodes(add.node, styleIds);
        }

        const adds = rawAdds.map((add: any) => ({
          ...add,
          node: sanitizeNode(add.node, styleIds.has(add.parentId), styleIds, styleTextIds),
        }));
        const attributes = Array.isArray(data.attributes)
          ? data.attributes.map((mutation: any) => ({
              ...mutation,
              attributes: sanitizeAttributes(mutation?.attributes),
            }))
          : [];
        const texts = Array.isArray(data.texts)
          ? data.texts.map((mutation: any) =>
              styleTextIds.has(mutation?.id)
                ? { ...mutation, value: sanitizeCss(mutation?.value) }
                : mutation,
            )
          : [];

        safeEvents.push({ ...event, data: { ...data, adds, attributes, texts } });
      } else if (data.source === 8) {
        safeEvents.push({
          ...event,
          data: {
            ...data,
            adds: Array.isArray(data.adds)
              ? data.adds.map((add: any) => ({ ...add, rule: sanitizeStyleSheetRule(add?.rule) }))
              : [],
            ...(typeof data.replace === 'string' && { replace: sanitizeCss(data.replace) }),
            ...(typeof data.replaceSync === 'string' && {
              replaceSync: sanitizeCss(data.replaceSync),
            }),
          },
        });
      } else if (data.source === 13) {
        const value = sanitizeStyleValue(data.set?.property, data.set?.value);

        safeEvents.push({
          ...event,
          data: { ...data, ...(data.set && { set: { ...data.set, value: value ?? '' } }) },
        });
      } else if (data.source === 15) {
        safeEvents.push({
          ...event,
          data: {
            ...data,
            styles: Array.isArray(data.styles)
              ? data.styles.map((style: any) => ({
                  ...style,
                  rules: Array.isArray(style?.rules)
                    ? style.rules.map((rule: any) => ({
                        ...rule,
                        rule: sanitizeStyleSheetRule(rule?.rule),
                      }))
                    : [],
                }))
              : [],
          },
        });
      } else if ([1, 2, 3, 4, 5, 6, 7, 11, 12, 14].includes(data.source)) {
        safeEvents.push(event);
      }

      continue;
    }

    if ([0, 1, 4, 5].includes(event.type)) {
      safeEvents.push(event);
    }
  }

  return safeEvents;
}
