// AI 질문 — 기초서류에 대해 자유롭게 묻는 챗봇 화면
// 질문 해석·답변 문장은 내 PC의 로컬 AI(Ollama, 127.0.0.1)가 하고, 개수·평균 같은 숫자는 앱이 직접 계산합니다.
//   1) 질문 → 조건(JSON)     : 로컬 AI (없으면 규칙 해석)
//   2) 조건 → 계산·근거 찾기 : 앱 (상품 목록·원문 문장·문서에서 뽑은 값)
//   3) 계산 결과 → 답변 문장 : 로컬 AI (없으면 정해진 문장)
// AI가 쓴 문장의 숫자가 계산 결과에 없으면 '확인 필요'로 표시합니다. 외부로 아무것도 보내지 않습니다.

const AI = { ok: false, models: [], model: "", error: "" };
const AI_KINDS = KIND_WORDS.map(([k]) => k);
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
      else if (!(prevPay && m.index - prevEnd <= 2)) t = `${+m[5]}년`;
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
const PERIOD_RE = /\d+년(?:경과|이내|미만|이후|초과|지난|까지|이상|동안|시점)|제?\d?납입기간(?:종료|만료)일?|납입(?:완료|종료)(?:일|후|이후)?|\d+회차|\d+세(?:이전|이후|부터|까지|이상|미만)|계약일~|~종신/g;
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
const AI_ITEMS = [...ITEM_DEFS.filter(d => !["period", "pay", "benefit", "etc", "premium"].includes(d.id)).map(d => d.label), PAYTABLE_ITEM];
// 질문 말 → 항목 (앞에 있는 것이 우선)
const ITEM_WORDS = [
  [PAYTABLE_ITEM, /지급기준표/],
  ["종목·세목", /세목|보험종목/],
  ["해약환급금 일부지급", /일부지급/],
  ["면책", /면책|보장개시|부담보|책임개시|보장하지않|지급하지않|자살|안주는|안줘|못받/],
  ["감액", /감액|\d+%만|절반만|일부만지급/],
  ["유지보너스", /유지보너스|보너스/],
  ["보험료 할인", /할인/],
  ["보험료 선납", /선납/],
  ["해지계약 부활", /부활|효력회복/],
  ["연체이율", /연체이율|연체이자/],
  ["보험계약대출", /계약대출|약관대출|대출/],
  ["의무가입", /의무(가입|부가|로|적으로)/],
  ["배당", /배당/],
  ["적립형 계약", /적립형/],
  ["간편심사형", /간편심사|간편고지|유병자|3\.?5\.?5/],
  ["중도인출", /계약자적립액인출|적립액인출|적립금인출|중도인출/],
  ["추가납입", /추가납입/],
  ["가입한도", /가입한도|가입금액한도|최저보험료|최고보험료|최소보험료|최저가입|최고가입|보험료한도/],
  ["가입나이", /가입나이|가입연령|가입가능나이|몇세|세까지|세이상|세부터|\d+세.{0,3}가입|가입.{0,6}\d+세|\d+세도/],
  [PAYTABLE_ITEM, /진단비|진단금|진단자금|입원일당|입원비|수술비|사망보험금|재해사망|장해|급부|일당|\d+만원|[천백십]만원|억원|\d+배|뇌혈관|뇌졸중|심근경색|유사암|갑상선암|질환|입원|수술|진단|골절|화상|치매|간병/],
];
const SPEC_CACHE = new Map();

// 상품 분석을 돌려 항목별 원문 줄과 지급기준표 줄을 만듦 (같은 상품·판매일자는 한 번만)
function specOf(p) {
  let R;
  try { R = analyzeProduct(p.key, p.latest.start); } catch (e) { return { items: {}, pay: [], error: e.message }; }
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
    items[def.label] = { lines, none: !!row.none };
  }
  const pay = [];
  (R.payTables || []).forEach(t => {
    (t.structRows || t.rows).forEach(r => pay.push({ text: r.text, doc: r.doc || t.doc, page: r.page, table: t.title }));
    t.notes.forEach(n => pay.push({ text: n.text, doc: n.doc || t.doc, page: n.page, table: t.title, note: true }));
  });
  return { items, pay };
}

