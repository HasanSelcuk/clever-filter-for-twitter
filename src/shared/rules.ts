import { hash } from './ids';
import type { ActionKind, Check, ConditionNode, NoulQuestion, Rule, Settings } from './types';

/** Probability that each check's statement holds, keyed by check id. */
export type Answers = Record<string, number>;

/**
 * Identifies a check by its wording. Editing a question changes the key, so cached answers to
 * the old wording are not reused.
 */
export function checkKey(check: Check): string {
  return hash(`${check.question}\u0000${check.yes}\u0000${check.no}`);
}

export function toQuestion(check: Check): NoulQuestion {
  const q: NoulQuestion = { type: 'noul', instructions: check.question.trim() };
  const yes = check.yes.trim();
  const no = check.no.trim();
  if (yes || no) {
    q.criteria = {};
    if (yes) q.criteria.true = yes;
    if (no) q.criteria.false = no;
  }
  return q;
}

/** Check ids a condition tree refers to. */
export function checkIdsOf(node: ConditionNode, out = new Set<string>()): Set<string> {
  if (node.kind === 'check') out.add(node.checkId);
  else for (const child of node.children) checkIdsOf(child, out);
  return out;
}

/** Checks that enabled rules need, in the order they appear in the check list. */
export function activeChecks(settings: Settings): Check[] {
  const ids = new Set<string>();
  for (const rule of settings.rules) {
    if (rule.enabled && isRunnable(rule, settings)) checkIdsOf(rule.root, ids);
  }
  return settings.checks.filter((c) => ids.has(c.id) && c.question.trim() !== '');
}

/** A rule runs only when it has at least one condition and every check it names exists. */
export function isRunnable(rule: Rule, settings: Settings): boolean {
  const ids = checkIdsOf(rule.root);
  if (ids.size === 0) return false;
  for (const id of ids) {
    const check = settings.checks.find((c) => c.id === id);
    if (!check || check.question.trim() === '') return false;
  }
  if (rule.action === 'like' && !settings.actions.likeRiskAccepted) return false;
  return true;
}

/**
 * Evaluates a condition. Returns `undefined` when an answer it needs is missing.
 * An empty group counts as false, so a half-built rule never fires.
 */
export function evaluate(node: ConditionNode, answers: Answers): boolean | undefined {
  let value: boolean | undefined;
  if (node.kind === 'check') {
    const p = answers[node.checkId];
    if (p === undefined) return undefined;
    value = p >= node.threshold;
  } else {
    if (node.children.length === 0) return false;
    let unknown = false;
    value = node.op === 'and';
    for (const child of node.children) {
      const v = evaluate(child, answers);
      if (v === undefined) {
        unknown = true;
        continue;
      }
      if (node.op === 'and' && !v) {
        value = false;
        unknown = false;
        break;
      }
      if (node.op === 'or' && v) {
        value = true;
        unknown = false;
        break;
      }
    }
    if (unknown) return undefined;
  }
  return node.negate ? !value : value;
}

export interface Outcome {
  hide?: Rule;
  bookmark?: Rule;
  like?: Rule;
}

/** The first matching enabled rule for each action. */
export function decide(settings: Settings, answers: Answers): Outcome {
  const outcome: Outcome = {};
  for (const rule of settings.rules) {
    if (!rule.enabled || outcome[rule.action] || !isRunnable(rule, settings)) continue;
    if (evaluate(rule.root, answers) === true) outcome[rule.action] = rule;
  }
  return outcome;
}

/** Plain-language summary of a rule, used in labels and tooltips. */
export function describe(node: ConditionNode, checks: Check[], top = true): string {
  if (node.kind === 'check') {
    const name = checks.find((c) => c.id === node.checkId)?.name ?? 'missing check';
    return node.negate ? `not ${name}` : name;
  }
  const parts = node.children.map((c) => describe(c, checks, false));
  const joined = parts.join(node.op === 'and' ? ' and ' : ' or ');
  const wrapped = !top && parts.length > 1 ? `(${joined})` : joined;
  return node.negate ? `not ${parts.length > 1 ? `(${joined})` : joined}` : wrapped;
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  hide: 'Hide',
  bookmark: 'Bookmark',
  like: 'Like',
};
