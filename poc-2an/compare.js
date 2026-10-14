// 2단계 — 상품 비교 · 개정 전후 비교
// 비교함에 상품(판매일자 단위)을 2~4개 담아 11개 항목을 나란히 비교하고,
// 같은 상품의 두 판매일자를 비교하면 문서별로 바뀐 줄(추가·삭제·변경)을 보여줍니다. 모두 원문 줄 그대로.

const MAX_COMPARE = 4;
const TRAY = []; // [{ key, start, name }]
let LAST_COMPARE = null;

// ---------- 비교함 ----------
function addToCompare(key, start) {
  if (TRAY.some(t => t.key === key && t.start === start)) return renderTray("이미 담긴 상품입니다.");
  if (TRAY.length >= MAX_COMPARE) return renderTray(`최대 ${MAX_COMPARE}개까지 비교할 수 있습니다.`);
  const d = DOCS.find(x => productKeyOf(x) === key);
  TRAY.push({ key, start, name: (d && d.productName) || key });
  renderTray();
}

function renderTray(message = "") {
  const tray = $("compareTray");
  tray.hidden = !TRAY.length && !message;
  $("trayItems").innerHTML = TRAY.map((t, i) =>
    `<span class="chip">${esc(t.name)} <b>${esc(t.start || "판매일자 미상")}</b>` +
    `<button type="button" data-tray-remove="${i}" title="빼기">×</button></span>`).join("") +
    (message ? ` <span class="warn">${esc(message)}</span>` : "");
  $("compareBtn").disabled = TRAY.length < 2;
  $("compareBtn").textContent = TRAY.length >= 2 && TRAY.every(t => t.key === TRAY[0].key) && TRAY.length === 2
    ? "개정 전후 비교" : `비교하기 (${TRAY.length})`;
}

// ---------- 항목 비교 ----------
// 행 상태: 같음 / 숫자 다름 / 표현 다름 / 일부 확인 불가 / 모두 확인 불가
function rowStatus(label, results) {
  // 감액·면책 '없음'도 비교 가능한 값으로 취급
  const cells = results.map(R => { const r = R.rows.find(x => x.label === label); return r.none ? [{ text: "없음" }] : r.lines; });
  if (cells.every(ls => !ls.length)) return { cls: "none", text: "모두 확인 불가" };
  if (cells.some(ls => !ls.length)) return { cls: "diff", text: "일부 확인 불가" };
  const isNone = ls => ls.length === 1 && ls[0].text === "없음";
  if (cells.some(isNone) && !cells.every(isNone)) return { cls: "diff", text: "있음/없음 다름" };
  if (label === "보험종류") {
    const sets = results.map(R => [...R.kinds, ...R.flags].map(x => x.label).sort().join("|"));
    return new Set(sets).size === 1 ? { cls: "same", text: "같음" } : { cls: "diff", text: "구분 다름" };
  }
  // "보험기간: 종신 / 납입기간: …"처럼 한 줄에 여러 항목이 있으면 해당 항목 값만 비교
  const def = ITEM_DEFS.find(d => d.label === label);
  const val = t => (def && def.words ? itemSegment(t, def.words) : stripEnum(t));
  const texts = cells.map(ls => [...new Set(ls.map(l => norm(val(l.text))))].sort().join("|"));
  if (new Set(texts).size === 1) return { cls: "same", text: "같음" };
  const nums = cells.map(ls => numbersOf(ls.map(l => val(l.text))).join());
  return new Set(nums).size > 1 ? { cls: "diff", text: "숫자 다름" } : { cls: "diff", text: "표현 다름" };
}

// ---------- 개정 전후: 문서별 바뀐 줄 ----------
const lineKey = t => norm(stripEnum(t));
// "가입나이: …" 처럼 항목명이 있는 줄은 항목명이 같으면 '변경'으로 짝지음
const lineLabel = t => { const m = stripEnum(t).match(/^([^:：]{1,20})[:：]/); return m ? norm(m[1]) : ""; };

function diffDocs(oldDocs, newDocs) {
  const lines = docs => docs.flatMap(d => docLines(d).map(l => ({ ...l, doc: d })));
  const a = lines(oldDocs), b = lines(newDocs);
  const aKeys = new Set(a.map(l => lineKey(l.text))), bKeys = new Set(b.map(l => lineKey(l.text)));
  const removed = a.filter(l => !bKeys.has(lineKey(l.text)));
  const added = b.filter(l => !aKeys.has(lineKey(l.text)));
  const changed = [];
  for (const r of removed) {
    const lab = lineLabel(r.text);
    if (!lab) continue;
    const i = added.findIndex(x => !x.paired && lineLabel(x.text) === lab);
    if (i !== -1) { added[i].paired = r.paired = true; changed.push({ from: r, to: added[i] }); }
  }
  return { changed, removed: removed.filter(l => !l.paired), added: added.filter(l => !l.paired) };
}