async function ensureSpecs(products, progress) {
  const todo = products.filter(p => !SPEC_CACHE.has(p.key + "|" + p.latest.start));
  const docs = todo.flatMap(p => p.latest.docs).filter(d => SOURCE_TYPES.includes(d.docType) && !d.error);
  if (SERVER_MODE) {
    for (let i = 0; i < docs.length; i += 8) {
      await Promise.all(docs.slice(i, i + 8).map(d => ensurePages([d])));
      if (progress) progress(`2/3 기초서류 읽는 중 ${Math.min(i + 8, docs.length)}/${docs.length} (처음 한 번만, 다음부터는 빠름)`);
    }
  }
  todo.forEach(p => SPEC_CACHE.set(p.key + "|" + p.latest.start, specOf(p)));
}
const specFor = p => SPEC_CACHE.get(p.key + "|" + p.latest.start) || { items: {}, pay: [] };

// 금액·숫자 표기 맞추기: 1,000만원 → 1000만원, 10,000원 → 1만원, 천만원 → 1000만원, 오백만원 → 500만원
const KNUM = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
function numNorm(s) {
  return norm(s).replace(/(\d),(?=\d{3})/g, "$1")
    .replace(/([일이삼사오육칠팔구]?)([천백십])([일이삼사오육칠팔구]?)(백|십)?만원/g, (m, a, u, b, u2) =>
      `${(KNUM[a] || 1) * { 천: 1000, 백: 100, 십: 10 }[u] + (b ? KNUM[b] * (u2 === "십" ? 10 : u2 === "백" ? 100 : 1) : 0)}만원`)
    .replace(/(?<![가-힣\d])([일이삼사오육칠팔구])만원/g, (m, a) => `${KNUM[a]}만원`)
    .replace(/(\d+)0000원/g, "$1만원")
    .replace(/(\d+)\.0(?=[^\d]|$)/g, "$1");
}
// 조건 값의 핵심어 (금액은 '원'을 뺀 말도 함께 — 표 칸이 줄바꿈되어 "3만 / 원"처럼 읽히는 경우)
const VALUE_STOP = new Set(["보험금", "지급", "지급하는", "지급하고", "주는", "받는", "금액", "보장", "상품", "보험", "있는", "되는", "가능한", "가능", "경우", "얼마", "얼마야", "나와", "알려", "알려줘",
  "기간", "내용", "조건", "지급기준표", "기준표", "보여줘", "보여", "이상", "이하", "있어", "있나", "얼마인지", "어떻게", "뭐야", "주나", "줘", "하는", "되나", "않는", "않은", "하지", "않고",
  "미리", "낼", "내는", "붙여야", "붙이는", "묻는", "여부", "받으면", "하면", "되면", "그럼", "그러면", "그", "그중", "중에", "건", "것", "거", "있나요", "인가요", "안", "주는건", "상품은", "안에", "내에", "후"]);
function valueTerms(v) {
  const out = [];
  for (const tok of String(v).replace(/(\d),(?=\d{3})/g, "$1").split(/[\s,?!.·/]+/)) for (const m of numNorm(tok).matchAll(/\d+(?:\.\d+)?(?:만원|억원|원|%|세|년|개월|일|회|배|만)?|[가-힣A-Za-z]+/g)) {
    let t = m[0];
    if (!/\d/.test(t)) { t = stemOf(t); if (t.length < 2 || TERM_STOP.has(t) || VALUE_STOP.has(t)) continue; }
    if (!out.includes(t)) out.push(t);
  }
  if (/암/.test(v) && !out.some(x => x.includes("암"))) out.push("암");
  return out;
}
const valueAlts = t => {
  const m = t.match(/^(\d+)배$/);
  if (m) return [`${m[1] * 100}%`, `${(m[1] - 1) * 100}%추가`];
  return [...termAlts(t), ...(/\d만원$/.test(t) ? [t.slice(0, -1)] : [])];
};
// 숫자 조건(1000만원·90일·50% 등)은 모두 있어야 하고, 말은 2개까지는 모두·3개 이상이면 절반 이상 (표 칸·줄바꿈으로 말이 갈라지는 경우)
const termHit = (text, t) => valueAlts(t).some(a => text.includes(a)) || (t.length >= 4 && /^[가-힣]+$/.test(t) && text.includes(t.slice(0, 2)) && text.includes(t.slice(2)));
function hasAll(text, terms) {
  const nums = terms.filter(t => /\d/.test(t)), words = terms.filter(t => !/\d/.test(t));
  if (!nums.every(t => termHit(text, t))) return false;
  const need = words.length <= 2 ? words.length : Math.ceil(words.length / 2);
  return words.filter(t => termHit(text, t)).length >= need;
}

