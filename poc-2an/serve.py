# 로컬 실행기 — 내 PC의 기초서류 폴더를 앱에 자동 연결하고, 검색 색인(SQLite)으로 대량 문서를 빠르게 검색
# 파이썬 기본 기능만 사용 (추가 설치 없음)
#
#   python serve.py                         → docs-folder.txt 의 폴더 사용 (없으면 처음에 한 번 물어봄)
#   python serve.py --folder "C:\...\2026"  → 폴더 변경(저장됨)
#
# - 이 PC(127.0.0.1)에서만 접속됩니다. 외부로 아무것도 보내지 않습니다.
# - PDF 글자 추출은 브라우저(pdf.js)가 하고, 결과를 .docs-cache/index.db 에 저장합니다.
#   다음 실행부터는 새로 추가·수정된 파일만 다시 읽습니다. (.docs-cache 폴더를 지우면 초기화)
# - 특징 사전(dummy-data/features.csv)이 바뀌면 저장된 글자로 특징 태그를 자동으로 다시 계산합니다.
# - AI 질문: 내 PC의 로컬 AI(Ollama, 127.0.0.1:11434)에만 연결합니다. 없으면 앱이 규칙 해석으로 답합니다.
import argparse
import csv
import hashlib
import http.server
import json
import os
import re
import socketserver
import sqlite3
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import shutil
import subprocess
import webbrowser
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
CONFIG = APP_DIR / "docs-folder.txt"
SAMPLE_DIR = "sample-기초서류폴더"  # 교육용 가상 기초서류 (가나다생명)
CACHE_DIR = APP_DIR / ".docs-cache"
DB_PATH = CACHE_DIR / "index.db"
FEATURES_CSV = APP_DIR / "dummy-data" / "features.csv"
MAX_POST = 300 * 1024 * 1024
WRITE_LOCK = threading.Lock()
# 로컬 AI(Ollama) — 이 PC 안의 주소만 사용 (프록시 설정도 무시해 외부로 나가지 않음)
OLLAMA_URL = "http://127.0.0.1:11434"
AI_RECOMMENDED = ["qwen2.5:7b", "qwen2.5:14b", "qwen2.5:3b"]
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def norm(s):
    return re.sub(r"\s+", "", s or "").lower()


# ---------- 폴더 설정 ----------
def ask_folder():
    while True:
        raw = input("기초서류 PDF 폴더 경로를 붙여넣고 Enter\n"
                    "(탐색기에서 기초서류 폴더를 열고 주소창 경로를 복사. 예: C:\\Users\\user\\Desktop\\App_261014\\doc_sample)\n> ")
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


# ---------- 색인 DB ----------
def connect():
    CACHE_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.create_function("norm", 1, norm, deterministic=True)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    with connect() as c:
        c.executescript("""
          CREATE TABLE IF NOT EXISTS docs(id INTEGER PRIMARY KEY, path TEXT UNIQUE, size INT, mtime INT,
                                          error TEXT, n_pages INT);
          CREATE TABLE IF NOT EXISTS pages(id INTEGER PRIMARY KEY, doc_id INT, page_no INT, text TEXT);
          CREATE INDEX IF NOT EXISTS pages_doc ON pages(doc_id, page_no);
          CREATE TABLE IF NOT EXISTS tags(doc_id INT, feature_id TEXT, evidence TEXT, PRIMARY KEY(doc_id, feature_id));
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        """)
        # 공백을 뺀 본문을 3글자 단위로 색인 (부분 일치 검색용, 본문은 pages 테이블에만 저장)
        c.execute("CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(compact, tokenize='trigram', detail='none', content='')")


def delete_doc(c, doc_id):
    for pid, text in c.execute("SELECT id, text FROM pages WHERE doc_id=?", (doc_id,)).fetchall():
        c.execute("INSERT INTO pages_fts(pages_fts, rowid, compact) VALUES('delete', ?, ?)", (pid, norm(text)))
    c.execute("DELETE FROM pages WHERE doc_id=?", (doc_id,))
    c.execute("DELETE FROM tags WHERE doc_id=?", (doc_id,))
    c.execute("DELETE FROM docs WHERE id=?", (doc_id,))


