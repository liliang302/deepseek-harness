/** Wire contract between the SDD Workbench Host service and its Client panel. */

/** One SDD Feature directory as discovered under `<root>/mai-specs/`. */
export interface SddFeatureSummary {
  /** Directory name, e.g. `999-sdd-workbench-panel`; also the featureId for document reads. */
  readonly id: string
  /** Three-digit prefix; null when the directory does not follow the `NNN-slug` convention. */
  readonly number: string | null
  /** Slug part of the directory name, or the whole name for non-conforming directories. */
  readonly slug: string
  /** First-level heading of BRIEF.md with markup noise removed; falls back to the slug. */
  readonly title: string
  /** Raw Phase cell from the BRIEF metadata table (draft/spec/design/dev/review/done…); null when absent. */
  readonly phase: string | null
  /** ROADMAP section the feature number is registered in; null when unregistered. */
  readonly roadmapSection: 'planned' | 'active' | 'done' | null
  /** Relative paths of the five stage artifacts inside the feature directory; null when missing. */
  readonly artifacts: SddArtifacts
  /** Markdown file names directly under `context/`, offered as material tabs. */
  readonly materials: readonly string[]
}

/** The five stage-artifact slots a feature can fill, each an intra-feature relative path. */
export interface SddArtifacts {
  readonly brief: string | null
  readonly prd: string | null
  readonly design: string | null
  readonly review: string | null
  readonly test: string | null
}

/** Result of one workspace scan. */
export interface SddScanResult {
  /** Absolute workspace root that was scanned (display only). */
  readonly root: string
  /** Whether `<root>/mai-specs` exists. */
  readonly specsDirExists: boolean
  /** Features ordered by directory name; non-conforming directories sort last. */
  readonly features: readonly SddFeatureSummary[]
}

/** One document read through the confined mai-specs surface. */
export interface SddDocument {
  /** Requested feature-relative path. */
  readonly path: string
  /** UTF-8 body, cut at the configured byte cap. */
  readonly text: string
  /** True when the body was cut before the file end. */
  readonly truncated: boolean
}