// 표 칸이 줄바꿈되어 "재해사망 / 보험금"처럼 갈라진 짧은 조각은 앞 줄에 붙여 보여 줌
const joinLines = ls => ls.reduce((o, l) => (o && l.text.length <= 3 && !/\d/.test(l.text) ? o + l.text : o + (o ? " / " : "") + l.text), "");

// 지급기준표에서 조건 값이 모두 들어 있는 가장 짧은 구간(1~7줄)
function payMatch(pay, terms) {
  for (let size = 1; size <= 7; size++) // 급부명 칸과 금액 칸이 여러 줄 떨어져 읽히는 표가 있어 최대 7줄
    for (let i = 0; i + size <= pay.length; i++) {
      const w = pay.slice(i, i + size);
      if (w.some(x => x.doc !== w[0].doc)) continue;
      if (hasAll(numNorm(w.map(x => x.text).join("")), terms)) return { doc: w[0].doc, page: w[0].page, text: joinLines(w), matched: terms };
    }
  return null;
}

// 항목 조건 판정: {ok: true/false/null(문서에서 확인 못함), ev: 근거}
function itemCheck(p, plan) {
  const sp = specFor(p);
  if (plan.item === PAYTABLE_ITEM) {
    // 약관에 '보험금 지급기준표'가 없으면 상품 분석의 '보험금 지급사유' 줄(본문 문장)로 확인
    const pay = sp.pay.length ? sp.pay : ((sp.items["보험금 지급사유"] || {}).lines || []);
    if (!pay.length) return { ok: null };
    if (plan.item_value) { const m = payMatch(pay, valueTerms(plan.item_value)); return { ok: !!m, ev: m }; }
    return { ok: plan.item_has !== "없음", ev: { doc: pay[0].doc, page: pay[0].page, text: joinLines(pay.slice(0, 16)), matched: [] } };
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
      const ages = [...all.matchAll(/(\d{1,3})세/g)].map(m => +m[1]);
      const best = it.lines.find(l => /\d+세/.test(l.text)) || it.lines[0];
      return { ok: ages.length ? Math.max(...ages) >= +age[1] : null, ev: { doc: best.doc, page: best.page, text: it.lines.filter(l => /\d+세/.test(l.text)).slice(0, 3).map(l => l.text).join(" / ") || best.text, matched: [`${Math.max(...ages)}세`] } };
    }
    const terms = valueTerms(plan.item_value);
    for (let i = 0; i < it.lines.length; i++) {
      const w = it.lines.slice(i, i + 4); // 표 머리줄과 값 줄이 떨어진 경우
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
  const r = await api("api/ai/chat", { model: AI.model, messages, format: schema || undefined, options: { temperature } });
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
const PLAN_KEYS = ["action", "category", "status", "year_from", "year_to", "product", "text", "field", "value", "group_by", "concept", "item", "item_value", "item_has"]; // + features(배열)·feature_logic
const PLAN_ACTIONS = ["count", "list", "average", "max", "min", "find", "explain"];
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
    value: { type: "string" },
    text: { type: "string" },
    field: { type: "string", enum: ["", ...Object.keys(AI_FIELDS)] },
    group_by: { type: "string", enum: PLAN_GROUPS },
    concept: { type: "string", enum: ["", ...Object.keys(AI_CONCEPTS)] },
    item: { type: "string", enum: ["", ...AI_ITEMS] },
    item_value: { type: "string" },
    item_has: { type: "string", enum: ["", "있음", "없음"] },
  },
  required: [...PLAN_KEYS, "features", "feature_logic"],
});

