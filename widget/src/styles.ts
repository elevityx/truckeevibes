// One constructable stylesheet shared by every shadow root; a <style> element (textContent) where constructable sheets are missing.
import css from './styles/widget.css?raw';

let shared: CSSStyleSheet | null | undefined;

/** Applies the widget stylesheet to `root`; returns a <style> element the caller must keep as the root's first child, or null. */
export function applyStyles(root: ShadowRoot): HTMLStyleElement | null {
  if (shared === undefined) {
    try {
      const s = new CSSStyleSheet();
      s.replaceSync(css);
      shared = s;
    } catch {
      shared = null;
    }
  }
  if (shared && Array.isArray(root.adoptedStyleSheets)) {
    root.adoptedStyleSheets = [shared];
    return null;
  }
  const st = document.createElement('style');
  st.textContent = css;
  return st;
}
