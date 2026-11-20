/** Pure folds over mai-specs contents: roadmap sections, brief headers, feature artifacts. */
import { expect, it } from 'vitest'
import { foldFeature, isFeatureDir, parseBriefHeader, parseRoadmap } from '../src/scan.ts'

const ROADMAP = [
  '# 需求路线图',
  '## 规划中',
  '| 需求 | 标题 | 规格 | 优先级 | 说明 |',
  '|---|---|---|---|---|',
  '| 998 | 未来需求 | standard | P2 | x |',
  '',
  '## 进行中',
  '| 需求 | 标题 | 规格 | 优先级 | 说明 |',
  '|---|---|---|---|---|',
  '| 999 | [SDD 工作台面板](999-sdd-workbench-panel/BRIEF.md) | standard | P1 | y |',
  '',
  '## 已完成',
  '| 需求 | 标题 | 规格 | 优先级 | 说明 |',
  '|---|---|---|---|---|',
  '| 997 | 旧需求 | simple | P3 | z |',
].join('\n')

it('maps feature numbers to their roadmap sections', () => {
  const map = parseRoadmap(ROADMAP)
  expect(map.get('998')).toBe('planned')
  expect(map.get('999')).toBe('active')
  expect(map.get('997')).toBe('done')
})

it('keeps the first section when a number repeats and ignores text outside sections', () => {
  const map = parseRoadmap(`${ROADMAP}\n| 999 | duplicate |\n\n## 未知分区\n| 996 | x |`)
  expect(map.get('999')).toBe('active')
  expect(map.has('996')).toBe(false)
})

it('degrades malformed roadmaps to whatever parses', () => {
  expect(parseRoadmap(undefined).size).toBe(0)
  expect(parseRoadmap('完全不是表格').size).toBe(0)
  expect(parseRoadmap('## 进行中\n随便一行').size).toBe(0)
})

it('extracts title and phase from a standard BRIEF header', () => {
  const header = parseBriefHeader('# 999: SDD 工作台面板\n\n| 项 | 值 |\n|---|---|\n| Phase | draft |\n')
  expect(header.title).toBe('SDD 工作台面板')
  expect(header.phase).toBe('draft')
})

it('tolerates backticked phases and skips fenced examples', () => {
  const header = parseBriefHeader('# T\n```\n# fake heading\n```\n| Phase | `dev` |\n')
  expect(header.title).toBe('T')
  expect(header.phase).toBe('dev')
})

it('returns null fields for missing or empty briefs', () => {
  expect(parseBriefHeader(undefined)).toEqual({ title: null, phase: null })
  expect(parseBriefHeader('')).toEqual({ title: null, phase: null })
})

it('folds stage artifacts and context materials', () => {
  const files = new Set(['BRIEF.md', 'spec/PRD.md', 'test/TEST_PLAN.md', 'context/a.md', 'context/sub/b.md', 'design/x.html'])
  const summary = foldFeature('999-demo', files, { title: 'Demo', phase: 'dev' }, new Map([['999', 'active'] as const]))
  expect(summary.artifacts).toEqual({ brief: 'BRIEF.md', prd: 'spec/PRD.md', design: null, review: null, test: 'test/TEST_PLAN.md' })
  expect(summary.materials).toEqual(['context/a.md'])
  expect(summary.number).toBe('999')
  expect(summary.slug).toBe('demo')
  expect(summary.roadmapSection).toBe('active')
})

it('falls back to the slug for non-conforming directories', () => {
  const summary = foldFeature('scratch-notes', new Set(), undefined, new Map())
  expect(summary.number).toBeNull()
  expect(summary.title).toBe('scratch-notes')
  expect(summary.roadmapSection).toBeNull()
})

it('recognizes feature directories but skips underscore and dot entries', () => {
  expect(isFeatureDir({ name: '999-x', directory: true })).toBe(true)
  expect(isFeatureDir({ name: '_templates', directory: true })).toBe(false)
  expect(isFeatureDir({ name: '.git', directory: true })).toBe(false)
  expect(isFeatureDir({ name: 'ROADMAP.md', directory: false })).toBe(false)
})
