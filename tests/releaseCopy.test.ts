import { describe, expect, it } from 'vitest'

const provenanceModule = import('../scripts/release-provenance.mjs').catch(() => ({}))

const context = {
  sourceRepository: 'HB-code-glitch/baby-diary',
  releaseRepository: 'HB-code-glitch/baby-diary-releases',
  tag: 'v0.3.9',
  sha: 'a'.repeat(40),
  version: '0.3.9',
  workflowRunId: '24681012',
  workflowRunAttempt: '2',
}

describe('release installation copy', () => {
  it('explains that the universal Mac installer supports both Apple Silicon and Intel', async () => {
    const module = await provenanceModule as {
      createReleaseNotes?: (value: typeof context) => string
    }
    expect(typeof module.createReleaseNotes).toBe('function')
    const notes = module.createReleaseNotes!(context)
    expect(notes).toContain('universal')
    expect(notes).toContain('Apple Silicon')
    expect(notes).toContain('Intel')
    expect(notes).toContain('INSTALL-ME-BabyDiary-Mac.dmg')
  })

  it('retains exactly one machine-readable source provenance marker', async () => {
    const module = await provenanceModule as {
      createReleaseNotes?: (value: typeof context) => string
    }
    expect(typeof module.createReleaseNotes).toBe('function')
    const notes = module.createReleaseNotes!(context)
    expect(notes.match(/<!-- baby-diary-source-provenance:/g)).toHaveLength(1)
  })
})
