/** Document path confinement: only stage-allowlisted .md files inside a feature directory pass. */
import { expect, it } from 'vitest'
import { confineSpecPath } from '../src/docs.ts'

it('accepts brief and stage-directory markdown', () => {
  expect(confineSpecPath('999-demo', 'BRIEF.md')).toBe('999-demo/BRIEF.md')
  expect(confineSpecPath('999-demo', 'spec/PRD.md')).toBe('999-demo/spec/PRD.md')
  expect(confineSpecPath('999-demo', 'design/TECH_DESIGN.md')).toBe('999-demo/design/TECH_DESIGN.md')
  expect(confineSpecPath('999-demo', 'review/DESIGN_REVIEW.md')).toBe('999-demo/review/DESIGN_REVIEW.md')
  expect(confineSpecPath('999-demo', 'test/TEST_PLAN.md')).toBe('999-demo/test/TEST_PLAN.md')
  expect(confineSpecPath('999-demo', 'context/作业一.md')).toBe('999-demo/context/作业一.md')
})

it('rejects traversal, absolute paths, backslashes, non-markdown, and unknown roots', () => {
  expect(confineSpecPath('999-demo', '../ROADMAP.md')).toBeNull()
  expect(confineSpecPath('999-demo', 'spec/../../etc/passwd.md')).toBeNull()
  expect(confineSpecPath('..', 'BRIEF.md')).toBeNull()
  expect(confineSpecPath('999-demo', '/abs/file.md')).toBeNull()
  expect(confineSpecPath('999-demo', 'spec\\PRD.md')).toBeNull()
  expect(confineSpecPath('999-demo', 'src/index.ts')).toBeNull()
  expect(confineSpecPath('999-demo', 'ROADMAP.md')).toBeNull()
  expect(confineSpecPath('999-demo', 'random/x.md')).toBeNull()
  expect(confineSpecPath('999-demo', '')).toBeNull()
  expect(confineSpecPath('.hidden', 'BRIEF.md')).toBeNull()
})
