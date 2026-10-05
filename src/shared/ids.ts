export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** FNV-1a, 32-bit, as 8 hex digits. Used for cache keys only. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
