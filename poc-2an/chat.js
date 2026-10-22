// AI 질문 — 기초서류에 대해 자유롭게 묻는 챗봇 화면
// 질문 해석·답변 문장은 내 PC의 로컬 AI(Ollama, 127.0.0.1)가 하고, 개수·평균 같은 숫자는 앱이 직접 계산합니다.
//   1) 질문 → 조건(JSON)     : 로컬 AI (없으면 규칙 해석)
//   2) 조건 → 계산·근거 찾기 : 앱 (상품 목록·원문 문장·문서에서 뽑은 값)
//   3) 계산 결과 → 답변 문장 : 로컬 AI (없으면 정해진 문장)
// AI가 쓴 문장의 숫자가 계산 결과에 없으면 '확인 필요'로 표시합니다. 외부로 아무것도 보내지 않습니다.

const AI = { ok: false, models: [], model: "", error: "" };
const AI_KINDS = [...KIND_WORDS.map(([k]) => k), "기타"];
const AI_STATUS = ["판매중", "판매종료"];

// 문서에서 뽑는 값 — words 근처(뒤쪽 80자)에서 읽음
const AI_FIELDS = {
  "예정이율": { words: ["예정이율", "적용이율"], unit: "%",
    parse: w => {
      const nums = [...w.matchAll(/(\d+(?:\.\d+)?)%/g)].map(m => +m[1]);
      if (!nums.length) return null;
      return /→|->|에서.{0,10}로/.test(w.slice(0, 40)) ? nums[Math.min(nums.length - 1, 1)] : nums[0]; // '2.75%→2.25%'는 바뀐 값
    } },
  "가입나이": { words: ["가입나이", "가입연령"], unit: "세",
    parse: w => { const m = w.match(/(\d+)세?~(?:만)?(\d+)세/); return m ? +m[2] : null; }, note: "최고 가입나이" },
  // 보험기간·납입기간: 근처 원문에서 기간 값 목록을 읽음 (예: 20년만기, 80세만기, 종신 / 10년납, 전기납) → "1년짜리" 같은 값 조건으로 거름
  "보험기간": { words: ["보험기간"], text: true, terms: "period" },
  "납입기간": { words: ["납입기간"], text: true, terms: "pay" },
};

