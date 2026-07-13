import { ipc } from '../lib/ipc'
import { configure, start } from './syncEngine'

/**
 * Start from one authoritative settings snapshot. Any settings/claim/init failure
 * is returned to the caller; it must never be retried under another config/family.
 */
export async function startSyncFromAuthoritativeSettings(): Promise<void> {
  const settings = await ipc.getSettings()
  await configure(settings.firebase, settings.familyId)
  await start()
}
