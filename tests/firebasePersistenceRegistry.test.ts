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
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIREBASE_PERSISTENCE_REGISTRY_FILE,
  FIREBASE_PROFILE_BOOTSTRAP_FILE,
  FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE,
  FIREBASE_PROFILE_BOOTSTRAP_REVOCATION_FILE,
  FirebasePersistenceRegistry,
  captureFirebaseProfileInitialState,
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
  return makeChromiumIndexedDbAuthBatchLog([{
    apiKey,
    appName,
    operation: options.operation,
  }], options)
}

function makeChromiumIndexedDbAuthBatchLog(
  records: Array<{
    apiKey: string
    appName: string
    operation?: 'put' | 'delete'
  }>,
  options: {
    sequenceLow?: number
    sequenceHigh?: number
  } = {},
): Buffer {
  const encodedRecords = records.flatMap(record => {
    const indexedDbKey = makeChromiumIndexedDbAuthKey(record.apiKey, record.appName)
    const operation = record.operation ?? 'put'
    return [
      Buffer.from([operation === 'put' ? 0x01 : 0x00]),
      encodeVarint(indexedDbKey.length),
      indexedDbKey,
      ...(operation === 'put' ? [Buffer.from([0x01, 0x00])] : []),
    ]
  })
  const batch = Buffer.concat([
    Buffer.alloc(8),
    Buffer.alloc(4),
    ...encodedRecords,
  ])
  batch.writeUInt32LE(options.sequenceLow ?? 0, 0)
  batch.writeUInt32LE(options.sequenceHigh ?? 0, 4)
  batch.writeUInt32LE(records.length, 8)
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
    ['gap', 1, 3],
    ['overlap', 5, 5],
  ])('accepts a valid %s between live WAL sequence ranges', (_label, firstSequence, nextSequence) => {
    const root = makeRoot(`higher-live-wal-${_label}`)
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      'unrelated',
      'unrelated',
      { sequenceLow: firstSequence },
    ))
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: nextSequence },
    ))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('replays a later WAL with a lower valid sequence while keeping the highest Auth version', () => {
    const root = makeRoot('higher-live-wal-backward-sequence')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 9 },
    ))
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 7, operation: 'delete' },
    ))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('increments the sequence for each record inside one WAL WriteBatch', () => {
    const root = makeRoot('wal-write-batch-sequence-increment')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 0, operation: 'delete' },
    ))
    writeFileSync(join(levelDb, '000006.log'), makeChromiumIndexedDbAuthBatchLog([
      { apiKey: 'unrelated', appName: 'unrelated' },
      { apiKey: DEFAULT_FIREBASE_CONFIG.apiKey, appName: LEGACY_FIREBASE_APP_NAME },
    ], { sequenceLow: 0 }))

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('rejects a WAL WriteBatch whose final increment exceeds the 56-bit sequence domain', () => {
    const root = makeRoot('wal-write-batch-sequence-end-overflow')
    writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthBatchLog([
      { apiKey: 'unrelated-a', appName: 'unrelated-a' },
      { apiKey: 'unrelated-b', appName: 'unrelated-b' },
    ], { sequenceLow: 0xffffffff, sequenceHigh: 0x00ffffff }))

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/sequence|56-bit|domain/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('keeps a prior valid live WAL record when the final record is truncated mid-write', () => {
    const root = makeRoot('wal-truncated-final-record')
    const completeRecord = makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
      { sequenceLow: 1 },
    )
    const crashedRecord = makeChromiumIndexedDbAuthLog('unrelated', 'unrelated', { sequenceLow: 2 })
    const fullLog = Buffer.concat([completeRecord, crashedRecord])
    // Simulate an ordinary unclean shutdown: the second WriteBatch's physical
    // record header was flushed, but its payload was cut short before the
    // process crashed. This is the routine condition real LevelDB treats as
    // a benign incomplete final record, not corruption.
    const truncatedLog = fullLog.subarray(0, fullLog.length - 4)
    expect(truncatedLog.length).toBeGreaterThan(completeRecord.length + 7)
    writeV038AuthLevelDb(root, truncatedLog)

    const registry = FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
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

  it('does not publish a firebase-valid settings file that fails SettingsStore strict validation', () => {
    const root = makeRoot('strict-settings-before-registry')
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      firebase: otherConfig,
      profile: 42,
    }))
    const initialState = captureFirebaseProfileInitialState(root)

    expect(() => new SettingsStore(root)).toThrow(/strict validation|settings/i)
    expect(initialState.settingsExisted).toBe(true)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('publishes a valid legacy claim only after SettingsStore completes strict validation', () => {
    const root = makeRoot('strict-settings-validated-registry')
    writeSettingsEvidence(root, customConfig)
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })

    const registry = FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
    )

    expect(registry.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('rejects a same-config settings replacement after post-validation detection', () => {
    const root = makeRoot('strict-settings-replaced-after-detection')
    writeSettingsEvidence(root, customConfig)
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      ...settingsStore.get(),
      language: 'ja',
    }))

    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
    )).toThrow(/settings.*changed|identity|evidence/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects a non-JSON opaque value supplied after SettingsStore validation', () => {
    const root = makeRoot('strict-settings-forbidden-opaque')
    writeSettingsEvidence(root, customConfig)
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })

    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      {
        ...settingsStore.get(),
        upgradeOpaque: { forbidden: () => 'not-json' },
      },
    )).toThrow(/strict application validation/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects a same-config settings replacement between SettingsStore and detection', () => {
    const root = makeRoot('strict-settings-replaced-before-detection')
    writeSettingsEvidence(root, customConfig)
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const validatedSettings = settingsStore.get()
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      ...validatedSettings,
      language: 'ja',
    }))
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })

    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      validatedSettings,
    )).toThrow(/settings.*SettingsStore|validated settings.*match|settings.*changed/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('keeps an initially settings-absent profile fresh after SettingsStore creates journal state', () => {
    const root = makeRoot('fresh-after-settings-validation')
    const initialState = captureFirebaseProfileInitialState(root)
    expect(initialState.settingsExisted).toBe(false)
    const settingsStore = new SettingsStore(root)
    expect(existsSync(join(root, BABY_INFO_JOURNAL_FILE))).toBe(true)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })

    const registry = FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
    )

    expect(registry.diagnostic().classification).toBe('fresh-v0.3.9-or-newer')
    expect(registry.claim(customConfig).appName)
      .toBe(getDigestFirebasePersistenceIdentity(customConfig).appName)
  })

  it('keeps a fresh profile fresh after a crash before first registry publication', () => {
    const root = makeRoot('fresh-bootstrap-crash-before-registry')
    const firstInitialState = captureFirebaseProfileInitialState(root)
    expect(firstInitialState.settingsExisted).toBe(false)
    expect(firstInitialState.freshBootstrap).toBe(true)
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE))).toBe(true)
    new SettingsStore(root)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)

    const secondInitialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState: secondInitialState })
    const registry = FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
    )

    expect(registry.diagnostic().classification).toBe('fresh-v0.3.9-or-newer')
    expect(registry.claim(customConfig).appName)
      .toBe(getDigestFirebasePersistenceIdentity(customConfig).appName)
  })

  it('fails closed when durable fresh bootstrap evidence is corrupted after a crash', () => {
    const root = makeRoot('fresh-bootstrap-corrupt-after-crash')
    captureFirebaseProfileInitialState(root)
    new SettingsStore(root)
    writeFileSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE), '{"version":2}')

    expect(() => captureFirebaseProfileInitialState(root)).toThrow(/bootstrap|evidence|invalid/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('rejects a copied bootstrap marker whose provenance belongs to another profile root', () => {
    const source = makeRoot('fresh-bootstrap-copy-source')
    const target = makeRoot('fresh-bootstrap-copy-target')
    captureFirebaseProfileInitialState(source)
    writeSettingsEvidence(target, customConfig)
    writeFileSync(
      join(target, FIREBASE_PROFILE_BOOTSTRAP_FILE),
      readFileSync(join(source, FIREBASE_PROFILE_BOOTSTRAP_FILE)),
    )

    expect(() => captureFirebaseProfileInitialState(target)).toThrow(/bootstrap|root|evidence|invalid/i)
    expect(existsSync(join(target, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('revalidates durable fresh bootstrap evidence immediately before publication', () => {
    const root = makeRoot('fresh-bootstrap-removed-before-publish')
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })

    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
      {
        beforePublish: () => unlinkSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE)),
      },
    )).toThrow(/bootstrap|evidence|ENOENT/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('never creates fresh bootstrap evidence over an active recovery protocol', () => {
    const root = makeRoot('fresh-bootstrap-blocked-by-recovery')
    writeFileSync(join(root, '.baby-info-pair-restore-v1.json'), '{}')

    const initialState = captureFirebaseProfileInitialState(root)

    expect(initialState).toMatchObject({ settingsExisted: true, freshBootstrap: false })
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE))).toBe(false)
  })

  it.each([
    ['restore intent', '.BaBy-InFo-PaIr-ReStOrE-V1.JsOn', 'file'],
    ['restore staging', '.BaBy-InFo-PaIr-ReStOrE-V1', 'directory'],
    ['restore tombstone', `.BaBy-InFo-PaIr-ReStOrE-V1.JsOn.ClEaNuP-${'a'.repeat(32)}`, 'file'],
    ['settings temp', `SeTtInGs.JsOn.TmP-${'a'.repeat(32)}`, 'file'],
    ['journal temp', `BaBy-InFo-JoUrNaL-V1.JsOnL.TmP-${'a'.repeat(32)}`, 'file'],
    ['journal', 'BaBy-InFo-JoUrNaL-V1.JsOnL', 'file'],
  ])('uses Windows case-insensitive semantics for mixed-case %s evidence', (_label, name, kind) => {
    const root = makeRoot(`windows-mixed-case-${_label.replace(' ', '-')}`)
    if (kind === 'directory') mkdirSync(join(root, name))
    else writeFileSync(join(root, name), '{}')

    const initialState = captureFirebaseProfileInitialState(root, { platform: 'win32' })

    expect(initialState).toMatchObject({ settingsExisted: true, freshBootstrap: false })
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE))).toBe(false)
  })

  it.each([
    ['restore intent', '.BaBy-InFo-PaIr-ReStOrE-V1.JsOn', 'file'],
    ['restore staging', '.BaBy-InFo-PaIr-ReStOrE-V1', 'directory'],
    ['restore tombstone', `.BaBy-InFo-PaIr-ReStOrE-V1.JsOn.ClEaNuP-${'a'.repeat(32)}`, 'file'],
    ['settings temp', `SeTtInGs.JsOn.TmP-${'a'.repeat(32)}`, 'file'],
    ['journal temp', `BaBy-InFo-JoUrNaL-V1.JsOnL.TmP-${'a'.repeat(32)}`, 'file'],
    ['journal', 'BaBy-InFo-JoUrNaL-V1.JsOnL', 'file'],
  ])('uses conservative macOS case-insensitive semantics for mixed-case %s evidence', (_label, name, kind) => {
    const root = makeRoot(`darwin-mixed-case-${_label.replace(' ', '-')}`)
    if (kind === 'directory') mkdirSync(join(root, name))
    else writeFileSync(join(root, name), '{}')

    const initialState = captureFirebaseProfileInitialState(root, { platform: 'darwin' })

    expect(initialState).toMatchObject({ settingsExisted: true, freshBootstrap: false })
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE))).toBe(false)
  })

  it('invalidates pending fresh bootstrap evidence when recovery starts later', () => {
    const root = makeRoot('fresh-bootstrap-invalidated-by-later-recovery')
    captureFirebaseProfileInitialState(root)
    writeFileSync(join(root, '.baby-info-pair-restore-v1.json'), '{}')

    const initialState = captureFirebaseProfileInitialState(root)

    expect(initialState).toMatchObject({ settingsExisted: true, freshBootstrap: false })
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('invalidates pending fresh bootstrap evidence when a configured backup root appears later', () => {
    const root = makeRoot('fresh-bootstrap-invalidated-by-later-backup-root')
    const recoveryEvidencePath = join(root, 'external-backups')
    const options = { recoveryEvidencePaths: [recoveryEvidencePath] }
    const firstInitialState = captureFirebaseProfileInitialState(root, options)
    expect(firstInitialState).toMatchObject({ settingsExisted: false, freshBootstrap: true })
    mkdirSync(recoveryEvidencePath)

    const secondInitialState = captureFirebaseProfileInitialState(root, options)

    expect(secondInitialState).toMatchObject({ settingsExisted: true, freshBootstrap: false })
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('revokes an existing bootstrap marker when recovery appears during its stable read', () => {
    const root = makeRoot('fresh-bootstrap-recovery-during-existing-read')
    const recoveryEvidencePath = join(root, 'external-backups')
    const recoveryEvidencePaths = [recoveryEvidencePath]
    captureFirebaseProfileInitialState(root, { recoveryEvidencePaths })
    new SettingsStore(root)
    let injected = false

    const initialState = captureFirebaseProfileInitialState(root, {
      recoveryEvidencePaths,
      afterFirstFileRead: target => {
        if (!injected && target === join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE)) {
          injected = true
          mkdirSync(recoveryEvidencePath)
        }
      },
    })

    expect(injected).toBe(true)
    expect(initialState).toMatchObject({ settingsExisted: true, freshBootstrap: false })
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE))).toBe(true)
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_REVOCATION_FILE))).toBe(true)

    rmSync(recoveryEvidencePath, { recursive: true, force: true })
    expect(captureFirebaseProfileInitialState(root, { recoveryEvidencePaths }))
      .toMatchObject({ settingsExisted: true, freshBootstrap: false })
  })

  it('revokes a newly linked bootstrap marker when recovery appears during its final read', () => {
    const root = makeRoot('fresh-bootstrap-recovery-during-publish-read')
    const recoveryEvidencePath = join(root, 'external-backups')
    const recoveryEvidencePaths = [recoveryEvidencePath]
    let injected = false

    const initialState = captureFirebaseProfileInitialState(root, {
      recoveryEvidencePaths,
      afterFirstFileRead: target => {
        if (!injected && target === join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE)) {
          injected = true
          mkdirSync(recoveryEvidencePath)
        }
      },
    })

    expect(injected).toBe(true)
    expect(initialState).toMatchObject({ settingsExisted: true, freshBootstrap: false })
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE))).toBe(true)
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_REVOCATION_FILE))).toBe(true)
  })

  it('never deletes a foreign replacement swapped onto the predictable bootstrap marker path', () => {
    const root = makeRoot('fresh-bootstrap-foreign-marker-swap')
    captureFirebaseProfileInitialState(root)
    new SettingsStore(root)
    const markerPath = join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE)
    const ownedArchive = join(root, 'owned-bootstrap-marker.archive')
    const foreignBytes = Buffer.from('{"foreign":true}\n')
    let injected = false

    expect(() => captureFirebaseProfileInitialState(root, {
      afterFirstFileRead: target => {
        if (!injected && target === markerPath) {
          injected = true
          renameSync(markerPath, ownedArchive)
          writeFileSync(markerPath, foreignBytes)
        }
      },
    })).toThrow(/bootstrap|identity|changed|evidence/i)

    expect(injected).toBe(true)
    expect(readFileSync(markerPath)).toEqual(foreignBytes)
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_REVOCATION_FILE))).toBe(false)
  })

  it('binds a legacy browser decision durably so registry loss and logout cannot reactivate fresh bootstrap', () => {
    const root = makeRoot('legacy-browser-bootstrap-resolution-survives-logout')
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
    ))
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })
    const firstRegistry = FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
    )
    expect(firstRegistry.diagnostic().classification).toBe('legacy-v0.3.8-upgrade')
    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE))).toBe(true)

    unlinkSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))
    rmSync(levelDb, { recursive: true, force: true })
    const restartedInitialState = captureFirebaseProfileInitialState(root)
    const restartedSettingsStore = new SettingsStore(root)
    const restartedSnapshot = detectPreexistingFirebaseProfile(root, {
      initialState: restartedInitialState,
    })
    const restartedRegistry = FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      restartedSnapshot,
      restartedSettingsStore.get(),
    )

    expect(restartedInitialState).toMatchObject({ settingsExisted: true, freshBootstrap: false })
    expect(restartedRegistry.diagnostic().classification).toBe('legacy-v0.3.8-upgrade')
    expect(restartedRegistry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('rejects a copied legacy resolution whose provenance belongs to another profile root', () => {
    const source = makeRoot('bootstrap-resolution-copy-source')
    writeV038AuthLevelDb(source, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
    ))
    const sourceInitialState = captureFirebaseProfileInitialState(source)
    const sourceSettings = new SettingsStore(source)
    FirebasePersistenceRegistry.openAfterSettingsValidation(
      source,
      detectPreexistingFirebaseProfile(source, { initialState: sourceInitialState }),
      sourceSettings.get(),
    )

    const target = makeRoot('bootstrap-resolution-copy-target')
    writeSettingsEvidence(target, DEFAULT_FIREBASE_CONFIG)
    writeFileSync(
      join(target, FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE),
      readFileSync(join(source, FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE)),
    )

    expect(() => captureFirebaseProfileInitialState(target)).toThrow(/bootstrap|root|resolution|invalid/i)
    expect(existsSync(join(target, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('pins bootstrap resolution identity from capture through registry reconstruction', () => {
    const root = makeRoot('bootstrap-resolution-identity-pinned')
    writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
    ))
    const firstInitialState = captureFirebaseProfileInitialState(root)
    const firstSettings = new SettingsStore(root)
    FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      detectPreexistingFirebaseProfile(root, { initialState: firstInitialState }),
      firstSettings.get(),
    )
    unlinkSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))
    const restartedInitialState = captureFirebaseProfileInitialState(root)
    const resolutionPath = join(root, FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE)
    const sameBytes = readFileSync(resolutionPath)
    renameSync(resolutionPath, join(root, 'bootstrap-resolution.archive'))
    writeFileSync(resolutionPath, sameBytes)

    expect(() => detectPreexistingFirebaseProfile(root, {
      initialState: restartedInitialState,
    })).toThrow(/bootstrap|decision|changed|identity/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('backfills a final resolution for a pre-witness registry that still has its root-bound marker', () => {
    const root = makeRoot('bootstrap-resolution-existing-registry-backfill')
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      detectPreexistingFirebaseProfile(root, { initialState }),
      settingsStore.get(),
    )
    unlinkSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE))
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(true)

    const restartedInitialState = captureFirebaseProfileInitialState(root)
    const restartedSnapshot = detectPreexistingFirebaseProfile(root, {
      initialState: restartedInitialState,
    })
    FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      restartedSnapshot,
      new SettingsStore(root).get(),
    )

    expect(existsSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE))).toBe(true)
  })

  it('rejects a fresh registry combined with durable bootstrap revocation evidence', () => {
    const root = makeRoot('fresh-registry-revocation-conflict')
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      detectPreexistingFirebaseProfile(root, { initialState }),
      settingsStore.get(),
    )
    const registryBytes = readFileSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))
    unlinkSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))
    unlinkSync(join(root, FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE))
    const recoveryEvidencePath = join(root, 'late-recovery')
    let injected = false
    captureFirebaseProfileInitialState(root, {
      recoveryEvidencePaths: [recoveryEvidencePath],
      afterFirstFileRead: target => {
        if (!injected && target === join(root, FIREBASE_PROFILE_BOOTSTRAP_FILE)) {
          injected = true
          mkdirSync(recoveryEvidencePath)
        }
      },
    })
    writeFileSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE), registryBytes)

    const conflictedInitialState = captureFirebaseProfileInitialState(root, {
      recoveryEvidencePaths: [recoveryEvidencePath],
    })
    const conflictedSnapshot = detectPreexistingFirebaseProfile(root, {
      initialState: conflictedInitialState,
    })
    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      conflictedSnapshot,
      new SettingsStore(root).get(),
    )).toThrow(/fresh registry|revoked|conflict|bootstrap/i)
  })

  it.each([
    FIREBASE_PROFILE_BOOTSTRAP_REVOCATION_FILE,
    FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE,
  ])('fails closed on corrupt durable bootstrap decision evidence %s', (fileName) => {
    const root = makeRoot(`corrupt-bootstrap-decision-${fileName}`)
    writeFileSync(join(root, fileName), '{"version":1}')

    expect(() => captureFirebaseProfileInitialState(root)).toThrow(/bootstrap|decision|evidence|invalid/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('binds recovery roots to the snapshot and rechecks them before registry linking', () => {
    const root = makeRoot('fresh-bootstrap-bound-recovery-before-registry-link')
    const recoveryEvidencePath = join(root, 'external-backups')
    const initialState = captureFirebaseProfileInitialState(root, {
      recoveryEvidencePaths: [recoveryEvidencePath],
    })
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })

    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
      { beforePublish: () => mkdirSync(recoveryEvidencePath) },
    )).toThrow(/bootstrap|recovery|evidence|eligibility/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('preserves browser-proved legacy Auth evidence after settings validation', () => {
    const root = makeRoot('browser-legacy-after-settings-validation')
    writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      DEFAULT_FIREBASE_CONFIG.apiKey,
      LEGACY_FIREBASE_APP_NAME,
    ))
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })
    expect(snapshot).toMatchObject({ kind: 'settings-validated-from-absence', existed: true })

    const registry = FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
    )

    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it.each([
    ['intent', (root: string) => writeFileSync(join(root, '.baby-info-pair-restore-v1.json'), '{}')],
    ['staging', (root: string) => mkdirSync(join(root, '.baby-info-pair-restore-v1'))],
    ['tombstone', (root: string) => writeFileSync(
      join(root, `.baby-info-pair-restore-v1.json.cleanup-${'a'.repeat(32)}`),
      '{}',
    )],
  ])('revalidates restore %s state immediately before registry publication', (_label, mutate) => {
    const root = makeRoot(`restore-${_label}-before-publish`)
    writeSettingsEvidence(root, customConfig)
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })

    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
      { beforePublish: () => mutate(root) },
    )).toThrow(/restore|staging|tombstone|protocol/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it.each([
    ['intent', (root: string) => writeFileSync(join(root, '.BaBy-InFo-PaIr-ReStOrE-V1.JsOn'), '{}')],
    ['staging', (root: string) => mkdirSync(join(root, '.BaBy-InFo-PaIr-ReStOrE-V1'))],
    ['tombstone', (root: string) => writeFileSync(
      join(root, `.BaBy-InFo-PaIr-ReStOrE-V1.JsOn.ClEaNuP-${'a'.repeat(32)}`),
      '{}',
    )],
  ])('blocks a mixed-case Windows restore %s immediately before registry publication', (_label, mutate) => {
    const root = makeRoot(`windows-mixed-case-restore-${_label}`)
    writeSettingsEvidence(root, customConfig)
    const initialState = captureFirebaseProfileInitialState(root, { platform: 'win32' })
    const settingsStore = new SettingsStore(root, { platform: 'win32' })
    const snapshot = detectPreexistingFirebaseProfile(root, { platform: 'win32', initialState })

    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
      { platform: 'win32', beforePublish: () => mutate(root) },
    )).toThrow(/restore|staging|tombstone|protocol/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('revalidates restore state after the final browser evidence scan', () => {
    const root = makeRoot('restore-intent-during-final-browser-scan')
    writeSettingsEvidence(root, customConfig)
    const levelDb = writeV038AuthLevelDb(root, makeChromiumIndexedDbAuthLog(
      customConfig.apiKey,
      LEGACY_FIREBASE_APP_NAME,
    ))
    const initialState = captureFirebaseProfileInitialState(root)
    const settingsStore = new SettingsStore(root)
    const snapshot = detectPreexistingFirebaseProfile(root, { initialState })
    const currentPath = join(levelDb, 'CURRENT')
    let finalScanArmed = false
    let injected = false

    expect(() => FirebasePersistenceRegistry.openAfterSettingsValidation(
      root,
      snapshot,
      settingsStore.get(),
      {
        beforePublish: () => { finalScanArmed = true },
        afterFirstFileRead: target => {
          if (finalScanArmed && !injected && target === currentPath) {
            injected = true
            writeFileSync(join(root, '.baby-info-pair-restore-v1.json'), '{}')
          }
        },
      },
    )).toThrow(/restore|protocol|cleanup/i)
    expect(injected).toBe(true)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('keeps the registry absent through every Windows restart-required recovery phase', () => {
    const root = makeRoot('windows-recovery-publication-gate')
    writeVerifiedRecoveryBackup(root)
    writeFileSync(join(root, 'settings.json'), '{ broken settings')
    writeFileSync(join(root, BABY_INFO_JOURNAL_FILE), '{"version":1,"type":"mutation"')
    const startLikeMain = (startupId: string): FirebasePersistenceRegistry => {
      const initialState = captureFirebaseProfileInitialState(root, { platform: 'win32' })
      const settingsStore = new SettingsStore(root, { platform: 'win32', startupId })
      const snapshot = detectPreexistingFirebaseProfile(root, { platform: 'win32', initialState })
      return FirebasePersistenceRegistry.openAfterSettingsValidation(
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
    expect(document.eligibilityEvidence.kind).toBe('settings-snapshot')
  })

  it('never publishes transient config B after a Windows primary-verified restore of config A', () => {
    const root = makeRoot('windows-transient-config-publication-gate')
    writeVerifiedRecoveryBackup(root)
    writeFileSync(join(root, 'settings.json'), '{ broken settings')
    writeFileSync(join(root, BABY_INFO_JOURNAL_FILE), '{ broken journal')
    const startLikeMain = (startupId: string): FirebasePersistenceRegistry => {
      const initialState = captureFirebaseProfileInitialState(root, { platform: 'win32' })
      const settingsStore = new SettingsStore(root, { platform: 'win32', startupId })
      const snapshot = detectPreexistingFirebaseProfile(root, { platform: 'win32', initialState })
      return FirebasePersistenceRegistry.openAfterSettingsValidation(
        root,
        snapshot,
        settingsStore.get(),
        { platform: 'win32' },
      )
    }

    for (const startupId of ['transient-boot-0', 'transient-boot-1', 'transient-boot-2']) {
      expect(() => startLikeMain(startupId)).toThrow(expect.objectContaining({
        restartRequired: true,
      }))
      expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    }

    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      firebase: otherConfig,
      profile: 42,
    }))
    expect(() => startLikeMain('transient-boot-3')).toThrow(/settings|restore|primary|validation/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toContain(otherConfig.apiKey)
  })

  it('keeps the registry absent when strict settings validation has no valid backup', () => {
    const root = makeRoot('invalid-settings-invalid-backup-gate')
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      firebase: otherConfig,
      profile: 42,
    }))
    const invalidBackup = join(root, 'backups', '2026-07-14_01-02-03')
    mkdirSync(invalidBackup, { recursive: true })
    writeFileSync(join(invalidBackup, 'settings.json'), '{ invalid backup')
    const initialState = captureFirebaseProfileInitialState(root)

    expect(() => new SettingsStore(root)).toThrow(/settings|backup|recovery|validation/i)
    expect(initialState.settingsExisted).toBe(true)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
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
