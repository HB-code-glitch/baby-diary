import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIREBASE_PERSISTENCE_REGISTRY_FILE,
  FirebasePersistenceRegistry,
  detectPreexistingFirebaseProfile,
} from '../electron/store/firebasePersistenceRegistry'
import { BABY_INFO_JOURNAL_FILE } from '../electron/store/babyInfoJournal'
import { SettingsStore } from '../electron/store/settings'
import {
  LEGACY_FIREBASE_APP_NAME,
  canonicalFirebaseConfig,
  getDigestFirebasePersistenceIdentity,
  getUnreleasedFNVFirebaseAppName,
  parseFirebasePersistenceClaim,
  sha256Hex,
} from '../shared/firebasePersistence'
import { DEFAULT_FIREBASE_CONFIG } from '../shared/defaultFirebaseConfig'
import { V038_AUTH_LEVELDB_FIXTURE } from './fixtures/firebaseV038AuthLevelDb'

const roots: string[] = []

const customConfig = {
  apiKey: 'custom-api-key',
  authDomain: 'custom.example.test',
  projectId: 'custom-project',
  storageBucket: 'custom-bucket',
  messagingSenderId: '987654321',
  appId: 'custom-app-id',
}

const otherConfig = {
  ...customConfig,
  apiKey: 'other-api-key',
  projectId: 'other-project',
  appId: 'other-app-id',
}

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `baby-diary-firebase-${label}-`))
  roots.push(root)
  return root
}

function writeSettingsEvidence(root: string, firebase: typeof customConfig | null): void {
  writeFileSync(join(root, 'settings.json'), JSON.stringify({
    baby: { name: '아기', birthdate: '2026-01-01' },
    profile: { uid: 'legacy-user', name: '보호자', role: 'mom' },
    familyId: 'ABCDEFGHJKLM',
    firebase,
  }))
}

function writeV038AuthLevelDb(root: string, authLog?: Buffer): string {
  const levelDb = join(root, 'IndexedDB', 'file__0.indexeddb.leveldb')
  mkdirSync(levelDb, { recursive: true })
  writeFileSync(join(levelDb, 'CURRENT'), Buffer.from(V038_AUTH_LEVELDB_FIXTURE.current, 'base64'))
  writeFileSync(join(levelDb, 'MANIFEST-000001'), Buffer.from(V038_AUTH_LEVELDB_FIXTURE.manifest, 'base64'))
  writeFileSync(join(levelDb, '000005.ldb'), Buffer.from(V038_AUTH_LEVELDB_FIXTURE.table, 'base64'))
  writeFileSync(
    join(levelDb, '000004.log'),
    authLog ?? Buffer.from(V038_AUTH_LEVELDB_FIXTURE.authLog, 'base64'),
  )
  return levelDb
}

