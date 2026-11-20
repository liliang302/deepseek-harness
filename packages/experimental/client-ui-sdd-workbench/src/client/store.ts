/** Panel view state shared by the page component and Remote loaders. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SddScanResult } from '@deepseek-ai/dsh-sdd-workbench/types'

/** Which surface the panel shows: the feature list or one feature's documents. */
export type SddView =
  | { readonly kind: 'list' }
  | { readonly kind: 'feature'; readonly id: string; readonly tab: string | null }

/** Document read state for the selected tab. */
export type SddDocState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly text: string; readonly truncated: boolean }
  | { readonly kind: 'error'; readonly code: string }

/** Complete panel snapshot. */
export interface SddWorkbenchState {
  view: SddView
  scan: SddScanResult | null
  scanning: boolean
  scanError: string | null
  doc: SddDocState
}

/** Panel write actions; components receive these draft-stripped via props.actions. */
const workbenchActions = {
  setView: (draft: SddWorkbenchState, view: SddView) => { draft.view = view; draft.doc = { kind: 'idle' } },
  scanStarted: (draft: SddWorkbenchState) => { draft.scanning = true; draft.scanError = null },
  scanFinished: (draft: SddWorkbenchState, result: SddScanResult) => {
    draft.scanning = false; draft.scan = result; draft.scanError = null
  },
  scanFailed: (draft: SddWorkbenchState, message: string) => { draft.scanning = false; draft.scanError = message },
  docLoading: (draft: SddWorkbenchState, featureId: string, tab: string) => {
    if (draft.view.kind === 'feature' && (draft.view.id !== featureId || draft.view.tab !== tab)) return
    draft.doc = { kind: 'loading' }
  },
  docReady: (draft: SddWorkbenchState, text: string, truncated: boolean) => { draft.doc = { kind: 'ready', text, truncated } },
  docFailed: (draft: SddWorkbenchState, code: string) => { draft.doc = { kind: 'error', code } },
}

/**
 * Create the panel store before the first render.
 * @returns the registration-owned store handle.
 */
export function createSddWorkbenchStore(): EngineStoreHandle<SddWorkbenchState, typeof workbenchActions> {
  return defineStore({
    init: (): SddWorkbenchState => ({
      view: { kind: 'list' },
      scan: null,
      scanning: false,
      scanError: null,
      doc: { kind: 'idle' },
    }),
    actions: workbenchActions,
  })
}
