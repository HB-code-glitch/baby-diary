/**
 * src/sync/useSync.ts
 * 동기화 상태를 React에서 사용하기 위한 훅.
 * UI 컴포넌트는 없음 — 순수 훅과 유틸 함수만 export.
 */
import { useState, useEffect } from 'react'
import {
  SyncState,
  getStatus,
  subscribeStatus,
  configure,
  signIn,
  signUp,
  signOutSync,
  createFamily,
  joinFamily,
  enqueue,
  start,
  stop,
  restartSync,
  updateFamilyBabyInfo,
} from './syncEngine'
import { ipc } from '../lib/ipc'
import { DiaryEvent } from '../../shared/types'
import { DEFAULT_FIREBASE_CONFIG } from './defaultFirebaseConfig'

export type { SyncState }

/**
 * 현재 동기화 상태를 구독하는 훅.
 * 컴포넌트가 마운트될 때 현재 상태를 즉시 받고,
 * 이후 상태 변경 시마다 리렌더링됨.
 */
export function useSyncStatus(): SyncState {
  const [state, setState] = useState<SyncState>(getStatus)

  useEffect(() => {
    const unsub = subscribeStatus(setState)
    return unsub
  }, [])

  return state
}

/**
 * 앱 수명주기에 맞춰 sync 엔진을 시작/중단하는 훅.
 * App.tsx 또는 최상위 컴포넌트에서 한 번만 마운트.
 */
export function useSyncLifecycle(): void {
  useEffect(() => {
    // 앱 설정을 읽어 configure → start
    // settings.firebase 가 null 이면 내장 기본 설정(DEFAULT_FIREBASE_CONFIG)으로 폴백.
    // 덕분에 첫 설치에서도 바로 로그인/회원가입 화면으로 진입할 수 있음.
    ipc.getSettings().then(async settings => {
      await configure(settings.firebase ?? DEFAULT_FIREBASE_CONFIG, settings.familyId)
      start()
    }).catch(async () => {
      // 설정 읽기 실패 시에도 기본 설정으로 configure
      await configure(DEFAULT_FIREBASE_CONFIG, '')
      start()
    })

    return () => {
      stop()
    }
  }, [])
}

// ────────────────────────────────────────────────────────────
// 설정 화면에서 사용할 유틸리티 함수들 (훅이 아닌 일반 함수 re-export)
// UI 페이지에서 직접 import해서 사용
// ────────────────────────────────────────────────────────────

export {
  configure,
  signIn,
  signUp,
  signOutSync,
  createFamily,
  joinFamily,
  enqueue,
  start,
  stop,
  getStatus,
  subscribeStatus,
  restartSync,
  updateFamilyBabyInfo,
}

/**
 * 로컬 append 후 자동으로 동기화 큐에 추가하는 래퍼.
 * UI 레이어에서 이벤트를 기록할 때 ipc.appendEvent 대신 이것을 사용하면
 * 로컬 저장 + 클라우드 큐잉이 한 번에 처리됨.
 */
export async function appendAndEnqueue(event: DiaryEvent): Promise<'ok' | 'duplicate' | 'error'> {
  const result = await ipc.appendEvent(event)
  if (result !== 'error') {
    enqueue(event)
  }
  return result
}
