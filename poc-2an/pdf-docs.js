// 기초서류 PDF 폴더 연결 — 선택한 폴더의 PDF 본문을 브라우저(PC) 안에서 읽어 검색에 포함
// 파일은 업로드·저장하지 않고 메모리에만 둡니다. (index.html의 norm, esc, $, readForm, TODAY 사용)

// ---------- pdf.js 설정: 서버 없이(file://) 동작하도록 내장 한글 CMap 사용 ----------
class EmbeddedCMapReaderFactory {
  constructor() {}
  async fetch({ name }) {
    const b64 = window.PDF_CMAPS_KO && window.PDF_CMAPS_KO[name];
    if (!b64) throw new Error(`CMap 없음: ${name}`);
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { cMapData: data, compressionType: 1 }; // 1 = BINARY(bcmap)
  }
}

const DOCS = []; // { file, path, name, docType, productName, productKey, start, end, pages: [text], error }

// ---------- 경로·파일명 해석 ----------
const DOC_TYPES = ["사업방법서", "산출방법서", "상품요약서", "약관"];
const docTypeOf = name => DOC_TYPES.find(t => name.includes(t)) || "기타";

const pad = n => String(n).padStart(2, "0");
function validDate(y, m, d) {
  y = +y; m = +m; d = +(d || 1);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// 문자열에서 날짜를 모두 찾기: 2023.01.01 / 2023-1-1 / 2023년 1월 1일 / 20230101 / 230101 / 2023.01 / 202301
function findDates(str) {
  const found = [];
  const patterns = [
    [/(?<!\d)((?:19|20)\d{2})\s*[.\-_/년]\s*(\d{1,2})\s*(?:[.\-_/월]\s*(\d{1,2})\s*일?)?(?!\d)/g, m => validDate(m[1], m[2], m[3])],
    [/(?<!\d)((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g, m => validDate(m[1], m[2], m[3])],
    [/(?<!\d)(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g, m => validDate("20" + m[1], m[2], m[3])],
    [/(?<!\d)((?:19|20)\d{2})(0[1-9]|1[0-2])(?!\d)/g, m => validDate(m[1], m[2])],
  ];
  for (const [re, toDate] of patterns) {
    for (const m of str.matchAll(re)) {
      const date = toDate(m);
      const s = m.index, e = m.index + m[0].length;
      if (date && !found.some(f => s < f.e && e > f.s)) found.push({ s, e, date, text: m[0] });
    }
  }
  return found.sort((a, b) => a.s - b.s);
}

// 판매일자: 가장 안쪽 폴더명부터 찾고, 없으면 파일명에서 찾음. 한 이름에 날짜가 2개면 시작~종료로 봄
function saleDatesOf(path) {
  const parts = path.split("/");
  const candidates = [...parts.slice(0, -1).reverse(), parts[parts.length - 1]];
  for (const seg of candidates) {
    const ds = findDates(seg);
    if (ds.length) return { start: ds[0].date, end: ds.length > 1 ? ds[1].date : "", explicitEnd: ds.length > 1 };
  }
  return { start: "", end: "", explicitEnd: false };
}

// 상품명 추정: 파일명에서 확장자·문서유형·날짜·구분기호를 뺀 나머지
// 문서유형을 뜻하는 말 (긴 말부터 지워야 "보험약관"에서 "보험"만 남지 않음)
const DOC_WORDS = ["보험약관", "보통약관", "특별약관", "기본약관", "특약약관", ...DOC_TYPES];

function productNameOf(fileName) {
  let s = fileName.replace(/\.pdf$/i, "");
  // "[보험약관] (무)…", "【사업방법서】…" 같은 대괄호 머리표 제거 (상품명의 둥근 괄호 "(무)"는 유지)
  s = s.replace(/[\[【〔［][^\]】〕］]*[\]】〕］]/g, " ");
  for (const d of findDates(s).reverse()) s = s.slice(0, d.s) + " " + s.slice(d.e);
  for (const t of DOC_WORDS) s = s.split(t).join(" ");
  // "(계약자용)", "_계약자용" 등은 같은 상품으로 봄 → 상품명에서 제외
  s = s.replace(/[(（]\s*계약자\s*용\s*[)）]|계약자\s*용/g, " ");
  s = s.replace(/(보통|특별)\s*$/, "").replace(/[_\-\s~]+/g, " ").trim();
  return s;
}

// 같은 상품으로 묶는 키: 공백 무시, "무배당 ○○"과 "(무)○○"은 같은 상품
const productKeyFrom = name => norm(name).replace(/^무배당/, "(무)");

function dayBefore(iso) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("sv-SE");
}

// 같은 상품(추정 상품명 동일)의 다음 판매일자 하루 전을 판매종료일로 추정
function inferEndDates() {
  const groups = {};
  DOCS.filter(d => d.start && !d.explicitEnd).forEach(d => (groups[d.productKey] ||= []).push(d));
  for (const list of Object.values(groups)) {
    const starts = [...new Set(list.map(d => d.start))].sort();
    list.forEach(d => {
      const next = starts.find(s => s > d.start);
      d.end = next ? dayBefore(next) : "";
    });
  }
}

// ---------- PDF 텍스트 추출 ----------
async function extractPages(data) {
  const pdf = await pdfjsLib.getDocument({ data, CMapReaderFactory: EmbeddedCMapReaderFactory, cMapPacked: true }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    // 글자 위치(y)가 바뀌면 줄바꿈 → 원문 줄 단위로 근거를 보여줄 수 있게 함
    let text = "", lastY = null;
    for (const it of tc.items) {
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith("\n")) text += "\n";
      text += it.str + (it.hasEOL ? "\n" : "");
      if (y !== null && it.str) lastY = y;
    }
    pages.push(text);
    page.cleanup();
  }
  await pdf.destroy();
  return pages;
}

function makeDoc(path, extra) {
  const name = path.split("/").pop();
  const productName = productNameOf(name);
  return { path, name, docType: docTypeOf(name), productName, productKey: productKeyFrom(productName),
           ...saleDatesOf(path), pages: [], error: "", ...extra };
}

async function readPages(doc, getBytes) {
  try {
    doc.pages = await extractPages(await getBytes());
    if (!doc.pages.join("").trim()) doc.error = "본문 텍스트 없음 (스캔 이미지 PDF일 수 있음)";
  } catch (e) {
    doc.error = "읽기 실패: " + (e && e.message ? e.message : e);
  }
}

function finishLoading(label) {
  if (!SERVER_MODE) DOCS.forEach(d => { d.searchText = norm(d.path + " " + d.pages.join(" ")); });
  inferEndDates();
  $("docsBar").style.width = "100%";
  setTimeout(() => { $("docsProgress").hidden = true; }, 600);
  const failed = DOCS.filter(d => d.error).length, noDate = DOCS.filter(d => !d.start).length;
  $("docsDot").classList.toggle("ok", DOCS.length > 0);
  $("docsStatus").textContent = `${label} — PDF ${DOCS.length}개` +
    (failed ? ` (본문 못 읽음 ${failed}개)` : "") + (noDate ? ` · 판매일자 인식 못함 ${noDate}개` : "");
  renderAll();
}

function resetDocs() {
  DOCS.forEach(d => d.url && d.url.startsWith("blob:") && URL.revokeObjectURL(d.url));
  DOCS.length = 0;
}

const progress = (i, n, path) => {
  $("docsProgress").hidden = false;
  $("docsStatus").textContent = `읽는 중 ${i + 1}/${n} — ${path}`;
  $("docsBar").style.width = `${(i / n) * 100}%`;
};

// 방법 1) [폴더 선택] — 파일을 매번 다시 선택 (index.html을 더블클릭해서 연 경우)
async function loadFolder(fileList) {
  const files = [...fileList].filter(f => /\.pdf$/i.test(f.name));
  resetDocs();
  if (!files.length) {
    $("docsStatus").textContent = "선택한 폴더에 PDF 파일이 없습니다.";
    renderAll();
    return;
  }
  const root = (files[0].webkitRelativePath || files[0].name).split("/")[0];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const doc = makeDoc(file.webkitRelativePath || file.name, { file });
    progress(i, files.length, doc.path);
    await readPages(doc, async () => new Uint8Array(await file.arrayBuffer()));
    DOCS.push(doc);
  }
  finishLoading(`연결됨: ${root}`);
}