// 기간 값 읽기 — 같은 표기로 맞춤: 1년(=1년만기·1년갱신) / 80세만기 / 종신 / 10년납 / 60세납 / 전기납 / 일시납
const PERIOD_TOKEN_RE = /(\d{1,3})(년|세)납|전기납|일시납|(\d{1,3})(년|세)만기|종신|(\d{1,3})년(?![납이미경초동마차후간도내전부까의분째씩치])/g;
const PAY_TOKEN_RE = /(\d{1,3})(년|세)납|전기납|일시납/g;
function termTokens(w, kind) {
  const out = [];
  w = w.replace(/(\d+(?:\/\d+)+)(년납|세납|년만기|세만기|년)/g, (m, nums, u) => nums.split("/").map(n => n + u).join(","));
  const re = kind === "pay" ? PAY_TOKEN_RE : PERIOD_TOKEN_RE;
  re.lastIndex = 0;
  let m, prevEnd = -9, prevPay = false;
  while ((m = re.exec(w))) {
    const isPay = /납$/.test(m[0]);
    let t = null;
    if (kind === "pay") t = m[1] ? `${+m[1]}${m[2]}납` : m[0];
    else if (!isPay) {
      if (m[0] === "종신") t = "종신";
      else if (m[3]) t = m[4] === "세" ? `${+m[3]}세만기` : `${+m[3]}년`;
      // 표에서 납입기간 값(예: "7년납 3년 4년") 바로 뒤에 붙은 "N년"은 납입기간 칸으로 보고 뺌
      else if (!(prevPay && m.index - prevEnd <= 2) && !/납입기간$|납입$/.test(w.slice(Math.max(0, m.index - 6), m.index))) t = `${+m[5]}년`;
      else { prevEnd = m.index + m[0].length; continue; }
    }
    prevPay = isPay; prevEnd = m.index + m[0].length;
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
// 질문의 값("1년짜리", "80세 만기", "10년납") → 같은 표기
function termValue(v, kind) {
  const c = norm(v);
  if (kind === "pay") {
    const m = c.match(/(?<!\d)(\d{1,3})(년|세)/);
    return /전기납/.test(c) ? "전기납" : /일시납/.test(c) ? "일시납" : m ? `${+m[1]}${m[2]}납` : "";
  }
  const m = c.match(/(?<!\d)(\d{1,3})(년|세)/);
  return /종신/.test(c) ? "종신" : m ? (m[2] === "세" ? `${+m[1]}세만기` : `${+m[1]}년`) : "";
}

// 낱말이 아니라 문서 구조로 판정하는 개념 — 예) 사망보험금이 경과기간에 따라 달라지는 상품(체증형·계단식·체감)
// 판정: 급부 말(anchor) 뒤 400자 안에 서로 다른 기간 표현(○년 경과·이내·미만·이후…) 2개 이상 +
//       서로 다른 금액 표현(○%·보험가입금액·○원) 2개 이상(또는 '매1년마다 …를 더한', 체증·체감 같은 증감 표현)
const PERIOD_RE = /\d+년(?:경과|이내|미만|이후|초과|지난|까지|이상|동안|시점)|제?\d?납입기간(?:종료|만료)일?|납입(?:완료|종료)(?:일|후|이후)?|\d+회차|\d+세(?:이전|이후|부터|까지|이상|미만)|계약일~|~종신|해당일(?:전일)?(?:까지|이후|부터)/g;
const AMOUNT_RE = /\d+(?:\.\d+)?%|보험가입금액|가입금액|\d[\d,]*만?원/g;
const CLAUSE_RE = /(?<!\d)\d{1,2}\.(?=[가-힣])|제\d+조[【(]|\(주\)|주\)|별표\d/;
// 보험금 지급이 늦어질 때의 이자(적립이율) 표, 면책 조항은 '기간별 지급금액'이 아님
const CONCEPT_NEG_RE = /적립이율|지급기일|청구일|보험계약대출이율|표준이율|연체이율|지연|이자|지급하지않|면책/;
const STEP_RE = /체증|체감|매\d*년(?:마다)?|씩(?:증가|감소|가산|체증)|[을를]더한|[을를]뺀/;
const AI_CONCEPTS = {
  "사망보험금 기간별 차등": { anchor: /사망보험금|사망하였을|사망한경우|사망시/g, words: ["사망", "년"],
    desc: "사망보험금 지급금액이 경과기간(○년 이내·이후 등)에 따라 달라짐" },
  "보험금 기간별 차등": { anchor: /보험금|지급금액|급부/g, words: ["보험금", "년"],
    desc: "보험금 지급금액이 경과기간에 따라 달라짐(체증·체감·감액 포함)" },
};

// 한 페이지에서 개념에 맞는 첫 구간 (원문 그대로, 기간·금액 표현 표시용 목록과 함께)
function conceptHit(text, concept) {
  const map = [];
  let comp = "";
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) { comp += text[i]; map.push(i); }
  const c = AI_CONCEPTS[concept];
  c.anchor.lastIndex = 0;
  let m, skipTo = -1;
  while ((m = c.anchor.exec(comp))) {
    if (m.index < skipTo) continue;
    // 다음 항목(예: "8.면책", "제5조【", "(주)")이 시작되면 그 앞까지만 봄 — 다른 조항의 기간이 섞이지 않게
    let w = comp.slice(m.index, m.index + 400);
    const b = w.slice(10).search(CLAUSE_RE);
    if (b !== -1) w = w.slice(0, 10 + b);
    const periods = [...new Set(w.match(PERIOD_RE) || [])];
    const amounts = [...new Set(w.match(AMOUNT_RE) || [])];
    if (periods.length >= 2 && (amounts.length >= 2 || STEP_RE.test(w)) && !CONCEPT_NEG_RE.test(w)) {
      const end = map[Math.min(m.index + w.length, comp.length) - 1] + 1;
      return { text: text.slice(map[m.index], end).replace(/\s+/g, " ").trim(), matched: [m[0], ...periods, ...amounts].slice(0, 12) };
    }
    skipTo = m.index + 40;
  }
  return null;
}

// 상품별로 최신 판매일자 문서부터 찾아 처음 맞는 구간
async function conceptEvidence(products, concept) {
  const c = AI_CONCEPTS[concept], out = new Map();
  const docs = products.flatMap(p => p.versions.flatMap(v => v.docs));
  const pages = new Map(); // doc → [{page, text}]
  if (SERVER_MODE) {
    const ids = docs.filter(d => d.id).map(d => d.id), byId = new Map(docs.map(d => [d.id, d]));
    const res = ids.length ? (await api("api/pages_with", { ids, words: c.words })).pages : [];
    res.forEach(h => { const d = byId.get(h.id); if (d) { if (!pages.has(d)) pages.set(d, []); pages.get(d).push(h); } });
  } else {
    docs.forEach(d => pages.set(d, (d.pages || []).map((text, i) => ({ page: i + 1, text }))));
  }
  for (const p of products) {
    let found = null;
    for (const v of p.versions) {
      for (const d of [...v.docs].sort(byDocPriority)) {
        for (const pg of pages.get(d) || []) {
          const h = conceptHit(pg.text, concept);
          if (h) { found = { doc: d, page: pg.page, ...h, latest: v === p.versions[0] }; break; }
        }
        if (found) break;
      }
      if (found) break;
    }
    if (found) out.set(p.key, [found]);
  }
  return out;
}


// ---------- 상품 스펙: 상품 분석 결과(사업방법서 항목·약관 보험금 지급기준표)를 질문 조건으로 ----------
// 상품마다 최신 판매일자의 사업방법서·상품요약서·약관을 '상품 분석'과 같은 규칙으로 읽어 항목별 원문 줄을 만들고,
// "유지보너스 있는 상품", "가입나이 70세까지", "암진단비 1,000만원" 같은 조건을 그 원문 줄에서 확인합니다.
const PAYTABLE_ITEM = "보험금 지급기준표";
const AI_ITEMS = [...ITEM_DEFS.filter(d => !["period", "pay", "benefit", "etc", "premium"].includes(d.id)).map(d => d.label), "납입주기", PAYTABLE_ITEM];
// 질문 말 → 항목 (앞에 있는 것이 우선)
const ITEM_WORDS = [
  [PAYTABLE_ITEM, /지급기준표/],
  ["종목·세목", /세목|보험종목/],
  ["해약환급금 일부지급", /일부지급/],
  ["면책", /면책|보장개시|부담보|책임개시|보장하지않|지급하지않|자살|안주는|안줘|못받|\d+일(이)?지나/],
  ["감액", /감액|\d+%만|절반만|반만|절반|일부만지급|\d+년미만.*\d+%|\d+%.*\d+년미만/],
  ["유지보너스", /유지보너스|보너스/],
  ["보험료 선납", /선납/],
  ["보험료 할인", /할인/],
  ["해지계약 부활", /부활|효력회복/],
  ["연체이율", /연체이율|연체이자/],
  ["보험계약대출", /계약대출|약관대출|(?<!년)대출/],
  ["의무가입", /의무(가입|부가|로|적으로)/],
  ["배당", /배당/],
  ["적립형 계약", /적립형/],
  ["간편심사형", /간편심사|간편고지|유병자|3\.?5\.?5/],
  ["중도인출", /계약자적립액인출|적립액인출|적립금인출|중도인출/],
  ["추가납입", /추가납입/],
  ["납입주기", /납입주기|월납|연납|3개월납|6개월납/],
  ["가입한도", /가입한도|가입금액한도|최저보험료|최고보험료|최소보험료|최저가입|최고가입|보험료한도/],
  ["가입나이", /가입나이|가입연령|가입가능나이|몇세|세까지|세이상|세부터|\d+세.{0,3}가입|가입.{0,6}\d+세|\d+세도/],
  [PAYTABLE_ITEM, /진단비|진단금|진단자금|입원일당|입원비|수술비|사망보험금|재해사망|장해|급부|일당|\d+만원|[천백십]만원|억원|\d+배|뇌혈관|뇌졸중|심근경색|유사암|갑상선암|질환|입원|수술|진단|골절|화상|치매|간병/],
];
const SPEC_CACHE = new Map();

// 상품 분석을 돌려 항목별 원문 줄과 지급기준표 줄을 만듦 (같은 상품·판매일자는 한 번만)
function specOf(p, v = p.latest) {
  let R;
  try { R = analyzeProduct(p.key, v.start); } catch (e) { return { items: {}, pay: [], error: e.message }; }
  const items = {};
  for (const row of R.rows) {
    if (!row.id) continue;
    const def = ITEM_DEFS.find(d => d.id === row.id);
    let lines = (row.lines || []).filter(l => l.hit).map(l => ({ text: l.text, doc: l.hit.doc, page: l.hit.page }));
    // 사업방법서 목차 구역에서 읽은 항목은 화면용으로 줄인 8줄이 아니라 구역 전체 (예: 유지보너스 표의 10년납 7.0%)
    if (row.section && lines[0]) {
      const sec = sectionsOf(lines[0].doc).find(x => x.title === row.section);
      if (sec) lines = sec.lines.map(l => ({ text: l.text, doc: sec.doc, page: l.page }));
    }
    // 항목명 줄('가입한도: 최저 1억원')로 읽었어도 사업방법서 목차 구역이 따로 있으면 그 내용도 값 찾기에 씀 (예: 최고 가입금액 30억원)
    if (!row.section && def.heading && lines.length && !["period", "pay", "age"].includes(def.id)) {
      const sec = R.base.filter(d => d.docType === "사업방법서").flatMap(sectionsOf).find(x => def.heading.test(x.key));
      if (sec) sec.lines.forEach(l => { if (!lines.some(x => norm(x.text) === norm(l.text))) lines.push({ text: l.text, doc: sec.doc, page: l.page }); });
    }
    items[def.label] = { lines, none: !!row.none, section: !!row.section }; // section: 목차 구역의 이어진 줄 (아니면 낱말로 찾은 떨어진 줄)
  }
  // 납입주기(월납·연납 등): 사업방법서·상품요약서의 모든 줄에서 (표 칸으로 적힌 경우 포함)
  const cyc = [];
  R.base.filter(d => d.docType !== "약관").forEach(d => docLines(d).forEach(l => { if (/월납|연납|3개월납|6개월납/.test(l.compact)) cyc.push({ text: l.text, doc: d, page: l.page }); }));
  const pay = [];
  const bdef = ITEM_DEFS.find(d => d.id === "benefit");
  findLines(R.base.filter(d => d.docType !== "약관"), bdef.re, 6, bdef.exclude).hits
    .forEach(h => pay.push({ text: h.text, doc: h.doc, page: h.page, note: true, src: h.doc.docType }));
  (R.payTables || []).forEach(t => {
    (t.structRows || t.rows).forEach(r => pay.push({ text: r.text, doc: r.doc || t.doc, page: r.page, table: t.title }));
    t.notes.forEach(n => pay.push({ text: n.text, doc: n.doc || t.doc, page: n.page, table: t.title, note: true }));
  });
  return { items, pay, cyc };
}

// allVersions: 값 조건은 이전 판매일자 문서도 확인 (최신 판에 없으면 이전 판에서 찾고 '이전 판'으로 표시)
async function ensureSpecs(products, progress, allVersions = false) {
  const todo = products.flatMap(p => (allVersions ? p.versions : [p.latest]).map(v => ({ p, v }))).filter(({ p, v }) => !SPEC_CACHE.has(p.key + "|" + v.start));
  const docs = todo.flatMap(({ v }) => v.docs).filter(d => SOURCE_TYPES.includes(d.docType) && !d.error);
  if (SERVER_MODE) {
    for (let i = 0; i < docs.length; i += 8) {
      await Promise.all(docs.slice(i, i + 8).map(d => ensurePages([d])));
      if (progress) progress(`2/3 기초서류 읽는 중 ${Math.min(i + 8, docs.length)}/${docs.length} (처음 한 번만, 다음부터는 빠름)`);
    }
  }
  todo.forEach(({ p, v }) => SPEC_CACHE.set(p.key + "|" + v.start, specOf(p, v)));
}
const specFor = (p, v = p.latest) => SPEC_CACHE.get(p.key + "|" + v.start) || { items: {}, pay: [] };

// 금액·숫자 표기 맞추기: 1,000만원 → 1000만원, 10,000원 → 1만원, 천만원 → 1000만원, 오백만원 → 500만원
const KNUM = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
function numNorm(s) {
  return norm(s).replace(/(\d),(?=\d{3})/g, "$1")
    .replace(/(\d+)(천|백|십)만원/g, (m, n, u) => `${n * { 천: 1000, 백: 100, 십: 10 }[u]}만원`)
    .replace(/([일이삼사오육칠팔구]?)([천백십])([일이삼사오육칠팔구]?)(백|십)?만원/g, (m, a, u, b, u2) =>
      `${(KNUM[a] || 1) * { 천: 1000, 백: 100, 십: 10 }[u] + (b ? KNUM[b] * (u2 === "십" ? 10 : u2 === "백" ? 100 : 1) : 0)}만원`)
    .replace(/(?<![가-힣\d])([일이삼사오육칠팔구])만원/g, (m, a) => `${KNUM[a]}만원`)
    .replace(/(\d+)0000원/g, "$1만원")
    .replace(/(\d+)\.0(?=[^\d]|$)/g, "$1");
}
// 조건 값의 핵심어 (금액은 '원'을 뺀 말도 함께 — 표 칸이 줄바꿈되어 "3만 / 원"처럼 읽히는 경우)
const VALUE_STOP = new Set(["보험금", "지급", "지급하는", "지급하고", "주는", "받는", "금액", "보장", "상품", "보험", "있는", "되는", "가능한", "가능", "경우", "얼마", "얼마야", "나와", "알려", "알려줘",
  "기간", "내용", "조건", "지급기준표", "기준표", "보여줘", "보여", "이상", "이하", "있어", "있나", "얼마인지", "어떻게", "뭐야", "주나", "줘", "하는", "되나", "않는", "않은", "하지", "않고",
  "미리", "낼", "내는", "붙여야", "붙여", "붙이는", "붙이", "해야하", "드려", "줘야", "묻는", "여부", "받으면", "하면", "되면", "그럼", "그러면", "그", "그중", "중에", "건", "것", "거", "있나요", "인가요", "안", "주는건", "상품은", "안에", "내에", "후", "비율", "수준", "기준", "사유", "정도", "몇", "몇개월", "늘어나", "늘어나는", "증가", "증가하는", "되나요",
  "받으", "예전", "이전", "과거", "옛날", "해야", "하나요", "돼요", "되요", "서비스", "상한", "하한", "높은", "낮은", "기능", "다른", "보험료"]);
function valueTerms(v) {
  const out = [];
  // "최대 3개월", "최고 30억원"처럼 한도 말 + 숫자는 붙은 그대로 한 말로 (다른 숫자 옆의 '최대'와 섞이지 않게)
  v = String(v).replace(/(최대|최소|최고|최저)\s*(\d)/g, "$1$2");
  for (const tok of String(v).replace(/(\d),(?=\d{3})/g, "$1").split(/[\s,?!.·/]+/)) for (const m of numNorm(tok).matchAll(/(?:최대|최소|최고|최저)\d+(?:\.\d+)?(?:만원|억원|원|%|세|년|개월|일|회|배|개)?|\d+(?:\.\d+)?(?:만원|억원|원|%|세|년|개월|일|회|배|종|개|만)?|[가-힣A-Za-z]+/g)) {
    let t = m[0];
    if (!/\d/.test(t)) { t = stemOf(t); if (t.length < 2 || TERM_STOP.has(t) || VALUE_STOP.has(t)) continue; }
    if (!out.includes(t)) out.push(t);
  }
  if (/암/.test(v) && !out.some(x => x.includes("암"))) out.push("암");
  return out;
}
const valueAlts = t => {
  const m = t.match(/^(\d+)배$/);
  if (m) return [t, `${m[1] * 100}%`, `${(m[1] - 1) * 100}%추가`];
  return [...termAlts(t), ...(/\d만원$/.test(t) ? [t.slice(0, -1)] : [])];
};
// 숫자 조건(1000만원·90일·50% 등)은 모두 있어야 하고, 말은 2개까지는 모두·3개 이상이면 절반 이상 (표 칸·줄바꿈으로 말이 갈라지는 경우)
// 숫자는 앞에 다른 숫자·소수점이 붙지 않은 곳만 ('5%'가 '1.25%'에 걸리지 않게)
const numIn = (text, a) => { for (let i = text.indexOf(a); i !== -1; i = text.indexOf(a, i + 1)) if (i === 0 || !/[\d.]/.test(text[i - 1])) return true; return false; };
const termHit = (text, t) => valueAlts(t).some(a => (/^\d/.test(a) ? numIn(text, a) : text.includes(a))) || splitNear(text, t);
function hasAll(text, terms) {
  const nums = terms.filter(t => /\d/.test(t)), words = terms.filter(t => !/\d/.test(t));
  if (!nums.every(t => termHit(text, t))) return false;
  const need = words.length <= 2 ? words.length : Math.ceil(words.length / 2);
  const key = words.reduce((a, t) => (t.length > a.length ? t : a), "");
  // 원인 말(재해·질병·상해·교통)은 빠지면 뜻이 달라지므로 꼭 있어야 함 (예: 재해 사망 ≠ 사망)
  if (!words.filter(t => /^(재해|질병|상해|교통|교통상해|[a-z]{2,4})$/i.test(t)).every(t => termHit(text, t.toLowerCase()) || termHit(text, t.toUpperCase()))) return false;
  return (!key || termHit(text, key)) && words.filter(t => termHit(text, t)).length >= need;
}

// 표 칸이 줄바꿈되어 "재해사망 / 보험금"처럼 갈라진 짧은 조각은 앞 줄에 붙여 보여 줌
const joinLines = ls => ls.reduce((o, l) => (o && l.text.length <= 3 && !/\d/.test(l.text) ? o + l.text : o + (o ? " / " : "") + l.text), "");

// 지급기준표 줄 묶기: 짧은 조각("금", "단비")은 앞 줄에 붙이고, 급부명 줄(…보험금·진단비·일당·수술비 (제○조))부터 다음 급부명 전까지를 한 덩어리로
const BENEFIT_HEAD = /^[가-힣·\s]{1,14}(보험금|진단비|진단금|진단자금|급여금|일당|수술비|입원비|보장금|연금|치료비)\s*(\(제\s*\d+\s*조\))?$/;
// 급부명으로 시작하고 같은 줄에 지급사유가 이어지는 줄 ("암수술비 암으로 수술을 받았을 때 … 200만원")
const BENEFIT_START = /^[가-힣·]{1,14}(보험금|진단비|진단금|급여금|일당|수술비|입원비|보장금|치료비)\s+\S/;
function payBlocks(pay) {
  const merged = [];
  for (const x of pay) {
    const last = merged[merged.length - 1];
    if (last && !x.note && !last.note && x.doc === last.doc && x.text.length <= 3 && !/\d/.test(x.text)) { last.text += x.text; last.parts.push(x); }
    else merged.push({ ...x, parts: [x] });
  }
  const blocks = [];
  for (const m of merged) {
    const t = m.text.replace(/\s+/g, " ").trim(), head = !m.note && (BENEFIT_HEAD.test(t) || BENEFIT_HEAD.test(t.replace(/\s+/g, "")) || BENEFIT_START.test(t));
    if (head || m.note || !blocks.length || blocks[blocks.length - 1].note || blocks[blocks.length - 1].doc !== m.doc) blocks.push({ doc: m.doc, page: m.page, note: m.note, lines: [] });
    blocks[blocks.length - 1].lines.push(m);
  }
  return blocks;
}

// 지급기준표에서 조건 값이 모두 들어 있는 곳: ① 표의 급부 덩어리 ② 주석 ③ 이어진 1~7줄 (표 칸이 여러 줄로 읽힌 경우)
function payMatch(pay, terms) {
  const AMT = /\d[\d,]*(만원|원)|\d+%|보험가입금액|가입금액/;
  const ok = ls => hasAll(numNorm(ls.map(x => x.text).join("")), terms);
  const blocks = payBlocks(pay);
  for (const want of [false, true]) // 표 줄 먼저, 주석은 나중
    for (const b of blocks.filter(b => !!b.note === want))
      if (b.lines.length <= 30 && ok(b.lines)) {
        // 덩어리 안에서 조건이 처음 맞는 줄까지 + 금액이 나올 때까지 (길면 급부명 … 맞는 줄 근처만)
        let end = 1;
        while (end < b.lines.length && !ok(b.lines.slice(0, end))) end++;
        while (end < b.lines.length && !AMT.test(b.lines.slice(0, end).map(x => x.text).join(""))) end++;
        const text = end <= 6 ? joinLines(b.lines.slice(0, end)) : `${joinLines(b.lines.slice(0, 1))} … ${joinLines(b.lines.slice(end - 3, end))}`;
        const pg = end <= 6 ? b.page : b.lines[end - 1].page;
        return { doc: b.doc, page: pg, text, matched: terms };
      }
  for (let size = 1; size <= 7; size++)
    for (let i = 0; i + size <= pay.length; i++) {
      const w = pay.slice(i, i + size);
      if (w.some(x => x.doc !== w[0].doc || !!x.note !== !!w[0].note)) continue; // 표 줄과 주석을 섞지 않음
      if (w.slice(1).some(x => !x.note && BENEFIT_START.test(x.text.replace(/\s+/g, " ").trim()))) continue; // 다른 급부 줄과 섞지 않음
      if (ok(w)) {
        let end = i + size;
        while (!AMT.test(pay.slice(i, end).map(x => x.text).join("")) && end < Math.min(pay.length, i + size + 6) && pay[end].doc === w[0].doc) end++;
        return { doc: w[0].doc, page: w[0].page, text: joinLines(pay.slice(i, end)), matched: terms };
      }
    }
  return null;
}

// 항목 조건 판정: {ok: true/false/null(문서에서 확인 못함), ev: 근거}
function itemCheck(p, plan, v = p.latest) {
  const sp = specFor(p, v);
  if (plan.item === PAYTABLE_ITEM) {
    // 약관에 '보험금 지급기준표'가 없으면 상품 분석의 '보험금 지급사유' 줄(본문 문장)로 확인
    const pay = sp.pay.length ? sp.pay : ((sp.items["보험금 지급사유"] || {}).lines || []);
    if (!pay.length) return { ok: null };
    if (plan.item_value) { const m = payMatch(pay, valueTerms(plan.item_value)); return { ok: !!m, ev: m }; }
    return { ok: plan.item_has !== "없음", ev: { doc: pay[0].doc, page: pay[0].page, text: joinLines(pay.slice(0, 16)), matched: [] } };
  }
  if (plan.item === "납입주기") {
    const ls = [...(sp.cyc || []), ...((sp.items["납입기간·주기"] || {}).lines || [])];
    const toks = [...new Set(ls.flatMap(l => numNorm(l.text).match(/월납|연납|3개월납|6개월납|일시납/g) || []))];
    if (!toks.length) return { ok: null };
    const want = numNorm(plan.item_value || "").match(/월납|연납|3개월납|6개월납|일시납/g) || [];
    const only = /만$|만되|만가능|만있/.test(numNorm(plan.item_value || "")) || /만/.test(plan.item_value || "");
    const other = /말고|외에|이외|빼고|아닌|다른/.test(plan.item_value || "");
    const ok = !want.length ? plan.item_has !== "없음" : other ? toks.some(t => !want.includes(t)) : only ? toks.length === want.length && want.every(w => toks.includes(w)) : want.every(w => toks.includes(w));
    const l = ls.find(x => /월납|연납|일시납|개월납/.test(numNorm(x.text))) || ls[0];
    return { ok, ev: { doc: l.doc, page: l.page, text: `납입주기: ${toks.join(", ")}`, matched: want } };
  }
  const it = sp.items[plan.item];
  if (!it || (!it.lines.length && !it.none)) return { ok: null };
  const exists = it.lines.length > 0 && !it.none;
  const ev0 = it.lines[0] ? { doc: it.lines[0].doc, page: it.lines[0].page, text: joinLines(it.lines.slice(0, 8)), matched: [] } : null;
  if (plan.item_has === "없음") return { ok: !exists, ev: ev0 || { doc: null, text: "해당사항 없음", matched: [] } };
  if (!exists) return { ok: plan.item_value || plan.item_has === "있음" ? false : true, ev: { doc: null, text: "해당사항 없음", matched: [] } };
  if (plan.item_value) {
    // 가입나이 "70세" → 최고 가입나이가 70세 이상
    const age = plan.item === "가입나이" && numNorm(plan.item_value).match(/(\d{1,3})세/);
    if (age) {
      const all = it.lines.map(l => numNorm(l.text)).join("/");
      const ages = [...all.matchAll(/(\d{1,3})세(?!만기|납|까지납|만|이후연금)/g)].map(m => +m[1]);
      const best = it.lines.find(l => /\d+세/.test(l.text)) || it.lines[0];
      const mode = /세부터/.test(numNorm(plan.item_value)) ? "min" : /세까지만/.test(numNorm(plan.item_value)) ? "max" : "";
      return { ok: !ages.length ? null : mode === "min" ? Math.min(...ages) === +age[1] : mode === "max" ? Math.max(...ages) === +age[1] : Math.max(...ages) >= +age[1], ev: { doc: best.doc, page: best.page, text: it.lines.filter(l => /\d+세/.test(l.text)).slice(0, 3).map(l => l.text).join(" / ") || best.text, matched: [`${Math.max(...ages)}세`] } };
    }
    const terms = valueTerms(plan.item_value);
    for (let i = 0; i < it.lines.length; i++) {
      if (!terms.some(t => termHit(numNorm(it.lines[i].text), t))) continue; // 값이 들어 있는 줄부터
      const w = it.lines.slice(i, i + (it.section ? 4 : 1)); // 목차 구역은 표 머리줄과 값 줄이 떨어진 경우까지, 낱말로 찾은 줄은 그 줄만
      if (hasAll(numNorm(w.map(l => l.text).join("")), terms)) return { ok: true, ev: { doc: w[0].doc, page: w[0].page, text: joinLines(w), matched: terms } };
    }
    return { ok: false, ev: ev0 };
  }
  return { ok: true, ev: ev0 };
}

// ---------- 로컬 AI 연결 (serve.py가 127.0.0.1:11434 의 Ollama로만 전달) ----------
async function aiCheck() {
  if (!SERVER_MODE) { AI.ok = false; AI.error = DEMO_MODE ? "웹 데모" : "파일로 연 화면"; renderAiStatus(); return; }
  try {
    const r = await api("api/ai/status");
    AI.ok = r.ok; AI.models = r.models || []; AI.error = r.error || "";
    let saved = "";
    try { saved = localStorage.getItem("aiModel") || ""; } catch (e) { /* 저장소 막힘 */ }
    AI.model = AI.models.includes(saved) ? saved : r.recommended || AI.models[0] || "";
  } catch (e) { AI.ok = false; AI.error = e.message; }
  renderAiStatus();
}

async function aiChat(messages, schema, temperature = 0) {
  // num_ctx: 질문 해석 안내문(약 3~4천 토큰)이 잘리지 않도록 대화 길이를 넉넉히 (Ollama 기본값은 더 작을 수 있음)
  const r = await api("api/ai/chat", { model: AI.model, messages, format: schema || undefined, options: { temperature, num_ctx: 8192 } });
  return r.content || "";
}

function renderAiStatus() {
  const box = $("aiStatus");
  if (AI.ok && AI.model) {
    box.className = "ai-status on";
    box.innerHTML = `<b>로컬 AI 연결됨</b> · 모델 ` +
      (AI.models.length > 1 ? `<select id="aiModel">${AI.models.map(m => `<option${m === AI.model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>` : `<b>${esc(AI.model)}</b>`) +
      ` · 내 PC 안에서만 동작 <label class="ai-opt"><input type="checkbox" id="aiWrite" checked> 답변 문장도 AI가 작성 (끄면 더 빠름)</label>`;
  } else {
    box.className = "ai-status off";
    const why = AI.error === "웹 데모" ? "웹 데모에서는 로컬 AI를 쓸 수 없습니다"
      : AI.error === "파일로 연 화면" ? "start.bat으로 실행해야 로컬 AI를 쓸 수 있습니다"
      : AI.ok ? "Ollama는 켜져 있지만 받은 모델이 없습니다 (ai-setup.bat 실행)"
      : "로컬 AI(Ollama)가 꺼져 있거나 설치되지 않았습니다";
    box.innerHTML = `<b>규칙 해석으로 답합니다</b> — ${esc(why)}. 개수·목록·평균 같은 정해진 질문은 그대로 됩니다. ` +
      `${SERVER_MODE ? `<button type="button" class="mini" id="aiRecheck">다시 확인</button>` : ""} <a href="#aiSetup" id="aiSetupLink">로컬 AI 설치 방법</a>`;
  }
}

document.addEventListener("change", e => {
  if (e.target.id !== "aiModel") return;
  AI.model = e.target.value;
  try { localStorage.setItem("aiModel", AI.model); } catch (err) { /* 저장소 막힘 */ }
});
document.addEventListener("click", e => {
  if (e.target.closest("#aiRecheck")) aiCheck();
  if (e.target.closest("#aiSetupLink")) { e.preventDefault(); $("aiSetup").open = true; $("aiSetup").scrollIntoView({ block: "start" }); }
});

// ---------- 1) 질문 → 조건 ----------
const PLAN_KEYS = ["action", "category", "status", "year_from", "year_to", "product", "text", "field", "value", "group_by", "concept", "item", "item_value", "item_has", "year_basis", "revised", "all_versions", "versions_min", "change"]; // + features·feature_logic·features_not·also(배열)
const PLAN_ACTIONS = ["count", "list", "average", "max", "min", "find", "explain", "newest", "oldest"];
const PLAN_GROUPS = ["", "연도", "판매상태", "분류"];

const planSchema = () => ({
  type: "object",
  properties: {
    action: { type: "string", enum: PLAN_ACTIONS },
    category: { type: "string", enum: ["", ...AI_KINDS] },
    status: { type: "string", enum: ["", ...AI_STATUS] },
    year_from: { type: "string" }, year_to: { type: "string" },
    product: { type: "string" },
    features: { type: "array", items: { type: "string", enum: FEATURES.map(f => f.name) } },
    feature_logic: { type: "string", enum: ["and", "or"] },
    features_not: { type: "array", items: { type: "string", enum: FEATURES.map(f => f.name) } },
    value: { type: "string" },
    text: { type: "string" },
    field: { type: "string", enum: ["", ...Object.keys(AI_FIELDS)] },
    group_by: { type: "string", enum: PLAN_GROUPS },
    concept: { type: "string", enum: ["", ...Object.keys(AI_CONCEPTS)] },
    item: { type: "string", enum: ["", ...AI_ITEMS] },
    item_value: { type: "string" },
    item_has: { type: "string", enum: ["", "있음", "없음"] },
    also: { type: "array", items: { type: "object", properties: { item: { type: "string", enum: ["", ...AI_ITEMS] }, item_value: { type: "string" }, item_has: { type: "string", enum: ["", "있음", "없음"] },
      field: { type: "string", enum: ["", ...Object.keys(AI_FIELDS)] }, value: { type: "string" } } } },
    year_basis: { type: "string", enum: ["", "first", "any", "revision"] },
    revised: { type: "string", enum: ["", "yes", "no"] },
    all_versions: { type: "string", enum: ["", "yes"] },
    versions_min: { type: "string" },
  },
  required: [...PLAN_KEYS, "features", "feature_logic", "features_not", "also"],
});

const plannerPrompt = () => `너는 보험 기초서류 검색 앱의 질문 해석기다. 사용자의 질문을 아래 JSON 조건으로 바꿔라. JSON만 출력한다.
- action: count(개수) | list(목록) | average(평균) | max(최고) | min(최저) | find(문서에 어떤 내용이 있는 상품 찾기) | explain(용어 설명 등 데이터와 무관한 질문) | newest(가장 최근 출시) | oldest(가장 오래된)
- category: 상품 분류. 다음 중 하나 또는 "": ${AI_KINDS.join(", ")}
- status: "판매중" | "판매종료"("판매중지", "단종"도 판매종료) | ""
- year_from, year_to: 판매개시 연도 범위 (예: "2020"). 없으면 ""
- product: 특정 상품명 일부 (예: "든든"). 없으면 ""
- features: 다음 특징 중 질문에 나온 것들의 배열(없으면 []): ${FEATURES.map(f => f.name).join(", ")}
- features_not: "저해지형 아닌", "갱신형 제외"처럼 빼야 하는 특징의 배열(없으면 [])
- feature_logic: 특징이 여러 개일 때 "and"(모두 해당) 또는 "or"("A 또는 B", "A나 B"처럼 하나라도 해당)
- text: 문서 문장에서 찾아야 할 내용(특징 목록으로 표현이 안 될 때). 예: "사망 시 이미 납입한 보험료에서 인출금액을 차감". 없으면 ""
- field: 문서에서 읽을 값: ${Object.keys(AI_FIELDS).join(", ")} 또는 "". 평균·최고·최저는 field가 꼭 있어야 한다.
- value: field가 보험기간·납입기간일 때 찾을 값(예: "1년", "종신", "80세만기", "10년납", "전기납"). "보험기간 1년짜리"처럼 값 조건이 있으면 꼭 넣는다. 없으면 ""
- group_by: "연도" | "판매상태" | "분류" | "" ("연도별로", "상태별로" 같은 말이 있을 때)
예) "종신보험 판매중지 상품 몇 개야?" → {"action":"count","category":"종신","status":"판매종료","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "판매중인 상품의 평균 예정이율은?" → {"action":"average","category":"","status":"판매중","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"예정이율","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "2023년 이후 나온 저해지형 상품 알려줘" → {"action":"list","category":"","status":"","year_from":"2023","year_to":"","product":"","features":["저해지형"],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "유사암 진단 시 가입금액의 10%를 주는 상품은?" → {"action":"find","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"유사암 진단 시 가입금액의 10% 지급","field":"","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
- concept: 문서에 같은 낱말로 적혀 있지 않고 표·구조로 판단해야 하는 내용. ${Object.entries(AI_CONCEPTS).map(([k, v]) => `"${k}"(${v.desc})`).join(", ")} 또는 "". concept를 쓰면 text는 ""로 둔다.
예) "종신 상품 중 사망보험금을 보험기간에 따라 다르게 주는 상품 있어?" → {"action":"find","category":"종신","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"사망보험금 기간별 차등","item":"","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "종신보험 중 추가납입 또는 중도인출이 되는 상품 알려줘" → {"action":"list","category":"종신","status":"","year_from":"","year_to":"","product":"","features":["추가납입","중도인출"],"feature_logic":"or","text":"","field":"","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "보험기간 1년짜리 상품 알려줘" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"보험기간","value":"1년","group_by":"","concept":"","item":"","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "10년납 종신보험 몇 개야?" → {"action":"count","category":"종신","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"납입기간","value":"10년납","group_by":"","concept":"","item":"","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
- also: 조건이 두 개 이상이면("A 있고 B도", "A이면서 B") 두 번째부터 [{"item":"…","item_value":"…","item_has":"…"}] 또는 [{"field":"납입기간","value":"7년납"}] 로 넣는다. 없으면 []
- year_basis: 연도 조건 기준 "first"(첫 출시) | "any"(어느 판매일자든) | "revision"("2025년에 개정된"처럼 개정판) | ""
- revised: "yes"(개정 이력 있음) | "no"(개정 없음) | ""
- all_versions: "예전·이전·과거 판"을 물으면 "yes"
- versions_min: "판매일자가 3개 이상", "2번 이상 개정"처럼 판(판매일자) 수 조건이면 최소 판 수(예: "3"), 없으면 ""
- value: 예정이율·가입나이처럼 숫자 값이면 "2.25%", "2.5% 이상"처럼 넣어도 된다
- item: 사업방법서 항목 또는 약관 보험금 지급기준표에 관한 조건. 다음 중 하나 또는 "": ${AI_ITEMS.join(", ")}
  (진단비·입원일당·수술비·사망보험금 금액, 지급사유는 "${PAYTABLE_ITEM}")
- item_has: 그 항목이 "있음"(있는/되는/가능한) 또는 "없음"(없는/안 되는). 값 조건이나 단순 조회면 ""
- item_value: 항목 안에서 찾을 값·말 (예: "70세", "고액 할인", "암진단비 1000만원", "입원일당 3만원", "90일"). 없으면 ""
예) "유지보너스 있는 상품 알려줘" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"유지보너스","item_value":"","item_has":"있음","also":[],"year_basis":"","revised":"","all_versions":""}
예) "암 진단 시 1000만원 주는 상품은?" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"${PAYTABLE_ITEM}","item_value":"암 진단 1000만원","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "70세까지 가입되는 상품" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"가입나이","item_value":"70세","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "튼튼간편건강보험 면책 조건 알려줘" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"튼튼간편건강","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"면책","item_value":"","item_has":"","also":[],"year_basis":"","revised":"","all_versions":""}
예) "보험료 할인 있고 선납도 되는 상품" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","features_not":[],"text":"","field":"","value":"","group_by":"","concept":"","item":"보험료 할인","item_value":"","item_has":"있음","also":[{"item":"보험료 선납","item_value":"","item_has":"있음"}],"year_basis":"","revised":"","all_versions":""}
item을 쓰면 text는 ""로 둔다.
concept는 질문에 '기간·경과·○년에 따라 보험금이 다르다/늘어난다/체증' 같은 말이 있을 때만 쓴다.
이전 질문의 조건이 주어지면, "그 중", "그럼" 같은 이어지는 질문은 이전 조건을 이어받아 바뀐 부분만 고친다.`;

// AI 응답을 검사해 허용된 값만 남김
function cleanPlan(p) {
  const out = {};
  PLAN_KEYS.forEach(k => { out[k] = typeof p?.[k] === "string" ? p[k].trim() : ""; });
  if (!PLAN_ACTIONS.includes(out.action)) out.action = "list";
  if (/중지|단종|종료/.test(out.status)) out.status = "판매종료";
  if (!AI_STATUS.includes(out.status)) out.status = "";
  if (!AI_KINDS.includes(out.category)) out.category = "";
  const fl = [...(Array.isArray(p?.features) ? p.features : []), ...(typeof p?.feature === "string" ? [p.feature] : [])];
  out.features = [...new Set(fl.filter(n => FEATURES.some(f => f.name === n)))];
  out.feature_logic = p?.feature_logic === "or" && out.features.length > 1 ? "or" : "and";
  out.features_not = [...new Set((Array.isArray(p?.features_not) ? p.features_not : []).filter(n => FEATURES.some(f => f.name === n)))];
  out.features = out.features.filter(n => !out.features_not.includes(n));
  if (!AI_FIELDS[out.field]) out.field = "";
  out.value = !out.value || !AI_FIELDS[out.field] ? "" : AI_FIELDS[out.field].terms ? termValue(out.value, AI_FIELDS[out.field].terms) : (/\d/.test(out.value) ? out.value : "");
  if (!PLAN_GROUPS.includes(out.group_by)) out.group_by = "";
  if (!AI_CONCEPTS[out.concept]) out.concept = "";
  if (!AI_ITEMS.includes(out.item)) { out.item = ""; out.item_value = ""; out.item_has = ""; }
  out.also = (Array.isArray(p?.also) ? p.also : []).slice(0, 3).map(c => {
    if (c && AI_ITEMS.includes(c.item)) return { item: c.item, item_value: String(c.item_value || "").trim(), item_has: ["있음", "없음"].includes(c.item_has) ? c.item_has : "" };
    if (c && AI_FIELDS[c.field] && c.value) return { field: c.field, value: AI_FIELDS[c.field].terms ? termValue(String(c.value), AI_FIELDS[c.field].terms) : String(c.value).trim() };
    return null;
  }).filter(c => c && (c.item || c.value));
  if (!["first", "any", "revision"].includes(out.year_basis)) out.year_basis = "";
  if (!["yes", "no"].includes(out.revised)) out.revised = "";
  if (out.all_versions !== "yes") out.all_versions = "";
  out.versions_min = /^\d{1,2}=?$/.test(out.versions_min) ? out.versions_min : "";
  if (!["있음", "없음"].includes(out.item_has)) out.item_has = /없/.test(out.item_has) ? "없음" : /있/.test(out.item_has) ? "있음" : "";
  if (out.item) out.text = "";
  if (out.concept) { out.text = ""; if (out.action === "list") out.action = "find"; }
  if (!/^[^→]+→[^→]+$/.test(out.change)) out.change = "";
  ["year_from", "year_to"].forEach(k => { const m = out[k].match(/(19|20)\d{2}/); out[k] = m ? m[0] : ""; });
  if (["average", "max", "min"].includes(out.action) && !out.field) out.action = "list";
  if (!out.item_value && out.item === "납입주기" && !out.item_has) out.item_has = "있음";
  return out;
}

// 기간에 따라 급부(보험금)가 달라지는지 묻는 질문인지 (구조 판정이 필요한 질문)
const conceptAsked = raw => /(기간|년|경과|시점|이내|이후).*(다르|다른|달라|달리|차등|차이|증가|감소|늘어|줄어|변하|바뀌)|체증|체감|계단식/.test(raw) && /사망|보험금|급부|지급/.test(raw);
// 이전 질문을 이어받는 질문인지 ("그 중", "그럼", "거기서" …)
const FOLLOW_UP_RE = /^\s*(그\s*중|그중|그럼|그러면|그리고|거기서|여기서|이\s*중|그\s*상품|그것|그거|위\s*상품|방금|앞의|그\s*결과)|그\s*중에|이\s*중에|위에서|방금\s*(찾은|나온)/;

// "A 있고 B도 되는", "A이면서 B" → 구간별 조건
function splitConds(q) {
  return q.replace(/없고\s*/g, "없음, ").replace(/도\s+(없|안\s?되|안\s?하)/g, " $1").split(/있고|되고\s|이면서|면서|그리고|하고\s|이고\s|및|,(?!\d{3})|(?<=[가-힣])도\s/).map(x => x.trim()).filter(x => x.length >= 2);
}

// 한 구간에서 사업방법서 항목·지급기준표 조건(또는 보험기간·납입기간 값) 찾기
function detectCond(sq, p) {
  const raw = norm(sq);
  // 보험기간·납입기간 값만 있는 구간 ("보험기간 종신", "납입기간 7년납")
  let field = Object.keys(AI_FIELDS).find(f => AI_FIELDS[f].terms && AI_FIELDS[f].words.some(w => raw.includes(w))) || "";
  if (!field && /(?<!\d)\d{1,3}(년|세)납|전기납|일시납/.test(raw)) field = "납입기간";
  if (!field && /(?<!\d)\d{1,3}(년|세)만기/.test(raw)) field = "보험기간";
  const fnum = field && raw.replace(/(19|20)\d{2}년/g, "").match(/(?<!\d)\d{1,3}(년|세)(만기|납)?|종신|전기납|일시납/);
  const fieldVal = field && fnum;
  const featPhr = p.features.flatMap(n => FEATURES.find(f => f.name === n).phrases);
  const rawI = featPhr.reduce((r, ph) => r.split(ph).join(" "), raw); // '사망보험금늘어나는'(체증형) 같은 특징 표현은 항목 판정에서 뺌
  const featItem = p.features.find(n => AI_ITEMS.includes(n) && FEATURES.find(f => f.name === n).phrases.some(ph => raw.includes(ph)));
  // 항목 이름이 분명히 있으면 그 항목, 병명·금액처럼 넓은 말로만 걸리면 알아들은 특징 항목(예: 간편심사형)을 우선
  const explicit = ITEM_WORDS.findIndex(([name, re]) => re.test(rawI) && !p.features.includes(name));
  const generic = explicit === ITEM_WORDS.length - 1;
  let hit = featItem && (explicit === -1 || generic) ? ITEM_WORDS.find(([name]) => name === featItem) : ITEM_WORDS[explicit];
  // 넓은 말로만 지급기준표가 걸렸는데 특징을 알아들었으면 특징 조건으로 충분 (예: "장해 50% 이상이면 납입면제")
  if (hit && generic && !featItem && p.features.length) hit = null;
  // 보험기간·납입기간 값("10년납")은 항목 이름이 분명히 있을 때만 그 항목 안의 값으로
  if (hit && fieldVal && (generic || hit[0] === PAYTABLE_ITEM)) hit = null;
  if (!hit) return fieldVal ? { field, value: fnum[0] } : null;
  const [item, re] = hit;
  // '지급하지 않는'처럼 조건 속 부정은 빼고, 항목 자체가 없는지 물을 때만 '없음'
  let item_has = /없는|없어|없음|없나|안되|불가|미적용|해당없|아닌|아니/.test(raw.replace(/(지급|보장|보상|해당)하지않/g, "")) ? "없음" : "";
  // 값: 항목 말·질문 말투·조건 말을 뺀 나머지 (지급기준표는 진단비·금액 같은 말이 곧 값)
  const drop = item === PAYTABLE_ITEM || item === "납입주기" ? null : item === "가입한도" ? /^(가입한도|한도)/ : item === "면책" ? /면책|부담보|책임개시|보장하지않|지급하지않|안주|못받/ : new RegExp(re.source);
  const words = sq.replace(/(\d),(?=\d{3})/g, "$1").replace(/(\d)\.(\d)/g, "$1·$2").split(/[\s,?!.()]+/).filter(Boolean).map(w => w.replace(/·/g, "."));
  const kept = words.filter(w => {
    const c = norm(w), st = stemOf(c);
    if (drop && drop.test(c) && !/\d/.test(c)) return false;
    if (st === "암" && !/암(보험|상품)/.test(raw)) return true; // 한 글자 병명 '암'은 값으로 (암보험·암상품은 분류)
    if (TERM_STOP.has(c) || TERM_STOP.has(st) || VALUE_STOP.has(st) || (st.length < 2 && !/\d/.test(st))) return false;
    if (/^(몇|개수|건수|개야|개냐|개지|개인지|몇개|목록|전체|모두|얼마|있|없|되|안|가능|불가|어떻|어때|알려|보여|찾아|조건|내용|중에?|중에서|이상|이하|까지만?)$/.test(st)) return false;
    if (p.category && (c === p.category || c === p.category + "보험" || c === p.category + "상품" || st === p.category + "보험")) return false;
    if (p.status && /판매/.test(c)) return false;
    if (/^(19|20)\d{2}년/.test(c)) return false;
    if (p.product && (p.product.includes(st) || st.includes(p.product))) return false;
    if (!/\d/.test(c) && p.features.some(n => FEATURES.find(f => f.name === n).phrases.some(ph => c.includes(ph)))) return false;
    return true;
  }).map(w => stemOf(norm(w)));
  // 면책: "안 주는·지급하지 않는"을 물으면 그 뜻(지급하지 않음·보장하지 않음·면책)이 있는 줄만
  if (item === "면책" && /안주|안줘|지급하지않|보장하지않|못받/.test(raw)) kept.push("지급하지않");
  let item_value;
  if (item === "가입나이") { const a = raw.match(/(\d{1,3})세(부터|까지만)?/); item_value = a ? `${a[1]}세${a[2] || ""}` : ""; } // 부터: 최저 나이 · 까지만: 최고 나이
  else item_value = item_has === "없음" ? "" : kept.filter(w => w.length >= 1).join(" ");
  if (item === "납입주기" && /(월납|연납|일시납|개월납)만/.test(raw)) item_value += "만"; // "월납만" → 그것만 있는 상품
  if (featItem && !item_value) return null; // 특징만 물은 경우는 특징 조건으로 충분
  if (!item_value && item_has !== "없음" && /있|되는|가능|적용|포함|주는|받|하는/.test(raw)) item_has = "있음";
  // "암 진단비"처럼 병명이 분류 말과 같으면 분류 조건으로 보지 않음 ("암보험 중 …"만 분류)
  const dropCat = (p.category === "암" && !/암(보험|상품)/.test(raw)) || (item === PAYTABLE_ITEM && p.category && !new RegExp(p.category + "(보험|상품)").test(norm(sq)));
  return { item, item_value, item_has, clearField: !!fieldVal, dropCat };
}

// 로컬 AI가 없을 때: 정해진 표현으로 해석
function rulePlan(q) {
  const Q = interpretQuestion(q.replace(/평균\s*공시\s*이율/g, "평균이율"), true), raw = norm(q);
  // "저해지형 아닌", "갱신형 제외" → 빼야 하는 특징
  const notFeat = Q.features.filter(f => f.phrases.some(ph => new RegExp(ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[형이가은는]{0,2}(아닌|아니|제외|빼고|말고)").test(raw))).map(f => f.name);
  // "암"은 "암보험·암상품"일 때만 분류 (그 밖에는 병명)
  if (Q.category === "암" && !/암(보험|상품)/.test(raw)) Q.category = "";
  if (Q.category === "종신" && /종신연금/.test(raw) && !/종신보험/.test(raw)) Q.category = ""; // 종신연금형은 연금의 세목
  if (Q.category === "정기" && /확정기간|정기간/.test(raw) && !/정기(보험|상품)/.test(raw)) Q.category = ""; // '확정기간'의 '정기'는 분류 아님
  if (!Q.category && /기타(분류|상품|보험|로분류)/.test(raw)) Q.category = "기타";
  const p = { action: "list", category: Q.category, status: Q.status, year_from: Q.from.slice(0, 4), year_to: Q.to.slice(0, 4),
    product: "", features: Q.features.map(f => f.name).filter(n => !notFeat.includes(n)), features_not: notFeat, feature_logic: /또는|혹은|이나|거나|둘중|중하나/.test(raw) ? "or" : "and",
    text: "", field: "", group_by: "" };
  if (/몇개|몇건|몇종|개수|건수|얼마나있/.test(raw)) p.action = "count";
  const rawA = raw.replace(/최저(보험료|가입금액|가입|보증이율|보증)|최고(보험료|가입금액|가입|한도)|최대\d+|최대한도|평균공시이율/g, ""); // 항목 이름 속 '최저·최고'는 계산 요청이 아님
  if (/평균/.test(rawA)) p.action = "average";
  else if (/가장최근|제일최근|최근에출시|최근에나온|최신상품|가장늦게|가장새로|가장나중/.test(rawA)) p.action = "newest";
  else if (/가장오래|제일오래|가장먼저|제일먼저|최초출시|처음출시|처음나온|최초로나온/.test(rawA)) p.action = "oldest";
  else if (/최고|최대|가장높|제일높|가장많|제일많/.test(rawA)) p.action = "max";
  else if (/최저|최소|가장낮|제일낮|가장적|제일적/.test(rawA)) p.action = "min";
  // 개정·판매일자 기준 연도, 개정 이력, 예전 판
  if (/개정/.test(raw)) p.year_basis = "revision"; else if (/판매일자|버전/.test(raw)) p.year_basis = "any";
  if (/개정이력|개정된적|개정판이있|여러번개정|개정이있|개정된상품|개정안된|개정되지않|개정이없|개정안한/.test(raw) && !/(19|20)\d{2}년/.test(raw)) { p.revised = /없|안된|안한|않/.test(raw) ? "no" : "yes"; p.year_basis = ""; }
  if (/예전|이전판|과거|옛날|구판|개정전/.test(raw)) p.all_versions = "yes";
  const vm = raw.match(/판매일자[가이]?(\d+)개이상|(\d+)번이상개정|개정[이을]?(\d+)번이상|개정(\d+)회이상/);
  if (vm) { const n = +(vm[1] || vm[2] || vm[3] || vm[4]); p.versions_min = String(vm[1] ? n : n + 1); p.year_basis = ""; } // 개정 n번 = 판 n+1개
  const ve = !vm && raw.match(/판매일자[가이]?(\d+)개(인|뿐|짜리)|판매일자[가이]?(\d+)개(?!이상)/);
  if (ve) { p.versions_min = (ve[1] || ve[3]) + "="; p.year_basis = ""; } // 정확히 n개
  p.field = Object.keys(AI_FIELDS).find(f => AI_FIELDS[f].words.some(w => raw.includes(w))) || "";
  // 숫자 값 조건: "예정이율 2.25%", "2.5% 이상"
  if (AI_FIELDS[p.field] && !AI_FIELDS[p.field].terms && !AI_FIELDS[p.field].text) {
    const m = q.match(/(\d+(?:\.\d+)?)\s*(%|세)\s*(이상|초과|이하|미만)?/);
    if (m && !["average", "max", "min"].includes(p.action)) p.value = m[0].replace(/\s+/g, "");
  }
  // 기간 값 조건: "보험기간 1년짜리", "80세만기", "10년납", "전기납"
  if (!p.field && /(?<!\d)\d{1,3}(년|세)납|전기납|일시납/.test(raw)) p.field = "납입기간";
  if (!p.field && /(?<!\d)\d{1,3}(년|세)만기/.test(raw)) p.field = "보험기간";
  if (AI_FIELDS[p.field] && AI_FIELDS[p.field].terms) {
    const num = raw.replace(/(19|20)\d{2}년/g, "").match(/(?<!\d)\d{1,3}(년|세)(만기|납)?|종신|전기납|일시납/);
    if (num) p.value = num[0];
  }
  const g = raw.match(/(연도|년도|판매상태|상태|분류)별/);
  if (g) p.group_by = g[1] === "년도" ? "연도" : g[1] === "상태" ? "판매상태" : g[1];
  const y = raw.match(/((?:19|20)\d{2})년(이후|부터)/);
  if (y) { p.year_from = y[1]; p.year_to = ""; }
  const y2 = raw.match(/((?:19|20)\d{2})년(이전|까지)/);
  if (y2) { p.year_to = y2[1]; if (!(y && y2.index > y.index)) p.year_from = ""; } // "2022년부터 2023년까지"는 둘 다
  const dec = raw.match(/((?:19|20)\d)0년대/);
  if (dec) { p.year_from = dec[1] + "0"; p.year_to = dec[1] + "9"; }
  const prod = productInQuestion(raw, q);
  if (prod) p.product = prod;
  // "예정이율이 뭐야?"처럼 용어 뜻을 묻는 질문
  if (p.field && !prod && p.action === "list" && /뭐야|뭔가요|무엇인가|무엇이야|이란|란뭐|뜻|의미|설명해/.test(raw)) p.action = "explain";
  if (/의무납입/.test(raw) && p.field === "납입기간" && !p.value) { p.field = ""; p.text = "의무납입기간"; p.action = p.action === "list" ? "find" : p.action; } // 의무납입기간(변액)은 문장에서
  // "최저보증이율이 1.5%에서 1.0%로 바뀐 상품" → 판매일자(판) 사이에 값이 바뀐 상품
  const NUMV = "\\d+(?:\\.\\d+)?\\s*(?:%|만원|억원|원|세|년|개월|일|회)";
  const chg = q.match(new RegExp(`(${NUMV})\\s*에서\\s*(${NUMV})\\s*(?:으로|로)\\s*(?:바뀐|바뀌|변경|달라|줄어|늘어|낮아|높아|올라|내려|인하|인상|축소|확대)`));
  if (chg) {
    const words = questionTerms(q.replace(chg[0], " ")).filter(t => !/^\d/.test(t) && !/^(바뀐|변경된|상품|판매일자|개정|개정된|예전|이전)$/.test(t));
    Object.assign(p, { change: `${chg[1].replace(/\s+/g, "")}→${chg[2].replace(/\s+/g, "")}`, text: words.join(" "), action: p.action === "count" ? "count" : "find", field: "", value: "" });
    return cleanPlan(p);
  }
  // 남은 핵심어가 2개 이상이면 문서 문장에서 찾을 내용
  const rest = questionTerms(q).filter(t => !(p.field && /^\d{1,3}(년|세)/.test(t)) && !/짜리|^만기$|^(19|20)\d0년대/.test(t) &&
    !/^(몇|개수|건수|개야|개냐|개지|개인지|연도별|년도별|상태별|판매상태별|분류별)/.test(t) &&
    !/^(판|판에|판에서|판의|판매|판매된|종료|종료된|중지|중지된|단종|현재|있나요|있습니|종이야|여부|묻는|평균|분류|분류된|기타|였던|이었던|바뀐|변경된|달라진|최고|최저|최대|최소|가장|제일|목록|전체|모두|얼마|이후|이전|부터|까지|상한|하한|높은|낮은|많은|적은|최근|최근에|최신|오래된|처음|개정|개정된|이력|판매일자|버전|예전|과거|출시|출시된|시작한)$/.test(t) &&
    !Object.values(AI_FIELDS).some(f => f.words.some(w => t.includes(w) || w.startsWith(t))) && !(prod && prod.includes(t)) &&
    !Q.features.some(f => f.phrases.some(ph => t.includes(ph) || ph.includes(t))));
  const noCond = !p.category && !p.status && !p.year_from && !p.year_to && !p.product && !p.features.length && !p.field && !p.group_by && !p.revised && !["count", "newest", "oldest"].includes(p.action);
  if (!p.versions_min && (rest.length >= 2 || (rest.length === 1 && ((noCond && rest[0].length >= 2) || (rest[0].length >= 3 && !/(이면서|면서|이고|이며|인데)$|종신|정기|건강|연금|저축|실손|변액/.test(rest[0]))) && /[가-힣]{2}/.test(rest[0]) && !/^(19|20)\d0년대/.test(rest[0])))) { p.text = rest.join(" "); if (p.action === "list") p.action = "find"; }
  // 기간에 따라 급부(보험금)가 달라지는지 묻는 질문 → 개념 판정
  if (conceptAsked(raw)) {
    p.concept = /사망/.test(raw) ? "사망보험금 기간별 차등" : "보험금 기간별 차등";
    if (["보험기간", "납입기간"].includes(p.field) && !p.value && !["average", "max", "min"].includes(p.action)) p.field = ""; // '보험기간 중'은 값 요청이 아님
    // '체증형'은 특징(체증이라고 적힌 상품)과 구조 판정(계단식·매년 증가)을 합쳐서 찾음 — executePlan 참고
    // "매년 10%씩", "150%까지"처럼 숫자가 있으면 지급기준표에서 그 숫자도 확인
    const pct = q.match(/\d+(?:\.\d+)?\s*%/g);
    if (pct) { p.item = PAYTABLE_ITEM; p.item_value = [...new Set(pct.map(x => x.replace(/\s+/g, "")))].join(" ") + (/사망/.test(raw) ? " 사망보험금" : ""); p.features = p.features.filter(n => n !== "체증형"); }
  }
  // "최대 150%까지 체증"처럼 체증형에 숫자가 있으면 지급기준표에서 그 숫자도 확인
  if (!p.concept && p.features.includes("체증형") && /\d+(?:\.\d+)?\s*%/.test(q)) {
    p.concept = "보험금 기간별 차등"; p.features = p.features.filter(n => n !== "체증형");
    p.item = PAYTABLE_ITEM; p.item_value = [...new Set(q.match(/\d+(?:\.\d+)?\s*%/g).map(x => x.replace(/\s+/g, "")))].join(" ");
    p.text = ""; if (p.action === "list") p.action = "find";
  }
  // "최고 가입나이 75세", "가입나이 최저가 30세" → 가입나이 최고·최저 값 조건
  const ageMm = raw.match(/(최고|최대|상한|최저|최소|하한)(?:가입나이|가입연령|나이)?[이가은는]?(\d{1,3})세/) || (/가입나이|가입연령/.test(raw) && raw.match(/(최고|최대|상한|최저|최소|하한)[이가은는]?(\d{1,3})세/));
  if (ageMm && !p.product) {
    Object.assign(p, { action: p.action === "count" ? "count" : "list", item: "가입나이", item_value: `${ageMm[2]}세${/최고|최대|상한/.test(ageMm[1]) ? "까지만" : "부터"}`, item_has: "", field: "", value: "", text: "", also: [] });
    return cleanPlan(p);
  }
  // 사업방법서 항목·지급기준표 조건 — "할인 있고 선납도 되는"처럼 이어진 조건은 나눠서 각각
  if (!p.concept && !["average", "max", "min", "newest", "oldest"].includes(p.action)) {
    const segs = splitConds(q);
    const perSeg = segs.length > 1 ? segs.map(sq => detectCond(sq, p)) : [];
    const multi = perSeg.filter(Boolean).length > 1;
    const list = multi ? perSeg.filter(Boolean) : [detectCond(q, p)].filter(Boolean);
    // "A도 있고 B도 되는"처럼 이어진 조건은 값이 없으면 '있음'
    if (multi) list.forEach(c => { if (c.item && !c.item_value && !c.item_has) c.item_has = "있음"; });
    if (list.length) {
      const c0 = list[0];
      if (c0.item) {
        if (c0.clearField) { p.field = ""; p.value = ""; }
        Object.assign(p, { item: c0.item, item_value: c0.item_value, item_has: c0.item_has });
        if (p.field === "가입나이" || (p.field && c0.item !== PAYTABLE_ITEM)) p.field = "";
      } else Object.assign(p, { field: c0.field, value: c0.value });
      p.also = list.slice(1).map(c => c.item ? { item: c.item, item_value: c.item_value, item_has: c.item_has } : { field: c.field, value: c.value });
      if (list.some(c => c.dropCat) && p.category) {
        if (p.item === PAYTABLE_ITEM && !p.item_value.includes(p.category)) p.item_value = (p.category + " " + p.item_value).trim();
        p.category = "";
      }
      if (list.some(c => c.item)) { p.text = ""; if (p.action === "find") p.action = "list"; }
    }
  }
  return cleanPlan(p);
}

// 질문 속 상품명: 상품명과 가장 길게 겹치는 부분(4글자 이상, '종신보험' 같은 분류 말만 겹치면 제외)
function productInQuestion(raw, q = raw) {
  const common = (a, b) => {
    let best = "";
    for (let i = 0; i < a.length; i++) for (let j = i + best.length + 1; j <= a.length; j++) {
      if (b.includes(a.slice(i, j))) best = a.slice(i, j); else break;
    }
    return best;
  };
  let best = "";
  for (const x of CATALOG_FOR_AI()) {
    const c = common(raw, norm(x.name));
    const core = c.replace(/보험|종신|정기|건강|연금|저축|변액|무배당|\(무\)|상품|가나다|수술비|수술|치아|상해|치매|간병|실손|의료|어린이|간편|유니버셜|암|진단|입원/g, "");
    if (c.length >= 3 && core.length >= 2 && c.length > best.length) best = c;
  }
  if (best) return best;
  // 질문 첫 말이 한 상품 이름에만 있는 짧은 말이면 그 상품 ("어린이 골절진단비", "치아 면책기간", "VIP 체증 비율")
  // — "…상품", 목록을 묻는 질문은 여러 상품에서 찾는 질문이므로 제외
  if (/상품|목록|몇개|있어|있나|있는|되는|주는/.test(raw)) return "";
  const w0 = norm(String(q).trim().split(/\s+/)[0] || "");
  for (const w of [...new Set([w0, stemOf(w0), w0.replace(/(보험|상품)$/, ""), stemOf(w0).replace(/(보험|상품)$/, "")])]) {
    if (w.length < 2 || /^\d/.test(w) || /^(수술|입원|진단|사망|재해|보험|상품|가나다|무배당)$/.test(w)) continue;
    const hits = CATALOG_FOR_AI().filter(x => norm(x.name).includes(w));
    if (hits.length === 1) return w;
  }
  return "";
}

// ---------- 2) 조건 → 계산 ----------
const CATALOG_FOR_AI = () => (CATALOG.length ? CATALOG : buildCatalog());

// 문서에서 단어 근처 원문 (서버 모드는 색인에서, 그 밖에는 메모리 본문에서)
async function nearWord(docs, words, after = 80) {
  const out = new Map(); // doc → [{page, text}]
  if (SERVER_MODE) {
    const ids = docs.filter(d => d.id).map(d => d.id), byId = new Map(docs.map(d => [d.id, d]));
    const res = ids.length ? (await api("api/near", { ids, words, after })).hits : [];
    res.forEach(h => { const d = byId.get(h.id); if (d) { if (!out.has(d)) out.set(d, []); out.get(d).push(h); } });
  } else {
    docs.forEach(d => (d.pages || []).forEach((t, pi) => {
      const comp = norm(t);
      for (const w of words) {
        for (let i = comp.indexOf(w), n = 0; i !== -1 && n < 3; i = comp.indexOf(w, i + w.length), n++) {
          if (!out.has(d)) out.set(d, []);
          out.get(d).push({ page: pi + 1, text: comp.slice(i, i + after) });
        }
      }
    }));
  }
  return out;
}

// 상품별 값: 최신 판매일자 문서부터 찾아 보고, 없으면 이전 판매일자로
async function fieldValues(products, fieldName) {
  const f = AI_FIELDS[fieldName];
  const docs = products.flatMap(p => p.versions.flatMap(v => v.docs));
  const near = await nearWord(docs, f.words.map(norm), f.terms ? 300 : 80);
  const res = new Map();
  for (const p of products) {
    let found = null;
    for (const v of p.versions) {
      for (const d of [...v.docs].sort(byDocPriority)) {
        for (const h of near.get(d) || []) {
          const w = norm(h.text);
          let value, tokens = null;
          if (f.terms) {
            // 다음 항목("4.납입기간", "제5조【" 등) 전까지만 보고 기간 값 목록을 읽음
            let win = w;
            const b = win.slice(10).search(CLAUSE_RE);
            if (b !== -1) win = win.slice(0, 10 + b);
            tokens = termTokens(win, f.terms);
            value = tokens.join(", ");
          } else value = f.text ? w.slice(0, 60) : f.parse(w);
          if (value !== null && value !== "") { found = { value, tokens, doc: d, page: h.page, text: h.text, start: v.start, latest: v === p.versions[0] }; break; }
        }
        if (found) break;
      }
      if (found) break;
    }
    res.set(p.key, found);
  }
  return res;
}

const yearOf = p => (p.versions[p.versions.length - 1].start || "").slice(0, 4); // 최초 판매개시 연도

// 항목 조건 하나 적용: {products, ev, unread}
async function applyItem(products, cond, progress, allVersions) {
  const byValue = allVersions || (!!cond.item_value && cond.item !== "가입나이");
  await ensureSpecs(products, progress, byValue);
  const ev = new Map(), keep = [], unread = [];
  for (const p of products) {
    let r = itemCheck(p, cond);
    // 값 조건(또는 '예전 판' 질문): 최신 판에 없으면 이전 판매일자 문서에서도 찾음
    if (byValue && !r.ok) for (const v of p.versions.slice(1)) {
      const r2 = itemCheck(p, cond, v);
      if (r2.ok) { r = { ...r2, ev: r2.ev && { ...r2.ev, old: v.start } }; break; }
    }
    // '예전 판' 조회(값 없이)는 판매일자마다 원문을 이어서 보여 줌
    if (allVersions && !cond.item_value && cond.item_has !== "없음") {
      const parts = p.versions.map(v => ({ v, r: itemCheck(p, cond, v) })).filter(x => x.r.ok && x.r.ev && x.r.ev.doc);
      if (parts.length) r = { ok: true, ev: { ...parts[0].r.ev, text: parts.map(x => `[${x.v.start}] ${x.r.ev.text}`).join(" ‖ ") } };
    }
    if (r.ok === null) { unread.push(p); continue; }
    if (r.ok) { keep.push(p); if (r.ev) ev.set(p.key, r.ev); }
  }
  return { products: keep, ev, unread };
}

// 상품을 하나 지정하고 그 상품의 내용을 묻는 질문 ("어린이 골절진단비 얼마야", "CI종신 2017년 판 선지급 비율")
//  → 조건으로 거르지 않고, 그 상품(연도를 말하면 그 해 판매일자) 문서에서 질문 말이 가장 많이 있는 줄을 보여 줌
function detailWords(question, p) {
  const name = norm(p.name), out = [];
  // 낱말 줄기 대신 조사만 뗀 말 ('가입한도'가 '가입'으로 줄지 않게), 숫자는 값 말로
  for (const tok of question.split(/[\s,?!.()]+/).filter(Boolean)) {
    if (/\d/.test(tok)) { valueTerms(tok).forEach(t => out.push(t)); continue; }
    let w = norm(tok).replace(/(이야|이에요|예요|인가요|인가|은요|는요|하면|되면|으면|이면|면|해요|해|하나|나요|은|는|이|가|을|를|의|에|에서|으로|로|도|만|야|요)$/, "");
    if (w.length >= 3) w = w.replace(/(까지|부터)$/, m => (w === "언제부터" ? m : ""));
    if (w.length >= 3 && /나$/.test(w) && !/(나이|하나)$/.test(w)) w = w.slice(0, -1); // 오르나 → 오르
    if (w.length >= 2 && !TERM_STOP.has(w) && !VALUE_STOP.has(w)) out.push(w);
  }
  const ws = [...new Set(out)].filter(t => !/^(19|20)\d{2}년$/.test(t) && !/^(판|알려|보여|얼마|어떻게|뭐|무엇|있|되|조건|내용|종류|얼마야|받아|받을|받나|보상돼|언제|얼마나|있을까|되나|되나요|있나요|어떤|무슨|몇)$/.test(t));
  // 상품 이름 말: '연금·치매·치아'처럼 내용에도 쓰는 말은 남기고(가볍게), 나머지는 뺌
  const named = t => t.length >= 2 && !/\d/.test(t) && (name.includes(t) || name.includes(t.replace(/(보험|상품)$/, "")));
  const out2 = ws.filter(t => !named(t) || /^(연금|치매|치아|수술비|간병|상해|저축|실손|암)$/.test(t));
  // '보장 내용', '특징'처럼 넓게 물으면 상품 특징·보장 줄
  if (!out2.some(t => !named(t)) && /보장|특징|요약|어떤상품|무슨상품|내용/.test(norm(question))) out2.push("보장", "특징");
  return out2.some(t => !named(t)) ? out2 : [];
}
const BENEFIT_WORD = /(보험금|진단비|진단금|수술비|치료비|일당|급여|입원|통원|진단|수술|사망|장해|연금)$/;
// 질문 말이 많이·길게 맞는 줄, 숫자(금액·%)가 있는 줄, 지급기준표 줄을 우선 — 같은 점수면 앞의 것(지급기준표 → 사업방법서 → …)
function bestLines(units, words, opt = {}) {
  const scored = [];
  for (const u of units) {
    const c = numNorm(u.text), hit = words.filter(t => termHit(c, t));
    if (!hit.length) continue;
    // 금액·숫자는 질문 말 뒤에 나와야 그 말의 값 (앞 줄 금액이 끼어든 조각은 제외)
    const from = Math.min(...hit.map(t => { const i = valueAlts(t).map(a => c.indexOf(a)).filter(i => i >= 0); return i.length ? Math.min(...i) : 0; }));
    const body = c.slice(from).replace(/^(\d{1,2}\.|[가-하]\.)/, "").replace(/최초\d+회한|\d+회당|\d+일당/g, "");
    const score = hit.reduce((a, t) => a + (opt.light && opt.light.includes(t) ? 1 : Math.min(t.length, 6) + (/\d/.test(t) ? 4 : 0)), 0) + (opt.ageHint && /\d+세/.test(c) ? 3 : 0) + (/\d+(%|만원|억원|원|세|년|일|회|개월|배)|계약자적립액|보험가입금액/.test(body) ? 2 : /\d/.test(body) ? 1 : 0) + (u.pay && hit.some(t => BENEFIT_WORD.test(t) && !(opt.light && opt.light.includes(t))) ? 2 + (u.block ? 1 : 0) : 0) - u.text.length / 300;
    scored.push({ ...u, score, matched: hit });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
async function productDetail(plan, p, question) {
  const words = detailWords(question, p);
  if (!words.length) return null;
  await ensureSpecs([p], null, true);
  const inYear = v => { const y = (v.start || "").slice(0, 4); return (!plan.year_from || y >= plan.year_from) && (!plan.year_to || y <= plan.year_to); };
  // '예전 판' 질문은 판매일자마다 이어서
  if (plan.all_versions === "yes" && p.versions.length > 1) {
    const parts = [];
    for (const v of p.versions) { const e = detailIn(plan, p, v, words); if (e) parts.push({ v, e }); }
    if (parts.length) return { v: parts[0].v, words, ev: { ...parts[0].e, text: parts.map(x => `[${x.v.start}] ${x.e.text}`).join(" ‖ ").slice(0, 700), matched: [...new Set(parts.flatMap(x => x.e.matched))] } };
  }
  let v = (plan.year_from || plan.year_to) && p.versions.find(inYear) || p.latest;
  let ev = detailIn(plan, p, v, words);
  // 최신 판에 없는 말이면 이전 판매일자 문서에서 (예: 개정으로 빠진 급부)
  if (!ev && !plan.year_from && !plan.year_to) for (const o of p.versions.slice(1)) { const e = detailIn(plan, p, o, words); if (e) { v = o; ev = e; break; } }
  return { v, ev: ev ? { ...ev, old: v !== p.latest ? v.start : undefined } : { doc: null, text: `문서에서 '${words.join(" ")}'을(를) 찾지 못함`, matched: [] }, words };
}
// 한 판매일자 문서에서: 항목 규칙으로 찾은 근거 + 질문 말이 가장 많이 맞는 줄
function detailIn(plan, p, v, words) {
  let ev = null;
  if (plan.item && plan.item !== PAYTABLE_ITEM) {
    const val = valueTerms(plan.item_value).filter(t => words.includes(t)).join(" ");
    for (const cond of [{ item: plan.item, item_value: val, item_has: "" }, ...(plan.item !== PAYTABLE_ITEM && val ? [{ item: plan.item, item_value: "", item_has: "" }] : [])]) {
      const r = itemCheck(p, cond, v);
      if (r.ok && r.ev && r.ev.doc) { ev = r.ev; break; }
    }
  }
  {
    const sp = specFor(p, v), units = [];
    // 지급기준표: 급부 덩어리, 그리고 이어진 1~4줄 (표 칸이 여러 줄로 읽힌 경우)
    const pay = sp.pay || [];
    payBlocks(pay).forEach(b => units.push({ doc: b.doc, page: b.page, text: joinLines(b.lines), pay: true, block: true }));
    for (let n = 1; n <= 4; n++) for (let i = 0; i + n <= pay.length; i++) {
      const w = pay.slice(i, i + n);
      if (w.every(x => x.doc === w[0].doc && !!x.note === !!w[0].note) && !/^\d/.test(w[0].text) && w[0].text.length > 3) units.push({ doc: w[0].doc, page: w[0].page, text: joinLines(w), pay: true });
    }
    [...v.docs].sort(byDocPriority).filter(d => SOURCE_TYPES.includes(d.docType) && !d.error && d.pages).forEach(d => {
      const ls = docLines(d);
      ls.forEach((l, i) => {
        if (isTocLine(l.text)) return;
        // 제목 줄("3. 연금개시나이에 관한 사항")·짧은 줄은 다음 줄까지 붙여서
        let text = l.text, j = i;
        while (j + 1 < ls.length && j - i < 2 && ls[j + 1].page === l.page && (/에관한사항$/.test(norm(ls[j].text)) || norm(text).length < 25)) text += " " + ls[++j].text;
        units.push({ doc: d, page: l.page, text });
      });
    });
    const nm = norm(p.name), sc = bestLines(units, words, { light: words.filter(t => nm.includes(t)), ageHint: plan.item === "가입나이" || plan.field === "가입나이" });
    // 질문 말이 원문에 그대로 없으면(예: '면책기간' → 보장개시일 문장) 항목 규칙으로 찾은 근거
    if (sc.length) {
      const same = (a, b) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));
      const top = [sc[0], ...sc.slice(1).filter(x => x.score >= sc[0].score * 0.6 && !same(sc[0].text, x.text)).slice(0, 1)].filter(x => !ev || !same(ev.text, x.text)).slice(0, ev ? 1 : 2);
      if (top.length) ev = ev ? { ...ev, text: `${ev.text} / ${top[0].text}`.slice(0, 500), matched: [...new Set([...(ev.matched || []), ...top[0].matched])] }
        : { doc: top[0].doc, page: top[0].page, text: top.map(x => x.text).join(" / ").slice(0, 400), matched: [...new Set(top.flatMap(x => x.matched))] };
    }
  }
  return ev;
}

async function executePlan(plan, progress, question = "") {
  let products = CATALOG_FOR_AI();
  const notes = [];
  // 상품 하나를 지정한 내용 질문
  if (question && plan.product && ["list", "find"].includes(plan.action) && !plan.group_by) {
    const named = products.filter(p => norm(p.name).includes(norm(plan.product).replace(/^\(무\)/, "")));
    const d = named.length === 1 ? await productDetail(plan, named[0], question) : null;
    if (d) {
      const p = named[0];
      const values = plan.field ? await fieldValues([p], plan.field) : new Map();
      notes.push(`상품을 지정한 질문: ${p.name}의 ${d.v.start} 판매일자 문서에서 '${d.words.join(" ")}'이(가) 있는 원문 (조건으로 거르지 않음)`);
      return { plan, products: [p], evidence: new Map(), values, total: 1, notes, unread: [], itemEv: new Map([[p.key, d.ev]]), itemLabel: "질문 내용 원문", detail: d,
        unreadLabel: "" };
    }
  }
  if (plan.category) products = products.filter(p => p.kind === plan.category);
  if (plan.status) products = products.filter(p => p.status === plan.status);
  if (plan.year_from || plan.year_to) {
    const inYear = y => y && (!plan.year_from || y >= plan.year_from) && (!plan.year_to || y <= plan.year_to);
    // first: 첫 출시 연도 / any: 어느 판매일자든 / revision: 개정판(첫 판 제외)의 판매일자
    products = products.filter(p => plan.year_basis === "any" ? p.versions.some(v => inYear((v.start || "").slice(0, 4)))
      : plan.year_basis === "revision" ? p.versions.slice(0, -1).some(v => inYear((v.start || "").slice(0, 4))) : inYear(yearOf(p)));
    if (plan.year_basis === "revision") notes.push("연도 조건: 그 해에 개정된 판매일자(첫 출시 판 제외)가 있는 상품");
  }
  if (plan.versions_min) {
    const n = parseInt(plan.versions_min, 10), exact = plan.versions_min.endsWith("=");
    products = products.filter(p => exact ? p.versions.length === n : p.versions.length >= n);
    notes.push(`판매일자(판) ${n}개${exact ? "" : " 이상"}`);
  }
  if (plan.revised) { products = products.filter(p => (p.versions.length > 1) === (plan.revised === "yes")); notes.push(`개정 이력 ${plan.revised === "yes" ? "있음(판매일자 2개 이상)" : "없음"}`); }
  if (plan.product) products = products.filter(p => norm(p.name).includes(norm(plan.product).replace(/^\(무\)/, "")));
  // '체증형'은 구조 판정(계단식·매년 증가 지급기준표)과 합쳐서 찾음
  const unionStep = plan.concept && plan.features.includes("체증형");
  const feats = plan.features.filter(n => !(unionStep && n === "체증형"));
  if (feats.length) {
    const fs = feats.map(n => FEATURES.find(x => x.name === n)).filter(Boolean);
    products = products.filter(p => plan.feature_logic === "or" ? fs.some(f => p.feat[f.id]) : fs.every(f => p.feat[f.id]));
  }
  if (plan.features_not.length) {
    const fs = plan.features_not.map(n => FEATURES.find(x => x.name === n)).filter(Boolean);
    products = products.filter(p => !fs.some(f => p.feat[f.id]));
  }
  // 문서 문장 조건: 핵심어가 한 문장에 모인 상품만
  const evidence = new Map();
  if (plan.change) {
    const [a, b] = plan.change.split("→"), terms = questionTerms(plan.text);
    const form = { keyword: "", from: "", to: "", category: "", status: "", docType: "" };
    const g1 = new Map(groupSentenceHits((await sentenceAnswer({ Q: { terms: [...terms, a] }, form })).hits).map(g => [g.key, g.hits]));
    const g2 = new Map(groupSentenceHits((await sentenceAnswer({ Q: { terms: [...terms, b] }, form })).hits).map(g => [g.key, g.hits]));
    products = products.filter(p => {
      const h1 = g1.get(p.key), h2 = g2.get(p.key);
      if (!h1 || !h2) return false;
      const x = h1.find(h => h2.some(k => (k.doc.start || "") > (h.doc.start || ""))); // 예전 판 a → 뒤 판 b
      if (!x) return false;
      const y = h2.find(k => (k.doc.start || "") > (x.doc.start || ""));
      evidence.set(p.key, [{ ...y, text: `[${x.doc.start}] ${x.text} → [${y.doc.start}] ${y.text}`, matched: [...(x.matched || []), ...(y.matched || [])] }]);
      return true;
    });
    notes.push(`판매일자 사이 변경: ${terms.join("·")} ${a} → ${b} (앞 판에 ${a}, 뒤 판에 ${b}가 같은 문장에)`);
  } else if (plan.text) {
    const terms = questionTerms(plan.text);
    if (terms.length) {
      const r = await sentenceAnswer({ Q: { terms }, form: { keyword: "", from: "", to: "", category: "", status: "", docType: "" } });
      // 숫자 하나 + 말: 그 말에 가장 가까운 같은 단위 숫자가 물은 숫자인 문장만 ("선지급 80%" ≠ "장해지급률 80% … 50%를 선지급")
      const nums = terms.filter(t => /^\d/.test(t)), wds = terms.filter(t => !/^\d/.test(t));
      const near = h => {
        const c = numNorm(h.text), want = numNorm(nums[0]), unit = want.replace(/^[\d.]+/, "");
        const ns = [...c.matchAll(new RegExp(`(?<![\\d.])\\d+(?:\\.\\d+)?${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"))].map(m => ({ i: m.index, v: m[0] }));
        if (!ns.length) return true;
        const pos = a => { const o = []; for (let i = c.indexOf(a); i !== -1; i = c.indexOf(a, i + 1)) o.push(i); return o; };
        // 말 뒤 40자 안의 숫자는 모두 그 말의 값("5년 이내 1.25%, 10년 이내 1.0%"), 말 앞은 바로 앞 숫자만
        return wds.some(w => termAlts(w).some(a => pos(a).some(i => {
          const e = i + a.length, before = ns.filter(n => n.i < i).pop();
          return ns.some(n => n.i >= e && n.i - e <= 40 && n.v === want) || (before && before.v === want && i - before.i <= 40);
        })));
      };
      const hits = nums.length === 1 && wds.length && terms.length <= 3 ? r.hits.filter(near) : r.hits;
      groupSentenceHits(hits).forEach(g => evidence.set(g.key, g.hits));
      products = products.filter(p => evidence.has(p.key));
      notes.push(`문장 조건: 핵심어 ${terms.join("·")} 중 ${termsNeeded(terms.length)}개 이상이 한 문장에`);
    }
  }
  if (plan.concept) {
    const ev = await conceptEvidence(products, plan.concept);
    ev.forEach((v, k) => evidence.set(k, v));
    const step = unionStep ? FEATURES.find(f => f.name === "체증형") : null;
    products = products.filter(p => ev.has(p.key) || (step && p.feat[step.id]));
    notes.push(`구조 판정: ${AI_CONCEPTS[plan.concept].desc} — 급부 말 뒤에 서로 다른 기간 표현 2개 이상과 금액(또는 증감) 표현이 함께 있는 원문 (규칙 판정이니 원문 확인)`);
  }
  let itemEv = null, itemUnread = [];
  const itemConds = [...(plan.item ? [{ item: plan.item, item_value: plan.item_value, item_has: plan.item_has }] : []), ...plan.also.filter(c => c.item)];
  for (const cond of itemConds) {
    const r = await applyItem(products, cond, progress, plan.all_versions === "yes");
    products = r.products;
    itemUnread.push(...r.unread.filter(p => !itemUnread.includes(p)));
    if (!itemEv) itemEv = r.ev;
    else r.ev.forEach((e, k) => { const prev = itemEv.get(k); itemEv.set(k, prev ? { ...prev, text: `${prev.text} ‖ ${cond.item}: ${e.text}`, matched: [...(prev.matched || []), ...(e.matched || [])] } : e); });
    notes.push(`항목 조건: ${cond.item}${cond.item_has ? ` ${cond.item_has}` : ""}${cond.item_value ? ` — '${cond.item_value}'` : ""}`);
  }
  if (itemConds.length) notes.push(`(항목 조건은 상품 분석과 같은 규칙으로 최신 판매일자 문서를 읽어 확인, 값 조건은 없으면 이전 판까지${plan.all_versions === "yes" ? " · 이번 질문은 이전 판 모두 포함" : ""})`);
  // 보험기간·납입기간 값이 두 개 이상 ("종신이면서 7년납")
  for (const c of plan.also.filter(c => c.field)) {
    const vals = await fieldValues(products, c.field);
    products = products.filter(p => { const v = vals.get(p.key); return v && (v.tokens ? v.tokens.includes(c.value) : String(v.value) === c.value); });
    notes.push(`값 조건: ${c.field} '${c.value}'`);
  }
  const values = plan.field ? await fieldValues(products, plan.field) : new Map();
  let unread = [];
  if (plan.value && AI_FIELDS[plan.field] && AI_FIELDS[plan.field].terms) {
    unread = products.filter(p => !values.get(p.key));
    const noValue = unread.length;
    products = products.filter(p => { const v = values.get(p.key); return v && v.tokens && v.tokens.includes(plan.value); });
    notes.push(`값 조건: 문서에서 읽은 ${plan.field} 값에 '${plan.value}'가 있는 상품` + (noValue ? ` (${plan.field}을 문서에서 못 읽은 상품 ${noValue}개는 제외 — 원문 확인 필요)` : ""));
  }
  if (plan.field && !AI_FIELDS[plan.field].terms && !AI_FIELDS[plan.field].text && plan.value) {
    const m = numNorm(plan.value).match(/(\d+(?:\.\d+)?)(%|세)?(이상|초과|이하|미만)?/);
    if (m) {
      const n = +m[1], op = m[3] || "";
      unread.push(...products.filter(p => !values.get(p.key)));
      products = products.filter(p => { const v = values.get(p.key); if (!v) return false; const x = v.value;
        return op === "이상" ? x >= n : op === "초과" ? x > n : op === "이하" ? x <= n : op === "미만" ? x < n : Math.abs(x - n) < 1e-6; });
      notes.push(`값 조건: ${plan.field} ${m[1]}${AI_FIELDS[plan.field].unit}${op ? " " + op : ""}`);
    }
  }
  if (["newest", "oldest"].includes(plan.action) && products.length) {
    // '가장 최근에 개정된'은 최신 판매일자, 그 밖에는 첫 출시일 기준
    const first = plan.revised === "yes" || plan.year_basis === "revision" ? p => p.versions[0].start || "" : p => p.versions[p.versions.length - 1].start || "";
    const best = products.map(first).filter(Boolean).sort()[plan.action === "newest" ? products.length - 1 : 0];
    products = products.filter(p => first(p) === best);
    notes.push(plan.revised === "yes" || plan.year_basis === "revision" ? `${plan.action === "newest" ? "가장 최근" : "가장 먼저"} 개정(판매일자 ${best})` : `${plan.action === "newest" ? "가장 최근" : "가장 먼저"} 출시(첫 판매일자 ${best})`);
  }
  const result = { plan, products, evidence, values, total: products.length, notes, unread: [...unread, ...itemUnread], itemEv,
    unreadLabel: plan.item ? `${plan.item}을 문서에서 확인하지 못한 상품` : plan.field ? `${plan.field}을 문서에서 못 읽은 상품` : "" };
  if (plan.field && !AI_FIELDS[plan.field].text) {
    const nums = products.map(p => values.get(p.key)).filter(Boolean).map(v => v.value);
    result.found = nums.length;
    result.missing = products.length - nums.length;
    if (nums.length) {
      const round = x => Math.round(x * 1000) / 1000;
      result.stat = { average: round(nums.reduce((a, b) => a + b, 0) / nums.length), max: Math.max(...nums), min: Math.min(...nums) };
      // "가장 높은 상품"은 그 상품만 표에
      if (["max", "min"].includes(plan.action)) {
        result.compared = products.length;
        result.products = products.filter(p => { const v = values.get(p.key); return v && v.value === result.stat[plan.action]; });
        result.total = result.products.length;
        notes.push(`값을 찾은 ${nums.length}개 상품 중 ${plan.action === "max" ? "가장 높은" : "가장 낮은"} 상품만 표시`);
      }
    }
  }
  if (plan.group_by) {
    const keyOf = p => plan.group_by === "연도" ? (yearOf(p) || "미상") : plan.group_by === "판매상태" ? p.status : p.kind;
    const groups = {};
    products.forEach(p => { groups[keyOf(p)] = (groups[keyOf(p)] || 0) + 1; });
    result.groups = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  }
  return result;
}

