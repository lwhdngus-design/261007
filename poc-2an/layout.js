// 화면 배치 보조 — 교육용 가상 상품 DB 표시 설정, 특징 바로 찾기 버튼

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
  $("answerPanel").scrollIntoView({ behavior: "smooth", block: "start" });
});