// 방법 2) 자동 연결 — start.bat(serve.py)로 연 경우. 지정 폴더 목록을 받아 오고,
// 색인이 안 된 PDF만 브라우저가 읽어서 내 PC의 검색 색인(.docs-cache/index.db)에 저장
const SERVER_MODE = location.protocol.startsWith("http");

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

// 서버 모드에서는 본문을 필요할 때만 가져옴 (상품 분석·AI 프롬프트용)
async function ensurePages(docs) {
  if (!SERVER_MODE) return;
  for (const d of docs) {
    if (d.pagesLoaded || !d.id) continue;
    d.pages = (await api(`api/pages?id=${d.id}`)).pages;
    d.pagesLoaded = true;
    d._lines = null;
    d._sections = null;
  }
}

let indexing = false;

async function loadFromServer() {
  if (indexing) return;
  const { root, folder, files } = await api("api/docs");
  resetDocs();
  $("docsFolder").textContent = folder;
  for (const f of files) {
    const url = "docs/" + f.path.split("/").map(encodeURIComponent).join("/");
    DOCS.push(makeDoc(f.path, { url, id: f.id, size: f.size, mtime: f.mtime, indexed: f.indexed,
                                error: f.error || "", features: f.features || {} }));
  }
  const todo = DOCS.filter(d => !d.indexed);
  finishLoading(`자동 연결: ${root}`);
  if (!todo.length) return;
  // 새 파일·수정된 파일만 읽어서 색인 (중간에 창을 닫아도 다음에 이어서 진행)
  indexing = true;
  $("reloadDocsBtn").disabled = true;
  const t0 = Date.now();
  try {
    for (let i = 0; i < todo.length; i++) {
      const d = todo[i];
      progress(i, todo.length, d.path);
      if (i > 2) {
        const left = Math.round((Date.now() - t0) / i * (todo.length - i) / 60000);
        $("docsStatus").textContent += ` · 남은 시간 약 ${left}분`;
      }
      await readPages(d, async () => new Uint8Array(await (await fetch(d.url)).arrayBuffer()));
      const r = await api("api/index", { path: d.path, size: d.size, mtime: d.mtime, pages: d.pages, error: d.error });
      Object.assign(d, { id: r.id, features: r.features, indexed: true, pages: [], pagesLoaded: false });
      if (i % 25 === 24) renderAll(); // 색인된 문서부터 바로 검색 가능
    }
  } finally {
    indexing = false;
    $("reloadDocsBtn").disabled = false;
  }
  finishLoading(`자동 연결: ${root} (새로 색인 ${todo.length}개)`);
}

