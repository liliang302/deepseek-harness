/** SDD Workbench global panel: feature list, artifact badges, and confined document reading. */

import { useCallback, useEffect, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SddFeatureSummary, SddScanResult } from '@deepseek-ai/dsh-sdd-workbench/types'
import { NS, type SddLocaleKey } from './locales.ts'
import { renderMarkdown } from './render-markdown.tsx'
import { createSddWorkbenchStore, type SddDocState } from './store.ts'
import css from './SddWorkbenchPage.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** SDD Workbench panel copy. */
    [NS]: SddLocaleKey
  }
}

/** The sidebar entry id doubles as the main-panel key. */
export const PANEL_ID = 'sdd-workbench' as MainPanelId

type Store = ReturnType<typeof createSddWorkbenchStore>
/** Framework-bound store props, following the ui-schedule editor-store pattern. */
type SddStoreProps = PropsStore<Store>
type Translate = (key: SddLocaleKey) => string
/** Face the panel registration injects so the page reaches the typed Remote without a module global. */
interface PanelFace {
  readonly remote: Context['remote']
  /** Current main-view Session identity, or null when none is retained. */
  readonly currentSessionId: () => SessionId | null
}
type PageProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & SddStoreProps & InjectFace<PanelFace>

const TAB_ORDER = ['brief', 'prd', 'design', 'review', 'test'] as const

/** Map one Remote failure code to its dictionary key; unknown codes fall back to the generic doc error. */
function docErrorKey(error: unknown): SddLocaleKey {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error).code : undefined
  if (code === 'sdd-workbench/bad-path') return 'error.bad-path'
  if (code === 'sdd-workbench/not-text') return 'error.not-text'
  if (code === 'sdd-workbench/not-found' || code === 'sdd-workbench/feature-not-found') return 'error.not-found'
  return 'error.doc'
}

interface PanelTab { readonly key: string; readonly labelKey: SddLocaleKey | null; readonly label: string; readonly path: string }

/** Tabs offered for one feature: existing stage artifacts plus context materials. */
function tabsOf(feature: SddFeatureSummary): PanelTab[] {
  const tabs: PanelTab[] = []
  for (const slot of TAB_ORDER) {
    const path = feature.artifacts[slot]
    if (path !== null) tabs.push({ key: slot, labelKey: `artifact.${slot}`, label: '', path })
  }
  for (const material of feature.materials) tabs.push({ key: material, labelKey: null, label: material.replace(/^context\//, ''), path: material })
  return tabs
}

/** Render the global panel body. */
export function SddWorkbenchPage(props: PageProps): ReactNode {
  const t = props.t as Translate
  const { useStore, actions } = props
  const view = useStore(state => state.view)
  const scan = useStore(state => state.scan)
  const scanning = useStore(state => state.scanning)
  const scanError = useStore(state => state.scanError)
  const doc = useStore(state => state.doc)
  const { remote } = props
  // uiSession's chat binding goes absent while a global panel is open; the mainView
  // retention counts survive the switch and name the current session, the same source
  // ui-open-in-app uses. Re-read per effect run so session switches take effect on refresh.
  const sessionId = props.currentSessionId()

  const rescan = useCallback((): void => {
    const controller = new AbortController()
    actions.scanStarted()
    void remote.sddWorkbench.scan(sessionId, controller.signal)
      .then((result) => { if (result.ok) actions.scanFinished(result.value); else actions.scanFailed(t('error.scan')) })
      .catch(() => { if (!controller.signal.aborted) actions.scanFailed(t('error.scan')) })
  }, [actions, remote, sessionId, t])

  useEffect(() => { rescan() }, [rescan])

  const openTab = useCallback((feature: SddFeatureSummary, tab: PanelTab): void => {
    actions.setView({ kind: 'feature', id: feature.id, tab: tab.key })
    const controller = new AbortController()
    actions.docLoading(feature.id, tab.key)
    void remote.sddWorkbench.readDoc(sessionId, feature.id, tab.path, controller.signal)
      .then((result) => {
        if (result.ok) actions.docReady(result.value.text, result.value.truncated)
        else actions.docFailed(docErrorKey(result.error))
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) actions.docFailed(docErrorKey(error)) })
  }, [actions, remote, sessionId])

  if (view.kind === 'list') {
    return (
      <div className={css.page}>
        <header className={css.header}>
          <h1 className={css.title}>{t('title')}</h1>
          <button type="button" className={css.refresh} onClick={rescan} disabled={scanning}>{t('refresh')}</button>
        </header>
        <ListBody t={t} scan={scan} scanning={scanning} scanError={scanError} onOpen={openTab} />
      </div>
    )
  }
  const feature = scan?.features.find(candidate => candidate.id === view.id)
  const tabs = feature === undefined ? [] : tabsOf(feature)
  const activeKey = view.tab ?? tabs[0]?.key ?? null
  return (
    <div className={css.page}>
      <header className={css.header}>
        <button type="button" className={css.back} onClick={() => { actions.setView({ kind: 'list' }) }}>{t('back')}</button>
        <h1 className={css.title}>{feature?.title ?? view.id}</h1>
        <button type="button" className={css.refresh} onClick={rescan} disabled={scanning}>{t('refresh')}</button>
      </header>
      <nav className={css.tabs} role="tablist">
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === activeKey}
            className={tab.key === activeKey ? css.tabActive : css.tab}
            onClick={() => { if (feature !== undefined) openTab(feature, tab) }}
          >
            {tab.labelKey === null ? tab.label : t(tab.labelKey)}
          </button>
        ))}
      </nav>
      <article className={css.doc}>
        <DocBody t={t} doc={doc} />
      </article>
    </div>
  )
}