function revisionDiff(key, oldStart, newStart) {
  const pick = (start, t) => DOCS.filter(d => productKeyOf(d) === key && d.start === start && d.docType === t && !d.error);
  return SOURCE_TYPES.map(t => {
    const o = pick(oldStart, t), n = pick(newStart, t);
    if (!o.length || !n.length) return { type: t, missing: !o.length && !n.length ? "양쪽 모두 없음" : !o.length ? `${oldStart} 판에 없음` : `${newStart} 판에 없음` };
    return { type: t, ...diffDocs(o, n) };
  });
}

// ---------- 화면 ----------
const MAX_DIFF_LINES = 60;
const refLink = l => `<a href="#" class="ref" data-open="${DOCS.indexOf(l.doc)}" data-page="${l.page}">(${esc(l.doc.docType)} p.${l.page})</a>`;

async function showCompare() {
  if (TRAY.length < 2) return;
  const panel = $("comparePanel");
  panel.hidden = false;
  $("compareBody").innerHTML = `<p class="note">문서 본문을 불러오는 중…</p>`;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  const items = [...TRAY].sort((x, y) => (x.key === y.key ? (x.start || "").localeCompare(y.start || "") : 0));
  try {
    const cdocs = DOCS.filter(d => items.some(t => productKeyOf(d) === t.key && d.start === t.start));
    await ensurePages(cdocs);
    await prepareTables(cdocs);
  } catch (e) {
    $("compareBody").innerHTML = `<p class="warn">본문을 불러오지 못했습니다: ${esc(e.message)}</p>`;
    return;
  }
  const results = items.map(t => analyzeProduct(t.key, t.start));
  const revision = items.length === 2 && items[0].key === items[1].key;
  const diff = revision ? revisionDiff(items[0].key, items[0].start, items[1].start) : null;
  LAST_COMPARE = { items, results, revision, diff };
  $("compareTitle").textContent = revision ? `개정 전후 비교 — ${results[0].name}` : `상품 비교 (${items.length}개)`;
  renderCompare();
}

function renderCompare() {
  if (!LAST_COMPARE) return;
  const { results, diff } = LAST_COMPARE;
  const onlyDiff = $("onlyDiff").checked;
  const labels = results[0].rows.map(r => r.label);
  const head = `<tr><th>항목</th>${results.map(R => `<th>${esc(R.name)}<div class="path">판매개시일 ${esc(R.start || "미상")}</div></th>`).join("")}<th>비교</th></tr>`;
  let diffCount = 0;
  const body = labels.map(label => {
    const st = rowStatus(label, results);
    if (st.cls !== "same" && st.cls !== "none") diffCount++;
    if (onlyDiff && (st.cls === "same" || st.cls === "none")) return "";
    const cells = results.map(R => {
      const row = R.rows.find(r => r.label === label);
      return `<td>${row.lines.length ? row.lines.map(lineHtml).join("") + (row.more > 0 ? `<p class="note">외 ${row.more}줄</p>` : "")
        : `<span class="na">${esc(emptyText(row))}</span>`}</td>`;
    }).join("");
    return `<tr class="cmp-${st.cls}"><td>${esc(label)}</td>${cells}<td><span class="badge ${st.cls === "same" ? "on" : st.cls === "none" ? "off" : "plan"}">${esc(st.text)}</span></td></tr>`;
  }).join("");

  let diffHtml = "";
  if (diff) {
    diffHtml = `<h3>문서별 바뀐 줄 (${esc(results[0].start)} → ${esc(results[1].start)})</h3>
      <p class="note">줄 단위로 비교했습니다. 줄 앞 번호만 바뀐 경우는 같은 줄로 봅니다. "가입나이:"처럼 항목명이 같은 줄은 '변경'으로 짝지었습니다.</p>` +
      diff.map(x => {
        if (x.missing) return `<h4>${esc(x.type)}</h4><p class="na">비교 불가 — ${esc(x.missing)}</p>`;
        const n = x.changed.length + x.removed.length + x.added.length;
        if (!n) return `<h4>${esc(x.type)}</h4><p class="na">바뀐 줄 없음</p>`;
        const list = [
          ...x.changed.map(c => `<li class="chg"><b>변경</b> ${esc(c.from.text)} ${refLink(c.from)}<br>→ ${esc(c.to.text)} ${refLink(c.to)}</li>`),
          ...x.removed.map(l => `<li class="del"><b>삭제</b> ${esc(l.text)} ${refLink(l)}</li>`),
          ...x.added.map(l => `<li class="add"><b>추가</b> ${esc(l.text)} ${refLink(l)}</li>`),
        ];
        return `<h4>${esc(x.type)} — 변경 ${x.changed.length} · 삭제 ${x.removed.length} · 추가 ${x.added.length}</h4>
          <ul class="difflist">${list.slice(0, MAX_DIFF_LINES).join("")}</ul>` +
          (list.length > MAX_DIFF_LINES ? `<p class="note">외 ${list.length - MAX_DIFF_LINES}줄 — [엑셀 저장]에는 전부 들어갑니다.</p>` : "");
      }).join("");
  }
  const checks = results.flatMap(R => R.checks.filter(c => c.startsWith("[확인 필요]") || c.includes("파일이 없어")).map(c => `${R.name} (${R.start}): ${c}`));
  $("compareBody").innerHTML = `
    <p class="summary">11개 항목 중 <b>${diffCount}</b>개 항목이 다릅니다. (원문 줄 기준 자동 판정 — 근거를 눌러 원문 확인)</p>
    <div class="table-scroll"><table class="facts compare"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${results.length + 2}" class="empty">다른 항목이 없습니다.</td></tr>`}</tbody></table></div>
    ${diffHtml}
    ${checks.length ? `<h3>확인 필요</h3><ul>${checks.map(c => `<li class="check">${esc(c)}</li>`).join("")}</ul>` : ""}`;
}

// ---------- 내보내기 ----------
const cellText = row => row.lines.length ? row.lines.map(l => `${l.text} (${l.ref})`).join(" / ") : emptyText(row);

function compareMarkdown() {
  const { results, diff } = LAST_COMPARE;
  const esc2 = s => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const out = [`# ${$("compareTitle").textContent}`, "",
    `| 항목 | ${results.map(R => esc2(`${R.name} (${R.start || "미상"})`)).join(" | ")} | 비교 |`,
    `|---|${results.map(() => "---").join("|")}|---|`,
    ...results[0].rows.map(r => `| ${r.label} | ${results.map(R => esc2(cellText(R.rows.find(x => x.label === r.label)))).join(" | ")} | ${rowStatus(r.label, results).text} |`)];
  if (diff) {
    out.push("", `## 문서별 바뀐 줄 (${results[0].start} → ${results[1].start})`);
    diff.forEach(x => {
      out.push("", `### ${x.type}`);
      if (x.missing) return out.push(`- 비교 불가: ${x.missing}`);
      x.changed.forEach(c => out.push(`- 변경: ${c.from.text} → ${c.to.text} (${c.to.doc.docType} p.${c.to.page})`));
      x.removed.forEach(l => out.push(`- 삭제: ${l.text} (${l.doc.docType} p.${l.page})`));
      x.added.forEach(l => out.push(`- 추가: ${l.text} (${l.doc.docType} p.${l.page})`));
      if (!x.changed.length && !x.removed.length && !x.added.length) out.push("- 바뀐 줄 없음");
    });
  }
  return out.join("\n");
}

