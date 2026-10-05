# Clever Filter for X

A browser extension for Chrome and Firefox. It sends each post you scroll past on X to a decision model, asks it your yes-or-no questions, and acts on the answers. A rule can hide the post, bookmark it, or like it.

Decision models such as TypeSafe's Jev and the open Laya models write no text. They read a post and a set of typed questions, then return a calibrated probability for each question. Laya answers in milliseconds on a GPU and in a fraction of a second on a CPU.

## How it works

- **Checks** are yes-or-no questions about a post, such as "Is `post` generic, low-effort text that reads like it was produced by an AI model?". Each one goes to the model as a `noul` question.
- **Rules** join checks with AND, OR and NOT, in nested groups. Each condition has a "sure at" slider, the probability at which it counts as yes (80% by default).
- **Actions:** Hide, Bookmark or Like. A hidden post shrinks to a one-line note with a Show button, or disappears entirely.
- **Quick starts** add a ready rule and its checks: AI slop, Messy AI posts, Engagement bait, Calm feed, Giveaways and scams, Save useful posts, Like thoughtful posts.
- **Live view**, on by default: a thin bar runs along posts being checked, a scan line sweeps a post as it gets hidden, and a short note appears on posts the extension liked or bookmarked. You can turn it off in Settings. It also stays off when the system asks for reduced motion.

Each post goes out as one request carrying every check the enabled rules use. Answers are cached per post, so scrolling back costs nothing. After a rule edit, the extension asks only the new questions. Several requests run at once, and posts nearest the screen go first. The number of parallel requests grows while answers come back fast and shrinks when the server reports it is busy.

### What gets checked

Only a post's own text is checked. When a post quotes another post, the quoted text is left out, and a post that only quotes another post is skipped. Posts with a video or images but no text are skipped too, along with ads. Replies under a post are left alone for now.

### Test mode

Turn on **Test mode** in the popup or in Settings. Every post on screen then gets a panel beside it:

- **Status:** Checked: passed, Hidden, Liked, Bookmarked, Waiting for the server, Skipped (with the reason), or Failed (with the error).
- **Probabilities** for each check, and how long the answer took.
- **Click the panel** for every detail:
  - when the post appeared in the page, when it came on screen, and how long it stayed there
  - when it was asked, sent, answered and shown
  - the server's own time, the model time, the model, the route and the token count
  - how each rule and each condition decided
- **Copy details** puts all of it on the clipboard as JSON.

A post whose request fails three times in a row is marked Failed and left as X shows it, until the settings change. The page also gives up on any single answer after 60 seconds, so no post can wait forever.

### Likes and bookmarks

Automatic likes come from your account, and X's rules forbid automated liking. The extension keeps likes off until you accept a risk note in Settings. Once you accept it:

- Only a post that has stayed on screen for a moment gets liked (1.5 s by default).
- One action at a time, with a pause between two actions (5 s by default, plus a random extra).
- Daily limits apply: 50 likes and 100 bookmarks by default.
- A post never gets liked twice, even after you unlike it.

## Model servers

| Option | Address | Key | Endpoint |
|---|---|---|---|
| Ollaya on this computer | `http://127.0.0.1:11435` | none | `POST /api/decide` |
| TypeSafe (Jev) | `https://api.typesafe.ai` | your key from console.typesafe.ai | `POST /v1/systemone` |
| Your own server | any | optional bearer token | either of the above |
| Shared project server | set in `src/shared/config.ts` | optional | `POST /api/decide` |

The default model is `laya`. It sends English posts to `laya:en` and everything else to `laya:multilingual`. For TypeSafe the default model is `jev-latest`, the same default the official SDK uses.

The **Test connection** button sends one sample post, reports which model answered and how long it took, and fills the model list from `GET /v1/models`.

### Ollaya and browser origins

Ollaya rejects requests from browser origins outside its allowlist with a 403, and extension requests carry `chrome-extension://…` or `moz-extension://…`. The extension handles this with a session `declarativeNetRequest` rule. The rule removes the `Origin` header from the extension's own background requests to the chosen server, and from nothing else. Web pages keep Ollaya's protection. If a browser ignores the rule, start Ollaya with:

```sh
OLLAYA_ORIGINS="chrome-extension://*,moz-extension://*" ollaya serve
```

### Running the shared server on a VPS

1. Install Ollaya, pull the model, and start it with a key:
   ```sh
   curl -fsSL https://ollaya.dev/install.sh | sh
   ollaya pull laya
   OLLAYA_API_KEY=some-long-secret OLLAYA_HOST=127.0.0.1:11435 ollaya serve
   ```
2. Put a TLS reverse proxy (Caddy, nginx) in front of it, and pass through `/api/decide`, `/v1/*` and `GET /`. Block `/api/pull`, `/api/delete`, `/api/copy` and `/api/create` at the proxy, so nobody can change your models.
3. Fill `COMMUNITY_SERVER` in `src/shared/config.ts` with the public address, then rebuild. The option shows up in Settings once the address is set.

A key built into a public extension is readable by anyone who opens the package, so it limits casual use but does not secure the server. For per-user tokens or rate limits, put a small gateway in front of Ollaya. `OLLAYA_MAX_QUEUE` (default 512) sets how many requests may wait before Ollaya answers `503 QUEUE_FULL`, and the extension backs off when it sees that.

## Install from source

```sh
npm install
npm run build        # writes dist/chrome and dist/firefox
npm run package      # also writes dist/*.zip
```

- **Chrome:** open `chrome://extensions`, turn on Developer mode, click "Load unpacked", and pick `dist/chrome`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", and pick `dist/firefox/manifest.json`.

Settings open after install. Pick a model server, press Test connection, and add a quick start.

## Development

```sh
npm run watch        # rebuild on change
npm run check        # typecheck and unit tests
npm run test:e2e     # build, then drive Chromium against a fake X timeline and a mock Ollaya
```

To try a real server with the same fake timeline, run:

```sh
SERVER_URL=https://your.server SERVER_KEY=your-token npm run test:server
```

It sets the server in the extension, presses Test connection, adds a few quick starts, opens the timeline with Test mode on, and prints every panel: status, probabilities and timings. A screenshot goes to `test-results/real-server.png`.

The end-to-end test loads the built extension into Chromium and opens a copy of X's timeline markup served at `https://x.com/home`. It talks to a mock server that follows Ollaya's API and its Origin rules. It adds quick starts through the settings page, then checks the hide animation, the like, the Show button, the popup counts and the off switch. Screenshots land in `test-results/`. Set `CHROMIUM_PATH` if your Chromium lives elsewhere.

### Layout

```
src/shared/      types, settings, rules engine, quick starts, server defaults
src/background/  server client, request scheduler, Origin rule, daily counts
src/content/     reads posts on X, draws the result, runs likes and bookmarks
src/options/     settings page
src/popup/       toolbar popup
static/          HTML, CSS, icons
scripts/         build and icon scripts
test/            unit tests, plus test/e2e
```

The content script finds posts through X's `data-testid` attributes (`cellInnerDiv`, `tweet`, `tweetText`, `like`, `bookmark`, `placementTracking`). They live in `src/content/dom.ts`, so a change on X's side means editing one file.

### Privacy

Only post text goes to the model server you pick. Your settings, rules, API key and daily counts stay in the browser's local extension storage. The key goes only to the server it belongs to.
