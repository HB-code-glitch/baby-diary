import * as path from 'path'
import { lstatSync, realpathSync } from 'fs'

type TestUserDataFileSystem = {
  lstatSync(candidate: string): {
    isDirectory(): boolean
    isSymbolicLink(): boolean
  }
  realpathSync(candidate: string): string
}

const DEFAULT_FILE_SYSTEM: TestUserDataFileSystem = { lstatSync, realpathSync }

function pathFor(platform: NodeJS.Platform) {
  if (platform === 'win32') return path.win32
  if (platform === 'darwin') return path.posix
  return path
}

function comparable(value: string, platform: NodeJS.Platform): string {
  let resolved = pathFor(platform).resolve(value)
  if (platform === 'darwin') {
    if (resolved === '/var' || resolved.startsWith('/var/')) {
      resolved = `/private${resolved}`
    } else if (resolved === '/tmp' || resolved.startsWith('/tmp/')) {
      resolved = `/private${resolved}`
    }
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isEqualOrDescendant(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const normalizedParent = comparable(parent, platform)
  const normalizedChild = comparable(child, platform)
  return normalizedChild === normalizedParent
    || normalizedChild.startsWith(`${normalizedParent}${pathFor(platform).sep}`)
}

export function resolveIsolatedTestUserData(
  requestedPath: string | undefined,
  {
    interactiveProfileRoot,
    tempRoot,
    platform = process.platform,
    fileSystem = DEFAULT_FILE_SYSTEM,
  }: {
    interactiveProfileRoot: string
    tempRoot: string
    platform?: NodeJS.Platform
    fileSystem?: TestUserDataFileSystem
  },
): string | undefined {
  if (!requestedPath) return undefined

  const platformPath = pathFor(platform)
  const isolated = platformPath.resolve(requestedPath)
  const temporary = platformPath.resolve(tempRoot)
  const interactive = platformPath.resolve(interactiveProfileRoot)
  const insideTemp = comparable(isolated, platform) !== comparable(temporary, platform)
    && isEqualOrDescendant(temporary, isolated, platform)
  const overlapsInteractive = isEqualOrDescendant(interactive, isolated, platform)
    || isEqualOrDescendant(isolated, interactive, platform)

  if (!insideTemp || overlapsInteractive) {
    throw new Error('Isolated test userData must be a temporary path that cannot overlap the interactive profile')
  }

  let isolatedEntry
  let realTemporary
  let realIsolated
  try {
    isolatedEntry = fileSystem.lstatSync(isolated)
    realTemporary = fileSystem.realpathSync(temporary)
    realIsolated = fileSystem.realpathSync(isolated)
  } catch {
    throw new Error('Isolated test userData must be an existing real directory')
  }
  if (!isolatedEntry.isDirectory() || isolatedEntry.isSymbolicLink()) {
    throw new Error('Isolated test userData must be an existing real directory without links')
  }
  const realTemporaryEntry = fileSystem.lstatSync(realTemporary)
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