# ---------- 특징 태그 (질문 검색용, 색인 시 미리 계산) ----------
def load_features():
    if not FEATURES_CSV.exists():
        return [], ""
    raw = FEATURES_CSV.read_bytes()
    feats = []
    for r in csv.DictReader(raw.decode("utf-8-sig").splitlines()):
        pats = []
        for p in filter(None, (r.get("doc_patterns") or "").split(";")):
            try:
                pats.append(re.compile(p, re.I))
            except re.error as e:
                print(f"[경고] 특징 {r.get('feature_id')} 패턴 오류 '{p}': {e}")
        if pats:
            feats.append((r["feature_id"], pats))
    return feats, hashlib.sha1(raw).hexdigest()


def compact_map(text):
    idx, chars = [], []
    for i, ch in enumerate(text):
        if not ch.isspace():
            chars.append(ch.lower())
            idx.append(i)
    return "".join(chars), idx


def cut(text, idx, s_c, e_c, before=50, after=70):
    s, e = idx[s_c], idx[e_c - 1] + 1
    a, b = max(0, s - before), min(len(text), e + after)
    return {"before": text[a:s], "hit": text[s:e], "after": text[e:b], "lead": a > 0, "tail": b < len(text)}


def doc_tags(path, pages, feats):
    """문서에 모든 패턴이 있으면 그 특징으로 태그. 근거 = 패턴별 첫 페이지 문맥"""
    maps = [compact_map(t) for t in pages]
    whole = norm(path) + "".join(m[0] for m in maps)
    out = {}
    for fid, pats in feats:
        if not all(p.search(whole) for p in pats):
            continue
        ev = []
        for p in pats:
            for pi, (comp, idx) in enumerate(maps):
                m = p.search(comp)
                if m and m.end() > m.start():
                    ev.append({"page": pi + 1, **cut(pages[pi], idx, m.start(), m.end())})
                    break
        out[fid] = ev
    return out


def write_tags(c, doc_id, tags):
    c.execute("DELETE FROM tags WHERE doc_id=?", (doc_id,))
    c.executemany("INSERT INTO tags VALUES(?,?,?)",
                  [(doc_id, fid, json.dumps(ev, ensure_ascii=False)) for fid, ev in tags.items()])


def ensure_tags():
    feats, h = load_features()
    with WRITE_LOCK, connect() as c:
        row = c.execute("SELECT value FROM meta WHERE key='features_hash'").fetchone()
        if row and row[0] == h:
            return
        docs = c.execute("SELECT id, path FROM docs").fetchall()
        if docs:
            print(f"특징 사전이 바뀌어 특징 태그를 다시 계산합니다 ({len(docs)}개 문서)...")
        for doc_id, path in docs:
            pages = [t for (t,) in c.execute("SELECT text FROM pages WHERE doc_id=? ORDER BY page_no", (doc_id,))]
            write_tags(c, doc_id, doc_tags(path, pages, feats))
        c.execute("INSERT OR REPLACE INTO meta VALUES('features_hash', ?)", (h,))


def index_doc(item):
    """브라우저가 보낸 추출 결과 저장: {path, size, mtime, pages, error}"""
    feats, _ = load_features()
    pages = [p or "" for p in item.get("pages") or []]
    with WRITE_LOCK, connect() as c:
        old = c.execute("SELECT id FROM docs WHERE path=?", (item["path"],)).fetchone()
        if old:
            delete_doc(c, old[0])
        cur = c.execute("INSERT INTO docs(path, size, mtime, error, n_pages) VALUES(?,?,?,?,?)",
                        (item["path"], item["size"], item["mtime"], item.get("error") or "", len(pages)))
        doc_id = cur.lastrowid
        for i, t in enumerate(pages):
            pid = c.execute("INSERT INTO pages(doc_id, page_no, text) VALUES(?,?,?)", (doc_id, i + 1, t)).lastrowid
            c.execute("INSERT INTO pages_fts(rowid, compact) VALUES(?,?)", (pid, norm(t)))
        tags = doc_tags(item["path"], pages, feats)
        write_tags(c, doc_id, tags)
    return {"id": doc_id, "features": tags, "error": item.get("error") or "", "n_pages": len(pages)}