// ---------- 3) 계산 결과 → 답변 ----------
const planText = p => [
  p.category && `분류 ${p.category}`, p.status && `판매상태 ${p.status}`,
  (p.year_from || p.year_to) && `판매개시 ${p.year_from || "…"}~${p.year_to || "…"}년`,
  p.product && `상품 ${p.product}`, p.features.length && `특징 ${p.features.join(p.feature_logic === "or" ? " 또는 " : " 그리고 ")}`, p.features_not.length && `특징 제외 ${p.features_not.join(", ")}`, p.text && `문서 내용 "${p.text}"`,
  p.concept && `구조 ${p.concept}`, p.item && `${p.item}${p.item_has ? " " + p.item_has : ""}${p.item_value ? `: ${p.item_value}` : ""}`,
  ...p.also.map(c => c.item ? `${c.item}${c.item_has ? " " + c.item_has : ""}${c.item_value ? `: ${c.item_value}` : ""}` : `${c.field} ${c.value}`),
  p.year_basis === "revision" && "개정 기준", p.year_basis === "any" && "판매일자 기준", p.revised && `개정 이력 ${p.revised === "yes" ? "있음" : "없음"}`, p.versions_min && `판매일자 ${p.versions_min}개 이상`, p.all_versions && "이전 판 포함",
  ["newest", "oldest"].includes(p.action) && (p.action === "newest" ? "가장 최근 출시" : "가장 먼저 출시"), p.field && (p.value ? `${p.field} ${p.value}` : `값 ${p.field}`), p.group_by && `${p.group_by}별`].filter(Boolean);

