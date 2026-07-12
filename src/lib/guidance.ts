/**
 * src/lib/guidance.ts
 * Evidence-based infant care guidance — research-verified dataset.
 * Sources: WHO, AAP, 厚生労働省, 질병관리청, NEJM (LEAP), Lancet (PETIT), et al.
 *
 * startDay = age in days from birth (0 = birth date / day of discharge).
 * Day-0 items are permanent safety references; startDay > 0 items appear on the calendar.
 */

import { addDays, format, parseISO } from 'date-fns'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuidanceMarker {
  id: string
  startDay: number
  titleKo: string
  titleJa: string
  bodyKo: string
  bodyJa: string
  /** Optional verbatim first-sentence quote for UI display (avoids fragile sentence-splitting). */
  quoteKo?: string
  /** Optional verbatim first-sentence quote in Japanese for UI display. */
  quoteJa?: string
  sourceLabel: string
  evidenceLevel: 'guideline-consensus' | 'RCT'
}

/** Legacy alias for backwards-compat with HistoryPage/SettingsPage.
 * Maps the new shape onto the old GuidanceItem shape fields.
 */
export interface GuidanceItem {
  id: string
  startDay: number
  titleKo: string
  titleJa: string
  bodyKo: string
  bodyJa: string
  /** Combined source string — mapped from sourceLabel */
  source: string
  /** If true, shown in Settings guide section and on birth-date day view, not on calendar */
  pinToSettings: boolean
}

export interface GuidanceDisclaimer {
  ko: string
  ja: string
}

export interface GuidanceSource {
  org: string
  title: string
  year: string
  url: string
}

// ---------------------------------------------------------------------------
// Dataset — 13 research-verified markers
// ---------------------------------------------------------------------------

