import type { DecideResult, QueueStatus } from '../shared/messages';

interface Job {
  priority: number;
  seq: number;
  run: () => Promise<DecideResult>;
  resolve: (r: DecideResult) => void;
}

export interface SchedulerOptions {
  start?: number;
  min?: number;
  max?: number;
  /** Answers slower than this count as a sign of load. */
  slowMs?: number;
  now?: () => number;
}

/**
 * Sends one post per request and runs several requests at once. The number in flight grows while
 * answers come back fast and shrinks when the server says it is busy or slows down. Posts closest
 * to the screen go first.
 */
export class Scheduler {
  private queue: Job[] = [];
  private inFlight = 0;
  private seq = 0;
  private fastStreak = 0;
  private pausedUntil = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private latencies: number[] = [];
  concurrency: number;
  readonly min: number;
  readonly max: number;
  private readonly slowMs: number;
  private readonly now: () => number;
  lastError: QueueStatus['lastError'] = null;
  lastModel: string | null = null;

  constructor(opts: SchedulerOptions = {}) {
    this.min = opts.min ?? 1;
    this.max = opts.max ?? 8;
    this.concurrency = opts.start ?? 2;
    this.slowMs = opts.slowMs ?? 2500;
    this.now = opts.now ?? Date.now;
  }

  submit(run: () => Promise<DecideResult>, priority = 0): Promise<DecideResult> {
    return new Promise((resolve) => {
      this.queue.push({ priority, seq: this.seq++, run, resolve });
      this.pump();
    });
  }

  status(): QueueStatus {
    const avg = this.latencies.length
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
      : null;
    return {
      inFlight: this.inFlight,
      waiting: this.queue.length,
      concurrency: this.concurrency,
      avgMs: avg,
      lastError: this.lastError,
      lastModel: this.lastModel,
    };
  }

  /** Called when the backend settings change: start over with a fresh estimate. */
  reset(): void {
    this.concurrency = Math.min(Math.max(2, this.min), this.max);
    this.fastStreak = 0;
    this.pausedUntil = 0;
    this.latencies = [];
    this.lastError = null;
    this.lastModel = null;
  }

  private next(): Job | undefined {
    if (this.queue.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i]!;
      const b = this.queue[best]!;
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    return this.queue.splice(best, 1)[0];
  }

  private pump(): void {
    const wait = this.pausedUntil - this.now();
    if (wait > 0) {
      if (!this.wakeTimer) {
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = null;
          this.pump();
        }, wait);
      }
      return;
    }
    while (this.inFlight < this.concurrency) {
      const job = this.next();
      if (!job) return;
      this.inFlight++;
      const started = this.now();
      job
        .run()
        .catch((err): DecideResult => ({ ok: false, error: { kind: 'server', message: String(err) } }))
        .then((result) => {
          this.inFlight--;
          this.record(result, this.now() - started);
          job.resolve(result);
          this.pump();
        });
    }
  }

  private record(result: DecideResult, ms: number): void {
    if (result.ok) {
      this.lastError = null;
      this.lastModel = result.model || this.lastModel;
      this.latencies.push(ms);
      if (this.latencies.length > 20) this.latencies.shift();
      if (ms > this.slowMs) {
        this.fastStreak = 0;
        this.concurrency = Math.max(this.min, this.concurrency - 1);
      } else if (++this.fastStreak >= this.concurrency) {
        this.fastStreak = 0;
        this.concurrency = Math.min(this.max, this.concurrency + 1);
      }
      return;
    }
    this.lastError = { ...result.error, at: this.now() };
    this.fastStreak = 0;
    if (result.error.kind === 'busy' || result.error.kind === 'timeout') {
      this.concurrency = Math.max(this.min, Math.floor(this.concurrency / 2));
      this.pausedUntil = this.now() + 2000;
    }
  }
}
