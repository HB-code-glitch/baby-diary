# BABY DIARY — 설계 계획서

가족용 육아 기록 데스크톱 앱. 아빠(Windows) + 엄마(Mac) 실시간 연동. **데이터 유실 절대 금지** (추억 보존용). 비용 0원.

## 1. 기술 스택

- **앱 셸**: Electron (Windows에서 개발/검증 → 동일 코드로 Mac 빌드)
- **프론트엔드**: React 18 + TypeScript + Vite + Tailwind CSS v3.4 + zustand + lucide-react + recharts
- **로컬 저장**: append-only JSONL 이벤트 로그 (아래 3절)
- **클라우드 동기화**: Firebase Auth(이메일/비밀번호) + Cloud Firestore — Spark 무료 플랜
  - 무료 쿼터: 저장 1GB, 읽기 5만/일, 쓰기 2만/일 — 하루 수십 건 기록엔 수십 년치 여유
  - Firebase Storage는 신규 프로젝트에서 유료 플랜 필요 → **사진 기능 v1 제외** (과금 0 원칙)
- **패키징**: electron-builder — Windows(NSIS+portable), Mac(dmg+zip, arm64+x64)
  - Mac 빌드는 GitHub Actions(macos-latest) 워크플로 제공 (무료 쿼터 내)

## 2. 데이터 모델 (이벤트 소싱)

```ts
interface DiaryEvent {
  id: string            // uuid v4
  type: 'pee' | 'poop' | 'temp' | 'breast' | 'formula' | 'diary' | 'message'
  at: string            // 사건 발생 시각 ISO8601 (사용자 조정 가능)
  data: EventData       // 타입별 페이로드
  author: { uid: string; name: string; role: 'dad' | 'mom' }
  createdAt: string
  updatedAt: string
  rev: number           // 수정 시 +1
  deleted: boolean      // soft delete만 존재
}

// 타입별 data
pee:     { note?: string }
poop:    { note?: string }
temp:    { celsius: number; note?: string }          // 열 체크
breast:  { side: 'L' | 'R' | 'both'; minutes?: number; note?: string }
formula: { ml: number; note?: string }               // 분유 CC
diary:   { title?: string; text: string }            // 가족 일기
message: { text: string }                            // 아기에게 남기는 메시지
```

## 3. 데이터 유실 방지 — 6중 보호 (최우선 요구사항)

1. **append-only JSONL**: `userData/data/events-YYYY-MM.jsonl`. 한 줄 = 이벤트 한 rev. **기존 바이트를 절대 덮어쓰지 않음** — 수정/삭제도 새 rev 라인 append. 로드 시 id별 최고 rev 채택.
2. **fsync 보장**: append 후 fs.fsyncSync — OS 크래시에도 유실 최소화.
3. **자가 복구 로드**: 시작 시 파싱, 잘린 마지막 라인(전원 차단 등)은 무시하고 경고 로그 — 나머지 데이터 무손상.
4. **이중 자동 백업**: 앱 시작 시 + 6시간마다 전체 데이터 스냅샷을 (a) `userData/backups/`, (b) `문서/BabyDiary-백업/` 두 곳에 복사. 백업은 삭제하지 않고 누적 (데이터가 작아 용량 무해; 90일 이상 된 것만 월 1개로 압축 보관).
5. **Firestore 원격 복제**: 모든 이벤트가 클라우드에도 존재 — PC 고장/분실 시 복구원. 오프라인 캐시(persistentLocalCache)로 네트워크 없어도 동작.
6. **수동 내보내기**: 설정에서 JSON/CSV 전체 내보내기 버튼.

원자성: 스냅샷/설정 파일 쓰기는 temp 파일 작성 → rename 패턴.

## 4. 동기화 설계

- Firestore 구조: `families/{familyId}/events/{eventId}`, `families/{familyId}` 문서에 멤버 uid 목록 + 아기 정보.
- 가족 연결: 첫 사용자가 가족 생성 → 6자리 초대코드 → 상대가 코드 입력으로 합류.
- 충돌 해결: 이벤트는 사실상 불변(append). 수정은 rev 증가 + updatedAt LWW(last-write-wins). 삭제는 tombstone. 두 부모가 동시에 같은 기록을 수정할 확률 극히 낮음 — LWW로 충분.
- 업로드 큐: 미전송 이벤트는 pending 표시 후 재시도(지수 백오프). 다운로드: onSnapshot 실시간 수신 → 로컬 JSONL에 append (id+rev 중복 제거).
- **Firebase 미설정/미로그인 시 완전 로컬 모드로 100% 동작** — 동기화는 부가 레이어. 설정 화면에서 상태 표시.
- 보안 규칙: 가족 멤버 uid만 해당 가족 문서 읽기/쓰기. deleted 필드만 true 허용(하드 삭제 불가), rev 감소 거부.

