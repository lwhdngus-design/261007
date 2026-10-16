// 상품 분석 — 사업방법서·상품요약서에서 핵심 특징을 '원문 그대로' 뽑아 정해진 형식으로 보여줌 (오프라인 규칙 기반)
// 원칙: 문서에 있는 줄만 인용(요약·환산·추측 없음), 못 찾으면 "문서 내 확인 불가", 문서끼리 숫자가 다르면 [확인 필요]

// 분석 대상 문서 (이 순서로 보여줌). 산출방법서는 계산식 위주라 제외
const SOURCE_TYPES = ["사업방법서", "상품요약서", "약관"];

// 사업방법서 2번 목차 "보험기간, 보험료 납입기간, 가입나이 및 보험료 납입주기" (보험기간·납입기간·가입나이가 함께 씀)
const SEC2 = /^보험기간.*(납입기간|가입나이)/;
const SECTION_MAX_LINES = 8;

// 추출 항목: 공백 제거한 원문 줄에 정규식 적용
const ITEM_DEFS = [
  // labelRe: '보험기간:'처럼 항목명으로 적힌 줄이 있으면 그 줄만 사용 ("보험기간 중 사망" 같은 언급 제외)
  // heading: 사업방법서 목차 제목(공백 제거, 앞 번호 뺀 부분)에 맞추는 별칭. 제목을 찾으면 다음 목차 제목 전까지가 내용
  { id: "period", label: "보험기간", re: /보험기간|보장기간|세만기|년만기/, labelRe: /(보험기간|보장기간)[:：]/, words: "보험기간|보장기간", compare: true, heading: SEC2 },
  { id: "pay", label: "납입기간·주기", re: /납입기간|납입주기|납입방법|월납|연납|일시납|\d+년납|전기납/, labelRe: /(납입기간|납입주기|납입방법)[:：]/, words: "납입기간|납입주기|납입방법", compare: true, heading: SEC2 },
  { id: "age", label: "가입나이", re: /가입나이|가입연령|가입가능나이|가입가능연령/, labelRe: /(가입나이|가입연령)[:：]/, words: "가입나이|가입연령", compare: true, heading: SEC2 },
  { id: "limit", label: "가입한도", re: /가입한도|가입금액|최저보험료|최고보험료|보험료한도|가입가능금액/, labelRe: /(가입한도|가입금액|보험료한도)[:：]/ },
  { id: "benefit", label: "보험금 지급사유", re: /지급사유|보험금을지급|지급합니다|지급하는경우/, exclude: /지급하지않|면책/ },
  // 지급기준표를 못 찾았을 때만 쓰는 규칙 (기간 + 지급하지 않음 / 기간 + 비율)
  { id: "exempt", label: "면책", re: /면책기간|부담보|((\d+년|\d+개월|\d+일)(미만|이내|동안)|보장개시일).{0,80}(지급하지않|보장하지않|면책)|(\d+일|\d+년)(이|을)?지난날의다음날/ },
  { id: "reduce", label: "감액", re: /((\d+년|\d+개월)(미만|이내)).{0,80}(\d+%|감액)|(\d+%|감액).{0,40}(\d+년|\d+개월)(미만|이내)/ },
  { id: "withdraw", label: "중도인출", re: /중도인출|계약자적립액(의)?(일부)?인출|적립금(의)?인출/, words: "중도인출|계약자적립액인출",
    heading: /중도인출|계약자적립액(의)?(일부)?인출|적립금(의)?인출/ },
  { id: "extra", label: "추가납입", re: /추가납입/ },
  { id: "etc", label: "기타", re: /해지환급금|갱신|배당|납입면제|특약|저해지|무해지/ },
  // ---- 사업방법서 목차 기준 항목 (목차 번호 순서) ----
  { id: "kind", label: "종목·세목", toc: 1, re: /세목|보험종목의(명칭|구성)/, heading: /^보험종목의(명칭|구성)|종목및세목|세목에관한사항/ },
  { id: "mandatory", label: "의무가입", toc: 3, re: /의무(가입|부가)/, heading: /의무(가입|부가)/ },
  { id: "dividend", label: "배당", toc: 4, re: /계약자배당|배당금/, heading: /^(계약자)?배당/ },
  { id: "premium", label: "보험료", toc: 5, re: /기본보험료|영업보험료|추가납입보험료|최저보험료|최고보험료/,
    heading: /^보험료(및보험가입금액)?에관한사항|^보험료의(산출|계산)/, labelRe: /(기본보험료|영업보험료)[:：]/, words: "기본보험료|영업보험료", compare: true },
  { id: "discount", label: "보험료 할인", toc: 6, re: /보험료할인|할인율|\d+%할인/, heading: /할인/ },
  { id: "bonus", label: "유지보너스", toc: 7, re: /유지보너스/, heading: /유지보너스/, labelRe: /유지보너스[:：]/, words: "유지보너스", compare: true },
  { id: "prepay", label: "보험료 선납", toc: 8, re: /선납/, heading: /선납/, labelRe: /선납[:：]/, words: "선납", compare: true },
  { id: "revival", label: "해지계약 부활", toc: 9, re: /부활|효력회복/, heading: /부활|효력회복/ },
  { id: "overdue_rate", label: "연체이율", toc: 10, re: /연체이(율|자율)/, heading: /연체이(율|자)/, labelRe: /연체이율[:：]/, words: "연체이율", compare: true },
  { id: "loan", label: "보험계약대출", toc: 12, re: /보험계약대출|약관대출/, heading: /보험계약대출|약관대출/, labelRe: /(보험계약대출|약관대출)[:：]/, words: "보험계약대출|약관대출", compare: true },
  { id: "partial_refund", label: "해약환급금 일부지급", toc: 13, re: /해(약|지)환급금(의)?일부(지급|만지급)|일부지급형/, heading: /환급금(의)?일부지급/,
    labelRe: /일부지급[:：]/, words: "일부지급", compare: true },
  { id: "simple_uw", label: "간편심사형", toc: 14, re: /간편(심사|고지)/, heading: /간편(심사|고지)|유병자/ },
  { id: "savings_type", label: "적립형 계약", toc: 15, re: /적립형(계약|으로|전환)/, heading: /적립형/ },
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
      if (!re.test(l.compact) || (exclude && exclude.test(l.compact)) || isTocLine(l.text) || PAYTABLE_HEAD.test(l.compact)) continue;
      const text = lineText(l), k = norm(text);
      // 같은 줄, 또는 앞의 제목 줄에 이미 붙어 나온 줄은 건너뜀
      if (seen.has(k) || [...seen].some(x => x.includes(k))) continue;
      seen.add(k); total++;
      if (n < perDoc) { hits.push({ doc: d, page: l.page, text }); n++; }
    }
  }
  return { hits, more: total - hits.length };
}

