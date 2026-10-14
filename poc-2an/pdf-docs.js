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
function productNameOf(fileName) {
  let s = fileName.replace(/\.pdf$/i, "");
  for (const d of findDates(s).reverse()) s = s.slice(0, d.s) + " " + s.slice(d.e);
  for (const t of DOC_TYPES) s = s.split(t).join(" ");
  s = s.replace(/(보통|특별)\s*$/, "").replace(/[_\-\s~]+/g, " ").trim();
  return s;
}

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
async function extractPages(file) {
  const data = new Uint8Array(await file.arrayBuffer());
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

async function loadFolder(fileList) {
  const files = [...fileList].filter(f => /\.pdf$/i.test(f.name));
  DOCS.forEach(d => d.url && URL.revokeObjectURL(d.url));
  DOCS.length = 0;
  if (!files.length) {
    $("docsStatus").textContent = "선택한 폴더에 PDF 파일이 없습니다.";
    renderDocs();
    return;
  }
  const root = (files[0].webkitRelativePath || files[0].name).split("/")[0];
  $("docsProgress").hidden = false;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const path = file.webkitRelativePath || file.name;
    $("docsStatus").textContent = `읽는 중 ${i + 1}/${files.length} — ${path}`;
    $("docsBar").style.width = `${(i / files.length) * 100}%`;
    const productName = productNameOf(file.name);
    const doc = { file, path, name: file.name, docType: docTypeOf(file.name), productName,
                  productKey: norm(productName), ...saleDatesOf(path), pages: [], error: "" };
    try {
      doc.pages = await extractPages(file);
      if (!doc.pages.join("").trim()) doc.error = "본문 텍스트 없음 (스캔 이미지 PDF일 수 있음)";
    } catch (e) {
      doc.error = "읽기 실패: " + (e && e.message ? e.message : e);
    }
    if (doc.error) failed++;
    doc.searchText = norm(doc.path + " " + doc.pages.join(" "));
    DOCS.push(doc);
  }
  inferEndDates();
  $("docsBar").style.width = "100%";
  setTimeout(() => { $("docsProgress").hidden = true; }, 600);
  const noDate = DOCS.filter(d => !d.start).length;
  $("docsStatus").textContent = `연결됨: ${root} — PDF ${DOCS.length}개` +
    (failed ? ` (본문 못 읽음 ${failed}개)` : "") + (noDate ? ` · 판매일자 인식 못함 ${noDate}개` : "");
  renderDocs();
}

// ---------- 검색 ----------
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

function searchDocs(q) {
  const terms = q.keyword.trim().split(/\s+/).map(norm).filter(Boolean);
  return DOCS
    .filter(d => terms.every(t => d.searchText.includes(t)))
    .filter(d => docMatchesFilters(d, q))
    .map(d => ({ doc: d, terms, nameHit: terms.length > 0 && terms.every(t => norm(d.name).includes(t)) }))
    // 정렬: 파일명(상품명) 일치 우선 → 판매개시일 최신순
    .sort((a, b) => (b.nameHit - a.nameHit) || (b.doc.start || "").localeCompare(a.doc.start || ""));
}

const MAX_ROWS = 200;

function renderDocs() {
  const cur = currentQuery();
  // 질문(특징) 검색일 때는 문서 목록 대신 '상품별 답변' 패널을 보여줌
  if (!DOCS.length || cur.mode === "question") { $("docsPanel").hidden = true; return; }
  $("docsPanel").hidden = false;
  const rows = searchDocs(cur.form);
  $("docsSummary").innerHTML = `검색 결과 <b>${rows.length}</b>건 / 불러온 PDF ${DOCS.length}건` +
    (rows.length > MAX_ROWS ? ` (상위 ${MAX_ROWS}건만 표시)` : "");
  if (!rows.length) {
    $("docsResults").innerHTML = `<tr><td colspan="5" class="empty">조건에 맞는 문서가 없습니다.</td></tr>`;
    return;
  }
  $("docsResults").innerHTML = rows.slice(0, MAX_ROWS).map(({ doc: d, terms }, i) => {
    let snipHtml = "", firstPage = 1;
    if (terms.length) {
      const list = [];
      d.pages.forEach((text, pi) => {
        if (list.length >= 3) return;
        snippets(text, terms, 3 - list.length).forEach(s => list.push({ ...s, page: pi + 1 }));
      });
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
  d.url ||= URL.createObjectURL(d.file);
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