export const GUIDANCE_MARKERS: GuidanceMarker[] = [
  {
    id: 'safe_sleep_supine',
    startDay: 0,
    titleKo: '등 대고 재우기 (SIDS 예방)',
    titleJa: 'あおむけ寝でSIDS予防',
    bodyKo: '생후 12개월까지 모든 낮잠·밤잠에 등을 대고 똑바로 눕혀 재워요. 엎드려 재우면 영아돌연사증후군(SIDS) 위험이 앙와위 대비 2.3~13.1배 높아져요. 스스로 뒤집게 되어도 처음엔 항상 등을 대고 눕히되, 자다가 뒤집은 건 되돌리지 않아도 돼요.',
    bodyJa: '生後12か月まで、お昼寝も夜も必ずあおむけで寝かせてください。うつぶせ寝はSIDS(乳幼児突然死症候群)のリスクをあおむけの2.3〜13.1倍に高めます。自分で寝返りできるようになったら、寝かせる時はあおむけにし、寝ている間に返ったものは戻さなくて大丈夫です。',
    sourceLabel: 'AAP·질병관리청·こども家庭庁',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'safe_sleep_environment',
    startDay: 0,
    titleKo: '안전한 수면 환경',
    titleJa: '安全な睡眠環境',
    bodyKo: '단단하고 평평한(기울기 10도 이하) 아기 전용 매트리스에 꼭 맞는 시트만 깔고, 베개·이불·범퍼·인형은 두지 않아요. 최소 6개월(가능하면 12개월)은 부모 방 안 별도 침대에서 재우면 위험이 최대 절반으로 줄지만, 같은 침대 공유는 위험을 높여요.',
    bodyJa: 'かたく平らな(傾き10度以下)ベビー用マットレスにぴったりのシーツだけを敷き、枕・掛け布団・バンパー・ぬいぐるみは置かないでください。少なくとも6か月(できれば12か月)は親の寝室内の別々のベッドで寝かせるとリスクが最大半減しますが、同じ布団で添い寝するとリスクが上がります。',
    sourceLabel: 'AAP 2022·질병관리청',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'fever_under_3mo_emergency',
    startDay: 0,
    titleKo: '3개월 미만 발열은 즉시 진료',
    titleJa: '生後3か月未満の発熱はすぐ受診',
    // P32: Align text with evaluateFever logic which uses ageDays < 90.
    // "12주(84일)" was misleading — "90일" matches the actual threshold.
    bodyKo: '생후 3개월(90일) 미만 아기가 직장 체온 38.0°C 이상이면 겉보기 상태가 좋아 보여도 예외 없이 즉시 병원에 가요. 이 시기 발열은 패혈증·수막염 등 중증 감염의 유일한 신호일 수 있어요. 진료 전 해열제를 먼저 먹이면 증상을 가려 진단이 늦어질 수 있어요.',
    bodyJa: '生後3か月(90日)未満の赤ちゃんが直腸体温38.0°C以上のときは、元気そうに見えても必ずすぐに受診してください。この時期の発熱は敗血症や髄膜炎など重い感染症の唯一のサインのことがあります。受診前に解熱剤を与えると症状が隠れ、診断が遅れる恐れがあります。',
    quoteKo: '생후 3개월(90일) 미만 아기가 직장 체온 38.0°C 이상이면 겉보기 상태가 좋아 보여도 예외 없이 즉시 병원에 가요.',
    quoteJa: '生後3か月(90日)未満の赤ちゃんが直腸体温38.0°C以上のときは、元気そうに見えても必ずすぐに受診してください。',
    sourceLabel: 'AAP·대한소아청소년과학회·日本小児科学会',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'fever_red_flags',
    startDay: 0,
    titleKo: '발열 응급 위험 신호',
    titleJa: '発熱の緊急サイン',
    bodyKo: '체온과 무관하게 다음 중 하나라도 보이면 즉시 응급실로 가요: 피부가 창백·얼룩·청색, 깨워도 계속 처짐, 힘든 호흡이나 그르렁거림, 눌러도 사라지지 않는 자반성 발진, 목 경직·대천문 팽창, 경련. 발열은 2세 미만은 24시간, 그 이상은 3일 넘게 지속되면 소아과에 연락해요.',
    bodyJa: '体温に関わらず、次のいずれかがあればすぐ救急へ:顔色が青白い・まだら・チアノーゼ、起こしてもぐったりが続く、呼吸が苦しそう・ゼーゼー、押しても消えない紫斑、首のこわばり・大泉門のふくらみ、けいれん。発熱が2歳未満で24時間、それ以上で3日続く時は小児科へ連絡してください。',
    sourceLabel: 'AAP·NICE NG143',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'antipyretic_age_limits',
    startDay: 0,
    titleKo: '해열제 연령 제한',
    titleJa: '解熱剤の年齢制限',
    bodyKo: '이부프로펜은 생후 6개월 미만에 쓰지 않아요(신장 미성숙). 아세트아미노펜(타이레놀)도 2세 미만은 의사 지시 없이 주지 않으며, 특히 3개월 미만은 반드시 먼저 진료받아요. 해열제는 체온 숫자보다 아이가 힘들어하거나 수유·수면에 지장이 있을 때 쓰는 게 원칙이에요.',
    bodyJa: 'イブプロフェンは生後6か月未満には使いません(腎機能が未熟なため)。アセトアミノフェン(カロナール等)も2歳未満は医師の指示なしに与えず、特に3か月未満は必ず先に受診してください。解熱剤は体温の数字よりも、赤ちゃんがつらそう・授乳や睡眠に支障がある時に使うのが基本です。',
    quoteKo: '이부프로펜은 생후 6개월 미만에 쓰지 않아요(신장 미성숙).',
    quoteJa: 'イブプロフェンは生後6か月未満には使いません(腎機能が未熟なため)。',
    sourceLabel: 'AAP·FDA·日本小児科学会',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'vitamin_d_supplement',
    startDay: 0,
    titleKo: '비타민D 매일 보충',
    titleJa: 'ビタミンDの毎日補充',
    bodyKo: '모유는 비타민D가 매우 낮아(평균 약 58 IU/L), 모유·혼합 수유아는 퇴원 후 수일 이내부터 하루 400 IU(10 μg)를 매일 보충해요. 분유를 하루 1,000 mL(약 32온스) 이상 먹는 아기는 별도 보충이 필요 없어요. (일본은 과거 200 IU였으나 2025년 국제기준 400 IU로 수렴 — 소아과와 상담)',
    bodyJa: '母乳はビタミンDが非常に少ないため(平均約58 IU/L)、母乳・混合栄養の赤ちゃんは退院後数日以内から1日400 IU(10 μg)を毎日補います。ミルクを1日1,000 mL(約32オンス)以上飲む場合は別途補充は不要です。(日本は従来200 IUでしたが、2025年に国際基準の400 IUへ —小児科でご相談ください)',
    sourceLabel: 'AAP·대한소아청소년과학회·日本小児医療保健協議会',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'tummy_time',
    startDay: 0,
    titleKo: '터미 타임 (엎드려 놀기)',
    titleJa: 'タミータイム(うつ伏せ遊び)',
    bodyKo: '퇴원 직후부터 아기가 깨어 있고 보호자가 지켜볼 때만 엎드려 놀기를 해요. 신생아기엔 1회 3~5분씩 하루 2~3회로 시작해 생후 7주엔 하루 15~30분으로 늘려요. 대근육 발달과 뒤통수 편평(단두증) 예방에 도움이 되며, 잠들면 즉시 등으로 눕혀요.',
    bodyJa: '退院直後から、赤ちゃんが起きていて保護者が見守れる時だけうつ伏せ遊びをします。新生児期は1回3〜5分を1日2〜3回から始め、生後7週で1日15〜30分に増やします。運動発達や後頭部の平ら(短頭症)予防に役立ちます。眠ってしまったらすぐにあおむけに戻してください。',
    sourceLabel: 'AAP 2022·NIH Safe to Sleep',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'intake_adequacy_signals',
    startDay: 0,
    titleKo: '수유 충분 신호와 체중',
    titleJa: '授乳が足りているサインと体重',
    bodyKo: '생후 5~7일부터 하루 6개 이상 젖은 기저귀가 나오면 참고 신호가 돼요. 다만 기저귀 수만으로 판단하긴 어렵고 체중이 더 믿을 만한 지표예요. 출생 체중은 3~4일경 최저(5~7% 감소가 흔함)를 지나 평균 8~9일, 늦어도 2주 안에 회복하며, 회복 후엔 하루 약 28g씩 늘어요.',
    bodyJa: '生後5〜7日から1日6枚以上おしっこのおむつが出ていれば目安になります。ただしおむつの枚数だけでは判断しにくく、体重の方が確かな指標です。出生体重は3〜4日ごろに最低(5〜7%減が一般的)となり、平均8〜9日、遅くとも2週間以内に戻り、その後は1日約28gずつ増えていきます。',
    sourceLabel: 'AAP·ABM Protocol #3·WHO',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'formula_0_1mo',
    startDay: 0,
    titleKo: '분유량 0~1개월',
    titleJa: 'ミルクの量 0〜1か月',
    bodyKo: '첫 주엔 1회 30~60 mL(1~2 oz), 하루 8~12회로 소량씩 자주 먹여요. 이후 2주엔 1회 45~90 mL, 1개월 말엔 1회 약 120 mL에 이르는 것이 일반적이에요. 배부름 신호(고개 돌리기, 수유 중 잠들기)를 보이면 남은 양을 억지로 먹이지 않아요.',
    bodyJa: '最初の1週間は1回30〜60 mL(1〜2オンス)を1日8〜12回、少量ずつこまめに与えます。その後2週目は1回45〜90 mL、1か月の終わりには1回約120 mLに達するのが一般的です。満腹のサイン(顔をそむける・授乳中に眠る)が出たら、残りを無理に飲ませないでください。',
    sourceLabel: 'AAP·CDC·厚生労働省',
    evidenceLevel: 'guideline-consensus',
  },
  // P34: Split formula_1_3mo into two bands so per-feed max is accurate per sub-age.
  // 1~2mo max is 160 mL; 2~3mo max rises to 180 mL. Marker text says
  // "1~2개월은 1회 120~160 mL" — keeping both consistent with the prose.
  {
    id: 'formula_1_2mo',
    startDay: 30,
    titleKo: '분유량 1~2개월',
    titleJa: 'ミルクの量 1〜2か月',
    bodyKo: '1~2개월은 1회 120~160 mL, 하루 6~7회예요. 체중 기준으로는 하루 약 150 mL/kg(미국 AAP 기준은 약 165 mL/kg) — 성장 곡선과 함께 평가해요.',
    bodyJa: '1〜2か月は1回120〜160 mLを1日6〜7回。体重あたりでは1日約150 mL/kg(米国AAP基準は約165 mL/kg)—成長曲線と合わせて判断してください。',
    sourceLabel: 'AAP·Nemours·厚生労働省',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'formula_2_3mo',
    startDay: 60,
    titleKo: '분유량 2~3개월',
    titleJa: 'ミルクの量 2〜3か月',
    bodyKo: '2~3개월은 1회 120~180 mL, 하루 6~7회예요. 3개월 말엔 180 mL까지도 정상이에요. 체중 기준으로는 하루 약 150 mL/kg(미국 AAP 기준은 약 165 mL/kg) — 성장 곡선과 함께 평가해요.',
    bodyJa: '2〜3か月は1回120〜180 mLを1日6〜7回。3か月の終わりには180 mLでも正常です。体重あたりでは1日約150 mL/kg(米国AAP基準は約165 mL/kg)—成長曲線と合わせて判断してください。',
    sourceLabel: 'AAP·Nemours·厚生労働省',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'formula_3_6mo',
    startDay: 90,
    titleKo: '분유량 3~6개월',
    titleJa: 'ミルクの量 3〜6か月',
    bodyKo: '3~4개월은 1회 120~180 mL, 4~6개월은 1회 180~240 mL로 하루 4~5회예요. 하루 총량은 960 mL(32 oz)를 넘지 않도록 하고, 이보다 더 원하면 이유식 시작을 검토하며 소아과와 상담해요. 이 시기부터 아기가 스스로 섭취량을 조절하기 시작해요.',
    bodyJa: '3〜4か月は1回120〜180 mL、4〜6か月は1回180〜240 mLを1日4〜5回。1日の合計は960 mL(32オンス)を超えないようにし、それ以上欲しがる場合は離乳食の開始を検討し小児科にご相談ください。この時期から赤ちゃんは自分で飲む量を調節し始めます。',
    sourceLabel: 'AAP·Seattle Children\'s·厚生労働省',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'weaning_start_readiness',
    startDay: 120,
    titleKo: '이유식 시작 시기와 준비 신호',
    titleJa: '離乳食の開始時期と準備サイン',
    bodyKo: '국제 기준(WHO·AAP·한국 모유수유아)은 생후 6개월, 일본과 한국 분유수유아는 5~6개월(4개월 이전 금지)에 시작해요. ①받쳐주면 앉아 목·머리를 가누고 ②음식에 관심을 보이며 ③숟가락 음식을 삼키는 준비 신호를 함께 확인해요. 첫 식품은 소화 잘 되는 쌀미음, 철분 풍부 식품(고기)을 초기부터 포함해요.',
    bodyJa: '国際基準(WHO・AAP・韓国の母乳栄養児)は生後6か月、日本と韓国のミルク栄養児は5〜6か月(4か月未満は不可)に始めます。①支えれば座って首・頭が安定する ②食べ物に興味を示す ③スプーンの食べ物を飲み込める、というサインも確認しましょう。最初はおかゆから始め、鉄分の多い食品(肉類)を早期から取り入れます。',
    sourceLabel: 'WHO·AAP·厚生労働省·질병관리청',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'allergen_early_intro',
    startDay: 120,
    titleKo: '알레르기 식품 조기 도입',
    titleJa: 'アレルギー食品の早期導入',
    bodyKo: '달걀·땅콩 등 알레르기 유발 식품을 일부러 늦게 도입할 이유가 없어요(4~6개월 이후). 오히려 조기 도입이 알레르기를 예방한다는 강력한 근거가 있어요(LEAP 연구: 땅콩 알레르기 약 80% 감소, PETIT 연구: 달걀 약 79% 감소). 단, 중증 아토피 등 고위험 아기는 전문의 평가 후 도입해요.',
    bodyJa: '卵やピーナッツなどアレルギーを起こしやすい食品を、あえて遅らせる必要はありません(4〜6か月以降)。むしろ早期導入がアレルギーを予防するという強い根拠があります(LEAP研究:ピーナッツアレルギー約80%減、PETIT研究:卵約79%減)。ただし重症アトピーなど高リスクの子は専門医の評価を受けてから始めてください。',
    sourceLabel: 'AAP·NEJM(LEAP)·Lancet(PETIT)·厚生労働省',
    evidenceLevel: 'RCT',
  },
]

