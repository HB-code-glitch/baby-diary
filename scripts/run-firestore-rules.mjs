import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const debugLog = resolve(process.cwd(), 'firestore-debug.log')
let result

try {
  const firebaseCli = require.resolve('firebase-tools/lib/bin/firebase')
  result = spawnSync(process.execPath, [
    firebaseCli,
    'emulators:exec',
    '--project',
    'demo-baby-diary',
    '--only',
    'auth,firestore',
    'vitest run tests/firestoreRulesEmulator.test.ts',
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
} finally {
  rmSync(debugLog, { force: true })
  if (existsSync(debugLog)) {
    throw new Error(`Firestore emulator diagnostic was not removed: ${debugLog}`)
  }
}

if (result?.error) throw result.error
if (result?.status !== 0) process.exitCode = result?.status ?? 1