function factsFor(result) {
  const p = result.plan, f = AI_FIELDS[p.field];
  const facts = {
    조건: planText(p).join(", ") || "전체", 기준: `연결된 기초서류 PDF ${DOCS.length}개 · 상품 ${CATALOG_FOR_AI().length}개`,
    상품수: result.total,
    상품: result.products.slice(0, 25).map(x => {
      const v = result.values.get(x.key), ev = result.evidence.get(x.key);
      return { 상품명: x.name, 분류: x.kind, 판매상태: x.status, 최신판매일자: x.latest.start,
        ...(v ? { [p.field]: f.text ? v.value : `${v.value}${f.unit}`, 근거: `${v.doc.docType} p.${v.page}` } : p.field ? { [p.field]: "문서에서 못 찾음" } : {}),
        ...(ev ? { 근거문장: ev[0].text.slice(0, 220), 문장근거: `${ev[0].doc.docType}(${ev[0].doc.start || "?"}) p.${ev[0].page}` } : {}),
        ...(result.itemEv && result.itemEv.get(x.key) ? { [result.itemLabel || p.item]: result.itemEv.get(x.key).text.slice(0, 220) } : {}) };
    }),
  };
  if (result.total > 25) facts.생략 = `외 ${result.total - 25}개`;
  if (result.stat) Object.assign(facts, { [`${p.field} 값을 찾은 상품 수`]: result.found, [`${p.field} 못 찾은 상품 수`]: result.missing,
    평균: `${result.stat.average}${f.unit}`, 최고: `${result.stat.max}${f.unit}`, 최저: `${result.stat.min}${f.unit}` });
  if (result.groups) facts[`${p.group_by}별 상품 수`] = Object.fromEntries(result.groups);
  return facts;
}

