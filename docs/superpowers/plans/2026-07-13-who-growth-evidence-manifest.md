# WHO 성장 데이터 근거 고정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱의 0~24개월 남녀 WFA/LHFA 100개 LMS 행이 2026-07-13에 확인한 공식 WHO Excel과 정확히 일치함을 저장소 내부 manifest와 오프라인 테스트로 고정하고, 현재 WHO/CDC 건강 문구의 출처 연결성과 한·일 동등성을 감사한다.

**Architecture:** 공식 Excel의 첫 시트 `Month`, `L`, `M`, `S` 열에서 0~24개월만 추출한 정규화 JSON을 불변 검증 기준으로 둔다. Vitest는 네 데이터 배열을 이 기준과 엄격 비교하고, manifest의 WHO 원본 URL·SHA-256·행 수를 검증한다. 공식 사이트 온라인 확인 결과와 문구 대조 결과는 날짜가 있는 감사 문서에 남기며, 출처와 어긋난 문구가 있을 때만 `src/lib/ageGuidance.ts`의 한국어·일본어 쌍을 함께 최소 수정한다.

**Tech Stack:** TypeScript, Vitest, JSON manifest, Markdown

## Global Constraints

- 검토 기준일은 `2026-07-13`이다.
- 공식 WHO/CDC 1차 출처만 근거로 사용한다.
- 한국어와 일본어 의미 및 action 수 동등성을 유지한다.
- macOS/Windows 공용 React/TypeScript 실행 경로와 데이터 스키마를 변경하지 않는다.
- `src/i18n/ko.json`, `src/i18n/ja.json`, settings/security/sync 관련 현재 사용자 변경은 수정·스테이징하지 않는다.
- 진단이 아님과 우려 시 의료진 상담 안전 문구를 유지한다.

---

### Task 1: 공식 WHO manifest와 100행 회귀 테스트

**Files:**
- Create: `tests/whoGrowthOfficialData.test.ts`
- Create: `tests/fixtures/who-growth-standards.manifest.json`
- Create: `docs/who-growth-data-provenance.md`

**Interfaces:**
- Consumes: `WFA_BOYS`, `WFA_GIRLS`, `LHFA_BOYS`, `LHFA_GIRLS` from `src/lib/whoGrowthData.ts`
- Produces: 네 공식 원본의 `pageUrl`, `downloadUrl`, `sha256`, `months`, `rows`를 가진 JSON manifest

- [ ] **Step 1: manifest 부재를 드러내는 실패 테스트 작성**

```ts
expect(existsSync(manifestPath)).toBe(true)
```

- [ ] **Step 2: RED 확인**

Run: `npx vitest run tests/whoGrowthOfficialData.test.ts`
Expected: FAIL because `tests/fixtures/who-growth-standards.manifest.json` is absent.

- [ ] **Step 3: 공식 URL과 SHA-256 메타데이터를 최소 구현**

```json
{
  "reviewedOn": "2026-07-13",
  "sources": {
    "WFA_BOYS": {
      "pageUrl": "https://www.who.int/tools/child-growth-standards/standards/weight-for-age",
      "downloadUrl": "https://cdn.who.int/.../wfa_boys_0-to-5-years_zscores.xlsx?sfvrsn=97a05331_9",
      "sha256": "f8f5a77b944ff7a8c1524e76f9d33f8a93cc423d23c2e7f2b10ba6b96a428e69",
      "months": [0, 24],
      "rows": []
    }
  }
}
```

- [ ] **Step 4: 메타데이터 테스트 GREEN 확인**

Run: `npx vitest run tests/whoGrowthOfficialData.test.ts`
Expected: PASS for the manifest presence/metadata test.

- [ ] **Step 5: 100행 엄격 비교 실패 테스트 추가**

```ts
expect(Object.values(manifest.sources).flatMap(source => source.rows)).toHaveLength(100)
expect(actual).toEqual(source.rows)
```

- [ ] **Step 6: RED 확인**

Run: `npx vitest run tests/whoGrowthOfficialData.test.ts`
Expected: FAIL because the four `rows` arrays do not yet contain 25 rows each.

- [ ] **Step 7: Excel에서 독립 추출해 확인한 100행 LMS 값을 manifest에 추가**

각 행은 다음 고정 형식만 사용한다.