function ListBody({ t, scan, scanning, scanError, onOpen }: {
  t: Translate
  scan: SddScanResult | null
  scanning: boolean
  scanError: string | null
  onOpen: (feature: SddFeatureSummary, tab: PanelTab) => void
}): ReactNode {
  if (scanError !== null) return <p className={css.error}>{scanError}</p>
  if (scan === null) return <p className={css.muted}>{scanning ? t('loading') : ''}</p>
  if (!scan.specsDirExists) {
    return (
      <div className={css.empty}>
        <h2>{t('empty.title')}</h2>
        <p className={css.muted}>{t('empty.hint')}</p>
      </div>
    )
  }
  if (scan.features.length === 0) return <p className={css.muted}>{t('empty.features')}</p>
  return (
    <ul className={css.list}>
      {scan.features.map(feature => (
        <li key={feature.id}>
          <button
            type="button"
            className={css.row}
            onClick={() => { const tabs = tabsOf(feature); if (tabs[0] !== undefined) onOpen(feature, tabs[0]) }}
          >
            <span className={css.number}>{feature.number ?? '—'}</span>
            <span className={css.rowTitle}>
              <span className={css.slug}>{feature.slug}</span>
              <span className={css.featureTitle}>{feature.title}</span>
            </span>
            <span className={css.phase}>{feature.phase ?? t('phase.unknown')}</span>
            <span className={css.badges}>
              {TAB_ORDER.map(slot => (
                <span key={slot} className={feature.artifacts[slot] !== null ? css.badgeOn : css.badgeOff} title={t(`artifact.${slot}`)}>
                  {t(`artifact.${slot}`)}
                </span>
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function DocBody({ t, doc }: { t: Translate; doc: SddDocState }): ReactNode {
  if (doc.kind === 'idle' || doc.kind === 'loading') return <p className={css.muted}>{t('loading')}</p>
  if (doc.kind === 'error') return <p className={css.error}>{t(docErrorKey({ code: doc.code }))}</p>
  return (
    <>
      {doc.truncated ? <p className={css.notice}>{t('truncated')}</p> : null}
      <div className={css.markdown}>{renderMarkdown(doc.text)}</div>
    </>
  )
}

/** Services the panel body needs once the Remote contribution is mounted. */
export const PANEL_INJECT = ['slots', 'locale', 'remote', 'remote.sddWorkbench', 'sessions', 'uiSession', 'layout'] as const

/** Register the sidebar entry and the global main panel; requires the mounted `remote.sddWorkbench` service. */
export function registerSddWorkbenchPanel(ctx: Context): void {
  const bind = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('main', function* () {
    yield ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      store: createSddWorkbenchStore(),
      inject: (): PanelFace => ({
        remote: ctx.remote,
        currentSessionId: () => {
          const state = ctx.sessions.list.getSnapshot()
          // Prefer the retained main view; while a global panel holds focus the
          // retention can be zero, so fall back to the most recently updated
          // non-archived session row — the same target the sidebar treats as current.
          const rows = state.ids.map(id => state.byId[id]).filter((row): row is NonNullable<typeof row> => row !== undefined)
          const retained = rows.find(row => (row.retainedBy.mainView ?? 0) > 0)
          const fallback = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)[0]
          const pick = retained ?? fallback
          return (pick?.id) ?? null
        },
      }),
    }, SddWorkbenchPage)
  }), 'sdd-workbench: main panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', function* () {
    yield ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 6,
      label: () => bind('panel'),
      locale: NS,
    }, PanelIcon)
  }), 'sdd-workbench: sidebar entry')
}

/** Sidebar glyph for the SDD Workbench entry: stacked spec sheets with a completion check. */
function PanelIcon({ size, active }: { size: number; active: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}
      fill="none" stroke={active ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)'} strokeWidth="1.6" strokeLinecap="round">
      <rect x="5" y="3.5" width="12" height="17" rx="2" />
      <path d="M8 8h6M8 11.5h6M8 15h4" />
      <circle cx="17.5" cy="17.5" r="3" fill="var(--dsw-alias-bg-module-platform)" />
      <path d="M16.2 17.5l1 1 1.7-2" />
    </svg>
  )
}
