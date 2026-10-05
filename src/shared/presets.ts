import type { ActionKind, Check, GroupNode, Rule } from './types';
import { newId } from './ids';

/** Fixed ids so that adding two presets that share a check reuses it. */
export const PRESET_CHECKS: Record<string, Check> = {
  'ai-slop': {
    id: 'ai-slop',
    name: 'AI slop',
    question: 'Is `post` generic, low-effort text that reads like it was produced by an AI model?',
    yes: 'Filler phrases, buzzwords, listicle tone, vague claims, emoji bullet points, no personal detail',
    no: 'Specific, personal or clearly written by a person',
  },
  'hard-to-read': {
    id: 'hard-to-read',
    name: 'Hard to read',
    question: 'Is `post` hard to read?',
    yes: 'A wall of text, broken grammar, unclear point, or jumbled formatting',
    no: 'Clear and easy to follow',
  },
  'engagement-bait': {
    id: 'engagement-bait',
    name: 'Engagement bait',
    question: 'Does `post` mainly ask for likes, replies, reposts or follows?',
    yes: 'Like if you agree, reply with an emoji, follow for more, comment a word to get a link',
    no: 'Shares something without fishing for reactions',
  },
  'rage-bait': {
    id: 'rage-bait',
    name: 'Rage bait',
    question: 'Is `post` written to make readers angry?',
    yes: 'Provokes outrage on purpose, insults a group, frames things to start a fight',
    no: 'Calm, informative or friendly, even when it disagrees',
  },
  'hostile': {
    id: 'hostile',
    name: 'Insults or harassment',
    question: 'Does `post` insult, harass or threaten someone?',
    yes: 'Name-calling, slurs, threats, piling on a person',
    no: 'No attacks on anyone',
  },
  'scam': {
    id: 'scam',
    name: 'Giveaways and scams',
    question: 'Does `post` promote a giveaway, airdrop, crypto pump or a get-rich-quick offer?',
    yes: 'Free money, airdrops, DM me to earn, guaranteed returns',
    no: 'No such offer',
  },
  'useful-resource': {
    id: 'useful-resource',
    name: 'Useful resource',
    question: 'Does `post` teach something or share a resource worth coming back to?',
    yes: 'A how-to, a guide, a thread of tips, a tool, a paper or a reference',
    no: 'Chat, news, opinions or jokes',
  },
  'thoughtful': {
    id: 'thoughtful',
    name: 'Thoughtful post',
    question: 'Is `post` an original, thoughtful point written by a person?',
    yes: 'Makes a specific, considered point in the author\'s own words',
    no: 'Low effort, a repost of common takes, an ad or a joke',
  },
};

export interface PresetCondition {
  checkId: keyof typeof PRESET_CHECKS;
  negate?: boolean;
  threshold?: number;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  action: ActionKind;
  op: 'and' | 'or';
  conditions: PresetCondition[];
}

export const PRESETS: Preset[] = [
  {
    id: 'ai-slop',
    name: 'AI slop',
    description: 'Hides posts that read like generic AI-written text.',
    action: 'hide',
    op: 'and',
    conditions: [{ checkId: 'ai-slop' }],
  },
  {
    id: 'messy-ai',
    name: 'Messy AI posts',
    description: 'Hides posts that are AI slop and also hard to read.',
    action: 'hide',
    op: 'and',
    conditions: [{ checkId: 'ai-slop', threshold: 0.7 }, { checkId: 'hard-to-read', threshold: 0.7 }],
  },
  {
    id: 'engagement-bait',
    name: 'Engagement bait',
    description: 'Hides posts that fish for likes, replies and follows.',
    action: 'hide',
    op: 'and',
    conditions: [{ checkId: 'engagement-bait' }],
  },
  {
    id: 'calm-feed',
    name: 'Calm feed',
    description: 'Hides rage bait and posts that insult or harass people.',
    action: 'hide',
    op: 'or',
    conditions: [{ checkId: 'rage-bait' }, { checkId: 'hostile' }],
  },
  {
    id: 'scams',
    name: 'Giveaways and scams',
    description: 'Hides airdrops, crypto pumps and get-rich-quick offers.',
    action: 'hide',
    op: 'and',
    conditions: [{ checkId: 'scam' }],
  },
  {
    id: 'save-resources',
    name: 'Save useful posts',
    description: 'Bookmarks guides, tools and references, skipping AI slop.',
    action: 'bookmark',
    op: 'and',
    conditions: [{ checkId: 'useful-resource', threshold: 0.85 }, { checkId: 'ai-slop', negate: true }],
  },
  {
    id: 'like-thoughtful',
    name: 'Like thoughtful posts',
    description: 'Likes original, thoughtful posts that you scroll past.',
    action: 'like',
    op: 'and',
    conditions: [{ checkId: 'thoughtful', threshold: 0.9 }, { checkId: 'ai-slop', negate: true }],
  },
];

export const DEFAULT_THRESHOLD = 0.8;

/** Builds the checks and the rule a preset adds, reusing checks that already exist. */
export function applyPreset(preset: Preset, existing: Check[]): { checks: Check[]; rule: Rule } {
  const checks = [...existing];
  for (const c of preset.conditions) {
    const check = PRESET_CHECKS[c.checkId];
    if (check && !checks.some((x) => x.id === check.id)) checks.push({ ...check });
  }
  const root: GroupNode = {
    kind: 'group',
    op: preset.op,
    negate: false,
    children: preset.conditions.map((c) => ({
      kind: 'check',
      checkId: c.checkId,
      negate: c.negate ?? false,
      threshold: c.threshold ?? DEFAULT_THRESHOLD,
    })),
  };
  return {
    checks,
    rule: { id: newId(), name: preset.name, enabled: true, action: preset.action, root, presetId: preset.id },
  };
}
