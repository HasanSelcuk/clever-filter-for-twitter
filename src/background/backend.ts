import { OLLAYA_KEEP_ALIVE, REQUEST_TIMEOUT_MS } from '../shared/config';
import type { BackendError, DecideMeta, DecideResult } from '../shared/messages';
import type { NoulQuestion, PostState, ProviderConfig } from '../shared/types';

export interface HttpRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

export function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function authHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = config.apiKey.trim();
  // TypeSafe and Ollaya (with OLLAYA_API_KEY set) both read a bearer token.
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function buildDecideRequest(
  config: ProviderConfig,
  state: PostState,
  questions: Record<string, NoulQuestion>,
): HttpRequest {
  const base = trimBase(config.baseUrl);
  const body: Record<string, unknown> = { model: config.model.trim(), state, questions };
  let path = '/v1/systemone';
  if (config.api === 'ollaya') {
    path = '/api/decide';
    body.keep_alive = OLLAYA_KEEP_ALIVE;
  }
  return {
    url: base + path,
    init: {
      method: 'POST',
      headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

export function buildModelsRequest(config: ProviderConfig): HttpRequest {
  return {
    url: `${trimBase(config.baseUrl)}/v1/models`,
    init: { method: 'GET', headers: authHeaders(config) },
  };
}

interface WireAnswer {
  type?: string;
  noul?: unknown;
}

/** Reads noul probabilities out of a /v1/systemone or /api/decide response. */
export function parseDecideResponse(
  body: unknown,
  questionIds: string[],
): { answers: Record<string, number>; model: string; truncated: boolean } | BackendError {
  if (typeof body !== 'object' || body === null) {
    return { kind: 'server', message: 'The server sent an answer this extension cannot read.' };
  }
  const b = body as { answers?: Record<string, WireAnswer>; model?: unknown; state_truncated?: unknown };
  const answers: Record<string, number> = {};
  for (const id of questionIds) {
    const a = b.answers?.[id];
    if (!a || typeof a.noul !== 'number' || !Number.isFinite(a.noul)) {
      return { kind: 'server', message: `The server sent no yes/no answer for "${id}".` };
    }
    answers[id] = a.noul;
  }
  return {
    answers,
    model: typeof b.model === 'string' ? b.model : '',
    truncated: b.state_truncated === true,
  };
}

function bodyMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  if (typeof body !== 'object' || body === null) return undefined;
  const { error, message, detail } = body as Record<string, unknown>;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, string>).message;
  }
  if (typeof message === 'string') return message;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .filter((d): d is { loc?: unknown[]; msg: string } => typeof d?.msg === 'string')
      .map((d) => {
        const loc = Array.isArray(d.loc) ? d.loc.filter((x) => x !== 'body').join('.') : '';
        return loc ? `${loc}: ${d.msg}` : d.msg;
      });
    if (parts.length) return parts.join('; ');
  }
  return undefined;
}

function bodyCode(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null) {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Turns an HTTP error into a message that says what to do next. */
export function classifyHttpError(status: number, body: unknown, config: ProviderConfig): BackendError {
  const code = bodyCode(body);
  const detail = bodyMessage(body);
  const model = config.model.trim();
  const isOllaya = config.api === 'ollaya';
  if (status === 401) {
    return {
      kind: 'auth',
      status,
      message: config.apiKey.trim()
        ? 'The server did not accept the API key. Check the key in Settings.'
        : 'The server needs an API key. Add one in Settings.',
    };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      status,
      message: isOllaya || code === 'FORBIDDEN'
        ? 'Ollaya refused a request from the browser. Restart it with OLLAYA_ORIGINS="chrome-extension://*,moz-extension://*".'
        : `The server refused the request${detail ? `: ${detail}` : '.'}`,
    };
  }
  if (status === 404) {
    if (code === 'MODEL_NOT_FOUND' || /model/i.test(detail ?? '')) {
      return {
        kind: 'model',
        status,
        message: isOllaya
          ? `The model "${model}" is not on the server. Run: ollaya pull ${model}`
          : `The server has no model named "${model}".`,
      };
    }
    return {
      kind: 'no-server',
      status,
      message: 'This address answered, but it does not look like an Ollaya or TypeSafe server.',
    };
  }
  if (status === 408 || status === 429 || status === 503) {
    return { kind: 'busy', status, message: 'The server is busy. Posts will be checked when it frees up.' };
  }
  if (status === 400 || status === 413 || status === 422) {
    return { kind: 'invalid', status, message: detail ? `The server rejected a request: ${detail}` : 'The server rejected a request.' };
  }
  return { kind: 'server', status, message: detail ? `Server error: ${detail}` : `Server error (${status}).` };
}