export const GUIDANCE_DISCLAIMER: GuidanceDisclaimer = {
  ko: '이 정보는 WHO·AAP·후생노동성·질병관리청 등 공신력 있는 기관의 일반 지침을 요약한 참고 자료로, 의학적 진단이나 처방을 대체하지 않아요. 수치는 목표가 아닌 참고 범위이며 아기마다 다를 수 있어요. 발열·수유·성장·발달에 대한 판단과 약물·보충제 용량은 반드시 담당 소아과 의사와 상담하세요. 응급 위험 신호가 보이면 지체 없이 진료를 받으세요.',
  ja: 'この情報はWHO・AAP・厚生労働省・韓国疾病管理庁など信頼できる機関の一般的なガイドラインをまとめた参考資料であり、医学的な診断や処方に代わるものではありません。数値は目標ではなく参考範囲で、赤ちゃんによって異なります。発熱・授乳・成長・発達の判断や、薬・サプリメントの量は必ずかかりつけの小児科医にご相談ください。緊急の危険サインが見られたら、ためらわず受診してください。',
}

export const GUIDANCE_SOURCES: GuidanceSource[] = [
  { org: 'American Academy of Pediatrics (AAP)', title: 'Sleep-Related Infant Deaths: Updated 2022 Recommendations', year: '2022', url: 'https://publications.aap.org/pediatrics/article/150/1/e2022057990/188304/Sleep-Related-Infant-Deaths-Updated-2022' },
  { org: 'American Academy of Pediatrics (AAP)', title: 'Amount and Schedule of Baby Formula Feedings', year: '2022', url: 'https://www.healthychildren.org/English/ages-stages/baby/formula-feeding/Pages/amount-and-schedule-of-formula-feedings.aspx' },
  { org: 'American Academy of Pediatrics (AAP)', title: 'Fever and Your Baby / Acetaminophen for Fever and Pain', year: '2024', url: 'https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/Fever-and-Your-Baby.aspx' },
  { org: 'American Academy of Pediatrics (AAP)', title: 'Prevention of Rickets and Vitamin D Deficiency (Wagner & Greer) / Where We Stand: Vitamin D', year: '2008', url: 'https://publications.aap.org/pediatrics/article/122/5/1142/71470/' },
  { org: 'CDC', title: 'How Much and How Often to Feed Infant Formula', year: '2024', url: 'https://www.cdc.gov/infant-toddler-nutrition/formula-feeding/how-much-and-how-often.html' },
  { org: 'Seattle Children\'s Hospital', title: 'Bottle-Feeding (Formula) Questions', year: '2024', url: 'https://www.seattlechildrens.org/conditions/a-z/bottle-feeding-formula-questions/' },
  { org: 'NICE', title: 'Fever in under 5s: assessment and initial management (NG143)', year: '2021', url: 'https://www.nice.org.uk/guidance/ng143/chapter/recommendations' },
  { org: 'WHO', title: 'Guideline for Complementary Feeding of Infants and Young Children 6–23 Months', year: '2023', url: 'https://www.who.int/publications/i/item/9789240081864' },
  { org: 'Du Toit G et al. / NEJM', title: 'Randomized Trial of Peanut Consumption in Infants at Risk (LEAP Trial)', year: '2015', url: 'https://www.nejm.org/doi/full/10.1056/NEJMoa1414850' },
  { org: 'Natsume O et al. / The Lancet', title: 'Two-step egg introduction for prevention of egg allergy (PETIT trial)', year: '2017', url: 'https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(16)31418-0/abstract' },
  { org: 'Academy of Breastfeeding Medicine (ABM)', title: 'Clinical Protocol #3: Supplementary Feedings in the Healthy Term Breastfed Neonate', year: '2017', url: 'https://abm.memberclicks.net/assets/DOCUMENTS/PROTOCOLS/3-supplementation-protocol-english.pdf' },
  { org: 'NIH / NICHD Safe to Sleep', title: 'Benefits of Tummy Time', year: '2023', url: 'https://safetosleep.nichd.nih.gov/reduce-risk/tummy-time' },
  { org: '厚生労働省', title: '授乳・離乳の支援ガイド(2019年改定版)/ 健康づくりのための睡眠ガイド2023', year: '2019', url: 'https://www.mhlw.go.jp/stf/newpage_04250.html' },
  { org: '日本小児医療保健協議会 栄養委員会', title: '乳児期のビタミンD欠乏の予防に関する提言', year: '2025', url: 'https://www.jpeds.or.jp/uploads/files/20250324_bitamin_D_teigen.pdf' },
  { org: '日本小児科学会', title: 'アセトアミノフェン製剤に関する声明(解熱鎮痛薬処方)', year: '2022', url: 'https://www.jpeds.or.jp/modules/guidelines/index.php?content_id=145' },
  { org: '질병관리청 국가건강정보포털', title: '영아돌연사증후군 예방 가이드라인 / 이유기보충식', year: '2023', url: 'https://health.kdca.go.kr/healthinfo/' },
  { org: '대한소아청소년과학회', title: '영아 안전 수면 권고 / 영아기 비타민D 보충 권고', year: '2023', url: 'https://www.pediatrics.or.kr/' },
  { org: 'Hewitt L et al. / Pediatrics', title: 'Tummy Time and Infant Health Outcomes: A Systematic Review', year: '2020', url: 'https://publications.aap.org/pediatrics/article-abstract/145/6/e20192168/' },
]

