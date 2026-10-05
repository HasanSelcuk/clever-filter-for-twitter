/**
 * Test mode: a details panel next to every post on screen. It shows the post's status, the
 * probability for each check, how each rule decided, and when each step happened.
 * The panels live in one fixed layer on <body>, outside X's own markup.
 */
import { ACTION_LABELS, evaluate, type Answers } from '../shared/rules';
import type { Check, ConditionNode, Settings } from '../shared/types';
import { SEL } from './dom';
import { visibleMsNow, type Trace } from './trace';

export interface PanelHost {
  settings(): Settings;
  checks(): Check[];
  answers(id: string): Answers;
  trace(id: string): Trace | undefined;
  maxFailures: number;
}

const WIDTH = 300;
const GAP = 8;

let layer: HTMLElement | null = null;
let frame = 0;
let lastText = 0;
const panels = new Map<string, HTMLElement>();

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function clock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const ms = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
const plus = (from: number | undefined, to: number | undefined) =>
  from !== undefined && to !== undefined ? `+${ms(to - from)}` : '';
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

type Line = [label: string, value: string, cls?: string];

/** The status line and its color. */
export function statusOf(t: Trace, maxFailures: number, now = Date.now()): { text: string; cls: string } {
  if (t.skip) return { text: `Skipped: ${t.skip}`, cls: 'skip' };
  const last = t.attempts.at(-1);
  if (t.failures >= maxFailures && last?.error) return { text: `Failed: ${last.error}`, cls: 'fail' };
  if (last && last.doneAt === undefined) return { text: `Waiting for the server, ${ms(now - last.askedAt)}`, cls: 'wait' };
  if (t.outcome) return { text: t.outcome, cls: t.outcomeKind ?? 'pass' };
  if (last?.error) return { text: `Retrying after: ${last.error}`, cls: 'wait' };
  return { text: 'Not asked yet', cls: 'wait' };
}

function conditionLines(node: ConditionNode, checks: Check[], a: Answers, depth: number, out: Line[]): void {
  const indent = '  '.repeat(depth);
  if (node.kind === 'check') {
    const check = checks.find((c) => c.id === node.checkId);
    const p = a[node.checkId];
    const verdict = evaluate(node, a);
    const label = `${indent}${node.negate ? 'not ' : ''}${check?.name ?? 'missing check'}`;
    const value = p === undefined ? 'no answer' : `${pct(p)} (yes at ${Math.round(node.threshold * 100)}%) ${verdict ? 'true' : 'false'}`;
    out.push([label, value, verdict ? 'yes' : 'no']);
    return;
  }
  if (depth > 0) {
    const v = evaluate(node, a);
    out.push([`${indent}${node.negate ? 'NOT ' : ''}${node.op.toUpperCase()} group`, v === undefined ? 'waiting' : String(v), v ? 'yes' : 'no']);
  }
  for (const child of node.children) conditionLines(child, checks, a, depth + 1, out);
}

export function linesFor(host: PanelHost, t: Trace, now = Date.now()): Line[] {
  const lines: Line[] = [];
  const kind = [t.media.join(', '), t.hasQuote ? 'quotes a post' : ''].filter(Boolean).join(', ');
  lines.push(['post', `${t.id}${kind ? ` (${kind})` : ''}`]);
  lines.push(['found', clock(t.foundAt)]);
  if (t.onScreenAt) lines.push(['on screen', `${clock(t.onScreenAt)}, seen for ${ms(visibleMsNow(t, now))}`]);

  const last = t.attempts.at(-1);
  if (last) {
    const m = last.meta;
    lines.push(['asked', `${clock(last.askedAt)} ${plus(t.foundAt, last.askedAt)} after found`]);
    if (m?.sentAt) lines.push(['sent', `${clock(m.sentAt)} ${plus(last.askedAt, m.sentAt)} in queue`]);
    if (m?.answeredAt) {
      const server = [
        m.serverTotalMs !== undefined ? `server ${ms(m.serverTotalMs)}` : '',
        m.serverEvalMs !== undefined ? `model ${ms(m.serverEvalMs)}` : '',
        m.serverLoadMs ? `load ${ms(m.serverLoadMs)}` : '',
      ].filter(Boolean).join(', ');
      lines.push(['answered', `${clock(m.answeredAt)} ${plus(m.sentAt, m.answeredAt)}${server ? ` (${server})` : ''}`]);
    }
    if (last.shownAt) lines.push(['shown', `${clock(last.shownAt)} ${plus(last.doneAt, last.shownAt)}, total ${plus(last.askedAt, last.shownAt)}`]);
    const facts = [
      last.model,
      m?.route,
      m?.inputTokens !== undefined ? `${m.inputTokens} tokens` : '',
      m && m.attempts > 1 ? `${m.attempts} tries` : '',
      last.truncated ? 'text cut to fit' : '',
      t.attempts.length > 1 ? `${t.attempts.length} requests` : '',
    ].filter(Boolean);
    if (facts.length) lines.push(['model', facts.join(', ')]);
    if (last.error) lines.push(['error', last.error, 'no']);
  }

  const s = host.settings();
  const checks = host.checks();
  const a = host.answers(t.id);
  if (!t.skip && Object.keys(a).length) {
    for (const rule of s.rules) {
      if (!rule.enabled) continue;
      const v = evaluate(rule.root, a);
      lines.push([`${rule.name}`, `${ACTION_LABELS[rule.action]}: ${v === undefined ? 'waiting' : v ? 'match' : 'no match'}`, v ? 'rule yes' : 'rule']);
      conditionLines(rule.root, checks, a, 0, lines);
    }
  }
  for (const act of t.actions) lines.push([act.kind, `${clock(act.at)} by "${act.rule}"`, 'yes']);
  return lines;
}