```json
{ "month": 0, "L": 0.3487, "M": 3.3464, "S": 0.14602 }
```

- [ ] **Step 8: 오프라인 회귀 테스트 GREEN 확인**

Run: `npx vitest run tests/whoGrowthOfficialData.test.ts`
Expected: PASS with exactly 4 series, 25 rows per series, 100 total rows, and exact deep equality.

- [ ] **Step 9: 재검증 절차 문서화**

`docs/who-growth-data-provenance.md`에 공식 페이지/다운로드 URL, 네 SHA-256, 첫 시트 `Month/L/M/S`의 0~24개월 추출 규칙, PowerShell `Get-FileHash`, 오프라인 Vitest 명령을 기록한다.

### Task 2: WHO/CDC 건강 문구 및 이중 언어 감사

**Files:**
- Create: `docs/health-guidance-who-cdc-audit-2026-07-13.md`
- Modify only if evidence mismatch is found: `src/lib/ageGuidance.ts`
- Test only if a correction is required: `tests/ageGuidance.test.ts`

**Interfaces:**
- Consumes: `AGE_GUIDANCE_ITEMS`, `DEVELOPMENT_CHECKPOINTS`, `HEALTH_EVIDENCE_SOURCES`, main-process official URL registry
- Produces: 각 WHO/CDC 주제, source ID, 공식 URL, 검토 결과를 연결한 감사 기록

- [ ] **Step 1: 공식 WHO/CDC URL과 현재 source ID 연결을 대조**

WHO 성장·수유·보충식·5세 미만 활동·건강식, CDC 수유·영양·식품 안전·구강 건강·발달 이정표·선별검사 URL이 공식 도메인과 현재 페이지로 응답하는지 확인한다.

- [ ] **Step 2: CDC 2/4/6/9/12/15/18/24/30/36/48/60개월 체크포인트와 앱 문구를 대조**

검토 시 `아직 못 함/기술 손실/보호자 우려 → 기다리지 말고 의료진과 상의`, `진단 아님` 문구를 보존한다.

- [ ] **Step 3: WHO 연령별 수유·보충식·활동/수면 범위와 앱 문구를 대조**

정확한 횟수·시간이 공식 범위와 다를 때만 수정하며, 목표 점수나 개인 진단으로 표현하지 않는다.

- [ ] **Step 4: 오류가 발견되면 먼저 한·일 동등성 실패 테스트 작성 및 RED 확인**

```ts
expect(item.actionsKo).toHaveLength(item.actionsJa.length)
expect(item.sourceIds).toContain(expectedOfficialSourceId)
```

- [ ] **Step 5: 필요한 한국어·일본어 문구만 함께 최소 수정 후 GREEN 확인**

Run: `npx vitest run tests/ageGuidance.test.ts tests/healthEvidence.test.ts`
Expected: PASS.

- [ ] **Step 6: 감사 문서에 유지/수정/제외 결정을 기록**

출처와 맞는 기존 문구는 `유지`, 근거 불일치는 `수정`, 앱이 진단하지 않는 경계는 `안전 문구 유지`로 기록한다.

### Task 3: 전체 검증과 선택적 커밋

**Files:**
- Verify only the scoped files above

**Interfaces:**
- Consumes: Tasks 1–2 outputs
- Produces: 테스트·타입체크·diff check 근거와 범위 제한 커밋

- [ ] **Step 1: 관련 테스트 실행**

Run: `npx vitest run tests/whoGrowthOfficialData.test.ts tests/whoGrowth.test.ts tests/ageGuidance.test.ts tests/healthEvidence.test.ts tests/healthContentAudit.test.ts`
Expected: PASS with zero failures.

- [ ] **Step 2: 타입체크 실행**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: 전체 테스트 실행**

Run: `npm test`
Expected: exit 0.

- [ ] **Step 4: 변경 범위와 공백 오류 검사**

Run: `git diff --check` and `git status --short`
Expected: no whitespace errors; no scoped edits to dirty settings/security/sync/i18n files.

- [ ] **Step 5: scoped files만 스테이징하고 diff self-review**

Run: `git diff --cached --stat` and `git diff --cached`
Expected: only WHO manifest/tests/docs, audit doc, and any evidence-proven ageGuidance correction.

- [ ] **Step 6: 커밋**

```bash
git commit -m "test: pin WHO growth evidence"
```