// ---------------------------------------------------------------------------
// Legacy compat shim — builds GUIDANCE_ITEMS from GUIDANCE_MARKERS
// Used by HistoryPage and SettingsPage which reference GuidanceItem / GUIDANCE_ITEMS
// ---------------------------------------------------------------------------

/** IDs of markers that are permanent safety references shown in Settings card + birth date day view */
const SETTINGS_PIN_IDS = new Set([
  'safe_sleep_supine',
  'safe_sleep_environment',
  'fever_under_3mo_emergency',
  'fever_red_flags',
  'antipyretic_age_limits',
  'vitamin_d_supplement',
  'tummy_time',
  'intake_adequacy_signals',
])

export const GUIDANCE_ITEMS: GuidanceItem[] = GUIDANCE_MARKERS.map(m => ({
  id: m.id,
  startDay: m.startDay,
  titleKo: m.titleKo,
  titleJa: m.titleJa,
  bodyKo: m.bodyKo,
  bodyJa: m.bodyJa,
  source: m.sourceLabel,
  pinToSettings: SETTINGS_PIN_IDS.has(m.id),
}))

// Legacy disclaimer constants consumed by HistoryPage
export const GUIDANCE_DISCLAIMER_KO = GUIDANCE_DISCLAIMER.ko
export const GUIDANCE_DISCLAIMER_JA = GUIDANCE_DISCLAIMER.ja

