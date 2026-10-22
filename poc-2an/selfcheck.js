// 자동 검증 — 기획서 요구사항별 완료 기준을 교육용 가상 데이터로 실행해 기대값과 실제값을 나란히 보여 줌
// 웹 데모에서는 샘플을 다 읽으면 자동으로 실행되어, 링크를 연 사람이 결과를 바로 확인할 수 있습니다.

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const codesOf = rows => rows.map(r => r.product.product_code).sort();
const BLANK_FORM = { keyword: "", from: "", to: "", category: "", status: "" };

function sampleKey(part) {
  const d = DOCS.find(x => (x.productName || "").includes(part));
  return d ? productKeyOf(d) : "";
}

const CHECKS = [
  // ---- 상품명·판매시기·담보명 검색 (가상 상품 DB) ----
  { req: "상품명·판매시기·담보명 검색", name: "키워드 '종신' (가상 DB)", expect: "P001, P002, P003",
    run: () => codesOf(search({ ...BLANK_FORM, keyword: "종신" })).join(", ") },
  { req: "상품명·판매시기·담보명 검색", name: "판매기간 2020-01-01 ~ 2020-12-31 (가상 DB)", expect: "6건",
    run: () => `${search({ ...BLANK_FORM, from: "2020-01-01", to: "2020-12-31" }).length}건` },
  { req: "상품명·판매시기·담보명 검색", name: "담보명 '유사암' (가상 DB)", expect: "P006, P007",
    run: () => codesOf(search({ ...BLANK_FORM, keyword: "유사암" })).join(", ") },
  { req: "상품명·판매시기·담보명 검색", name: "판매중 + 분류 '건강' (가상 DB)", expect: "P005, P011",
    run: () => codesOf(search({ ...BLANK_FORM, status: "판매중", category: "건강" })).join(", ") },
  { req: "상품명·판매시기·담보명 검색", name: "본문 키워드 '제2영업보험료' (기초서류 PDF)", expect: "1건 · 두단계종신보험 사업방법서",
    run: async () => {
      const rows = await searchDocs({ ...BLANK_FORM, keyword: "제2영업보험료" });
      return `${rows.length}건` + (rows[0] ? ` · ${(rows[0].doc.productName || "").replace("(무)가나다", "")} ${rows[0].doc.docType}` : "");
    } },
  { req: "상품명·판매시기·담보명 검색", name: "질문 '제1납입기간과 제2납입기간이 구분된 종신보험이 뭐였지?'", expect: "1개 · (무)가나다두단계종신보험",
    run: () => {
      const Q = interpretQuestion("제1납입기간과 제2납입기간이 구분된 종신보험이 뭐였지?");
      const list = answerProducts({ mode: "question", Q, form: { ...BLANK_FORM, category: Q.category } });
      return `${list.length}개` + (list[0] ? ` · ${list[0].name}` : "");
    } },
  { req: "상품명·판매시기·담보명 검색", name: "문장 질문 '사망 시 이미 납입한 보험료에서 인출금액을 차감한 금액을 지급하는 상품' (특징 사전 없이)", expect: "1개 · (무)가나다두갈래종신보험 약관 p.1",
    run: async () => {
      const Q = interpretQuestion("사망 시 이미 납입한 보험료에서 인출금액을 차감한 금액을 지급하는 상품이 뭐가 있어?");
      const r = await sentenceAnswer({ Q, form: { ...BLANK_FORM } });
      const list = groupSentenceHits(r.hits), h = list[0] && list[0].hits[0];
      return `${list.length}개` + (h ? ` · ${list[0].name} ${h.doc.docType} p.${h.page}` : "");
    } },
  // ---- 판매시기별 상품 목록 ----
  { req: "판매시기별 상품 목록", name: "상품 목록 자동 구성", expect: "상품 20 · 판매일자 30 · PDF 82",
    run: () => {
      const c = buildCatalog();
      return `상품 ${c.length} · 판매일자 ${c.reduce((s, p) => s + p.versions.length, 0)} · PDF ${DOCS.length}`;
    } },
  { req: "판매시기별 상품 목록", name: "특징 '납입기간 분할형'이 최신판에 있는 상품", expect: "(무)가나다두단계종신보험",
    run: () => {
      const f = FEATURES.find(x => x.name === "납입기간 분할형");
      return buildCatalog().filter(p => f && p.feat[f.id] === "latest").map(p => p.name).join(", ") || "없음";
    } },
  // ---- 포트폴리오·주요사항 ----
  { req: "포트폴리오·주요사항", name: "가상 DB 12개 상품 상세 (요약·담보·월별 포트폴리오)", expect: "12 / 12",
    run: () => {
      const ok = DB.products.filter(p => {
        renderDbDetail(p.product_code);
        const rows = [...document.querySelectorAll("#dbDetail table")].map(t => t.tBodies[0] ? t.tBodies[0].rows.length : 0);
        return document.querySelector("#dbDetail .dbsum p").textContent.length > 50 && rows[1] > 0 && rows[2] > 0;
      }).length;
      $("dbDetail").hidden = true;
      return `${ok} / ${DB.products.length}`;
    } },
  // ---- 주요 내용 정리 · 근거 원문 연결 ----
  { req: "주요 내용 정리", name: "상품 분석 두단계종신보험 2025-01-01 — 납입기간", expect: "'제1납입기간 3년' 포함",
    run: async () => {
      const R = await analyzed("두단계", "2025-01-01");
      const row = R.rows.find(r => r.label === "납입기간·주기");
      const text = row ? row.lines.map(l => l.text).join(" / ") : "";
      return /제1납입기간\s*3\s*년/.test(text) ? "'제1납입기간 3년' 포함" : text.slice(0, 60) || "찾지 못함";
    } },
  { req: "주요 내용 정리", name: "같은 분석 — 항목 수 · '의무가입'", expect: "24개 항목 · 의무가입 없음",
    run: async () => {
      const R = await analyzed("두단계", "2025-01-01");
      const row = R.rows.find(r => r.label === "의무가입");
      return `${R.rows.length}개 항목 · 의무가입 ${row && row.none ? "없음" : row && row.lines.length ? "있음" : "확인 불가"}`;
    } },
  { req: "근거 원문 연결", name: "분석 결과의 모든 인용 줄에 문서·쪽수 (상품명에서 읽은 보험종류는 근거 '상품명')", expect: "누락 0줄",
    run: async () => {
      const R = await analyzed("두단계", "2025-01-01");
      const lines = R.rows.flatMap(r => r.lines);
      const miss = lines.filter(l => !/p\.\d+/.test(l.ref || "") && l.ref !== "상품명").length;
      return `누락 ${miss}줄`;
    } },
  { req: "주요 내용 정리", name: "규칙 판정 확신 낮음 표시 — 같은 분석 ('금리연동형'이 연체이율 문장의 '공시이율'로 판정됨)", expect: "보험종류, 면책, 감액",
    run: async () => {
      const R = await analyzed("두단계", "2025-01-01");
      const labels = [...(R.lowConf || [])];
      const listed = R.checks.filter(c => c.startsWith("[확신 낮음]")).length;
      return listed >= labels.length ? labels.join(", ") : `표시 ${labels.length}개 · 목록 ${listed}개`;
    } },
  { req: "근거 원문 연결", name: "개정 전후 비교 2023-07-01 → 2025-01-01 (상품요약서)", expect: "납입기간 줄 '변경'",
    run: async () => {
      const key = sampleKey("두단계");
      await analyzed("두단계", "2023-07-01");
      const d = revisionDiff(key, "2023-07-01", "2025-01-01").find(x => x.type === "상품요약서");
      return d && d.changed && d.changed.some(c => /납입기간/.test(c.from.text) && /제1납입기간/.test(c.to.text)) ? "납입기간 줄 '변경'" : "변경 없음";
    } },
];

