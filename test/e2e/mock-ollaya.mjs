// A stand-in for `ollaya serve`, following its documented API: GET /, GET /v1/models,
// POST /api/decide and POST /v1/systemone, with Ollaya's Origin allowlist (403 FORBIDDEN for
// browser origins outside localhost). Answers come from keywords so tests are predictable.
import { createServer } from 'node:http';

const LOCAL_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?|app:\/\/|file:\/\/)/;

function score(instructions, post) {
  if (/AI model/i.test(instructions)) return /game-changing|unlock your/i.test(post) ? 0.95 : 0.04;
  if (/thoughtful/i.test(instructions)) return /rewrote|measured/i.test(post) ? 0.96 : 0.08;
  if (/outdoors/i.test(instructions)) return 0.9;
  return 0.1;
}

export async function startMockOllaya(port, { token } = {}) {
  let originSeen = false;
  const posts = [];
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const origin = req.headers.origin;
    if (origin) originSeen = true;
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      return send(403, { error: `origin ${origin} not allowed`, code: 'FORBIDDEN' });
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Ollaya is running');
    }
    // OLLAYA_API_KEY: every request except GET / needs the bearer token.
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return send(401, { error: 'unauthorized', code: 'UNAUTHORIZED' });
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(200, { models: [{ name: 'laya:en', description: '', release_date: '2026-09-20' }, { name: 'laya:latest', description: '', release_date: '2026-09-20' }] });
    }
    if (req.method === 'POST' && (req.url === '/api/decide' || req.url === '/v1/systemone')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (body.model !== 'laya') {
          return send(404, { error: `model "${body.model}" not found, try pulling it first`, code: 'MODEL_NOT_FOUND' });
        }
        const post = typeof body.state === 'string' ? body.state : body.state.post;
        posts.push(post);
        const answers = {};
        for (const [id, q] of Object.entries(body.questions)) {
          answers[id] = { type: 'noul', noul: score(q.instructions ?? id, post) };
        }
        setTimeout(() => send(200, {
          model: 'laya:en',
          answers,
          usage: { input_tokens: 40, output_tokens: 0 },
          routing: { router: 'laya:latest', model: 'laya:en', route: 'english', reason: 'English Latin text' },
          state_truncated: false,
          done_reason: 'decide',
          total_duration: 18_734_512,
          load_duration: 0,
          eval_duration: 16_302_117,
        }), 120);
      });
      return;
    }
    send(404, { error: 'not found', code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    sawOrigin: () => originSeen,
    askedAbout: (text) => posts.some((p) => p.includes(text)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