// ---------------------------------------------------------------------------
// getGuidanceForAge — current-age formula/weaning marker for a baby
// ---------------------------------------------------------------------------

/**
 * Returns the guidance marker(s) that are currently active for a baby of the
 * given age in days.  "Active" means the marker's startDay is the highest one
 * that does not exceed ageInDays — i.e. the most recent band that has begun.
 *
 * Only formula_* and weaning_* / allergen_* markers are returned (the ones
 * that give actionable per-age advice rather than permanent safety tips).
 *
 * @param birthdate ISO date string 'yyyy-MM-dd'
 * @param today     ISO date string 'yyyy-MM-dd' or Date (defaults to today)
 */
export function getGuidanceForAge(
  birthdate: string,
  today: string | Date = new Date()
): GuidanceMarker[] {
  if (!birthdate) return []

  const birth = parseISO(birthdate)
  const todayDate = typeof today === 'string' ? parseISO(today) : today
  const ageInDays = Math.floor((todayDate.getTime() - birth.getTime()) / (1000 * 60 * 60 * 24))
  if (ageInDays < 0) return []

  // Age-keyed calendar markers (startDay > 0 items + formula_0_1mo which is day-0)
  const ageBanded = GUIDANCE_MARKERS.filter(m =>
    m.id.startsWith('formula_') ||
    m.id.startsWith('weaning_') ||
    m.id.startsWith('allergen_')
  )

  // For formula: pick the single marker with the highest startDay <= ageInDays
  const formulaMarkers = ageBanded.filter(m => m.id.startsWith('formula_') && m.startDay <= ageInDays)
  const bestFormula = formulaMarkers.length > 0
    ? [formulaMarkers.reduce((prev, curr) => curr.startDay > prev.startDay ? curr : prev)]
    : []

  // For weaning/allergen: active once startDay is reached (no "next replaces prev" — both active together)
  const weaningActive = ageBanded.filter(m =>
    (m.id.startsWith('weaning_') || m.id.startsWith('allergen_')) &&
    m.startDay <= ageInDays
  )

  return [...bestFormula, ...weaningActive]
}