export function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Reads `retry-after-ms` or `Retry-After` the way the TypeSafe SDK does. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SendOutcome {
  ok: boolean;
  status: number;
  body: unknown;
  headers: Headers | null;
  attempts: number;
  error?: BackendError;
}

/** One request with a timeout and up to `retries` retries on 408, 429, 5xx and network errors. */
export async function send(
  req: HttpRequest,
  config: ProviderConfig,
  fetchImpl: Fetch = (u, i) => fetch(u, i),
  retries = 2,
): Promise<SendOutcome> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(req.url, { ...req.init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      let host = req.url;
      try {
        host = new URL(req.url).host;
      } catch {
        /* keep the raw url */
      }
      return {
        ok: false,
        status: 0,
        body: undefined,
        headers: null,
        attempts: attempt + 1,
        error: timedOut
          ? { kind: 'timeout', message: `${host} took longer than ${REQUEST_TIMEOUT_MS / 1000} seconds to answer.` }
          : {
              kind: 'network',
              message:
                config.api === 'ollaya' && /127\.0\.0\.1|localhost/.test(host)
                  ? `Could not reach Ollaya at ${host}. Start it with: ollaya serve`
                  : `Could not reach ${host}. ${String((err as Error)?.message ?? '')}`.trim(),
            },
      };
    }
    let body: unknown;
    try {
      body = await readBody(res);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return { ok: true, status: res.status, body, headers: res.headers, attempts: attempt + 1 };
    if (attempt < retries && isRetryable(res.status)) {
      const wait = retryAfterMs(res.headers);
      await sleep(wait !== undefined && wait <= 60_000 ? wait : 500 * 2 ** attempt);
      continue;
    }
    return {
      ok: false,
      status: res.status,
      body,
      headers: res.headers,
      attempts: attempt + 1,
      error: classifyHttpError(res.status, body, config),
    };
  }
}

export async function decide(
  config: ProviderConfig,
  state: PostState,
  questions: Record<string, NoulQuestion>,
  fetchImpl?: Fetch,
): Promise<DecideResult> {
  if (!trimBase(config.baseUrl)) {
    return { ok: false, error: { kind: 'no-server', message: 'No server address is set. Pick one in Settings.' } };
  }
  const started = Date.now();
  const out = await send(buildDecideRequest(config, state, questions), config, fetchImpl);
  const meta = { ...serverMeta(out.body), attempts: out.attempts };
  if (!out.ok) return { ok: false, error: out.error!, meta };
  const parsed = parseDecideResponse(out.body, Object.keys(questions));
  if ('kind' in parsed) return { ok: false, error: parsed, meta };
  return { ok: true, ...parsed, ms: Date.now() - started, meta };
}

const nsToMs = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v / 1e5) / 10 : undefined;

/** Timing fields Ollaya's /api/decide adds to its answer. TypeSafe sends only token usage. */
export function serverMeta(body: unknown): Omit<DecideMeta, 'attempts'> {
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;
  const usage = b.usage as { input_tokens?: unknown } | undefined;
  const routing = b.routing as { route?: unknown } | null | undefined;
  return {
    serverTotalMs: nsToMs(b.total_duration),
    serverEvalMs: nsToMs(b.eval_duration),
    serverLoadMs: nsToMs(b.load_duration),
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
    route: typeof routing?.route === 'string' ? routing.route : undefined,
  };
}

export async function listModels(config: ProviderConfig, fetchImpl?: Fetch): Promise<string[] | BackendError> {
  const out = await send(buildModelsRequest(config), config, fetchImpl, 0);
  if (!out.ok) return out.error!;
  const models = (out.body as { models?: { name?: unknown }[] } | undefined)?.models;
  if (!Array.isArray(models)) return { kind: 'no-server', message: 'The server sent no model list.' };
  return models.map((m) => (typeof m?.name === 'string' ? m.name : '')).filter(Boolean);
}