// 엑셀에서 바로 열리는 CSV (UTF-8 BOM)
function compareCsv() {
  const { results, diff } = LAST_COMPARE;
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [["항목", ...results.map(R => `${R.name} (${R.start || "미상"})`), "비교"],
    ...results[0].rows.map(r => [r.label, ...results.map(R => cellText(R.rows.find(x => x.label === r.label))), rowStatus(r.label, results).text])];
  if (diff) {
    rows.push([], ["문서", "구분", `${results[0].start} 판`, `${results[1].start} 판`, "근거"]);
    diff.forEach(x => {
      if (x.missing) return rows.push([x.type, "비교 불가", x.missing]);
      x.changed.forEach(c => rows.push([x.type, "변경", c.from.text, c.to.text, `p.${c.from.page} → p.${c.to.page}`]));
      x.removed.forEach(l => rows.push([x.type, "삭제", l.text, "", `p.${l.page}`]));
      x.added.forEach(l => rows.push([x.type, "추가", "", l.text, `p.${l.page}`]));
    });
  }
  return "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n");
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- 이벤트 ----------
document.addEventListener("click", e => {
  const add = e.target.closest("button[data-compare-add]");
  if (add) addToCompare(add.dataset.compareAdd, add.dataset.start);
  const rm = e.target.closest("button[data-tray-remove]");
  if (rm) { TRAY.splice(+rm.dataset.trayRemove, 1); renderTray(); }
});
$("addCompareBtn").addEventListener("click", () => CURRENT && addToCompare(CURRENT.key, CURRENT.start));
$("prevVersionBtn").addEventListener("click", () => {
  if (!CURRENT) return;
  const older = productVersions(CURRENT.key).filter(v => v && v < CURRENT.start); // 최신순 정렬
  if (!older.length) return alert("이전 판매일자 문서가 없습니다.");
  TRAY.length = 0;
  TRAY.push({ key: CURRENT.key, start: older[0], name: CURRENT.name }, { key: CURRENT.key, start: CURRENT.start, name: CURRENT.name });
  renderTray();
  showCompare();
});
$("compareBtn").addEventListener("click", showCompare);
$("clearTrayBtn").addEventListener("click", () => { TRAY.length = 0; renderTray(); });
$("onlyDiff").addEventListener("change", renderCompare);
$("closeCompareBtn").addEventListener("click", () => { $("comparePanel").hidden = true; });
$("copyCompareBtn").addEventListener("click", e => LAST_COMPARE && copyText(compareMarkdown(), e.target));
$("csvCompareBtn").addEventListener("click", () => LAST_COMPARE &&
  download(`${LAST_COMPARE.revision ? "revision-compare" : "product-compare"}_${TODAY}.csv`, compareCsv())); // 영문 파일명: 일부 환경에서 한글 다운로드 이름이 깨짐
