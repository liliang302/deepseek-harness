/** The SDD Workbench service scans a real temporary mai-specs tree through the local filesystem backend. */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SddWorkbench from '../src/index.ts'

const roots: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

interface Harness { workbench: SddWorkbench; root: string }

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'sddw-'))
  dirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.provide('sandboxPolicy', { workspaceRoot: root } as never)
  ctx.provide('sessions', { get: () => undefined } as never)
  const workbench = new SddWorkbench(ctx, { maxDocBytes: 1024 * 1024, briefProbeBytes: 64 * 1024 })
  return { workbench, root }
}

async function seedSpecs(root: string): Promise<void> {
  await mkdir(join(root, 'mai-specs', '999-demo', 'spec'), { recursive: true })
  await mkdir(join(root, 'mai-specs', '999-demo', 'context'), { recursive: true })
  await writeFile(join(root, 'mai-specs', 'ROADMAP.md'), '# 需求路线图\n\n## 进行中\n\n| 需求 | 标题 | 规格 | 优先级 | 说明 |\n|---|---|---|---|---|\n| 999 | [Demo](999-demo/BRIEF.md) | standard | P1 | x |\n')
  await writeFile(join(root, 'mai-specs', '999-demo', 'BRIEF.md'), '# 999: 演示需求\n\n| 项 | 值 |\n|---|---|\n| Phase | dev |\n')
  await writeFile(join(root, 'mai-specs', '999-demo', 'spec', 'PRD.md'), '# PRD\n\n正文 **重点**。\n')
  await writeFile(join(root, 'mai-specs', '999-demo', 'context', '材料.md'), '素材')
}

describe('scan', () => {
  it('reports an absent mai-specs directory without failing (AC-03)', async () => {
    const { workbench } = await harness()
    const result = await workbench.scan(null, new AbortController().signal)
    expect(result.specsDirExists).toBe(false)
    expect(result.features).toEqual([])
  })

  it('folds features with artifacts, phase, and roadmap section', async () => {
    const { workbench, root } = await harness()
    await seedSpecs(root)
    const result = await workbench.scan(null, new AbortController().signal)
    expect(result.specsDirExists).toBe(true)
    const feature = result.features.find(candidate => candidate.id === '999-demo')
    expect(feature?.title).toBe('演示需求')
    expect(feature?.phase).toBe('dev')
    expect(feature?.roadmapSection).toBe('active')
    expect(feature?.artifacts.brief).toBe('BRIEF.md')
    expect(feature?.artifacts.prd).toBe('spec/PRD.md')
    expect(feature?.materials).toEqual(['context/材料.md'])
  })
})

describe('readDoc', () => {
  it('reads confined documents round-trip', async () => {
    const { workbench, root } = await harness()
    await seedSpecs(root)
    const doc = await workbench.readDoc(null, '999-demo', 'spec/PRD.md', new AbortController().signal)
    expect(doc.text).toContain('正文')
    expect(doc.truncated).toBe(false)
  })

  it('refuses traversal outside the stage allowlist (BR-02)', async () => {
    const { workbench, root } = await harness()
    await seedSpecs(root)
    await expect(workbench.readDoc(null, '999-demo', '../ROADMAP.md', new AbortController().signal))
      .rejects.toMatchObject({ code: 'sdd-workbench/bad-path' })
    await expect(workbench.readDoc(null, '..', 'BRIEF.md', new AbortController().signal))
      .rejects.toMatchObject({ code: 'sdd-workbench/bad-path' })
  })

  it('refuses symlink escape through the resolved containment check', async () => {
    const { workbench, root } = await harness()
    await seedSpecs(root)
    await symlink(join(root, 'outside.md'), join(root, 'mai-specs', '999-demo', 'spec', 'escape.md'))
    await writeFile(join(root, 'outside.md'), 'secret')
    await expect(workbench.readDoc(null, '999-demo', 'spec/escape.md', new AbortController().signal))
      .rejects.toMatchObject({ code: 'sdd-workbench/bad-path' })
  })
  it('marks oversized documents truncated at the cap (NFR-02)', async () => {
    const { root } = await harness()
    await seedSpecs(root)
    await writeFile(join(root, 'mai-specs', '999-demo', 'spec', 'BIG.md'), 'x'.repeat(5000))
    const small = new Context()
    roots.push(small)
    await small.plugin(LocalFileSystem, { cwd: root })
    small.provide('sandboxPolicy', { workspaceRoot: root } as never)
    small.provide('sessions', { get: () => undefined } as never)
    const tiny = new SddWorkbench(small, { maxDocBytes: 1024, briefProbeBytes: 1024 })
    const doc = await tiny.readDoc(null, '999-demo', 'spec/BIG.md', new AbortController().signal)
    expect(doc.truncated).toBe(true)
    expect(Buffer.byteLength(doc.text)).toBeLessThanOrEqual(1024)
  })

  it('fails with not-found for missing targets', async () => {
    const { workbench, root } = await harness()
    await seedSpecs(root)
    await expect(workbench.readDoc(null, '999-demo', 'review/DESIGN_REVIEW.md', new AbortController().signal))
      .rejects.toMatchObject({ code: 'sdd-workbench/not-found' })
    await expect(workbench.readDoc(null, 'nope', 'BRIEF.md', new AbortController().signal))
      .rejects.toMatchObject({ code: 'sdd-workbench/feature-not-found' })
  })
})
