/** SDD Workbench Host service: read-only scans of the workspace's mai-specs tree for the Web panel. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { confineSpecPath } from './docs.ts'
import { KNOWN_SUBDIRS, SPECS_DIR } from './layout.ts'
import { foldFeature, isFeatureDir, parseBriefHeader, parseRoadmap, type BriefHeader, type ScanEntry } from './scan.ts'
import type { SddDocument, SddFeatureSummary, SddScanResult } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `sddWorkbench` Remote namespace. */
    sddWorkbench: SddWorkbench
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A document request named a path outside the confined stage allowlist. */
    'sdd-workbench/bad-path': { readonly featureId: string; readonly path: string }
    /** The named feature directory does not exist under mai-specs. */
    'sdd-workbench/feature-not-found': { readonly featureId: string }
    /** The confined target is missing or not a regular file. */
    'sdd-workbench/not-found': { readonly path: string }
    /** The document is not UTF-8 text. */
    'sdd-workbench/not-text': { readonly path: string }
    /** Scanning or reading failed at the filesystem layer. */
    'sdd-workbench/read-failed': { readonly path: string }
  }
}

/** Tunable read caps, validated by `SddWorkbench.Config`. */
export interface SddWorkbenchConfig {
  /** Full-file byte cap for one document read (PRD NFR-02). */
  maxDocBytes: number
  /** Bytes of ROADMAP.md / BRIEF.md decoded to locate header fields. */
  briefProbeBytes: number
}

/**
 * Resolve the workspace root for one panel view: the live Session's header cwd when
 * given, otherwise the deployment fallback root — the same precedence the
 * `workspaceFiles` lookup applies, without its session-not-found failure mode so
 * an empty state can render instead (PRD AC-03).
 */
async function resolveRoot(ctx: Context, sessionId: SessionId | null): Promise<string> {
  if (sessionId !== null) {
    const live = ctx.sessions.get(sessionId)?.header
    const stored = live === undefined ? await ctx.get('sessionPersistence')?.stat(sessionId) : undefined
    const cwd = (live ?? stored?.header)?.cwd
    if (cwd !== undefined) return cwd
  }
  return ctx.sandboxPolicy.workspaceRoot
}

/** Read up to `maxBytes` of one resolved file as UTF-8, or undefined when unreadable/non-text. */
async function readProbe(ctx: Context, target: FsTarget, maxBytes: number): Promise<string | undefined> {
  try {
    const bytes = await ctx.fs.readBytes(target, undefined, maxBytes)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    // Probe reads are best-effort: a missing, racing, or non-text header file degrades display fields only (BR-03).
    void error
    return undefined
  }
}

/** List direct children of one directory target, swallowing races with deletion. */
async function listDir(ctx: Context, target: FsTarget, signal: AbortSignal): Promise<readonly ScanEntry[]> {
  try {
    const entries = await ctx.fs.listDir(target, signal)
    return entries.map(entry => ({ name: entry.name, directory: entry.type === 'directory' }))
  } catch (error: unknown) {
    // A vanished or unreadable directory contributes nothing to the listing (BR-03 degradation).
    void error
    return []
  }
}

/** Fold one feature directory from shallow listings; returns null when it vanished mid-scan. */
async function foldOne(ctx: Context, root: string, name: string, roadmap: ReadonlyMap<string, 'planned' | 'active' | 'done'>, probeBytes: number, signal: AbortSignal): Promise<SddFeatureSummary | null> {
  const base = `${root}/${SPECS_DIR}/${name}`
  const files = new Set<string>()
  const briefTarget = await ctx.fs.resolve(`${base}/BRIEF.md`, { signal }).catch(() => undefined)
  let header: BriefHeader | undefined
  if (briefTarget !== undefined && (await ctx.fs.stat(briefTarget, signal).catch(() => undefined))?.type === 'file') {
    files.add('BRIEF.md')
    header = parseBriefHeader(await readProbe(ctx, briefTarget, probeBytes))
  }
  for (const subdir of KNOWN_SUBDIRS) {
    const dirTarget = await ctx.fs.resolve(`${base}/${subdir}`, { signal }).catch(() => undefined)
    if (dirTarget === undefined || (await ctx.fs.stat(dirTarget, signal).catch(() => undefined))?.type !== 'directory') continue
    for (const entry of await listDir(ctx, dirTarget, signal)) {
      if (!entry.directory && entry.name.endsWith('.md')) files.add(`${subdir}/${entry.name}`)
    }
  }
  return foldFeature(name, files, header, roadmap)
}

