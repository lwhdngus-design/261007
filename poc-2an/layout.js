// 화면 배치 보조 — 교육용 가상 상품 DB 표시 설정, 특징 바로 찾기 메뉴, 상품 목록 판매상태 탭, 상단 바로가기

// 가상 상품 DB: 보기 설정에서 켤 때만 보임 (이 브라우저에 설정 기억)
const DB_KEY = "showVirtualDb";
function setVirtualDb(on) {
  $("dbPanel").hidden = !on;
  $("dbToggle").checked = on;
  try { localStorage.setItem(DB_KEY, on ? "1" : "0"); } catch (e) { /* 저장 못 해도 동작 */ }
}
let dbSaved = false;
try { dbSaved = localStorage.getItem(DB_KEY) === "1"; } catch (e) { /* 기본값: 꺼짐 */ }
setVirtualDb(dbSaved);
$("dbToggle").addEventListener("change", e => setVirtualDb(e.target.checked));
document.addEventListener("click", e => {
  if (!e.target.closest("#emptyDbBtn")) return;
  setVirtualDb(true);
  $("dbPanel").scrollIntoView({ behavior: "smooth", block: "start" });
});

// 특징 바로 찾기: 누르면 특징 이름으로 질문 검색
$("featureChips").innerHTML = FEATURES.map(f =>
  `<button type="button" class="fchip" data-feature="${esc(f.name)}" title="${esc(f.name)} 상품 찾기">${esc(f.name)}</button>`).join("");
$("featureChips").addEventListener("click", e => {
  const b = e.target.closest("[data-feature]");
  if (!b) return;
  $("keyword").value = b.dataset.feature;
  renderAll();
  markFeature();
  $("answerPanel").scrollIntoView({ behavior: "smooth", block: "start" });
});

// 지금 검색창이 특징 이름이면 왼쪽 메뉴에서 그 특징을 강조
function markFeature() {
  const k = $("keyword").value.trim();
  document.querySelectorAll("#featureChips .fchip").forEach(b => b.classList.toggle("on", b.dataset.feature === k));
}
$("searchForm").addEventListener("submit", markFeature);
$("resetBtn").addEventListener("click", markFeature);
$("keyword").addEventListener("input", markFeature);

// 상품 목록 판매상태 탭 → 숨은 판매상태 선택칸(catStatus)과 연동
$("catTabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-st]");
  if (!b) return;
  $("catStatus").value = b.dataset.st;
  $("catStatus").dispatchEvent(new Event("change"));
});
$("catStatus").addEventListener("change", () => {
  document.querySelectorAll("#catTabs button").forEach(b => b.classList.toggle("on", b.dataset.st === $("catStatus").value));
});

// 상단 바로가기: 분석·비교 화면이 열려 있을 때만 활성
const navLinks = [...document.querySelectorAll(".gnb a[data-needs]")];
const syncNav = () => navLinks.forEach(a => a.classList.toggle("off", $(a.dataset.needs).hidden));
navLinks.forEach(a => new MutationObserver(syncNav).observe($(a.dataset.needs), { attributes: true, attributeFilter: ["hidden"] }));
syncNav();
