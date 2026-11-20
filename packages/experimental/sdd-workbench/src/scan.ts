/** Pure folds over mai-specs directory contents: ROADMAP sections, BRIEF headers, feature summaries. */
import type { SddArtifacts, SddFeatureSummary } from './types.ts'
import { ARTIFACT_SLOTS, FEATURE_DIR_PATTERN } from './layout.ts'

/** Directory entry as the scanner sees it, narrowed to what folding needs. */
export interface ScanEntry {
  /** Entry name within its parent directory. */
  readonly name: string
  /** Whether the entry is a directory (symlink-followed). */
  readonly directory: boolean
}

/** Roadmap section headings recognized in `ROADMAP.md`, mapped to stable wire values. */
const ROADMAP_SECTIONS: readonly [heading: string, section: 'planned' | 'active' | 'done'][] = [
  ['规划中', 'planned'],
  ['进行中', 'active'],
  ['已完成', 'done'],
]

/**
 * Fold `ROADMAP.md` into a number-to-section map. Malformed tables contribute nothing;
 * an unrecognizable document yields an empty map (BR-03 degradation).
 * @param markdown - ROADMAP.md content, or undefined when absent.
 * @returns first-section-wins mapping from three-digit feature numbers to sections.
 */
export function parseRoadmap(markdown: string | undefined): Map<string, 'planned' | 'active' | 'done'> {
  const out = new Map<string, 'planned' | 'active' | 'done'>()
  if (markdown === undefined) return out
  let current: 'planned' | 'active' | 'done' | null = null
  for (const line of markdown.split('\n')) {
    const heading = /^##\s*(.+?)\s*$/.exec(line)
    if (heading !== null) {
      const [, sectionHeading] = heading
      current = ROADMAP_SECTIONS.find(([label]) => label === sectionHeading)?.[1] ?? null
      continue
    }
    if (current === null) continue
    const row = /^\|\s*(\d{3})\s*\|/.exec(line)
    if (row !== null && row[1] !== undefined && !out.has(row[1])) out.set(row[1], current)
  }
  return out
}

/** Header fields extracted from a BRIEF.md prefix. */
export interface BriefHeader {
  /** First ATX level-1 heading text with markup noise removed; null when absent. */
  readonly title: string | null
  /** Raw Phase cell value from the two-column metadata table; null when absent. */
  readonly phase: string | null
}

/**
 * Read the BRIEF.md title and Phase without assuming more than the template's loose conventions.
 * Fenced code blocks are skipped so example headings inside them do not match (stage-contract rule).
 * @param markdown - leading bytes of BRIEF.md decoded as text, or undefined when unreadable.
 * @returns whichever header fields were found.
 */
export function parseBriefHeader(markdown: string | undefined): BriefHeader {
  if (markdown === undefined) return { title: null, phase: null }
  let title: string | null = null
  let phase: string | null = null
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (title === null) {
      const heading = /^#\s+(.+?)\s*$/.exec(line)
      if (heading !== null && heading[1] !== undefined) title = cleanHeading(heading[1])
    }
    if (phase === null) {
      const row = /^\|\s*Phase\s*\|\s*(.+?)\s*\|\s*$/i.exec(line)
      if (row !== null) {
        const value = (row[1] ?? '').replace(/^`+|`+$/g, '').trim()
        phase = value.length > 0 ? value : null
      }
    }
    if (title !== null && phase !== null) break
  }
  return { title, phase }
}

/** Strip leading numeric prefixes ("999: ") and emphasis markers from a heading. */
function cleanHeading(raw: string): string {
  return raw.replace(/^\d+[:：]\s*/, '').replace(/[*_`]/g, '').trim()
}

/**
 * Fold one feature directory into a summary.
 * @param entryName - directory name under mai-specs.
 * @param files - set of feature-relative file paths discovered by shallow listing.
 * @param header - parsed BRIEF header, or undefined when BRIEF.md is missing/unreadable.
 * @param roadmap - number-to-section map from parseRoadmap.
 * @returns the wire summary; non-conforming names sort after numbered features via `number: null`.
 */
export function foldFeature(
  entryName: string,
  files: ReadonlySet<string>,
  header: BriefHeader | undefined,
  roadmap: ReadonlyMap<string, 'planned' | 'active' | 'done'>,
): SddFeatureSummary {
  const match = FEATURE_DIR_PATTERN.exec(entryName)
  const number = match?.[1] ?? null
  const slug = match?.[2] ?? entryName
  const found = Object.fromEntries(ARTIFACT_SLOTS.map(({ slot, candidates }) => [
    slot, candidates.find(candidate => files.has(candidate)) ?? null,
  ])) as Record<keyof SddArtifacts, string | null>
  return {
    id: entryName,
    number,
    slug,
    title: header?.title ?? slug,
    phase: header?.phase ?? null,
    roadmapSection: number === null ? null : roadmap.get(number) ?? null,
    artifacts: found,
    materials: [...files].filter(path => path.startsWith('context/') && path.endsWith('.md') && !path.slice('context/'.length).includes('/')).sort(),
  }
}

/** True when a top-level mai-specs entry names a feature workspace directory (conforming or not). */
export function isFeatureDir(entry: ScanEntry): boolean {
  return entry.directory && !entry.name.startsWith('_') && !entry.name.startsWith('.')
}
