import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  assertUpgradeContinuity,
  UPGRADE_FIREBASE_PROJECT_ID,
  V038_DEFAULT_FIREBASE_EVIDENCE,
  buildFailClosedChromiumArgs,
  buildUpgradeFirebaseConfig,
  buildUpgradeTransportPolicy,
  describeUpgradeBlockedRequest,
  installCdpUpgradeNetworkGuard,
  redactUpgradeCredentialText,
  readUpgradeEmulatorEvidence,
  resolveUpgradeNetworkRequest,
  startUpgradeDenyProxy,
  snapshotUpgradeContinuity,
  validateUpgradeEmulatorEnvironment,
} from '../scripts/upgrade-firebase-continuity.mjs'

const ENV = {
  BABYDIARY_UPGRADE_FIREBASE_EMULATOR: '1',
  BABYDIARY_UPGRADE_FIREBASE_PROJECT_ID: 'demo-baby-diary',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const stableJson = (value: any): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

describe('published-upgrade Firebase continuity guard', () => {
  it('accepts only the pinned loopback emulator endpoints and emits the v0.3.8-compatible config', () => {
    expect(validateUpgradeEmulatorEnvironment(ENV)).toEqual({
      projectId: 'demo-baby-diary',
      auth: { host: '127.0.0.1', port: 9099 },
      firestore: { host: '127.0.0.1', port: 8080 },
    })
    const exactConfig = buildUpgradeFirebaseConfig()
    expect(sha256(exactConfig.apiKey)).toBe(V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256)
    expect(sha256(stableJson(exactConfig))).toBe(V038_DEFAULT_FIREBASE_EVIDENCE.configSha256)
    expect(exactConfig.projectId).not.toBe('demo-baby-diary')

    for (const bad of [
      { ...ENV, BABYDIARY_UPGRADE_FIREBASE_EMULATOR: undefined },
      { ...ENV, BABYDIARY_UPGRADE_FIREBASE_PROJECT_ID: 'production-project' },
      { ...ENV, FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com:9099' },
      { ...ENV, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9100' },
      { ...ENV, FIRESTORE_EMULATOR_HOST: 'http://127.0.0.1:8080' },
    ]) {
      expect(() => validateUpgradeEmulatorEnvironment(bad)).toThrow(/emulator|loopback|project|port|host/i)
    }
  })

  it('starts Chromium with external DNS fail-closed before the first renderer request', () => {
    const args = buildFailClosedChromiumArgs({ denyProxyPort: 43191 })
    expect(args).toContain('--disable-background-networking')
    expect(args).toContain('--proxy-server=http://127.0.0.1:43191')
    expect(args).toContain('--proxy-bypass-list=localhost;127.0.0.1;[::1]')
    const resolver = args.find((item: string) => item.startsWith('--host-resolver-rules='))
    expect(resolver).toContain('MAP * ~NOTFOUND')
    expect(resolver).toContain('EXCLUDE localhost')
    expect(resolver).toContain('EXCLUDE 127.0.0.1')
    expect(resolver).toContain('EXCLUDE [::1]')
  })

  it('rewrites only Auth, SecureToken, and Firestore to loopback while preserving path/query', () => {
    const allowedFileRoot = path.resolve('packaged', 'app.asar')
    const allowedFileUrl = pathToFileURL(path.join(allowedFileRoot, 'dist', 'index.html')).href
    expect(resolveUpgradeNetworkRequest(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key',
      { allowedFileRoot, method: 'POST' },
    )).toEqual({
      action: 'rewrite',
      category: 'auth',
      url: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key',
    })
    expect(resolveUpgradeNetworkRequest(
      'https://identitytoolkit.googleapis.com/v2/passwordPolicy?key=demo-api-key',
      { allowedFileRoot, method: 'GET' },
    )).toEqual({
      action: 'rewrite',
      category: 'auth-password-policy',
      url: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v2/passwordPolicy?key=demo-api-key',
    })
    expect(resolveUpgradeNetworkRequest(
      'https://securetoken.googleapis.com/v1/token?key=demo-api-key',
      { allowedFileRoot, method: 'POST' },
    )).toEqual({
      action: 'rewrite',
      category: 'secure-token',
      url: 'http://127.0.0.1:9099/securetoken.googleapis.com/v1/token?key=demo-api-key',
    })
    expect(resolveUpgradeNetworkRequest(
      'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fdemo-baby-diary%2Fdatabases%2F(default)&RID=42',
      { allowedFileRoot, method: 'GET' },
    )).toEqual({
      action: 'rewrite',
      category: 'firestore',
      url: 'http://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fdemo-baby-diary%2Fdatabases%2F(default)&RID=42',
    })
    expect(resolveUpgradeNetworkRequest(
      'http://127.0.0.1:8080/google.firestore.v1.Firestore/Write/channel?database=projects%2Fdemo-baby-diary%2Fdatabases%2F(default)&SID=abc',
      { allowedFileRoot, method: 'POST' },
    )).toEqual({ action: 'allow', category: 'firestore-loopback' })
    expect(resolveUpgradeNetworkRequest(
      allowedFileUrl,
      { allowedFileRoot, method: 'GET' },
    ))
      .toEqual({ action: 'allow', category: 'local-resource' })

    const exactConfig = buildUpgradeFirebaseConfig()
    const publishedPolicy = buildUpgradeTransportPolicy('published-v038')
    const publishedAuth = resolveUpgradeNetworkRequest(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(exactConfig.apiKey)}`,
      { allowedFileRoot, method: 'POST', ...publishedPolicy },
    )
    expect(publishedAuth.action).toBe('rewrite')
    expect(publishedAuth.category).toBe('auth')
    const publishedFirestore = resolveUpgradeNetworkRequest(
      `https://firestore.googleapis.com/google.firestore.v1.Firestore/Write/channel?database=${encodeURIComponent(`projects/${exactConfig.projectId}/databases/(default)`)}`,
      { allowedFileRoot, method: 'POST', ...publishedPolicy },
    )
    expect(publishedFirestore.action).toBe('rewrite')
    expect(publishedFirestore.category).toBe('firestore')

    for (const blocked of [
      'https://example.com/telemetry?token=secret',
      'https://firestore.googleapis.com.evil.test/v1/projects/demo-baby-diary',
      'http://127.0.0.1:8000/not-an-emulator',
      'ws://127.0.0.1:8080/socket',
      'https://1.1.1.1/',
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=production-key',
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key&key=demo-api-key',
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key&unknown=value',
      'https://identitytoolkit.googleapis.com/v2/passwordPolicy?key=production-key',
      'https://identitytoolkit.googleapis.com/v2/passwordPolicyExtra?key=demo-api-key',
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key#token',
      'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fproduction%2Fdatabases%2F(default)',
      'https://firestore.googleapis.com/v1/projects/demo-baby-diary.evil/databases/(default)/documents/families',
      'file:///Users/person/.ssh/id_ed25519',
      'http://127.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key',
      'http://[::ffff:127.0.0.1]:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key',
      'not a URL',
    ]) {
      expect(resolveUpgradeNetworkRequest(blocked, {
        allowedFileRoot: '/Applications/Baby Diary.app/Contents/Resources/app.asar',
      })).toEqual({ action: 'block', category: 'external' })
    }

    for (const [rawUrl, method] of [
      ['https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key', 'GET'],
      ['https://identitytoolkit.googleapis.com/v2/passwordPolicy?key=demo-api-key', 'POST'],
      ['https://identitytoolkit.googleapis.com/v1/projects?key=demo-api-key', 'POST'],
      ['https://identitytoolkit.googleapis.com/v1/token?key=demo-api-key', 'POST'],
      ['https://securetoken.googleapis.com/v1/accounts:lookup?key=demo-api-key', 'POST'],
      ['https://securetoken.googleapis.com/v1/not-token?key=demo-api-key', 'POST'],
      ['https://firestore.googleapis.com/google.firestore.v1.Firestore/DeleteAll/channel?database=projects%2Fdemo-baby-diary%2Fdatabases%2F(default)', 'POST'],
      ['https://firestore.googleapis.com/v1/projects/demo-baby-diary/databases/(default)/documents/private/value', 'GET'],
      ['https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fdemo-baby-diary%2Fdatabases%2F(default)', 'TRACE'],
    ] as const) {
      expect(resolveUpgradeNetworkRequest(rawUrl, { allowedFileRoot, method }))
        .toEqual({ action: 'block', category: 'external' })
    }
  })

  it('canonicalizes file URLs and rejects traversal, encoded separators, UNC, and device authorities', () => {
    const allowedFileRoot = path.resolve('packaged', 'app.asar')
    const rootUrl = pathToFileURL(allowedFileRoot).href.replace(/\/$/, '')
    expect(resolveUpgradeNetworkRequest(`${rootUrl}/dist/index.html`, { allowedFileRoot, method: 'GET' }))
      .toEqual({ action: 'allow', category: 'local-resource' })

    for (const rawUrl of [
      `${rootUrl}/../outside.txt`,
      `${rootUrl}/%2e%2e/outside.txt`,
      `${rootUrl}/dist%2Foutside.txt`,
      `${rootUrl}/dist%5Coutside.txt`,
      'file://server/share/app.asar/index.html',
      'file://./C:/app.asar/index.html',
    ]) {
      expect(resolveUpgradeNetworkRequest(rawUrl, { allowedFileRoot, method: 'GET' }))
        .toEqual({ action: 'block', category: 'external' })
    }
  })

  it('records only an enum/path/method/query-name shape for a blocked Firebase request', () => {
    const shape = describeUpgradeBlockedRequest(
      'https://identitytoolkit.googleapis.com/v2/passwordPolicy?key=production-secret&clientType=CLIENT_TYPE_WEB&clientType=duplicate&version=secret-version',
      { method: 'POST' },
    )
    expect(shape).toEqual({
      host: 'identity-toolkit',
      pathname: '/v2/passwordPolicy',
      method: 'POST',
      queryParameterNames: ['clientType', 'clientType', 'key', 'version'],
      configuredDemoKeyEquality: false,
      requestKeySha256: sha256('production-secret'),
      hasFragment: false,
      hasUserInfo: false,
      blockReason: 'identity-request-shape',
    })
    const serialized = JSON.stringify(shape)
    for (const forbidden of ['production-secret', 'CLIENT_TYPE_WEB', 'duplicate', 'secret-version']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('routes every pre-guard external socket through a loopback deny proxy without retaining bytes', async () => {
    const proxy = await startUpgradeDenyProxy()
    expect(proxy.port).toBeGreaterThan(0)
    const socket = await new Promise<any>((resolvePromise, rejectPromise) => {
      import('node:net').then(({ connect }) => {
        const client = connect({ host: '127.0.0.1', port: proxy.port })
        client.once('connect', () => {
          client.write('CONNECT example.com:443 HTTP/1.1\r\nAuthorization: Bearer secret\r\n\r\n')
        })
        client.once('close', () => resolvePromise(client))
        client.once('error', error => {
          if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolvePromise(client)
          else rejectPromise(error)
        })
      }).catch(rejectPromise)
    })
    socket.destroy()
    expect(proxy.getEvidence()).toEqual({ blockedConnections: 1 })
    await proxy.close()
  })

  it('uses Fetch request-stage interception, can force offline, and detaches cleanly', async () => {
    const listeners = new Map<string, (event: any) => Promise<void>>()
    const send = vi.fn(async () => ({}))
    const session = {
      on: vi.fn((event: string, listener: (payload: any) => Promise<void>) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
      send,
      detach: vi.fn(async () => {}),
    }
    const page = {
      context: () => ({ newCDPSession: vi.fn(async () => session) }),
    }
    const guard = await installCdpUpgradeNetworkGuard(page as any)
    expect(send).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: false,
    })

    await listeners.get('Fetch.requestPaused')?.({
      requestId: 'auth-1',
      request: { url: 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key', method: 'POST' },
    })
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', expect.objectContaining({
      requestId: 'auth-1',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:9099\/identitytoolkit\.googleapis\.com\//),
    }))

    await listeners.get('Fetch.requestPaused')?.({
      requestId: 'password-policy-1',
      request: { url: 'https://identitytoolkit.googleapis.com/v2/passwordPolicy?key=demo-api-key', method: 'GET' },
    })
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', expect.objectContaining({
      requestId: 'password-policy-1',
      url: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v2/passwordPolicy?key=demo-api-key',
    }))

    guard.setOffline(true)
    await listeners.get('Fetch.requestPaused')?.({
      requestId: 'offline-1',
      request: { url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Write/channel?database=projects%2Fdemo-baby-diary%2Fdatabases%2F(default)', method: 'POST' },
    })
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'offline-1',
      errorReason: 'BlockedByClient',
    })

    guard.setOffline(false)
    await listeners.get('Fetch.requestPaused')?.({
      requestId: 'external-1',
      request: { url: 'https://example.com/?password=hunter2', method: 'GET' },
    })
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'external-1',
      errorReason: 'BlockedByClient',
    })
    expect(guard.getEvidence()).toEqual(expect.objectContaining({
      rewrittenAuth: 1,
      rewrittenPasswordPolicy: 1,
      expectedOfflineBlocks: 1,
      externalBlocks: 1,
      runtimeRequestKeySha256: sha256('demo-api-key'),
      firstExternalBlock: {
        host: 'other',
        pathname: '<redacted>',
        method: 'GET',
        queryParameterNames: ['password'],
        configuredDemoKeyEquality: false,
        requestKeySha256: null,
        hasFragment: false,
        hasUserInfo: false,
        blockReason: 'external-origin',
      },
    }))
    expect(JSON.stringify(guard.getEvidence())).not.toContain('hunter2')
    await expect(guard.assertReady()).resolves.toBeUndefined()

    await guard.close()
    expect(send).toHaveBeenCalledWith('Fetch.disable')
    expect(session.detach).toHaveBeenCalledTimes(1)
  })

  it('turns an asynchronous CDP response failure into a bounded generic gate failure', async () => {
    const listeners = new Map<string, (event: any) => Promise<void>>()
    const send = vi.fn(async (method: string) => {
      if (method === 'Fetch.continueRequest') throw new Error('sensitive request failure')
      return {}
    })
    const session = {
      on: vi.fn((event: string, listener: (payload: any) => Promise<void>) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
      send,
      detach: vi.fn(async () => {}),
    }
    const page = { context: () => ({ newCDPSession: async () => session }) }
    const guard = await installCdpUpgradeNetworkGuard(page as any)
    await listeners.get('Fetch.requestPaused')?.({
      requestId: 'failed-1',
      request: { url: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=demo-api-key', method: 'POST' },
    }).catch(() => {})
    await expect(guard.assertReady()).rejects.toThrow(/network guard request handling failed/i)
    await expect(guard.close()).rejects.toThrow(/network guard request handling failed/i)
    expect(session.detach).toHaveBeenCalledTimes(1)
  })

  it('redacts email, password, API keys, refresh/id tokens, and URL credentials', () => {
    const raw = 'email=parent@example.test password=hunter2 apiKey=demo-key idToken=abc refresh_token=def https://url-user-91:url-pass-91@example.test/?token=ghi'
    const redacted = redactUpgradeCredentialText(raw)
    for (const secret of ['parent@example.test', 'hunter2', 'demo-key', 'abc', 'def', 'url-user-91', 'url-pass-91', 'ghi']) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted).toContain('[REDACTED]')
  })

  it('reads Auth and Firestore emulator truth without exposing tokens', async () => {
    const response = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    })
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/accounts')) return response({ users: [{ localId: 'uid-1', email: 'parent@example.test' }] })
      if (url.includes('/documents/families/family-1/events')) {
        return response({
          documents: [
            {
              fields: {
                event: {
                  mapValue: {
                    fields: {
                      id: { stringValue: 'pending' },
                      rev: { integerValue: '1' },
                      deleted: { booleanValue: false },
                    },
                  },
                },
              },
            },
          ],
        })
      }
      if (url.endsWith('/documents/families/family-1')) {
        return response({ fields: {
          inviteCode: { stringValue: 'ABC234' },
          members: { mapValue: { fields: {
            'uid-1': { mapValue: { fields: { role: { stringValue: 'dad' } } } },
            'uid-2': { mapValue: { fields: { role: { stringValue: 'mom' } } } },
          } } },
        } })
      }
      throw new Error('unexpected endpoint')
    })
    await expect(readUpgradeEmulatorEvidence({
      uid: 'uid-1',
      familyId: 'family-1',
      pendingEvent: { id: 'pending', rev: 1 },
      fetchImpl,
    })).resolves.toEqual({
      uid: 'uid-1',
      email: 'parent@example.test',
      familyId: 'family-1',
      inviteCode: 'ABC234',
      memberUids: ['uid-1', 'uid-2'],
      cloudPendingCopies: 1,
      cloudEventIds: ['pending'],
    })
    for (const call of fetchImpl.mock.calls) {
      expect(call[0]).not.toMatch(/token|password|apiKey/i)
    }
    const exactProjectId = buildUpgradeFirebaseConfig().projectId
    const calledUrls = fetchImpl.mock.calls.map(call => call[0])
    expect(calledUrls.filter(url => url.includes('/documents'))
      .every(url => url.includes(`/projects/${exactProjectId}/databases/(default)`))).toBe(true)
    expect(calledUrls.find(url => url.endsWith('/accounts')))
      .toContain(`/projects/${UPGRADE_FIREBASE_PROJECT_ID}/accounts`)
  })

  it('requires the same restored account/family and exact-once pending drain without signup fallback', () => {
    const baseline = snapshotUpgradeContinuity({
      uid: 'uid-v038',
      email: 'parent@example.test',
      familyId: 'family-1',
      inviteCode: 'ABC234',
      memberUids: ['uid-v038'],
      onlineEvent: { id: 'online', rev: 1, deleted: false },
      pendingEvent: { id: 'pending', rev: 1, deleted: false },
      pendingCount: 1,
      cloudPendingCopies: 0,
      authFormVisible: false,
      signupAttempted: true,
    })
    const candidate = snapshotUpgradeContinuity({
      uid: 'uid-v038',
      email: 'parent@example.test',
      familyId: 'family-1',
      inviteCode: 'ABC234',
      memberUids: ['uid-v038', 'uid-device-2'],
      onlineEvent: { id: 'online', rev: 1, deleted: false },
      pendingEvent: { id: 'pending', rev: 1, deleted: false },
      pendingCount: 0,
      cloudPendingCopies: 1,
      authFormVisible: false,
      signupAttempted: false,
      secondDevice: {
        uid: 'uid-device-2',
        familyId: 'family-1',
        convergedEventIds: ['online', 'pending'],
      },
    })
    expect(baseline.emailSha256).toBe(sha256('parent@example.test'))
    expect(baseline).toMatchObject({
      version: 2,
      uidSha256: sha256('uid-v038'),
      familyIdSha256: sha256('family-1'),
      memberUidSha256s: [sha256('uid-v038')],
      onlineEvent: { idSha256: sha256('online') },
      pendingEvent: { idSha256: sha256('pending') },
    })
    const persisted = JSON.stringify({ baseline, candidate })
    for (const forbidden of [
      'uid-v038',
      'uid-device-2',
      'parent@example.test',
      'family-1',
      'ABC234',
      '"online"',
      '"pending"',
    ]) expect(persisted).not.toContain(forbidden)
    expect(() => assertUpgradeContinuity(baseline, candidate, 'candidate-first-run')).not.toThrow()

    for (const broken of [
      { ...candidate, uidSha256: sha256('replacement') },
      { ...candidate, emailSha256: sha256('other@example.test') },
      { ...candidate, familyIdSha256: sha256('other-family') },
      { ...candidate, authFormVisible: true },
      { ...candidate, signupAttempted: true },
      { ...candidate, pendingCount: 1 },
      { ...candidate, cloudPendingCopies: 0 },
      { ...candidate, cloudPendingCopies: 2 },
      { ...candidate, secondDevice: undefined },
      { ...candidate, secondDevice: { ...candidate.secondDevice, familyIdSha256: sha256('other-family') } },
    ]) {
      expect(() => assertUpgradeContinuity(baseline, broken, 'candidate-first-run'))
        .toThrow(/account|email|family|auth|signup|pending|exact|second-device|converg/i)
    }
  })

  it('compares event semantics while allowing the durable auth-bound derivative metadata', () => {
    const common = {
      uid: 'uid-v038',
      email: 'parent@example.test',
      familyId: 'family-1',
      inviteCode: 'ABC234',
      memberUids: ['uid-v038', 'uid-device-2'],
      onlineEvent: { id: 'online', rev: 1, deleted: false },
      authFormVisible: false,
    }
    const source = {
      id: 'pending',
      rev: 1,
      deleted: false,
      type: 'poop',
      data: { memo: 'same care record' },
      author: { uid: '', name: 'Parent', role: 'dad' },
    }
    const derivative = {
      ...source,
      author: { ...source.author, uid: 'uid-v038' },
      mutationId: 'auth-bound-mutation',
      sync: { version: 1, encodedEventId: 'pending' },
      migration: { version: 1, kind: 'legacy-author-v1', sourceContentId: 'source-id' },
    }
    const baseline = snapshotUpgradeContinuity({
      ...common,
      pendingEvent: source,
      pendingCount: 1,
      cloudPendingCopies: 0,
      signupAttempted: true,
    })
    const candidateInput = {
      ...common,
      pendingEvent: derivative,
      pendingCount: 0,
      cloudPendingCopies: 1,
      signupAttempted: false,
      secondDevice: {
        uid: 'uid-device-2',
        familyId: 'family-1',
        convergedEventIds: ['online', 'pending'],
      },
    }
    const candidate = snapshotUpgradeContinuity(candidateInput)
    expect(() => assertUpgradeContinuity(baseline, candidate, 'candidate-first-run')).not.toThrow()

    const substituted = snapshotUpgradeContinuity({
      ...candidateInput,
      pendingEvent: { ...derivative, data: { memo: 'changed' } },
    })
    expect(() => assertUpgradeContinuity(baseline, substituted, 'candidate-first-run'))
      .toThrow(/pending event continuity changed/i)
  })
})