def import_json_cache():
    """이전 버전(.docs-cache/*.json) 캐시를 DB로 옮김 → 다시 읽지 않아도 됨"""
    files = list(CACHE_DIR.glob("*.json")) if CACHE_DIR.exists() else []
    for f in files:
        try:
            c = json.loads(f.read_text(encoding="utf-8"))
            if c.get("path"):
                index_doc(c)
            f.unlink()
        except (OSError, ValueError, KeyError):
            pass
    if files:
        print(f"이전 캐시 {len(files)}개를 색인으로 옮겼습니다.")


# ---------- 목록 ----------
def list_docs(root):
    on_disk = {}
    for dirpath, _, names in os.walk(root):
        for n in sorted(names):
            if n.lower().endswith(".pdf"):
                full = Path(dirpath) / n
                st = full.stat()
                rel = root.name + "/" + full.relative_to(root).as_posix()  # 폴더 선택 방식과 같은 경로 형태
                on_disk[rel] = (st.st_size, int(st.st_mtime))
    with connect() as c:
        rows = {p: (i, s, m, e, n) for i, p, s, m, e, n in c.execute("SELECT id, path, size, mtime, error, n_pages FROM docs")}
        tags = {}
        for doc_id, fid, ev in c.execute("SELECT doc_id, feature_id, evidence FROM tags"):
            tags.setdefault(doc_id, {})[fid] = json.loads(ev)
    # 지금 폴더 안에서 없어진 파일만 색인에서 뺌 (다른 폴더의 색인은 그대로 둠 → 폴더를 바꿔도 다시 읽지 않음)
    prefix = root.name + "/"
    gone = [r[0] for p, r in rows.items() if p.startswith(prefix) and p not in on_disk]
    if gone:
        with WRITE_LOCK, connect() as c:
            for doc_id in gone:
                delete_doc(c, doc_id)
    files = []
    for rel, (size, mtime) in on_disk.items():
        item = {"path": rel, "size": size, "mtime": mtime, "indexed": False}
        r = rows.get(rel)
        if r and r[1] == size and r[2] == mtime:
            item.update(id=r[0], indexed=True, error=r[3] or "", n_pages=r[4], features=tags.get(r[0], {}))
        files.append(item)
    return {"root": root.name, "folder": str(root), "files": files}


# ---------- 검색 ----------
# 공백 제거·소문자 본문을 SQLite 내장 함수로 계산 (파이썬 함수보다 훨씬 빠름)
# 일반 공백·줄바꿈·탭·CR, 줄바꿈 없는 공백(U+00A0), 전각 공백(U+3000)
SQL_NORM = "lower(" + "replace(" * 6 + "text" + "".join(
    f", {ch}, '')" for ch in ("' '", "char(10)", "char(13)", "char(9)", "char(160)", "char(12288)")) + ")"


def trigram_query(term):
    return " AND ".join('"' + term[i:i + 3].replace('"', '""') + '"' for i in range(len(term) - 2))


def search_ids(terms, limit_ids=None):
    """모든 단어가 들어 있는 문서 id (문서 단위 AND, 공백 무시, 파일 경로 포함)"""
    terms = sorted({norm(t) for t in terms if norm(t)}, key=len, reverse=True)  # 긴 단어부터 → 후보 축소
    pnorm = SQL_NORM
    with connect() as c:
        paths = {i: norm(p) for i, p in c.execute("SELECT id, path FROM docs")}
        ids = set(paths) if limit_ids is None else set(limit_ids) & set(paths)
        for t in terms:
            hit = {i for i in ids if t in paths[i]}
            rest = ids - hit
            if len(t) >= 3:
                # 1) 3글자 색인으로 후보 페이지(본문 없이 id만)  2) 문서마다 실제 포함 페이지를 1개만 확인하고 멈춤
                cand = {}
                for doc_id, pid in c.execute("SELECT p.doc_id, p.id FROM pages_fts f JOIN pages p ON p.id=f.rowid "
                                             "WHERE pages_fts MATCH ? ORDER BY p.doc_id, p.id", (trigram_query(t),)):
                    if doc_id in rest:
                        cand.setdefault(doc_id, []).append(pid)
                for doc_id, pids in cand.items():
                    for k in range(0, len(pids), 500):
                        chunk = pids[k:k + 500]
                        if c.execute(f"SELECT 1 FROM pages WHERE id IN ({','.join('?' * len(chunk))}) "
                                     f"AND instr({pnorm}, ?) > 0 LIMIT 1", chunk + [t]).fetchone():
                            hit.add(doc_id)
                            break
            else:
                # 1~2글자 단어는 색인을 못 써서 문서마다 페이지를 훑되, 찾으면 바로 멈춤
                for doc_id in rest:
                    if c.execute(f"SELECT 1 FROM pages WHERE doc_id=? AND instr({pnorm}, ?) > 0 LIMIT 1",
                                 (doc_id, t)).fetchone():
                        hit.add(doc_id)
            ids = hit
            if not ids:
                break
    return sorted(ids)


