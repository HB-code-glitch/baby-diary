# WHO/CDC 건강 안내 문구 감사 — 2026-07-13

## 범위와 결론

`src/lib/ageGuidance.ts`에서 WHO 또는 미국 CDC 출처 ID를 연결한 보호자용 건강·발달 문구를 2026-07-13 현재 공식 1차 자료와 대조했다. 연령, 횟수, 시간, 선별검사 시점처럼 오해 위험이 큰 구체 주장과 그 주변의 안전 문구를 우선 확인했다.

감사 결과, 공식 자료와 어긋나는 보호자용 주장을 찾지 못했다. 따라서 최소 수정 원칙에 따라 `ageGuidance.ts`의 문구와 숫자는 변경하지 않았다. 이 감사가 일반 의료 조언을 새로 추가하지 않으며, 앱의 “진단이 아님”, “걱정되거나 하던 기술을 잃으면 의료진과 상의”라는 안전 경계도 그대로 유지한다.

이 문서는 WHO/CDC가 근거인 문구만 다룬다. NICE, AAP, KDCA, CFA, NIAID 등 다른 기관 출처의 재감사는 이번 범위가 아니며 관련 문구를 변경하지 않았다.

## WHO 확인 결과

| 출처 ID | 공식 자료 | 확인한 핵심 주장 | 결과 |
| --- | --- | --- | --- |
| `who-infant-feeding` | [Infant and young child feeding](https://www.who.int/news-room/fact-sheets/detail/infant-and-young-child-feeding) | 수유는 아기 신호에 맞추고, 보완식은 약 6개월부터 시작하며 6–8개월은 하루 2–3회, 9–23개월은 3–4회와 필요 시 간식을 제공한다는 기준 | 일치 |
| `who-complementary-feeding` | [WHO guideline for complementary feeding](https://www.who.int/publications/i/item/9789240081864) | 약 6개월부터 연령에 맞는 안전하고 다양한 보완식, 반응적 수유 | 일치 |
| `who-under-five-activity` | [Guidelines on physical activity, sedentary behaviour and sleep for children under 5 years](https://www.who.int/publications/i/item/9789241550536) | 영아 활동·엎드려 놀기·화면·수면, 1–4세 활동·화면·수면 시간 | 일치 |
| `who-child-growth-standards` | [WHO Child Growth Standards](https://www.who.int/tools/child-growth-standards) | 0–24개월 WFA/LHFA LMS 성장 기준 | 일치; 별도 [원본·해시 문서](./who-growth-data-provenance.md)와 오프라인 100행 테스트로 고정 |
| `who-healthy-diet` | [Healthy diet](https://www.who.int/news-room/fact-sheets/detail/healthy-diet) | 다양한 식품과 균형 있는 식사, 자유당·소금 제한 방향 | 일치 |

활동·수면 숫자는 WHO 원문 PDF의 권고 표도 함께 확인했다.

- 아직 이동하지 못하는 영아: 깨어 있는 동안 여러 차례 활동하고 엎드려 놀기 총 30분 이상, 한 번에 1시간 넘는 구속을 피하고 화면은 권하지 않음.
- 수면: 0–3개월 14–17시간, 4–11개월 12–16시간, 1–2세 11–14시간, 3–4세 10–13시간.
- 1–2세: 하루 여러 강도의 신체활동 총 180분 이상. 1세 화면은 권하지 않고, 2세는 1시간 이하이며 적을수록 좋음.
- 3–4세: 하루 총 180분 이상이며 이 중 중·고강도 활동 60분 이상, 화면은 1시간 이하이며 적을수록 좋음.

## CDC 영양·구강 건강 확인 결과

| 출처 ID | 공식 자료 | 확인한 핵심 주장 | 결과 |
| --- | --- | --- | --- |
| `cdc-breastfeeding-frequency` | [How Much and How Often to Breastfeed](https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/how-much-and-how-often.html) | 초기 수유 빈도와 아기 신호 중심 안내 | 일치 |
| `cdc-formula-feeding` | [How Much and How Often to Feed Infant Formula](https://www.cdc.gov/infant-toddler-nutrition/formula-feeding/how-much-and-how-often.html) | 분유 수유량·빈도는 아기 신호와 성장에 따라 달라짐 | 일치 |
| `cdc-hunger-fullness-cues` | [Signs Your Child Is Hungry or Full](https://www.cdc.gov/infant-toddler-nutrition/mealtime/signs-your-child-is-hungry-or-full.html) | 배고픔·포만 신호에 반응하고 먹는 양을 강요하지 않음 | 일치 |
| `cdc-complementary-foods` | [When, What, and How to Introduce Solid Foods](https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/when-what-and-how-to-introduce-solid-foods.html) | 약 6개월, 준비 신호 확인, 4개월 전 고형식 시작은 권하지 않음 | 일치 |
| `cdc-iron` | [Iron](https://www.cdc.gov/infant-toddler-nutrition/vitamins-minerals/iron.html) | 약 6개월부터 철 공급원 고려, 더 이른 보충은 의료진과 상의 | 일치 |
| `cdc-vitamin-d` | [Vitamin D](https://www.cdc.gov/infant-toddler-nutrition/vitamins-minerals/vitamin-d.html) | 모유 수유 또는 혼합 수유 영아의 비타민 D를 의료진·지역 지침과 확인 | 일치; 앱은 용량을 일반화하지 않는 보수적 표현 유지 |
| `cdc-choking` | [Choking Hazards](https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/choking-hazards.html) | 앉은 자세에서 관찰하며 먹이고 크기·모양·질감을 발달에 맞게 조정 | 일치 |
| `cdc-foods-to-avoid` | [Foods and Drinks to Avoid or Limit](https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/foods-and-drinks-to-avoid-or-limit.html) | 12개월 전 꿀·주음료로서 우유·주스 제한, 비살균 식품 회피, 24개월 전 첨가당 회피 | 일치 |
| `cdc-child-oral-health` | [Oral Health Tips for Children](https://www.cdc.gov/oral-health/prevention/oral-health-tips-for-children.html) | 첫 치아부터 양치, 첫돌까지 치과 방문, 불소 사용은 전문 지침 확인 | 일치 |
| `cdc-picky-eaters` | [Picky Eaters and What to Do](https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/picky-eaters.html) | 새 음식을 반복 노출하고 선택권을 주되 억지로 먹이지 않음 | 일치 |

## CDC 발달 이정표·선별검사 확인 결과

`cdc-developmental-milestones`는 [CDC Milestones by 2 Months through 5 Years](https://www.cdc.gov/act-early/milestones/index.html) 인덱스로 연결된다. 인덱스에서 아래 현재 연령별 공식 페이지를 따라가 앱 체크포인트를 각각 대조했다.

| 앱 월령 | CDC 공식 페이지 | 앱에서 선택해 요약한 항목 | 결과 |
| --- | --- | --- | --- |
| 2개월 | [2 Months](https://www.cdc.gov/act-early/milestones/2-months.html) | 얼굴 반응, 울음 외 소리, 엎드려 머리 들기 | 일치 |
| 4개월 | [4 Months](https://www.cdc.gov/act-early/milestones/4-months.html) | 관심을 끄는 미소, 소리 주고받기, 머리 가누기, 손을 입으로 가져가기 | 일치 |
| 6개월 | [6 Months](https://www.cdc.gov/act-early/milestones/6-months.html) | 익숙한 사람, 웃음·소리, 뒤집기, 앉을 때 손 지지 | 일치 |
| 9개월 | [9 Months](https://www.cdc.gov/act-early/milestones/9-months.html) | 이름 반응, 표정, 혼자 앉기, 양손 사이 물건 옮기기 | 일치 |
| 12개월 | [1 Year](https://www.cdc.gov/act-early/milestones/1-year.html) | 함께하는 놀이, 손 흔들기, 의미 있는 호칭, 붙잡고 일어서기 | 일치 |
| 15개월 | [15 Months](https://www.cdc.gov/act-early/milestones/15-months.html) | 물건 보여주기, 도움을 위한 가리키기, 몇 걸음, 1–2단어 | 일치 |
| 18개월 | [18 Months](https://www.cdc.gov/act-early/milestones/18-months.html) | 흥미 공유 가리키기, 한 단계 지시, 독립 보행 | 일치 |
| 24개월 | [2 Years](https://www.cdc.gov/act-early/milestones/2-years.html) | 두 단어 연결, 타인 감정 알아차리기, 달리기, 계단 걷기 | 일치 |
| 30개월 | [30 Months](https://www.cdc.gov/act-early/milestones/30-months.html) | 또래 옆·함께 놀기, 약 50단어, 두 단어 이상 연결, 두 발 뛰기 | 일치 |
| 36개월 | [3 Years](https://www.cdc.gov/act-early/milestones/3-years.html) | 놀이 참여, 대화 주고받기, 질문, 원 그리기 | 일치 |
| 48개월 | [4 Years](https://www.cdc.gov/act-early/milestones/4-years.html) | 역할놀이, 네 단어 이상 문장·경험 말하기, 큰 공 받기, 단추 풀기 | 일치 |
| 60개월 | [5 Years](https://www.cdc.gov/act-early/milestones/5-years.html) | 규칙·차례, 두 사건 이상 이야기, 한 발 뛰기 | 일치 |

`cdc-developmental-screening`은 [Developmental Monitoring and Screening](https://www.cdc.gov/act-early/about/developmental-monitoring-and-screening.html)과 대조했다. 앱의 표준 발달 선별검사 9·18·30개월 및 자폐 선별검사 18·24개월 표시는 공식 안내와 일치한다. CDC도 이정표 자료가 검증된 선별도구나 진단을 대신하지 않으며, 이정표 누락·기술 소실·보호자 우려가 있으면 의료진과 상의하도록 안내한다.

## 한·일 패리티와 안전 경계

- 각 항목의 `actionsKo`와 `actionsJa` 개수 및 비어 있지 않은 대응 문구는 기존 테스트가 검증한다.
- 출처 ID와 선별검사 시점은 언어와 무관한 공통 구조라 두 언어에 동일하게 적용된다.
- 발달 체크포인트의 한국어·일본어 모두 “진단표가 아님” 또는 의료진 상담 경계를 유지한다.
- 이번 감사에서 한국어·일본어 문자열 파일을 변경하지 않았으며, 제품 문구도 어느 한 언어만 수정하지 않았다.

## 검증

다음 테스트가 WHO 매니페스트, 건강 근거 ID, 연령 안내 구조, 한·일 패리티와 안전 문구를 확인한다.

```powershell
npx vitest run tests/whoGrowthOfficialData.test.ts tests/whoGrowth.test.ts tests/ageGuidance.test.ts tests/healthEvidence.test.ts tests/healthContentAudit.test.ts
```

이번 변경은 정적 TypeScript/JSON 테스트와 문서만 추가한다. Electron 런타임, 저장 형식, 동기화, 운영체제 경로 또는 UI/i18n 파일에는 손대지 않았다.
