import { format, isValid, parseISO } from 'date-fns'
import type { Locale } from 'date-fns'
import type { DataInfo } from '../../shared/types'

interface DataDisclosureOptions {
  formatPattern: string
  locale: Locale
  noBackup: string
}

export function getDataDisclosurePresentation(
  dataInfo: Pick<DataInfo, 'eventCount' | 'lastBackupTime'> | null,
  options: DataDisclosureOptions,
): { count: number; backup: string } | null {
  if (!dataInfo) return null

  const parsedBackupTime = dataInfo.lastBackupTime ? parseISO(dataInfo.lastBackupTime) : null
  const backup = parsedBackupTime && isValid(parsedBackupTime)
    ? format(parsedBackupTime, options.formatPattern, { locale: options.locale })
    : options.noBackup

  return { count: dataInfo.eventCount, backup }
}
