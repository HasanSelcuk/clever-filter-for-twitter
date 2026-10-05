/** Where the decision model runs. */
export type ProviderId = 'typesafe' | 'ollaya' | 'custom' | 'community';

/**
 * Wire format a server speaks.
 * - `typesafe`: POST /v1/systemone, the format TypeSafe (Jev) defines and Ollaya mirrors.
 * - `ollaya`: POST /api/decide, Ollaya's native endpoint. It truncates long posts to fit the
 *   model's context and reports it, where /v1/systemone on Ollaya refuses them with 422.
 */
export type ApiStyle = 'typesafe' | 'ollaya';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  api: ApiStyle;
}

export interface BackendSettings {
  provider: ProviderId;
  typesafe: ProviderConfig;
  ollaya: ProviderConfig;
  custom: ProviderConfig;
  community: ProviderConfig;
}

/** A yes/no question asked about every post. Sent to the model as a `noul` question. */
export interface Check {
  id: string;
  name: string;
  question: string;
  /** Optional description of a "yes" answer. */
  yes: string;
  /** Optional description of a "no" answer. */
  no: string;
}

export interface CheckNode {
  kind: 'check';
  checkId: string;
  /** true reads the condition as "is not". */
  negate: boolean;
  /** Probability at or above which the check counts as yes. */
  threshold: number;
}

export interface GroupNode {
  kind: 'group';
  op: 'and' | 'or';
  negate: boolean;
  children: ConditionNode[];
}

export type ConditionNode = CheckNode | GroupNode;

export type ActionKind = 'hide' | 'bookmark' | 'like';

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  action: ActionKind;
  root: GroupNode;
  /** Set when the rule came from a quick start. */
  presetId?: string;
}

export type PageKind = 'home' | 'search' | 'profile' | 'replies' | 'lists' | 'other';

export interface Settings {
  version: 1;
  enabled: boolean;
  backend: BackendSettings;
  checks: Check[];
  rules: Rule[];
  pages: Record<Exclude<PageKind, 'other'>, boolean>;
  display: {
    /** `label` collapses the post to a one-line note; `remove` leaves no trace. */
    hiddenStyle: 'label' | 'remove';
    /** Plays the scan and collapse animation when a visible post gets filtered. */
    animation: boolean;
  };
  actions: {
    /** The person accepted the risk note for automatic likes. */
    likeRiskAccepted: boolean;
    dailyLikeLimit: number;
    dailyBookmarkLimit: number;
    /** Seconds between two automatic likes or bookmarks. */
    gapSeconds: number;
    /** Seconds a post must stay on screen before it gets liked or bookmarked. */
    dwellSeconds: number;
  };
}

/** A noul question in the wire format both APIs share. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

/** The state sent for one post. Question text refers to its fields in backticks. */
export interface PostState {
  post: string;
  quoted_post?: string;
}

export interface DayStats {
  date: string;
  checked: number;
  hidden: number;
  liked: number;
  bookmarked: number;
}
