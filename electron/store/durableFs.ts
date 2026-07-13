import * as nodeFs from 'fs'
import * as path from 'path'

export interface DurableFileOps {
  existsSync(target: nodeFs.PathLike): boolean
  mkdirSync(target: nodeFs.PathLike, options?: nodeFs.MakeDirectoryOptions): string | undefined
  openSync(target: nodeFs.PathLike, flags: nodeFs.OpenMode, mode?: nodeFs.Mode): number
  writeSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(oldPath: nodeFs.PathLike, newPath: nodeFs.PathLike): void
  unlinkSync(target: nodeFs.PathLike): void
  fstatSync(fd: number): nodeFs.Stats
  ftruncateSync(fd: number, length?: number): void
}

export interface DurableWriteOptions {
  fs?: DurableFileOps
  platform?: NodeJS.Platform
}

export interface DurableWriteEvidence {
  fileSynced: true
  directorySynced: boolean
}

const DEFAULT_OPS = nodeFs as unknown as DurableFileOps
let temporarySequence = 0

export class DurableAppendUncertainError extends Error {
  readonly code = 'DURABLE_APPEND_UNCERTAIN' as const

  constructor(
    readonly target: string,
    readonly preAppendLength: number,
    readonly appendError: unknown,
    readonly rollbackError: unknown,
  ) {
    super(
      `Durable append failed and rollback could not be confirmed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
    )
    this.name = 'DurableAppendUncertainError'
    Object.assign(this, { cause: appendError })
  }
}

export function isDurableAppendUncertainError(error: unknown): error is DurableAppendUncertainError {
  return error instanceof DurableAppendUncertainError
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'DURABLE_APPEND_UNCERTAIN')
}

export class DurableAppendCommittedError extends Error {
  readonly code = 'DURABLE_APPEND_COMMITTED_WITH_ERROR' as const
  readonly committed = true as const
  readonly fileSynced = true as const

  constructor(
    readonly target: string,
    readonly preAppendLength: number,
    readonly appendedLength: number,
    readonly postCommitError: unknown,
  ) {
    super(
      `Durable append committed its bytes but a later operation failed: ${postCommitError instanceof Error ? postCommitError.message : String(postCommitError)}`,
    )
    this.name = 'DurableAppendCommittedError'
    Object.assign(this, { cause: postCommitError })
  }
}

export function isDurableAppendCommittedError(error: unknown): error is DurableAppendCommittedError {
  return error instanceof DurableAppendCommittedError
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'DURABLE_APPEND_COMMITTED_WITH_ERROR')
}

export class DurableReplaceCommittedError extends Error {
  readonly code = 'DURABLE_REPLACE_COMMITTED_WITH_ERROR' as const
  readonly committed = true as const
  readonly fileSynced = true as const
  readonly renameCompleted = true as const

  constructor(
    readonly target: string,
    readonly postCommitError: unknown,
  ) {
    super(
      `Atomic replacement committed the renamed file but a later operation failed: ${postCommitError instanceof Error ? postCommitError.message : String(postCommitError)}`,
    )
    this.name = 'DurableReplaceCommittedError'
    Object.assign(this, { cause: postCommitError })
  }
}

export function isDurableReplaceCommittedError(error: unknown): error is DurableReplaceCommittedError {
  return error instanceof DurableReplaceCommittedError
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'DURABLE_REPLACE_COMMITTED_WITH_ERROR')
}

export class DurableTruncateUncertainError extends Error {
  readonly code = 'DURABLE_TRUNCATE_UNCERTAIN' as const

  constructor(
    readonly target: string,
    readonly truncatedLength: number,
    readonly syncError: unknown,
    readonly closeError?: unknown,
  ) {
    super(
      `Durable truncation changed the file but could not confirm durability: ${syncError instanceof Error ? syncError.message : String(syncError)}`,
    )
    this.name = 'DurableTruncateUncertainError'
    Object.assign(this, { cause: syncError })
  }
}

export function isDurableTruncateUncertainError(error: unknown): error is DurableTruncateUncertainError {
  return error instanceof DurableTruncateUncertainError
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'DURABLE_TRUNCATE_UNCERTAIN')
}

function asBuffer(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
}

/** Write the complete buffer, treating a zero/invalid short write as failure. */
export function writeAllSync(
  fd: number,
  data: Uint8Array,
  ops: Pick<DurableFileOps, 'writeSync'> = DEFAULT_OPS,
  position: number | null = null,
): void {
  const buffer = asBuffer(data)
  let offset = 0
  while (offset < buffer.byteLength) {
    const writePosition = position === null ? null : position + offset
    const count = ops.writeSync(fd, buffer, offset, buffer.byteLength - offset, writePosition)
    if (!Number.isInteger(count) || count <= 0 || count > buffer.byteLength - offset) {
      throw new Error('durable write made no progress (short write)')
    }
    offset += count
  }
}

function ensureParent(target: string, ops: DurableFileOps): void {
  const parent = path.dirname(target)
  if (!ops.existsSync(parent)) ops.mkdirSync(parent, { recursive: true })
}

function syncParentDirectory(
  target: string,
  ops: DurableFileOps,
  platform: NodeJS.Platform,
): boolean {
  // Windows does not expose a reliably fsync-able directory handle through
  // Node. File contents are fsynced before same-volume rename/append, and the
  // returned evidence explicitly records that no directory fsync occurred.
  if (platform === 'win32') return false

  const fd = ops.openSync(path.dirname(target), 'r')
  try {
    ops.fsyncSync(fd)
  } finally {
    ops.closeSync(fd)
  }
  return true
}

export function appendDurableFileSync(
  target: string,
  data: string | Uint8Array,
  options: DurableWriteOptions = {},
): DurableWriteEvidence {
  const ops = options.fs ?? DEFAULT_OPS
  const platform = options.platform ?? process.platform
  ensureParent(target, ops)
  const created = !ops.existsSync(target)
  const payload = asBuffer(data)
  const fd = ops.openSync(target, created ? 'wx+' : 'r+', 0o600)

  let appendCommitted = false
  let preAppendLength = 0
  let operationFailed = false
  let operationError: unknown
  try {
    const stat = ops.fstatSync(fd)
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error('durable append target length is invalid')
    }
    preAppendLength = stat.size
    try {
      writeAllSync(fd, payload, ops, preAppendLength)
      ops.fsyncSync(fd)
      appendCommitted = true
    } catch (appendError) {
      try {
        ops.ftruncateSync(fd, preAppendLength)
        ops.fsyncSync(fd)
      } catch (rollbackError) {
        throw new DurableAppendUncertainError(
          target,
          preAppendLength,
          appendError,
          rollbackError,
        )
      }
      throw appendError
    }
  } catch (error) {
    operationFailed = true
    operationError = error
  }

  let closeFailed = false
  let closeError: unknown
  try {
    ops.closeSync(fd)
  } catch (error) {
    closeFailed = true
    closeError = error
  }

  if (appendCommitted && closeFailed) {
    throw new DurableAppendCommittedError(
      target,
      preAppendLength,
      payload.byteLength,
      closeError,
    )
  }
  if (operationFailed) throw operationError
  if (closeFailed) throw closeError

  let directorySynced = false
  if (created) {
    try {
      directorySynced = syncParentDirectory(target, ops, platform)
    } catch (error) {
      throw new DurableAppendCommittedError(
        target,
        preAppendLength,
        payload.byteLength,
        error,
      )
    }
  }
  return {
    fileSynced: true,
    directorySynced,
  }
}

export function atomicReplaceFileSync(
  target: string,
  data: string | Uint8Array,
  options: DurableWriteOptions = {},
): DurableWriteEvidence {
  const ops = options.fs ?? DEFAULT_OPS
  const platform = options.platform ?? process.platform
  ensureParent(target, ops)
  temporarySequence += 1
  const temporary = `${target}.tmp-${process.pid}-${temporarySequence}`
  let temporaryExists = false
  try {
    const fd = ops.openSync(temporary, 'wx', 0o600)
    temporaryExists = true
    try {
      writeAllSync(fd, asBuffer(data), ops)
      ops.fsyncSync(fd)
    } finally {
      ops.closeSync(fd)
    }
    ops.renameSync(temporary, target)
    temporaryExists = false
    let directorySynced: boolean
    try {
      directorySynced = syncParentDirectory(target, ops, platform)
    } catch (error) {
      throw new DurableReplaceCommittedError(target, error)
    }
    return {
      fileSynced: true,
      directorySynced,
    }
  } catch (error) {
    if (temporaryExists) {
      try { ops.unlinkSync(temporary) } catch { /* preserve the original failure */ }
    }
    throw error
  }
}

/** Remove a known torn suffix and durably publish the shorter file. */
export function truncateDurableFileSync(
  target: string,
  length: number,
  options: DurableWriteOptions = {},
): DurableWriteEvidence {
  const ops = options.fs ?? DEFAULT_OPS
  const platform = options.platform ?? process.platform
  const fd = ops.openSync(target, 'r+')

  let truncationCompleted = false
  let fileSyncCompleted = false
  let operationFailed = false
  let operationError: unknown
  try {
    ops.ftruncateSync(fd, length)
    truncationCompleted = true
    ops.fsyncSync(fd)
    fileSyncCompleted = true
  } catch (error) {
    operationFailed = true
    operationError = error
  }

  let closeFailed = false
  let closeError: unknown
  try {
    ops.closeSync(fd)
  } catch (error) {
    closeFailed = true
    closeError = error
  }

  if (operationFailed || closeFailed) {
    if (truncationCompleted && !fileSyncCompleted) {
      throw new DurableTruncateUncertainError(
        target,
        length,
        operationError,
        closeError,
      )
    }
    if (operationFailed) throw operationError
    throw closeError
  }
  return {
    fileSynced: true,
    directorySynced: syncParentDirectory(target, ops, platform),
  }
}
