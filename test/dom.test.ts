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
    expect(readPost(a)).toEqual({
      id: '111',
      state: { post: 'Hello 👋 world' },
      promoted: false,
      hasQuote: false,
      media: [],
      skip: null,
    });
  });

  it('checks only the post\'s own text, never the quoted post', () => {
    const a = article(
      `${header('222')}<div data-testid="tweetText">My take</div>` +
        `<div role="link" tabindex="0">${header('333')}<div data-testid="tweetText">Original</div></div>`,
    );
    expect(readPost(a)).toMatchObject({ id: '222', state: { post: 'My take' }, hasQuote: true, skip: null });
  });

  it('skips a post that only quotes another post', () => {
    const a = article(`${header('444')}<div role="link">${header('555')}<div data-testid="tweetText">Only quote</div></div>`);
    expect(readPost(a)).toMatchObject({ state: { post: '' }, skip: 'no text of its own, only a quoted post' });
  });

  it('skips video and image posts without text, and keeps the ones with text', () => {
    const video = '<div data-testid="tweetPhoto"><div data-testid="videoPlayer"><div data-testid="videoComponent"><video></video></div></div></div>';
    expect(readPost(article(`${header('7')}${video}`))).toMatchObject({ media: ['video'], skip: 'no text, video only' });
    expect(readPost(article(`${header('8')}<div data-testid="tweetText">Watch this</div>${video}`))).toMatchObject({
      state: { post: 'Watch this' },
      media: ['video'],
      skip: null,
    });
    expect(readPost(article(`${header('9')}<div data-testid="tweetPhoto"></div>`))?.skip).toBe('no text, image only');
  });

  it('flags promoted posts and skips posts without a status link', () => {
    expect(readPost(article(`${header('1')}<div data-testid="tweetText">Buy</div><div data-testid="placementTracking"></div>`))).toMatchObject({
      promoted: true,
      skip: 'promoted post',
    });
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
