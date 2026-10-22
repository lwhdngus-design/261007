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
  "보험기간": { words: ["보험기간"], text: true },
  "납입기간": { words: ["납입기간"], text: true },
};

// 낱말이 아니라 문서 구조로 판정하는 개념 — 예) 사망보험금이 경과기간에 따라 달라지는 상품(체증형·계단식·체감)
// 판정: 급부 말(anchor) 뒤 400자 안에 서로 다른 기간 표현(○년 경과·이내·미만·이후…) 2개 이상 +
//       서로 다른 금액 표현(○%·보험가입금액·○원) 2개 이상(또는 '매1년마다 …를 더한', 체증·체감 같은 증감 표현)
const PERIOD_RE = /\d+년(?:경과|이내|미만|이후|초과|지난|까지|이상|동안|시점)/g;
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
const PLAN_KEYS = ["action", "category", "status", "year_from", "year_to", "product", "text", "field", "group_by", "concept"]; // + features(배열)·feature_logic
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
    text: { type: "string" },
    field: { type: "string", enum: ["", ...Object.keys(AI_FIELDS)] },
    group_by: { type: "string", enum: PLAN_GROUPS },
    concept: { type: "string", enum: ["", ...Object.keys(AI_CONCEPTS)] },
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
- group_by: "연도" | "판매상태" | "분류" | "" ("연도별로", "상태별로" 같은 말이 있을 때)
예) "종신보험 판매중지 상품 몇 개야?" → {"action":"count","category":"종신","status":"판매종료","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","group_by":"","concept":""}
예) "판매중인 상품의 평균 예정이율은?" → {"action":"average","category":"","status":"판매중","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"예정이율","group_by":"","concept":""}
예) "2023년 이후 나온 저해지형 상품 알려줘" → {"action":"list","category":"","status":"","year_from":"2023","year_to":"","product":"","features":["저해지형"],"feature_logic":"and","text":"","field":"","group_by":"","concept":""}
예) "유사암 진단 시 가입금액의 10%를 주는 상품은?" → {"action":"find","category":"","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"유사암 진단 시 가입금액의 10% 지급","field":"","group_by":"","concept":""}
- concept: 문서에 같은 낱말로 적혀 있지 않고 표·구조로 판단해야 하는 내용. ${Object.entries(AI_CONCEPTS).map(([k, v]) => `"${k}"(${v.desc})`).join(", ")} 또는 "". concept를 쓰면 text는 ""로 둔다.
예) "종신 상품 중 사망보험금을 보험기간에 따라 다르게 주는 상품 있어?" → {"action":"find","category":"종신","status":"","year_from":"","year_to":"","product":"","features":[],"feature_logic":"and","text":"","field":"","group_by":"","concept":"사망보험금 기간별 차등"}
예) "종신보험 중 추가납입 또는 중도인출이 되는 상품 알려줘" → {"action":"list","category":"종신","status":"","year_from":"","year_to":"","product":"","features":["추가납입","중도인출"],"feature_logic":"or","text":"","field":"","group_by":"","concept":""}
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
  if (!PLAN_GROUPS.includes(out.group_by)) out.group_by = "";
  if (!AI_CONCEPTS[out.concept]) out.concept = "";
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
  const Q = interpretQuestion(q, true), raw = norm(q);
  const p = { action: "list", category: Q.category, status: Q.status, year_from: Q.from.slice(0, 4), year_to: Q.to.slice(0, 4),
    product: "", features: Q.features.map(f => f.name), feature_logic: /또는|혹은|이나|거나|둘중|중하나/.test(raw) ? "or" : "and",
    text: "", field: "", group_by: "" };
  if (/몇개|몇건|몇종|개수|건수|얼마나있/.test(raw)) p.action = "count";
  if (/평균/.test(raw)) p.action = "average";
  else if (/최고|최대|가장높|제일높/.test(raw)) p.action = "max";
  else if (/최저|최소|가장낮|제일낮/.test(raw)) p.action = "min";
  p.field = Object.keys(AI_FIELDS).find(f => AI_FIELDS[f].words.some(w => raw.includes(w))) || "";
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
  const rest = questionTerms(q).filter(t => !/^(몇|개수|건수|평균|최고|최저|최대|최소|가장|제일|목록|전체|모두|얼마|연도별|상태별|분류별|이후|이전|부터|까지)/.test(t) &&
    !Object.values(AI_FIELDS).some(f => f.words.some(w => t.includes(w))) && !(prod && prod.includes(t)) &&
    !Q.features.some(f => f.phrases.some(ph => t.includes(ph) || ph.includes(t))));
  if (rest.length >= 2) { p.text = rest.join(" "); if (p.action === "list") p.action = "find"; }
  // 기간에 따라 급부(보험금)가 달라지는지 묻는 질문 → 개념 판정
  if (conceptAsked(raw)) {
    p.concept = /사망/.test(raw) ? "사망보험금 기간별 차등" : "보험금 기간별 차등";
    if (["보험기간", "납입기간"].includes(p.field) && !["average", "max", "min"].includes(p.action)) p.field = ""; // '보험기간 중'은 값 요청이 아님
    p.features = p.features.filter(n => n !== "체증형"); // '체증'이라고 적히지 않은 계단식 지급도 찾도록 구조 판정으로 대신
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
async function nearWord(docs, words) {
  const out = new Map(); // doc → [{page, text}]
  if (SERVER_MODE) {
    const ids = docs.filter(d => d.id).map(d => d.id), byId = new Map(docs.map(d => [d.id, d]));
    const res = ids.length ? (await api("api/near", { ids, words })).hits : [];
    res.forEach(h => { const d = byId.get(h.id); if (d) { if (!out.has(d)) out.set(d, []); out.get(d).push(h); } });
  } else {
    docs.forEach(d => (d.pages || []).forEach((t, pi) => {
      const comp = norm(t);
      for (const w of words) {
        const i = comp.indexOf(w);
        if (i !== -1) { if (!out.has(d)) out.set(d, []); out.get(d).push({ page: pi + 1, text: comp.slice(i, i + 80) }); break; }
      }
    }));
  }
  return out;
}

// 상품별 값: 최신 판매일자 문서부터 찾아 보고, 없으면 이전 판매일자로
async function fieldValues(products, fieldName) {
  const f = AI_FIELDS[fieldName];
  const docs = products.flatMap(p => p.versions.flatMap(v => v.docs));
  const near = await nearWord(docs, f.words.map(norm));
  const res = new Map();
  for (const p of products) {
    let found = null;
    for (const v of p.versions) {
      for (const d of [...v.docs].sort(byDocPriority)) {
        for (const h of near.get(d) || []) {
          const w = norm(h.text);
          const value = f.text ? w.slice(0, 60) : f.parse(w);
          if (value !== null && value !== "") { found = { value, doc: d, page: h.page, text: h.text, start: v.start, latest: v === p.versions[0] }; break; }
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

async function executePlan(plan) {
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
  const values = plan.field ? await fieldValues(products, plan.field) : new Map();
  const result = { plan, products, evidence, values, total: products.length, notes };
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
  p.concept && `구조 ${p.concept}`, p.field && `값 ${p.field}`, p.group_by && `${p.group_by}별`].filter(Boolean);

function factsFor(result) {
  const p = result.plan, f = AI_FIELDS[p.field];
  const facts = {
    조건: planText(p).join(", ") || "전체", 기준: `연결된 기초서류 PDF ${DOCS.length}개 · 상품 ${CATALOG_FOR_AI().length}개`,
    상품수: result.total,
    상품: result.products.slice(0, 25).map(x => {
      const v = result.values.get(x.key), ev = result.evidence.get(x.key);
      return { 상품명: x.name, 분류: x.kind, 판매상태: x.status, 최신판매일자: x.latest.start,
        ...(v ? { [p.field]: f.text ? v.value : `${v.value}${f.unit}`, 근거: `${v.doc.docType} p.${v.page}` } : p.field ? { [p.field]: "문서에서 못 찾음" } : {}),
        ...(ev ? { 근거문장: ev[0].text.slice(0, 220), 문장근거: `${ev[0].doc.docType}(${ev[0].doc.start || "?"}) p.${ev[0].page}` } : {}) };
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
  if (!result.total) return `조건(${cond})에 맞는 상품을 찾지 못했습니다.`;
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
  if (!result.products.length) return html;
  const SHOW = 30;
  html += `<div class="table-scroll"><table class="ai-table"><thead><tr><th>상품명</th><th>분류</th><th>판매상태</th><th>최신 판매일자</th>` +
    (p.field ? `<th>${esc(p.field)}</th>` : "") + (result.evidence.size ? `<th>근거 문장</th>` : "") + `<th>기초서류</th></tr></thead><tbody>` +
    result.products.slice(0, SHOW).map(x => {
      const v = result.values.get(x.key), ev = result.evidence.get(x.key);
      const link = (d, page, label) => `<a href="#" data-open="${DOCS.indexOf(d)}" data-page="${page}">${esc(label)}</a>`;
      const vCell = !p.field ? "" : `<td>${v ? `<b>${esc(f.text ? v.value : v.value + f.unit)}</b><div class="path">${link(v.doc, v.page, `${v.doc.docType}(${v.start}) p.${v.page}`)}${v.latest ? "" : " · 이전 판"}</div>` : `<span class="muted">문서에서 못 찾음</span>`}</td>`;
      const eCell = !result.evidence.size ? "" : `<td>${ev ? `${link(ev[0].doc, ev[0].page, `${ev[0].doc.docType}(${ev[0].doc.start || "?"}) p.${ev[0].page}`)}${ev[0].latest === false ? " · 이전 판" : ""} ${highlight(ev[0].text, ev[0].matched)}` : ""}</td>`;
      return `<tr><td><button type="button" class="linkbtn" data-analyze="${esc(x.key)}" data-start="${esc(x.latest.start)}">${esc(x.name)}</button></td>` +
        `<td>${esc(x.kind)}</td><td>${stBadge(x.status, x.latest.statusBy)}</td><td>${esc(x.latest.start || "")}</td>${vCell}${eCell}<td>${docLinksHtml(x.latest.docs)}</td></tr>`;
    }).join("") + `</tbody></table></div>` + (result.total > SHOW ? `<p class="note">외 ${result.total - SHOW}개</p>` : "");
  return html;
}

function addTurn(q) {
  const el = document.createElement("div");
  el.className = "ai-turn";
  el.innerHTML = `<div class="ai-q">${esc(q)}</div><div class="ai-a"><p class="muted ai-progress">질문 해석 중…</p></div>`;
  $("aiLog").appendChild(el);
  el.scrollIntoView({ block: "end", behavior: "smooth" });
  return el.querySelector(".ai-a");
}

async function askAi(q) {
  if (aiBusy || !q.trim()) return;
  if (!DOCS.length) { addTurn(q).innerHTML = `<p class="warn">기초서류가 아직 연결되지 않았습니다. 연결(또는 샘플 읽기)이 끝난 뒤 물어보세요.</p>`; return; }
  aiBusy = true; $("aiSend").disabled = true;
  const box = addTurn(q), t0 = performance.now();
  const progress = t => { const p = box.querySelector(".ai-progress"); if (p) p.textContent = t; };
  const useAi = AI.ok && AI.model;
  let plan, by = "규칙 해석", answer, warn = "";
  try {
    if (useAi) {
      progress(`1/3 로컬 AI(${AI.model})가 질문을 조건으로 바꾸는 중… (PC 사양에 따라 수십 초)`);
      const followUp = FOLLOW_UP_RE.test(q) && AI_HISTORY.length > 0;
      const prev = followUp ? AI_HISTORY.slice(-1).map(h => `이전 질문: ${h.q}\n이전 조건: ${JSON.stringify(h.plan)}`).join("\n") : "";
      try {
        const raw = await aiChat([{ role: "system", content: plannerPrompt() }, { role: "user", content: (prev ? prev + "\n\n" : "") + "질문: " + q }], planSchema());
        plan = cleanPlan(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
        by = `로컬 AI 해석 (${AI.model})`;
        // 안전장치: AI가 놓친 조건을 규칙 해석으로 보완 (구조 판정, 또는 AI 조건이 하나도 없을 때)
        const rp = rulePlan(q), filled = [];
        // 질문에 없는 구조 판정은 뺌 (이전 질문에서 잘못 이어받는 것 방지)
        const prevConcept = followUp && AI_HISTORY[AI_HISTORY.length - 1].plan.concept;
        if (plan.concept && !conceptAsked(norm(q)) && plan.concept !== prevConcept) { plan.concept = ""; filled.push("구조 판정 제외"); if (plan.action === "find" && !plan.text) plan.action = "list"; }
        if (!plan.concept && rp.concept) {
          plan.concept = rp.concept; plan.text = ""; filled.push("구조 판정");
          if (plan.action === "list") plan.action = "find";
          plan.features = plan.features.filter(n => n !== "체증형");
          if (!plan.category && rp.category) plan.category = rp.category;
        }
        const conds = x => ["category", "status", "year_from", "year_to", "product", "text", "field", "concept"].filter(k => x[k]).length + (x.features.length ? 1 : 0);
        if (!conds(plan) && conds(rp)) { plan = { ...rp, action: plan.action === "list" ? rp.action : plan.action }; filled.push("조건 전체"); }
        if (followUp) by += " · 이전 질문 조건 이어받음";
        if (filled.length) by += ` + 규칙 보완(${filled.join("·")})`;
      } catch (e) {
        plan = rulePlan(q); warn = `AI 해석 실패(${e.message}) → 규칙 해석으로 대신함`;
      }
    } else plan = rulePlan(q);
    progress("2/3 앱이 상품 목록·원문에서 계산하는 중…");
    const result = await executePlan(plan);
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
  } catch (e) {
    box.innerHTML = `<p class="warn">답변 실패: ${esc(e.message)}</p>`;
  } finally {
    aiBusy = false; $("aiSend").disabled = false;
  }
}

$("aiForm").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("aiInput").value;
  $("aiInput").value = "";
  askAi(q);
});
$("aiClear").addEventListener("click", () => { $("aiLog").innerHTML = ""; AI_HISTORY.length = 0; });

const AI_EXAMPLES = ["종신보험 중 판매중지된 상품은 몇 개야?", "판매중인 상품의 평균 예정이율은?", "연도별로 상품이 몇 개 나왔어?",
  "사망 시 이미 납입한 보험료에서 인출금액을 차감한 금액을 지급하는 상품은?", "2023년 이후 나온 종신보험 목록 알려줘"];
$("aiExamples").innerHTML = "예시: " + AI_EXAMPLES.map(x => `<button type="button" class="mini" data-ai-ex="${esc(x)}">${esc(x)}</button>`).join(" ");
$("aiExamples").addEventListener("click", e => {
  const b = e.target.closest("button[data-ai-ex]");
  if (b) askAi(b.dataset.aiEx);
});

aiCheck();