## 5. 화면 구성 (한국어 UI)

1. **오늘(홈)**: 대형 빠른기록 버튼 5개(소변/대변/체온/모유/분유) → 원탭 기록(시각=지금, 즉시 수정 가능 토스트), 오늘 타임라인, "마지막 수유 후 N시간 M분" 배지, 아기 D+일수.
2. **기록**: 달력/날짜 네비 + 타임라인, 타입 필터, 항목 수정·삭제(soft).
3. **통계**: 일별 분유 총량(ml)·수유 횟수·기저귀 횟수 막대, 체온 라인 그래프(37.5℃ 경고선).
4. **일기**: 가족 일기 목록(작성자 표시) + 에디터.
5. **아기에게**: 편지 느낌 메시지 목록 + 작성 (나중에 아기가 크면 읽을 메시지).
6. **설정**: 아기 정보(이름/생일), 내 프로필(엄마/아빠), 가족 연결(코드), 동기화 상태, 백업 폴더 열기, 내보내기.

## 6. 디자인 방향

- `clean-minimal-beige-light-mode` 시스템: 따뜻한 크림/베이지 바탕, 부드러운 라운드 카드, 낮은 대비의 정갈한 구조.
- 포인트 컬러: 피치(수유), 세이지(기저귀), 앰버(체온) — 파스텔 저채도.
- 폰트: Pretendard(로컬 번들, 웹폰트 의존 없음 = 오프라인 완전 동작).
- 아이콘: lucide-react. 애니메이션 최소·부드럽게. frontend-design 스킬 기준 적용.

## 7. 디렉토리 구조

```
/ (D:\BABY DIARY MAC)
├─ electron/        # main process: 창, IPC, 데이터 스토어, 백업 스케줄러
│  ├─ main.ts  preload.ts
│  └─ store/       # eventLog.ts(JSONL), backup.ts, settings.ts
├─ src/            # renderer
│  ├─ pages/  components/  lib/  store/
│  └─ sync/        # firebase.ts, syncEngine.ts (renderer 측)
├─ shared/types.ts # Event 타입 공유
├─ tests/          # 데이터 계층 단위 테스트 (vitest) — 유실 방지 로직 집중
└─ .github/workflows/build.yml  # win+mac 빌드
```

## 8. 구현 단계

- P1 스캐폴드 + 데이터 계층 + 테스트 (sonnet)
- P2 UI 전체 (sonnet, 디자인 스킬 로드) ∥ 동기화 모듈 (sonnet, firebase 스킬 로드)
- P3 통합 + 전체 테스트 (sonnet)
- P4 데이터 계층·동기화 적대적 리뷰 (opus) → 수정
- P5 실행 검증 + 스크린샷 확인
- P6 Firebase 프로젝트 연결(사용자 로그인 필요 — 안내), Mac 빌드 워크플로

## 9. Mac 전환 절차 (추후)

1. GitHub 리포 push → Actions가 mac dmg 자동 빌드 (또는 엄마 맥에서 `npm run build:mac`)
2. 서명 없음 → 첫 실행 시 우클릭-열기 (가족용 무료 배포 표준 방식)
3. 데이터 경로는 Electron userData 자동 분기 — 코드 수정 불필요

## 설계 결정

### TZ-1: 날짜 그룹화 — 디바이스 로컬 시간 사용 (P23)

- **현재 동작**: 모든 날짜 그룹화가 date-fns (`isToday`, `isSameDay`, `startOfDay`, `parseISO`)를 통해 디바이스 로컬 시간으로 수행된다.
- **이 가족에게 일관성 보장**: 아빠(Windows, KST = UTC+9)와 엄마(Mac, JST = UTC+9)가 모두 UTC+9를 사용하며 DST(일광 절약 시간)가 없다. 따라서 두 디바이스에서의 날짜 경계가 항상 일치한다.
- **향후 변경 시**: 가족이 다른 타임존으로 이사하거나 타임존이 다른 새 멤버가 합류할 경우, `DiaryEvent`에 `localDate: string` (YYYY-MM-DD, 기록 시점의 로컬 날짜) 필드를 추가하고 이 필드 기준으로 그룹화하도록 변경할 것.
- **관련 코드**: `src/store/useAppStore.ts` (todayEvents, eventsForDay), `src/pages/HistoryPage.tsx` (useDayIndicators)
