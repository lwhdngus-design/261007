// 상품 분석 — 사업방법서·상품요약서에서 핵심 특징을 '원문 그대로' 뽑아 정해진 형식으로 보여줌 (오프라인 규칙 기반)
// 원칙: 문서에 있는 줄만 인용(요약·환산·추측 없음), 못 찾으면 "문서 내 확인 불가", 문서끼리 숫자가 다르면 [확인 필요]

// 분석 대상 문서 (이 순서로 보여줌). 산출방법서는 계산식 위주라 제외
const SOURCE_TYPES = ["사업방법서", "상품요약서", "약관"];

// 추출 항목: 공백 제거한 원문 줄에 정규식 적용
const ITEM_DEFS = [
  // labelRe: '보험기간:'처럼 항목명으로 적힌 줄이 있으면 그 줄만 사용 ("보험기간 중 사망" 같은 언급 제외)
  { id: "period", label: "보험기간", re: /보험기간|보장기간|세만기|년만기/, labelRe: /(보험기간|보장기간)[:：]/, words: "보험기간|보장기간", compare: true },
  { id: "pay", label: "납입기간·주기", re: /납입기간|납입주기|납입방법|월납|연납|일시납|\d+년납|전기납/, labelRe: /(납입기간|납입주기|납입방법)[:：]/, words: "납입기간|납입주기|납입방법", compare: true },
  { id: "age", label: "가입나이", re: /가입나이|가입연령|가입가능나이|가입가능연령/, labelRe: /(가입나이|가입연령)[:：]/, words: "가입나이|가입연령", compare: true },
  { id: "limit", label: "가입한도", re: /가입한도|가입금액|최저보험료|최고보험료|보험료한도|가입가능금액/, labelRe: /(가입한도|가입금액|보험료한도)[:：]/ },
  { id: "benefit", label: "보험금 지급사유", re: /지급사유|보험금을지급|지급합니다|지급하는경우/, exclude: /지급하지않|면책/ },
  { id: "exempt", label: "면책", re: /면책|지급하지않|보장개시|부책/ },
  { id: "reduce", label: "감액", re: /감액/ },
  { id: "withdraw", label: "중도인출", re: /중도인출/ },
  { id: "extra", label: "추가납입", re: /추가납입/ },
  { id: "etc", label: "기타", re: /해지환급금|갱신|배당|납입면제|특약|저해지|무해지/ },
];

// 보험종류 구분 (상품명 → 본문 순으로 확인)
const KIND_WORDS = [["종신", /종신/], ["정기", /정기보험/], ["연금", /연금보험/], ["저축", /저축보험/], ["건강", /건강보험/],
  ["암", /암보험|암케어/], ["실손", /실손/], ["CI", /CI보험|치명적질병/i], ["변액", /변액/], ["유니버셜", /유니버셜/]];
const TYPE_FLAGS = [["비갱신형", /비갱신형/], ["갱신형", /(?<!비)갱신형/], ["순수보장형", /순수보장형/], ["환급형", /(?<![저무])환급형/],
  ["저해지형", /저해지/], ["무해지형", /무해지/], ["무배당", /무배당/], ["유배당", /유배당/],
  ["금리확정형", /금리확정|확정금리/], ["금리연동형", /금리연동|공시이율/], ["보기 구분형(제1·제2보기)", /제1보기/]];

// ---------- 원문 줄 ----------
function docLines(d) {
  if (d._lines) return d._lines;
  const out = [];
  d.pages.forEach((t, pi) => {
    const lines = t.split("\n").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    lines.forEach((s, li) => out.push({ page: pi + 1, text: s, next: lines[li + 1] || "", compact: norm(s) }));
  });
  return (d._lines = out);
}

// 짧은 제목 줄(예: "7. 보험금 지급사유")은 다음 줄을 붙여 보여줌. "보험기간: 종신"처럼 값이 있는 줄은 그대로
const lineText = l => (l.text.length < 25 && l.next && !/[:：]\s*\S/.test(l.text) ? `${l.text} ${l.next}` : l.text).slice(0, 220);

