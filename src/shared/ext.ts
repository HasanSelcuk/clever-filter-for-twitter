/**
 * The extension API. Firefox exposes `browser`, Chrome exposes `chrome`; both return promises
 * in Manifest V3, and Firefox also answers to `chrome`.
 */
export const ext: typeof chrome =
  (globalThis as unknown as { browser?: typeof chrome }).browser ?? globalThis.chrome;