// 목차 줄: "제5조【보험금을 지급하지 않는 사유】 ........27" 처럼 점선 뒤 쪽번호
const isTocLine = t => /[.·…ㆍ‥]{4,}\s*\d*\s*$/.test(t) || /[.·…]{6,}/.test(t);

// ---------- 약관의 보험금 지급기준표 ----------
// 감액: "1년 미만 … 50%"처럼 기간 + 비율(또는 '감액'), 면책: 기간/보장개시일 + 지급하지 않음·면책
const REDUCE_RE = /((\d+년|\d+개월|\d+일)(미만|이내|이전|까지|동안)|보장개시일.{0,20}(\d+년|\d+개월)).{0,80}(\d+(\.\d+)?%|감액|절반)|(\d+(\.\d+)?%|감액).{0,40}(\d+년|\d+개월)(미만|이내)/;
const EXEMPT_RE = /((\d+년|\d+개월|\d+일)(미만|이내|동안|이전|까지)|보장개시일|책임개시일).{0,80}(지급하지않|보장하지않|면책|책임을지지않|해당하지않|보상하지않)|면책기간|부담보|보장개시일[은는].{0,40}(\d+일|\d+년|\d+개월)(이|을)?지난|(\d+일|\d+년|\d+개월)(이|을)?지난날의다음날/;
const PAYTABLE_HEAD = /보험금\s*지급\s*기준\s*표/;
// 표 제목 줄: "지급기준표"로 끝나는 짧은 줄 ("…지급기준표에서 정한 보험금" 같은 본문 조각은 제외)
const isPayTableTitle = l => PAYTABLE_HEAD.test(l.compact) && !isTocLine(l.text) && l.compact.length <= 40 &&
  /보험금지급기준표[)\]】>]*$/.test(l.compact.replace(/\([^)]*\)$/, ""));
