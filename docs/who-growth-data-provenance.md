# WHO 성장표 데이터 출처와 재현 절차

검토일: 2026-07-13

권위 기관: World Health Organization (WHO)

`src/lib/whoGrowthData.ts`의 0–24개월 체중-연령(WFA) 및 신장/길이-연령(LHFA) LMS 값은 아래 WHO 공식 Excel 원본의 첫 워크시트에서 추출했다. 저장소에는 원본 바이너리를 복제하지 않고, 원본 URL·SHA-256·워크시트 이름·정규화한 100개 행을 [`tests/fixtures/who-growth-standards.manifest.json`](../tests/fixtures/who-growth-standards.manifest.json)에 고정한다.

## 공식 원본

| 시리즈 | WHO 안내 페이지 | 공식 Excel 원본 | SHA-256 |
| --- | --- | --- | --- |
| WFA 남아 | [Weight-for-age](https://www.who.int/tools/child-growth-standards/standards/weight-for-age) | [wfa_boys_0-to-5-years_zscores.xlsx](https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/wfa_boys_0-to-5-years_zscores.xlsx?sfvrsn=97a05331_9) | `f8f5a77b944ff7a8c1524e76f9d33f8a93cc423d23c2e7f2b10ba6b96a428e69` |
| WFA 여아 | [Weight-for-age](https://www.who.int/tools/child-growth-standards/standards/weight-for-age) | [wfa_girls_0-to-5-years_zscores.xlsx](https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/wfa_girls_0-to-5-years_zscores.xlsx?sfvrsn=4c03b8db_7) | `01e9a6fda2f3723dbc74d3c86bfbfcb9f6d474367d1d7b4a804501a2debd2ef1` |
| LHFA 남아 | [Length/height-for-age](https://www.who.int/tools/child-growth-standards/standards/length-height-for-age) | [lhfa_boys_0-to-2-years_zscores.xlsx](https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/lhfa_boys_0-to-2-years_zscores.xlsx?sfvrsn=30e044c_9) | `ccfd8e455141c9a39dd728d99b7d7e080a925b06ea4a4d7592229665713dba54` |
| LHFA 여아 | [Length/height-for-age](https://www.who.int/tools/child-growth-standards/standards/length-height-for-age) | [lhfa_girls_0-to-2-years_zscores.xlsx](https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/lhfa_girls_0-to-2-years_zscores.xlsx?sfvrsn=e9e66a95_11) | `6757f5eb96b51ab5cdb4828105929c78b1fb3d73b0fd8fa65682ad9f60f8c083` |

2026-07-13 검토에서는 위 URL에서 새로 받은 각 파일의 해시가 같은 날 제공된 로컬 공식 사본의 해시 및 매니페스트 값과 모두 일치했다.

## 정규화 규칙

- 각 Excel 파일의 첫 워크시트만 사용한다.
- 열은 `Month`, `L`, `M`, `S`만 읽는다.
- 완료 월령 `0`부터 `24`까지를 포함해 시리즈별 25행, 총 100행을 보존한다.
- Excel 셀의 숫자를 반올림하거나 허용 오차를 적용하지 않고 JSON 숫자로 직렬화한다.
- 워크시트 이름, 추출 범위와 예상 행 수는 매니페스트 메타데이터에도 함께 고정한다.

기존 `whoGrowthData.ts`의 네 배열은 공식 원본 100행과 이미 정확히 일치했으므로 제품 숫자는 수정하지 않았다. [`tests/whoGrowthOfficialData.test.ts`](../tests/whoGrowthOfficialData.test.ts)는 네 배열을 매니페스트 행과 `toEqual`로 엄격 비교하며, 월령 연속성과 총 행 수도 오프라인에서 확인한다.

## 재현 방법

공식 파일을 내려받은 뒤 PowerShell에서 해시를 확인한다.

```powershell
Get-FileHash -Algorithm SHA256 .\wfa_boys_0-to-5-years_zscores.xlsx
Get-FileHash -Algorithm SHA256 .\wfa_girls_0-to-5-years_zscores.xlsx
Get-FileHash -Algorithm SHA256 .\lhfa_boys_0-to-2-years_zscores.xlsx
Get-FileHash -Algorithm SHA256 .\lhfa_girls_0-to-2-years_zscores.xlsx
```

macOS/Linux에서는 같은 파일에 `shasum -a 256 <파일>`을 사용할 수 있다. 저장소 루트에서 오프라인 데이터 비교를 실행한다.

```powershell
npx vitest run tests/whoGrowthOfficialData.test.ts
```

공식 파일이 바뀌는 경우에는 URL과 새 해시만 바꾸지 않는다. 먼저 WHO 안내 페이지에서 변경 사실을 확인하고, 100개 LMS 행을 다시 추출·검토한 뒤 매니페스트, 제품 배열, 이 문서를 하나의 변경으로 갱신한다.
