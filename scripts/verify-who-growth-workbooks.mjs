import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const SERIES_IDS = Object.freeze(['WFA_BOYS', 'WFA_GIRLS', 'LHFA_BOYS', 'LHFA_GIRLS'])
const REQUIRED_HEADERS = Object.freeze(['Month', 'L', 'M', 'S'])

function fail(message) {
  throw new Error(message)
}

function requireBufferRange(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    fail(`invalid XLSX ZIP range for ${label}`)
  }
}

function findEndOfCentralDirectory(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset
  }
  fail('XLSX ZIP end-of-central-directory record not found')
}

function readZipEntries(bytes) {
  const eocd = findEndOfCentralDirectory(bytes)
  requireBufferRange(bytes, eocd, 22, 'end-of-central-directory')
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) {
    fail('multi-disk XLSX ZIP files are not supported')
  }

  const diskEntries = bytes.readUInt16LE(eocd + 8)
  const entryCount = bytes.readUInt16LE(eocd + 10)
  if (diskEntries !== entryCount || entryCount === 0 || entryCount === 0xffff) {
    fail('invalid or ZIP64 XLSX central directory')
  }

  let offset = bytes.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let index = 0; index < entryCount; index += 1) {
    requireBufferRange(bytes, offset, 46, `central entry ${index}`)
    if (bytes.readUInt32LE(offset) !== 0x02014b50) fail(`invalid XLSX central entry ${index}`)

    const flags = bytes.readUInt16LE(offset + 8)
    const compression = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    requireBufferRange(bytes, offset + 46, nameLength + extraLength + commentLength, `central entry ${index} payload`)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/')

    if ((flags & 1) !== 0) fail(`encrypted XLSX entry is not supported: ${name}`)
    if (compression !== 0 && compression !== 8) fail(`unsupported XLSX compression ${compression}: ${name}`)
    requireBufferRange(bytes, localOffset, 30, `local entry ${name}`)
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) fail(`invalid XLSX local entry: ${name}`)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    requireBufferRange(bytes, dataStart, compressedSize, `compressed entry ${name}`)
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
    const data = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    if (data.length !== uncompressedSize) fail(`XLSX entry size mismatch: ${name}`)
    if (entries.has(name)) fail(`duplicate XLSX ZIP entry: ${name}`)
    entries.set(name, data)
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

function requireEntry(entries, name) {
  const entry = entries.get(name)
  if (!entry) fail(`missing XLSX entry: ${name}`)
  return entry.toString('utf8')
}

function decodeXml(value) {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function attributesFrom(tag) {
  const attributes = new Map()
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    attributes.set(match[1], decodeXml(match[2]))
  }
  return attributes
}

function worksheetEntryFor(entries, expectedWorksheet, seriesId) {
  const workbook = requireEntry(entries, 'xl/workbook.xml')
  let relationshipId = null
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?\s*>/g)) {
    const attributes = attributesFrom(match[0])
    if (attributes.get('name') === expectedWorksheet) {
      relationshipId = attributes.get('r:id') ?? null
      break
    }
  }
  if (!relationshipId) fail(`${seriesId} worksheet ${JSON.stringify(expectedWorksheet)} not found`)

  const relationships = requireEntry(entries, 'xl/_rels/workbook.xml.rels')
  let target = null
  for (const match of relationships.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const attributes = attributesFrom(match[0])
    if (attributes.get('Id') === relationshipId && attributes.get('Type')?.endsWith('/worksheet')) {
      target = attributes.get('Target') ?? null
      break
    }
  }
  if (!target) fail(`${seriesId} worksheet relationship ${relationshipId} not found`)

  const normalized = target.startsWith('/')
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join('xl', target))
  if (normalized.startsWith('../') || !normalized.startsWith('xl/')) {
    fail(`${seriesId} worksheet target escapes the workbook: ${target}`)
  }
  if (!entries.has(normalized)) fail(`${seriesId} worksheet entry not found: ${normalized}`)
  return normalized
}

function textNodes(xml) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map(match => decodeXml(match[1]))
    .join('')
}

function sharedStringsFrom(entries) {
  const bytes = entries.get('xl/sharedStrings.xml')
  if (!bytes) return []
  const xml = bytes.toString('utf8')
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .map(match => textNodes(match[1]))
}

