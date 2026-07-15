import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveIsolatedTestUserData } from '../electron/testUserDataIsolation'

describe('Electron test userData isolation', () => {
  let root: string
  let interactiveProfileRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'baby-diary-test-userdata-'))
    interactiveProfileRoot = join(root, 'interactive-profile')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('leaves the normal interactive profile path flow untouched without a test override', () => {
    const lstat = vi.fn(() => { throw new Error('must not inspect') })
    const realpath = vi.fn(() => { throw new Error('must not inspect') })

    expect(resolveIsolatedTestUserData(undefined, {
      interactiveProfileRoot,
      tempRoot: tmpdir(),
      fileSystem: { lstatSync: lstat, realpathSync: realpath },
    })).toBeUndefined()
    expect(lstat).not.toHaveBeenCalled()
    expect(realpath).not.toHaveBeenCalled()
  })

  it('accepts only an existing real directory below the OS temp root', () => {
    const isolated = join(root, 'isolated-profile')
    mkdirSync(isolated)

    expect(resolveIsolatedTestUserData(isolated, {
      interactiveProfileRoot,
      tempRoot: tmpdir(),
    })).toBe(isolated)

    expect(() => resolveIsolatedTestUserData(join(root, 'missing-profile'), {
      interactiveProfileRoot,
      tempRoot: tmpdir(),
    })).toThrow(/real directory/i)
  })

  it('rejects a linked test directory even when its name is below the OS temp root', () => {
    const target = join(root, 'link-target')
    const linked = join(root, 'linked-profile')
    mkdirSync(target)
    symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => resolveIsolatedTestUserData(linked, {
      interactiveProfileRoot,
      tempRoot: tmpdir(),
    })).toThrow(/link|real directory/i)
  })

  it('accepts a real isolated directory through the OS temp alias used by macOS', () => {
    const realTemp = join(root, 'real-temp')
    const tempAlias = join(root, 'temp-alias')
    mkdirSync(realTemp)
    symlinkSync(realTemp, tempAlias, process.platform === 'win32' ? 'junction' : 'dir')
    const isolatedThroughAlias = join(tempAlias, 'isolated-profile')
    mkdirSync(join(realTemp, 'isolated-profile'))

    expect(resolveIsolatedTestUserData(isolatedThroughAlias, {
      interactiveProfileRoot,
      tempRoot: tempAlias,
    })).toBe(isolatedThroughAlias)
  })

  it.each([
    ['/var/folders/runner/T', '/private/var/folders/runner/T'],
    ['/tmp', '/private/tmp'],
  ])('accepts the canonical macOS system temp alias %s -> %s', (tempRoot, canonicalTempRoot) => {
    const isolated = `${canonicalTempRoot}/baby-diary-sync-e2e/device-a`
    const realDirectory = { isDirectory: () => true, isSymbolicLink: () => false }
    const realpath = vi.fn((candidate: string) => candidate === tempRoot
      ? canonicalTempRoot
      : candidate)

    expect(resolveIsolatedTestUserData(isolated, {
      interactiveProfileRoot: '/Users/runner/Library/Application Support/baby-diary',
      tempRoot,
      platform: 'darwin',
      fileSystem: {
        lstatSync: vi.fn(() => realDirectory),
        realpathSync: realpath,
      },
    })).toBe(isolated)
    expect(realpath).toHaveBeenCalledWith(tempRoot)
  })

  it('does not treat an arbitrary Darwin path rewrite as a system temp alias', () => {
    const realDirectory = { isDirectory: () => true, isSymbolicLink: () => false }
    expect(() => resolveIsolatedTestUserData('/real-temp/device-a', {
      interactiveProfileRoot: '/Users/runner/Library/Application Support/baby-diary',
      tempRoot: '/alias-temp',
      platform: 'darwin',
      fileSystem: {
        lstatSync: vi.fn(() => realDirectory),
        realpathSync: vi.fn((candidate: string) => candidate
          .replace('/alias-temp', '/real-temp')),
      },
    })).toThrow(/temporary path/i)
  })

  it('rejects an interactive profile overlap hidden only by the macOS /var alias', () => {
    const tempRoot = '/private/var/folders/runner/T'
    const isolated = `${tempRoot}/device-a`
    const realDirectory = { isDirectory: () => true, isSymbolicLink: () => false }

    expect(() => resolveIsolatedTestUserData(isolated, {
      interactiveProfileRoot: '/var/folders/runner/T/device-a',
      tempRoot,
      platform: 'darwin',
      fileSystem: {
        lstatSync: vi.fn(() => realDirectory),
        realpathSync: vi.fn((candidate: string) => candidate),
      },
    })).toThrow(/overlap/i)
  })

  it('rejects a canonical macOS alias whose real isolated path escapes the real temp root', () => {
    const tempRoot = '/var/folders/runner/T'
    const canonicalTempRoot = '/private/var/folders/runner/T'
    const isolated = `${canonicalTempRoot}/device-a`
    const realDirectory = { isDirectory: () => true, isSymbolicLink: () => false }

    expect(() => resolveIsolatedTestUserData(isolated, {
      interactiveProfileRoot: '/Users/runner/Library/Application Support/baby-diary',
      tempRoot,
      platform: 'darwin',
      fileSystem: {
        lstatSync: vi.fn(() => realDirectory),
        realpathSync: vi.fn((candidate: string) => {
          if (candidate === tempRoot) return canonicalTempRoot
          if (candidate === isolated) return '/private/var/folders/escaped/device-a'
          return candidate
        }),
      },
    })).toThrow(/real path/i)
  })

  it('rejects a real final directory reached through a parent link that escapes real temp', () => {
    const realTemp = join(root, 'real-temp')
    const outside = join(root, 'outside-temp')
    const linkedParent = join(realTemp, 'linked-parent')
    mkdirSync(realTemp)
    mkdirSync(outside)
    mkdirSync(join(outside, 'isolated-profile'))
    symlinkSync(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => resolveIsolatedTestUserData(join(linkedParent, 'isolated-profile'), {
      interactiveProfileRoot: outside,
      tempRoot: realTemp,
    })).toThrow(/real path|interactive profile/i)
  })
})
