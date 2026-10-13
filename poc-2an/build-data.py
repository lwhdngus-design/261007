# dummy-data/*.csv -> data.js (index.html을 서버 없이 더블클릭으로 열기 위해 CSV를 JS로 묶음)
# CSV 수정 후 실행: python3 build-data.py
import json, pathlib
here = pathlib.Path(__file__).parent
names = ["products", "coverages", "portfolio", "documents"]
data = {n: (here / "dummy-data" / f"{n}.csv").read_text(encoding="utf-8-sig") for n in names}
(here / "data.js").write_text(
    "// 자동 생성 파일 — 직접 수정하지 말고 build-data.py를 실행하세요\nwindow.CSV_DATA = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n",
    encoding="utf-8")
print("data.js written")
