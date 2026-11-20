/** Browser plugin contributing the SDD Workbench sidebar panel: feature navigation and spec browsing. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import sddWorkbenchRemote from '@deepseek-ai/dsh-sdd-workbench/remote'
import { en, NS, zh } from './locales.ts'
import { PANEL_INJECT, registerSddWorkbenchPanel } from './panel.tsx'

/** Services required to mount the Remote contribution, register the panel, and read the Session. */
export const inject = ['locale', 'remote']

/**
 * Mount the generated `sddWorkbench` Remote namespace, then register the panel for this plugin's lifetime.
 * @param ctx - Client root context carrying the slot registry, copy, Remote, and layout.
 * @returns disposer removing the panel registrations and the Remote mount.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'sdd-workbench: dictionaries')
  const disposeRemote = await ctx.remote.$mount(sddWorkbenchRemote)
  const ui = ctx.inject(PANEL_INJECT, registerSddWorkbenchPanel)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
