/** my-ai-infra SDD layout constants: the single maintenance point for artifact discovery. */

/** Project-relative directory holding all SDD feature workspaces. */
export const SPECS_DIR = 'mai-specs'

/** One feature workspace directory: three-digit number, hyphen, slug. */
export const FEATURE_DIR_PATTERN = /^(\d{3})-([\w.-]+)$/

/** Stage artifacts probed inside a feature directory, in tab order.
 * Each entry lists candidate relative paths; the first existing one wins.
 */
export const ARTIFACT_SLOTS: readonly { readonly slot: 'brief' | 'prd' | 'design' | 'review' | 'test'; readonly candidates: readonly string[] }[] = [
  { slot: 'brief', candidates: ['BRIEF.md'] },
  { slot: 'prd', candidates: ['spec/PRD.md'] },
  { slot: 'design', candidates: ['design/TECH_DESIGN.md'] },
  { slot: 'review', candidates: ['review/DESIGN_REVIEW.md', 'review/CODE_REVIEW.md'] },
  { slot: 'test', candidates: ['test/TEST_PLAN.md', 'ACCEPTANCE.md', 'test/ACCEPTANCE.md'] },
]

/** Subdirectories scanned one level deep during a feature listing. */
export const KNOWN_SUBDIRS: readonly string[] = ['spec', 'design', 'review', 'test', 'context']

/** First path segment a document read may start with (BR-02 allowlist). */
export const READABLE_ROOTS: readonly string[] = ['BRIEF.md', 'spec', 'design', 'review', 'test', 'context']
