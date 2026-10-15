// A generation token for admin loads: a load whose answer arrives after a newer load or a mutation began must not paint.

export interface RequestGate {
  begin(): number;
  invalidate(): void;
  isCurrent(t: number): boolean;
}

export function createRequestGate(): RequestGate {
  let n = 0;
  return {
    begin: () => ++n,
    invalidate: () => {
      n++;
    },
    isCurrent: (t) => t === n,
  };
}

/** Runs fetch; calls apply only if no newer begin()/invalidate() happened meanwhile. A stale error is swallowed; a current error rethrows. */
export async function gated<T>(g: RequestGate, fetch: () => Promise<T>, apply: (v: T) => void): Promise<'applied' | 'stale'> {
  const t = g.begin();
  try {
    const v = await fetch();
    if (!g.isCurrent(t)) return 'stale';
    apply(v);
    return 'applied';
  } catch (e) {
    if (!g.isCurrent(t)) return 'stale';
    throw e;
  }
}
