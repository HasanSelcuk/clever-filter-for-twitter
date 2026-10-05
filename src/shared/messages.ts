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

export type DecideResult =
  | { ok: true; answers: Record<string, number>; model: string; ms: number; truncated: boolean }
  | { ok: false; error: BackendError };

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