/** Fold the workspace's mai-specs tree into feature summaries (PRD FR-01/FR-02). */
export async function scanSpecs(ctx: Context, root: string, probeBytes: number, signal: AbortSignal): Promise<SddScanResult> {
  const specsTarget = await ctx.fs.resolve(`${root}/${SPECS_DIR}`, { signal })
  const specsInfo = await ctx.fs.stat(specsTarget, signal).catch(() => undefined)
  if (specsInfo?.type !== 'directory') return { root, specsDirExists: false, features: [] }
  let roadmap = new Map<string, 'planned' | 'active' | 'done'>()
  const roadmapTarget = await ctx.fs.resolve(`${root}/${SPECS_DIR}/ROADMAP.md`, { signal }).catch(() => undefined)
  if (roadmapTarget !== undefined) roadmap = parseRoadmap(await readProbe(ctx, roadmapTarget, probeBytes))
  const features: SddFeatureSummary[] = []
  for (const entry of (await listDir(ctx, specsTarget, signal)).filter(isFeatureDir)) {
    const summary = await foldOne(ctx, root, entry.name, roadmap, probeBytes, signal)
    if (summary !== null) features.push(summary)
  }
  features.sort((a, b) => (a.number === null ? 1 : b.number === null ? -1 : a.number.localeCompare(b.number)) || a.id.localeCompare(b.id))
  return { root, specsDirExists: true, features }
}

/** Mount the read-only SDD Workbench Remote surface. */
export default class SddWorkbench extends TypertRemoteService {
  static inject = ['fs', 'sandboxPolicy', 'sessions']

  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<SddWorkbenchConfig> = z.object({
    maxDocBytes: z.natural().min(1024).default(1024 * 1024),
    briefProbeBytes: z.natural().min(1024).default(64 * 1024),
  })

  constructor(ctx: Context, private readonly config: SddWorkbenchConfig) {
    super(ctx, 'sddWorkbench', { namespace: 'sddWorkbench' })
  }

  /**
   * Enumerate the workspace's SDD features and their stage artifacts.
   * @param sessionId - active Session whose workspace root hosts mai-specs, or null for the deployment root.
   * @param signal - Client cancellation.
   * @returns scan result; an absent mai-specs directory yields `specsDirExists: false` rather than an error.
   * @throws RemoteError `gateway/internal`: the workspace root itself cannot be inspected.
   */
  @Remote
  async scan(sessionId: SessionId | null, signal: AbortSignal): Promise<SddScanResult> {
    const root = await resolveRoot(this.ctx, sessionId)
    return await scanSpecs(this.ctx, root, this.config.briefProbeBytes, signal)
  }

  /**
   * Read one Markdown document confined to the feature's stage directories.
   * @param sessionId - active Session workspace, or null for the deployment root.
   * @param featureId - feature directory name as reported by scan.
   * @param relPath - feature-relative `.md` path within the stage allowlist.
   * @param signal - Client cancellation.
   * @returns the document body, cut at the byte cap with `truncated` set.
   * @throws RemoteError `sdd-workbench/bad-path`: the request left the confined surface.
   * @throws RemoteError `sdd-workbench/feature-not-found` / `not-found`: the target is absent.
   * @throws RemoteError `sdd-workbench/not-text`: the bytes are not valid UTF-8.
   * @throws RemoteError `sdd-workbench/read-failed`: the filesystem refused the read.
   */
  @Remote
  async readDoc(sessionId: SessionId | null, featureId: string, relPath: string, signal: AbortSignal): Promise<SddDocument> {
    const joined = confineSpecPath(featureId, relPath)
    if (joined === null) throw new RemoteError('sdd-workbench/bad-path', `"${featureId}/${relPath}" leaves the mai-specs document surface`, { featureId, path: relPath })
    const root = await resolveRoot(this.ctx, sessionId)
    const specsReal = await this.ctx.fs.resolve(`${root}/${SPECS_DIR}`, { signal })
    const featureTarget = await this.ctx.fs.resolve(`${root}/${SPECS_DIR}/${featureId}`, { signal })
    if ((await this.ctx.fs.stat(featureTarget, signal).catch(() => undefined))?.type !== 'directory') {
      throw new RemoteError('sdd-workbench/feature-not-found', `Feature "${featureId}" not found`, { featureId })
    }
    const target = await this.ctx.fs.resolve(`${root}/${SPECS_DIR}/${joined}`, { signal })
    if (!this.ctx.fs.contains(specsReal, target)) throw new RemoteError('sdd-workbench/bad-path', `"${relPath}" escapes the mai-specs root`, { featureId, path: relPath })
    const info = await this.ctx.fs.stat(target, signal)
    if (info?.type !== 'file') throw new RemoteError('sdd-workbench/not-found', `"${joined}" is not a readable file`, { path: joined })
    const cap = this.config.maxDocBytes
    let bytes: Uint8Array
    try {
      // The range read takes exactly cap+1 bytes, so `truncated` is decided from the actual delivery.
      bytes = await this.ctx.fs.readByteRange(target, { offset: 0, length: cap + 1 }, signal)
    } catch (error: unknown) {
      throw new RemoteError('sdd-workbench/read-failed', `Failed to read "${joined}"`, { path: joined }, { cause: error })
    }
    const truncated = bytes.byteLength > cap
    const body = truncated ? bytes.subarray(0, cap) : bytes
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch (error: unknown) {
      throw new RemoteError('sdd-workbench/not-text', `"${joined}" is not UTF-8 text`, { path: joined }, { cause: error })
    }
    return { path: relPath, text, truncated }
  }
}
