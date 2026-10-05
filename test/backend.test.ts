import { describe, expect, it, vi } from 'vitest';
import {
  buildDecideRequest,
  classifyHttpError,
  decide,
  listModels,
  parseDecideResponse,
  retryAfterMs,
} from '../src/background/backend';
import { PROVIDER_DEFAULTS } from '../src/shared/config';
import type { ProviderConfig } from '../src/shared/types';

const typesafe: ProviderConfig = { ...PROVIDER_DEFAULTS.typesafe, apiKey: 'ts-key' };
const ollaya: ProviderConfig = { ...PROVIDER_DEFAULTS.ollaya };
const questions = { slop: { type: 'noul' as const, instructions: 'Is `post` slop?' } };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('requests', () => {
  it('calls TypeSafe at /v1/systemone with a bearer key', () => {
    const req = buildDecideRequest(typesafe, { post: 'hi' }, questions);
    expect(req.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(req.init.headers.Authorization).toBe('Bearer ts-key');
    expect(JSON.parse(String(req.init.body))).toEqual({ model: 'jev-latest', state: { post: 'hi' }, questions });
  });

  it('calls Ollaya at /api/decide with keep_alive and no key', () => {
    const req = buildDecideRequest({ ...ollaya, baseUrl: 'http://127.0.0.1:11435/' }, { post: 'hi' }, questions);
    expect(req.url).toBe('http://127.0.0.1:11435/api/decide');
    expect(req.init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(String(req.init.body));
    expect(body.model).toBe('laya');
    expect(body.keep_alive).toBe('30m');
  });
});

describe('responses', () => {
  it('reads noul answers and the answering model', () => {
    const r = parseDecideResponse(
      { model: 'laya:en', answers: { slop: { type: 'noul', noul: 0.91 } }, state_truncated: true },
      ['slop'],
    );
    expect(r).toEqual({ answers: { slop: 0.91 }, model: 'laya:en', truncated: true });
  });

  it('fails when an answer is missing', () => {
    expect(parseDecideResponse({ answers: {} }, ['slop'])).toMatchObject({ kind: 'server' });
  });
});

describe('errors', () => {
  it('explains Ollaya origin refusals', () => {
    const e = classifyHttpError(403, { error: 'origin not allowed', code: 'FORBIDDEN' }, ollaya);
    expect(e.kind).toBe('forbidden');
    expect(e.message).toContain('OLLAYA_ORIGINS');
  });

  it('tells the person to pull a missing model', () => {
    const e = classifyHttpError(404, { error: 'model "laya:latest" not found, try pulling it first', code: 'MODEL_NOT_FOUND' }, ollaya);
    expect(e).toMatchObject({ kind: 'model' });
    expect(e.message).toContain('ollaya pull laya');
  });

  it('reads TypeSafe validation details', () => {
    const e = classifyHttpError(422, { detail: [{ loc: ['body', 'state'], msg: 'Field required', type: 'missing' }] }, typesafe);
    expect(e.message).toContain('state: Field required');
  });

  it('asks for a key on 401', () => {
    expect(classifyHttpError(401, {}, { ...typesafe, apiKey: '' }).message).toContain('needs an API key');
  });

  it('reads Retry-After in seconds and retry-after-ms', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '150', 'retry-after': '9' }))).toBe(150);
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });
});

describe('decide', () => {
  it('retries a busy server and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(503, { error: 'busy', code: 'QUEUE_FULL' }, { 'retry-after-ms': '1' }))
      .mockResolvedValueOnce(json(200, { model: 'jev-1', answers: { slop: { type: 'noul', noul: 0.2 } } }));
    const r = await decide(typesafe, { post: 'x' }, questions, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: true, answers: { slop: 0.2 }, model: 'jev-1' });
  });

  it('does not retry a rejected key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401, { error: 'bad key' }));
    const r = await decide(typesafe, { post: 'x' }, questions, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, error: { kind: 'auth' } });
  });

  it('reports a missing server address', async () => {
    const r = await decide({ ...ollaya, baseUrl: '' }, { post: 'x' }, questions, vi.fn());
    expect(r).toMatchObject({ ok: false, error: { kind: 'no-server' } });
  });

  it('lists models from /v1/models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { models: [{ name: 'laya:en' }, { name: 'laya:latest' }] }));
    expect(await listModels(ollaya, fetchImpl)).toEqual(['laya:en', 'laya:latest']);
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:11435/v1/models');
  });
});