function findLines(docs, re, perDoc = 3, exclude = null) {
  const hits = [], seen = new Set();
  let total = 0;
  for (const d of docs) {
    let n = 0;
    for (const l of docLines(d)) {
      if (!re.test(l.compact) || (exclude && exclude.test(l.compact))) continue;
      const text = lineText(l), k = norm(text);
      // 같은 줄, 또는 앞의 제목 줄에 이미 붙어 나온 줄은 건너뜀
      if (seen.has(k) || [...seen].some(x => x.includes(k))) continue;
      seen.add(k); total++;
      if (n < perDoc) { hits.push({ doc: d, page: l.page, text }); n++; }
    }
  }
  return { hits, more: total - hits.length };
}

const refOf = h => `${h.doc.docType} p.${h.page}`;
// 비교용 숫자 (줄 앞 번호 "4.", "1)", "(2)" 는 제외)
const stripEnum = t => t.replace(/^\s*(\d+[.)]|\(\d+\)|[①-⑳])\s*/, "");
// "보험기간: 종신 / 납입기간: 10년납"처럼 한 줄에 여러 항목이 있으면 해당 항목 값만 잘라 비교
function itemSegment(text, words) {
  const m = stripEnum(text).match(new RegExp(`(?:${words})\\s*[:：]\\s*(.*?)(?=\\s*/|\\s+[^\\s:：/]+\\s*[:：]|$)`));
  return m ? m[1] : stripEnum(text);
}
const numbersOf = texts => [...new Set(texts.map(stripEnum).join(" ").match(/\d+(?:[.,]\d+)?\s*(?:세|년|개월|일|%|원|만원|억원)?/g) || [])].map(norm).sort();

// ---------- 분석 ----------
function productVersions(key) {
  const docs = DOCS.filter(d => productKeyOf(d) === key);
  return [...new Set(docs.map(d => d.start))].sort().reverse();
}