/** Short form: the probabilities and the total time. */
export function summaryFor(host: PanelHost, t: Trace, now = Date.now()): string[] {
  const out: string[] = [];
  const a = host.answers(t.id);
  const probs = host
    .checks()
    .filter((c) => a[c.id] !== undefined)
    .map((c) => `${c.name} ${pct(a[c.id]!)}`);
  if (probs.length) out.push(probs.join(' · '));
  const last = t.attempts.at(-1);
  const times = [`found ${clock(t.foundAt)}`];
  if (last?.shownAt) times.push(`answer in ${ms(last.shownAt - last.askedAt)}`);
  if (last?.meta?.serverTotalMs !== undefined) times.push(`server ${ms(last.meta.serverTotalMs)}`);
  if (t.onScreenAt) times.push(`seen ${ms(visibleMsNow(t, now))}`);
  out.push(times.join(' · '));
  return out;
}

const expanded = new Set<string>();

function ensureLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'cf-test-layer';
  document.body.append(layer);
  return layer;
}

function build(host: PanelHost, t: Trace, panel: HTMLElement, now: number): void {
  const status = statusOf(t, host.maxFailures, now);
  panel.dataset.status = status.cls;
  const head = document.createElement('div');
  head.className = 'cf-panel-status';
  head.textContent = status.text;

  const open = expanded.has(t.id);
  const table = document.createElement('div');
  table.className = open ? 'cf-panel-lines' : 'cf-panel-summary';
  if (open) {
    for (const [label, value, cls] of linesFor(host, t, now)) {
      const k = document.createElement('span');
      k.className = `cf-k${cls?.includes('rule') ? ' cf-rule' : ''}`;
      k.textContent = label;
      const v = document.createElement('span');
      v.className = `cf-v${cls?.includes('yes') ? ' cf-yes' : ''}`;
      v.textContent = value;
      table.append(k, v);
    }
  } else {
    for (const line of summaryFor(host, t, now)) {
      const row = document.createElement('div');
      row.textContent = line;
      table.append(row);
    }
  }
  panel.onclick = (e) => {
    if ((e.target as Element).closest('button')) return;
    e.stopPropagation();
    if (expanded.has(t.id)) expanded.delete(t.id);
    else expanded.add(t.id);
    build(host, t, panel, Date.now());
  };
  panel.title = open ? 'Click to show less' : 'Click for every detail';

  const text = document.createElement('div');
  text.className = 'cf-panel-text';
  text.textContent = t.text ? `“${t.text.length > 160 ? `${t.text.slice(0, 160)}…` : t.text}”` : '';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'cf-panel-copy';
  copy.textContent = 'Copy details';
  copy.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const data = { ...t, status: status.text, answers: host.answers(t.id), lines: linesFor(host, t) };
    void navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => (copy.textContent = 'Copied'));
  };
  panel.replaceChildren(head, table, ...(open ? [text, copy] : []));
}

/** Puts the panel beside its post, below the previous panel. Returns the panel's bottom edge. */
function place(cell: HTMLElement, panel: HTMLElement, below: number): number | null {
  const r = cell.getBoundingClientRect();
  if (r.bottom < -50 || r.top > innerHeight + 50 || r.height === 0) return null;
  let left = r.right + GAP;
  if (left + WIDTH > innerWidth - 4) left = Math.max(4, r.right - WIDTH - GAP);
  const top = Math.max(r.top, below + 4);
  panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  return top + panel.offsetHeight;
}

function tick(host: PanelHost): void {
  frame = requestAnimationFrame(() => tick(host));
  const now = Date.now();
  const refreshText = now - lastText > 250;
  if (refreshText) lastText = now;
  const root = ensureLayer();
  const seen = new Set<string>();
  let below = -Infinity;
  for (const cell of Array.from(document.querySelectorAll<HTMLElement>(`${SEL.cell}[data-cf-id]`))) {
    const id = cell.dataset.cfId!;
    const t = host.trace(id);
    if (!t || seen.has(id)) continue;
    let panel = panels.get(id);
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'cf-panel';
      panels.set(id, panel);
      root.append(panel);
      build(host, t, panel, now);
    } else if (refreshText && !panel.matches(':hover')) {
      build(host, t, panel, now);
    }
    const bottom = place(cell, panel, below);
    if (bottom !== null) {
      seen.add(id);
      below = bottom;
    }
  }
  for (const [id, panel] of panels) {
    if (!seen.has(id)) {
      panel.remove();
      panels.delete(id);
    }
  }
}

export function startPanels(host: PanelHost): void {
  if (frame) return;
  frame = requestAnimationFrame(() => tick(host));
}

export function stopPanels(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  layer?.remove();
  layer = null;
  panels.clear();
}
