import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendDurableFileSync,
  atomicReplaceFileSync,
  writeAllSync,
  type DurableFileOps,
} from '../electron/store/durableFs'

describe('durable synchronous file writes', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-diary-durable-fs-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loops over short writes until every UTF-8 byte has been written', () => {
    const source = Buffer.from('엄마-baby', 'utf8')
    const written: number[] = []
    const writeSync = vi.fn((
      _fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
    ) => {
      const count = Math.min(2, length)
      written.push(...Array.from(buffer.subarray(offset, offset + count)))
      return count
    })

    writeAllSync(7, source, { writeSync })

    expect(Buffer.from(written)).toEqual(source)
    expect(writeSync.mock.calls.length).toBeGreaterThan(1)
  })

  it('fails closed when a write makes no progress', () => {
    expect(() => writeAllSync(7, Buffer.from('data'), {
      writeSync: () => 0,
    })).toThrow(/short write|progress/i)
  })

  it('appends all bytes and fsyncs before returning', () => {
    const file = path.join(tmpDir, 'journal.jsonl')
    appendDurableFileSync(file, Buffer.from('first\n'))
    appendDurableFileSync(file, Buffer.from('둘 번째\n'))

    expect(fs.readFileSync(file, 'utf8')).toBe('first\n둘 번째\n')
  })

  it('rolls a failed append back to the pre-append length on the same handle', () => {
    const file = path.join(tmpDir, 'journal.jsonl')
    fs.writeFileSync(file, 'confirmed\n')
    let fsyncCalls = 0
    const ops: DurableFileOps = {
      ...fs,
      fsyncSync(fd) {
        fsyncCalls += 1
        if (fsyncCalls === 1) throw new Error('injected append fsync failure')
        fs.fsyncSync(fd)
      },
    }

    expect(() => appendDurableFileSync(
      file,
      Buffer.from('unconfirmed\n'),
      { fs: ops },
    )).toThrow(/injected append fsync failure/)

    expect(fsyncCalls).toBe(2)
    expect(fs.readFileSync(file, 'utf8')).toBe('confirmed\n')
  })

  it('reports a structured uncertain state when append rollback cannot be confirmed', () => {
    const file = path.join(tmpDir, 'journal.jsonl')
    fs.writeFileSync(file, 'confirmed\n')
    let fsyncCalls = 0
    const ops: DurableFileOps = {
      ...fs,
      fsyncSync() {
        fsyncCalls += 1
        throw new Error(fsyncCalls === 1 ? 'append fsync failed' : 'rollback fsync failed')
      },
    }

    let caught: unknown
    try {
      appendDurableFileSync(file, Buffer.from('unconfirmed\n'), { fs: ops })
    } catch (error) { caught = error }

    expect(caught).toMatchObject({
      code: 'DURABLE_APPEND_UNCERTAIN',
      preAppendLength: Buffer.byteLength('confirmed\n'),
    })
    expect(String(caught)).toMatch(/rollback fsync failed/i)
  })

  it('atomically replaces a file only after full write and fsync', () => {
    const file = path.join(tmpDir, 'settings.json')
    fs.writeFileSync(file, 'old')

    atomicReplaceFileSync(file, Buffer.from('new 설정', 'utf8'))

    expect(fs.readFileSync(file, 'utf8')).toBe('new 설정')
    expect(fs.readdirSync(tmpDir).filter(name => name.includes('.tmp-'))).toEqual([])
  })

  it.each(['write', 'file-fsync', 'rename', 'directory-fsync'] as const)(
    'propagates injected %s failure and never reports durable success',
    failure => {
      const file = path.join(tmpDir, 'settings.json')
      fs.writeFileSync(file, 'old')
      let openCount = 0
      const realOpen = fs.openSync.bind(fs)
      const ops: DurableFileOps = {
        ...fs,
        openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
          openCount += 1
          return realOpen(target, flags, mode)
        },
        writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) {
          if (failure === 'write') throw new Error('injected write')
          return fs.writeSync(fd, buffer, offset, length, position)
        },
        fsyncSync(fd: number) {
          const directoryPhase = openCount >= 2
          if (failure === 'file-fsync' && !directoryPhase) throw new Error('injected file fsync')
          if (failure === 'directory-fsync' && directoryPhase) throw new Error('injected directory fsync')
          fs.fsyncSync(fd)
        },
        renameSync(oldPath: fs.PathLike, newPath: fs.PathLike) {
          if (failure === 'rename') throw new Error('injected rename')
          fs.renameSync(oldPath, newPath)
        },
      }

      expect(() => atomicReplaceFileSync(
        file,
        Buffer.from('new'),
        { fs: ops, platform: 'linux' },
      )).toThrow(/injected/)

      if (failure !== 'directory-fsync') {
        expect(fs.readFileSync(file, 'utf8')).toBe('old')
      } else {
        // Rename happened, but the API still fails because directory durability
        // could not be established.
        expect(fs.readFileSync(file, 'utf8')).toBe('new')
      }
    },
  )

  it('uses the explicit safe Windows contract without claiming a directory fsync', () => {
    const file = path.join(tmpDir, 'settings.json')
    const result = atomicReplaceFileSync(file, Buffer.from('windows'), { platform: 'win32' })

    expect(result).toEqual({ fileSynced: true, directorySynced: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('windows')
  })
})
