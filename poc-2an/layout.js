// 화면 배치 보조 — 상단 메뉴 화면 전환(검색·목록 · AI 질문 · 상품 분석 · 상품 비교 · 기초서류 연결 · 교육용 실습),
// 상품 목록 판매상태 탭, 기초서류 연결 현황, 교육용 자료 내려받기

// 앱 버전 (업데이트가 반영됐는지 기초서류 연결 화면에서 확인)
const APP_VERSION = "2026-10-16 · AI 질문(로컬 AI 챗봇)";
$("appVersion").textContent = APP_VERSION;

// ---------- 화면 전환 ----------
const VIEWS = { home: "viewHome", ai: "viewAi", analysis: "viewAnalysis", compare: "viewCompare", connect: "viewConnect", edu: "viewEdu" };
let curView = "home", homeScroll = 0;

function showView(view, target) {
  if (curView === "home" && view !== "home") homeScroll = window.scrollY; // 검색·목록 화면 위치 기억
  const back = view === "home" && curView !== "home" && !target;
  curView = view;
  Object.entries(VIEWS).forEach(([v, id]) => { $(id).hidden = v !== view; });
  document.querySelectorAll(".gnb a[data-view]").forEach(a =>
    a.classList.toggle("cur", a.dataset.view === view && (view !== "home" || a.dataset.target === target)));
  if (view === "connect") renderConnectStats();
  if (view === "edu") renderEduInfo();
  const el = target && target !== "top" ? $(target) : null;
  if (el && !el.hidden) el.scrollIntoView({ behavior: "smooth", block: "start" });
  else window.scrollTo(0, back ? homeScroll : 0);
}

// "← 검색·상품 목록으로": 보던 위치로 돌아감
document.addEventListener("click", e => { if (e.target.closest("[data-back]")) showView("home"); });

document.addEventListener("click", e => {
  const a = e.target.closest("a[data-view]");
  if (!a) return;
  e.preventDefault();
  showView(a.dataset.view, a.dataset.target);
});

// 분석·비교 메뉴는 그 화면이 열려 있을 때만 활성
const navLinks = [...document.querySelectorAll(".gnb a[data-needs]")];
const syncNav = () => navLinks.forEach(a => a.classList.toggle("off", $(a.dataset.needs).hidden));
navLinks.forEach(a => new MutationObserver(syncNav).observe($(a.dataset.needs), { attributes: true, attributeFilter: ["hidden"] }));
syncNav();

// 분석·비교를 [닫기]로 닫으면 검색·목록 화면으로 돌아감 (열 때는 showAnalysis·showCompare가 해당 화면을 엶)
[["analysisPanel", "analysis"], ["comparePanel", "compare"]].forEach(([id, view]) => new MutationObserver(() => {
  if ($(id).hidden && curView === view) showView("home");
}).observe($(id), { attributes: true, attributeFilter: ["hidden"] }));

// ---------- 상품 목록 판매상태 탭 → 숨은 판매상태 선택칸(catStatus)과 연동 ----------
$("catTabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-st]");
  if (!b) return;
  $("catStatus").value = b.dataset.st;
  $("catStatus").dispatchEvent(new Event("change"));
});
$("catStatus").addEventListener("change", () => {
  document.querySelectorAll("#catTabs button").forEach(b => b.classList.toggle("on", b.dataset.st === $("catStatus").value));
});

// ---------- 기초서류 연결 현황 ----------
function renderConnectStats() {
  if (!DOCS.length) { $("connectStats").textContent = "—"; return; }
  const count = t => DOCS.filter(d => d.docType === t).length;
  const products = new Set(DOCS.map(productKeyOf)).size;
  const dates = new Set(DOCS.map(d => d.start).filter(Boolean)).size;
  const errors = DOCS.filter(d => d.error).length;
  $("connectStats").innerHTML = `PDF <b>${DOCS.length}</b>개 · 상품 <b>${products}</b>개 · 판매일자 ${dates}개<br>` +
    ["사업방법서", "상품요약서", "약관"].map(t => `${t} ${count(t)}`).join(" · ") +
    (DOCS.length - count("사업방법서") - count("상품요약서") - count("약관") ? ` · 기타 ${DOCS.length - count("사업방법서") - count("상품요약서") - count("약관")}` : "") +
    (errors ? `<div class="warn">본문을 못 읽은 파일 ${errors}개 (스캔 이미지 PDF 등)</div>` : "");
}
// 불러오기 상태가 바뀔 때마다 연결 현황 갱신
new MutationObserver(() => { if (curView === "connect") renderConnectStats(); renderEduInfo(); })
  .observe($("docsStatus"), { childList: true, characterData: true, subtree: true });

// ---------- 교육용 실습 ----------
const SAMPLE_FOLDER = "sample-기초서류폴더";
const SAMPLE_LIST = window.SAMPLE_FILES || [];