function writeVerifiedRecoveryBackup(root: string): void {
  const snapshot = join(root, 'backups', '2026-07-13_10-20-30')
  mkdirSync(join(snapshot, 'data'), { recursive: true })
  const settings = {
    baby: { name: 'Recovery Baby', birthdate: '2026-01-01', gender: 'girl' },
    profile: { uid: 'recovery-parent', name: 'Recovery Parent', role: 'mom' },
    familyId: 'ABCDEFGHJKLM',
    firebase: customConfig,
  }
  writeFileSync(join(snapshot, 'settings.json'), JSON.stringify(settings, null, 2))
  writeFileSync(join(snapshot, BABY_INFO_JOURNAL_FILE), '')
  writeFileSync(join(snapshot, 'data', '2026-07.jsonl'), '{"event":true}\n')
  const relativePaths = [
    'settings.json',
    BABY_INFO_JOURNAL_FILE,
    'data/2026-07.jsonl',
  ]
  const files = relativePaths.map(relativePath => {
    const bytes = readFileSync(join(snapshot, ...relativePath.split('/')))
    return {
      path: relativePath,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
  writeFileSync(join(snapshot, 'manifest.json'), JSON.stringify({
    version: 1,
    source: 'baby-diary',
    snapshotTimestamp: '2026-07-13T10:20:30.000Z',
    files,
  }, null, 2))
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? 0x82f63b78 : 0)
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32c(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ CRC32C_TABLE[(value ^ byte) & 0xff]
  return (~value) >>> 0
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  do {
    let byte = value & 0x7f
    value = Math.floor(value / 128)
    if (value > 0) byte |= 0x80
    bytes.push(byte)
  } while (value > 0)
  return Buffer.from(bytes)
}

function makeLevelDbPhysicalRecord(payload: Buffer, type = 0x01): Buffer {
  const typeBytes = Buffer.from([type])
  const record = Buffer.alloc(7 + payload.length)
  record.writeUInt16LE(payload.length, 4)
  record[6] = type
  payload.copy(record, 7)
  const checksum = crc32c(Buffer.concat([typeBytes, payload]))
  record.writeUInt32LE((((checksum >>> 15) | (checksum << 17)) + 0xa282ead8) >>> 0, 0)
  return record
}

function makeLevelDbManifest(options: {
  logNumber?: number
  previousLogNumber?: number
  tableNumbers?: number[]
}): Buffer {
  const edit: Buffer[] = []
  if (options.logNumber !== undefined) {
    edit.push(Buffer.from([0x02]), encodeVarint(options.logNumber))
  }
  if (options.previousLogNumber !== undefined) {
    edit.push(Buffer.from([0x09]), encodeVarint(options.previousLogNumber))
  }
  for (const tableNumber of options.tableNumbers ?? []) {
    edit.push(
      Buffer.from([0x07]),
      encodeVarint(0),
      encodeVarint(tableNumber),
      encodeVarint(1),
      Buffer.from([0x00, 0x00]),
    )
  }
  return makeLevelDbPhysicalRecord(Buffer.concat(edit))
}

function makeChromiumIndexedDbAuthKey(apiKey: string, appName: string): Buffer {
  const authKey = `firebase:authUser:${apiKey}:${appName}`
  const utf16Be = Buffer.from(authKey, 'utf16le').swap16()
  // Chromium IndexedDB backing-store key: one-byte id lengths, database 2,
  // object store 1, data index 1, IDB string key, UTF-16 code-unit length.
  return Buffer.concat([
    Buffer.from([0x00, 0x02, 0x01, 0x01, 0x01]),
    encodeVarint(authKey.length),
    utf16Be,
  ])
}

function makeChromiumIndexedDbAuthLog(
  apiKey: string,
  appName: string,
  options: {
    sequenceLow?: number
    sequenceHigh?: number
    operation?: 'put' | 'delete'
  } = {},
): Buffer {
  const indexedDbKey = makeChromiumIndexedDbAuthKey(apiKey, appName)
  const operation = options.operation ?? 'put'
  const batch = Buffer.concat([
    Buffer.alloc(8),
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    Buffer.from([operation === 'put' ? 0x01 : 0x00]),
    encodeVarint(indexedDbKey.length),
    indexedDbKey,
    ...(operation === 'put' ? [Buffer.from([0x01, 0x00])] : []),
  ])
  batch.writeUInt32LE(options.sequenceLow ?? 0, 0)
  batch.writeUInt32LE(options.sequenceHigh ?? 0, 4)
  return makeLevelDbPhysicalRecord(batch)
}

function makeLevelDbBlock(entries: Array<{ key: Buffer; value: Buffer }>): Buffer {
  const encoded: Buffer[] = []
  const restartOffsets: number[] = []
  let offset = 0
  for (const entry of entries) {
    restartOffsets.push(offset)
    const item = Buffer.concat([
      encodeVarint(0),
      encodeVarint(entry.key.length),
      encodeVarint(entry.value.length),
      entry.key,
      entry.value,
    ])
    encoded.push(item)
    offset += item.length
  }
  if (restartOffsets.length === 0) restartOffsets.push(0)
  const restartArray = Buffer.alloc(restartOffsets.length * 4 + 4)
  restartOffsets.forEach((value, index) => restartArray.writeUInt32LE(value, index * 4))
  restartArray.writeUInt32LE(restartOffsets.length, restartOffsets.length * 4)
  return Buffer.concat([...encoded, restartArray])
}

function appendLevelDbTableBlock(parts: Buffer[], block: Buffer): { offset: number; size: number } {
  const offset = parts.reduce((total, part) => total + part.length, 0)
  const compression = Buffer.from([0])
  const trailer = Buffer.alloc(5)
  trailer[0] = compression[0]
  const checksum = crc32c(Buffer.concat([block, compression]))
  trailer.writeUInt32LE((((checksum >>> 15) | (checksum << 17)) + 0xa282ead8) >>> 0, 1)
  parts.push(block, trailer)
  return { offset, size: block.length }
}

function makeLevelDbAuthTable(options: {
  apiKey: string
  appName: string
  sequenceLow: number
  sequenceHigh?: number
  operation: 'put' | 'delete'
}): Buffer {
  const userKey = makeChromiumIndexedDbAuthKey(options.apiKey, options.appName)
  const sequenceHigh = options.sequenceHigh ?? 0
  const trailerLow = ((options.sequenceLow << 8) | (options.operation === 'put' ? 1 : 0)) >>> 0
  const trailerHigh = ((sequenceHigh << 8) | (options.sequenceLow >>> 24)) >>> 0
  const internalTrailer = Buffer.alloc(8)
  internalTrailer.writeUInt32LE(trailerLow, 0)
  internalTrailer.writeUInt32LE(trailerHigh, 4)
  const dataBlock = makeLevelDbBlock([{
    key: Buffer.concat([userKey, internalTrailer]),
    value: Buffer.alloc(0),
  }])
  const parts: Buffer[] = []
  const dataHandle = appendLevelDbTableBlock(parts, dataBlock)
  const metaHandle = appendLevelDbTableBlock(parts, makeLevelDbBlock([]))
  const dataHandleBytes = Buffer.concat([
    encodeVarint(dataHandle.offset),
    encodeVarint(dataHandle.size),
  ])
  const indexHandle = appendLevelDbTableBlock(parts, makeLevelDbBlock([{
    key: Buffer.from([0xff]),
    value: dataHandleBytes,
  }]))
  const footer = Buffer.alloc(48)
  const handles = Buffer.concat([
    encodeVarint(metaHandle.offset),
    encodeVarint(metaHandle.size),
    encodeVarint(indexHandle.offset),
    encodeVarint(indexHandle.size),
  ])
  handles.copy(footer)
  Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]).copy(footer, 40)
  parts.push(footer)
  return Buffer.concat(parts)
}

interface LevelDbTestBlock {
  stored: Buffer
  compression: 0 | 1
}

interface LevelDbTestBlockHandle {
  offset: number
  size: number
}

function makeLevelDbTableFixture(
  dataBlocks: LevelDbTestBlock[],
  transformHandles: (handles: LevelDbTestBlockHandle[]) => LevelDbTestBlockHandle[] = handles => handles,
): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  const append = ({ stored, compression }: LevelDbTestBlock): LevelDbTestBlockHandle => {
    const handle = { offset, size: stored.length }
    const compressionBytes = Buffer.from([compression])
    const trailer = Buffer.alloc(5)
    trailer[0] = compression
    const checksum = crc32c(Buffer.concat([stored, compressionBytes]))
    trailer.writeUInt32LE((((checksum >>> 15) | (checksum << 17)) + 0xa282ead8) >>> 0, 1)
    parts.push(stored, trailer)
    offset += stored.length + trailer.length
    return handle
  }
  const dataHandles = dataBlocks.map(append)
  const metaHandle = append({ stored: makeLevelDbBlock([]), compression: 0 })
  const indexEntries = transformHandles(dataHandles).map((handle, index) => {
    const key = Buffer.alloc(4)
    key.writeUInt32BE(index)
    return {
      key,
      value: Buffer.concat([encodeVarint(handle.offset), encodeVarint(handle.size)]),
    }
  })
  const indexHandle = append({ stored: makeLevelDbBlock(indexEntries), compression: 0 })
  const footer = Buffer.alloc(48)
  Buffer.concat([
    encodeVarint(metaHandle.offset),
    encodeVarint(metaHandle.size),
    encodeVarint(indexHandle.offset),
    encodeVarint(indexHandle.size),
  ]).copy(footer)
  Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]).copy(footer, 40)
  parts.push(footer)
  return Buffer.concat(parts)
}