def snippets_for(ids, terms, per_doc=3):
    terms = [norm(t) for t in terms if norm(t)]
    out = {}
    with connect() as c:
        for doc_id in ids:
            snips = []
            for t in terms:
                if len(snips) >= per_doc:
                    break
                if len(t) >= 3:
                    rows = c.execute("SELECT p.page_no, p.text FROM pages_fts f JOIN pages p ON p.id=f.rowid "
                                     "WHERE pages_fts MATCH ? AND p.doc_id=? ORDER BY p.page_no", (trigram_query(t), doc_id))
                else:
                    rows = c.execute(f"SELECT page_no, text FROM pages WHERE doc_id=? AND instr({SQL_NORM}, ?) > 0 "
                                     "ORDER BY page_no", (doc_id, t))
                for page_no, text in rows:
                    comp, idx = compact_map(text)
                    k = comp.find(t)
                    if k != -1:
                        snips.append({"page": page_no, **cut(text, idx, k, k + len(t), 40, 40)})
                        break
            out[doc_id] = snips
    return out


# ---------- 문장 질문 검색 (question.js 의 splitSentences·scoreSentence 와 같은 규칙) ----------
SENT_SPLIT = re.compile(r"(?<=[.。!?])\s+")


def split_sentences(text):
    out = []
    for piece in SENT_SPLIT.split(text or ""):
        parts = re.split(r"\n+", piece) if len(piece) > 300 else [piece]
        for p in parts:
            for i in range(0, len(p), 300):
                t = p[i:i + 300].strip()
                if t:
                    out.append(t)
    return out


def ask(groups, need, ids, per_doc=2):
    """핵심어 묶음(같은 뜻 말 포함) 중 need개 이상이 한 문장에 있는 원문. 1) SQL로 그만큼 들어 있는 페이지만 고르고 2) 문장 단위로 채점"""
    groups = [[norm(a) for a in g if norm(a)] for g in groups]
    groups = [g for g in groups if g]
    if not groups or not ids:
        return []
    need = max(1, min(int(need), len(groups)))
    cond = " + ".join("(" + " OR ".join("instr(t, ?) > 0" for _ in g) + ")" for g in groups)
    sql = (f"WITH n AS MATERIALIZED (SELECT doc_id, page_no, text, {SQL_NORM} AS t FROM pages "
           f"WHERE doc_id IN (SELECT value FROM json_each(?))) "
           f"SELECT doc_id, page_no, text FROM n WHERE ({cond}) >= ?")
    params = [json.dumps([int(i) for i in ids])] + [a for g in groups for a in g] + [need]
    best = {}
    with connect() as c:
        for doc_id, page_no, text in c.execute(sql, params):
            for sent in split_sentences(text):
                comp = norm(sent)
                matched = [next((a for a in g if a in comp), "") for g in groups]
                hits = sum(1 for m in matched if m)
                if hits >= need:
                    best.setdefault(doc_id, []).append({"id": doc_id, "page": page_no, "text": sent, "hits": hits,
                                                        "matched": [m for m in matched if m], "len": len(comp)})
    out = []
    for lst in best.values():
        lst.sort(key=lambda h: (-h["hits"], h["len"]))
        out.extend(lst[:per_doc])
    return out