if (SERVER_MODE) {
  $("serverMode").hidden = false;
  $("noFolder").hidden = true;
  $("reloadDocsBtn").hidden = false;
  $("docsNote").textContent = "start.bat으로 실행 중 — 지정 폴더를 자동으로 읽어 내 PC의 검색 색인(앱 폴더 .docs-cache)에 저장합니다. " +
    "다음 실행부터는 새로 추가·수정된 파일만 읽습니다. 외부로는 아무것도 전송되지 않습니다.";
  const run = () => loadFromServer().catch(err => { indexing = false; $("docsStatus").textContent = "자동 연결 실패: " + err.message; });
  $("reloadDocsBtn").addEventListener("click", run);
  run();
}

// ---------- 검색 ----------
// 판매기간·분류·판매상태 조건 (키워드 검색과 질문 검색이 함께 사용)
function docMatchesFilters(d, { from, to, category, status }) {
  // 판매기간 겹침: 판매개시일 <= To AND (종료일 빈값 OR 종료일 >= From). 판매일자를 모르면 기간 검색에서 제외
  if ((from || to) && !(d.start && (!to || d.start <= to) && (!from || !d.end || d.end >= from))) return false;
  if (category && !d.path.includes(category)) return false;
  if (status && !(d.start && (status === "판매중"
    ? d.start <= TODAY && (!d.end || d.end >= TODAY)
    : d.end && d.end < TODAY))) return false;
  return true;
}