function templateAnswer(result) {
  const p = result.plan, f = AI_FIELDS[p.field], cond = planText(p).filter(x => !x.startsWith("값 ")).join(", ") || "전체";
  if (p.action === "explain") return "연결된 기초서류에서 답할 수 있는 질문(개수·목록·평균·문서 내용 찾기)이 아닙니다. 용어 설명 같은 질문은 로컬 AI가 연결되어 있을 때 답합니다.";
  if (result.detail) {
    const x = result.products[0], e = result.detail.ev;
    return e.doc ? `${x.name}의 ${e.doc.docType}(${result.detail.v.start}) p.${e.page} 원문: "${e.text}"` : `${x.name}의 문서에서 '${result.detail.words.join(" ")}'을(를) 찾지 못했습니다. 아래 기초서류를 열어 확인하세요.`;
  }
  if (!result.total) return p.action === "count" ? `조건(${cond})에 맞는 상품은 0개입니다.` : `조건(${cond})에 맞는 상품을 찾지 못했습니다.`;
  let s = `조건(${cond})에 맞는 상품은 ${result.total}개입니다.`;
  if (result.groups) s += " " + result.groups.map(([k, n]) => `${k} ${n}개`).join(", ") + ".";
  if (f && !f.text) {
    const found = result.products.filter(x => result.values.get(x.key));
    const valOf = x => `${result.values.get(x.key).value}${f.unit}`;
    const src = x => { const v = result.values.get(x.key); return `${v.doc.docType}(${v.start}) p.${v.page}`; };
    const fname = p.field + (f.note ? `(${f.note})` : "");
    if (!found.length) s += ` 그중 문서에서 ${p.field} 값을 찾은 상품이 없습니다.`;
    else if (found.length === 1) s += ` ${found[0].name}의 ${fname}은 ${valOf(found[0])}입니다(${src(found[0])}).`;
    else if (["max", "min"].includes(p.action)) {
      const target = result.stat[p.action];
      const who = found.filter(x => result.values.get(x.key).value === target).map(x => x.name);
      s += ` 문서에서 값을 찾은 ${found.length}개 상품 중 ${fname}이 가장 ${p.action === "max" ? "높은" : "낮은"} 상품은 ${who.join(", ")}(${target}${f.unit})입니다.`;
    } else if (p.action === "average") s += ` 문서에서 ${fname} 값을 찾은 ${found.length}개 상품의 평균은 ${result.stat.average}${f.unit}입니다.`;
    else s += ` 문서에서 ${fname} 값을 찾은 ${found.length}개 상품은 ${result.stat.min}${f.unit} ~ ${result.stat.max}${f.unit}입니다.`;
    if (found.length && result.missing) s += ` (값을 못 찾은 ${result.missing}개 제외)`;
  }
  return s;
}

