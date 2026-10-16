// 질문 검색 — "제1보기와 제2보기가 구분된 종신보험이 뭐였지?" 같은 문장을 특징·조건으로 해석해 상품을 찾음
// 오프라인 규칙 기반: 특징 사전(dummy-data/features.csv)과 분류·판매상태·연도 표현을 대조합니다.
// 특징 사전에 없는 질문은 '문장 질문 검색': 질문에서 핵심어를 뽑아, 핵심어가 한 문장 안에 모여 있는 원문을 찾습니다.

// ---------- 특징 사전 ----------
const FEATURES = DB.features.map(r => ({
  id: r.feature_id,
  name: r.feature_name,
  phrases: r.question_phrases.split(";").map(norm).filter(Boolean),
  // 문서 패턴은 공백 제거 본문에 적용, 여러 개면 모두 있어야 일치
  patterns: r.doc_patterns.split(";").filter(Boolean).map(p => new RegExp(p, "i")),
}));

const featureMatches = (f, compactText) => f.patterns.every(re => re.test(compactText));

const CATEGORY_WORDS = [...new Set([
  ...DB.products.map(p => mainCategory(p.category)),
  "종신", "정기", "건강", "암", "연금", "저축", "간병", "실손", "변액", "유니버셜", "CI",
])].map(c => ({ label: c, key: norm(c) })).sort((a, b) => b.key.length - a.key.length);

// 해석에 쓰지 않는 말 (질문 끝맺음·조사 등) — 남은 말 표시에서만 제외
const STOP_WORDS = ["보험료납입기간", "납입기간", "보험료", "나눠져있는", "나뉘어진", "나눠진", "으로", "과", "구분되어있는", "구분되어있던", "나뉘어있는", "구분된", "구분", "뭐였지", "뭐였더라", "뭐지", "무엇",
  "어떤", "있는", "있던", "되어", "보험", "상품", "알려줘", "찾아줘", "였지", "인가", "였나", "이었지", "뭐",
  "와", "과", "가", "이", "은", "는", "을", "를", "의", "에", "에서", "로", "도", "만", "요", "?", ".", "!", ","]
  .map(norm).sort((a, b) => b.length - a.length);

// ---------- 질문 해석 ----------
const IGNORED = new Set(); // 사용자가 × 로 끈 해석 (질문이 바뀌면 초기화)
let lastQuestion = "";

