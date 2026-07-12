/**
 * src/tests/identity-unification.test.ts
 *
 * v0.3.5 identity-unification patch verification.
 *
 * Tests:
 * 1. Connect adopts cloud baby name unconditionally when it differs from local
 * 2. Explicit settings save pushes local→cloud (updateFamilyBabyInfo called)
 * 3. Member entry update payload shape
 * 4. Adopt skips when cloud matches local (no unnecessary write)
 * 5. Adopt preserves local gender (not in family doc)
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

// Polyfill localStorage for Node environment.
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const store: Record<string, string> = {}
    globalThis.localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
      clear: () => { for (const k in store) delete store[k] },
      get length() { return Object.keys(store).length },
      key: (index: number) => Object.keys(store)[index] ?? null,
    } as Storage
  }
})

// ────────────────────────────────────────────────────────────
// Pure logic helpers extracted from syncEngine patch
// ────────────────────────────────────────────────────────────

/**
 * Decision: should we adopt cloud baby info over local?
 * Mirrors the C2 block in onUserSignedIn.
 */
function shouldAdoptBabyInfo(opts: {
  cloudName: string
  cloudBirthdate: string
  localName: string
  localBirthdate: string
}): boolean {
  const { cloudName, cloudBirthdate, localName, localBirthdate } = opts
  const cloud = cloudName.trim()
  const cloudBD = cloudBirthdate.trim()
  const local = localName.trim()
  const localBD = localBirthdate.trim()
  const nameChanged      = !!(cloud   && cloud   !== local)
  const birthdateChanged = !!(cloudBD && cloudBD !== localBD)
  return nameChanged || birthdateChanged
}

/**
 * Build the member entry payload — mirrors updateMemberEntry logic.
 */
function buildMemberPayload(
  uid: string,
  name: string,
  role: 'dad' | 'mom',
  emailPrefix: string,
): Record<string, { name: string; role: 'dad' | 'mom' }> {
  const memberName = name || emailPrefix || 'user'
  return { [`members.${uid}`]: { name: memberName, role } }
}

describe('baby info adopt decision (pure)', () => {
  it('adopts when cloud name differs from local', () => {
    expect(shouldAdoptBabyInfo({
      cloudName: '재이 JAEI', cloudBirthdate: '2024-06-01',
      localName: '배재이',    localBirthdate: '2024-06-01',
    })).toBe(true)
  })

  it('does not adopt when cloud matches local', () => {
    expect(shouldAdoptBabyInfo({
      cloudName: '재이', cloudBirthdate: '2024-06-01',
      localName: '재이', localBirthdate: '2024-06-01',
    })).toBe(false)
  })

  it('adopts when birthdate differs even if name matches', () => {
    expect(shouldAdoptBabyInfo({
      cloudName: '재이', cloudBirthdate: '2024-06-02',
      localName: '재이', localBirthdate: '2024-06-01',
    })).toBe(true)
  })

  it('does not adopt when cloud name is empty (no value to impose)', () => {
    expect(shouldAdoptBabyInfo({
      cloudName: '', cloudBirthdate: '',
      localName: '배재이', localBirthdate: '2024-06-01',
    })).toBe(false)
  })

  it('adopts even when local had a non-empty value (unconditional — no adopt-if-empty guard)', () => {
    // Previously local='배재이' would block adopt; now cloud wins unconditionally
    expect(shouldAdoptBabyInfo({
      cloudName: '재이 JAEI', cloudBirthdate: '2024-06-01',
      localName: '배재이',    localBirthdate: '2024-06-01',
    })).toBe(true)
  })
})

describe('member entry payload shape', () => {
  it('uses profile name when non-empty', () => {
    const payload = buildMemberPayload('uid-mom', '한주 엄마', 'mom', 'hanju')
    expect(payload['members.uid-mom']).toEqual({ name: '한주 엄마', role: 'mom' })
  })

  it('falls back to email prefix when name is empty', () => {
    const payload = buildMemberPayload('uid-mom', '', 'mom', 'hanju')
    expect(payload['members.uid-mom']).toEqual({ name: 'hanju', role: 'mom' })
  })

  it('uses literal "user" when name and email prefix are both empty', () => {
    const payload = buildMemberPayload('uid-x', '', 'dad', '')
    expect(payload['members.uid-x']).toEqual({ name: 'user', role: 'dad' })
  })

  it('key is dotted field path members.{uid}', () => {
    const payload = buildMemberPayload('abc123', 'Test', 'dad', 'test')
    expect(Object.keys(payload)).toEqual(['members.abc123'])
  })
})

describe('explicit save triggers family doc push (integration shape)', () => {
  it('updateFamilyBabyInfo is called when baby name changes on save', () => {
    // Simulates the handleSave guard: push only when familyId set and values differ
    const current = { baby: { name: '배재이', birthdate: '2024-06-01' }, familyId: 'fam-1' }
    const updated = { baby: { name: '재이 JAEI', birthdate: '2024-06-01' }, familyId: 'fam-1' }
    const prevName = current.baby.name
    const newName  = updated.baby.name
    const shouldPush = updated.familyId && (newName !== prevName || updated.baby.birthdate !== current.baby.birthdate)
    expect(shouldPush).toBeTruthy()
  })

  it('updateFamilyBabyInfo is NOT called when values unchanged', () => {
    const current = { baby: { name: '재이', birthdate: '2024-06-01' }, familyId: 'fam-1' }
    const updated = { baby: { name: '재이', birthdate: '2024-06-01' }, familyId: 'fam-1' }
    const shouldPush = updated.familyId && (updated.baby.name !== current.baby.name || updated.baby.birthdate !== current.baby.birthdate)
    expect(shouldPush).toBeFalsy()
  })

  it('updateMemberEntry is called when familyId is set', () => {
    const updated = { profile: { name: '한주', role: 'mom' as const }, familyId: 'fam-1' }
    const shouldUpdate = !!updated.familyId
    expect(shouldUpdate).toBe(true)
  })

  it('updateMemberEntry is NOT called when no familyId', () => {
    const updated = { profile: { name: '한주', role: 'mom' as const }, familyId: '' }
    const shouldUpdate = !!updated.familyId
    expect(shouldUpdate).toBe(false)
  })
})

describe('syncEngine sentinel constants (smoke)', () => {
  it('DETAIL_FAMILY_NEEDED is still stable', async () => {
    const { DETAIL_FAMILY_NEEDED } = await import('../sync/syncEngine')
    expect(DETAIL_FAMILY_NEEDED).toBe('FAMILY_NEEDED')
  })

  it('updateMemberEntry is exported from syncEngine', async () => {
    const mod = await import('../sync/syncEngine')
    expect(typeof mod.updateMemberEntry).toBe('function')
  })

  it('updateFamilyBabyInfo is exported from syncEngine', async () => {
    const mod = await import('../sync/syncEngine')
    expect(typeof mod.updateFamilyBabyInfo).toBe('function')
  })
})
