// Per-root stylesheet bookkeeping: adoptedStyleSheets where supported, else one <style> element kept per root.
import { applyStyles } from './styles';

const styles = new WeakMap<ShadowRoot, HTMLStyleElement | null>();

export function styleFor(root: ShadowRoot): HTMLStyleElement | null {
  if (!styles.has(root)) styles.set(root, applyStyles(root));
  return styles.get(root) ?? null;
}
