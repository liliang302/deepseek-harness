/** Path confinement for document reads: only `.md` files inside a feature's known stage directories. */
import { READABLE_ROOTS } from './layout.ts'

/** Feature directory name gate: no separators, no dot segments, filesystem-safe characters only. */
const FEATURE_ID_PATTERN = /^[\w.-]+$/

/**
 * Validate and join one document request against `<root>/mai-specs/<featureId>/`.
 * Rejects absolute paths, backslashes, empty/dot/dot-dot segments, non-`.md` targets,
 * and first segments outside the stage allowlist (PRD BR-02). Symlink escape is caught
 * separately by the caller through resolved-path containment.
 * @param featureId - feature directory name as reported by scan.
 * @param relPath - feature-relative document path requested by the Client.
 * @returns the validated `featureId/relPath` join, or null when the request must be refused.
 */
export function confineSpecPath(featureId: string, relPath: string): string | null {
  if (!FEATURE_ID_PATTERN.test(featureId) || featureId === '.' || featureId === '..' || featureId.startsWith('.')) return null
  if (!relPath.endsWith('.md') || relPath.length <= 3) return null
  if (relPath.startsWith('/') || relPath.includes('\\')) return null
  const segments = relPath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  const head = segments[0]
  if (head === undefined || !READABLE_ROOTS.includes(head)) return null
  return `${featureId}/${relPath}`
}