def near_words(ids, words, after=80, per_doc=8, per_page=3):
    """문서마다 단어가 나오는 곳 뒤쪽 원문(공백 제거, 페이지당 최대 3곳) — AI 질문의 값 읽기(예정이율·보험기간 등)"""
    words = [norm(w) for w in words if norm(w)]
    if not words or not ids:
        return []
    after = max(20, min(int(after), 400))
    cond = " OR ".join("instr(t, ?) > 0" for _ in words)
    sql = (f"WITH n AS MATERIALIZED (SELECT doc_id, page_no, {SQL_NORM} AS t FROM pages "
           f"WHERE doc_id IN (SELECT value FROM json_each(?))) "
           f"SELECT doc_id, page_no, t FROM n WHERE {cond} ORDER BY doc_id, page_no")
    out, count = [], {}
    with connect() as c:
        for doc_id, page_no, t in c.execute(sql, [json.dumps([int(i) for i in ids])] + words):
            found = 0
            for w in words:
                k = t.find(w)
                while k != -1 and found < per_page and count.get(doc_id, 0) < per_doc:
                    out.append({"id": doc_id, "page": page_no, "text": t[k:k + after]})
                    count[doc_id] = count.get(doc_id, 0) + 1
                    found += 1
                    k = t.find(w, k + len(w))
    return out


def pages_with(ids, words, limit=20000):
    """단어가 모두 들어 있는 페이지 원문 — AI 질문의 구조 판정(예: 사망보험금 기간별 차등)용"""
    words = [norm(w) for w in words if norm(w)]
    if not words or not ids:
        return []
    cond = " AND ".join(f"instr({SQL_NORM}, ?) > 0" for _ in words)
    sql = (f"SELECT doc_id, page_no, text FROM pages WHERE doc_id IN (SELECT value FROM json_each(?)) "
           f"AND {cond} ORDER BY doc_id, page_no LIMIT {int(limit)}")
    with connect() as c:
        return [{"id": d, "page": p, "text": t} for d, p, t in c.execute(sql, [json.dumps([int(i) for i in ids])] + words)]


# ---------- 로컬 AI (Ollama) ----------
def ollama(path, body=None, timeout=5):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL + path, data=data, headers={"Content-Type": "application/json"})
    with NO_PROXY.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def ai_status():
    try:
        models = [m["name"] for m in ollama("/api/tags").get("models", [])]
    except (OSError, ValueError, urllib.error.URLError) as e:
        return {"ok": False, "models": [], "error": f"로컬 AI 연결 안 됨 ({e.__class__.__name__})"}
    rec = next((m for r in AI_RECOMMENDED for m in models if m == r or m.startswith(r + "-")), models[0] if models else "")
    return {"ok": bool(models), "models": models, "recommended": rec}