// 공백 제거 문자열에서 찾은 위치를 원문 위치로 되돌려 앞뒤 문맥을 잘라냄
function snippets(pageText, terms, max) {
  const map = [];
  let compact = "";
  for (let i = 0; i < pageText.length; i++) {
    if (!/\s/.test(pageText[i])) { compact += pageText[i].toLowerCase(); map.push(i); }
  }
  const out = [];
  for (const t of terms) { // 페이지당 단어별 첫 위치만
    const idx = compact.indexOf(t);
    if (out.length >= max || idx === -1) continue;
    const s = map[idx], e = map[idx + t.length - 1] + 1;
    const a = Math.max(0, s - 40), b = Math.min(pageText.length, e + 40);
    out.push({ before: pageText.slice(a, s), hit: pageText.slice(s, e), after: pageText.slice(e, b), lead: a > 0, tail: b < pageText.length });
  }
  return out;
}

const sortDocs = (rows) => rows
  // 정렬: 파일명(상품명) 일치 우선 → 판매개시일 최신순
  .sort((a, b) => (b.nameHit - a.nameHit) || (b.doc.start || "").localeCompare(a.doc.start || ""));

async function searchDocs(q) {
  const terms = q.keyword.trim().split(/\s+/).map(norm).filter(Boolean);
  let docs = DOCS.filter(d => docMatchesFilters(d, q));
  if (terms.length) {
    if (SERVER_MODE) {
      const ids = new Set((await api("api/search", { terms })).ids);
      docs = docs.filter(d => ids.has(d.id));
    } else {
      docs = docs.filter(d => terms.every(t => d.searchText.includes(t)));
    }
  }
  return sortDocs(docs.map(d => ({ doc: d, terms, nameHit: terms.length > 0 && terms.every(t => norm(d.name).includes(t)) })));
}

// 일치 문장: 파일 모드는 메모리 본문에서, 서버 모드는 색인에서 (화면에 보이는 문서만)
async function snippetsFor(docs, terms) {
  const out = new Map();
  if (!terms.length) return out;
  if (SERVER_MODE) {
    const ids = docs.filter(d => d.id).map(d => d.id);
    const res = ids.length ? (await api("api/snippets", { ids, terms })).snippets : {};
    docs.forEach(d => out.set(d, res[d.id] || []));
  } else {
    docs.forEach(d => {
      const list = [];
      d.pages.forEach((text, pi) => {
        if (list.length >= 3) return;
        snippets(text, terms, 3 - list.length).forEach(s => list.push({ ...s, page: pi + 1 }));
      });
      out.set(d, list);
    });
  }
  return out;
}

const MAX_ROWS = 200;
let docsRenderSeq = 0;