// ---------------------------------------------------------------------------
// getCalendarGuidance — map markers with startDay > 0 to concrete dates
// ---------------------------------------------------------------------------

export interface CalendarGuidanceItem {
  marker: GuidanceMarker
  date: string  // 'yyyy-MM-dd'
}

/**
 * Returns all markers with startDay > 0 mapped to concrete dates (birthdate + startDay).
 * Day-0 markers are excluded (would clutter birth date).
 *
 * @param birthdate ISO date string 'yyyy-MM-dd'
 */
export function getCalendarGuidance(birthdate: string): CalendarGuidanceItem[] {
  if (!birthdate) return []
  const birth = parseISO(birthdate)
  return GUIDANCE_MARKERS
    .filter(m => m.startDay > 0)
    .map(m => ({
      marker: m,
      date: format(addDays(birth, m.startDay), 'yyyy-MM-dd'),
    }))
}

// ---------------------------------------------------------------------------
// getCurrentFormulaGuidance — legacy helper consumed by HomePage InsightsPanel
// ---------------------------------------------------------------------------

/**
 * Returns the single most-relevant formula guidance item for ageInDays.
 * Returns null if no formula marker applies yet.
 */
export function getCurrentFormulaGuidance(ageInDays: number): GuidanceItem | null {
  const formulaItems = GUIDANCE_ITEMS.filter(
    g => g.id.startsWith('formula_') && g.startDay <= ageInDays
  )
  if (formulaItems.length === 0) return null
  return formulaItems.reduce((prev, curr) => curr.startDay > prev.startDay ? curr : prev)
}

