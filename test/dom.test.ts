import { describe, expect, it } from 'vitest';
import { visibleRatio } from '../src/content/actions';
import { focalPostId, pageKind, readPost } from '../src/content/dom';

function article(html: string): Element {
  document.body.innerHTML = `<div data-testid="cellInnerDiv"><article data-testid="tweet">${html}</article></div>`;
  return document.querySelector('article')!;
}

const header = (id: string) => `<a href="/someone/status/${id}"><time datetime="2026-10-01">Oct 1</time></a>`;

describe('readPost', () => {
  it('reads id and text, with emoji from alt text', () => {
    const a = article(`${header('111')}<div data-testid="tweetText"><span>Hello </span><img alt="👋"><span> world</span></div>`);
    expect(readPost(a)).toEqual({ id: '111', state: { post: 'Hello 👋 world' }, promoted: false });
  });

  it('separates a quoted post', () => {
    const a = article(
      `${header('222')}<div data-testid="tweetText">My take</div>` +
        `<div role="link" tabindex="0">${header('333')}<div data-testid="tweetText">Original</div></div>`,
    );
    expect(readPost(a)?.state).toEqual({ post: 'My take', quoted_post: 'Original' });
    expect(readPost(a)?.id).toBe('222');
  });

  it('uses the quote as the post when the post has no text', () => {
    const a = article(`${header('444')}<div role="link">${header('555')}<div data-testid="tweetText">Only quote</div></div>`);
    expect(readPost(a)?.state).toEqual({ post: 'Only quote' });
  });

  it('flags promoted posts and skips posts without a status link', () => {
    expect(readPost(article(`${header('1')}<div data-testid="placementTracking"></div>`))?.promoted).toBe(true);
    expect(readPost(article('<div data-testid="tweetText">Ad</div>'))).toBeNull();
  });
});

describe('pages', () => {
  it('names the page kind', () => {
    expect(pageKind('/home')).toBe('home');
    expect(pageKind('/search')).toBe('search');
    expect(pageKind('/jack/status/20')).toBe('replies');
    expect(pageKind('/jack')).toBe('profile');
    expect(pageKind('/jack/with_replies')).toBe('profile');
    expect(pageKind('/i/lists/123')).toBe('lists');
    expect(pageKind('/notifications')).toBe('other');
    expect(pageKind('/i/bookmarks')).toBe('other');
    expect(pageKind('/settings')).toBe('other');
  });

  it('finds the opened post on a status page', () => {
    expect(focalPostId('/jack/status/20/photo/1')).toBe('20');
    expect(focalPostId('/home')).toBeNull();
  });
});

describe('visibleRatio', () => {
  it('measures how much of a post is on screen', () => {
    expect(visibleRatio({ top: 0, bottom: 200, height: 200 }, 800)).toBe(1);
    expect(visibleRatio({ top: 700, bottom: 900, height: 200 }, 800)).toBe(0.5);
    expect(visibleRatio({ top: -1000, bottom: 2000, height: 3000 }, 800)).toBe(1);
    expect(visibleRatio({ top: 900, bottom: 1000, height: 100 }, 800)).toBe(0);
  });
});