function analyzeProduct(key, start) {
  const all = DOCS.filter(d => productKeyOf(d) === key && d.start === start && !d.error);
  const sources = all.filter(d => SOURCE_TYPES.includes(d.docType)).sort(byDocPriority);
  const others = all.filter(d => !SOURCE_TYPES.includes(d.docType) && d.docType !== "산출방법서").sort(byDocPriority);
  const name = (all[0] || DOCS.find(d => productKeyOf(d) === key) || {}).productName || key;
  const base = sources.length ? sources : others;
  const R = { key, start, name, base, rows: [], checks: [], cautions: [] };
  const missing = SOURCE_TYPES.filter(t => !base.some(d => d.docType === t));
  if (missing.length) R.checks.push(`이 판매일자 폴더에 ${missing.join("·")} 파일이 없어 해당 문서 내용은 반영되지 않았습니다.`);
  if (!sources.length && others.length) R.checks.push(`사업방법서·상품요약서·약관을 찾지 못해 ${others.map(d => d.name).join(", ")} 기준으로 추출했습니다.`);
  const failed = DOCS.filter(d => productKeyOf(d) === key && d.start === start && d.error);
  failed.forEach(d => R.checks.push(`${d.name}: ${d.error}`));

  // 1) 보험종류
  const nameCompact = norm(name);
  const kinds = KIND_WORDS.filter(([, re]) => re.test(nameCompact)).map(([k]) => ({ label: k, ref: "상품명" }));
  if (!kinds.length) {
    for (const [k, re] of KIND_WORDS) {
      const h = findLines(base, re, 1).hits[0];
      if (h) { kinds.push({ label: k, ref: refOf(h), text: h.text }); break; }
    }
  }
  const flags = [];
  for (const [label, re] of TYPE_FLAGS) {
    const h = findLines(base, re, 1).hits[0];
    if (h) flags.push({ label, ref: refOf(h), text: h.text, hit: h });
  }
  // 갱신형과 비갱신형이 함께 있으면(담보별로 다를 수 있음) 확인 필요
  if (flags.some(f => f.label === "갱신형") && flags.some(f => f.label === "비갱신형"))
    R.checks.push("[확인 필요] 갱신형과 비갱신형 표현이 함께 있습니다 — 담보별로 다른지 원문 확인: " +
      flags.filter(f => /갱신형/.test(f.label)).map(f => `"${f.text}" (${f.ref})`).join(" / "));
  R.kinds = kinds; R.flags = flags;
  R.rows.push({ label: "보험종류", lines: [...kinds, ...flags].map(x => ({ text: x.text ? `${x.label} — ${x.text}` : x.label, ref: x.ref })), more: 0 });

  // 2) 항목별 원문 줄
  for (const def of ITEM_DEFS) {
    let { hits, more } = def.labelRe ? findLines(base, def.labelRe) : { hits: [] };
    if (!hits.length) ({ hits, more } = findLines(base, def.re, 3, def.exclude));
    R.rows.push({ id: def.id, label: def.label, lines: hits.map(h => ({ text: h.text, ref: refOf(h), hit: h })), more });
    if (!hits.length) R.checks.push(`${def.label}: 문서 내 확인 불가`);
    // 사업방법서·상품요약서·약관 중 2개 이상에 나온 항목은 숫자를 대조해 다르면 확인 필요
    if (def.compare) {
      const byType = SOURCE_TYPES.map(t => hits.filter(h => h.doc.docType === t)).filter(x => x.length);
      if (byType.length > 1) {
        const sets = byType.map(x => numbersOf(x.map(h => itemSegment(h.text, def.words))).join());
        if (new Set(sets).size > 1)
          R.checks.push(`[확인 필요] ${def.label}: 문서 간 숫자가 다릅니다 — ` + byType.map(x => `"${x[0].text}" (${refOf(x[0])})`).join(" / "));
      }
    }
  }

  // 3) 유의사항: 불리하거나 오해하기 쉬운 조건 줄 (최대 5개)
  const rules = [["exempt"], ["reduce"], ["etc", /갱신.*(보험료|인상|변경)|보험료.*(인상|변경)/],
    ["etc", /저해지|무해지|해지환급금.*(없|적|지급하지)/], ["withdraw", /한도|제한|이내|수수료|경과|감소/],
    ["extra", /한도|제한|이내|비용|공제/]];
  for (const [id, re] of rules) {
    if (R.cautions.length >= 5) break;
    const l = (R.rows.find(r => r.id === id)?.lines || [])
      .find(l => (!re || re.test(norm(l.text))) && !R.cautions.some(c => c.text === l.text));
    if (l) R.cautions.push(l);
  }

  // 4) 한눈에 보기 (확인된 구분 + 분석 대상)
  const facts = [...kinds.map(k => k.label), ...flags.map(f => f.label)];
  R.overview = [
    `${name}: ${facts.length ? facts.join(" · ") : "보험종류 문서 내 확인 불가"}`,
    `판매개시일 ${start || "미상"} 기준 ${base.map(d => d.docType).join("·") || "문서 없음"} ${base.length}개 파일에서 원문 줄을 그대로 인용했습니다(요약·환산 없음).`,
  ];
  return R;
}

// ---------- 화면 ----------
let CURRENT = null;

const lineHtml = l => `<p class="line">${esc(l.text)} ` +
  (l.hit ? `<a href="#" class="ref" data-open="${DOCS.indexOf(l.hit.doc)}" data-page="${l.hit.page}">(${esc(l.ref)})</a>` : `<span class="ref">(${esc(l.ref)})</span>`) + `</p>`;