async function aiAnswer(question, result) {
  if (result.plan.action === "explain") {
    return aiChat([{ role: "system", content: "보험 용어를 3문장 이내 한국어로 쉽게 설명한다. 회사·상품 이름이나 숫자를 지어내지 않는다." },
      { role: "user", content: question }], null, 0.2);
  }
  return aiChat([
    { role: "system", content: "너는 보험 기초서류 검색 앱의 답변 작성기다. 아래 '계산 결과'만 근거로 한국어 2~5문장으로 답한다. " +
      "숫자는 계산 결과에 있는 값만 그대로 쓰고 새로 계산하거나 추측하지 않는다. 상품이 많으면 몇 개만 예로 든다. 값을 못 찾은 상품이 있으면 그 사실도 말한다. " +
      "결과가 0개면 찾지 못했다고 답한다. 표나 목록 기호 없이 문장으로 쓴다." },
    { role: "user", content: `질문: ${question}\n\n계산 결과(JSON):\n${JSON.stringify(factsFor(result), null, 1)}` },
  ], null, 0.2);
}

// AI 문장 속 숫자가 계산 결과·질문에 있는지 확인
function numberCheck(text, result, question) {
  const known = new Set((JSON.stringify(factsFor(result)) + " " + question).match(/\d+(?:\.\d+)?/g) || []);
  return [...new Set((text.match(/\d+(?:\.\d+)?/g) || []).filter(n => !known.has(n)))];
}

