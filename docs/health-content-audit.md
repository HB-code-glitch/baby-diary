# 건강·발달 콘텐츠 감사 원장

- 검토일: 2026-07-13
- 적용 범위: `src`, `electron`, `shared`의 사용자 노출 건강·발달 문구와 근거 참조
- 판정 기준: WHO, CDC, NIH/NICHD/NIAID, AAP, NICE, KDCA, 일본 こども家庭庁·厚生労働省, 한국·일본 소방당국의 공식 자료
- 결정 원칙: 진단·처방처럼 읽히는 단정은 제거하고, 기록 요약·일반 안내·문화 기념일을 구분한다.

## 유지한 주제와 결정

| 유지한 주장·주제 | 앱 위치 | 결정 | 공식 소스 ID와 URL |
|---|---|---|---|
| 반응적 수유와 수유 기록 | `src/lib/breastfeeding.ts`, `src/components/FeedingTipPopup.tsx`, 설정의 수유 안내 | 고정 다음 수유 시각·남은 허용량·월령별 쿼터는 사용하지 않는다. 기록값과 배고픔·포만 신호만 안내한다. | [`who-infant-feeding`](https://www.who.int/news-room/fact-sheets/detail/infant-and-young-child-feeding), [`cdc-breastfeeding-frequency`](https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/how-much-and-how-often.html), [`cdc-formula-feeding`](https://www.cdc.gov/infant-toddler-nutrition/formula-feeding/how-much-and-how-often.html), [`cdc-hunger-fullness-cues`](https://www.cdc.gov/infant-toddler-nutrition/mealtime/signs-your-child-is-hungry-or-full.html) |
| 보완식·철분·비타민 D·알레르기·질식 안전 | `src/lib/ageGuidance.ts`의 월령별 영양 카드 | 약 6개월과 준비 신호, 국가별 보충제 맥락, 안전한 형태와 상담 조건을 보존한다. 효과 백분율 마케팅과 보편적 용량 처방은 제외한다. | [`who-complementary-feeding`](https://www.who.int/publications/i/item/9789240081864), [`cdc-complementary-foods`](https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/when-what-and-how-to-introduce-solid-foods.html), [`cdc-iron`](https://www.cdc.gov/infant-toddler-nutrition/vitamins-minerals/iron.html), [`cdc-vitamin-d`](https://www.cdc.gov/infant-toddler-nutrition/vitamins-minerals/vitamin-d.html), [`cdc-choking`](https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/choking-hazards.html), [`niaid-peanut-allergy`](https://www.niaid.nih.gov/sites/default/files/peanut-allergy-prevention-guidelines-parent-summary.pdf), [`kdca-infant-nutrition`](https://health.kdca.go.kr/healthinfo/biz/health/gnrlzHealthInfo/gnrlzHealthInfo/gnrlzHealthInfoView.do?cntnts_sn=5212), [`cfa-infant-nutrition`](https://www.cfa.go.jp/policies/boshihoken/eiyou/), [`cfa-one-month-checkup`](https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/d4a9b67b-acbd-4e2a-a27a-7e8f2d6106dd/d1e17788/20250107_policies_boshihoken_tsuuchi_2024_113.pdf) |
| 안전 수면 | `src/lib/ageGuidance.ts`의 영아 수면 카드 | 모든 잠을 바로 눕혀 시작하고, 양방향 뒤집기·속싸개 중단·비어 있는 평평한 수면면 조건을 유지한다. | [`aap-safe-sleep-2022`](https://publications.aap.org/pediatrics/article/150/1/e2022057990/188304/Sleep-Related-Infant-Deaths-Updated-2022), [`nichd-safe-sleep`](https://safetosleep.nichd.nih.gov/reduce-risk/FAQ), [`cfa-safe-sleep`](https://www.cfa.go.jp/policies/boshihoken/kenkou/sids) |
| 발열·저체온·응급 위험 신호 | `src/lib/guidance.ts`, `src/lib/ageGuidance.ts`, `src/components/FeverModal.tsx` | 월령과 전신 상태를 함께 보고 측정 부위를 단정하지 않는다. 미온수 닦기와 오래된 24시간/3일 규칙은 제외한다. | [`aap-fever-baby`](https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/Fever-and-Your-Baby.aspx), [`nice-fever-ng143`](https://www.nice.org.uk/guidance/ng143/chapter/recommendations), [`nice-newborn-red-flags-ng194`](https://www.nice.org.uk/guidance/ng194/chapter/recommendations) |
| 체온 기록 통계 | `src/pages/StatsPage.tsx` | 설명 없는 37.5°C 기준선을 제거했다. 일별 평균은 기록 요약이며 아이 나이와 측정 부위·방법에 따라 해석이 달라짐을 표시한다. | [`aap-fever-baby`](https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/Fever-and-Your-Baby.aspx), [`nice-fever-ng143`](https://www.nice.org.uk/guidance/ng143/chapter/recommendations) |
| 검진 리포트의 체온 값 | `src/lib/reportModel.ts`, `src/report/ReportView.tsx` | 내부 `feverCount` 필드는 호환성을 위해 유지하되, 화면에는 “38°C 이상 기록값”으로 표시한다. 이는 발열 횟수나 진단이 아니며 나이·측정 부위를 함께 확인한다. | [`aap-fever-baby`](https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/Fever-and-Your-Baby.aspx), [`nice-fever-ng143`](https://www.nice.org.uk/guidance/ng143/chapter/recommendations) |
| WHO 성장 차트와 근사 백분위 | `src/lib/whoGrowth.ts`, `src/lib/whoGrowthData.ts`, `src/pages/StatsPage.tsx`, `src/lib/reportModel.ts`, `src/report/ReportView.tsx` | 앱이 제공하는 0~24개월 범위를 명시한다. 백분위는 WHO 차트의 근사 참고값이며, 한 번의 값보다 같은 방법으로 측정한 추세와 측정 오차를 함께 본다. | [`who-child-growth-standards`](https://www.who.int/tools/child-growth-standards) |
| 발달 관찰과 선별검사 연결 | `src/lib/ageGuidance.ts`의 2~60개월 체크포인트 | 이정표를 진단이나 합격표로 쓰지 않는다. 기술 소실·미도달·보호자 우려를 의료진 상담과 표준화 선별검사로 연결한다. | [`cdc-developmental-milestones`](https://www.cdc.gov/act-early/milestones/index.html), [`cdc-developmental-screening`](https://www.cdc.gov/act-early/about/developmental-monitoring-and-screening.html) |
| 5세 미만 활동·수면·화면 일반 범위 | `src/lib/ageGuidance.ts` | 연령 범위와 낮잠 포함 여부를 보존하고 목표 점수나 5세 이후 자동 연장으로 표현하지 않는다. | [`who-under-five-activity`](https://www.who.int/publications/i/item/9789241550536) |
| 구강관리·식생활·사고 예방 | `src/lib/ageGuidance.ts` | 지역 지침 확인, 보호자 감독, 안전 행동을 유지한다. | [`cdc-child-oral-health`](https://www.cdc.gov/oral-health/prevention/oral-health-tips-for-children.html), [`who-healthy-diet`](https://www.who.int/news-room/fact-sheets/detail/healthy-diet), [`cdc-picky-eaters`](https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/picky-eaters.html), [`cfa-accident-prevention`](https://www.cfa.go.jp/policies/child-safety-actions/handbook) |
| 국가별 검진·예방접종·응급 연결 | `src/lib/ageGuidance.ts`의 한국/일본 카드 | 앱에 접종 일정을 하드코딩하지 않고 국가 공식 페이지로 연결한다. 긴급 행동은 한국·일본 모두 119로 지역화한다. | [`kdca-infant-checkups`](https://health.kdca.go.kr/healthinfo/biz/health/ntcnInfo/healthSourc/thtimtCntnts/thtimtCntntsView.do?thtimt_cntnts_sn=131), [`kdca-vaccination`](https://nip.kdca.go.kr/irhp/infm/goVcntInfo.do?menuCd=131&menuLv=1), [`cfa-infant-checkups`](https://www.cfa.go.jp/policies/boshihoken/nyuyojikenshin), [`mhlw-vaccination`](https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/kenkou/kekkaku-kansenshou/yobou-sesshu/index.html), [`kr-nfa-119`](https://nfa.go.kr/nfa/safetyinfo/emergencyservice/119emergencydeclaration), [`jp-fdma-119`](https://www.fdma.go.jp/mission/enrichment/kyukyumusen_kinkyutuhou/119.html) |
| 16시간 수면 타이머 | `src/pages/HomePage.tsx`, `src/i18n/ko.json`, `src/i18n/ja.json` | 의료 기준이 아니라 제품 안전장치다. 16시간을 넘긴 미완료 타이머만 저장하지 않고 종료하며, 이미 저장된 기록은 삭제하지 않는다고 명시한다. | 해당 없음 — 제품 동작 설명 |
| 문화 기념일 | `src/lib/milestones.ts` | 삼칠일·오미야마이리·하프 버스데이·시치고산은 전통·기념·축하 행사로만 설명한다. 건강·성장 효능을 주장하지 않는다. | 해당 없음 — 문화 설명 |

## 제거·중립화한 항목

- 설명 없는 체온 차트 37.5°C 선
- “열/발열 횟수”로 해석되던 리포트의 38°C 이상 기록 카운트
- “또래 100명 중 정확히 몇 번째”라는 백분위 서열 표현
- 현재 언어와 무관하게 반복되던 영어 PDF 면책 문구와 한·일 drift
- 저장된 수면 기록이 자동 삭제된다고 오해시키는 16시간 문구
- 소비자가 없는 이전 `guidance` 달력/배너/분유량/짧은 면책 i18n 키

## 회귀 방지와 한계

- `tests/healthContentAudit.test.ts`가 한·일 키/자리표시자 동등성, 금지 도메인, 미온수 닦기·고정 수유 쿼터·오래된 발열 기간·효과 백분율 마케팅, Stats/Report 문구, WHO 소스 ID와 이 원장을 검사한다.
- 성장 LMS 계산과 0~24개월 범위는 기존 `tests/whoGrowth.test.ts`와 `tests/reportModel.test.ts`를 유지한다. 이번 감사는 사용자 해석 문구와 소스 추적성을 다뤘으며, 표의 모든 수치를 WHO 원본 파일과 행별 재대조하지는 않았다.
- 예방접종 일정과 머리둘레 차트는 추가하지 않았다. 동기화 이벤트와 프로필 저장 스키마도 변경하지 않았다.
- Task 3도 `src/i18n/ko.json`, `src/i18n/ja.json`을 수정할 수 있으므로 통합 시 이 파일은 키 단위로 병합해야 한다. Task 4의 `tempContextNote`, `temperatureContext`, 성장·수면 문구와 dead-key 제거를 보존한다.
