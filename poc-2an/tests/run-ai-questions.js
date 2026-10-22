// AI 질문 자동 채점 — tests/ai-questions.json 의 질문을 앱(규칙 해석)으로 실행해 기대 결과와 비교
//   python serve.py --sample --no-browser  (다른 창)
//   node tests/run-ai-questions.js [그룹]   → 통과/실패 목록, 실패 상세는 tests/ai-results.json
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const URL = process.env.URL || 'http://127.0.0.1:8765/index.html';
const KEYS = { 든든: '든든종신', 튼튼건강보험: '튼튼건강보험', 암케어: '암케어', 두단계: '두단계', 두갈래: '두갈래', 지킴이: '지킴이', 튼튼간편: '튼튼간편' };
(async () => {
  const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'ai-questions.json'), 'utf8')).filter(c => !process.argv[2] || c.g === process.argv[2]);
  const b = await chromium.launch({ args: ['--no-proxy-server'] });
  const pg = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(URL);
  await pg.waitForFunction(() => DOCS.length > 0 && document.getElementById('docsProgress').hidden && /— PDF/.test(document.getElementById('docsStatus').textContent), null, { timeout: 180000 });
  await pg.evaluate(() => { AI.ok = false; renderAiStatus(); showView('ai'); }); // 규칙 해석으로 채점
  const out = [];
  for (const c of bank) {
    const r = await pg.evaluate(async c => {
      const n = document.querySelectorAll('.ai-turn').length;
      await askAi(c.q, c.mode === 'follow' ? 'follow' : 'new');
      const turn = document.querySelectorAll('.ai-turn')[n];
      const names = [...turn.querySelectorAll('tbody tr td:first-child')].map(td => td.innerText.trim());
      return { names, answer: (turn.querySelector('.ai-answer') || {}).innerText || turn.innerText.slice(0, 200),
        cond: (turn.querySelector('.ai-cond') || {}).innerText || '', table: (turn.querySelector('table') || {}).innerText || '' };
    }, c);
    const got = Object.keys(KEYS).filter(k => r.names.some(n => n.includes(KEYS[k])));
    let ok = true, why = [];
    if (c.expect) { const exp = [...c.expect].sort(), g = [...got].sort(); if (exp.join() !== g.join()) { ok = false; why.push(`기대 ${exp.join(',') || '없음'} / 결과 ${g.join(',') || '없음'}`); } }
    if (c.count !== undefined && !new RegExp(`(^|[^\\d])${c.count}개`).test(r.answer)) { ok = false; why.push(`개수 ${c.count} 아님: ${r.answer.slice(0, 80)}`); }
    if (c.text && !(r.table + r.answer).includes(c.text)) { ok = false; why.push(`'${c.text}' 없음`); }
    out.push({ ...c, ok, why: why.join(' · '), cond: r.cond.replace(/\s+/g, ' '), got });
    console.log(`${ok ? 'O' : 'X'} [${c.g}] ${c.q}${ok ? '' : `  → ${why.join(' · ')}  | ${r.cond.replace(/\s+/g, ' ')}`}`);
  }
  const pass = out.filter(x => x.ok).length;
  console.log(`\n통과 ${pass} / ${out.length}` + (errs.length ? `  · 오류 ${errs.join(' | ')}` : ''));
  fs.writeFileSync(path.join(__dirname, 'ai-results.json'), JSON.stringify(out, null, 1));
  await b.close();
})();