// pure: 검색창과 관계없이 해석만 (AI 질문 화면용 — 검색창의 × 상태를 건드리지 않음)
function interpretQuestion(text, pure = false) {
  const raw = norm(text);
  const IGN = pure ? new Set() : IGNORED;
  if (!pure && raw !== lastQuestion) { IGNORED.clear(); lastQuestion = raw; }
  const Q = { raw, features: [], category: "", status: "", from: "", to: "", chips: [], leftover: [] };
  if (!raw) return Q;
  const taken = [];
  const free = (s, e) => !taken.some(([a, b]) => s < b && e > a);
  const chip = (key, kind, label) => {
    const ignored = IGN.has(key);
    if (!Q.chips.some(c => c.key === key)) Q.chips.push({ key, kind, label, ignored });
    return !ignored;
  };

  // 1) 특징: 긴 표현부터 먼저 차지 (예: '비갱신형'이 '갱신형'보다 우선)
  const cands = [];
  FEATURES.forEach(f => f.phrases.forEach(p => {
    for (let i = raw.indexOf(p); i !== -1; i = raw.indexOf(p, i + 1)) cands.push({ f, s: i, e: i + p.length });
  }));
  cands.sort((a, b) => (b.e - b.s) - (a.e - a.s) || a.s - b.s);
  for (const c of cands) {
    if (!free(c.s, c.e)) continue;
    taken.push([c.s, c.e]);
    if (chip("f:" + c.f.id, "특징", c.f.name) && !Q.features.includes(c.f)) Q.features.push(c.f);
  }

  // 2) 판매상태
  for (const [re, st] of [[/판매종료|판매중지|판매안하는|단종/, "판매종료"], [/판매중|현재판매|판매하는|판매되는/, "판매중"]]) {
    const m = raw.match(re);
    if (m && free(m.index, m.index + m[0].length)) {
      taken.push([m.index, m.index + m[0].length]);
      if (chip("status", "판매상태", st)) Q.status = st;
      break;
    }
  }

  // 3) 연도 (예: 2023년 → 2023-01-01 ~ 2023-12-31 판매기간)
  const y = raw.match(/((?:19|20)\d{2})년/);
  if (y && free(y.index, y.index + y[0].length)) {
    taken.push([y.index, y.index + y[0].length]);
    if (chip("year", "판매연도", y[1] + "년")) { Q.from = `${y[1]}-01-01`; Q.to = `${y[1]}-12-31`; }
  }

  // 4) 상품분류
  for (const c of CATEGORY_WORDS) {
    const i = raw.indexOf(c.key);
    if (i !== -1 && free(i, i + c.key.length)) {
      taken.push([i, i + c.key.length]);
      if (chip("cat", "분류", c.label)) Q.category = c.label;
      break;
    }
  }

  // 5) 해석하지 못한 말 (참고 표시만, 검색에는 쓰지 않음)
  let rest = raw.split("").map((ch, i) => (free(i, i + 1) ? ch : " ")).join("");
  for (const w of STOP_WORDS) rest = rest.split(w).join(" ");
  Q.leftover = rest.split(" ").filter(w => w.length >= 2);

  // 6) 문장 질문 검색용 핵심어 (특징 사전과 관계없이 질문 문장 그대로)
  const all = questionTerms(text);
  Q.termChips = all.map(t => ({ key: "t:" + t, term: t, ignored: IGN.has("t:" + t) }));
  Q.terms = Q.termChips.filter(c => !c.ignored).map(c => c.term);
  Q.sentence = all.length >= 2 && (QUESTION_CUE.test(raw) || all.length >= 4);
  return Q;
}

// ---------- 문장 질문 검색: 핵심어 뽑기 ----------
const QUESTION_CUE = /뭐|무엇|어떤|어느|있어|있나|있을까|있는지|알려|찾아|인가|인지|궁금|\?|상품|경우/;
// 말끝(조사·어미)을 떼어 낱말 줄기만 남김 — 긴 것부터, 두 글자 이상 남을 때만
const ENDINGS = ["에서는", "으로는", "이었던", "하는데", "되는데", "합니까", "입니까", "인가요", "있나요",
  "해주는", "해준", "에서", "에게", "으로", "로는", "부터", "까지", "보다", "처럼", "에는", "에도", "이나", "이랑", "하는", "되는", "해서",
  "하여", "하고", "하면", "한다", "된다", "했던", "됐던", "였던", "해야", "되어", "돼서", "하지", "되지",
  "해", "을", "를", "이", "가", "은", "는", "의", "에", "와", "과", "도", "만", "로", "한", "된", "할", "될", "시", "때", "인", "적"];
const TERM_STOP = new Set(["상품", "보험", "보험상품", "뭐", "뭐가", "무엇", "어떤", "어느", "있어", "있나", "있는", "있을까", "있는지", "있었지",
  "알려줘", "알려", "찾아줘", "찾아", "경우", "것", "거", "좀", "혹시", "해당", "관련", "대해", "대한", "내용", "무슨", "뭐야", "뭐였지",
  "뭐였더라", "뭐지", "궁금", "궁금해", "알고", "싶어", "이런", "그런", "어디", "언제", "다른", "같은", "모든", "어떻게", "얼마", "있다", "없다",
  "이것", "그것", "중에", "중", "및", "또는", "그리고", "회사", "우리", "지금", "현재",
  "주는", "받는", "나오는", "해주는", "되는", "하는", "있고", "없는", "때"]);
// 같은 뜻으로 함께 찾을 말 (질문 핵심어에 들어 있으면 바꿔 넣은 말도 찾음)
const SYNONYMS = [["차감", "공제", "뺀", "제외"], ["기납입", "이미납입한", "납입한"], ["해지", "해약"], ["지급", "지불"], ["돌려", "환급"], ["줄어", "감소", "감액"]];

