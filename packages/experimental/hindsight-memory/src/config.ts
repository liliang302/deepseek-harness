/**
 * Configuration schema and value-range normalization. The Loader validates
 * types at plugin load (fail loud); {@link normalizeConfig} only normalizes
 * value ranges: trailing slashes, tag cleanup, integer floors.
 *
 * @module @deepseek-ai/dsh-hindsight-memory/config
 */

import type { HindsightMemoryConfig } from './types.ts'

/** Default configuration; every key is documented in README.md「Configuration」. */
export const DEFAULTS = Object.freeze({
  /** Self-hosted Hindsight base URL (personal default; production deployments must set explicitly). */
  url: 'http://127.0.0.1:8888',
  /** Memory bank id. */
  bank: 'hermes',
  /** USER store char budget, aligned with Hermes user_char_limit. */
  userCharLimit: 1375,
  /** MEMORY store char budget, aligned with Hermes memory_char_limit. */
  memoryCharLimit: 2200,
  /** Frozen snapshot at the first step of each session. */
  snapshot: true,
  /** Per-turn semantic recall after the first turn. */
  autoRecall: true,
  /** Semantic recall token budget. */
  recallTokens: 800,
  /** Retain each finished turn as a mem:session document. */
  autoRetain: true,
  /** Skip retention below this combined turn length. */
  retainMinChars: 120,
  /** Max chars retained per turn. */
  maxRetainChars: 6000,
  /** Nudge every N turns; 0 disables. */
  nudgeInterval: 10,
  /** Base tags on every write. */
  tags: Object.freeze(['dsh']),
  /** Recall / document read timeout. */
  timeoutMs: 8000,
  /** Retain / delete timeout (server-side extraction needs seconds). */
  retainTimeoutMs: 30000,
  /** Single-entry char cap. */
  maxEntryChars: 2200,
  /** Total injected-text char cap. */
  maxInjectedChars: 6000,
  /** Screen writes for secrets and prompt injection. */
  protectSecrets: true,
  /** Max entries read for the session snapshot. */
  maxEntries: 200,
})

/** Loader-validated plugin configuration; every field carries a default. */
export type Config = HindsightMemoryConfig

/**
 * Normalize loader-validated configuration to runtime values. Types are
 * already guaranteed by {@link Config}; this only trims URLs, cleans tags,
 * and floors numeric keys.
 * @param raw - validated plugin configuration (possibly partial before defaults apply).
 * @returns the complete runtime configuration.
 */
export function normalizeConfig(raw: Partial<Config>): HindsightMemoryConfig {
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.filter(tag => typeof tag === 'string' && tag.trim().length > 0).map(tag => tag.trim()))]
    : [...DEFAULTS.tags]
  return {
    url: raw.url !== undefined && raw.url.trim().length > 0 ? raw.url.trim().replace(/\/+$/, '') : DEFAULTS.url,
    bank: raw.bank !== undefined && raw.bank.trim().length > 0 ? raw.bank.trim() : DEFAULTS.bank,
    userCharLimit: Math.floor(raw.userCharLimit ?? DEFAULTS.userCharLimit),
    memoryCharLimit: Math.floor(raw.memoryCharLimit ?? DEFAULTS.memoryCharLimit),
    snapshot: raw.snapshot !== false,
    autoRecall: raw.autoRecall !== false,
    recallTokens: Math.floor(raw.recallTokens ?? DEFAULTS.recallTokens),
    autoRetain: raw.autoRetain !== false,
    retainMinChars: Math.floor(raw.retainMinChars ?? DEFAULTS.retainMinChars),
    maxRetainChars: Math.floor(raw.maxRetainChars ?? DEFAULTS.maxRetainChars),
    nudgeInterval: Math.floor(raw.nudgeInterval ?? DEFAULTS.nudgeInterval),
    tags,
    timeoutMs: Math.floor(raw.timeoutMs ?? DEFAULTS.timeoutMs),
    retainTimeoutMs: Math.floor(raw.retainTimeoutMs ?? DEFAULTS.retainTimeoutMs),
    maxEntryChars: Math.floor(raw.maxEntryChars ?? DEFAULTS.maxEntryChars),
    maxInjectedChars: Math.floor(raw.maxInjectedChars ?? DEFAULTS.maxInjectedChars),
    protectSecrets: raw.protectSecrets !== false,
    maxEntries: Math.floor(raw.maxEntries ?? DEFAULTS.maxEntries),
  }
}

/**
 * Char budget of one curated target.
 * @param config - runtime configuration.
 * @param target - curated library.
 * @returns the configured char limit for that library.
 */
export function charLimitFor(config: HindsightMemoryConfig, target: 'user' | 'memory'): number {
  return target === 'user' ? config.userCharLimit : config.memoryCharLimit
}