def ai_chat(body):
    req = {"model": str(body.get("model") or ""), "messages": body.get("messages") or [], "stream": False,
           "keep_alive": "15m", "options": body.get("options") or {}}
    if body.get("format"):
        req["format"] = body["format"]
    try:
        r = ollama("/api/chat", req, timeout=600)
    except urllib.error.HTTPError as e:
        if req.get("format") and req["format"] != "json":  # 오래된 Ollama: JSON 형식 지정(스키마) 미지원 → 일반 JSON 모드
            req["format"] = "json"
            r = ollama("/api/chat", req, timeout=600)
        else:
            raise ValueError(f"로컬 AI 오류 {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
    return {"content": (r.get("message") or {}).get("content", "")}


def doc_pages(doc_id):
    with connect() as c:
        return [t for (t,) in c.execute("SELECT text FROM pages WHERE doc_id=? ORDER BY page_no", (doc_id,))]


# ---------- 웹 서버 ----------
def make_handler(root):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(APP_DIR), **kw)

        def log_message(self, *a):  # 콘솔을 조용하게
            pass

        def end_headers(self):
            # 업데이트(git pull) 후 브라우저가 예전 화면을 캐시에서 꺼내 쓰지 않도록 매번 새로 받게 함
            self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def send_json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def read_json(self):
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > MAX_POST:
                raise ValueError("요청 크기 오류")
            return json.loads(self.rfile.read(n).decode("utf-8"))

        def doc_path(self, rel):
            # "<루트폴더명>/하위/파일.pdf" → 실제 경로 (루트 밖으로 나가는 경로는 거부)
            parts = rel.split("/", 1)
            if len(parts) != 2 or parts[0] != root.name:
                return None
            p = (root / parts[1]).resolve()
            return p if p.is_file() and p.suffix.lower() == ".pdf" and root in p.parents else None

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(url.query)
            if url.path == "/api/docs":
                ensure_tags()
                return self.send_json(list_docs(root))
            if url.path == "/api/ai/status":
                return self.send_json(ai_status())
            if url.path == "/api/pages":
                return self.send_json({"pages": doc_pages(int(qs.get("id", ["0"])[0]))})
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
            path = urllib.parse.urlparse(self.path).path
            try:
                body = self.read_json()
                if path == "/api/index":
                    if not self.doc_path(body["path"]):
                        return self.send_json({"error": "폴더 밖 경로"}, 400)
                    return self.send_json(index_doc(body))
                if path == "/api/search":
                    return self.send_json({"ids": search_ids(body.get("terms", []))})
                if path == "/api/ask":
                    return self.send_json({"hits": ask(body.get("groups", []), body.get("need", 1), body.get("ids", []))})
                if path == "/api/near":
                    return self.send_json({"hits": near_words(body.get("ids", []), body.get("words", []), body.get("after", 80))})
                if path == "/api/pages_with":
                    return self.send_json({"pages": pages_with(body.get("ids", []), body.get("words", []))})
                if path == "/api/ai/chat":
                    return self.send_json(ai_chat(body))
                if path == "/api/snippets":
                    res = snippets_for([int(i) for i in body.get("ids", [])][:300], body.get("terms", []))
                    return self.send_json({"snippets": {str(k): v for k, v in res.items()}})
            except (ValueError, KeyError, TypeError, OSError, sqlite3.Error, urllib.error.URLError) as e:
                return self.send_json({"error": str(e)}, 400)
            return self.send_error(404)

    return Handler


# ---------- 브라우저 열기 (크롬 우선) ----------
def find_chrome():
    """설치된 크롬 실행 파일 경로 (없으면 None)"""
    cands = []
    if os.name == "nt":
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
            if base:
                cands.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
        try:  # 레지스트리에 등록된 설치 경로
            import winreg
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    with winreg.OpenKey(hive, r"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") as k:
                        cands.append(Path(winreg.QueryValue(k, None)))
                except OSError:
                    pass
        except ImportError:
            pass
    elif sys.platform == "darwin":
        cands.append(Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            if shutil.which(name):
                cands.append(Path(shutil.which(name)))
    return next((str(c) for c in cands if c and c.is_file()), None)


def open_browser(url, which):
    if which == "chrome":
        chrome = find_chrome()
        if chrome:
            subprocess.Popen([chrome, url])
            return "크롬"
        print("크롬을 찾지 못해 기본 브라우저로 엽니다.")
    webbrowser.open(url)
    return "기본 브라우저"


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description="기초서류 폴더 자동 연결 실행기")
    ap.add_argument("--folder", help="기초서류 PDF 폴더 경로 (한 번 지정하면 저장됨)")
    ap.add_argument("--sample", action="store_true",
                    help="교육용 가상 샘플 폴더(sample-기초서류폴더)로 실행 (저장된 폴더 설정은 바꾸지 않음)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--browser", choices=["chrome", "default"], default="chrome",
                    help="열 브라우저: chrome(기본, 없으면 기본 브라우저) / default(Windows 기본 브라우저)")
    args = ap.parse_args()

    root = (APP_DIR / SAMPLE_DIR).resolve() if args.sample else docs_root(args.folder)
    init_db()
    import_json_cache()
    ensure_tags()
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
    st = ai_status()
    print(f"로컬 AI: 연결됨 (모델 {', '.join(st['models'])})" if st["ok"] else
          "로컬 AI: 없음 → AI 질문은 규칙 해석으로 답합니다 (설치: ai-setup.bat)")
    print("이 창을 닫으면 앱이 종료됩니다. (폴더 변경: python serve.py --folder \"경로\")")
    if not args.no_browser:
        threading.Timer(0.8, lambda: print(f"{open_browser(url, args.browser)}로 열었습니다.")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
