export type UpdateMode = 'off' | 'auto' | 'manual'

export function getUpdateMode(
  isPackaged: boolean,
  isE2E: boolean,
  platform: NodeJS.Platform,
  portableExecutableFile: string | undefined,
): UpdateMode {
  if (!isPackaged || isE2E) return 'off'
  if (platform === 'win32' && !portableExecutableFile) return 'auto'
  return 'manual'
}
