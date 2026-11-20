/**
 * Pure-type outlet of the hindsight-memory plugin: configuration, curated
 * store results, and recall views. Structured action branches on
 * {@link StoreResult} keep every field present-or-absent (never `undefined`)
 * so tool return values stay lossless JSON.
 *
 * @module @deepseek-ai/dsh-hindsight-memory/types
 */

/** Curated memory target library (`user` = who the user is, `memory` = working environment). */
export type MemoryTarget = 'user' | 'memory'

/** Normalized plugin configuration (18 keys; see cordis.patch.yml for defaults). */
export interface HindsightMemoryConfig {
  /** Self-hosted Hindsight base URL without a trailing slash. */
  url: string
  /** Memory bank id. */
  bank: string
  /** Char budget of the USER store (Hermes user_char_limit). */
  userCharLimit: number
  /** Char budget of the MEMORY store (Hermes memory_char_limit). */
  memoryCharLimit: number
  /** Inject the frozen snapshot at the first step of each session. */
  snapshot: boolean
  /** Run a semantic recall after the first turn. */
  autoRecall: boolean
  /** Token budget for semantic recall. */
  recallTokens: number
  /** Retain each finished turn as a mem:session document. */
  autoRetain: boolean
  /** Skip retention when the combined turn text is shorter than this many chars. */
  retainMinChars: number
  /** Max chars retained per turn. */
  maxRetainChars: number
  /** Nudge the model to review memory every N turns; 0 disables. */
  nudgeInterval: number
  /** Base tags attached to every write. */
  tags: string[]
  /** Timeout for recall / document reads. */
  timeoutMs: number
  /** Timeout for retain / delete (server-side extraction takes seconds). */
  retainTimeoutMs: number
  /** Max chars of a single curated entry. */
  maxEntryChars: number
  /** Total char cap for injected context text. */
  maxInjectedChars: number
  /** Screen writes for credentials and prompt-injection text. */
  protectSecrets: boolean
  /** Max entries read for the session snapshot. */
  maxEntries: number
}

/** One curated entry (document view). */
export interface MemoryEntry {
  /** Hindsight document id. */
  readonly id: string
  /** Trimmed original text. */
  readonly content: string
  /** Char count of {@link content}. */
  readonly chars: number
  /** ISO creation timestamp from the document. */
  readonly createdAt: string
}

/** One side's char occupancy against its budget. */
export interface UsageSide {
  /** Used chars. */
  readonly chars: number
  /** Budget in chars. */
  readonly limit: number
  /** Entry count. */
  readonly count: number
}

/** Both stores' occupancy. */
export interface UsagePair {
  /** USER store usage. */
  readonly user: UsageSide
  /** MEMORY store usage. */
  readonly memory: UsageSide
}

/** Both stores loaded (snapshot input). */
export interface LoadedStores {
  /** USER entries, oldest first. */
  readonly user: readonly MemoryEntry[]
  /** MEMORY entries, oldest first. */
  readonly memory: readonly MemoryEntry[]
  /** Combined occupancy. */
  readonly usage: UsagePair
}

/** Rejected-write failure vocabulary (security screen and length checks). */
export type FailureKind =
  | 'secret'
  | 'injection'
  | 'empty'
  | 'too_long'
  | 'over_budget'
  | 'no_match'

/** Result of locating an entry with a unique fragment. */
export type MatchResult =
  | { readonly entry: MemoryEntry }
  | { readonly reason: string }

/** Content-screen verdict. */
export type InspectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'secret' | 'injection' | 'empty'; readonly reason: string }

/** Length-check verdict. */
export type InspectLengthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'too_long'; readonly reason: string; readonly limit: number }

/** Successful `add` result. */
export interface AddSuccess {
  readonly ok: true
  readonly action: 'add'
  readonly target: MemoryTarget
  readonly entry: { readonly id: string; readonly content: string }
  readonly entries: readonly MemoryEntry[]
}

/** Successful `replace` result; the old document was deleted after the new write landed. */
export interface ReplaceSuccess {
  readonly ok: true
  readonly action: 'replace'
  readonly target: MemoryTarget
  readonly entry: { readonly id: string; readonly content: string }
  readonly replaced: MemoryEntry
  readonly entries: readonly MemoryEntry[]
}

/** Successful `remove` result. */
export interface RemoveSuccess {
  readonly ok: true
  readonly action: 'remove'
  readonly target: MemoryTarget
  readonly removed: MemoryEntry
  readonly deletedUnits: number
  readonly entries: readonly MemoryEntry[]
}

/** Failed store operation with the current entries for follow-up decisions. */
export interface StoreFailure {
  readonly ok: false
  readonly kind: FailureKind
  readonly reason: string
  readonly entries?: readonly MemoryEntry[]
  readonly usage?: UsageSide
}

/** Any curated-store operation result. */
export type StoreResult = AddSuccess | ReplaceSuccess | RemoveSuccess | StoreFailure

/** `remove` outcome: the success shape carries the removed entry for consumers. */
export type RemoveOutcome = RemoveSuccess | StoreFailure

/** One recalled fact. */
export interface RecallFact {
  /** Fact id. */
  readonly id: string
  /** Trimmed fact text. */
  readonly text: string
  /** Fact tags. */
  readonly tags: readonly string[]
  /** Hindsight fact type label. */
  readonly factType: string
}

/** Per-session projection state folded from the durable Session log. */
export interface HindsightProjectionState {
  /** Whether this session already carries a durable snapshot injection. */
  snapshotInjected: boolean
  /** Latest turn whose user message came from a real human prompt (not an injection). */
  lastRealTurn: number
  /** Turn numbers already retained into Hindsight. */
  retainedTurns: number[]
}