function renderEduInfo() {
  $("sampleCount").textContent = SAMPLE_LIST.length ? `(PDF ${SAMPLE_LIST.length}개)` : "";
  const folder = $("docsFolder").textContent;
  $("sampleModeNote").innerHTML = folder.replace(/\\/g, "/").endsWith(SAMPLE_FOLDER)
    ? `<b class="ok-text">지금 가상 샘플로 실행 중입니다.</b> 상단 [기초서류 검색]·[상품 목록]에서 바로 실습하세요.`
    : SERVER_MODE ? `지금은 내 기초서류 폴더로 실행 중입니다${folder ? ` (${esc(folder)})` : ""}.` : "";
  if (DEMO_MODE) $("sampleZipNote").textContent = "웹 데모에서는 저장이 막혀 있음";
  if (DEMO_MODE) document.querySelectorAll(".demo-only").forEach(el => { el.hidden = false; });
  if (DEMO_MODE) $("sampleModeNote").innerHTML = `<b class="ok-text">지금 웹 데모로 실행 중입니다.</b> 가상 샘플이 이미 연결되어 있어 상단 [기초서류 검색]·[상품 목록]에서 바로 실습할 수 있습니다.`;
  if (!SERVER_MODE && !DEMO_MODE) $("sampleZipNote").textContent = "start.bat / start-sample.bat으로 실행했을 때 내려받을 수 있습니다";
}

// CSV: 엑셀에서 한글이 깨지지 않도록 BOM을 붙여 저장
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-csv]");
  if (!b) return;
  download(`${b.dataset.csv}.csv`, "﻿" + window.CSV_DATA[b.dataset.csv]);
});

// ZIP(무압축) 만들기 — 외부 라이브러리 없이 내 PC 안에서 묶음
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nm = enc.encode(name), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 파일명
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nm.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, nm.length, true); cen.setUint32(42, offset, true);
    parts.push(local, nm, data); central.push(cen, nm);
    offset += 30 + nm.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

$("sampleZipBtn").addEventListener("click", async () => {
  const btn = $("sampleZipBtn"), note = $("sampleZipNote");
  if (DEMO_MODE) { demoNotice("웹 데모에서는 파일 저장이 막혀 있습니다. 앱 폴더의 sample-기초서류폴더에 같은 PDF가 들어 있습니다."); return; }
  if (!SERVER_MODE) { note.textContent = "start.bat / start-sample.bat으로 실행했을 때 내려받을 수 있습니다"; return; }
  btn.disabled = true;
  try {
    const entries = [];
    for (let i = 0; i < SAMPLE_LIST.length; i++) {
      note.textContent = `묶는 중 ${i + 1}/${SAMPLE_LIST.length}`;
      const path = SAMPLE_LIST[i];
      const res = await fetch(path.split("/").map(encodeURIComponent).join("/"));
      if (!res.ok) throw new Error(`${path} (${res.status})`);
      entries.push({ name: path, data: new Uint8Array(await res.arrayBuffer()) });
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(makeZip(entries));
    a.download = "sample-docs.zip";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    note.textContent = `PDF ${entries.length}개를 묶었습니다`;
  } catch (err) {
    note.textContent = "내려받기 실패: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

// 따라 해 보기: 검색 화면으로 가서 바로 실행
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-try]");
  if (!b) return;
  if (!b.dataset.try) { showView("home", "catalogPanel"); return; }
  $("searchForm").reset();
  $("keyword").value = b.dataset.try;
  renderAll();
  showView("home", "searchPanel");
});

// 상품 목록이 비었을 때 안내 버튼 → 교육용 실습
document.addEventListener("click", e => {
  if (!e.target.closest("#emptyDbBtn")) return;
  showView("edu");
});

// ---------- 웹 데모 ----------
// 교육자료 링크로 연 웹 데모는 파일 내려받기와 새 창 열기가 막혀 있어, 안내를 띄우고 PDF 쪽은 화면 안에서 보여 줌
function demoNotice(msg) {
  let t = $("demoToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "demoToast"; t.className = "toast"; t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.textContent = msg; t.hidden = false;
  clearTimeout(demoNotice.timer);
  demoNotice.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

async function showDocPage(d, page) {
  $("modalTitle").textContent = `${d.productName || d.name} · ${d.docType} p.${page}`;
  $("modalBody").style.gridTemplateColumns = "minmax(300px, 1fr)";
  $("modalBody").innerHTML = `<p class="note">${esc(d.docType)} p.${page} 그리는 중…</p>`;
  $("imgModal").hidden = false;
  try {
    const pdf = await openPdf(d);
    const n = Math.min(Math.max(1, page), pdf.numPages);
    const pg = await pdf.getPage(n);
    const vp = pg.getViewport({ scale: 1.6 });
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    await pg.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    const nav = (p, label) => p >= 1 && p <= pdf.numPages ? `<button type="button" class="mini" data-open="${DOCS.indexOf(d)}" data-page="${p}">${label}</button>` : "";
    $("modalBody").innerHTML = `<div class="modal-col"><div class="buttons" style="margin-bottom:8px">${nav(n - 1, "이전 쪽")}${nav(n + 1, "다음 쪽")}
      <span class="note">${n} / ${pdf.numPages}쪽 · ${esc(d.path)}</span></div><img src="${cv.toDataURL("image/jpeg", 0.88)}" alt="${esc(d.docType)} p.${n}"></div>`;
  } catch (err) {
    $("modalBody").innerHTML = `<p class="warn">PDF를 그리지 못했습니다: ${esc(err.message)}</p>`;
  }
}

if (DEMO_MODE) {
  document.querySelector(".util").insertAdjacentHTML("beforeend", `<span class="hl">웹 데모 · 가상 데이터</span>`);
  // compare.js의 download(엑셀·CSV 저장)를 안내로 바꿈
  download = name => demoNotice(`웹 데모에서는 파일 저장(${name})이 막혀 있습니다. 내 PC에서 start-sample.bat으로 실행한 앱에서 저장할 수 있습니다.`);
}

renderEduInfo();
