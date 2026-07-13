import * as nodeFs from 'fs'
import * as path from 'path'

export interface DurableFileOps {
  existsSync(target: nodeFs.PathLike): boolean
  mkdirSync(target: nodeFs.PathLike, options: nodeFs.MakeDirectoryOptions & { recursive: true }): string | undefined
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
  const fd = ops.openSync(target, 'a', 0o600)
  try {
    writeAllSync(fd, asBuffer(data), ops)
    ops.fsyncSync(fd)
  } finally {
    ops.closeSync(fd)
  }
  return {
    fileSynced: true,
    directorySynced: created ? syncParentDirectory(target, ops, platform) : false,
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
    return {
      fileSynced: true,
      directorySynced: syncParentDirectory(target, ops, platform),
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
  try {
    ops.ftruncateSync(fd, length)
    ops.fsyncSync(fd)
  } finally {
    ops.closeSync(fd)
  }
  return {
    fileSynced: true,
    directorySynced: syncParentDirectory(target, ops, platform),
  }
}