const plannerPrompt = () => `너는 보험 기초서류 검색 앱의 질문 해석기다. 사용자의 질문을 아래 JSON 조건으로 바꿔라. JSON만 출력한다.
- action: count(개수) | list(목록) | average(평균) | max(최고) | min(최저) | find(문서에 어떤 내용이 있는 상품 찾기) | explain(용어 설명 등 데이터와 무관한 질문)
- category: 상품 분류. 다음 중 하나 또는 "": ${AI_KINDS.join(", ")}
- status: "판매중" | "판매종료"("판매중지", "단종"도 판매종료) | ""
- year_from, year_to: 판매개시 연도 범위 (예: "2020"). 없으면 ""
- product: 특정 상품명 일부 (예: "든든"). 없으면 ""
- features: 다음 특징 중 질문에 나온 것들의 배열(없으면 []): ${FEATURES.map(f => f.name).join(", ")}
- feature_logic: 특징이 여러 개일 때 "and"(모두 해당) 또는 "or"("A 또는 B", "A나 B"처럼 하나라도 해당)
- text: 문서 문장에서 찾아야 할 내용(특징 목록으로 표현이 안 될 때). 예: "사망 시 이미 납입한 보험료에서 인출금액을 차감". 없으면 ""
- field: 문서에서 읽을 값: ${Object.keys(AI_FIELDS).join(", ")} 또는 "". 평균·최고·최저는 field가 꼭 있어야 한다.
- value: field가 보험기간·납입기간일 때 찾을 값(예: "1년", "종신", "80세만기", "10년납", "전기납"). "보험기간 1년짜리"처럼 값 조건이 있으면 꼭 넣는다. 없으면 ""
- group_by: "연도" | "판매상태" | "분류" | "" ("연도별로", "상태별로" 같은 말이 있을 때)
예) "종신보험 판매중지 상품 몇 개야?" → {"action":"count","category":"종신","status":"판매종료","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":""}
예) "판매중인 상품의 평균 예정이율은?" → {"action":"average","category":"","status":"판매중","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"예정이율","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":""}
예) "2023년 이후 나온 저해지형 상품 알려줘" → {"action":"list","category":"","status":"","year_from":"2023","year_to":"","product":"","features":["저해지형"],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":""}
예) "유사암 진단 시 가입금액의 10%를 주는 상품은?" → {"action":"find","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"유사암 진단 시 가입금액의 10% 지급","field":"","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":""}
- concept: 문서에 같은 낱말로 적혀 있지 않고 표·구조로 판단해야 하는 내용. ${Object.entries(AI_CONCEPTS).map(([k, v]) => `"${k}"(${v.desc})`).join(", ")} 또는 "". concept를 쓰면 text는 ""로 둔다.
예) "종신 상품 중 사망보험금을 보험기간에 따라 다르게 주는 상품 있어?" → {"action":"find","category":"종신","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"사망보험금 기간별 차등","item":"","item_value":"","item_has":""}
예) "종신보험 중 추가납입 또는 중도인출이 되는 상품 알려줘" → {"action":"list","category":"종신","status":"","year_from":"","year_to":"","product":"","features":["추가납입","중도인출"],"feature_logic":"or","text":"","field":"","value":"","group_by":"","concept":"","item":"","item_value":"","item_has":""}
예) "보험기간 1년짜리 상품 알려줘" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"보험기간","value":"1년","group_by":"","concept":"","item":"","item_value":"","item_has":""}
예) "10년납 종신보험 몇 개야?" → {"action":"count","category":"종신","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"납입기간","value":"10년납","group_by":"","concept":"","item":"","item_value":"","item_has":""}
- item: 사업방법서 항목 또는 약관 보험금 지급기준표에 관한 조건. 다음 중 하나 또는 "": ${AI_ITEMS.join(", ")}
  (진단비·입원일당·수술비·사망보험금 금액, 지급사유는 "${PAYTABLE_ITEM}")
- item_has: 그 항목이 "있음"(있는/되는/가능한) 또는 "없음"(없는/안 되는). 값 조건이나 단순 조회면 ""
- item_value: 항목 안에서 찾을 값·말 (예: "70세", "고액 할인", "암진단비 1000만원", "입원일당 3만원", "90일"). 없으면 ""
예) "유지보너스 있는 상품 알려줘" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"유지보너스","item_value":"","item_has":"있음"}
예) "암 진단 시 1000만원 주는 상품은?" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"${PAYTABLE_ITEM}","item_value":"암 진단 1000만원","item_has":""}
예) "70세까지 가입되는 상품" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"가입나이","item_value":"70세","item_has":""}
예) "튼튼간편건강보험 면책 조건 알려줘" → {"action":"list","category":"","status":"","year_from":"","year_to":"","product":"튼튼간편건강","features":[],"feature_logic":"and","text":"","field":"","value":"","group_by":"","concept":"","item":"면책","item_value":"","item_has":""}
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
  if (!AI_FIELDS[out.field]) out.field = "";
  out.value = out.value && AI_FIELDS[out.field] && AI_FIELDS[out.field].terms ? termValue(out.value, AI_FIELDS[out.field].terms) : "";
  if (!PLAN_GROUPS.includes(out.group_by)) out.group_by = "";
  if (!AI_CONCEPTS[out.concept]) out.concept = "";
  if (!AI_ITEMS.includes(out.item)) { out.item = ""; out.item_value = ""; out.item_has = ""; }
  if (!["있음", "없음"].includes(out.item_has)) out.item_has = /없/.test(out.item_has) ? "없음" : /있/.test(out.item_has) ? "있음" : "";
  if (out.item) out.text = "";
  if (out.concept) { out.text = ""; if (out.action === "list") out.action = "find"; }
  ["year_from", "year_to"].forEach(k => { const m = out[k].match(/(19|20)\d{2}/); out[k] = m ? m[0] : ""; });
  if (["average", "max", "min"].includes(out.action) && !out.field) out.action = "list";
  return out;
}

// 기간에 따라 급부(보험금)가 달라지는지 묻는 질문인지 (구조 판정이 필요한 질문)
const conceptAsked = raw => /(기간|년|경과|시점|이내|이후).*(다르|다른|달라|달리|차등|차이|증가|감소|늘어|줄어|변하|바뀌)|체증|체감|계단식/.test(raw) && /사망|보험금|급부|지급/.test(raw);
// 이전 질문을 이어받는 질문인지 ("그 중", "그럼", "거기서" …)
const FOLLOW_UP_RE = /^\s*(그\s*중|그중|그럼|그러면|그리고|거기서|여기서|이\s*중|그\s*상품|그것|그거|위\s*상품|방금|앞의|그\s*결과)|그\s*중에|이\s*중에|위에서|방금\s*(찾은|나온)/;

// 로컬 AI가 없을 때: 정해진 표현으로 해석
function rulePlan(q) {
  const Q = interpretQuestion(q.replace(/평균\s*공시\s*이율/g, "평균이율"), true), raw = norm(q);
  const p = { action: "list", category: Q.category, status: Q.status, year_from: Q.from.slice(0, 4), year_to: Q.to.slice(0, 4),
    product: "", features: Q.features.map(f => f.name), feature_logic: /또는|혹은|이나|거나|둘중|중하나/.test(raw) ? "or" : "and",
    text: "", field: "", group_by: "" };
  if (/몇개|몇건|몇종|개수|건수|얼마나있/.test(raw)) p.action = "count";
  const rawA = raw.replace(/최저(보험료|가입금액|가입|보증이율|보증)|최고(보험료|가입금액|가입|한도)|최대\d+|최대한도|평균공시이율/g, ""); // 항목 이름 속 '최저·최고'는 계산 요청이 아님
  if (/평균/.test(rawA)) p.action = "average";
  else if (/최고|최대|가장높|제일높/.test(rawA)) p.action = "max";
  else if (/최저|최소|가장낮|제일낮/.test(rawA)) p.action = "min";
  p.field = Object.keys(AI_FIELDS).find(f => AI_FIELDS[f].words.some(w => raw.includes(w))) || "";
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
  if (y2) { p.year_to = y2[1]; p.year_from = ""; }
  const prod = productInQuestion(raw);
  if (prod) p.product = prod;
  // "예정이율이 뭐야?"처럼 용어 뜻을 묻는 질문
  if (p.field && !prod && p.action === "list" && /뭐야|뭔가요|무엇인가|무엇이야|이란|란뭐|뜻|의미|설명해/.test(raw)) p.action = "explain";
  // 남은 핵심어가 2개 이상이면 문서 문장에서 찾을 내용
  const rest = questionTerms(q).filter(t => !(p.field && /^\d{1,3}(년|세)/.test(t)) && !/짜리|^만기$/.test(t) && !/^(판매|종료|중지|단종|현재|있나요|있습니|종이야|여부|묻는|몇|개수|건수|개야|개냐|개지|개인지|평균|최고|최저|최대|최소|가장|제일|목록|전체|모두|얼마|연도별|년도별|상태별|판매상태별|분류별|이후|이전|부터|까지)/.test(t) &&
    !Object.values(AI_FIELDS).some(f => f.words.some(w => t.includes(w))) && !(prod && prod.includes(t)) &&
    !Q.features.some(f => f.phrases.some(ph => t.includes(ph) || ph.includes(t))));
  if (rest.length >= 2) { p.text = rest.join(" "); if (p.action === "list") p.action = "find"; }
  // 기간에 따라 급부(보험금)가 달라지는지 묻는 질문 → 개념 판정
  if (conceptAsked(raw)) {
    p.concept = /사망/.test(raw) ? "사망보험금 기간별 차등" : "보험금 기간별 차등";
    if (["보험기간", "납입기간"].includes(p.field) && !p.value && !["average", "max", "min"].includes(p.action)) p.field = ""; // '보험기간 중'은 값 요청이 아님
    p.features = p.features.filter(n => n !== "체증형"); // '체증'이라고 적히지 않은 계단식 지급도 찾도록 구조 판정으로 대신
  }
  // 사업방법서 항목·지급기준표 조건
  if (!p.concept && !["average", "max", "min"].includes(p.action) && !(p.field && p.value)) {
    const featPhr = p.features.flatMap(n => FEATURES.find(f => f.name === n).phrases);
    const rawI = featPhr.reduce((r, ph) => r.split(ph).join(" "), raw); // '사망보험금늘어나는'(체증형) 같은 특징 표현은 항목 판정에서 뺌
    const featItem = p.features.find(n => AI_ITEMS.includes(n));
    // 항목 이름이 질문에 분명히 있으면 그 항목, 병명·금액처럼 넓은 말로만 걸리면 질문에서 알아들은 특징 항목(예: 간편심사형)을 우선
    const explicit = ITEM_WORDS.findIndex(([name, re]) => re.test(rawI) && !p.features.includes(name));
    const generic = explicit === ITEM_WORDS.length - 1;
    const hit = featItem && (explicit === -1 || generic) ? ITEM_WORDS.find(([name]) => name === featItem) : ITEM_WORDS[explicit];
    if (hit) {
      const [item, re] = hit;
      p.item = item;
      if (p.field === "가입나이" || (p.field && item !== PAYTABLE_ITEM)) p.field = "";
      // '지급하지 않는'처럼 조건 속 부정은 빼고, 항목 자체가 없는지 물을 때만 '없음'
      p.item_has = /없는|없어|없음|없나|안되|불가|미적용|해당없|아닌|아니/.test(raw.replace(/(지급|보장|보상|해당)하지않/g, "")) ? "없음" : "";
      // 값: 항목 말·질문 말투·조건 말을 뺀 나머지 (지급기준표는 진단비·금액 같은 말이 곧 값)
      const drop = item === PAYTABLE_ITEM || item === "가입한도" ? null : item === "면책" ? /면책|보장개시|부담보|책임개시|보장하지않|지급하지않|안주|못받/ : new RegExp(re.source);
      const words = q.replace(/(\d),(?=\d{3})/g, "$1").split(/[\s,?!.]+/).filter(Boolean);
      const kept = words.filter(w => {
        const c = norm(w), st = stemOf(c);
        if (drop && drop.test(c) && !/\d/.test(c)) return false;
        if (TERM_STOP.has(c) || TERM_STOP.has(st) || VALUE_STOP.has(st) || st.length < 1) return false;
        if (/^(몇|개수|건수|개야|개냐|개지|개인지|몇개|목록|전체|모두|얼마|있|없|되|안|가능|불가|어떻|어때|알려|보여|찾아|조건|내용|중에?|중에서|이상|이하|까지만?)$/.test(st)) return false;
        if (p.category && (c === p.category || c === p.category + "보험" || c === p.category + "상품")) return false;
        if (p.status && /판매/.test(c)) return false;
        if (/^(19|20)\d{2}년/.test(c)) return false;
        if (p.product && p.product.includes(st)) return false;
        if (p.features.some(n => FEATURES.find(f => f.name === n).phrases.some(ph => c.includes(ph)))) return false;
        return true;
      }).map(w => stemOf(norm(w)));
      if (item === "가입나이") { const a = raw.match(/(\d{1,3})세/); p.item_value = a ? `${a[1]}세` : ""; }
      else p.item_value = p.item_has === "없음" ? "" : kept.filter(w => w.length >= 1).join(" ");
      if (featItem && !p.item_value) { p.item = ""; p.item_has = ""; } // 특징만 물은 경우는 특징 조건으로 충분
      else if (!p.item_value && p.item_has !== "없음" && /있|되는|가능|적용|포함|주는|받|하는/.test(raw)) p.item_has = "있음";
      // "암 진단비"처럼 병명이 분류 말과 같으면 분류 조건으로 보지 않음 ("암보험 중 …"만 분류)
      if (p.category === "암" && !/암(보험|상품)/.test(raw) || (item === PAYTABLE_ITEM && p.category && !new RegExp(p.category + "(보험|상품)").test(raw))) {
        if (!p.item_value.includes(p.category)) p.item_value = (p.category + " " + p.item_value).trim();
        p.category = "";
      }
      p.text = "";
      if (p.action === "find") p.action = "list";
    }
  }
  return cleanPlan(p);
}

// 질문 속 상품명: 상품명과 가장 길게 겹치는 부분(4글자 이상, '종신보험' 같은 분류 말만 겹치면 제외)
function productInQuestion(raw) {
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
    const core = c.replace(/보험|종신|정기|건강|연금|저축|변액|무배당|\(무\)|상품/g, "");
    if (c.length >= 4 && core.length >= 2 && c.length > best.length) best = c;
  }
  return best;
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

async function executePlan(plan, progress) {
  let products = CATALOG_FOR_AI();
  const notes = [];
  if (plan.category) products = products.filter(p => p.kind === plan.category);
  if (plan.status) products = products.filter(p => p.status === plan.status);
  if (plan.year_from) products = products.filter(p => yearOf(p) && yearOf(p) >= plan.year_from);
  if (plan.year_to) products = products.filter(p => yearOf(p) && yearOf(p) <= plan.year_to);
  if (plan.product) products = products.filter(p => norm(p.name).includes(norm(plan.product).replace(/^\(무\)/, "")));
  if (plan.features.length) {
    const fs = plan.features.map(n => FEATURES.find(x => x.name === n)).filter(Boolean);
    products = products.filter(p => plan.feature_logic === "or" ? fs.some(f => p.feat[f.id]) : fs.every(f => p.feat[f.id]));
  }
  // 문서 문장 조건: 핵심어가 한 문장에 모인 상품만
  const evidence = new Map();
  if (plan.text) {
    const terms = questionTerms(plan.text);
    if (terms.length) {
      const r = await sentenceAnswer({ Q: { terms }, form: { keyword: "", from: "", to: "", category: "", status: "", docType: "" } });
      groupSentenceHits(r.hits).forEach(g => evidence.set(g.key, g.hits));
      products = products.filter(p => evidence.has(p.key));
      notes.push(`문장 조건: 핵심어 ${terms.join("·")} 중 ${termsNeeded(terms.length)}개 이상이 한 문장에`);
    }
  }
  if (plan.concept) {
    const ev = await conceptEvidence(products, plan.concept);
    ev.forEach((v, k) => evidence.set(k, v));
    products = products.filter(p => ev.has(p.key));
    notes.push(`구조 판정: ${AI_CONCEPTS[plan.concept].desc} — 급부 말 뒤에 서로 다른 기간 표현 2개 이상과 금액(또는 증감) 표현이 함께 있는 원문 (규칙 판정이니 원문 확인)`);
  }
  let itemEv = null, itemUnread = [];
  if (plan.item) {
    await ensureSpecs(products, progress);
    itemEv = new Map();
    const keep = [];
    for (const p of products) {
      const r = itemCheck(p, plan);
      if (r.ok === null) { itemUnread.push(p); continue; }
      if (r.ok) { keep.push(p); if (r.ev) itemEv.set(p.key, r.ev); }
    }
    products = keep;
    notes.push(`항목 조건: ${plan.item}${plan.item_has ? ` ${plan.item_has}` : ""}${plan.item_value ? ` — '${plan.item_value}'` : ""} (상품 분석과 같은 규칙으로 최신 판매일자 문서를 읽어 확인` +
      (plan.item === "가입나이" && /\d+세/.test(plan.item_value) ? ", 최고 가입나이 기준" : "") + ")");
  }
  const values = plan.field ? await fieldValues(products, plan.field) : new Map();
  let unread = [];
  if (plan.value) {
    unread = products.filter(p => !values.get(p.key));
    const noValue = unread.length;
    products = products.filter(p => { const v = values.get(p.key); return v && v.tokens && v.tokens.includes(plan.value); });
    notes.push(`값 조건: 문서에서 읽은 ${plan.field} 값에 '${plan.value}'가 있는 상품` + (noValue ? ` (${plan.field}을 문서에서 못 읽은 상품 ${noValue}개는 제외 — 원문 확인 필요)` : ""));
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
  p.product && `상품 ${p.product}`, p.features.length && `특징 ${p.features.join(p.feature_logic === "or" ? " 또는 " : " 그리고 ")}`, p.text && `문서 내용 "${p.text}"`,
  p.concept && `구조 ${p.concept}`, p.item && `${p.item}${p.item_has ? " " + p.item_has : ""}${p.item_value ? `: ${p.item_value}` : ""}`, p.field && (p.value ? `${p.field} ${p.value}` : `값 ${p.field}`), p.group_by && `${p.group_by}별`].filter(Boolean);

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
        ...(result.itemEv && result.itemEv.get(x.key) ? { [p.item]: result.itemEv.get(x.key).text.slice(0, 220) } : {}) };
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
    (p.field ? `<th>${esc(p.field)}</th>` : "") + (result.evidence.size ? `<th>근거 문장</th>` : "") + (result.itemEv ? `<th>${esc(p.item)}</th>` : "") + `<th>기초서류</th></tr></thead><tbody>` +
    result.products.slice(0, MAX).map((x, i) => {
      const v = result.values.get(x.key), ev = result.evidence.get(x.key);
      const link = (d, page, label) => `<a href="#" data-open="${DOCS.indexOf(d)}" data-page="${page}">${esc(label)}</a>`;
      const vCell = !p.field ? "" : `<td>${v ? `<b>${esc(f.text ? v.value : v.value + f.unit)}</b><div class="path">${link(v.doc, v.page, `${v.doc.docType}(${v.start}) p.${v.page}`)}${v.latest ? "" : " · 이전 판"}</div>` : `<span class="muted">문서에서 못 찾음</span>`}</td>`;
      const eCell = !result.evidence.size ? "" : `<td>${ev ? `${link(ev[0].doc, ev[0].page, `${ev[0].doc.docType}(${ev[0].doc.start || "?"}) p.${ev[0].page}`)}${ev[0].latest === false ? " · 이전 판" : ""} ${highlight(ev[0].text, ev[0].matched)}` : ""}</td>`;
      const iv = result.itemEv ? result.itemEv.get(x.key) : null;
      const iCell = !result.itemEv ? "" : `<td>${iv ? (iv.doc ? `${link(iv.doc, iv.page, `${iv.doc.docType}(${iv.doc.start || "?"}) p.${iv.page}`)} ` : "") + highlight(iv.text.slice(0, 600), iv.matched || []) : `<span class="muted">문서에서 못 찾음</span>`}</td>`;
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
          plan.features = plan.features.filter(n => n !== "체증형");
          if (!plan.category && rp.category) plan.category = rp.category;
        }
        if (!plan.value && rp.value) { plan.field = rp.field; plan.value = rp.value; filled.push("값 조건"); }
        if (!plan.item && rp.item && !plan.concept) {
          Object.assign(plan, { item: rp.item, item_value: rp.item_value, item_has: rp.item_has, text: "" });
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
    const result = await executePlan(plan, progress);
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

const AI_EXAMPLES = ["종신보험 중 판매중지된 상품은 몇 개야?", "판매중인 상품의 평균 예정이율은?", "연도별로 상품이 몇 개 나왔어?",
  "사망 시 이미 납입한 보험료에서 인출금액을 차감한 금액을 지급하는 상품은?", "2023년 이후 나온 종신보험 목록 알려줘"];
$("aiExamples").innerHTML = "예시: " + AI_EXAMPLES.map(x => `<button type="button" class="mini" data-ai-ex="${esc(x)}">${esc(x)}</button>`).join(" ");
$("aiExamples").addEventListener("click", e => {
  const b = e.target.closest("button[data-ai-ex]");
  if (b) askAi(b.dataset.aiEx, "new");
});

syncAiButtons();
aiCheck();