// ---------- 화면 ----------
const AI_HISTORY = []; // {q, plan}
let aiBusy = false;

function resultHtml(result) {
  const p = result.plan, f = AI_FIELDS[p.field];
  const chips = planText(p).map(t => `<span class="chip">${esc(t)}</span>`).join("") || `<span class="chip">조건 없음 (전체)</span>`;
  let html = `<div class="ai-cond">해석한 조건: ${chips}</div>`;
  if (result.notes.length) html += `<div class="note">${esc(result.notes.join(" · "))}</div>`;
  if (result.groups) html += `<div class="note">${esc(p.group_by)}별: ${result.groups.map(([k, n]) => `${esc(k)} <b>${n}</b>개`).join(" · ")}</div>`;
  // 값 조건인데 그 값을 문서에서 못 읽은 상품 — 원문 확인용
  const unreadHtml = result.unread && result.unread.length ? `<details class="ai-unread"><summary>${esc(result.unreadLabel)} ${result.unread.length}개 — 원문에서 확인</summary><ul>` +
    result.unread.slice(0, 100).map(x => `<li><button type="button" class="linkbtn" data-analyze="${esc(x.key)}" data-start="${esc(x.latest.start)}">${esc(x.name)}</button> ${docLinksHtml(x.latest.docs)}</li>`).join("") +
    (result.unread.length > 100 ? `<li class="note">외 ${result.unread.length - 100}개</li>` : "") + `</ul></details>` : "";
  if (!result.products.length) return html + unreadHtml;
  const SHOW = 10, MAX = 300; // 처음엔 10개만, 나머지는 [더 보기]
  html += `<div class="table-scroll"><table class="ai-table"><thead><tr><th>상품명</th><th>분류</th><th>판매상태</th><th>최신 판매일자</th>` +
    (p.field ? `<th>${esc(p.field)}</th>` : "") + (result.evidence.size ? `<th>근거 문장</th>` : "") + (result.itemEv ? `<th>${esc(result.itemLabel || [p.item, ...p.also.filter(c => c.item).map(c => c.item)].filter(Boolean).join(" · "))}</th>` : "") + `<th>기초서류</th></tr></thead><tbody>` +
    result.products.slice(0, MAX).map((x, i) => {
      const v = result.values.get(x.key), ev = result.evidence.get(x.key);
      const link = (d, page, label) => `<a href="#" data-open="${DOCS.indexOf(d)}" data-page="${page}">${esc(label)}</a>`;
      const vCell = !p.field ? "" : `<td>${v ? `<b>${esc(f.text ? v.value : v.value + f.unit)}</b><div class="path">${link(v.doc, v.page, `${v.doc.docType}(${v.start}) p.${v.page}`)}${v.latest ? "" : " · 이전 판"}</div>` : `<span class="muted">문서에서 못 찾음</span>`}</td>`;
      const eCell = !result.evidence.size ? "" : `<td>${ev ? `${link(ev[0].doc, ev[0].page, `${ev[0].doc.docType}(${ev[0].doc.start || "?"}) p.${ev[0].page}`)}${ev[0].latest === false ? " · 이전 판" : ""} ${highlight(ev[0].text, ev[0].matched)}` : ""}</td>`;
      const iv = result.itemEv ? result.itemEv.get(x.key) : null;
      const iCell = !result.itemEv ? "" : `<td>${iv ? (iv.doc ? `${link(iv.doc, iv.page, `${iv.doc.docType}(${iv.doc.start || "?"}) p.${iv.page}`)}${iv.old ? " · 이전 판" : ""} ` : "") + highlight(iv.text.slice(0, 600), iv.matched || []) : `<span class="muted">문서에서 못 찾음</span>`}</td>`;
      return `<tr${i >= SHOW ? ' class="ai-more" hidden' : ""}><td><button type="button" class="linkbtn" data-analyze="${esc(x.key)}" data-start="${esc(x.latest.start)}">${esc(x.name)}</button></td>` +
        `<td>${esc(x.kind)}</td><td>${stBadge(x.status, x.latest.statusBy)}</td><td>${esc(x.latest.start || "")}</td>${vCell}${eCell}${iCell}<td>${docLinksHtml(x.latest.docs)}</td></tr>`;
    }).join("") + `</tbody></table></div>` +
    (result.total > SHOW ? `<div class="ai-morebar"><button type="button" class="mini" data-ai-more="${Math.min(result.total, MAX) - SHOW}">나머지 ${Math.min(result.total, MAX) - SHOW}개 더 보기</button>` +
      (result.total > MAX ? ` <span class="note">(최대 ${MAX}개까지 표시 · 전체 ${result.total}개)</span>` : "") + `</div>` : "") + unreadHtml;
  return html;
}

