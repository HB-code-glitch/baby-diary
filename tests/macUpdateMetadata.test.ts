import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

type RefreshModule = {
  refreshMacUpdateMetadata?: (
    options: { releaseDir: string; version: string },
    dependencies: {
      buildBlockMap: (input: string, compression: string, output: string) => Promise<{
        size: number
        sha512: string
      }>
    },
  ) => Promise<{ dmgCount: number }>
}

const yaml = createRequire(import.meta.url)('js-yaml') as {
  dump(value: unknown, options?: unknown): string
  load(value: string): any
}
const refreshModule = import('../scripts/refresh-mac-update-metadata.mjs').catch(() => ({}))
const temporaryDirectories: string[] = []
const version = '0.3.9'

function sha512(bytes: Buffer) {
  return createHash('sha512').update(bytes).digest('base64')
}

async function fixture(includeUniversalDmg = true) {
  const releaseDir = await mkdtemp(join(tmpdir(), 'baby-diary-mac-metadata-'))
  temporaryDirectories.push(releaseDir)
  const armDmg = Buffer.from('final-stapled-arm64-dmg')
  const universalDmg = Buffer.from('final-stapled-universal-dmg')
  const armZip = Buffer.from('signed-arm64-zip')
  const universalZip = Buffer.from('signed-universal-zip')
  await Promise.all([
    writeFile(join(releaseDir, `Baby Diary-${version}-arm64.dmg`), armDmg),
    writeFile(join(releaseDir, `Baby Diary-${version}-universal.dmg`), universalDmg),
    writeFile(join(releaseDir, `Baby Diary-${version}-arm64.dmg.blockmap`), 'old-arm-blockmap'),
    writeFile(join(releaseDir, `Baby Diary-${version}-universal.dmg.blockmap`), 'old-universal-blockmap'),
  ])

  const files = [
    { url: `Baby-Diary-${version}-arm64-mac.zip`, sha512: sha512(armZip), size: armZip.length },
    { url: `Baby-Diary-${version}-arm64.dmg`, sha512: 'stale-arm', size: 1 },
    { url: `Baby-Diary-${version}-universal-mac.zip`, sha512: sha512(universalZip), size: universalZip.length },
  ]
  if (includeUniversalDmg) {
    files.push({ url: `Baby-Diary-${version}-universal.dmg`, sha512: 'stale-universal', size: 1 })
  }
  const latest = {
    version,
    files,
    path: `Baby-Diary-${version}-universal-mac.zip`,
    sha512: sha512(universalZip),
    releaseDate: '2026-07-13T00:00:00.000Z',
  }
  const latestPath = join(releaseDir, 'latest-mac.yml')
  await writeFile(latestPath, yaml.dump(latest), 'utf8')
  return { releaseDir, latestPath, latestSource: await readFile(latestPath, 'utf8'), armDmg, universalDmg }
}

async function api() {
  const module = await refreshModule as RefreshModule
  expect(typeof module.refreshMacUpdateMetadata).toBe('function')
  return module.refreshMacUpdateMetadata!
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('post-staple Mac updater metadata refresh', () => {
  it('regenerates both DMG blockmaps and binds latest-mac.yml to the final DMG bytes', async () => {
    const refresh = await api()
    const { releaseDir, latestPath, armDmg, universalDmg } = await fixture()
    const result = await refresh({ releaseDir, version }, {
      buildBlockMap: async (input, compression, output) => {
        expect(compression).toBe('gzip')
        const bytes = await readFile(input)
        await writeFile(output, `blockmap:${basename(input)}`)
        return { size: bytes.length, sha512: sha512(bytes) }
      },
    })

    expect(result.dmgCount).toBe(2)
    const latest = yaml.load(await readFile(latestPath, 'utf8'))
    const entry = (name: string) => latest.files.find((file: any) => file.url === name)
    expect(entry(`Baby-Diary-${version}-arm64.dmg`)).toMatchObject({
      size: armDmg.length,
      sha512: sha512(armDmg),
    })
    expect(entry(`Baby-Diary-${version}-universal.dmg`)).toMatchObject({
      size: universalDmg.length,
      sha512: sha512(universalDmg),
    })
    expect(entry(`Baby-Diary-${version}-universal-mac.zip`).sha512).toBe(latest.sha512)
    expect(await readFile(join(releaseDir, `Baby Diary-${version}-arm64.dmg.blockmap`), 'utf8'))
      .toBe(`blockmap:Baby Diary-${version}-arm64.dmg`)
    expect(await readFile(join(releaseDir, `Baby Diary-${version}-universal.dmg.blockmap`), 'utf8'))
      .toBe(`blockmap:Baby Diary-${version}-universal.dmg`)
  })

  it('fails before regeneration when latest-mac.yml omits either final DMG', async () => {
    const refresh = await api()
    const { releaseDir, latestPath, latestSource } = await fixture(false)
    let buildCalls = 0
    await expect(refresh({ releaseDir, version }, {
      buildBlockMap: async () => {
        buildCalls += 1
        return { size: 1, sha512: 'unused' }
      },
    })).rejects.toThrow(/universal\.dmg/)
    expect(buildCalls).toBe(0)
    expect(await readFile(latestPath, 'utf8')).toBe(latestSource)
  })

  it('does not publish staged metadata when blockmap generation reports different source bytes', async () => {
    const refresh = await api()
    const { releaseDir, latestPath, latestSource } = await fixture()
    await expect(refresh({ releaseDir, version }, {
      buildBlockMap: async (_input, _compression, output) => {
        await writeFile(output, 'new-but-invalid-blockmap')
        return { size: 1, sha512: 'wrong' }
      },
    })).rejects.toThrow(/changed while regenerating/)
    expect(await readFile(latestPath, 'utf8')).toBe(latestSource)
    expect(await readFile(join(releaseDir, `Baby Diary-${version}-arm64.dmg.blockmap`), 'utf8'))
      .toBe('old-arm-blockmap')
  })
})
