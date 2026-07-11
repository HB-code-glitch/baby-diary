/**
 * 가족 전용 Firebase 프로젝트 기본 설정 (Spark 무료 플랜).
 * apiKey는 클라이언트 공개 값 — 보안은 Firestore Security Rules 가 담당.
 * 사용자가 별도 Firebase 설정을 붙여넣으면 해당 값이 우선 적용됨.
 */
import { FirebaseConfig } from './firebase'

export const DEFAULT_FIREBASE_CONFIG: FirebaseConfig = {
  apiKey:            'AIzaSyBM4WKVJYQA_ht0O3ivNSSGkNM0-GQt8Aw',
  authDomain:        'baby-diary-jaei-2026.firebaseapp.com',
  projectId:         'baby-diary-jaei-2026',
  storageBucket:     'baby-diary-jaei-2026.firebasestorage.app',
  messagingSenderId: '406531612461',
  appId:             '1:406531612461:web:aa43b832f0661feaccfda4',
}