async function showAnalysis(key, start) {
  const versions = productVersions(key);
  if (!versions.includes(start)) start = versions[0];
  $("analysisPanel").hidden = false;
  $("analysisBody").innerHTML = `<p class="note">문서 본문을 불러오는 중…</p>`;
  try {
    await ensurePages(DOCS.filter(d => productKeyOf(d) === key && d.start === start));
  } catch (e) {
    $("analysisBody").innerHTML = `<p class="warn">본문을 불러오지 못했습니다: ${esc(e.message)}</p>`;
    return;
  }
  const R = analyzeProduct(key, start);
  CURRENT = R;
  $("analysisPanel").hidden = false;
  $("analysisTitle").textContent = `상품 분석 — ${R.name}`;
  $("analysisVersion").innerHTML = versions.map(v => `<option value="${esc(v)}"${v === start ? " selected" : ""}>판매개시일 ${esc(v || "미상")}</option>`).join("");
  const rows = R.rows.map(r => `<tr>
      <td>${esc(r.label)}</td>
      <td>${r.lines.length ? r.lines.map(lineHtml).join("") + (r.more > 0 ? `<p class="note">외 ${r.more}줄 더 있음 — 원문 확인</p>` : "")
 : `<span class="na">문서 내 확인 불가</span>`}</td>
      <td>${r.lines.length ? esc([...new Set(r.lines.map(l => l.ref))].join(", ")) : "-"}</td>
    </tr>`).join("");
  $("analysisBody").innerHTML = `
    <h3>한눈에 보기</h3>
    ${R.overview.map(t => `<p class="line">${esc(t)}</p>`).join("")}
    <h3>핵심 특징 표</h3>
    <table class="facts"><thead><tr><th>항목</th><th>내용 (원문 그대로)</th><th>문서 근거</th></tr></thead><tbody>${rows}</tbody></table>
    <h3>유의사항</h3>
    ${R.cautions.length ? `<ul>${R.cautions.map(l => `<li>${lineHtml(l)}</li>`).join("")}</ul>` : `<p class="na">문서에서 유의 조건 줄을 찾지 못했습니다.</p>`}
    <h3>확인 필요 항목</h3>
    ${R.checks.length ? `<ul>${R.checks.map(c => `<li class="${c.startsWith("[확인 필요]") ? "check" : ""}">${esc(c)}</li>`).join("")}</ul>` : `<p class="na">없음</p>`}
    <p class="note">※ 규칙 기반 자동 추출입니다. 항목 분류가 틀릴 수 있으니 근거 페이지를 눌러 원문을 확인하세요. 담보·형별 구분은 원문 줄에 적힌 그대로 보여줍니다.</p>`;
  $("analysisPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// 결과를 마크다운 표로 복사 (보고서·메일 붙여넣기용)
function analysisMarkdown(R) {
  const cell = s => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`# 상품 분석 — ${R.name} (판매개시일 ${R.start || "미상"})`, "", "### 한눈에 보기", ...R.overview, "",
    "### 핵심 특징 표", "| 항목 | 내용 | 문서 근거(페이지/조항) |", "|---|---|---|",
    ...R.rows.map(r => `| ${r.label} | ${r.lines.length ? cell(r.lines.map(l => l.text).join(" / ")) : "문서 내 확인 불가"} | ${cell([...new Set(r.lines.map(l => l.ref))].join(", ")) || "-"} |`),
    "", "### 유의사항", ...(R.cautions.length ? R.cautions.map(l => `- ${l.text} (${l.ref})`) : ["- 문서에서 찾지 못함"]),
    "", "### 확인 필요 항목", ...(R.checks.length ? R.checks.map(c => `- ${c}`) : ["- 없음"])].join("\n");
}

// 사용자가 준 분석 프롬프트 + 문서 본문 (사내 승인된 AI에 직접 붙여넣는 용도. 앱은 아무것도 전송하지 않음)
const ANALYSIS_PROMPT = `당신은 보험상품 문서를 분석하는 보험 상품 분석 전문가입니다.
아래 [문서]는 보험 상품의 사업방법서·상품요약서·약관입니다.
이 문서에서 상품의 핵심 특징을 추출해 [출력 형식]에 맞춰 요약하세요.

## 작성 원칙
1. 문서에 명시된 내용만 사용합니다. 추측하거나 일반 상식으로 보충하지 않습니다.
2. 문서에서 찾을 수 없는 항목은 "문서 내 확인 불가"로 표기합니다. 빈칸으로 두거나 지어내지 않습니다.
3. 숫자(나이, 기간, 금액, 비율)와 조건은 원문 그대로 옮깁니다. 반올림·환산·의역을 하지 않습니다.
4. 담보(보장)·플랜·형(例: 1형/2형, 갱신형/비갱신형)별로 내용이 다르면 구분해서 각각 적습니다.
5. 보험업계 용어는 원문 표현을 유지하되, 필요하면 괄호로 짧게 풀이합니다.
6. 상충하거나 모호한 내용이 있으면 임의로 해석하지 말고 "[확인 필요]"와 함께 원문 근거를 적습니다.

## 추출 항목
1. 상품명 / 보험종류
   - 종신, 정기, 연금, 저축, 건강, 암, 실손, CI, 변액, 유니버셜 등 구분
   - 갱신형/비갱신형, 보장형/환급형, 배당 유무, 금리확정/금리연동 여부
2. 보험기간 (주계약 및 담보별, 만기 형태: 세만기/년만기/종신)
3. 납입기간(납기) 및 납입방법 (월납/연납/일시납 등 납입주기)
4. 가입나이 (최저~최고, 보험기간·납입기간·성별·플랜별로 다르면 구분)
5. 가입한도 (최저/최고 가입금액, 최저/최고 보험료, 심사 기준에 따른 제한)
6. 보험금 지급사유 (담보별로 어떤 경우에 얼마를 지급하는지, 지급 횟수·감액 지급 기간 포함)
7. 면책 사유 (보험금을 지급하지 않는 경우) 및 면책기간·부책기간
8. 감액 조건 (감액지급 기간과 비율, 감액 사유)
9. 중도인출 (가능 여부, 가능 시점, 한도, 횟수, 수수료·해지환급금 영향)
10. 추가납입 (가능 여부, 한도, 가능 기간, 추가납입 시 비용 구조)
11. 기타 특이사항 (해지환급금 구조, 갱신 조건, 계약자배당, 특약 구성, 면제 조건 등)

## 출력 형식
### 한눈에 보기
(상품의 성격을 2~3줄로 요약)

### 핵심 특징 표
| 항목 | 내용 | 문서 근거(페이지/조항) |
|---|---|---|
| 보험종류 | | |
| 보험기간 | | |
| 납입기간·주기 | | |
| 가입나이 | | |
| 가입한도 | | |
| 보험금 지급사유 | | |
| 면책 | | |
| 감액 | | |
| 중도인출 | | |
| 추가납입 | | |
| 기타 | | |

### 유의사항
(가입자가 오해하기 쉬운 조건, 제한, 불리한 조건을 3~5개 이내로 정리)

### 확인 필요 항목
(문서에서 찾지 못했거나 모호한 항목 목록)

[문서]
`;

function promptWithDocs(R) {
  const docs = R.base;
  return ANALYSIS_PROMPT + docs.map(d =>
    `--- ${d.docType}: ${d.path} ---\n` + d.pages.map((t, i) => `[p.${i + 1}]\n${t.trim()}`).join("\n\n")).join("\n\n");
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = "복사됨";
  setTimeout(() => { btn.textContent = old; }, 1200);
}

document.addEventListener("click", e => {
  const b = e.target.closest("button[data-analyze]");
  if (b) showAnalysis(b.dataset.analyze, b.dataset.start);
});
$("analysisVersion").addEventListener("change", e => CURRENT && showAnalysis(CURRENT.key, e.target.value));
$("closeAnalysisBtn").addEventListener("click", () => { $("analysisPanel").hidden = true; });
$("copyMdBtn").addEventListener("click", e => CURRENT && copyText(analysisMarkdown(CURRENT), e.target));
$("copyPromptBtn").addEventListener("click", e => {
  if (!CURRENT) return;
  if (!confirm("문서 본문이 포함된 프롬프트를 클립보드에 복사합니다.\n외부 AI에 붙여넣기 전에 사내 보안 기준을 확인하세요.")) return;
  copyText(promptWithDocs(CURRENT), e.target);
});
