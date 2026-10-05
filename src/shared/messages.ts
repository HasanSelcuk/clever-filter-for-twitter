import type { DayStats, NoulQuestion, PostState, ProviderConfig } from './types';

export type ErrorKind =
  | 'no-server'
  | 'auth'
  | 'forbidden'
  | 'model'
  | 'invalid'
  | 'busy'
  | 'network'
  | 'timeout'
  | 'server'
  | 'permission';

export interface BackendError {
  kind: ErrorKind;
  message: string;
  status?: number;
}

/** Timings and server details of one request, shown in test mode. Times are Date.now() values. */
export interface DecideMeta {
  /** HTTP attempts, 1 when there was no retry. */
  attempts: number;
  /** The background worker got the request from the page. */
  receivedAt?: number;
  /** The request left the queue and went to the server. */
  sentAt?: number;
  /** The server's answer arrived. */
  answeredAt?: number;
  /** From Ollaya's /api/decide: time inside the server, in ms. */
  serverTotalMs?: number;
  serverEvalMs?: number;
  serverLoadMs?: number;
  inputTokens?: number;
  /** Ollaya router choice, such as english or multilingual. */
  route?: string;
}

export type DecideResult =
  | { ok: true; answers: Record<string, number>; model: string; ms: number; truncated: boolean; meta?: DecideMeta }
  | { ok: false; error: BackendError; meta?: DecideMeta };

export interface QueueStatus {
  inFlight: number;
  waiting: number;
  concurrency: number;
  avgMs: number | null;
  lastError: (BackendError & { at: number }) | null;
  lastModel: string | null;
}

export type Request =
  | { type: 'decide'; state: PostState; questions: Record<string, NoulQuestion>; priority: number }
  | { type: 'count'; field: 'checked' | 'hidden' }
  | { type: 'reserve'; action: 'like' | 'bookmark' }
  | { type: 'release'; action: 'like' | 'bookmark' }
  | { type: 'status' }
  | { type: 'test'; config?: ProviderConfig };

export interface StatusResponse {
  queue: QueueStatus;
  stats: DayStats;
}

export type TestResult =
  | { ok: true; models: string[] | null; answeredBy: string; ms: number }
  | { ok: false; error: BackendError };

export type ReserveResult = { allowed: true } | { allowed: false; reason: string };
