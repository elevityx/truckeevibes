// The only DOM builder the widget uses: createElement / createElementNS + textContent + setAttribute from an allowlist.
// No HTML parsing API is used anywhere in the widget (check-no-html and check-widget rule 4 enforce it).
const SVG_NS = 'http://www.w3.org/2000/svg';
const ATTRS = new Set([
  'class', 'type', 'href', 'target', 'rel', 'role', 'tabindex', 'viewBox', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'x', 'y', 'width', 'height', 'rx', 'cx', 'cy', 'r', 'focusable',
]);

export type Attrs = Record<string, string | number | null | undefined | false>;
export type Child = Node | string | null | undefined | false;

function setAttrs(node: Element, attrs: Attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (!ATTRS.has(k) && !k.startsWith('aria-') && !k.startsWith('data-')) throw new TypeError(`tv_attr ${k}`);
    const s = String(v);
    // hrefs come only from safeWebsite, directionsUrl, googleCalendarUrl, safePageUrl or the constant credit URL; all are https.
    if (k === 'href' && !s.startsWith('https://')) continue;
    node.setAttribute(k, s);
  }
}

function append(node: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  setAttrs(node, attrs);
  append(node, children);
  return node;
}

export function svg(tag: 'svg' | 'path' | 'rect' | 'circle', attrs: Attrs = {}, ...children: Child[]): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  setAttrs(node, attrs);
  append(node, children);
  return node;
}

export function on<T extends Event>(node: EventTarget, type: string, fn: (e: T) => void) {
  node.addEventListener(type, fn as EventListener);
}