function cellValue(attributes, body, sharedStrings, seriesId) {
  if (attributes.get('t') === 'inlineStr') return textNodes(body)
  const valueMatch = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)
  if (!valueMatch) return undefined
  const raw = decodeXml(valueMatch[1]).trim()
  if (attributes.get('t') === 's') {
    const index = Number(raw)
    if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) {
      fail(`${seriesId} invalid shared-string index: ${raw}`)
    }
    return sharedStrings[index]
  }
  if (attributes.get('t') === 'str') return raw
  const number = Number(raw)
  if (!Number.isFinite(number)) fail(`${seriesId} invalid numeric cell: ${raw}`)
  return number
}

function rowsFromWorksheet(xml, sharedStrings, seriesId) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map()
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = attributesFrom(cellMatch[1])
      const reference = attributes.get('r')
      const column = reference?.match(/^[A-Z]+/)?.[0]
      if (!column) fail(`${seriesId} cell is missing an A1 reference`)
      if (cells.has(column)) fail(`${seriesId} duplicate cell column ${column}`)
      cells.set(column, cellValue(attributes, cellMatch[2], sharedStrings, seriesId))
    }
    rows.push(cells)
  }
  if (rows.length === 0) fail(`${seriesId} worksheet has no rows`)
  return rows
}

function extractSeries(entries, worksheetEntry, seriesId) {
  const sharedStrings = sharedStringsFrom(entries)
  const sheetRows = rowsFromWorksheet(requireEntry(entries, worksheetEntry), sharedStrings, seriesId)
  const headers = new Map()
  for (const [column, value] of sheetRows[0]) {
    if (typeof value === 'string') {
      if (headers.has(value)) fail(`${seriesId} duplicate header: ${value}`)
      headers.set(value, column)
    }
  }
  for (const header of REQUIRED_HEADERS) {
    if (!headers.has(header)) fail(`${seriesId} missing required header: ${header}`)
  }

  const extracted = []
  for (const cells of sheetRows.slice(1)) {
    const month = cells.get(headers.get('Month'))
    if (typeof month !== 'number' || month < 0 || month > 24) continue
    const row = { month }
    for (const field of ['L', 'M', 'S']) {
      const value = cells.get(headers.get(field))
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`${seriesId} month ${month} is missing numeric ${field}`)
      }
      row[field] = value
    }
    extracted.push(row)
  }

  if (extracted.length !== 25 || extracted.some((row, index) => row.month !== index)) {
    fail(`${seriesId} months must be exactly 0 through 24 in order`)
  }
  return extracted
}

function sameRows(actual, expected) {
  return Array.isArray(expected)
    && actual.length === expected.length
    && actual.every((row, index) => {
      const candidate = expected[index]
      return candidate
        && row.month === candidate.month
        && row.L === candidate.L
        && row.M === candidate.M
        && row.S === candidate.S
    })
}

function requireExactKeys(value, label) {
  if (!value || typeof value !== 'object') fail(`${label} must be an object`)
  const keys = Object.keys(value)
  if (keys.length !== SERIES_IDS.length || SERIES_IDS.some((id, index) => keys[index] !== id)) {
    fail(`${label} keys must be exactly ${SERIES_IDS.join(', ')} in order`)
  }
}

export function verifyWhoGrowthWorkbooks({ manifest, workbookPaths, appSeries }) {
  requireExactKeys(manifest?.sources, 'manifest sources')
  requireExactKeys(workbookPaths, 'workbook paths')
  requireExactKeys(appSeries, 'app series')

  const series = []
  let totalRows = 0
  for (const id of SERIES_IDS) {
    const source = manifest.sources[id]
    if (!source || typeof source.sha256 !== 'string' || typeof source.worksheet !== 'string') {
      fail(`${id} manifest source metadata is incomplete`)
    }
    const bytes = readFileSync(workbookPaths[id])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== source.sha256) {
      fail(`${id} SHA-256 mismatch: expected ${source.sha256}, received ${sha256}`)
    }

    const entries = readZipEntries(bytes)
    const worksheetEntry = worksheetEntryFor(entries, source.worksheet, id)
    const extracted = extractSeries(entries, worksheetEntry, id)
    if (!sameRows(extracted, source.rows)) fail(`${id} manifest rows mismatch`)
    if (!sameRows(extracted, appSeries[id])) fail(`${id} app rows mismatch`)
    series.push(Object.freeze({ id, rows: extracted.length, sha256 }))
    totalRows += extracted.length
  }

  if (totalRows !== 100) fail(`expected 100 WHO LMS rows, received ${totalRows}`)
  return Object.freeze({ series: Object.freeze(series), totalRows })
}
