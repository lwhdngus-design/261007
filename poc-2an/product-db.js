// 가상 상품 DB 상세 — 상품 행을 누르면 주요사항 요약 · 기본정보 · 담보 · 심의 문서 · 포트폴리오(월별 보유계약)
// 요약은 DB 항목을 정해진 순서로 이어 붙이는 규칙 기반 요약입니다(AI 미사용, 외부 전송 없음).

const won = v => (v === "" || v == null ? "-" : Number(v).toLocaleString("ko-KR"));
const pct = (a, b) => (b ? ((a - b) / b * 100).toFixed(1) : "0.0");

function productSummary(p, covs, docs, port) {
  const st = saleStatus(p);
  const main = covs.filter(c => c.main_rider === "주계약").map(c => c.coverage_name);
  const riders = covs.filter(c => c.main_rider !== "주계약").length;
  const reduce = covs.filter(c => +c.reduction_months > 0).map(c => `${c.coverage_name} ${c.reduction_months}개월 ${c.reduction_pct}%`);
  const wait = covs.filter(c => +c.waiting_days > 0).map(c => `${c.coverage_name} ${c.waiting_days}일`);
  const last = port[port.length - 1], first = port[0];
  const parts = [
    `${p.category} · ${p.benefit_type} · ${p.channel} 채널, ${p.sale_start} ~ ${p.sale_end || "현재"} 판매(${st}, ${p.revision_no}차).`,
    `예정이율 ${p.assumed_rate}% ${p.rate_type}형, ${p.refund_type}${p.renewable === "Y" ? " · 갱신형" : " · 비갱신형"}.`,
    p.key_features ? `주요 특징: ${p.key_features.split(";").map(s => s.trim()).filter(Boolean).join(", ")}.` : "",
    covs.length ? `담보 ${covs.length}개 — 주계약 ${main.join(", ") || "-"}${riders ? `, 특약 ${riders}개` : ""}.` : "",
    reduce.length ? `감액: ${reduce.join(", ")}.` : "",
    wait.length ? `면책(대기)기간: ${wait.join(", ")}.` : "",
    last ? `${last.base_month} 기준 보유 ${won(last.policy_count)}건 · 연납보험료 ${last.annual_premium_100m}억 · 책임준비금 ${last.reserve_100m}억` +
      (first && first !== last ? ` (${first.base_month} 대비 건수 ${pct(+last.policy_count, +first.policy_count)}%).` : ".") : "",
    docs.length ? `관련 문서 ${docs.length}건(최근: ${docs[docs.length - 1].doc_date} ${docs[docs.length - 1].title}).` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

function renderDbDetail(code) {
  const box = $("dbDetail");
  const p = DB.products.find(x => x.product_code === code);
  if (!p) { box.hidden = true; return; }
  const covs = DB.coverages.filter(c => c.product_code === code);
  const docs = DB.documents.filter(d => d.product_code === code).sort((a, b) => a.doc_date.localeCompare(b.doc_date));
  const port = DB.portfolio.filter(r => r.product_code === code).sort((a, b) => a.base_month.localeCompare(b.base_month));
  const kv = [["상품코드", p.product_code], ["상품군", p.product_group], ["분류", p.category], ["보장/저축", p.benefit_type],
    ["판매채널", p.channel], ["판매기간", `${p.sale_start} ~ ${p.sale_end || ""}`], ["판매상태", saleStatus(p)], ["개정차수", `${p.revision_no}차`],
    ["해지환급형", p.refund_type], ["갱신", p.renewable === "Y" ? "갱신형" : "비갱신형"], ["금리", `${p.rate_type} ${p.assumed_rate}%`], ["상품위원회", p.committee_date]];
  box.hidden = false;
  box.innerHTML = `
    <div class="analysis-head"><h2>${esc(p.product_name)} <small class="muted">${esc(p.product_code)}</small></h2>
      <div class="buttons"><button type="button" id="dbDetailClose">닫기</button></div></div>
    <div class="dbsum"><b>주요사항 요약</b> <span class="muted">(DB 항목 자동 정리 · AI 미사용)</span><p>${esc(productSummary(p, covs, docs, port))}</p></div>
    <h3>기본 정보</h3>
    <table class="kv kv4"><tbody>${kv.reduce((rows, [k, v], i) => {
      if (i % 2 === 0) rows.push([]);
      rows[rows.length - 1].push(`<th>${esc(k)}</th><td>${esc(v)}</td>`);
      return rows;
    }, []).map(r => `<tr>${r.join("")}</tr>`).join("")}</tbody></table>
    <h3>담보 (${covs.length}개)</h3>
    <div class="table-scroll"><table><thead><tr><th>담보명</th><th>구분</th><th>지급사유</th><th>지급률</th><th>감액</th><th>면책(대기)</th><th>갱신주기</th><th>가입나이</th></tr></thead><tbody>
      ${covs.map(c => `<tr><td><b>${esc(c.coverage_name)}</b></td><td>${esc(c.main_rider)}</td><td>${esc(c.payment_reason)}</td>
        <td class="num">${esc(c.payment_pct)}%</td><td class="num">${+c.reduction_months ? `${esc(c.reduction_months)}개월 ${esc(c.reduction_pct)}%` : "-"}</td>
        <td class="num">${+c.waiting_days ? `${esc(c.waiting_days)}일` : "-"}</td><td class="num">${+c.renewal_years ? `${esc(c.renewal_years)}년` : "-"}</td>
        <td class="num">${esc(c.min_age)}~${esc(c.max_age)}세</td></tr>`).join("") || `<tr><td colspan="8" class="empty">담보 정보 없음</td></tr>`}
    </tbody></table></div>
    <h3>포트폴리오 (월별 보유계약)</h3>
    <div class="table-scroll"><table><thead><tr><th>기준월</th><th>보유건수</th><th>가입금액(억)</th><th>연납보험료(억)</th><th>책임준비금(억)</th></tr></thead><tbody>
      ${port.map(r => `<tr><td>${esc(r.base_month)}</td><td class="num">${won(r.policy_count)}</td><td class="num">${esc(r.sum_insured_100m)}</td>
        <td class="num">${esc(r.annual_premium_100m)}</td><td class="num">${esc(r.reserve_100m)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">포트폴리오 정보 없음</td></tr>`}
    </tbody></table></div>
    <h3>관련 문서 (${docs.length}건)</h3>
    ${docs.map(d => `<div class="pcard"><h3 style="font-size:15px">${esc(d.title)}</h3><div class="meta">${esc(d.doc_date)} · ${esc(d.doc_type)}</div><p class="line">${esc(d.content)}</p></div>`).join("") || `<p class="empty">관련 문서 없음</p>`}`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("results").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-code]");
  if (!tr) return;
  document.querySelectorAll("#results tr.sel").forEach(x => x.classList.remove("sel"));
  tr.classList.add("sel");
  renderDbDetail(tr.dataset.code);
});
document.addEventListener("click", e => {
  if (!e.target.closest("#dbDetailClose")) return;
  $("dbDetail").hidden = true;
  document.querySelectorAll("#results tr.sel").forEach(x => x.classList.remove("sel"));
});