/**
 * Get all guidance items relevant for a given age in days (for day view banner).
 * Includes formula transitions and weaning — excludes pinToSettings items
 * unless ageInDays === 0 (birth date).
 */
export function getGuidanceForDay(ageInDays: number): GuidanceItem[] {
  if (ageInDays < 0) return []
  if (ageInDays === 0) {
    return GUIDANCE_ITEMS.filter(g => g.startDay === 0)
  }
  return GUIDANCE_ITEMS.filter(g => !g.pinToSettings && g.startDay === ageInDays)
}

// ---------------------------------------------------------------------------
// FEEDING_BANDS — structured numeric data colocated with markers
// Every number here must appear verbatim in the corresponding marker's bodyKo
// ---------------------------------------------------------------------------

export interface FeedingBand {
  /** Matches the marker id this band is derived from */
  // P34: formula_1_3mo split into formula_1_2mo (30-59d) and formula_2_3mo (60-89d)
  id: 'formula_0_1mo' | 'formula_1_2mo' | 'formula_2_3mo' | 'formula_3_6mo'
  /** Min ml per feed — source: marker bodyKo (e.g. "30" in formula_0_1mo) */
  perFeedMlMin: number
  /** Max ml per feed — source: marker bodyKo (e.g. "120" in formula_0_1mo) */
  perFeedMlMax: number
  /** Min feeds per day — source: marker bodyKo */
  feedsPerDayMin: number
  /** Max feeds per day — source: marker bodyKo */
  feedsPerDayMax: number
  /** Daily max ml cap (null = no explicit cap in markers). source: marker bodyKo */
  dailyMaxMl: number | null
  /** Per-kg ml/day min — source: formula_1_2mo/formula_2_3mo marker (厚生労働省/AAP) */
  perKgMlPerDayMin?: number
  /** Per-kg ml/day max — source: formula_1_2mo/formula_2_3mo marker */
  perKgMlPerDayMax?: number
}

/**
 * Structured feeding bands derived verbatim from GUIDANCE_MARKERS prose.
 * Band id matches the marker id it was extracted from.
 * Do NOT change any number here without updating the corresponding marker body.
 */
export const FEEDING_BANDS: FeedingBand[] = [
  {
    // Source: formula_0_1mo bodyKo — "첫 주엔 1회 30~60 mL...1개월 말엔 1회 약 120 mL"
    // "하루 8~12회"
    id: 'formula_0_1mo',
    perFeedMlMin: 30,
    perFeedMlMax: 120,
    feedsPerDayMin: 8,
    feedsPerDayMax: 12,
    dailyMaxMl: null,
  },
  {
    // P34: formula_1_2mo (30-59d) — "1회 120~160 mL, 하루 6~7회"
    id: 'formula_1_2mo',
    perFeedMlMin: 120,
    perFeedMlMax: 160,
    feedsPerDayMin: 6,
    feedsPerDayMax: 7,
    dailyMaxMl: null,
    perKgMlPerDayMin: 150,
    perKgMlPerDayMax: 165,
  },
  {
    // P34: formula_2_3mo (60-89d) — "1회 120~180 mL, 하루 6~7회"
    id: 'formula_2_3mo',
    perFeedMlMin: 120,
    perFeedMlMax: 180,
    feedsPerDayMin: 6,
    feedsPerDayMax: 7,
    dailyMaxMl: null,
    perKgMlPerDayMin: 150,
    perKgMlPerDayMax: 165,
  },
  {
    // Source: formula_3_6mo bodyKo — "1회 120~180 mL, 4~6개월은 1회 180~240 mL" (perFeedMlMin=120, perFeedMlMax=240)
    // "하루 4~5회"
    // "960 mL(32 oz)를 넘지 않도록"
    id: 'formula_3_6mo',
    perFeedMlMin: 120,
    perFeedMlMax: 240,
    feedsPerDayMin: 4,
    feedsPerDayMax: 5,
    dailyMaxMl: 960,
  },
]

