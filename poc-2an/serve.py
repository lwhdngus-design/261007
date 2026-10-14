# 로컬 실행기 — 내 PC의 기초서류 폴더를 앱에 자동 연결 (파이썬 기본 기능만 사용, 추가 설치 없음)
#
#   python serve.py                         → docs-folder.txt 의 폴더 사용 (없으면 처음에 한 번 물어봄)
#   python serve.py --folder "C:\...\2026"  → 폴더 변경(저장됨)
#
# - 이 PC(127.0.0.1)에서만 접속됩니다. 외부로 아무것도 보내지 않습니다.
# - PDF에서 읽은 글자는 .docs-cache 폴더에 저장해, 다음 실행부터는 바뀐 파일만 다시 읽습니다.
#   (.docs-cache 폴더를 지우면 캐시가 초기화됩니다. GitHub에는 올라가지 않습니다)
import argparse
import hashlib
import http.server
import json
import os
import socketserver
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
CONFIG = APP_DIR / "docs-folder.txt"
CACHE_DIR = APP_DIR / ".docs-cache"
MAX_POST = 200 * 1024 * 1024  # 캐시 1건 최대 200MB


def ask_folder():
    while True:
        raw = input("기초서류 PDF 폴더 경로를 붙여넣고 Enter (예: C:\\Users\\user\\Desktop\\App_261014\\doc_sample_2026\\2026)\n> ")
        p = Path(raw.strip().strip('"'))
        if p.is_dir():
            return p
        print(f"폴더를 찾을 수 없습니다: {p}\n")


def docs_root(cli_folder):
    if cli_folder:
        p = Path(cli_folder.strip('"'))
        if not p.is_dir():
            sys.exit(f"폴더를 찾을 수 없습니다: {p}")
    elif CONFIG.exists() and Path(CONFIG.read_text(encoding="utf-8").strip()).is_dir():
        p = Path(CONFIG.read_text(encoding="utf-8").strip())
    else:
        p = ask_folder()
    CONFIG.write_text(str(p.resolve()), encoding="utf-8")
    return p.resolve()


def cache_file(rel):
    return CACHE_DIR / (hashlib.sha1(rel.encode("utf-8")).hexdigest() + ".json")


def list_docs(root):
    files = []
    for dirpath, _, names in os.walk(root):
        for n in sorted(names):
            if not n.lower().endswith(".pdf"):
                continue
            full = Path(dirpath) / n
            st = full.stat()
            rel = root.name + "/" + full.relative_to(root).as_posix()  # 폴더 선택 방식과 같은 경로 형태
            item = {"path": rel, "size": st.st_size, "mtime": int(st.st_mtime)}
            cf = cache_file(rel)
            if cf.exists():
                try:
                    c = json.loads(cf.read_text(encoding="utf-8"))
                    if c.get("size") == item["size"] and c.get("mtime") == item["mtime"]:
                        item["pages"] = c.get("pages", [])
                        item["error"] = c.get("error", "")
                except (OSError, ValueError):
                    pass
            files.append(item)
    return {"root": root.name, "folder": str(root), "files": files}


def make_handler(root):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(APP_DIR), **kw)

        def log_message(self, *a):  # 콘솔을 조용하게
            pass

        def send_json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def doc_path(self, rel):
            # "<루트폴더명>/하위/파일.pdf" → 실제 경로 (루트 밖으로 나가는 경로는 거부)
            parts = rel.split("/", 1)
            if len(parts) != 2 or parts[0] != root.name:
                return None
            p = (root / parts[1]).resolve()
            return p if p.is_file() and p.suffix.lower() == ".pdf" and root in p.parents else None

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            if url.path == "/api/docs":
                return self.send_json(list_docs(root))
            if url.path.startswith("/docs/"):
                p = self.doc_path(urllib.parse.unquote(url.path[len("/docs/"):]))
                if not p:
                    return self.send_error(404)
                data = p.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if url.path.startswith("/.docs-cache") or url.path.endswith("docs-folder.txt"):
                return self.send_error(404)
            return super().do_GET()

        def do_POST(self):
            if urllib.parse.urlparse(self.path).path != "/api/cache":
                return self.send_error(404)
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > MAX_POST:
                return self.send_error(413)
            try:
                c = json.loads(self.rfile.read(n).decode("utf-8"))
                if not self.doc_path(c["path"]):
                    return self.send_error(400)
                CACHE_DIR.mkdir(exist_ok=True)
                tmp = cache_file(c["path"]).with_suffix(".tmp")
                tmp.write_text(json.dumps({k: c.get(k) for k in ("path", "size", "mtime", "pages", "error")},
                                          ensure_ascii=False), encoding="utf-8")
                tmp.replace(cache_file(c["path"]))
            except (ValueError, KeyError, OSError) as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)
            return self.send_json({"ok": True})

    return Handler


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description="기초서류 폴더 자동 연결 실행기")
    ap.add_argument("--folder", help="기초서류 PDF 폴더 경로 (한 번 지정하면 저장됨)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    root = docs_root(args.folder)
    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = Server(("127.0.0.1", port), make_handler(root))
            break
        except OSError:
            continue
    if not server:
        sys.exit("사용할 수 있는 포트를 찾지 못했습니다.")
    url = f"http://127.0.0.1:{server.server_address[1]}/index.html"
    print(f"기초서류 폴더: {root}")
    print(f"앱 주소: {url}")
    print("이 창을 닫으면 앱이 종료됩니다. (폴더 변경: python serve.py --folder \"경로\")")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
