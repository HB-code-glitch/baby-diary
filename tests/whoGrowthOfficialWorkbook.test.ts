import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { verifyWhoGrowthWorkbooks } from '../scripts/verify-who-growth-workbooks.mjs'
import {
  LHFA_BOYS,
  LHFA_GIRLS,
  WFA_BOYS,
  WFA_GIRLS,
} from '../src/lib/whoGrowthData'

const ROOT = process.cwd()
const FIXTURE_DIRECTORY = join(ROOT, 'tests', 'fixtures', 'who-growth-official')
const MANIFEST_PATH = join(ROOT, 'tests', 'fixtures', 'who-growth-standards.manifest.json')

const WORKBOOK_PATHS = {
  WFA_BOYS: join(FIXTURE_DIRECTORY, 'wfa_boys_0-to-5-years_zscores.xlsx'),
  WFA_GIRLS: join(FIXTURE_DIRECTORY, 'wfa_girls_0-to-5-years_zscores.xlsx'),
  LHFA_BOYS: join(FIXTURE_DIRECTORY, 'lhfa_boys_0-to-2-years_zscores.xlsx'),
  LHFA_GIRLS: join(FIXTURE_DIRECTORY, 'lhfa_girls_0-to-2-years_zscores.xlsx'),
} as const

const APP_SERIES = {
  WFA_BOYS,
  WFA_GIRLS,
  LHFA_BOYS,
  LHFA_GIRLS,
} as const

type SeriesId = keyof typeof APP_SERIES

interface LmsRow {
  month: number
  L: number
  M: number
  S: number
}

interface Manifest {
  sources: Record<SeriesId, {
    sha256: string
    worksheet: string
    rows: LmsRow[]
  }>
}

interface ZipEntry {
  name: string
  data: Buffer
}

const TEMP_DIRECTORY = mkdtempSync(join(tmpdir(), 'who-growth-workbook-test-'))
let mutationSequence = 0

afterAll(() => {
  rmSync(TEMP_DIRECTORY, { recursive: true, force: true })
})

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('ZIP end-of-central-directory record not found')
}