function stemOf(w) {
  for (let k = 0; k < 2; k++) {
    const e = ENDINGS.find(x => w.endsWith(x) && w.length - x.length >= 2 && !(x === "해" && /[상재손피방이위]해$/.test(w)));
    if (!e) break;
    w = w.slice(0, -e.length);
  }
  return w;
}

function questionTerms(text) {
  const out = [];
  for (const tok of (text || "").toLowerCase().split(/[\s,?!.·~"'“”‘’()\[\]]+/)) {
    const w = stemOf(tok);
    if (w.length < 2 || TERM_STOP.has(w) || TERM_STOP.has(tok)) continue;
    if (/^((19|20)\d{2})년?$/.test(w) || /^판매(중|종료|중지)/.test(w)) continue; // 연도·판매상태는 조건으로 처리
    if (CATEGORY_WORDS.some(c => w === c.key || w === c.key + "보험" || w === c.key + "형")) continue; // 분류도 조건으로
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

// 핵심어 → 같은 뜻 말까지 포함한 후보 목록
function termAlts(t) {
  const alts = [t];
  for (const g of SYNONYMS) for (const w of g) {
    if (!t.includes(w)) continue;
    g.filter(x => x !== w).forEach(x => { const a = t.replace(w, x); if (!alts.includes(a)) alts.push(a); });
  }
  return alts;
}

// 몇 개의 핵심어가 한 문장에 있어야 일치로 볼지 (2개 이하면 모두, 그 이상이면 3/4 이상)
const termsNeeded = n => (n <= 2 ? n : Math.max(2, Math.ceil(n * 0.75)));

// 원문을 문장 단위로 나눔 (마침표·물음표 뒤 공백, 아주 긴 덩어리는 줄바꿈·300자 단위로)
function splitSentences(text) {
  const out = [];
  for (const piece of (text || "").split(/(?<=[.。!?])\s+/)) {
    const parts = piece.length > 300 ? piece.split(/\n+/) : [piece];
    for (const p of parts) for (let i = 0; i < p.length; i += 300) {
      const t = p.slice(i, i + 300).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

// 문장 하나 채점: 들어 있는 핵심어(같은 뜻 포함) 수
function scoreSentence(sentence, groups) {
  const comp = norm(sentence);
  const matched = groups.map(g => g.find(a => comp.includes(a)) || "");
  return { hits: matched.filter(Boolean).length, matched: matched.filter(Boolean), len: comp.length };
}

// 현재 검색창 → 키워드 검색 또는 질문 검색. 질문으로 인식된 특징이 하나라도 있으면 특징 질문 검색,
// 특징은 없지만 문장으로 물어본 질문이면 문장 질문 검색 (둘 다 아래 '질문 답변'에 원문 문장을 함께 보여 줌)
function currentQuery() {
  const f = readForm();
  const Q = interpretQuestion(f.keyword);
  if (!Q.features.length && !Q.sentence) return { mode: "keyword", form: f, Q };
  return {
    mode: Q.features.length ? "question" : "sentence", Q,
    form: { keyword: "", from: Q.from || f.from, to: Q.to || f.to,
            category: Q.category || f.category, status: Q.status || f.status, docType: f.docType },
  };
}

function renderInterpretation() {
  const Q = interpretQuestion($("keyword").value);
  const box = $("interp");
  const hasFeat = Q.chips.some(c => c.kind === "특징");
  if (!hasFeat && !Q.sentence) { box.hidden = true; return; }
  box.hidden = false;
  const chipHtml = (key, kind, label, ignored) =>
    `<span class="chip${ignored ? " ignored" : ""}">${esc(kind)} <b>${esc(label)}</b>` +
    `<button type="button" data-chip="${esc(key)}" title="${ignored ? "다시 사용" : "이 해석 빼기"}">${ignored ? "↺" : "×"}</button></span>`;
  box.innerHTML = `질문 해석:` + Q.chips.map(c => chipHtml(c.key, c.kind, c.label, c.ignored)).join("") +
    (Q.sentence ? ` <span>· 문장에서 찾을 핵심어:</span>` + Q.termChips.map(c => chipHtml(c.key, "핵심어", c.term, c.ignored)).join("")
      : Q.leftover.length ? ` <span>· 참고하지 않은 말: ${esc(Q.leftover.join(", "))}</span>` : "");
}

$("interp").addEventListener("click", e => {
  const b = e.target.closest("button[data-chip]");
  if (!b) return;
  IGNORED.has(b.dataset.chip) ? IGNORED.delete(b.dataset.chip) : IGNORED.add(b.dataset.chip);
  renderAll();
});

// ---------- 상품별 답변 (기초서류 PDF) ----------
// 공백을 무시하고 정규식으로 찾은 위치의 원문 앞뒤 문맥
function regexSnippet(pageText, re) {
  const map = [];
  let compact = "";
  for (let i = 0; i < pageText.length; i++) {
    if (!/\s/.test(pageText[i])) { compact += pageText[i].toLowerCase(); map.push(i); }
  }
  const m = re.exec(compact);
  if (!m || !m[0]) return null;
  const s = map[m.index], e = map[m.index + m[0].length - 1] + 1;
  const a = Math.max(0, s - 50), b = Math.min(pageText.length, e + 70);
  return { before: pageText.slice(a, s), hit: pageText.slice(s, e), after: pageText.slice(e, b), lead: a > 0, tail: b < pageText.length };
}

// 문서가 특징을 가졌는지: 서버 모드는 색인 때 미리 계산한 태그, 파일 모드는 본문에서 바로 확인
const docHasFeature = (d, f) => (SERVER_MODE ? !!(d.features && d.features[f.id]) : featureMatches(f, d.searchText));

// 특징 근거 문맥 (패턴별 첫 페이지)
function featureEvidence(d, f) {
  if (SERVER_MODE) return (d.features && d.features[f.id]) || [];
  return f.patterns.map(re => {
    for (let i = 0; i < d.pages.length; i++) {
      const s = regexSnippet(d.pages[i], re);
      if (s) return { page: i + 1, ...s };
    }
    return null;
  }).filter(Boolean);
}

const DOC_PRIORITY = ["사업방법서", "상품요약서", "약관", "산출방법서", "기타"];
const byDocPriority = (a, b) => DOC_PRIORITY.indexOf(a.docType) - DOC_PRIORITY.indexOf(b.docType) || (b.start || "").localeCompare(a.start || "");

function answerProducts(cur) {
  const groups = new Map();
  DOCS.filter(d => docMatchesFilters(d, cur.form)).forEach(d => {
    const k = productKeyOf(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  });
  const out = [];
  for (const [key, docs] of groups) {
    const perFeature = cur.Q.features.map(f => ({ f, docs: docs.filter(d => docHasFeature(d, f)).sort(byDocPriority) }));
    if (perFeature.some(x => !x.docs.length)) continue; // 모든 특징을 만족해야 함
    const matchedDocs = [...new Set(perFeature.flatMap(x => x.docs))].sort(byDocPriority);
    const latest = matchedDocs.map(d => d.start).filter(Boolean).sort().pop() || "";
    out.push({ key, name: docs[0].productName || docs[0].name, perFeature, matchedDocs, latest });
  }
  return out.sort((a, b) => b.latest.localeCompare(a.latest));
}

function renderAnswer() {
  const cur = currentQuery();
  const panel = $("answerPanel");
  if (cur.mode === "keyword") { panel.hidden = true; $("sentBox").hidden = true; return; }
  panel.hidden = false;
  renderSentenceAnswer(cur);
  if (cur.mode === "sentence") { $("answerSummary").innerHTML = ""; $("answerCards").innerHTML = ""; return; }
  const featNames = cur.Q.features.map(f => f.name).join(" + ");
  if (!DOCS.length) {
    $("answerSummary").innerHTML = `특징 <b>${esc(featNames)}</b> — 기초서류 PDF 폴더를 연결하면 문서 본문에서 찾아 답합니다. (아래 가상 상품 DB 결과 참고)`;
    $("answerCards").innerHTML = "";
    return;
  }
  const list = answerProducts(cur);
  $("answerSummary").innerHTML = `특징 <b>${esc(featNames)}</b>에 해당하는 상품 <b>${list.length}</b>개 (불러온 PDF ${DOCS.length}건 기준)`;
  if (!list.length) {
    $("answerCards").innerHTML = `<p class="empty">조건에 맞는 상품을 문서에서 찾지 못했습니다. 위 해석에서 조건을 빼 보세요(×).</p>`;
    return;
  }
  $("answerCards").innerHTML = list.map(p => {
    const best = p.matchedDocs[0];
    const evidence = p.perFeature.map(({ f, docs }) => {
      const d = docs[0];
      const shown = [];
      const lines = featureEvidence(d, f).map(s => {
        if (shown.some(t => t.page === s.page && t.text.includes(s.hit))) return ""; // 앞 문맥에 이미 보임
        shown.push({ page: s.page, text: s.before + s.hit + s.after });
        return `<p class="snip"><a href="#" class="pg" data-open="${DOCS.indexOf(d)}" data-page="${s.page}">${esc(d.docType)} p.${s.page}</a>` +
          `${s.lead ? "…" : ""}${esc(s.before)}<mark>${esc(s.hit)}</mark>${esc(s.after)}${s.tail ? "…" : ""}</p>`;
      }).join("");
      return `<div><span class="tag">${esc(f.name)}</span>${lines}</div>`;
    }).join("");
    const versions = [...new Set(p.matchedDocs.map(d => d.start || "판매일자 미상"))].sort().reverse();
    const docList = p.matchedDocs.map(d => `${d.docType}(${d.start || "?"})`).join(", ");
    return `<div class="pcard">
      <h3>${esc(p.name)}</h3>
      <div class="meta">판매일자: ${esc(versions.join(", "))} · 근거 문서: ${esc(docList)}</div>
      ${evidence}
      <div class="buttons">
        <button type="button" class="primary" data-analyze="${esc(p.key)}" data-start="${esc(best.start)}">상품 분석 보기</button>
        <button type="button" data-compare-add="${esc(p.key)}" data-start="${esc(best.start)}">비교 담기</button>
        <button type="button" data-open="${DOCS.indexOf(best)}" data-page="1">${esc(best.docType)} 열기</button>
      </div>
    </div>`;
  }).join("");
}

// ---------- 문장 질문 검색: 핵심어가 한 문장에 모인 원문 찾기 ----------
// 파일·웹 데모 모드는 메모리의 본문에서, 서버 모드는 색인(serve.py /api/ask)에서 찾습니다.
async function sentenceAnswer(cur) {
  const groups = cur.Q.terms.map(termAlts);
  const need = termsNeeded(groups.length);
  const docs = DOCS.filter(d => docMatchesFilters(d, cur.form));
  const hits = []; // {doc, page, text, hits, matched, len}
  if (!groups.length) return { groups, need, hits };
  if (SERVER_MODE) {
    const ids = docs.filter(d => d.id).map(d => d.id);
    const byId = new Map(docs.map(d => [d.id, d]));
    const res = ids.length ? (await api("api/ask", { groups, need, ids })).hits : [];
    res.forEach(h => byId.has(h.id) && hits.push({ ...h, doc: byId.get(h.id) }));
  } else {
    for (const d of docs) {
      const best = [];
      (d.pages || []).forEach((text, pi) => splitSentences(text).forEach(sent => {
        const sc = scoreSentence(sent, groups);
        if (sc.hits >= need) best.push({ doc: d, page: pi + 1, text: sent, ...sc });
      }));
      best.sort((a, b) => b.hits - a.hits || a.len - b.len);
      hits.push(...best.slice(0, 2));
    }
  }
  return { groups, need, hits };
}

// 상품별로 묶기: 핵심어가 가장 많이 모인 문장 순, 같으면 짧은 문장·문서 우선순위·최신 판매일자
function groupSentenceHits(hits) {
  const byProduct = new Map();
  hits.sort((a, b) => b.hits - a.hits || a.len - b.len || byDocPriority(a.doc, b.doc));
  for (const h of hits) {
    const k = productKeyOf(h.doc);
    if (!byProduct.has(k)) byProduct.set(k, { key: k, name: h.doc.productName || h.doc.name, hits: [] });
    byProduct.get(k).hits.push(h);
  }
  return [...byProduct.values()];
}

let sentSeq = 0;
async function renderSentenceAnswer(cur) {
  const box = $("sentBox"), seq = ++sentSeq;
  if (!cur.Q.sentence) { box.hidden = true; return; }
  box.hidden = false;
  const termsTxt = cur.Q.terms.join(" · ");
  if (!DOCS.length) {
    box.innerHTML = `<h3>질문 문장으로 찾은 원문</h3><p class="summary">핵심어 <b>${esc(termsTxt)}</b> — 기초서류 PDF 폴더를 연결하면 원문에서 찾아 답합니다.</p>`;
    return;
  }
  box.innerHTML = `<h3>질문 문장으로 찾은 원문</h3><p class="summary">찾는 중…</p>`;
  let r;
  try { r = await sentenceAnswer(cur); } catch (e) {
    if (seq === sentSeq) box.innerHTML = `<h3>질문 문장으로 찾은 원문</h3><p class="warn">문장 검색 실패: ${esc(e.message)}</p>`;
    return;
  }
  if (seq !== sentSeq) return;
  const list = groupSentenceHits(r.hits);
  const SHOW = 20;
  const head = `<h3>질문 문장으로 찾은 원문</h3><p class="summary">핵심어 ${r.groups.length}개(<b>${esc(termsTxt)}</b>) 중 <b>${r.need}개 이상</b>이 한 문장에 함께 있는 상품 <b>${list.length}</b>개` +
    ` (불러온 PDF ${DOCS.length}건 기준 · 특징 사전 없이 질문 문장 그대로 검색 · 같은 뜻 말 일부 포함)</p>`;
  if (!list.length) {
    box.innerHTML = head + `<p class="empty">핵심어가 한 문장에 모인 원문을 찾지 못했습니다. 위 '핵심어' 칩에서 덜 중요한 말을 빼(×) 보거나, 문서에 쓰인 표현으로 바꿔 물어보세요.</p>`;
    return;
  }
  box.innerHTML = head + list.slice(0, SHOW).map(p => {
    const best = p.hits[0];
    const lines = p.hits.slice(0, 3).map(h =>
      `<p class="snip"><a href="#" class="pg" data-open="${DOCS.indexOf(h.doc)}" data-page="${h.page}">${esc(h.doc.docType)}(${esc(h.doc.start || "?")}) p.${h.page}</a>` +
      `${highlight(h.text, h.matched)} <span class="note">핵심어 ${h.hits}/${r.groups.length}</span></p>`).join("");
    const versions = [...new Set(p.hits.map(h => h.doc.start || "판매일자 미상"))].sort().reverse();
    return `<div class="pcard">
      <h3>${esc(p.name)}</h3>
      <div class="meta">판매일자: ${esc(versions.join(", "))} · 가장 많이 일치: 핵심어 ${best.hits}/${r.groups.length}</div>
      ${lines}
      <div class="buttons">
        <button type="button" class="primary" data-analyze="${esc(p.key)}" data-start="${esc(best.doc.start)}">상품 분석 보기</button>
        <button type="button" data-compare-add="${esc(p.key)}" data-start="${esc(best.doc.start)}">비교 담기</button>
        <button type="button" data-open="${DOCS.indexOf(best.doc)}" data-page="${best.page}">${esc(best.doc.docType)} 열기</button>
      </div>
    </div>`;
  }).join("") + (list.length > SHOW ? `<p class="note">외 ${list.length - SHOW}개 상품 — 핵심어를 더 넣거나 분류·판매상태로 좁혀 보세요.</p>` : "");
}
