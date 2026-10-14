# dummy-data/*.csv -> data.js (index.html을 서버 없이 더블클릭으로 열기 위해 CSV를 JS로 묶음)
# CSV 수정 후 실행: python3 build-data.py
import json, pathlib
here = pathlib.Path(__file__).parent
names = ["products", "coverages", "portfolio", "documents", "features"]
data = {n: (here / "dummy-data" / f"{n}.csv").read_text(encoding="utf-8-sig") for n in names}
# 교육용 가상 기초서류 PDF 목록 (교육용 실습 화면의 ZIP 내려받기에 사용)
sample = here / "sample-기초서류폴더"
files = sorted(p.relative_to(here).as_posix() for p in sample.rglob("*.pdf")) if sample.is_dir() else []
(here / "data.js").write_text(
    "// 자동 생성 파일 — 직접 수정하지 말고 build-data.py를 실행하세요\nwindow.CSV_DATA = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n"
    + "window.SAMPLE_FILES = " + json.dumps(files, ensure_ascii=False, indent=1) + ";\n",
    encoding="utf-8")
print("data.js written")
