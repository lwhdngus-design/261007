// 실행 결과 바로 보기 — 주소 끝의 #이름으로 대표 실행 결과를 바로 엶 (교육자료·안내에서 링크로 연결)
// 예) …/index.html#analysis → 가상 상품 '두단계종신보험' 2025판 상품 분석 화면
// 모두 교육용 가상 샘플(가나다생명) 기준입니다.

const EXAMPLES = {
  "q-split": { label: "질문 검색 답변", desc: "'제1납입기간과 제2납입기간이 구분된 종신보험이 뭐였지?' → 상품별 답변과 근거 쪽수",
    run: async () => { searchFor("제1납입기간과 제2납입기간이 구분된 종신보험이 뭐였지?"); showView("home", "answerPanel"); } },
  "kw-premium": { label: "키워드 검색 결과", desc: "'제2영업보험료' → 일치한 문서·문장·쪽수",
    run: async () => { searchFor("제2영업보험료"); showView("home", "docsPanel"); } },
  "catalog": { label: "판매시기별 상품 목록", desc: "상품별 판매일자(개정)·문서·특징 표, 판매일자별로 펼친 상태",
    run: async () => {
      searchFor("");
      $("catExpand").checked = true; $("catExpand").dispatchEvent(new Event("change"));
      showView("home", "catalogPanel");
    } },
  "analysis": { label: "상품 분석 24개 항목", desc: "'두단계종신보험' 2025판: 원문 인용 · 근거 쪽수 · 지급기준표 그림",
    run: async () => { await openAnalysis("두단계", "2025-01-01"); showView("analysis"); } },
  "paytable": { label: "지급기준표 크게 보기", desc: "약관 별표 보험금 지급기준표를 원문 모양 그대로",
    run: async () => {
      await openAnalysis("두단계", "2025-01-01");
      showView("analysis");
      const b = [...document.querySelectorAll("#analysisBody tr")].find(tr => /보험금 지급사유/.test(tr.cells[0] && tr.cells[0].textContent));
      const btn = b && b.querySelector("[data-imgset]");
      if (btn) btn.click();
    } },
  "revision": { label: "개정 전후 비교", desc: "'두단계종신보험' 2023판 → 2025판: 항목별 판정과 바뀐 줄",
    run: async () => {
      await openAnalysis("두단계", "2025-01-01");
      $("prevVersionBtn").click();
      await until(() => !$("comparePanel").hidden && $("compareBody").querySelector("table"));
      showView("compare");
    } },
  "compare": { label: "상품 비교 (3개)", desc: "든든·두갈래·암케어를 24개 항목으로 나란히",
    run: async () => {
      TRAY.length = 0;
      [["든든", "2023-01-01"], ["두갈래", "2024-03-01"], ["암케어", "2023-04-01"]].forEach(([p, st]) => addToCompare(sampleKey(p), st));
      await showCompare();
      showView("compare");
    } },
  "db-detail": { label: "포트폴리오·주요사항", desc: "가상 상품 DB '든든종신보험(2차)': 요약·담보·월별 보유계약·심의 문서",
    run: async () => {
      searchFor("");
      showView("edu");
      renderDbDetail("P002");
    } },
  "selfcheck": { label: "자동 검증 14개", desc: "기획서 요구사항별 기대값·실제값 (샘플을 읽으면 자동 실행)",
    run: async () => { showView("edu", "selfCheck"); if (!/통과/.test($("checkSummary").textContent)) runSelfCheck(); } },
};

function searchFor(text) {
  $("searchForm").reset();
  $("keyword").value = text;
  renderAll();
}

async function openAnalysis(part, start) {
  await showAnalysis(sampleKey(part), start);
  await until(() => $("analysisBody").querySelector("table.facts"));
}

function until(test, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (test() ? resolve() : Date.now() - t0 > ms ? reject(new Error("시간 초과")) : setTimeout(tick, 200));
    tick();
  });
}

// 샘플을 다 읽은 뒤 실행 (웹 데모·start-sample.bat 모두)
const docsReady = () => DOCS.length > 0 && /— PDF \d+개/.test($("docsStatus").textContent) && $("docsProgress").hidden;

async function openExample(name) {
  const ex = EXAMPLES[name];
  if (!ex) return;
  $("exampleNote").hidden = false;
  $("exampleNote").textContent = `실행 예시 여는 중: ${ex.label} (샘플을 읽고 있으면 끝난 뒤 열립니다)`;
  try {
    await until(docsReady, 180000);
    await ex.run();
    $("exampleNote").innerHTML = `<b>실행 예시</b> ${esc(ex.label)} — ${esc(ex.desc)} · 교육용 가상 데이터`;
  } catch (e) {
    $("exampleNote").textContent = `실행 예시를 열지 못했습니다: ${e.message}`;
  }
}

// 교육용 실습 화면의 "실행 결과 바로 보기" 목록
$("exampleList").innerHTML = Object.entries(EXAMPLES).map(([k, ex]) =>
  `<li><a href="#${k}" data-example="${k}"><b>${esc(ex.label)}</b></a> <span class="note">${esc(ex.desc)}</span></li>`).join("");
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-example]");
  if (!a) return;
  e.preventDefault();
  history.replaceState(null, "", "#" + a.dataset.example);
  openExample(a.dataset.example);
});
window.addEventListener("hashchange", () => openExample(location.hash.slice(1)));
if (EXAMPLES[location.hash.slice(1)]) openExample(location.hash.slice(1));