const NOTE_START = /^\s*(\(?주\s*\d*\)|주\s*\d*[).:：]|주\s*\d+\s|※|\*|<\s*주|【\s*주|\[\s*주)/;
const NOTE_ITEM = /^\s*(\d+[.)]\s|[①-⑳]|\(\d+\)|[가-하][.)]\s|-\s|ㆍ|·)/;
// 표 다음에 오는 예시 상자 등은 표 영역에서 제외
const REGION_END = /^\s*(【[^】]*예시[^】]*】|\[[^\]]*예시[^\]]*\])/;
// 감액·면책 판정: 보험금 지급 맥락이 있고, 이율·적립액 설명은 제외 ("5년 이내 1.25%" 같은 최저보증이율 문장 오인 방지)
const PAY_CONTEXT = /지급|보험금|급여금|진단비|진단금|수술비|입원비|보장/;
const NOT_BENEFIT = /이율|금리|이자|적립액|적립금|수수료|해지환급금|보험료의?납입/;
const isReduce = t => { const c = norm(t); return REDUCE_RE.test(c) && PAY_CONTEXT.test(c) && !NOT_BENEFIT.test(c); };
const isExempt = t => { const c = norm(t); return EXEMPT_RE.test(c) && !NOT_BENEFIT.test(c); };
const TABLE_END = /^\s*(【\s*(부\s*표|별\s*표)|\[\s*(부\s*표|별\s*표)|<\s*(부\s*표|별\s*표)|부\s*표\s*\d|별\s*표\s*\d|제\s*\d+\s*관|제\s*\d+\s*조\s*[\[(【(])/;
const MAX_TABLE_LINES = 160;

function payTablesOf(docs) {
  const tables = [];
  for (const d of docs) {
    const lines = docLines(d);
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i];
      // 제목 줄만 (본문 속 "보험금 지급기준표에서 정한…" 문장과 목차 줄은 제외)
      if (!isPayTableTitle(head)) continue;
      const rows = [], notes = [];
      let inNotes = false, j = i + 1;
      for (; j < lines.length && j < i + MAX_TABLE_LINES; j++) {
        const l = lines[j];
        if (isPayTableTitle(l)) break; // 다음 지급기준표
        if (j > i + 1 && (TABLE_END.test(l.text) || REGION_END.test(l.text))) break;
        if (isTocLine(l.text)) continue;
        if (NOTE_START.test(l.text)) { inNotes = true; notes.push({ text: l.text, page: l.page, doc: d }); continue; }
        if (inNotes) {
          // "(주)" 아래 1. 2. ① 같은 번호 항목은 각각 하나의 주석, 그 밖의 줄은 앞 주석에 이어 붙임
          if (NOTE_ITEM.test(l.text)) { notes.push({ text: l.text, page: l.page, doc: d }); continue; }
          const last = notes[notes.length - 1];
          if (last && last.text.length < 600) last.text += " " + l.text;
          continue;
        }
        if (/^(급부명|급부명칭|지급사유|지급금액|보장명|구\s*분|\(기준|기준\s*:)/.test(l.text.replace(/\s+/g, " "))) continue; // 표 머리
        rows.push({ text: l.text, page: l.page, doc: d });
      }
      if (rows.length || notes.length) tables.push({ doc: d, page: head.page, title: head.text, rows, notes });
      i = j - 1;
    }
  }
  return tables;
}

// 항목이 비었을 때 문구: 지급기준표에서 감액·면책 조건이 없으면 "없음", 그 밖에는 "문서 내 확인 불가"
const NONE_TEXT = "없음 (보험금 지급기준표와 주석에 해당 조건 없음)";
const emptyText = r => (r.none ? r.noneText || NONE_TEXT : "문서 내 확인 불가");

// ---------- 지급기준표 칸 복원 (글자 위치로 행·열 다시 맞춤) ----------
// 지급기준표가 있는 쪽만 PDF를 다시 읽어, 머리행(급부명칭·지급사유·지급금액)의 가로 위치로 열을 나누고
// 세로 간격이 넓은 곳에서 행을 나눔 → "사망보험금 | 피보험자가 사망하였을 때 | 보험가입금액"
// PDF 쪽의 글자 조각 → 위치(y)가 같은 것끼리 한 줄 (위 → 아래 순서)
// 글자 조각 잇기: 간격이 좁으면 붙이고(한 글자씩 저장된 PDF 대비), 넓으면 띄움
const joinItems = its => its.reduce((acc, it, i) => {
  const prev = its[i - 1];
  return acc + (prev && it.x - (prev.x + prev.w) > 2.5 ? " " : "") + it.str;
}, "").replace(/\s+/g, " ").trim();

function buildPageLines(items) {
  const lines = [];
  for (const it of items) {
    if (!it.str || !it.str.trim() || !it.transform) continue;
    const x = it.transform[4], y = it.transform[5];
    let line = lines.find(l => Math.abs(l.y - y) <= 2);
    if (!line) lines.push(line = { y, items: [] });
    line.items.push({ x, w: it.width || 0, h: it.height || Math.abs(it.transform[3]) || 10, str: it.str });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = joinItems(l.items);
    l.compact = norm(l.text);
    l.h = Math.max(...l.items.map(i => i.h));
  }
  return lines;
}

function structurePage(items, pageNo, st) {
  const lines = buildPageLines(items);
  const join = joinItems;
  const flush = () => {
    const seg = st.cur;
    if (!seg || !seg.raw.length) return;
    const gaps = seg.raw.slice(1).map((l, i) => seg.raw[i].y - l.y).filter(g => g > 0.5);
    const min = Math.min(...gaps), max = Math.max(...gaps);
    const rows = [];
    let row = null;
    seg.raw.forEach((l, i) => {
      const gap = i ? seg.raw[i - 1].y - l.y : Infinity;
      // 간격이 모두 비슷하면 줄마다 한 행, 아니면 넓은 간격에서 행 나눔
      const newRow = !row || l.page !== row.page || !gaps.length || max / min < 1.25 || gap > min * 1.35;
      if (newRow) rows.push(row = { page: l.page, cells: seg.cols.map(() => []) });
      const parts = seg.cols.map(() => []);
      l.items.forEach(it => {
        let c = 0;
        seg.cols.forEach((cx, k) => { if (it.x + 4 >= cx) c = k; });
        parts[c].push(it);
      });
      parts.forEach((its, c) => { if (its.length) row.cells[c].push(join(its)); });
    });
    // 칸 안에서 줄이 바뀐 글자는 이어 붙임 (한글은 붙여서, 그 밖은 띄어서)
    const cellText = lines => lines.reduce((acc, t) => acc + (acc && !/[가-힣(]$/.test(acc) || /^[A-Za-z0-9]/.test(t) ? " " : "") + t, "");
    seg.rows.push(...rows.map(r => ({ page: r.page, text: r.cells.map(c => cellText(c).trim()).filter(Boolean).join(" | ") }))
      .filter(r => r.text));
    seg.raw = [];
  };
  for (const l of lines) {
    if (isPayTableTitle(l)) {
      flush();
      st.segs.push(st.cur = { title: l.text, page: pageNo, cols: null, raw: [], rows: [],
        regions: [{ page: pageNo, top: l.y + l.h, bottom: l.y - 3 }] });
      st.inNotes = false;
      continue;
    }
    if (!st.cur) continue;
    if (TABLE_END.test(l.text) || REGION_END.test(l.text)) { flush(); st.cur = null; continue; }
    // 표·주석이 차지하는 세로 범위 (다음 쪽으로 이어지면 최대 2쪽까지)
    let reg = st.cur.regions.find(r => r.page === pageNo);
    if (!reg) {
      if (st.cur.regions.length >= 2) { flush(); st.cur = null; continue; }
      st.cur.regions.push(reg = { page: pageNo, top: l.y + l.h, bottom: l.y - 3 });
    }
    reg.bottom = Math.min(reg.bottom, l.y - Math.max(3, l.h * 0.35));
    if (NOTE_START.test(l.text)) { flush(); st.inNotes = true; continue; }
    if (/지급사유/.test(l.compact) && /지급금액|지급액|보험금액/.test(l.compact) && l.compact.length < 60) {
      flush();
      // 머리행 글자 위치 = 열 시작점 (가까운 조각은 하나로)
      // 머리행에서 글자 사이 빈칸이 넓은 곳 = 칸 경계
      const xs = [];
      l.items.forEach((i, k) => { const prev = l.items[k - 1]; if (!prev || i.x - (prev.x + prev.w) > 8) xs.push(i.x); });
      st.cur.cols = xs; st.inNotes = false;
      continue;
    }
    if (st.inNotes || !st.cur.cols) continue;
    st.cur.raw.push({ ...l, page: pageNo });
  }
  flush();
}

// 쪽의 세로 범위(top~bottom, PDF 좌표)를 그림으로 잘라냄
async function renderRegions(pdf, regions) {
  const images = [], canvases = new Map();
  for (const r of regions) {
    try {
      if (!canvases.has(r.page)) {
        const page = await pdf.getPage(r.page);
        const vp = page.getViewport({ scale: 2 });
        const cv = document.createElement("canvas");
        cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
        await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        canvases.set(r.page, { cv, vp });
      }
      const { cv, vp } = canvases.get(r.page);
      const top = Math.max(0, vp.convertToViewportPoint(0, r.top + 4)[1]);
      const bottom = Math.min(cv.height, vp.convertToViewportPoint(0, r.bottom)[1] + 4);
      if (bottom - top < 20) continue;
      const out = document.createElement("canvas");
      out.width = cv.width; out.height = Math.ceil(bottom - top);
      const ctx = out.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(cv, 0, top, cv.width, out.height, 0, 0, out.width, out.height);
      images.push({ page: r.page, src: out.toDataURL("image/jpeg", 0.85) });
    } catch (e) { /* 그림을 못 만들면 글자 결과만 사용 */ }
  }
  canvases.clear();
  return images;
}

const openPdf = async d => {
  const data = d.file ? new Uint8Array(await d.file.arrayBuffer()) : new Uint8Array(await (await fetch(d.url)).arrayBuffer());
  return pdfjsLib.getDocument({ data, CMapReaderFactory: EmbeddedCMapReaderFactory, cMapPacked: true }).promise;
};

// ---------- 사업방법서 목차 구역 ----------
// "5. 보험료에 관한 사항"처럼 번호로 시작하는 짧은 제목 줄부터 다음 번호(+1~+3) 제목 전까지를 한 구역으로 봄.
// 구역 안의 "가." "(1)" "①" 같은 하위 번호, 수식 속 "2." 같은 줄에서는 끊지 않음. 별첨(서식) 이후는 보지 않음.
// 제목 글자는 한글·영문·괄호로 시작 (또는 "14. 2 형(간편심사형)…"처럼 '숫자+형/종')
const TOP_HEAD = /^(\d{1,2})[.)]((?:\d+(?:형|종)|[가-힣A-Za-z(「“"]).*)$/;
const NONE_BODY = /^(해당사항(이)?없음|해당(사항)?없음|없음|-|―)\.?$/;
const SECTION_NONE_TEXT = "없음 (사업방법서 해당사항 없음)";

function sectionsOf(d) {
  if (d._sections) return d._sections;
  const secs = [];
  let cur = null;
  for (const l of docLines(d)) {
    if (/^[(\[【<]?별첨/.test(l.compact)) break;
    const m = l.compact.match(TOP_HEAD);
    if (m && l.compact.length <= 45 && !isTocLine(l.text)) {
      const n = +m[1];
      if ((!cur && n <= 3) || (cur && n > cur.num && n <= cur.num + 3)) {
        cur = { num: n, title: l.text, key: m[2].replace(/[:：].*$/, ""), page: l.page, doc: d, lines: [] };
        if (/[:：]\s*\S/.test(l.text)) cur.lines.push(l); // "1. 보험종목의 명칭: 내용"처럼 제목 줄에 내용이 있으면 포함
        secs.push(cur);
        continue;
      }
    }
    if (cur) cur.lines.push(l);
  }
  return (d._sections = secs);
}

// 표가 들어 있는 구역(짧은 줄이 많음)은 그림으로도 잘라 둠
const isTableLike = sec => sec.lines.length >= 6 && sec.lines.filter(l => l.text.length < 20).length / sec.lines.length >= 0.3;

async function prepareSections(docs) {
  for (const d of docs) {
    if (d.docType !== "사업방법서" || d._sectionImgs !== undefined) continue;
    d._sectionImgs = {};
    const secs = sectionsOf(d).filter(isTableLike);
    if (!secs.length) continue;
    try {
      const pdf = await openPdf(d);
      const all = sectionsOf(d);
      const linesOfPage = new Map();
      const pageLines = async p => {
        if (!linesOfPage.has(p)) { const pg = await pdf.getPage(p); linesOfPage.set(p, buildPageLines((await pg.getTextContent()).items)); pg.cleanup(); }
        return linesOfPage.get(p);
      };
      const findHead = (lines, sec) => { const k = norm(sec.title); return lines.find(l => l.compact === k || (k.length > 8 && l.compact.startsWith(k.slice(0, 12)))); };
      for (const sec of secs) {
        const next = all[all.indexOf(sec) + 1];
        const last = Math.min(next ? next.page : sec.lines[sec.lines.length - 1].page, sec.page + 2);
        const regions = [];
        for (let p = sec.page; p <= last; p++) {
          const lines = await pageLines(p);
          if (!lines.length) continue;
          let top = Math.max(...lines.map(l => l.y + l.h)), bottom = Math.min(...lines.map(l => l.y)) - 4;
          if (p === sec.page) { const h = findHead(lines, sec); if (!h) break; top = h.y + h.h; }
          if (next && p === next.page) { const h = findHead(lines, next); if (h) bottom = h.y + h.h + 2; }
          if (top - bottom > 10) regions.push({ page: p, top, bottom });
        }
        d._sectionImgs[sec.num] = await renderRegions(pdf, regions);
      }
      await pdf.destroy();
    } catch (e) { /* 그림 없이 글자만 */ }
  }
}

async function prepareTables(docs) {
  for (const d of docs) {
    if (d.docType !== "약관" || d._tableSegs !== undefined) continue;
    const tables = payTablesOf([d]);
    d._tableSegs = null;
    if (!tables.length) continue;
    const pages = [...new Set(tables.flatMap(t => [t.page, ...t.rows.map(r => r.page), ...t.notes.map(n => n.page)]))].sort((a, b) => a - b);
    try {
      const pdf = await openPdf(d);
      const st = { segs: [], cur: null, inNotes: false };
      let prev = null;
      for (const p of pages) {
        if (prev !== null && p !== prev + 1) { st.cur = null; } // 떨어진 쪽은 이어 붙이지 않음
        const page = await pdf.getPage(p);
        structurePage((await page.getTextContent()).items, p, st);
        page.cleanup();
        prev = p;
      }
      // 표 영역을 그림으로 잘라 둠 (약관에 보이는 모양 그대로)
      for (const seg of st.segs) seg.images = await renderRegions(pdf, seg.regions || []);
      await pdf.destroy();
      d._tableSegs = st.segs;
    } catch (e) {
      d._tableSegs = null; // 실패하면 줄 단위 결과 사용
    }
  }
}

// 줄 단위로 찾은 표와 칸 복원 결과를 순서대로 짝지음
function attachStructured(tables) {
  const byDoc = new Map();
  tables.forEach(t => { if (!byDoc.has(t.doc)) byDoc.set(t.doc, []); byDoc.get(t.doc).push(t); });
  for (const [d, ts] of byDoc) {
    const segs = d._tableSegs || [];
    ts.forEach((t, i) => {
      if (!segs[i]) return;
      if (segs[i].rows.length) t.structRows = segs[i].rows.map(r => ({ ...r, doc: d }));
      if (segs[i].images && segs[i].images.length) t.images = segs[i].images.map(im => ({ ...im, doc: d }));
    });
  }
  return tables;
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

  // 규칙 기반 판정 중 확신이 낮은 항목 → 표의 항목명 옆 표시 + 확인 필요 목록
  const lowConf = (label, reason, line) => {
    R.lowConf = R.lowConf || new Set();
    R.lowConf.add(label);
    R.checks.push(`[확신 낮음] ${label} — ${reason}` + (line ? ` : "${line.text.slice(0, 80)}" (${line.ref})` : ""));
  };

  // 줄 앞의 항목명 (예: "6. 보험금 지급사유: …" → 보험금지급사유, "제3조(보험금의 지급사유) …" → 보험금의지급사유)
  const lineLabelOf = t => {
    const m = String(t).match(/^\s*(?:\d{1,2}\s*[.)]\s*)?([^:：()]{2,20})\s*[:：]/) || String(t).match(/^\s*제\s*\d+\s*조\s*\(([^)]{2,20})\)/);
    return m ? norm(m[1]) : "";
  };

  // 1) 보험종류
  const nameCompact = norm(name);
  const kinds = KIND_WORDS.filter(([, re]) => re.test(nameCompact)).map(([k]) => ({ label: k, ref: "상품명" }));
  if (!kinds.length) {
    for (const [k, re] of KIND_WORDS) {
      const h = findLines(base, re, 1).hits[0];
      if (h) { kinds.push({ label: k, ref: refOf(h), text: h.text, hit: h }); break; }
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
  kinds.filter(k => k.ref !== "상품명").forEach(k =>
    lowConf("보험종류", `상품명에 종류가 없어 본문 단어 '${k.label}'로 판정`, { text: k.text, ref: k.ref }));
  // 구분 표현은 상품을 정의하는 줄(명칭·구성·유형 등)이나 그 표현으로 시작하는 줄에서 찾았을 때만 믿을 만함
  const DEFINE_LINE = /명칭|종목|구성|유형|종류|형태|구분|특이사항|상품의특징|해지환급금/;
  flags.filter(f => !DEFINE_LINE.test(lineLabelOf(f.text)) && !norm(f.text).startsWith(norm(f.label).replace(/\(.*$/, "")))
    .forEach(f => lowConf("보험종류", `'${f.label}'은 상품 정의 줄이 아닌 본문 문장의 단어로 판정 — 상품 구분을 설명하는 문장인지 확인`, { text: f.text, ref: f.ref }));
  // hit(문서·쪽)을 함께 넘겨야 근거가 눌림 (상품명에서 판정한 것은 쪽이 없어 글자로만 표시)
  R.rows.push({ label: "보험종류", lines: [...kinds, ...flags].map(x => ({ text: x.text ? `${x.label} — ${x.text}` : x.label, ref: x.ref, hit: x.hit })), more: 0 });

  // 2) 항목별 원문 줄 — 보험금 지급사유·감액·면책은 약관의 '보험금 지급기준표'와 그 주석을 우선 사용
  const tables = attachStructured(payTablesOf(base.filter(d => d.docType === "약관")));
  R.payTables = tables;
  // 근거 표시: 어느 표에서 나왔는지 (예: "약관 p.4 별표2 암진단특약 보험금 지급기준표 주석")
  const tRef = x => `약관 p.${x.page} ${(x.table || "지급기준표").replace(/\s+/g, " ").slice(0, 30)}${x.note ? " 주석" : ""}`;
  if (!tables.length && base.some(d => d.docType === "약관"))
    R.checks.push("약관에서 '보험금 지급기준표'를 찾지 못해 지급사유·감액·면책은 본문 문장에서 찾았습니다 (정확도 낮음).");
  const tLine = x => ({ text: x.text.slice(0, 400), ref: tRef(x), hit: { doc: x.doc, page: x.page } });
  for (const def of ITEM_DEFS) {
    if (tables.length && ["benefit", "reduce", "exempt"].includes(def.id)) {
      const main = tables[0]; // 첫 번째 지급기준표 = 주계약
      const notes = tables.flatMap(t => t.notes.map(n => ({ ...n, note: true, table: t.title })));
      const rowsAll = tables.flatMap(t => (t.structRows || t.rows).map(r => ({ ...r, table: t.title })));
      let lines, more = 0, none = false;
      if (def.id === "benefit") {
        const mainRows = main.structRows || main.rows;
        lines = mainRows.slice(0, 10).map(r => tLine({ ...r, table: main.title }));
        more = mainRows.length - lines.length;
      } else {
        const test = def.id === "reduce" ? isReduce : isExempt;
        const found = [...notes, ...rowsAll].filter(x => test(x.text));
        lines = found.slice(0, 6).map(tLine);
        more = found.length - lines.length;
        none = !found.length;
      }
      // 지급사유는 첫 번째(주계약) 표만 보여주고 나머지 표 제목을 안내. 감액·면책은 모든 표의 주석에서 찾음
      const extra = def.id === "benefit" && tables.length > 1
        ? "그 밖의 지급기준표: " + tables.slice(1).map(t => `${t.title} (p.${t.page})`).join(", ") : "";
      if (none) lowConf(def.label, def.id === "reduce"
        ? "지급기준표 주석에서 '기간 + 감액 비율' 문장을 찾지 못해 '없음'으로 판정 — 표 그림과 주석 확인"
        : "지급기준표 주석에서 '기간 + 지급하지 않음' 문장을 찾지 못해 '없음'으로 판정 — 표 그림과 주석 확인");
      R.rows.push({ id: def.id, label: def.label, lines, more, none, fromTable: true, extra,
                    images: def.id === "benefit" ? main.images || [] : [] });
      if (!lines.length && !none) R.checks.push(`${def.label}: 지급기준표에서 표 내용을 읽지 못함 (약관 p.${main.page} 원문 확인)`);
      continue;
    }
    let { hits, more } = def.labelRe ? findLines(base, def.labelRe) : { hits: [] };
    const labelled = hits.length > 0;
    // 사업방법서 목차 구역 (항목명 줄이 없을 때)
    if (!hits.length && def.heading) {
      const sec = base.filter(d => d.docType === "사업방법서").flatMap(sectionsOf).find(x => def.heading.test(x.key));
      if (sec) {
        const body = norm(sec.lines.map(l => l.text).join(""));
        const row = { id: def.id, label: def.label, section: sec.title, imgSource: "사업방법서",
          images: (sec.doc._sectionImgs && sec.doc._sectionImgs[sec.num] || []).map(im => ({ ...im, doc: sec.doc })) };
        if (!body || NONE_BODY.test(body)) {
          Object.assign(row, { lines: [], more: 0, none: !!body, noneText: SECTION_NONE_TEXT,
            ...(body ? {} : { images: [] }) });
          if (!body) R.checks.push(`${def.label}: 사업방법서 '${sec.title}' 내용 없음`);
        } else {
          const ls = sec.lines.slice(0, SECTION_MAX_LINES);
          Object.assign(row, { lines: ls.map(l => ({ text: l.text, ref: refOf({ doc: sec.doc, page: l.page }), hit: { doc: sec.doc, page: l.page } })),
            more: sec.lines.length - ls.length });
        }
        R.rows.push(row);
        continue;
      }
    }
    if (!hits.length) ({ hits, more } = findLines(base, def.re, 3, def.exclude));
    R.rows.push({ id: def.id, label: def.label, lines: hits.map(h => ({ text: h.text, ref: refOf(h), hit: h })), more });
    // 항목명이 붙은 줄을 못 찾아 문장 검색으로 찾았는데, 그 줄이 다른 항목명으로 시작하면 다른 내용일 가능성이 큼
    const own = new RegExp(def.words || def.label.replace(/[·\s]/g, "|"));
    const foreign = !labelled && def.id !== "etc" ? hits.find(h => { const lb = lineLabelOf(h.text); return lb && !own.test(lb); }) : null;
    if (foreign)
      lowConf(def.label, `항목명 줄을 못 찾아 문장 검색으로 찾았고, 그 줄은 '${lineLabelOf(foreign.text)}' 항목의 줄 — 다른 내용일 수 있음`, { text: foreign.text, ref: refOf(foreign) });
    if (!hits.length) R.checks.push(`${def.label}: 문서 내 확인 불가`);
    // 사업방법서·상품요약서·약관 중 2개 이상에 나온 항목은 숫자를 대조해 다르면 확인 필요
    if (def.compare && labelled) {
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
// 지급기준표 그림 (누르면 PDF 해당 쪽) + 글자로 읽은 결과는 펼쳐보기
// 지급기준표 그림 모음 (창으로 크게 보기용) — 칸에는 작은 미리보기와 버튼만 둠
const IMG_SETS = [];
function registerImgSet(title, images) { IMG_SETS.push({ title, images }); return IMG_SETS.length - 1; }

function tableImagesHtml(r, title = "보험금 지급기준표") {
  const id = registerImgSet(title, r.images);
  const pages = r.images.map(i => i.page).join(", p.");
  const what = r.section ? "표" : "지급기준표";
  const thumb = `<button type="button" class="tblthumb" data-imgset="${id}" title="크게 보기"><img src="${r.images[0].src}" alt="${what} 미리보기"></button>`;
  const text = r.lines.length ? `<details class="tbltext"><summary>글자로 보기 (복사용 · 칸 구분이 정확하지 않을 수 있음)</summary>${r.lines.map(lineHtml).join("")}</details>` : "";
  return `<div class="tblwrap">${thumb}<div class="tblmeta"><button type="button" class="mini primary" data-imgset="${id}">${what} 보기</button>` +
    `<span class="note">${esc(r.imgSource || "약관")} p.${pages}${r.images.length > 1 ? ` (${r.images.length}쪽)` : ""}</span></div></div>` + text +
    (r.extra ? `<p class="note">${esc(r.extra)}</p>` : "");
}

// 큰 창: 그림 여러 묶음을 나란히 (상품 비교 시 여러 상품)
function openImgModal(title, sets) {
  $("modalTitle").textContent = title;
  $("modalBody").style.gridTemplateColumns = `repeat(${sets.length}, minmax(${sets.length > 1 ? 420 : 300}px, 1fr))`;
  $("modalBody").innerHTML = sets.map(s => `<div class="modal-col">${sets.length > 1 ? `<h4>${esc(s.title)}</h4>` : ""}` +
    (s.images.length ? s.images.map(im => `<img src="${im.src}" alt="${esc(im.doc.docType)} p.${im.page}">` +
      `<p class="note">${esc(im.doc.docType)} p.${im.page} <a href="#" data-open="${DOCS.indexOf(im.doc)}" data-page="${im.page}">원문 열기</a></p>`).join("")
      : `<p class="na">지급기준표 그림 없음</p>`) + `</div>`).join("");
  $("imgModal").hidden = false;
  $("modalClose").focus();
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-imgset]");
  if (b) { const s = IMG_SETS[+b.dataset.imgset]; openImgModal(s.title, [s]); return; }
  if (e.target.id === "imgModal" || e.target.closest("#modalClose")) $("imgModal").hidden = true;
});
document.addEventListener("keydown", e => { if (e.key === "Escape") $("imgModal").hidden = true; });

// ---------- 화면 ----------
let CURRENT = null;

const lineHtml = l => `<p class="line">${esc(l.text)} ` +
  (l.hit ? `<a href="#" class="ref" data-open="${DOCS.indexOf(l.hit.doc)}" data-page="${l.hit.page}">(${esc(l.ref)})</a>` : `<span class="ref">(${esc(l.ref)})</span>`) + `</p>`;

async function showAnalysis(key, start) {
  const versions = productVersions(key);
  if (!versions.includes(start)) start = versions[0];
  $("analysisPanel").hidden = false;
  showView("analysis");
  $("analysisBody").innerHTML = `<p class="note">문서 본문을 불러오는 중…</p>`;
  try {
    const vdocs = DOCS.filter(d => productKeyOf(d) === key && d.start === start);
    await ensurePages(vdocs);
    await prepareTables(vdocs);
    await prepareSections(vdocs);
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
      <td>${esc(r.label)}${R.lowConf && R.lowConf.has(r.label) ? `<span class="lowconf" title="규칙 판정 확신 낮음 — 아래 확인 필요 항목 참고">확신 낮음</span>` : ""}</td>
      <td>${r.images && r.images.length ? tableImagesHtml(r, `${R.name} (${R.start || "미상"}) ${r.section ? "사업방법서 " + r.section : "보험금 지급기준표"}`) : r.lines.length ? r.lines.map(lineHtml).join("") + (r.more > 0 ? `<p class="note">외 ${r.more}줄 더 있음 — 원문 확인</p>` : "")
        + (r.extra ? `<p class="note">${esc(r.extra)}</p>` : "")
 : `<span class="na">${esc(emptyText(r))}</span>`}</td>
      <td>${r.lines.length ? esc([...new Set(r.lines.map(l => l.ref))].join(", ")) : "-"}</td>
    </tr>`).join("");
  const vdocs = DOCS.filter(d => productKeyOf(d) === key && d.start === start);
  $("analysisBody").innerHTML = `
    <div class="doclinks-box"><b>기초서류 원문</b> <span class="note">(판매개시일 ${esc(start || "미상")} · 누르면 PDF가 열림)</span>${docLinksHtml(vdocs, "doclinks-row")}</div>
    <h3>한눈에 보기</h3>
    ${R.overview.map(t => `<p class="line">${esc(t)}</p>`).join("")}
    <h3>핵심 특징 표</h3>
    <div class="table-scroll"><table class="facts"><thead><tr><th>항목</th><th>내용 (원문 그대로)</th><th>문서 근거</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h3>유의사항</h3>
    ${R.cautions.length ? `<ul>${R.cautions.map(l => `<li>${lineHtml(l)}</li>`).join("")}</ul>` : `<p class="na">문서에서 유의 조건 줄을 찾지 못했습니다.</p>`}
    <h3>확인 필요 항목</h3>
    ${R.checks.length ? `<ul>${R.checks.map(c => `<li class="${c.startsWith("[확인 필요]") ? "check" : c.startsWith("[확신 낮음]") ? "low" : ""}">${esc(c)}</li>`).join("")}</ul>` : `<p class="na">없음</p>`}
    <p class="note">※ 규칙 기반 자동 추출입니다. [확신 낮음]은 항목명·목차·지급기준표가 아니라 본문 단어나 문장 검색으로 판정한 항목입니다. 항목 분류가 틀릴 수 있으니 근거 페이지를 눌러 원문을 확인하세요. 담보·형별 구분은 원문 줄에 적힌 그대로 보여줍니다.</p>`;
  window.scrollTo(0, 0);
}

// 결과를 마크다운 표로 복사 (보고서·메일 붙여넣기용)
function analysisMarkdown(R) {
  const cell = s => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`# 상품 분석 — ${R.name} (판매개시일 ${R.start || "미상"})`, "", "### 한눈에 보기", ...R.overview, "",
    "### 핵심 특징 표", "| 항목 | 내용 | 문서 근거(페이지/조항) |", "|---|---|---|",
    ...R.rows.map(r => `| ${r.label} | ${r.lines.length ? cell(r.lines.map(l => l.text).join(" / ")) : emptyText(r)} | ${cell([...new Set(r.lines.map(l => l.ref))].join(", ")) || "-"} |`),
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
9. 중도인출 (계약자적립액 인출 포함 — 가능 여부, 가능 시점, 한도, 횟수, 수수료·해지환급금 영향)
10. 추가납입 (가능 여부, 한도, 가능 기간, 추가납입 시 비용 구조)
11. 기타 특이사항 (해지환급금 구조, 갱신 조건, 계약자배당, 특약 구성, 면제 조건 등)
— 아래 12~24는 사업방법서 목차 기준 항목입니다. 사업방법서에 "해당사항 없음"으로 적혀 있으면 "없음 (사업방법서 해당사항 없음)"으로 표기합니다.
12. 종목·세목 (보험종목의 명칭과 세목, 형 구분)
13. 의무가입
14. 배당
15. 보험료 (기본보험료·영업보험료·추가납입보험료 등의 정의와 구성)
16. 보험료 할인
17. 유지보너스 (보험료 납입기간별 발생일과 금액)
18. 보험료 선납 (선납 가능 기간, 할인 방법)
19. 해지계약 부활(효력회복) (청약 가능 기간 등)
20. 연체이율
21. 보험계약대출 (대출 한도, 상환·차감 방법)
22. 해약환급금 일부지급 (지급 비율, 적용 기간)
23. 간편심사형 (대상, 심사 방식)
24. 적립형 계약 (전환 조건, 보험기간·납입기간·전환나이)

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
| 종목·세목 | | |
| 의무가입 | | |
| 배당 | | |
| 보험료 | | |
| 보험료 할인 | | |
| 유지보너스 | | |
| 보험료 선납 | | |
| 해지계약 부활 | | |
| 연체이율 | | |
| 보험계약대출 | | |
| 해약환급금 일부지급 | | |
| 간편심사형 | | |
| 적립형 계약 | | |

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