// 분석에 필요한 본문·목차·표를 준비한 뒤 분석 (같은 판은 한 번만)
const ANALYZED = new Map();
async function analyzed(part, start) {
  const key = sampleKey(part), id = key + "|" + start;
  if (!ANALYZED.has(id)) {
    const vdocs = DOCS.filter(d => productKeyOf(d) === key && d.start === start);
    await ensurePages(vdocs);
    await prepareTables(vdocs);
    await prepareSections(vdocs);
    ANALYZED.set(id, analyzeProduct(key, start));
  }
  return ANALYZED.get(id);
}

let checkRunning = false;
async function runSelfCheck() {
  if (checkRunning) return;
  if (!DOCS.length) { $("checkSummary").textContent = "기초서류(가상 샘플)가 연결된 뒤에 실행할 수 있습니다."; return; }
  checkRunning = true;
  $("runCheckBtn").disabled = true;
  ANALYZED.clear();
  const out = [];
  for (const c of CHECKS) {
    let actual;
    try { actual = String(await c.run()); } catch (e) { actual = "오류: " + e.message; }
    out.push({ ...c, actual, pass: actual === c.expect });
    $("checkSummary").textContent = `실행 중 ${out.length}/${CHECKS.length}`;
  }
  const passed = out.filter(r => r.pass).length;
  const when = new Date().toLocaleString("ko-KR", { hour12: false });
  $("checkSummary").innerHTML = `<b>${passed} / ${out.length}</b> 통과 · ${esc(when)} 실행 · 데이터: 가상 샘플 PDF ${DOCS.length}개 · 가상 상품 DB ${DB.products.length}개`;
  $("checkBody").innerHTML = out.map(r => `<tr class="${r.pass ? "" : "fail"}"><td>${esc(r.req)}</td><td>${esc(r.name)}</td>
    <td>${esc(r.expect)}</td><td>${esc(r.actual)}</td><td><span class="badge ${r.pass ? "on" : "plan"}">${r.pass ? "통과" : "다름"}</span></td></tr>`).join("");
  $("checkTable").hidden = false;
  $("runCheckBtn").disabled = false;
  checkRunning = false;
}

$("runCheckBtn").addEventListener("click", runSelfCheck);

// 웹 데모: 샘플을 다 읽으면 자동 실행. 링크에 #selfcheck가 있으면 결과 화면을 바로 엶
if (DEMO_MODE) {
  const waitDocs = setInterval(() => {
    if (!/^웹 데모: .* — PDF/.test($("docsStatus").textContent)) return;
    clearInterval(waitDocs);
    runSelfCheck();
  }, 500);
}
if (location.hash === "#selfcheck") showView("edu", "selfCheck");