async function renderDocs() {
  const seq = ++docsRenderSeq; // 빠르게 다시 검색하면 이전 결과는 버림
  const cur = currentQuery();
  // 질문(특징) 검색일 때는 문서 목록 대신 '상품별 답변' 패널을 보여줌
  // 검색어·조건이 하나도 없으면 문서 목록 대신 상품 목록이 메인
  const f = cur.form, idle = !f.keyword.trim() && !f.from && !f.to && !f.category && !f.status;
  if (!DOCS.length || cur.mode === "question" || idle) { $("docsPanel").hidden = true; return; }
  $("docsPanel").hidden = false;
  let rows, snips;
  try {
    rows = await searchDocs(cur.form);
    snips = await snippetsFor(rows.slice(0, MAX_ROWS).map(r => r.doc), rows.length ? rows[0].terms : []);
  } catch (e) {
    if (seq === docsRenderSeq) $("docsSummary").textContent = "검색 실패: " + e.message;
    return;
  }
  if (seq !== docsRenderSeq) return;
  const notIndexed = DOCS.filter(d => SERVER_MODE && !d.indexed).length;
  $("docsSummary").innerHTML = `검색 결과 <b>${rows.length}</b>건 / 불러온 PDF ${DOCS.length}건` +
    (rows.length > MAX_ROWS ? ` (상위 ${MAX_ROWS}건만 표시)` : "") +
    (notIndexed && cur.form.keyword.trim() ? ` · 색인 중인 ${notIndexed}건은 아직 검색되지 않음` : "");
  if (!rows.length) {
    $("docsResults").innerHTML = `<tr><td colspan="5" class="empty">조건에 맞는 문서가 없습니다.</td></tr>`;
    return;
  }
  $("docsResults").innerHTML = rows.slice(0, MAX_ROWS).map(({ doc: d, terms }) => {
    let snipHtml = "", firstPage = 1;
    if (terms.length) {
      const list = snips.get(d) || [];
      if (list.length) firstPage = list[0].page;
      snipHtml = list.map(s => `<p class="snip"><span class="pg">p.${s.page}</span>${s.lead ? "…" : ""}${esc(s.before)}<mark>${esc(s.hit)}</mark>${esc(s.after)}${s.tail ? "…" : ""}</p>`).join("")
        || `<p class="snip note">파일 경로에서 일치</p>`;
    }
    if (d.error) snipHtml += `<p class="warn">${esc(d.error)}</p>`;
    const period = d.start ? `${esc(d.start)}<div class="path">~ ${esc(d.end || "")}${d.end && !d.explicitEnd ? " (추정)" : ""}</div>` : `<span class="warn">인식 못함</span>`;
    return `<tr>
      <td>${period}</td>
      <td>${esc(d.docType)}</td>
      <td>${esc(d.productName || d.name)}<div class="path">${esc(d.path)}</div></td>
      <td>${snipHtml}</td>
      <td class="actions"><button type="button" data-open="${DOCS.indexOf(d)}" data-page="${firstPage}">열기</button>
        <button type="button" data-analyze="${esc(productKeyOf(d))}" data-start="${esc(d.start)}">분석</button></td>
    </tr>`;
  }).join("");
}

// 같은 상품으로 묶는 키 (파일명에서 상품명을 못 뽑으면 파일명 전체)
const productKeyOf = d => d.productKey || norm(d.name);

// PDF 열기: 메모리의 파일을 새 탭으로 (일치한 페이지로 이동). 결과·답변·분석 화면 공통
function openDoc(index, page) {
  const d = DOCS[index];
  d.url ||= URL.createObjectURL(d.file); // 서버 모드는 처음부터 docs/... 주소가 있음
  window.open(`${d.url}#page=${page || 1}`, "_blank");
}
document.addEventListener("click", e => {
  const btn = e.target.closest("button[data-open], a[data-open]");
  if (!btn) return;
  e.preventDefault();
  openDoc(+btn.dataset.open, btn.dataset.page);
});

$("folderInput").addEventListener("change", e => {
  loadFolder(e.target.files).catch(err => { $("docsStatus").textContent = "폴더 읽기 실패: " + err.message; });
  e.target.value = "";
});