function makeSnappyEmptyLevelDbBlock(logicalBytes: number): Buffer {
  if (logicalBytes < 8 || logicalBytes % 4 !== 0) {
    throw new Error('Snappy LevelDB test block size must be a positive restart-array size')
  }
  const restartCount = (logicalBytes - 4) / 4
  const header = encodeVarint(logicalBytes)
  const zerosRemaining = logicalBytes - 5
  const copyCount = Math.ceil(zerosRemaining / 64)
  const encoded = Buffer.alloc(header.length + 2 + copyCount * 3 + 5)
  header.copy(encoded)
  let offset = header.length
  // One literal zero seeds distance-one copies for the all-zero restart array.
  encoded[offset] = 0x00
  encoded[offset + 1] = 0x00
  offset += 2
  let unwrittenZeros = zerosRemaining
  while (unwrittenZeros > 0) {
    const length = Math.min(64, unwrittenZeros)
    encoded[offset] = ((length - 1) << 2) | 0x02
    encoded[offset + 1] = 0x01
    encoded[offset + 2] = 0x00
    offset += 3
    unwrittenZeros -= length
  }
  encoded[offset] = 0x0c
  encoded.writeUInt32LE(restartCount, offset + 1)
  return encoded
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('main-owned Firebase persistence registry', () => {
  it('matches Node SHA-256 for standard, Unicode, and long canonical inputs', () => {
    const inputs = [
      '',
      'abc',
      '아기日記👶',
      'firebase-canonical-config/'.repeat(8_192),
    ]
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(
        createHash('sha256').update(input, 'utf8').digest('hex'),
      )
    }
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('inherits the released v0.3.8 namespace from captured Auth key encoding when settings is absent', () => {
    const root = makeRoot('released-browser-evidence')
    const levelDb = writeV038AuthLevelDb(root)
    const protectedFiles = ['CURRENT', 'MANIFEST-000001', '000004.log', '000005.ldb']
    const before = protectedFiles.map(name => readFileSync(join(levelDb, name)))
    const originalApiKey = DEFAULT_FIREBASE_CONFIG.apiKey
    DEFAULT_FIREBASE_CONFIG.apiKey = V038_AUTH_LEVELDB_FIXTURE.placeholderKey
    try {
      const snapshot = detectPreexistingFirebaseProfile(root)
      const registry = FirebasePersistenceRegistry.open(root, snapshot)

      expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
      protectedFiles.forEach((name, index) => {
        expect(readFileSync(join(levelDb, name))).toEqual(before[index])
      })
    } finally {
      DEFAULT_FIREBASE_CONFIG.apiKey = originalApiKey
    }
  })

  it('does not treat an arbitrary cache string as released browser persistence evidence', () => {
    const root = makeRoot('cache-false-positive')
    const token = `firebase:authUser:${DEFAULT_FIREBASE_CONFIG.apiKey}:${LEGACY_FIREBASE_APP_NAME}`
    mkdirSync(join(root, 'Cache'), { recursive: true })
    writeFileSync(join(root, 'Cache', 'entry.bin'), token)

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName)
      .toBe(getDigestFirebasePersistenceIdentity(DEFAULT_FIREBASE_CONFIG).appName)
  })

  it('ignores an older orphan WAL containing the released key when CURRENT/MANIFEST retired it', () => {
    const root = makeRoot('orphan-auth-log')
    const releasedLog = makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
    )
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog('unrelated', 'unrelated'))
    writeFileSync(join(levelDb, '000003.log'), releasedLog)

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName)
      .toBe(getDigestFirebasePersistenceIdentity(DEFAULT_FIREBASE_CONFIG).appName)
  })

  it('scans both current and previous live WALs during a LevelDB log rotation', () => {
    const root = makeRoot('rotating-live-auth-log')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
    ))
    writeFileSync(
      join(levelDb, 'MANIFEST-000001'),
      makeLevelDbManifest({ logNumber: 6, previousLogNumber: 4 }),
    )
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthLog(
      'unrelated',
      'unrelated',
      { sequenceLow: 1 },
    ))

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('applies a higher live WAL tombstone over an older Auth value in an SST', () => {
    const root = makeRoot('higher-live-wal-delete')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      'unrelated',
      'unrelated',
      { sequenceLow: 2 },
    ))
    writeFileSync(join(levelDb, '000005.ldb'), makeLevelDbAuthTable({
      apiKey: DEFAULT_FIREBASE_CONFIG.apiKey,
      appName: LEGACY_FIREBASE_APP_NAME,
      sequenceLow: 1,
      operation: 'put',
    }))
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 3, operation: 'delete' },
    ))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName)
      .toBe(getDigestFirebasePersistenceIdentity(DEFAULT_FIREBASE_CONFIG).appName)
  })

  it('inherits Auth evidence created in a higher live WAL', () => {
    const root = makeRoot('higher-live-wal-create')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      'unrelated',
      'unrelated',
      { sequenceLow: 1 },
    ))
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 2 },
    ))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('merges several higher live WALs in file and sequence order', () => {
    const root = makeRoot('several-higher-live-wals')
    writeSettingsEvidence(root, customConfig)
    const fnvAppName = getUnreleasedFNVFirebaseAppName(customConfig)
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      customConfig.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 1 },
    ))
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthLog(
      customConfig.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 2, operation: 'delete' },
    ))
    writeFileSync(join(levelDb, '000009.log'), makeChromiumIndexedDbAuthLog(
      customConfig.apiKey,
      fnvAppName,
      { sequenceLow: 3 },
    ))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(customConfig)).toMatchObject({
      version: 2,
      appName: fnvAppName,
    })
  })

  it('fails closed on a checksum-invalid higher live WAL', () => {
    const root = makeRoot('corrupt-higher-live-wal')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      'unrelated',
      'unrelated',
      { sequenceLow: 1 },
    ))
    const corrupt = makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 2 },
    )
    corrupt[0] ^= 0xff
    writeFileSync(join(levelDb, '000006.log'), corrupt)

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/checksum|physical record|invalid/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it.each([
    ['gap', 3],
    ['duplicate', 1],
  ])('fails closed on a %s between ordered live WAL WriteBatch sequences', (_label, nextSequence) => {
    const root = makeRoot(`higher-live-wal-${_label}`)
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      'unrelated',
      'unrelated',
      { sequenceLow: 1 },
    ))
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: nextSequence },
    ))

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/sequence|ordered|contiguous/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('detects a stable-directory inventory change while reading a higher live WAL', () => {
    const root = makeRoot('higher-live-wal-inventory-change')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      'unrelated',
      'unrelated',
      { sequenceLow: 1 },
    ))
    const highLogPath = join(levelDb, '000006.log')
    writeFileSync(highLogPath, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 2 },
    ))
    let attacked = false

    expect(() => detectPreexistingFirebaseProfile(root, {
      afterFirstFileRead: target => {
        if (!attacked && target === highLogPath) {
          attacked = true
          writeFileSync(join(levelDb, '000007.log'), makeChromiumIndexedDbAuthLog(
            'late',
            'late',
            { sequenceLow: 3 },
          ))
        }
      },
    })).toThrow(/directory identity changed|changed while reading/i)
    expect(attacked).toBe(true)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('detects an identical-byte atomic swap of a higher live WAL', () => {
    const root = makeRoot('higher-live-wal-atomic-swap')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      'unrelated',
      'unrelated',
      { sequenceLow: 1 },
    ))
    const highLogPath = join(levelDb, '000006.log')
    const displaced = join(levelDb, '000006.displaced.log')
    const original = makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 2 },
    )
    writeFileSync(highLogPath, original)
    let attacked = false

    expect(() => detectPreexistingFirebaseProfile(root, {
      afterFirstFileRead: target => {
        if (!attacked && target === highLogPath) {
          attacked = true
          renameSync(highLogPath, displaced)
          writeFileSync(highLogPath, original)
        }
      },
    })).toThrow(/changed while reading|identity changed|directory identity/i)
    expect(attacked).toBe(true)
    expect(readFileSync(displaced)).toEqual(original)
    expect(readFileSync(highLogPath)).toEqual(original)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('does not resurrect a retired WAL after the rotation manifest clears prev_log_number', () => {
    const root = makeRoot('retired-auth-log')
    const levelDb = writeV038AuthLevelDb(root)
    writeFileSync(
      join(levelDb, 'MANIFEST-000001'),
      makeLevelDbManifest({ logNumber: 6, previousLogNumber: 0 }),
    )
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthLog('unrelated', 'unrelated'))

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName)
      .toBe(getDigestFirebasePersistenceIdentity(DEFAULT_FIREBASE_CONFIG).appName)
  })

  it.each([
    ['CURRENT', (levelDb: string) => writeFileSync(join(levelDb, 'CURRENT'), 'MANIFEST-../escape\n')],
    ['MANIFEST', (levelDb: string) => {
      const manifestPath = join(levelDb, 'MANIFEST-000001')
      const corrupt = Buffer.from(readFileSync(manifestPath))
      corrupt[0] ^= 0xff
      writeFileSync(manifestPath, corrupt)
    }],
  ])('fails closed on malformed %s metadata', (_label, corruptMetadata) => {
    const root = makeRoot(`malformed-${_label.toLowerCase()}`)
    const levelDb = writeV038AuthLevelDb(root)
    corruptMetadata(levelDb)

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/CURRENT|manifest|checksum|invalid/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('validates the captured v0.3.8 Snappy table block even when it has no Auth claim', () => {
    const root = makeRoot('snappy-table-validation')
    const table = Buffer.from(V038_AUTH_LEVELDB_FIXTURE.table, 'base64')
    // Captured table 000005 has one data block at offset 0, size 974, followed by
    // LevelDB compression type 1 (raw Snappy). Detection must decode this block.
    expect(table[974]).toBe(1)
    writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog('unrelated', 'unrelated'))

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName)
      .toBe(getDigestFirebasePersistenceIdentity(DEFAULT_FIREBASE_CONFIG).appName)
  })

  it('rejects duplicate data-block handles in a live SST', () => {
    const root = makeRoot('duplicate-sst-block-handle')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog('unrelated', 'unrelated'))
    const emptyBlock = { stored: makeLevelDbBlock([]), compression: 0 as const }
    writeFileSync(join(levelDb, '000005.ldb'), makeLevelDbTableFixture(
      [emptyBlock],
      handles => [handles[0], handles[0]],
    ))

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/duplicate|overlap/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects overlapping data-block handles in a live SST', () => {
    const root = makeRoot('overlapping-sst-block-handles')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog('unrelated', 'unrelated'))
    const emptyBlock = { stored: makeLevelDbBlock([]), compression: 0 as const }
    writeFileSync(join(levelDb, '000005.ldb'), makeLevelDbTableFixture(
      [emptyBlock],
      handles => [handles[0], { offset: handles[0].offset + 1, size: handles[0].size - 1 }],
    ))

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/duplicate|overlap/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects a live SST whose aggregate block count exceeds the scanner budget', () => {
    const root = makeRoot('sst-block-count-budget')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog('unrelated', 'unrelated'))
    const empty = makeLevelDbBlock([])
    // 16,383 data blocks plus metaindex and index exceed the 16,384-block aggregate budget.
    const dataBlocks = Array.from({ length: 16_383 }, () => ({
      stored: empty,
      compression: 0 as const,
    }))
    writeFileSync(join(levelDb, '000005.ldb'), makeLevelDbTableFixture(dataBlocks))

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/block count|too many.*blocks|budget/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects Snappy blocks whose aggregate logical bytes exceed the scanner budget', () => {
    const root = makeRoot('sst-logical-byte-budget')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog('unrelated', 'unrelated'))
    const compressedEmptyBlock = makeSnappyEmptyLevelDbBlock(33 * 1024 * 1024)
    const table = makeLevelDbTableFixture([{ stored: compressedEmptyBlock, compression: 1 }])
    expect(table.length).toBeLessThan(4 * 1024 * 1024)
    writeFileSync(join(levelDb, '000005.ldb'), table)
    writeFileSync(join(levelDb, '000007.ldb'), table)
    writeFileSync(
      join(levelDb, 'MANIFEST-000001'),
      makeLevelDbManifest({ logNumber: 4, tableNumbers: [5, 7] }),
    )

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/logical|decoded|decompressed|budget/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects a checksum-invalid live WAL without leaking its key or value', () => {
    const root = makeRoot('invalid-live-log-crc')
    const secretValue = 'private.parent@example.test uid-private eyJhbGciOiJub25lIn0.token'
    const live = Buffer.concat([
      makeChromiumIndexedDbAuthLog(DEFAULT_FIREBASE_CONFIG.apiKey, LEGACY_FIREBASE_APP_NAME),
      Buffer.from(secretValue),
    ])
    live[0] ^= 0xff
    writeV038AuthLevelDb(root, live)

    let message = ''
    try {
      detectPreexistingFirebaseProfile(root)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/checksum|physical record|invalid/i)
    expect(message).not.toContain(DEFAULT_FIREBASE_CONFIG.apiKey)
    expect(message).not.toContain('private.parent@example.test')
    expect(message).not.toContain('uid-private')
    expect(message).not.toContain('eyJhbGciOiJub25lIn0')
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('detects a same-inode same-size live WAL rewrite during its stable read', () => {
    const root = makeRoot('live-log-same-inode-rewrite')
    const levelDb = writeV038AuthLevelDb(root)
    const logPath = join(levelDb, '000004.log')
    const changed = Buffer.from(readFileSync(logPath))
    changed[changed.length - 1] ^= 0x01
    let attacked = false

    expect(() => detectPreexistingFirebaseProfile(root, {
      afterFirstFileRead: target => {
        if (!attacked && target === logPath) {
          attacked = true
          writeFileSync(logPath, changed)
        }
      },
    })).toThrow(/changed while reading|identity changed/i)
    expect(attacked).toBe(true)
    expect(readFileSync(logPath)).toEqual(changed)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('detects an identical-byte atomic live WAL path swap', () => {
    const root = makeRoot('live-log-atomic-swap')
    const levelDb = writeV038AuthLevelDb(root)
    const logPath = join(levelDb, '000004.log')
    const displaced = join(levelDb, '000004.displaced.log')
    const original = readFileSync(logPath)
    let attacked = false

    expect(() => detectPreexistingFirebaseProfile(root, {
      afterFirstFileRead: target => {
        if (!attacked && target === logPath) {
          attacked = true
          renameSync(logPath, displaced)
          writeFileSync(logPath, original)
        }
      },
    })).toThrow(/changed while reading|identity changed|directory identity/i)
    expect(attacked).toBe(true)
    expect(readFileSync(displaced)).toEqual(original)
    expect(readFileSync(logPath)).toEqual(original)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects a live WAL above the per-file read budget without reading or publishing it', () => {
    const root = makeRoot('oversized-live-log')
    const levelDb = writeV038AuthLevelDb(root)
    const logPath = join(levelDb, '000004.log')
    truncateSync(logPath, 64 * 1024 * 1024 + 1)

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/size|budget/i)
    expect(lstatSync(logPath).size).toBe(64 * 1024 * 1024 + 1)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects an overpopulated LevelDB directory before scanning attacker-controlled files', () => {
    const root = makeRoot('too-many-leveldb-entries')
    const levelDb = writeV038AuthLevelDb(root)
    for (let index = 0; index < 509; index += 1) {
      writeFileSync(join(levelDb, `attacker-${String(index).padStart(4, '0')}`), '')
    }

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/too many entries/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects a manifest with more live files than the bounded scanner permits', () => {
    const root = makeRoot('too-many-live-files')
    const levelDb = writeV038AuthLevelDb(root)
    writeFileSync(
      join(levelDb, 'MANIFEST-000001'),
      makeLevelDbManifest({ tableNumbers: Array.from({ length: 129 }, (_, index) => index + 1) }),
    )

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/too many live files/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects a linked Chromium IndexedDB directory before publishing a registry', () => {
    const root = makeRoot('indexeddb-link')
    const outside = makeRoot('indexeddb-link-outside')
    writeV038AuthLevelDb(outside)
    try {
      symlinkSync(join(outside, 'IndexedDB'), join(root, 'IndexedDB'), 'junction')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/link|reparse|identity|path/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('selects an evidenced FNV namespace only when the public namespace is absent', () => {
    const root = makeRoot('fnv-browser-evidence')
    writeSettingsEvidence(root, customConfig)
    const fnvAppName = getUnreleasedFNVFirebaseAppName(customConfig)
    writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(customConfig.apiKey, fnvAppName))

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(registry.claim(customConfig)).toEqual({
      version: 2,
      ownership: 'main-registry-fnv-evidence',
      configIdentity: canonicalFirebaseConfig(customConfig),
      appName: fnvAppName,
    })
  })

  it('prefers the public v0.3.8 namespace when both public and FNV keys are evidenced', () => {
    const root = makeRoot('public-and-fnv-evidence')
    writeSettingsEvidence(root, customConfig)
    const log = Buffer.concat([
      makeChromiumIndexedDbAuthLog(
        customConfig.apiKey,
        getUnreleasedFNVFirebaseAppName(customConfig),
        { sequenceLow: 1 },
      ),
      makeChromiumIndexedDbAuthLog(
        customConfig.apiKey,
        LEGACY_FIREBASE_APP_NAME,
        { sequenceLow: 2 },
      ),
    ])
    writeV038AuthLevelDb(root, log)

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(registry.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('treats an SST value as absent when a newer live WAL tombstone deletes it', () => {
    const root = makeRoot('sst-value-wal-delete')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 2, operation: 'delete' },
    ))
    writeFileSync(join(levelDb, '000005.ldb'), makeLevelDbAuthTable({
      apiKey: DEFAULT_FIREBASE_CONFIG.apiKey,
      appName: LEGACY_FIREBASE_APP_NAME,
      sequenceLow: 1,
      operation: 'put',
    }))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName)
      .toBe(getDigestFirebasePersistenceIdentity(DEFAULT_FIREBASE_CONFIG).appName)
  })

  it('treats a WAL value as absent when a newer live SST tombstone deletes it', () => {
    const root = makeRoot('wal-value-sst-delete')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 1, operation: 'put' },
    ))
    writeFileSync(join(levelDb, '000005.ldb'), makeLevelDbAuthTable({
      apiKey: DEFAULT_FIREBASE_CONFIG.apiKey,
      appName: LEGACY_FIREBASE_APP_NAME,
      sequenceLow: 2,
      operation: 'delete',
    }))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName)
      .toBe(getDigestFirebasePersistenceIdentity(DEFAULT_FIREBASE_CONFIG).appName)
  })

  it('restores active evidence when a newer put recreates a deleted Auth key', () => {
    const root = makeRoot('delete-then-recreate')
    writeV038AuthLevelDb(root, Buffer.concat([
      makeChromiumIndexedDbAuthLog(
        DEFAULT_FIREBASE_CONFIG.apiKey,
        LEGACY_FIREBASE_APP_NAME,
        { sequenceLow: 1, operation: 'delete' },
      ),
      makeChromiumIndexedDbAuthLog(
        DEFAULT_FIREBASE_CONFIG.apiKey,
        LEGACY_FIREBASE_APP_NAME,
        { sequenceLow: 2, operation: 'put' },
      ),
    ]))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('fails closed when live SST and WAL disagree at the same LevelDB sequence', () => {
    const root = makeRoot('same-sequence-conflict')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 2, operation: 'delete' },
    ))
    writeFileSync(join(levelDb, '000005.ldb'), makeLevelDbAuthTable({
      apiKey: DEFAULT_FIREBASE_CONFIG.apiKey,
      appName: LEGACY_FIREBASE_APP_NAME,
      sequenceLow: 2,
      operation: 'put',
    }))

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/sequence|conflict|ambiguous/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('selects active FNV evidence when the public key has a newer tombstone', () => {
    const root = makeRoot('deleted-public-active-fnv')
    writeSettingsEvidence(root, customConfig)
    const fnvAppName = getUnreleasedFNVFirebaseAppName(customConfig)
    writeV038AuthLevelDb(root, Buffer.concat([
      makeChromiumIndexedDbAuthLog(customConfig.apiKey, LEGACY_FIREBASE_APP_NAME, {
        sequenceLow: 1,
      }),
      makeChromiumIndexedDbAuthLog(customConfig.apiKey, fnvAppName, {
        sequenceLow: 2,
      }),
      makeChromiumIndexedDbAuthLog(customConfig.apiKey, LEGACY_FIREBASE_APP_NAME, {
        sequenceLow: 3,
        operation: 'delete',
      }),
    ]))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(customConfig)).toMatchObject({ version: 2, appName: fnvAppName })
  })

  it('keeps public evidence when a newer tombstone removes only the FNV key', () => {
    const root = makeRoot('active-public-deleted-fnv')
    writeSettingsEvidence(root, customConfig)
    const fnvAppName = getUnreleasedFNVFirebaseAppName(customConfig)
    writeV038AuthLevelDb(root, Buffer.concat([
      makeChromiumIndexedDbAuthLog(customConfig.apiKey, LEGACY_FIREBASE_APP_NAME, {
        sequenceLow: 1,
      }),
      makeChromiumIndexedDbAuthLog(customConfig.apiKey, fnvAppName, {
        sequenceLow: 2,
      }),
      makeChromiumIndexedDbAuthLog(customConfig.apiKey, fnvAppName, {
        sequenceLow: 3,
        operation: 'delete',
      }),
    ]))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('rejects a WAL base sequence outside LevelDB\'s 56-bit sequence domain', () => {
    const root = makeRoot('wal-sequence-overflow')
    writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceHigh: 0x01000000 },
    ))

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/sequence/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('accepts only the explicit FNV registry claim variant and exact derived app name', () => {
    const appName = getUnreleasedFNVFirebaseAppName(customConfig)
    expect(parseFirebasePersistenceClaim({
      version: 2,
      ownership: 'main-registry-fnv-evidence',
      configIdentity: canonicalFirebaseConfig(customConfig),
      appName,
    }, customConfig)).toEqual({
      version: 2,
      ownership: 'main-registry-fnv-evidence',
      configIdentity: canonicalFirebaseConfig(customConfig),
      appName,
    })
    expect(() => parseFirebasePersistenceClaim({
      version: 1,
      configIdentity: canonicalFirebaseConfig(customConfig),
      appName,
    }, customConfig)).toThrow(/claim|invalid/i)
    expect(() => parseFirebasePersistenceClaim({
      version: 2,
      ownership: 'main-registry-fnv-evidence',
      configIdentity: canonicalFirebaseConfig(customConfig),
      appName: 'baby-diary-0000000000000000',
    }, customConfig)).toThrow(/claim|invalid/i)
  })

  it('snapshots corrupt settings without publishing until validated recovery completes', () => {
    const root = makeRoot('corrupt-recovery-gate')
    writeFileSync(join(root, 'settings.json'), '{broken-settings')

    const snapshot = detectPreexistingFirebaseProfile(root)

    expect(snapshot.kind).toBe('settings-invalid')
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    expect(() => FirebasePersistenceRegistry.open(root, snapshot)).toThrow(/recovery/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('keeps the registry absent through every Windows restart-required recovery phase', () => {
    const root = makeRoot('windows-recovery-publication-gate')
    writeVerifiedRecoveryBackup(root)
    writeFileSync(join(root, 'settings.json'), '{ broken settings')
    writeFileSync(join(root, BABY_INFO_JOURNAL_FILE), '{"version":1,"type":"mutation"')
    const snapshot = detectPreexistingFirebaseProfile(root, { platform: 'win32' })
    expect(snapshot.kind).toBe('settings-invalid')

    const startLikeMain = (startupId: string): FirebasePersistenceRegistry => {
      const settingsStore = new SettingsStore(root, { platform: 'win32', startupId })
      return FirebasePersistenceRegistry.openAfterSettingsRecovery(
        root,
        snapshot,
        settingsStore.get(),
        { platform: 'win32' },
      )
    }

    for (const startupId of ['registry-boot-0', 'registry-boot-1', 'registry-boot-2']) {
      expect(() => startLikeMain(startupId)).toThrow(expect.objectContaining({
        restartRequired: true,
      }))
      expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    }

    const registry = startLikeMain('registry-boot-3')
    expect(registry.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(true)
    const document = JSON.parse(readFileSync(
      join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE),
      'utf8',
    ))
    expect(document.eligibilityEvidence.kind).toBe('settings-recovered')
  })

  it('claims the exact shared default when released settings stored firebase:null', () => {
    const root = makeRoot('legacy-default')
    writeSettingsEvidence(root, null)
    const snapshot = detectPreexistingFirebaseProfile(root)

    const registry = FirebasePersistenceRegistry.open(root, snapshot)

    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
    expect(registry.claim(customConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(customConfig).appName,
    )
  })

  it('inherits a v0.3.8 custom config despite partial and unknown unrelated settings fields', () => {
    const root = makeRoot('legacy-partial-unknown')
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      firebase: customConfig,
      baby: { unknownHistoricalShape: ['preserve', 0, false, null] },
      profile: 42,
      upgradeOpaque: { deep: { ko: '보존', ja: '保持' } },
    }))

    const snapshot = detectPreexistingFirebaseProfile(root)
    const registry = FirebasePersistenceRegistry.open(root, snapshot)

    expect(registry.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('fails closed when the settings firebase field itself is malformed', () => {
    const root = makeRoot('legacy-malformed-firebase')
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      firebase: { ...customConfig, extra: 'not released' },
      upgradeOpaque: { keep: true },
    }))

    const snapshot = detectPreexistingFirebaseProfile(root)
    expect(snapshot.kind).toBe('settings-invalid')
    expect(() => FirebasePersistenceRegistry.open(root, snapshot)).toThrow(/recovery/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('canonicalizes IPC config in main and rejects renderer-supplied extra fields', () => {
    const root = makeRoot('invalid-ipc-config')
    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(() => registry.claim({
      ...customConfig,
      rendererFingerprint: canonicalFirebaseConfig(customConfig),
    })).toThrow(/configuration shape is invalid/i)
  })

  it('immutably binds the canonical custom config A to v0.3.8 and keeps A -> B -> A stable across restart', () => {
    const root = makeRoot('legacy-custom')
    writeSettingsEvidence(root, customConfig)
    const evidence = detectPreexistingFirebaseProfile(root)
    expect(evidence).toMatchObject({ existed: true, kind: 'settings-snapshot' })

    const first = FirebasePersistenceRegistry.open(root, evidence)
    const rawBefore = readFileSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))

    expect(first.claim(customConfig)).toMatchObject({
      appName: LEGACY_FIREBASE_APP_NAME,
      configIdentity: canonicalFirebaseConfig(customConfig),
    })
    expect(first.claim(otherConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(otherConfig).appName,
    )

    const restarted = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(restarted.claim(otherConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(otherConfig).appName,
    )
    expect(restarted.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
    expect(readFileSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toEqual(rawBefore)

    const diagnostic = restarted.diagnostic()
    expect(diagnostic).toMatchObject({
      classification: 'legacy-v0.3.8-upgrade',
      legacyAppName: LEGACY_FIREBASE_APP_NAME,
      preservedDigestAppName: getDigestFirebasePersistenceIdentity(customConfig).appName,
    })
  })

  it('persists a fresh classification so a later settings file can never steal the legacy namespace', () => {
    const root = makeRoot('fresh')
    const evidence = detectPreexistingFirebaseProfile(root)
    expect(evidence).toMatchObject({ existed: false, kind: 'settings-absent' })

    const first = FirebasePersistenceRegistry.open(root, evidence)
    expect(first.claim(customConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(customConfig).appName,
    )

    writeSettingsEvidence(root, customConfig)
    const restarted = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(restarted.claim(customConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(customConfig).appName,
    )
    expect(restarted.diagnostic().classification).toBe('fresh-v0.3.9-or-newer')
  })

  it('re-reads the one hard-link winner when two processes publish concurrently', () => {
    const root = makeRoot('concurrent')
    writeSettingsEvidence(root, customConfig)
    const evidence = detectPreexistingFirebaseProfile(root)
    let second!: FirebasePersistenceRegistry

    const first = FirebasePersistenceRegistry.open(root, evidence, {
      beforePublish: () => {
        second = FirebasePersistenceRegistry.open(root, evidence)
      },
    })

    expect(first.claim(customConfig)).toEqual(second.claim(customConfig))
    expect(first.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('survives response loss after publish and returns the same ownership on retry', () => {
    const root = makeRoot('response-loss')
    writeSettingsEvidence(root, customConfig)
    const evidence = detectPreexistingFirebaseProfile(root)

    expect(() => FirebasePersistenceRegistry.open(root, evidence, {
      afterPublish: () => { throw new Error('simulated response loss') },
    })).toThrow('simulated response loss')

    const retried = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(retried.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
    expect(retried.claim(otherConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(otherConfig).appName,
    )
  })

  it('fails closed on corrupt or unknown registry fields without replacing existing bytes', () => {
    const root = makeRoot('corrupt')
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const corrupt = Buffer.from('{"version":1,"legacyClaim":null,"unknown":true}\n')
    writeFileSync(registryPath, corrupt)

    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )).toThrow(/registry/i)
    expect(readFileSync(registryPath)).toEqual(corrupt)
  })

  it('rejects a registry symlink/reparse point and never changes its target', () => {
    const root = makeRoot('symlink')
    const outside = makeRoot('outside')
    const target = join(outside, 'target.json')
    const targetBytes = Buffer.from('{"outside":true}\n')
    writeFileSync(target, targetBytes)
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    try {
      symlinkSync(target, registryPath, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }

    expect(lstatSync(registryPath).isSymbolicLink()).toBe(true)
    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )).toThrow(/link|reparse|regular/i)
    expect(readFileSync(target)).toEqual(targetBytes)
  })

  it('does not remove an unverified foreign crash candidate', () => {
    const root = makeRoot('foreign-temp')
    const foreign = join(root, `${FIREBASE_PERSISTENCE_REGISTRY_FILE}.candidate-foreign`)
    writeFileSync(foreign, 'forensic evidence')

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(registry.claim(customConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(customConfig).appName,
    )
    expect(existsSync(foreign)).toBe(true)
    expect(readFileSync(foreign, 'utf8')).toBe('forensic evidence')
  })

  it('never modifies Chromium Auth, Local Storage, or IndexedDB bytes', () => {
    const root = makeRoot('chromium-untouched')
    writeSettingsEvidence(root, customConfig)
    const sentinels = [
      join(root, 'IndexedDB', 'firebase.leveldb'),
      join(root, 'Local Storage', 'leveldb', 'auth.log'),
      join(root, 'Session Storage', 'session.log'),
    ]
    sentinels.forEach((file, index) => {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, Buffer.from(`sentinel-${index}-firebase-bytes`))
    })
    const before = sentinels.map(file => readFileSync(file))

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(registry.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)

    sentinels.forEach((file, index) => expect(readFileSync(file)).toEqual(before[index]))
  })

  it('can retry the same snapshot after a pre-publish interruption without a digest fallback', () => {
    const root = makeRoot('publish-interrupted')
    writeSettingsEvidence(root, customConfig)
    const snapshot = detectPreexistingFirebaseProfile(root)

    expect(() => FirebasePersistenceRegistry.open(root, snapshot, {
      beforePublish: () => { throw new Error('power loss before link') },
    })).toThrow('power loss before link')
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)

    const retried = FirebasePersistenceRegistry.open(root, snapshot)
    expect(retried.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('fails before publication if the parent directory identity changes', () => {
    const container = makeRoot('root-swap')
    const root = join(container, 'profile')
    const displaced = join(container, 'profile-original')
    mkdirSync(root)
    writeSettingsEvidence(root, customConfig)
    const evidence = detectPreexistingFirebaseProfile(root)

    expect(() => FirebasePersistenceRegistry.open(root, evidence, {
      beforePublish: () => {
        // Keep the original bytes for forensics and substitute an empty directory.
        renameSync(root, displaced)
        mkdirSync(root)
      },
    })).toThrow(/directory|identity|path/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    expect(existsSync(join(displaced, 'settings.json'))).toBe(true)
  })

  it('rejects a valid settings replacement after snapshot and publishes no final claim', () => {
    const root = makeRoot('settings-swap')
    writeSettingsEvidence(root, customConfig)
    const snapshot = detectPreexistingFirebaseProfile(root)
    const original = join(root, 'settings.original.json')

    expect(() => FirebasePersistenceRegistry.open(root, snapshot, {
      beforePublish: () => {
        renameSync(join(root, 'settings.json'), original)
        writeSettingsEvidence(root, otherConfig)
      },
    })).toThrow(/settings.*changed|identity/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    expect(existsSync(original)).toBe(true)
  })

  it('rejects corrupt settings evidence before publishing any registry', () => {
    const root = makeRoot('settings-corrupt')
    writeFileSync(join(root, 'settings.json'), '{not-json')

    const snapshot = detectPreexistingFirebaseProfile(root)
    expect(snapshot.kind).toBe('settings-invalid')
    expect(() => FirebasePersistenceRegistry.open(root, snapshot)).toThrow(/recovery/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{not-json')
  })

  it('detects a same-inode same-size registry rewrite between stable reads', () => {
    const root = makeRoot('same-inode-rewrite')
    const initial = detectPreexistingFirebaseProfile(root)
    FirebasePersistenceRegistry.open(root, initial)
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const original = readFileSync(registryPath)
    const changed = Buffer.from(original)
    const whitespace = changed.indexOf(0x0a)
    expect(whitespace).toBeGreaterThan(0)
    changed[whitespace] = 0x20

    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
      { afterFirstFileRead: () => writeFileSync(registryPath, changed) },
    )).toThrow(/changed while reading|identity changed/i)
    expect(readFileSync(registryPath)).toEqual(changed)
  })

  it('detects an atomic final-path swap even when replacement bytes are identical', () => {
    const root = makeRoot('atomic-final-swap')
    FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const displaced = join(root, 'registry.displaced.json')
    const original = readFileSync(registryPath)

    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
      {
        afterFirstFileRead: () => {
          renameSync(registryPath, displaced)
          writeFileSync(registryPath, original)
        },
      },
    )).toThrow(/changed while reading|identity changed/i)
    expect(readFileSync(displaced)).toEqual(original)
    expect(readFileSync(registryPath)).toEqual(original)
  })

  it('rejects an oversized final registry without truncating or replacing it', () => {
    const root = makeRoot('oversized')
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const oversized = Buffer.alloc(64 * 1024 + 1, 0x78)
    writeFileSync(registryPath, oversized)

    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )).toThrow(/size/i)
    expect(readFileSync(registryPath)).toEqual(oversized)
  })

  it('safely creates a completely absent nested userData root and classifies it fresh', () => {
    const container = makeRoot('absent-root')
    const root = join(container, 'nested', 'profile')

    const snapshot = detectPreexistingFirebaseProfile(root)

    expect(snapshot).toMatchObject({ existed: false, kind: 'settings-absent' })
    expect(lstatSync(root).isDirectory()).toBe(true)
    expect(FirebasePersistenceRegistry.open(root, snapshot).diagnostic().classification)
      .toBe('fresh-v0.3.9-or-newer')
  })

  it('accepts a concurrent regular-directory mkdir winner', () => {
    const container = makeRoot('mkdir-race')
    const root = join(container, 'profile')

    const snapshot = detectPreexistingFirebaseProfile(root, {
      beforeRootCreate: () => mkdirSync(root, { recursive: true }),
    })

    expect(snapshot.kind).toBe('settings-absent')
    expect(lstatSync(root).isDirectory()).toBe(true)
  })

  it('rejects an attacker symlink winner during root creation', () => {
    const container = makeRoot('mkdir-symlink-race')
    const outside = makeRoot('mkdir-symlink-outside')
    const root = join(container, 'profile')
    let linked = false

    try {
      expect(() => detectPreexistingFirebaseProfile(root, {
        beforeRootCreate: () => {
          symlinkSync(outside, root, 'junction')
          linked = true
        },
      })).toThrow(/link|reparse/i)
    } catch (error) {
      if (!linked && (error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })
})
