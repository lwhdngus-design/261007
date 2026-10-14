// 3단계 — 상품 목록 자동 구성
// 불러온 기초서류를 상품별로 묶어 판매일자(버전)·판매상태·문서 구비·특징 표를 한눈에 보여주고 엑셀(CSV)로 내보냄.
// 상품명·판매일자는 파일명/폴더명에서, 특징은 특징 사전(features.csv)으로 판정합니다.

const CAT_TYPES = [["사업방법서", "사"], ["상품요약서", "요"], ["약관", "약"]];

function kindOf(name) {
  const n = norm(name);
  const k = KIND_WORDS.find(([, re]) => re.test(n));
  return k ? k[0] : "기타";
}

function statusOf(v) {
  if (!v.start) return "미상";
  if (v.start > TODAY) return "판매예정";
  return !v.end || v.end >= TODAY ? "판매중" : "판매종료";
}

function buildCatalog() {
  const groups = new Map();
  DOCS.forEach(d => {
    const k = productKeyOf(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  });
  const products = [];
  for (const [key, docs] of groups) {
    const byStart = new Map();
    docs.forEach(d => {
      if (!byStart.has(d.start)) byStart.set(d.start, []);
      byStart.get(d.start).push(d);
    });
    const versions = [...byStart].map(([start, vd]) => ({
      start, docs: vd,
      end: vd[0].end || "", explicitEnd: vd.some(d => d.explicitEnd),
      types: new Set(vd.map(d => d.docType)),
      features: new Set(FEATURES.filter(f => vd.some(d => docHasFeature(d, f))).map(f => f.id)),
      errors: vd.filter(d => d.error).length,
      pending: vd.filter(d => SERVER_MODE && !d.indexed).length,
    })).sort((a, b) => (b.start || "").localeCompare(a.start || "")); // 최신 판매일자 먼저
    versions.forEach(v => { v.status = statusOf(v); });
    const latest = versions[0];
    const name = docs[0].productName || docs[0].name;
    // 특징: 최신 판매일자에 있으면 'latest', 과거 판매일자에만 있으면 'past'
    const feat = {};
    FEATURES.forEach(f => {
      feat[f.id] = latest.features.has(f.id) ? "latest" : versions.some(v => v.features.has(f.id)) ? "past" : "";
    });
    products.push({ key, name, kind: kindOf(name), versions, latest, status: latest.status, feat, nDocs: docs.length });
  }
  return products.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

// ---------- 화면 ----------
let CATALOG = [];

function openCatalog() {
  $("catalogPanel").hidden = false;
  // 분류 선택지는 목록을 새로 만들 때 갱신
  CATALOG = buildCatalog();
  const kinds = [...new Set(CATALOG.map(p => p.kind))].sort();
  const cur = $("catKind").value;
  $("catKind").innerHTML = `<option value="">분류 전체</option>` + kinds.map(k => `<option${k === cur ? " selected" : ""}>${esc(k)}</option>`).join("");
  const curF = $("catFeature").value;
  $("catFeature").innerHTML = `<option value="">특징 전체</option>` +
    FEATURES.map(f => `<option value="${esc(f.id)}"${f.id === curF ? " selected" : ""}>${esc(f.name)}</option>`).join("");
  renderCatalog();
  $("catalogPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function filteredCatalog() {
  const q = norm($("catSearch").value), kind = $("catKind").value, st = $("catStatus").value, fid = $("catFeature").value;
  return CATALOG.filter(p =>
    (!q || norm(p.name).includes(q)) && (!kind || p.kind === kind) && (!st || p.status === st) &&
    (!fid || p.feat[fid]));
}

const docMarks = types => CAT_TYPES.map(([t, s]) => `<span class="dm${types.has(t) ? " on" : ""}" title="${t}${types.has(t) ? " 있음" : " 없음"}">${s}</span>`).join("");
const stBadge = st => `<span class="badge ${st === "판매중" ? "on" : st === "판매종료" ? "off" : "plan"}">${esc(st)}</span>`;

function renderCatalog() {
  if ($("catalogPanel").hidden) return;
  if (!DOCS.length) {
    $("catalogBody").innerHTML = `<p class="empty">기초서류 폴더를 먼저 연결하세요.</p>`;
    return;
  }
  CATALOG = buildCatalog();
  const list = filteredCatalog();
  const expand = $("catExpand").checked;
  const pending = DOCS.filter(d => SERVER_MODE && !d.indexed).length;
  const noDate = DOCS.filter(d => !d.start).length;
  const fHead = FEATURES.map(f => `<th class="fcol" title="${esc(f.name)}">${esc(f.name)}</th>`).join("");
  const fCells = (has, isProduct) => FEATURES.map(f => {
    const v = isProduct ? has[f.id] : has.has(f.id) ? "latest" : "";
    return `<td class="fcell">${v === "latest" ? `<span class="fm on" title="${isProduct ? "최신 판매일자에 있음" : "있음"}">●</span>`
      : v === "past" ? `<span class="fm" title="과거 판매일자에만 있음">○</span>` : ""}</td>`;
  }).join("");
  const actions = (key, start) =>
    `<button type="button" class="mini" data-analyze="${esc(key)}" data-start="${esc(start)}">분석</button>` +
    `<button type="button" class="mini" data-compare-add="${esc(key)}" data-start="${esc(start)}">비교 담기</button>`;
  const rows = list.map(p => {
    if (!expand) {
      const chips = p.versions.map(v => `<a href="#" class="vchip" data-analyze-link="${esc(p.key)}" data-start="${esc(v.start)}">${esc(v.start || "미상")}</a>`).join(" ");
      const warn = [p.versions.some(v => v.errors) ? "본문 못 읽은 파일 있음" : "", p.versions.some(v => v.pending) ? "색인 중" : ""].filter(Boolean).join(", ");
      return `<tr>
        <td><a href="#" data-analyze-link="${esc(p.key)}" data-start="${esc(p.latest.start)}"><b>${esc(p.name)}</b></a>${warn ? `<div class="warn">${esc(warn)}</div>` : ""}</td>
        <td>${esc(p.kind)}</td><td>${stBadge(p.status)}</td>
        <td class="vlist">${chips}</td><td class="nowrap">${docMarks(p.latest.types)}</td>
        ${fCells(p.feat, true)}<td class="actions">${actions(p.key, p.latest.start)}</td></tr>`;
    }
    return p.versions.map((v, i) => `<tr${i ? ' class="sub"' : ""}>
        <td>${i ? "" : `<b>${esc(p.name)}</b>`}</td><td>${i ? "" : esc(p.kind)}</td><td>${stBadge(v.status)}</td>
        <td class="nowrap"><a href="#" data-analyze-link="${esc(p.key)}" data-start="${esc(v.start)}">${esc(v.start || "미상")}</a>
          <div class="path">~ ${esc(v.end || "")}${v.end && !v.explicitEnd ? " (추정)" : ""}</div></td>
        <td class="nowrap">${docMarks(v.types)}${v.errors ? `<div class="warn">못 읽음 ${v.errors}</div>` : ""}</td>
        ${fCells(v.features, false)}<td class="actions">${actions(p.key, v.start)}</td></tr>`).join("");
  }).join("");
  const nVersions = CATALOG.reduce((s, p) => s + p.versions.length, 0);
  $("catalogBody").innerHTML = `
    <p class="summary">상품 <b>${CATALOG.length}</b>개 · 판매일자(버전) ${nVersions}개 · PDF ${DOCS.length}개` +
      (list.length !== CATALOG.length ? ` — 조건에 맞는 상품 <b>${list.length}</b>개` : "") +
      (pending ? ` · <span class="warn">색인 중 ${pending}개는 특징이 아직 반영되지 않음</span>` : "") +
      (noDate ? ` · <span class="warn">판매일자 인식 못함 ${noDate}개</span>` : "") + `</p>
    <p class="note">● 최신 판매일자에 있음 · ○ 과거 판매일자에만 있음 · 문서: 사=사업방법서 요=상품요약서 약=약관 (진한 글자=있음) ·
      판매상태와 종료일은 폴더 날짜로 추정 · 상품명·판매일자를 누르면 상품 분석</p>
    <div class="table-scroll"><table class="catalog">
      <thead><tr><th>상품명</th><th>분류</th><th>상태</th><th>${expand ? "판매일자" : "판매일자(최신순)"}</th><th>문서</th>${fHead}<th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${FEATURES.length + 6}" class="empty">조건에 맞는 상품이 없습니다.</td></tr>`}</tbody>
    </table></div>`;
}

// 엑셀(CSV): 판매일자(버전) 단위 한 줄
function catalogCsv() {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const head = ["상품명", "분류", "판매개시일", "판매종료일", "종료일 구분", "판매상태(추정)", "최신 판매일자 여부",
    ...CAT_TYPES.map(([t]) => t), ...FEATURES.map(f => f.name), "파일 수", "본문 못 읽은 파일", "파일 경로"];
  const rows = filteredCatalog().flatMap(p => p.versions.map((v, i) => [
    p.name, p.kind, v.start || "미상", v.end, v.end ? (v.explicitEnd ? "폴더명" : "추정") : "", v.status, i === 0 ? "Y" : "",
    ...CAT_TYPES.map(([t]) => (v.types.has(t) ? "Y" : "")), ...FEATURES.map(f => (v.features.has(f.id) ? "Y" : "")),
    v.docs.length, v.errors || "", v.docs.map(d => d.path).join(" | ")]));
  return "﻿" + [head, ...rows].map(r => r.map(q).join(",")).join("\r\n");
}

// ---------- 이벤트 ----------
$("catalogBtn").addEventListener("click", openCatalog);
$("closeCatalogBtn").addEventListener("click", () => { $("catalogPanel").hidden = true; });
["catSearch"].forEach(id => $(id).addEventListener("input", renderCatalog));
["catKind", "catStatus", "catFeature", "catExpand"].forEach(id => $(id).addEventListener("change", renderCatalog));
$("csvCatalogBtn").addEventListener("click", () => download(`product-list_${TODAY}.csv`, catalogCsv()));
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-analyze-link]");
  if (!a) return;
  e.preventDefault();
  showAnalysis(a.dataset.analyzeLink, a.dataset.start);
});
