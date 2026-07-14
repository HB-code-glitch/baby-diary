import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
