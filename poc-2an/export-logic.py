# 핵심 로직 추출 — 현재 구현된 코드를 고치지 않고 그대로 모아 main-logic.txt 한 파일로 저장
#   python export-logic.py   → main-logic.txt
# - 제외: 화면 디자인/스타일(index.html의 CSS·HTML 마크업, layout.js 화면 배치), 기능 설명(README 등),
#         외부 라이브러리(lib/pdf.js), 데이터(data.js: 가상 CSV·샘플 PDF 목록), 검증·예시용(selfcheck.js, examples.js)
# - index.html은 화면 마크업을 빼고 <script> 안의 로직만 그대로 옮김
# - 인증정보(API 키·비밀번호 등)로 보이는 값이 있으면 실제 값을 가림 (현재 코드에는 없음)
import re
from pathlib import Path

APP = Path(__file__).resolve().parent
OUT = APP / "main-logic.txt"

# 실행 순서대로: 로컬 실행기(서버) → 데이터 빌드 → 화면 로직
FILES = [
    ("serve.py", "로컬 실행기 · 검색 색인(SQLite) · 문장 질문 검색 · 로컬 AI 연결"),
    ("build-data.py", "가상 데이터(CSV) → data.js 변환"),
    ("index.html", "기본 검색 로직 (<script> 부분만)"),
    ("pdf-docs.js", "기초서류 PDF 읽기 · 판매일자·판매상태 · 문서 검색"),
    ("question.js", "질문 해석 · 특징 질문 · 문장 질문 검색"),
    ("analysis.js", "상품 분석 (사업방법서·상품요약서·약관 → 핵심 특징 표)"),
    ("compare.js", "상품 비교 · 개정 전후 비교"),
    ("catalog.js", "상품 목록 자동 구성"),
    ("product-db.js", "가상 상품 DB 주요사항 요약"),
    ("chat.js", "AI 질문 (질문→조건→앱 계산→답변)"),
]

SECRET = re.compile(r"""((?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*)(["'])([^"']{4,})\2""", re.I)


def inline_scripts(html):
    """<script src=...>가 아닌 <script> 블록의 내용만 원문 그대로"""
    blocks = re.findall(r"<script>(.*?)</script>", html, re.S)
    return "\n".join(b.strip("\n") for b in blocks)


def main():
    parts, masked = [], 0
    for name, desc in FILES:
        text = (APP / name).read_text(encoding="utf-8")
        if name.endswith(".html"):
            text = inline_scripts(text)
        text, n = SECRET.subn(lambda m: m.group(1) + m.group(2) + "***" + m.group(2), text)
        masked += n
        parts.append(f"{'=' * 100}\n# FILE: {name}  ({desc})\n{'=' * 100}\n{text.rstrip()}\n")
    header = ("상품 검증 기준자료 통합 검색 — 핵심 로직(Main Logic) 추출본\n"
              "현재 구현된 코드를 수정·요약 없이 그대로 옮김 (화면 디자인/스타일 코드와 기능 설명은 제외)\n"
              f"포함 파일: {', '.join(n for n, _ in FILES)}\n"
              "제외: index.html의 CSS·HTML 마크업, layout.js(화면 배치), README(기능 설명), lib/(외부 라이브러리 pdf.js), "
              "data.js(가상 데이터), selfcheck.js·examples.js(검증·예시)\n"
              f"인증정보: {'가린 값 ' + str(masked) + '개' if masked else '코드에 API 키·비밀번호 등 인증정보 없음'}\n\n")
    OUT.write_text(header + "\n".join(parts), encoding="utf-8")
    print(f"{OUT.name} 저장: {OUT.stat().st_size:,} bytes · 파일 {len(FILES)}개")


if __name__ == "__main__":
    main()