/**
 * Returns the FeedingBand active for a baby of `ageDays` days old.
 * Returns null only if ageDays < 0.
 *
 * P33: Removed upper cutoff — formula_3_6mo (startDay 90) remains applicable
 * after 180 days until weaning begins; returning null for >180 was misleading.
 *
 * Band boundaries match the startDay of each marker:
 *   formula_0_1mo: 0–29 days
 *   formula_1_3mo: 30–89 days
 *   formula_3_6mo: 90+ days
 */
export function getFeedingBand(ageDays: number): FeedingBand | null {
  if (ageDays < 0) return null
  if (ageDays < 30) return FEEDING_BANDS[0]  // formula_0_1mo
  if (ageDays < 60) return FEEDING_BANDS[1]  // formula_1_2mo  (P34)
  if (ageDays < 90) return FEEDING_BANDS[2]  // formula_2_3mo  (P34)
  return FEEDING_BANDS[3]                     // formula_3_6mo (no upper bound)
}

// ---------------------------------------------------------------------------
// FEVER_CARE — pre-hospital care steps (sourced from AAP·HealthyChildren)
// Content grounded in fever_under_3mo_emergency, fever_red_flags,
// antipyretic_age_limits markers already in GUIDANCE_MARKERS, and
// AAP HealthyChildren "Fever and Your Baby" (2024) cited in GUIDANCE_SOURCES.
// Do NOT add any step not traceable to those sources.
// ---------------------------------------------------------------------------

export interface FeverCareStep {
  ko: string
  ja: string
}

export const FEVER_CARE: { steps: FeverCareStep[]; sourceLabel: string } = {
  sourceLabel: 'AAP·HealthyChildren',
  steps: [
    {
      ko: '옷을 가볍게 입히고 담요나 두꺼운 이불은 덮지 않아요.',
      ja: '薄着にし、毛布や厚い掛け布団はかけないでください。',
    },
    {
      ko: '실내를 서늘하고 환기가 잘 되게 유지해요.',
      ja: '部屋を涼しく、風通しよく保ちましょう。',
    },
    {
      ko: '모유 또는 분유를 자주 먹여 수분을 보충해요.',
      ja: '母乳やミルクをこまめに与えて水分を補給してください。',
    },
    {
      ko: '몸을 미온수(체온보다 약간 낮은 온도)로 닦아줄 수 있어요. 단, 몸이 떨리면 즉시 중단해요. 알코올(소독용 에탄올) 마사지는 절대 하면 안 돼요.',
      ja: 'ぬるま湯(体温より少し低い温度)で体を拭くことができます。ふるえが出たらすぐ中止してください。アルコールでのマッサージは絶対にしないでください。',
    },
    {
      ko: '아기의 호흡·의식·피부색·발진 상태를 주의 깊게 관찰해요.',
      ja: '赤ちゃんの呼吸・意識・肌の色・発疹の状態を注意深く観察しましょう。',
    },
  ],
}

// ---------------------------------------------------------------------------
// evaluateFever — tier logic
// ---------------------------------------------------------------------------

export type FeverLevel = 'emergency' | 'danger' | 'warning' | 'caution' | null

/**
 * Returns the severity tier for a recorded temperature.
 *
 * Thresholds grounded in GUIDANCE_MARKERS:
 *   fever_under_3mo_emergency: 3개월(90일) 미만 38.0°C → 즉시 진료
 *   fever_red_flags: 39.0+ = 위험 범주 within red-flag context
 *   fever_red_flags: 38.0+ = 발열 (general warning)
 *
 * @param celsius  Recorded temperature
 * @param ageDays  Baby's age in days; null if birthdate unknown
 */
export function evaluateFever(celsius: number, ageDays: number | null): FeverLevel {
  if (celsius < 37.5) return null
  if (celsius < 38.0) return 'caution'
  // MF-01: age unknown → conservative default (cannot rule out age<90d)
  if (ageDays === null && celsius >= 38.0) return 'emergency'
  // emergency: under 90 days (3 months) with fever >= 38.0
  if (ageDays !== null && ageDays < 90 && celsius >= 38.0) return 'emergency'
  if (celsius >= 39.0) return 'danger'
  if (celsius >= 38.0) return 'warning'
  return 'caution'
}
