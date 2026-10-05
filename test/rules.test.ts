import { describe, expect, it } from 'vitest';
import { applyPreset, PRESETS } from '../src/shared/presets';
import { activeChecks, checkKey, decide, describe as describeRule, evaluate, isRunnable, toQuestion } from '../src/shared/rules';
import { defaultSettings } from '../src/shared/settings';
import type { Check, CheckNode, GroupNode, Rule, Settings } from '../src/shared/types';

const c = (checkId: string, threshold = 0.8, negate = false): CheckNode => ({ kind: 'check', checkId, threshold, negate });
const g = (op: 'and' | 'or', children: GroupNode['children'], negate = false): GroupNode => ({ kind: 'group', op, negate, children });
const check = (id: string, name = id): Check => ({ id, name, question: `Is \`post\` ${name}?`, yes: '', no: '' });

function withRules(rules: Rule[], checks: Check[]): Settings {
  const s = defaultSettings();
  s.checks = checks;
  s.rules = rules;
  return s;
}

describe('evaluate', () => {
  it('compares a probability with the threshold', () => {
    expect(evaluate(c('a'), { a: 0.8 })).toBe(true);
    expect(evaluate(c('a'), { a: 0.79 })).toBe(false);
    expect(evaluate(c('a', 0.8, true), { a: 0.9 })).toBe(false);
  });

  it('joins with AND and OR', () => {
    const and = g('and', [c('a'), c('b')]);
    const or = g('or', [c('a'), c('b')]);
    expect(evaluate(and, { a: 0.9, b: 0.9 })).toBe(true);
    expect(evaluate(and, { a: 0.9, b: 0.1 })).toBe(false);
    expect(evaluate(or, { a: 0.1, b: 0.9 })).toBe(true);
    expect(evaluate(or, { a: 0.1, b: 0.1 })).toBe(false);
  });

  it('reverses a group with NOT', () => {
    expect(evaluate(g('or', [c('a'), c('b')], true), { a: 0.1, b: 0.1 })).toBe(true);
  });

  it('nests groups', () => {
    // a AND (b OR NOT c)
    const tree = g('and', [c('a'), g('or', [c('b'), c('c', 0.8, true)])]);
    expect(evaluate(tree, { a: 0.9, b: 0.1, c: 0.1 })).toBe(true);
    expect(evaluate(tree, { a: 0.9, b: 0.1, c: 0.9 })).toBe(false);
    expect(evaluate(tree, { a: 0.1, b: 0.9, c: 0.1 })).toBe(false);
  });

  it('reports unknown only when the missing answer matters', () => {
    expect(evaluate(g('and', [c('a'), c('b')]), { a: 0.9 })).toBeUndefined();
    expect(evaluate(g('and', [c('a'), c('b')]), { a: 0.1 })).toBe(false);
    expect(evaluate(g('or', [c('a'), c('b')]), { a: 0.9 })).toBe(true);
  });

  it('treats an empty group as no match', () => {
    expect(evaluate(g('and', []), {})).toBe(false);
  });
});

describe('decide', () => {
  const checks = [check('slop'), check('hard')];
  const hideRule: Rule = { id: 'r1', name: 'Slop', enabled: true, action: 'hide', root: g('and', [c('slop'), c('hard')]) };
  const likeRule: Rule = { id: 'r2', name: 'Good', enabled: true, action: 'like', root: g('and', [c('slop', 0.5, true)]) };

  it('picks the first matching rule per action', () => {
    const s = withRules([hideRule, likeRule], checks);
    s.actions.likeRiskAccepted = true;
    expect(decide(s, { slop: 0.9, hard: 0.9 }).hide?.id).toBe('r1');
    expect(decide(s, { slop: 0.1, hard: 0.1 }).like?.id).toBe('r2');
  });

  it('skips like rules until the risk note is accepted', () => {
    const s = withRules([likeRule], checks);
    expect(isRunnable(likeRule, s)).toBe(false);
    expect(decide(s, { slop: 0.1 }).like).toBeUndefined();
  });

  it('skips disabled rules and rules with missing checks', () => {
    const off = { ...hideRule, enabled: false };
    const broken: Rule = { ...hideRule, id: 'r3', root: g('and', [c('gone')]) };
    const s = withRules([off, broken], checks);
    expect(decide(s, { slop: 0.9, hard: 0.9 }).hide).toBeUndefined();
    expect(activeChecks(s)).toEqual([]);
  });

  it('asks only the checks enabled rules use', () => {
    const s = withRules([{ ...hideRule, root: g('and', [c('hard')]) }], checks);
    expect(activeChecks(s).map((x) => x.id)).toEqual(['hard']);
  });
});

describe('questions', () => {
  it('builds a noul question with optional criteria', () => {
    expect(toQuestion({ id: 'a', name: 'A', question: ' Is `post` spam? ', yes: '', no: '' })).toEqual({
      type: 'noul',
      instructions: 'Is `post` spam?',
    });
    expect(toQuestion({ id: 'a', name: 'A', question: 'Q', yes: 'Y', no: '' })).toEqual({
      type: 'noul',
      instructions: 'Q',
      criteria: { true: 'Y' },
    });
  });

  it('changes the cache key when the wording changes', () => {
    const a = check('x');
    expect(checkKey(a)).toBe(checkKey({ ...a, name: 'renamed' }));
    expect(checkKey(a)).not.toBe(checkKey({ ...a, question: 'Other?' }));
  });

  it('describes a rule in words', () => {
    const checks = [check('a', 'AI slop'), check('b', 'Hard to read'), check('c', 'Spam')];
    expect(describeRule(g('and', [c('a'), g('or', [c('b'), c('c', 0.8, true)])]), checks)).toBe(
      'AI slop and (Hard to read or not Spam)',
    );
  });
});

describe('presets', () => {
  it('adds checks once and builds runnable rules', () => {
    let s = defaultSettings();
    s.actions.likeRiskAccepted = true;
    for (const p of PRESETS) {
      const { checks, rule } = applyPreset(p, s.checks);
      s = { ...s, checks, rules: [...s.rules, rule] };
      expect(isRunnable(rule, s)).toBe(true);
    }
    const ids = s.checks.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
