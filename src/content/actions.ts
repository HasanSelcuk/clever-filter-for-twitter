import { ext } from '../shared/ext';
import type { ReserveResult } from '../shared/messages';
import type { Settings } from '../shared/types';
import { SEL } from './dom';

export type AutoAction = 'like' | 'bookmark';

interface Pending {
  postId: string;
  kind: AutoAction;
  ruleName: string;
  seenSince: number | null;
}

export interface ActionHost {
  settings(): Settings;
  /** The cell currently showing a post, if it is in the page. */
  findCell(postId: string): HTMLElement | null;
  reserve(kind: AutoAction): Promise<ReserveResult>;
  release(kind: AutoAction): void;
  done(cell: HTMLElement, kind: AutoAction, ruleName: string): void;
  log(message: string): void;
}

const ACTED_KEY = 'acted';
const ACTED_MAX = 5000;
const VISIBLE_RATIO = 0.6;

/** Share of a cell inside the viewport, measured against the smaller of the two heights. */
export function visibleRatio(rect: { top: number; bottom: number; height: number }, viewport: number): number {
  if (rect.height <= 0) return 0;
  const overlap = Math.min(rect.bottom, viewport) - Math.max(rect.top, 0);
  return Math.max(0, overlap) / Math.min(rect.height, viewport);
}

/**
 * Likes and bookmarks posts the way a person would: only a post that has stayed on screen for a
 * moment, one at a time, with a pause between two actions, and never the same post twice.
 */
export class ActionRunner {
  private pending = new Map<string, Pending>();
  private acted = new Set<string>();
  private loaded: Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastActionAt = 0;
  private stopReason: string | null = null;

  constructor(private host: ActionHost) {
    this.loaded = ext.storage.local.get(ACTED_KEY).then((r) => {
      for (const key of (r[ACTED_KEY] as string[] | undefined) ?? []) this.acted.add(key);
    });
  }

  want(postId: string, kind: AutoAction, ruleName: string): void {
    const key = `${kind}:${postId}`;
    if (this.acted.has(key) || this.pending.has(key)) return;
    this.pending.set(key, { postId, kind, ruleName, seenSince: null });
    this.start();
  }

  /** Drops queued actions that rules no longer ask for. */
  keepOnly(keys: Set<string>): void {
    for (const key of this.pending.keys()) if (!keys.has(key)) this.pending.delete(key);
  }

  clear(): void {
    this.pending.clear();
  }

  private start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 250);
  }

  private async tick(): Promise<void> {
    if (this.pending.size === 0) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.busy || document.hidden) return;
    await this.loaded;
    const s = this.host.settings().actions;
    const now = Date.now();
    let ready: Pending | null = null;
    for (const p of this.pending.values()) {
      const cell = this.host.findCell(p.postId);
      const onScreen = cell !== null && visibleRatio(cell.getBoundingClientRect(), innerHeight) >= VISIBLE_RATIO;
      if (!onScreen) {
        p.seenSince = null;
        continue;
      }
      p.seenSince ??= now;
      if (!ready && now - p.seenSince >= s.dwellSeconds * 1000) ready = p;
    }
    if (!ready || now - this.lastActionAt < s.gapSeconds * 1000) return;
    this.busy = true;
    try {
      await this.run(ready);
    } finally {
      this.busy = false;
    }
  }

  private async run(p: Pending): Promise<void> {
    const key = `${p.kind}:${p.postId}`;
    const cell = this.host.findCell(p.postId);
    const article = cell?.querySelector(SEL.tweet);
    if (!cell || !article) return;
    const [doSel, doneSel] = p.kind === 'like' ? [SEL.like, SEL.unlike] : [SEL.bookmark, SEL.removeBookmark];
    if (article.querySelector(doneSel)) {
      this.pending.delete(key);
      await this.remember(key);
      return;
    }
    const button = article.querySelector<HTMLElement>(doSel);
    if (!button) {
      // The bookmark button is missing on narrow layouts; there is nothing to press.
      this.pending.delete(key);
      return;
    }
    const permit = await this.host.reserve(p.kind);
    if (!permit.allowed) {
      if (this.stopReason !== permit.reason) this.host.log(permit.reason);
      this.stopReason = permit.reason;
      this.pending.delete(key);
      return;
    }
    this.stopReason = null;
    this.lastActionAt = Date.now() + Math.random() * 1500;
    button.click();
    this.pending.delete(key);
    await new Promise((r) => setTimeout(r, 1200));
    const confirmed = this.host.findCell(p.postId)?.querySelector(`${SEL.tweet} ${doneSel}`) != null;
    if (confirmed) {
      await this.remember(key);
      this.host.done(cell, p.kind, p.ruleName);
    } else {
      this.host.release(p.kind);
      this.host.log(`X did not confirm the ${p.kind} on post ${p.postId}.`);
    }
  }

  private async remember(key: string): Promise<void> {
    this.acted.add(key);
    const list = Array.from(this.acted).slice(-ACTED_MAX);
    await ext.storage.local.set({ [ACTED_KEY]: list });
  }
}
