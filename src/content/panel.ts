/**
 * Test mode: a small status button beside every post on screen. It shows a tick when the post
 * was checked and passed, a cross when a rule hid it, and a ring while it waits. Pressing it opens
 * a card with the probabilities, the rule results and the timings.
 * Everything lives in one fixed layer on <body>, outside X's own markup.
 */
import { ACTION_LABELS, decide, evaluate, type Answers } from '../shared/rules';
import type { Check, ConditionNode, Settings } from '../shared/types';
import { SEL } from './dom';
import { visibleMsNow, type Trace } from './trace';

export interface PanelHost {
  settings(): Settings;
  /** Every check, for names. */
  checks(): Check[];
  /** The checks enabled rules ask about. */
  activeChecks(): Check[];
  answers(id: string): Answers;
  trace(id: string): Trace | undefined;
  revealed(id: string): boolean;
  maxFailures: number;
}

const GAP = 8;
const CARD_WIDTH = 320;

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

export type StatusKind = 'pass' | 'hidden' | 'action' | 'wait' | 'fail' | 'skip';

export interface Status {
  kind: StatusKind;
  text: string;
}

export const SYMBOLS: Record<StatusKind, string> = {
  pass: '✓',
  hidden: '✕',
  action: '✓',
  wait: '',
  fail: '!',
  skip: '–',
};

/**
 * Works out the status from the answers on every call, so it always matches the numbers shown.
 */
export function statusOf(host: PanelHost, t: Trace, now = Date.now()): Status {
  if (t.skip) return { kind: 'skip', text: `Skipped: ${t.skip}` };
  const checks = host.activeChecks();
  const a = host.answers(t.id);
  const complete = checks.length > 0 && checks.every((c) => a[c.id] !== undefined);
  if (complete) {
    const outcome = decide(host.settings(), a);
    if (outcome.hide) {
      return { kind: 'hidden', text: `${host.revealed(t.id) ? 'Shown on request, matched' : 'Hidden by'} "${outcome.hide.name}"` };
    }
    const act = t.actions.at(-1);
    if (act) return { kind: 'action', text: `Checked, ${act.kind} by "${act.rule}"` };
    if (outcome.like || outcome.bookmark) {
      const rule = (outcome.like ?? outcome.bookmark)!;
      return { kind: 'action', text: `Checked, ${outcome.like ? 'will like' : 'will bookmark'} once on screen ("${rule.name}")` };
    }
    return { kind: 'pass', text: 'Checked: no rule matched' };
  }
  const last = t.attempts.at(-1);
  if (last && last.doneAt === undefined) return { kind: 'wait', text: `Waiting for the server, ${ms(now - last.askedAt)}` };
  if (t.failures >= host.maxFailures && last?.error) return { kind: 'fail', text: `Failed: ${last.error}` };
  if (last?.error) return { kind: 'wait', text: `Will retry. Last error: ${last.error}` };
  return { kind: 'wait', text: 'Waiting to be sent' };
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
  const answers = host.answers(t.id);
  for (const c of host.activeChecks()) {
    const p = answers[c.id];
    lines.push([c.name, p === undefined ? 'no answer yet' : pct(p), 'rule']);
  }
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

interface Panel {
  root: HTMLElement;
  button: HTMLButtonElement;
  card: HTMLElement;
  body: HTMLElement;
  copy: HTMLButtonElement;
  open: boolean;
  sig: string;
}

let layer: HTMLElement | null = null;
let frame = 0;
const panels = new Map<string, Panel>();
const opened = new Set<string>();

function ensureLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'cf-test-layer';
  document.body.append(layer);
  return layer;
}

function createPanel(host: PanelHost, id: string): Panel {
  const root = document.createElement('div');
  root.className = 'cf-test';
  root.dataset.postId = id;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cf-test-button';
  const card = document.createElement('div');
  card.className = 'cf-test-card';
  const body = document.createElement('div');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'cf-test-copy';
  copy.textContent = 'Copy details';
  card.append(body, copy);
  root.append(button, card);

  const panel: Panel = { root, button, card, body, copy, open: opened.has(id), sig: '' };
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    panel.open = !panel.open;
    if (panel.open) opened.add(id);
    else opened.delete(id);
    panel.sig = '';
  });
  copy.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const t = host.trace(id);
    if (!t) return;
    const data = { ...t, status: statusOf(host, t).text, answers: host.answers(id), lines: linesFor(host, t) };
    void navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy details'), 1500);
    });
  });
  return panel;
}

function fillCard(host: PanelHost, t: Trace, status: Status, body: HTMLElement, now: number): void {
  const head = document.createElement('div');
  head.className = 'cf-test-status';
  head.textContent = status.text;
  const table = document.createElement('div');
  table.className = 'cf-test-lines';
  for (const [label, value, cls] of linesFor(host, t, now)) {
    const k = document.createElement('span');
    k.className = `cf-k${cls?.includes('rule') ? ' cf-rule' : ''}`;
    k.textContent = label;
    const v = document.createElement('span');
    v.className = `cf-v${cls?.includes('yes') ? ' cf-yes' : ''}`;
    v.textContent = value;
    table.append(k, v);
  }
  const text = document.createElement('div');
  text.className = 'cf-test-text';
  text.textContent = t.text ? `“${t.text.length > 200 ? `${t.text.slice(0, 200)}…` : t.text}”` : '';
  body.replaceChildren(head, table, text);
}

function update(host: PanelHost, t: Trace, panel: Panel, now: number): void {
  const status = statusOf(host, t, now);
  // Rebuild only when something visible changed; the clock part ticks once a second.
  const sig = `${status.kind}|${status.text}|${panel.open ? JSON.stringify(linesFor(host, t, Math.floor(now / 1000) * 1000)) : ''}`;
  if (sig === panel.sig) return;
  panel.sig = sig;
  panel.root.dataset.status = status.kind;
  panel.button.textContent = SYMBOLS[status.kind];
  panel.button.title = `${status.text}. Press for details.`;
  panel.button.setAttribute('aria-label', status.text);
  panel.button.setAttribute('aria-expanded', String(panel.open));
  panel.card.hidden = !panel.open;
  panel.root.classList.toggle('cf-open', panel.open);
  if (panel.open) fillCard(host, t, status, panel.body, now);
}

function place(cell: HTMLElement, panel: Panel): boolean {
  const r = cell.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.height === 0) return false;
  const roomRight = innerWidth - r.right - GAP;
  const left = roomRight >= 28 ? r.right + GAP : r.right - 32;
  const top = Math.min(Math.max(r.top + 10, 4), Math.max(4, r.bottom - 30));
  panel.root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  // Open the card toward the side with more room.
  panel.root.dataset.side = innerWidth - left >= CARD_WIDTH + 8 ? 'right' : 'left';
  return true;
}

function tick(host: PanelHost): void {
  frame = requestAnimationFrame(() => tick(host));
  const now = Date.now();
  const root = ensureLayer();
  const seen = new Set<string>();
  for (const cell of Array.from(document.querySelectorAll<HTMLElement>(`${SEL.cell}[data-cf-id]`))) {
    const id = cell.dataset.cfId!;
    const t = host.trace(id);
    if (!t || seen.has(id)) continue;
    let panel = panels.get(id);
    if (!panel) {
      panel = createPanel(host, id);
      panels.set(id, panel);
      root.append(panel.root);
    }
    update(host, t, panel, now);
    if (place(cell, panel)) seen.add(id);
  }
  for (const [id, panel] of panels) {
    if (!seen.has(id)) {
      panel.root.remove();
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