// 질문 말풍선이 화면 위쪽에 오도록 스크롤
function scrollToTurn(el) {
  const top = el.getBoundingClientRect().top + window.scrollY - 16;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

// [더 보기] / [접기]
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-ai-more]");
  if (!b) return;
  const rows = b.closest(".ai-a").querySelectorAll("tr.ai-more");
  const open = b.dataset.open !== "1";
  rows.forEach(r => { r.hidden = !open; });
  b.dataset.open = open ? "1" : "";
  b.textContent = open ? "접기" : `나머지 ${b.dataset.aiMore}개 더 보기`;
});

function addTurn(q, followUp = false) {
  const el = document.createElement("div");
  el.className = "ai-turn" + (followUp ? " follow" : "");
  const tag = followUp ? `<span class="ai-tag">↳ 이어서</span>` : AI_HISTORY.length ? `<span class="ai-tag new">새 질문</span>` : "";
  el.innerHTML = `<div class="ai-q">${tag}${esc(q)}</div><div class="ai-a"><p class="muted ai-progress">질문 해석 중…</p></div>`;
  $("aiLog").appendChild(el);
  scrollToTurn(el);
  return el.querySelector(".ai-a");
}

// 이전 질문 조건을 이어받아 바뀐 부분만 덮어씀 (로컬 AI가 없을 때의 이어서 질문)
function mergePlan(prev, cur) {
  const out = { ...prev, action: cur.action };
  ["category", "status", "year_from", "year_to", "product", "text", "field", "value", "group_by", "concept", "item", "item_value", "item_has"].forEach(k => { if (cur[k]) out[k] = cur[k]; });
  if (cur.item && cur.item !== prev.item) { out.item_value = cur.item_value; out.item_has = cur.item_has; }
  if (cur.features.length) { out.features = cur.features; out.feature_logic = cur.feature_logic; }
  if (cur.features_not.length) out.features_not = cur.features_not;
  if (cur.also.length) out.also = cur.also;
  ["year_basis", "revised", "all_versions", "versions_min"].forEach(k => { if (cur[k]) out[k] = cur[k]; });
  if (cur.year_from && !cur.year_to) out.year_to = "";
  if (cur.year_to && !cur.year_from) out.year_from = "";
  return cleanPlan(out);
}

// mode: "new"(새 질문 — 이전 대화와 무관), "follow"(이전 질문에 이어서), "auto"(Enter: '그 중' 등으로 시작하면 이어서)
async function askAi(q, mode = "auto") {
  if (aiBusy || !q.trim()) return;
  const followUp = AI_HISTORY.length > 0 && (mode === "follow" || (mode === "auto" && FOLLOW_UP_RE.test(q)));
  const last = followUp ? AI_HISTORY[AI_HISTORY.length - 1] : null;
  if (!DOCS.length) { addTurn(q).innerHTML = `<p class="warn">기초서류가 아직 연결되지 않았습니다. 연결(또는 샘플 읽기)이 끝난 뒤 물어보세요.</p>`; return; }
  aiBusy = true; syncAiButtons();
  const box = addTurn(q, followUp), t0 = performance.now();
  const progress = t => { const p = box.querySelector(".ai-progress"); if (p) p.textContent = t; };
  const useAi = AI.ok && AI.model;
  let plan, by = "규칙 해석", answer, warn = "";
  try {
    if (useAi) {
      progress(`1/3 로컬 AI(${AI.model})가 질문을 조건으로 바꾸는 중… (PC 사양에 따라 수십 초)`);
      const prev = followUp ? `이전 질문: ${last.q}\n이전 조건: ${JSON.stringify(last.plan)}\n(이번 질문은 위 질문에 이어지는 질문이다. 이전 조건을 이어받아 바뀐 부분만 고친다.)` : "";
      try {
        const raw = await aiChat([{ role: "system", content: plannerPrompt() }, { role: "user", content: (prev ? prev + "\n\n" : "") + "질문: " + q }], planSchema());
        plan = cleanPlan(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
        by = `로컬 AI 해석 (${AI.model})`;
        // 안전장치: AI가 놓친 조건을 규칙 해석으로 보완 (구조 판정, 또는 AI 조건이 하나도 없을 때)
        const rp = rulePlan(q), filled = [];
        // 질문에 없는 구조 판정은 뺌 (이전 질문에서 잘못 이어받는 것 방지)
        const prevConcept = followUp && last.plan.concept;
        if (plan.concept && !conceptAsked(norm(q)) && plan.concept !== prevConcept) { plan.concept = ""; filled.push("구조 판정 제외"); if (plan.action === "find" && !plan.text) plan.action = "list"; }
        if (!plan.concept && rp.concept) {
          plan.concept = rp.concept; plan.text = ""; filled.push("구조 판정");
          if (plan.action === "list") plan.action = "find";
          // 체증형은 구조 판정과 합쳐서 찾음 (executePlan)
          if (!plan.category && rp.category) plan.category = rp.category;
        }
        if (!plan.value && rp.value) { plan.field = rp.field; plan.value = rp.value; filled.push("값 조건"); }
        if (!plan.also.length && rp.also.length && plan.item === rp.item) { plan.also = rp.also; filled.push("조건 여러 개"); }
        ["year_basis", "revised", "all_versions", "versions_min"].forEach(k => { if (!plan[k] && rp[k]) { plan[k] = rp[k]; filled.push(k === "revised" ? "개정 이력" : k === "all_versions" ? "이전 판" : "연도 기준"); } });
        if (!plan.product && rp.product) { plan.product = rp.product; filled.push("상품명"); }
        if (rp.change && plan.change !== rp.change) { Object.assign(plan, { change: rp.change, text: rp.text, item: "", item_value: "", item_has: "", concept: "" }); if (plan.action === "list") plan.action = "find"; filled.push("판 사이 변경"); }
        if (["newest", "oldest"].includes(rp.action) && plan.action !== rp.action) { plan.action = rp.action; filled.push("최근·오래된 출시"); }
        if (!plan.item && rp.item && !plan.concept) {
          Object.assign(plan, { item: rp.item, item_value: rp.item_value, item_has: rp.item_has, text: "" });
          if (!plan.also.length && rp.also.length) plan.also = rp.also;
          if (rp.item === PAYTABLE_ITEM && !rp.category) plan.category = ""; // '암 진단비'의 '암'은 분류가 아님
          if (plan.action === "find") plan.action = "list";
          filled.push("항목 조건");
        }
        const conds = x => ["category", "status", "year_from", "year_to", "product", "text", "field", "value", "concept", "item"].filter(k => x[k]).length + (x.features.length ? 1 : 0);
        if (!conds(plan) && conds(rp)) { plan = { ...rp, action: plan.action === "list" ? rp.action : plan.action }; filled.push("조건 전체"); }
        if (followUp) by += " · 이전 질문 조건 이어받음";
        if (filled.length) by += ` + 규칙 보완(${filled.join("·")})`;
      } catch (e) {
        plan = followUp ? mergePlan(last.plan, rulePlan(q)) : rulePlan(q); warn = `AI 해석 실패(${e.message}) → 규칙 해석으로 대신함`;
      }
    } else {
      plan = followUp ? mergePlan(last.plan, rulePlan(q)) : rulePlan(q);
      if (followUp) by += " · 이전 질문 조건 이어받음";
    }
    progress("2/3 앱이 상품 목록·원문에서 계산하는 중…");
    const result = await executePlan(plan, progress, followUp ? "" : q);
    answer = templateAnswer(result);
    let aiWrote = false;
    if (useAi && ($("aiWrite") ? $("aiWrite").checked : true)) {
      progress(`3/3 로컬 AI가 답변 문장을 쓰는 중…`);
      try { answer = (await aiAnswer(q, result)).trim() || answer; aiWrote = true; } catch (e) { warn += (warn ? " · " : "") + `AI 답변 실패(${e.message}) → 정해진 문장으로 대신함`; }
    }
    const bad = aiWrote && plan.action !== "explain" ? numberCheck(answer, result, q) : [];
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    box.innerHTML = `<div class="ai-answer">${esc(answer).replace(/\n/g, "<br>")}</div>` +
      (bad.length ? `<p class="warn">확인 필요: AI 문장의 숫자 ${esc(bad.join(", "))}은(는) 앱 계산 결과에 없습니다. 아래 표의 값을 기준으로 보세요.</p>` : "") +
      (plan.action === "explain" && aiWrote ? `<p class="warn">문서 근거 없는 일반 설명입니다(AI 지식). 회사 기준은 기초서류로 확인하세요.</p>` : "") +
      `<div class="ai-meta">${esc(by)} · 숫자는 앱 계산값 · 답변 ${aiWrote ? "AI 작성" : "정해진 문장"} · ${sec}초${warn ? ` · <span class="warn">${esc(warn)}</span>` : ""}</div>` +
      (plan.action === "explain" ? "" : resultHtml(result));
    AI_HISTORY.push({ q, plan });
    scrollToTurn(box.parentElement);
    $("aiInput").focus({ preventScroll: true });
  } catch (e) {
    box.innerHTML = `<p class="warn">답변 실패: ${esc(e.message)}</p>`;
  } finally {
    aiBusy = false; syncAiButtons();
  }
}

// 이어서 질문은 앞선 질문이 있을 때만
function syncAiButtons() {
  $("aiSend").disabled = aiBusy;
  $("aiFollow").disabled = aiBusy || !AI_HISTORY.length;
  $("aiFollow").title = AI_HISTORY.length ? `이전 질문 "${AI_HISTORY[AI_HISTORY.length - 1].q}"의 조건을 이어받아 묻습니다` : "먼저 질문을 하나 하세요";
}

// Enter·[새 질문] / [이어서 질문] / [새 대화 시작]
let aiEnter = false; // Enter로 보냈는지 (브라우저는 Enter도 첫 버튼을 누른 것으로 처리하므로 따로 기록)
$("aiInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) aiEnter = true; });
$("aiForm").addEventListener("submit", e => {
  e.preventDefault();
  const mode = aiEnter ? "auto" : e.submitter && e.submitter.id === "aiFollow" ? "follow" : "new";
  aiEnter = false;
  const q = $("aiInput").value;
  $("aiInput").value = "";
  askAi(q, mode);
});
$("aiClear").addEventListener("click", () => { $("aiLog").innerHTML = ""; AI_HISTORY.length = 0; syncAiButtons(); $("aiInput").focus(); });

const AI_EXAMPLES = ["종신보험 중 판매중지된 상품은 몇 개야?", "유지보너스 있는 상품 알려줘", "암 진단 시 1000만원 주는 상품은?",
  "보험료 할인 있고 선납도 되는 상품", "보험기간 1년짜리 상품 알려줘", "90일 면책 있는 상품", "70세까지 가입되는 상품", "가장 최근에 출시된 상품"];
$("aiExamples").innerHTML = "예시: " + AI_EXAMPLES.map(x => `<button type="button" class="mini" data-ai-ex="${esc(x)}">${esc(x)}</button>`).join(" ");
$("aiExamples").addEventListener("click", e => {
  const b = e.target.closest("button[data-ai-ex]");
  if (b) askAi(b.dataset.aiEx, "new");
});

syncAiButtons();
aiCheck();
