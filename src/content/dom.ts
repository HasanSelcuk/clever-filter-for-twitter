import type { PageKind, PostState } from '../shared/types';

/** X's own test ids. They are the most stable hooks the page offers. */
export const SEL = {
  cell: '[data-testid="cellInnerDiv"]',
  tweet: 'article[data-testid="tweet"]',
  text: '[data-testid="tweetText"]',
  promoted: '[data-testid="placementTracking"]',
  like: '[data-testid="like"]',
  unlike: '[data-testid="unlike"]',
  bookmark: '[data-testid="bookmark"]',
  removeBookmark: '[data-testid="removeBookmark"]',
} as const;

const RESERVED = new Set([
  'home', 'explore', 'search', 'notifications', 'messages', 'i', 'settings', 'compose',
  'bookmarks', 'jobs', 'communities', 'premium_sign_up', 'login', 'logout', 'signup', 'tos',
  'privacy', 'account', 'lists', 'grok', 'hashtag',
]);

export function pageKind(pathname: string): PageKind {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/home') return 'home';
  if (path === '/search') return 'search';
  if (/^\/i\/lists\/\d+$/.test(path)) return 'lists';
  if (/^\/[A-Za-z0-9_]{1,15}\/status\/\d+/.test(path)) return 'replies';
  const m = /^\/([A-Za-z0-9_]{1,15})(\/(with_replies|media|highlights|articles|superfollows))?$/.exec(path);
  if (m && !RESERVED.has(m[1]!.toLowerCase())) return 'profile';
  return 'other';
}

/** The post opened on a status page, which the extension never touches. */
export function focalPostId(pathname: string): string | null {
  return /^\/[A-Za-z0-9_]{1,15}\/status\/(\d+)/.exec(pathname)?.[1] ?? null;
}

/** Text of a node with emoji images read from their alt text. */
export function readText(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? '';
    else if (child instanceof HTMLImageElement) out += child.alt;
    else if (child instanceof HTMLBRElement) out += '\n';
    else if (child.nodeType === Node.ELEMENT_NODE) out += readText(child);
  }
  return out;
}

export interface PostInfo {
  id: string;
  state: PostState;
  promoted: boolean;
}

/** The id of a post from its timestamp link. Promoted posts have none. */
export function postId(article: Element): string | null {
  for (const time of Array.from(article.querySelectorAll('time'))) {
    const href = time.closest('a')?.getAttribute('href') ?? '';
    const m = /\/status\/(\d+)/.exec(href);
    if (m) return m[1]!;
  }
  return null;
}

/** Whether a text block sits inside a quoted post's card. */
function inQuote(el: Element, article: Element): boolean {
  const card = el.closest('div[role="link"]');
  return card !== null && article.contains(card) && card !== article;
}

export function readPost(article: Element): PostInfo | null {
  const id = postId(article);
  const promoted = article.querySelector(SEL.promoted) !== null || article.closest(SEL.promoted) !== null;
  if (!id) return null;
  let main = '';
  let quoted = '';
  for (const el of Array.from(article.querySelectorAll(SEL.text))) {
    const text = readText(el).trim();
    if (!text) continue;
    if (inQuote(el, article)) quoted ||= text;
    else main ||= text;
  }
  if (!main && !quoted) return { id, state: { post: '' }, promoted };
  const state: PostState = { post: main || quoted };
  if (main && quoted) state.quoted_post = quoted;
  return { id, state, promoted };
}

export function cellOf(article: Element): HTMLElement | null {
  return article.closest<HTMLElement>(SEL.cell);
}
