import * as path from 'path'
import { lstatSync, realpathSync } from 'fs'

function comparable(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isEqualOrDescendant(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const normalizedParent = comparable(parent, platform)
  const normalizedChild = comparable(child, platform)
  return normalizedChild === normalizedParent
    || normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
}

export function resolveIsolatedTestUserData(
  requestedPath: string | undefined,
  {
    interactiveProfileRoot,
    tempRoot,
    platform = process.platform,
  }: {
    interactiveProfileRoot: string
    tempRoot: string
    platform?: NodeJS.Platform
  },
): string | undefined {
  if (!requestedPath) return undefined

  const isolated = path.resolve(requestedPath)
  const temporary = path.resolve(tempRoot)
  const interactive = path.resolve(interactiveProfileRoot)
  const insideTemp = isolated !== temporary && isEqualOrDescendant(temporary, isolated, platform)
  const overlapsInteractive = isEqualOrDescendant(interactive, isolated, platform)
    || isEqualOrDescendant(isolated, interactive, platform)

  if (!insideTemp || overlapsInteractive) {
    throw new Error('Isolated test userData must be a temporary path that cannot overlap the interactive profile')
  }

  let isolatedEntry
  let realTemporary
  let realIsolated
  try {
    isolatedEntry = lstatSync(isolated)
    realTemporary = realpathSync(temporary)
    realIsolated = realpathSync(isolated)
  } catch {
    throw new Error('Isolated test userData must be an existing real directory')
  }
  if (!isolatedEntry.isDirectory() || isolatedEntry.isSymbolicLink()) {
    throw new Error('Isolated test userData must be an existing real directory without links')
  }
  const realTemporaryEntry = lstatSync(realTemporary)
  if (!realTemporaryEntry.isDirectory()
    || comparable(realTemporary, platform) === comparable(realIsolated, platform)
    || !isEqualOrDescendant(realTemporary, realIsolated, platform)) {
    throw new Error('Isolated test userData real path must remain below the real OS temp directory')
  }
  const realOverlapsInteractive = isEqualOrDescendant(interactive, realIsolated, platform)
    || isEqualOrDescendant(realIsolated, interactive, platform)
    || isEqualOrDescendant(interactive, realTemporary, platform)
  if (realOverlapsInteractive) {
    throw new Error('Isolated test userData real path must not overlap the interactive profile')
  }
  return isolated
}