function readZipEntries(bytes: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes)
  const entryCount = bytes.readUInt16LE(eocd + 10)
  let offset = bytes.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < entryCount; index += 1) {
    expect(bytes.readUInt32LE(offset), `central entry ${index}`).toBe(0x02014b50)
    const compression = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')

    expect(bytes.readUInt32LE(localOffset), `local entry ${name}`).toBe(0x04034b50)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
    const data = compression === 0
      ? Buffer.from(compressed)
      : compression === 8
        ? inflateRawSync(compressed)
        : (() => { throw new Error(`unsupported ZIP compression ${compression}`) })()

    entries.push({ name, data })
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  return crc >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function writeStoredZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(entry.data.length, 18)
    localHeader.writeUInt32LE(entry.data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localParts.push(localHeader, name, entry.data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(entry.data.length, 20)
    centralHeader.writeUInt32LE(entry.data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(centralHeader, name)
    localOffset += localHeader.length + name.length + entry.data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function mutateWorkbook(
  seriesId: SeriesId,
  entryName: string,
  transform: (xml: string) => string,
): string {
  const entries = readZipEntries(readFileSync(WORKBOOK_PATHS[seriesId]))
  const entry = entries.find(candidate => candidate.name === entryName)
  expect(entry, entryName).toBeDefined()
  const before = entry!.data.toString('utf8')
  const after = transform(before)
  expect(after, `${entryName} mutation`).not.toBe(before)
  entry!.data = Buffer.from(after, 'utf8')

  const path = join(TEMP_DIRECTORY, `${mutationSequence += 1}-${seriesId}.xlsx`)
  writeFileSync(path, writeStoredZip(entries))
  return path
}

function withWorkbookHash(manifest: Manifest, seriesId: SeriesId, workbookPath: string): Manifest {
  const copy = structuredClone(manifest)
  copy.sources[seriesId].sha256 = createHash('sha256').update(readFileSync(workbookPath)).digest('hex')
  return copy
}

function replaceCellValue(xml: string, row: number, column: string, replacement: string): string {
  const pattern = new RegExp(`(<c r="${column}${row}"[^>]*><v>)[^<]+(</v>)`)
  return xml.replace(pattern, `$1${replacement}$2`)
}

function workbookOptions(overrides: {
  manifest?: Manifest
  workbookPaths?: Record<SeriesId, string>
  appSeries?: Record<SeriesId, readonly LmsRow[]>
} = {}) {
  return {
    manifest: overrides.manifest ?? readManifest(),
    workbookPaths: overrides.workbookPaths ?? { ...WORKBOOK_PATHS },
    appSeries: overrides.appSeries ?? APP_SERIES,
  }
}

describe('official WHO XLSX workbook verifier', () => {
  it('binds four exact official workbook bytes and 100 extracted rows to the manifest and app arrays', () => {
    const result = verifyWhoGrowthWorkbooks(workbookOptions())

    expect(result.series).toEqual([
      { id: 'WFA_BOYS', rows: 25, sha256: 'f8f5a77b944ff7a8c1524e76f9d33f8a93cc423d23c2e7f2b10ba6b96a428e69' },
      { id: 'WFA_GIRLS', rows: 25, sha256: '01e9a6fda2f3723dbc74d3c86bfbfcb9f6d474367d1d7b4a804501a2debd2ef1' },
      { id: 'LHFA_BOYS', rows: 25, sha256: 'ccfd8e455141c9a39dd728d99b7d7e080a925b06ea4a4d7592229665713dba54' },
      { id: 'LHFA_GIRLS', rows: 25, sha256: '6757f5eb96b51ab5cdb4828105929c78b1fb3d73b0fd8fa65682ad9f60f8c083' },
    ])
    expect(result.totalRows).toBe(100)
  })

  it('rejects bytes that do not match the pinned SHA-256', () => {
    const wrongBytes = join(TEMP_DIRECTORY, 'wrong-bytes.xlsx')
    writeFileSync(wrongBytes, Buffer.concat([readFileSync(WORKBOOK_PATHS.WFA_BOYS), Buffer.from([0])]))
    const workbookPaths = { ...WORKBOOK_PATHS, WFA_BOYS: wrongBytes }

    expect(() => verifyWhoGrowthWorkbooks(workbookOptions({ workbookPaths })))
      .toThrow(/WFA_BOYS SHA-256 mismatch/)
  })

  it.each([
    ['sex', WORKBOOK_PATHS.WFA_GIRLS],
    ['metric', WORKBOOK_PATHS.LHFA_BOYS],
  ])('rejects a wrong %s workbook mapping', (_mapping, wrongWorkbook) => {
    const workbookPaths = { ...WORKBOOK_PATHS, WFA_BOYS: wrongWorkbook }

    expect(() => verifyWhoGrowthWorkbooks(workbookOptions({ workbookPaths })))
      .toThrow(/WFA_BOYS SHA-256 mismatch/)
  })

  it('rejects the wrong worksheet even when its new bytes are re-hashed', () => {
    const workbookPath = mutateWorkbook('WFA_BOYS', 'xl/workbook.xml', xml =>
      xml.replace('wfa_boys_0 to 5 years_zscores', 'unexpected_growth_sheet'))
    const manifest = withWorkbookHash(readManifest(), 'WFA_BOYS', workbookPath)
    const workbookPaths = { ...WORKBOOK_PATHS, WFA_BOYS: workbookPath }

    expect(() => verifyWhoGrowthWorkbooks(workbookOptions({ manifest, workbookPaths })))
      .toThrow(/WFA_BOYS worksheet .* not found/)
  })

  it.each(['Month', 'L', 'M', 'S'])('rejects a missing required %s header even when its new bytes are re-hashed', header => {
    const workbookPath = mutateWorkbook('WFA_BOYS', 'xl/sharedStrings.xml', xml =>
      xml.replace(`<t>${header}</t>`, `<t>${header}_wrong</t>`))
    const manifest = withWorkbookHash(readManifest(), 'WFA_BOYS', workbookPath)
    const workbookPaths = { ...WORKBOOK_PATHS, WFA_BOYS: workbookPath }

    expect(() => verifyWhoGrowthWorkbooks(workbookOptions({ manifest, workbookPaths })))
      .toThrow(new RegExp(`WFA_BOYS missing required header: ${header}`))
  })

  it.each([
    ['missing', (xml: string) => xml.replace(/<row r="14"[\s\S]*?<\/row>/, '')],
    ['duplicate', (xml: string) => replaceCellValue(xml, 15, 'A', '12')],
    ['reordered', (xml: string) => {
      const first = xml.match(/<row r="14"[\s\S]*?<\/row>/)?.[0] ?? ''
      const second = xml.match(/<row r="15"[\s\S]*?<\/row>/)?.[0] ?? ''
      return xml.replace(first, '__FIRST_ROW__').replace(second, first).replace('__FIRST_ROW__', second)
    }],
    ['extra', (xml: string) => {
      const row = xml.match(/<row r="26"[\s\S]*?<\/row>/)?.[0] ?? ''
      return xml.replace(row, `${row}${row}`)
    }],
  ])('rejects %s or otherwise non-canonical 0-24 month rows', (_label, transform) => {
    const workbookPath = mutateWorkbook('WFA_BOYS', 'xl/worksheets/sheet1.xml', transform)
    const manifest = withWorkbookHash(readManifest(), 'WFA_BOYS', workbookPath)
    const workbookPaths = { ...WORKBOOK_PATHS, WFA_BOYS: workbookPath }

    expect(() => verifyWhoGrowthWorkbooks(workbookOptions({ manifest, workbookPaths })))
      .toThrow(/WFA_BOYS months must be exactly 0 through 24 in order/)
  })

  it('rejects workbook value drift even when its new bytes are re-hashed', () => {
    const workbookPath = mutateWorkbook('WFA_BOYS', 'xl/worksheets/sheet1.xml', xml =>
      replaceCellValue(xml, 2, 'C', '3.3465'))
    const manifest = withWorkbookHash(readManifest(), 'WFA_BOYS', workbookPath)
    const workbookPaths = { ...WORKBOOK_PATHS, WFA_BOYS: workbookPath }

    expect(() => verifyWhoGrowthWorkbooks(workbookOptions({ manifest, workbookPaths })))
      .toThrow(/WFA_BOYS manifest rows mismatch/)
  })

  it('rejects manifest value drift independently of the app arrays', () => {
    const manifest = readManifest()
    manifest.sources.WFA_BOYS.rows[0].M += 0.0001

    expect(() => verifyWhoGrowthWorkbooks(workbookOptions({ manifest })))
      .toThrow(/WFA_BOYS manifest rows mismatch/)
  })

  it('rejects app-array value drift independently of the manifest', () => {
    const appSeries = structuredClone(APP_SERIES) as unknown as Record<SeriesId, LmsRow[]>
    appSeries.WFA_BOYS[0].M += 0.0001

    expect(() => verifyWhoGrowthWorkbooks(workbookOptions({ appSeries })))
      .toThrow(/WFA_BOYS app rows mismatch/)
  })
})
