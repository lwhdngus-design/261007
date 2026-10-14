// 질문 검색 — "제1보기와 제2보기가 구분된 종신보험이 뭐였지?" 같은 문장을 특징·조건으로 해석해 상품을 찾음
// 오프라인 규칙 기반: 특징 사전(dummy-data/features.csv)과 분류·판매상태·연도 표현을 대조합니다.

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

function interpretQuestion(text) {
  const raw = norm(text);
  if (raw !== lastQuestion) { IGNORED.clear(); lastQuestion = raw; }
  const Q = { raw, features: [], category: "", status: "", from: "", to: "", chips: [], leftover: [] };
  if (!raw) return Q;
  const taken = [];
  const free = (s, e) => !taken.some(([a, b]) => s < b && e > a);
  const chip = (key, kind, label) => {
    const ignored = IGNORED.has(key);
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
  return Q;
}

// 현재 검색창 → 키워드 검색 또는 질문 검색. 질문으로 인식된 특징이 하나라도 있으면 질문 검색
function currentQuery() {
  const f = readForm();
  const Q = interpretQuestion(f.keyword);
  if (!Q.features.length) return { mode: "keyword", form: f, Q };
  return {
    mode: "question", Q,
    form: { keyword: "", from: Q.from || f.from, to: Q.to || f.to,
            category: Q.category || f.category, status: Q.status || f.status },
  };
}

function renderInterpretation() {
  const Q = interpretQuestion($("keyword").value);
  const box = $("interp");
  if (!Q.chips.some(c => c.kind === "특징")) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `질문 해석:` + Q.chips.map(c =>
    `<span class="chip${c.ignored ? " ignored" : ""}">${esc(c.kind)} <b>${esc(c.label)}</b>` +
    `<button type="button" data-chip="${esc(c.key)}" title="${c.ignored ? "다시 사용" : "이 해석 빼기"}">${c.ignored ? "↺" : "×"}</button></span>`
  ).join("") + (Q.leftover.length ? ` <span>· 참고하지 않은 말: ${esc(Q.leftover.join(", "))}</span>` : "");
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
  if (cur.mode !== "question") { panel.hidden = true; return; }
  panel.hidden = false;
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
