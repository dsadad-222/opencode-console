# -*- coding: utf-8 -*-
"""opencode 上游控制台 —— 管理 127.0.0.1:8893 这条转发链路。

设计原则：
  ① 纯标准库（http.server + sqlite3），不引任何第三方包 —— 谁都能起，打包也简单；
  ② 控制台只是「界面 + 历史库」，真正的配置存在 8893 那侧的 config.json，
     控制台挂了不影响链路；
  ③ 请求日志靠「8893 内存环形缓冲 → 每 5 秒拉增量 → 落 SQLite」，
     8893 自己不写盘，30 天日志长在控制台这边。

端口：8895（8787 是 codebuddy2api，8893 是转发层，8894 是视觉代理，8899 是 codex++）
"""
import csv
import io
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request as ur
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, 'static')
DB_FILE = os.path.join(ROOT, 'console.db')
LOG_DIR = os.path.join(ROOT, 'logs')
LOG_FILE = os.path.join(LOG_DIR, 'console.log')

PORT = int(os.environ.get('OPENCODE_CONSOLE_PORT', '8895'))
FWD = os.environ.get('OPENCODE_FORWARD', 'http://127.0.0.1:8893')
SERVE = os.environ.get('OPENCODE_SERVE', 'http://127.0.0.1:5099')
VER = '20261021-console-v1'

# 本地一律绕开系统代理，否则 127.0.0.1 会被 Clash 吃掉
OPENER = ur.build_opener(ur.ProxyHandler({}))

DEFAULT_SETTINGS = {
    'check_enabled': True,
    'check_interval_min': 60,
    'log_retention_days': 30,
    'test_prompt': '只回复两个字：在线',
}

_LOGF = None


def log(msg):
    global _LOGF
    line = '[%s] %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
    try:
        if _LOGF is None:
            os.makedirs(LOG_DIR, exist_ok=True)
            _LOGF = open(LOG_FILE, 'a', encoding='utf-8', buffering=1)
        _LOGF.write(line)
    except Exception:
        pass
    try:
        sys.stderr.write(line)
    except Exception:
        pass


# ── 数据库 ────────────────────────────────────────────────────
def db():
    c = sqlite3.connect(DB_FILE, timeout=15)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS events (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            epoch   TEXT NOT NULL,
            seq     INTEGER NOT NULL,
            ts      REAL,
            model   TEXT,
            stream  INTEGER,
            ok      INTEGER,
            ms      INTEGER,
            ptok    INTEGER,
            ctok    INTEGER,
            chars   INTEGER,
            err     TEXT,
            src     TEXT,
            UNIQUE(epoch, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);

        CREATE TABLE IF NOT EXISTS probes (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      REAL,
            model   TEXT,
            ok      INTEGER,
            ms      INTEGER,
            text    TEXT,
            error   TEXT,
            kind    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_probes_ts ON probes(ts);

        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        """)


def kv_get(k, default=None):
    with db() as c:
        r = c.execute('SELECT v FROM kv WHERE k=?', (k,)).fetchone()
    return r['v'] if r else default


def kv_set(k, v):
    with db() as c:
        c.execute('INSERT INTO kv(k,v) VALUES(?,?) '
                  'ON CONFLICT(k) DO UPDATE SET v=excluded.v', (k, str(v)))


def settings():
    s = dict(DEFAULT_SETTINGS)
    raw = kv_get('settings')
    if raw:
        try:
            s.update(json.loads(raw))
        except Exception:
            pass
    return s


# ── 转发层 HTTP 客户端 ────────────────────────────────────────
def fwd(method, path, body=None, timeout=25):
    url = FWD + path
    data = json.dumps(body).encode() if body is not None else None
    req = ur.Request(url, data=data,
                     headers={'Content-Type': 'application/json'},
                     method=method)
    try:
        with OPENER.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8')), None
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode('utf-8')), 'HTTP %d' % e.code
        except Exception:
            return None, 'HTTP %d' % e.code
    except Exception as e:
        return None, '%s: %s' % (type(e).__name__, e)


def probe_url(url, timeout=6):
    """能拿到任何 HTTP 响应就算通（401/403 也是通）。"""
    try:
        OPENER.open(ur.Request(url), timeout=timeout)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


# ── 后台线程：采集请求事件 ────────────────────────────────────
def collector():
    epoch = None
    last = 0
    miss = 0
    while True:
        try:
            cfg, err = fwd('GET', '/admin/config', timeout=12)
            if err or not cfg:
                miss += 1
                if miss in (3, 30) or miss % 120 == 0:
                    log('collector: 8893 不可达（连续 %d 次）%s' % (miss, err))
                time.sleep(5)
                continue
            if miss:
                log('collector: 8893 恢复')
                miss = 0

            # 用转发层给的固定启动时间当批次标识；拿不到才退回 uptime 反推。
            # 反推会有取整漂移，曾导致同一批事件被重复采集。
            ep = str(cfg.get('started_at') or
                     int(time.time() - (cfg.get('uptime') or 0)))
            if ep != epoch:
                # 8893 重启了 → seq 从头来，重置游标
                if epoch is not None:
                    log('collector: 检测到转发层重启（epoch %s -> %s）' % (epoch, ep))
                epoch = ep
                last = 0

            d, err = fwd('GET', '/admin/events?since=%d' % last, timeout=12)
            if err or not d:
                time.sleep(5)
                continue
            evs = d.get('events') or []
            if evs:
                rows = [(epoch, e.get('seq'), e.get('ts') or time.time(),
                         e.get('model'), 1 if e.get('stream') else 0,
                         1 if e.get('ok') else 0, e.get('ms'),
                         e.get('ptok'), e.get('ctok'), e.get('chars'),
                         (e.get('err') or '')[:500] or None, e.get('src'))
                        for e in evs]
                with db() as c:
                    c.executemany(
                        'INSERT OR IGNORE INTO events '
                        '(epoch,seq,ts,model,stream,ok,ms,ptok,ctok,chars,err,src) '
                        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', rows)
                last = max(e.get('seq') or 0 for e in evs)
                kv_set('last_seq', last)
                kv_set('last_epoch', epoch)
        except Exception as e:
            log('collector 异常: %r' % e)
        time.sleep(5)


# ── 后台线程：定时体检 ────────────────────────────────────────
def run_probe(model, prompt=None, kind='manual'):
    s = settings()
    prompt = prompt or s.get('test_prompt')
    t0 = time.time()
    d, err = fwd('POST', '/admin/test',
                 {'model': model, 'prompt': prompt}, timeout=300)
    ms = int((time.time() - t0) * 1000)
    if err or not d:
        rec = (time.time(), model, 0, ms, None, str(err)[:500], kind)
    else:
        rec = (time.time(), model, 1 if d.get('ok') else 0,
               d.get('ms') or ms, (d.get('text') or '')[:500],
               (d.get('error') or '')[:500] or None, kind)
    with db() as c:
        c.execute('INSERT INTO probes(ts,model,ok,ms,text,error,kind) '
                  'VALUES (?,?,?,?,?,?,?)', rec)
        # 限流 != 故障：zen 免费层报 `Rate limit exceeded` 时 8 个模型会同时
        # 超时，界面上看起来像服务挂了。单独记一笔，概览里标「限流中」。
        blob = ('%s %s' % (rec[5] or '', rec[4] or '')).lower()
        # 免费档（-free / big-pickle）超时 60 秒以上也按限流算：
        # zen 限流时 8893 拿到的往往是 `message failed: TimeoutError`，
        # 原文 `Rate limit exceeded` 在 serve 那层就被吞了。
        is_pipe = str(model).endswith('-free') or model == 'big-pickle'
        slow_pipe = is_pipe and not rec[2] and (rec[3] or 0) > 60000
        if ('rate limit' in blob or 'retryerror' in blob
                or 'too many requests' in blob or slow_pipe):
            c.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)',
                      ('rate_limited_at', str(time.time())))
            log('probe: 检测到上游限流（%s）' % model)
        elif rec[2]:
            # 一旦有模型测通了，说明限流已解除 —— 立刻清标记，
            # 否则界面会挂着「限流中」整整 30 分钟，反而误导。
            c.execute("DELETE FROM kv WHERE k='rate_limited_at'")
            c.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)',
                      ('rate_cleared_at', str(time.time())))
    return rec


def checker():
    """按 check_interval_min 静默巡检全部模型。"""
    while True:
        try:
            s = settings()
            if not s.get('check_enabled'):
                time.sleep(120)
                continue
            interval = max(5, int(s.get('check_interval_min') or 60)) * 60
            last = float(kv_get('last_auto_check', 0) or 0)
            with db() as c:
                have = c.execute('SELECT COUNT(*) n FROM probes').fetchone()['n']
            # 从没测过（新库 / 刚清空）就立刻跑一轮，别让界面全显示「未测」
            if have and time.time() - last < interval:
                time.sleep(60)
                continue
            kv_set('last_auto_check', time.time())
            cfg, err = fwd('GET', '/admin/config', timeout=15)
            if err or not cfg:
                log('checker: 拿不到模型列表，跳过本轮')
                time.sleep(60)
                continue
            models = [m['id'] for m in (cfg.get('models') or [])
                      if m.get('enabled', True)]
            log('checker: 开始巡检 %d 个在架模型' % len(models))
            bad = []
            for m in models:
                try:
                    rec = run_probe(m, kind='auto')
                    if not rec[2]:
                        bad.append((m, rec[5] or '无回复'))
                except Exception as e:
                    bad.append((m, repr(e)[:120]))
                time.sleep(2)          # 别把 serve 打满
            kv_set('last_check_bad', json.dumps(bad, ensure_ascii=False))
            kv_set('last_check_at', time.time())
            log('checker: 完成，异常 %d 个 %s' % (len(bad), bad))
        except Exception as e:
            log('checker 异常: %r' % e)
        time.sleep(60)


# ── 后台线程：日志清理 ────────────────────────────────────────
def cleaner():
    while True:
        try:
            days = max(1, int(settings().get('log_retention_days') or 30))
            cut = time.time() - days * 86400
            with db() as c:
                n1 = c.execute('DELETE FROM events WHERE ts < ?', (cut,)).rowcount
                n2 = c.execute('DELETE FROM probes WHERE ts < ?', (cut,)).rowcount
            if n1 or n2:
                log('cleaner: 清理 %d 条事件 / %d 条体检（保留 %d 天）'
                    % (n1, n2, days))
        except Exception as e:
            log('cleaner 异常: %r' % e)
        time.sleep(6 * 3600)


# ── HTTP 处理 ─────────────────────────────────────────────────
MIME = {'.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'opencode-console/' + VER

    def log_message(self, fmt, *a):
        pass                      # 别把每个静态请求都写进日志

    # ---- 基础输出 ----
    def _send(self, code, body, ctype, extra=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False),
                   'application/json; charset=utf-8')

    def _static(self, path):
        rel = path.lstrip('/')
        if rel in ('', 'index.html'):
            rel = 'index.html'
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self._send(404, 'Not Found', 'text/plain; charset=utf-8')
        ext = os.path.splitext(full)[1].lower()
        with open(full, 'rb') as f:
            data = f.read()
        self._send(200, data, MIME.get(ext, 'application/octet-stream'))

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n).decode('utf-8')) if n else {}

    def _qs(self):
        return parse_qs(urlparse(self.path).query)

    # ---- 路由 ----
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path.startswith('/api/'):
                return self.api_get(path)
            return self._static(path)
        except Exception as e:
            log('GET %s 异常: %r' % (path, e))
            return self._json(500, {'error': repr(e)})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            return self.api_post(path)
        except Exception as e:
            log('POST %s 异常: %r' % (path, e))
            return self._json(500, {'error': repr(e)})

    # ---- API: GET ----
    def api_get(self, path):
        if path == '/api/overview':
            return self._json(200, self.overview())

        if path == '/api/models':
            cfg, err = fwd('GET', '/admin/config', timeout=20)
            if err or not cfg:
                return self._json(200, {'ok': False, 'error': err, 'models': []})
            rows = self._last_probe_map()
            st = self._model_stats_24h()
            models = []
            for m in cfg.get('models') or []:
                p = rows.get(m['id']) or {}
                # v13：免费档全部支持「模拟」工具调用（提示词约定 + 输出解析），
                # 标记出来让界面能显示，避免用户以为只能纯聊天。
                models.append(dict(m, tools='emulated', probe=p,
                                   stats=st.get(m['id']) or
                                   {'n': 0, 'ok': 0, 'avg_ms': 0}))
            return self._json(200, {'ok': True, 'models': models,
                                    'blacklist': cfg.get('blacklist') or [],
                                    'config': cfg.get('config') or {},
                                    # 代理档（支持 tools）：独立于免费池，不在本页管理，
                                    # 只做展示 —— 让用户知道「哪些模型名能调工具」。
                                    'proxy_models': cfg.get('proxy_models') or [],
                                    'proxy_upstream': cfg.get('proxy_upstream') or '',
                                    # pipe 档的体量/超时参数，只读展示。
                                    # 这些是转发层启动时从环境变量读的，控制台改不了。
                                    'pipe': {k: cfg.get(k) for k in (
                                        'variant_default', 'variant_cap',
                                        'history_budget', 'ttft_sec',
                                        'stall_sec', 'stream_max_sec')},
                                    # 外部 provider（NVIDIA NIM / OpenRouter…）
                                    'ext': cfg.get('ext') or [],
                                    'ext_conf': cfg.get('ext_conf') or '',
                                    'ver': cfg.get('ver')})

        if path == '/api/logs':
            return self._json(200, self.logs())

        if path == '/api/logs/export':
            return self.export_csv()

        if path == '/api/settings':
            return self._json(200, settings())

        if path == '/api/health':
            return self._json(200, self.health())

        if path == '/api/probes':
            q = self._qs()
            model = (q.get('model') or [''])[0]
            lim = min(500, int((q.get('limit') or ['100'])[0] or 100))
            sql = 'SELECT * FROM probes'
            args = []
            if model:
                sql += ' WHERE model=?'
                args.append(model)
            sql += ' ORDER BY id DESC LIMIT ?'
            args.append(lim)
            with db() as c:
                rows = [dict(r) for r in c.execute(sql, args)]
            return self._json(200, {'probes': rows})

        if path == '/api/batch':
            return self._json(200, BATCH.snapshot())

        return self._json(404, {'error': 'not found'})

    # ---- API: POST ----
    def api_post(self, path):
        body = self._body()

        if path == '/api/config':
            d, err = fwd('POST', '/admin/config', body, timeout=40)
            if err:
                return self._json(200, {'ok': False, 'error': err})
            return self._json(200, {'ok': True, 'result': d})

        if path == '/api/test':
            model = body.get('model')
            if not model:
                return self._json(400, {'ok': False, 'error': 'missing model'})
            rec = run_probe(model, body.get('prompt'), kind='manual')
            return self._json(200, {'ok': bool(rec[2]), 'model': model,
                                    'ms': rec[3], 'text': rec[4] or '',
                                    'error': rec[5] or ''})

        if path == '/api/batch-test':
            # scope: 'all'（默认，全通道）| 'free'（只测免费档）
            return self._json(200, BATCH.start(body.get('models'),
                                               body.get('scope') or 'all'))

        if path == '/api/batch-cancel':
            BATCH.cancel()
            return self._json(200, {'ok': True})

        if path == '/api/refresh':
            d, err = fwd('POST', '/admin/refresh', {}, timeout=60)
            if err:
                return self._json(200, {'ok': False, 'error': err})
            return self._json(200, {'ok': True, 'count': (d or {}).get('count'),
                                    'models': (d or {}).get('models')})

        if path == '/api/settings':
            cur = settings()
            for k in DEFAULT_SETTINGS:
                if k in body:
                    cur[k] = body[k]
            kv_set('settings', json.dumps(cur, ensure_ascii=False))
            # 同步给 8893 的 config（保留它自己的字段）
            cfg, err = fwd('GET', '/admin/config', timeout=15)
            if not err and cfg:
                fwd('POST', '/admin/config',
                    {'check_interval_min': int(cur.get('check_interval_min') or 60),
                     'log_retention_days': int(cur.get('log_retention_days') or 30)},
                    timeout=40)
            return self._json(200, {'ok': True, 'settings': cur})

        return self._json(404, {'error': 'not found'})

    # ---- 各接口实现 ----
    def _last_probe_map(self):
        """每个模型最近一次体检结果。"""
        with db() as c:
            rows = c.execute("""
                SELECT p.* FROM probes p
                JOIN (SELECT model, MAX(id) mid FROM probes GROUP BY model) x
                  ON p.id = x.mid
            """).fetchall()
        return {r['model']: {'ts': r['ts'], 'ok': bool(r['ok']), 'ms': r['ms'],
                             'text': r['text'], 'error': r['error'],
                             'kind': r['kind']}
                for r in rows}

    def _model_stats_24h(self):
        """每个模型最近 24 小时的调用量与成功率。"""
        cut = time.time() - 86400
        with db() as c:
            rows = c.execute("""
                SELECT model, COUNT(*) n, SUM(ok) ok, AVG(ms) ms
                FROM events WHERE ts > ? GROUP BY model""", (cut,)).fetchall()
        return {r['model']: {'n': r['n'] or 0, 'ok': r['ok'] or 0,
                             'avg_ms': int(r['ms'] or 0)} for r in rows}

    def overview(self):
        cfg, ferr = fwd('GET', '/admin/config', timeout=15)
        stats, serr = fwd('GET', '/admin/stats', timeout=10)
        now = time.time()
        day_ago = now - 86400

        with db() as c:
            # 「中断」= 客户端在流结束前自己断开，不算上游失败
            g = c.execute("""SELECT COUNT(*) n,
                             SUM(ok) ok,
                             SUM(CASE WHEN ok=0 AND (err IS NULL OR err NOT LIKE '[中断]%')
                                      THEN 1 ELSE 0 END) failed,
                             SUM(CASE WHEN err LIKE '[中断]%' THEN 1 ELSE 0 END) interrupted,
                             AVG(ms) avg, MIN(ms) mn, MAX(ms) mx
                             FROM events WHERE ts > ?""", (day_ago,)).fetchone()
            tot = c.execute("""SELECT COUNT(*) n FROM events""").fetchone()
            hours = c.execute("""SELECT CAST((ts-?)/3600 AS INTEGER) h,
                                 COUNT(*) n, SUM(ok) ok FROM events
                                 WHERE ts > ? GROUP BY h ORDER BY h""",
                              (day_ago, day_ago)).fetchall()
            recent = c.execute("""SELECT ts, model, ok, ms, stream, err, src
                                  FROM events ORDER BY id DESC LIMIT 12""").fetchall()
            # 24h P95
            mss = [r['ms'] for r in c.execute(
                'SELECT ms FROM events WHERE ts > ? AND ms IS NOT NULL ORDER BY ms',
                (day_ago,)) if r['ms'] is not None]
            bad_models = c.execute("""
                SELECT model, SUM(1-ok) bad, COUNT(*) n FROM events
                WHERE ts > ? GROUP BY model HAVING bad > 0
                ORDER BY bad DESC LIMIT 8""", (day_ago,)).fetchall()
            # 每个模型的真实调用状态（24h）—— 代理档和外部 provider 没有
            # 主动探测，只能靠真实请求聚合出状态。
            agg = {}
            for r in c.execute("""SELECT model, COUNT(*) n, SUM(ok) ok,
                                         AVG(ms) avg, MAX(ts) last_ts
                                  FROM events WHERE ts > ? GROUP BY model""",
                               (day_ago,)):
                agg[r['model']] = dict(r)

        def pct(q):
            if not mss:
                return 0
            return mss[min(len(mss) - 1, int(len(mss) * q))]

        all_models = (cfg or {}).get('models') or []
        models = [m for m in all_models if m.get('enabled', True)]
        free_ids = {m['id'] for m in models}
        # 限流窗口（30 分钟）：期内免费档的失败按「限流中」解释，不算故障
        try:
            rl_at = float(kv_get('rate_limited_at', 0) or 0)
        except Exception:
            rl_at = 0
        rate_limited = bool(rl_at) and (time.time() - rl_at) < 1800
        probes = self._last_probe_map()
        healthy = sum(1 for m in models
                      if (probes.get(m['id']) or {}).get('ok'))
        unknown = sum(1 for m in models if m['id'] not in probes)

        # ── 全通道矩阵（v21）：免费档 / 代理档 / 外部 provider 合一 ──
        def _st(mid):
            """状态优先级：主动探测 → 24h 真实调用 → 未测。"""
            p = probes.get(mid) or {}
            if p.get('ok') is False and rate_limited and mid in free_ids:
                return 'limited', p.get('ms'), 'probe'
            if p.get('ok') is not None:
                return ('ok' if p['ok'] else 'bad'), p.get('ms'), 'probe'
            a = agg.get(mid)
            if a and a['n']:
                ok = a['ok'] or 0
                st = 'ok' if ok == a['n'] else ('bad' if ok == 0 else 'mixed')
                return st, int(a['avg'] or 0), 'live'
            return 'unknown', None, None

        def _fill(items):
            out = []
            for it in items:
                st, ms, src = _st(it['id'])
                it = dict(it, state=st, ms=ms, src=src)
                a = agg.get(it['id']) or {}
                it['calls'] = a.get('n') or 0
                it['ok_calls'] = a.get('ok') or 0
                out.append(it)
            return out

        proxy_ids = (cfg or {}).get('proxy_models') or []
        # proxy_visible=false 时不列代理档（8787 号池），矩阵里也不单独成组
        if not ((cfg or {}).get('config') or {}).get('proxy_visible', True):
            proxy_ids = []
        ext_conf = (cfg or {}).get('ext') or []

        free_items = _fill([{'id': m['id'],
                             'label': m.get('alias') or m['id'],
                             'prov': m.get('provider') or 'opencode',
                             'tools': 'emulated'} for m in models])
        proxy_items = _fill([{'id': m, 'label': m, 'prov': 'proxy',
                              'tools': True} for m in proxy_ids])
        ext_items = []
        for e in ext_conf:
            for mid in (e.get('list') or []):
                short = mid.split('/', 1)[1] if '/' in mid else mid
                ext_items.append({'id': mid, 'label': short,
                                  'prov': e.get('id'), 'tools': True})
        ext_items = _fill(ext_items)

        all_ready = sum(1 for g in (free_items, proxy_items, ext_items)
                        for it in g if it['state'] in ('ok', 'mixed'))
        all_total = len(free_items) + len(proxy_items) + len(ext_items)
        matrix = [
            {'key': 'free', 'label': '免费档 · serve',
             'note': '提示词模拟工具，延迟抖动大', 'models': free_items},
        ]
        if proxy_items:      # proxy_visible=false 时整个分组都不出现
            matrix.append({'key': 'proxy', 'label': '代理档 · 号池',
                           'note': '原生工具，吃号池额度',
                           'models': proxy_items})
        matrix.append({'key': 'ext', 'label': '外部 / 本机 provider',
                       'note': '原生工具，免密或自备 Key',
                       'models': ext_items})
        return {
            'ver': VER,
            'now': now,
            'chain': {
                'forward': {'ok': not ferr, 'url': FWD,
                            'ver': (cfg or {}).get('ver'),
                            'uptime': (cfg or {}).get('uptime'),
                            'error': ferr},
                'serve': {'ok': bool((cfg or {}).get('serve_ready')),
                          'url': (cfg or {}).get('serve') or SERVE},
                'upstream': {'ok': bool((cfg or {}).get('serve_ready'))},
            },
            'counts': {
                'models': len(models),
                'healthy': healthy,
                'unknown': unknown,
                'blacklist': len((cfg or {}).get('blacklist') or []),
                # 全通路口径（免费档 + 代理档 + 外部 provider）
                'all_total': all_total,
                'all_ready': all_ready,
                'free': len(free_items),
                'proxy': len(proxy_items),
                'ext': len(ext_items),
            },
            'matrix': matrix,
            'rate_limited': rate_limited,
            'rate_limited_at': rl_at,
            'db': {
                'day_total': g['n'] or 0,
                'day_ok': g['ok'] or 0,
                'day_failed': g['failed'] or 0,
                'day_interrupted': g['interrupted'] or 0,
                'day_avg_ms': int(g['avg'] or 0),
                'day_p95_ms': pct(0.95),
                'day_max_ms': g['mx'] or 0,
                'all_total': tot['n'] or 0,
            },
            'runtime': stats or {},
            'settings': settings(),
            'series': [{'hour_offset': r['h'], 'n': r['n'], 'ok': r['ok'] or 0}
                       for r in hours],
            'recent': [dict(r) for r in recent],
            'bad_models': [dict(r) for r in bad_models],
            'last_check_at': float(kv_get('last_check_at', 0) or 0),
            'last_check_bad': json.loads(kv_get('last_check_bad', '[]') or '[]'),
        }

    def logs(self):
        q = self._qs()
        lim = min(1000, int((q.get('limit') or ['200'])[0] or 200))
        model = (q.get('model') or [''])[0]
        only = (q.get('only') or [''])[0]        # failed | slow | stream
        since = float((q.get('since') or ['0'])[0] or 0)
        sql = 'SELECT * FROM events WHERE ts > ?'
        args = [since]
        if model:
            sql += ' AND model=?'
            args.append(model)
        if only == 'failed':
            sql += ' AND ok=0'
        elif only == 'slow':
            sql += ' AND ms >= 10000'
        elif only == 'stream':
            sql += ' AND stream=1'
        sql += ' ORDER BY id DESC LIMIT ?'
        args.append(lim)
        with db() as c:
            rows = [dict(r) for r in c.execute(sql, args)]
            total = c.execute('SELECT COUNT(*) n FROM events').fetchone()['n']
        return {'logs': rows, 'total': total}

    def export_csv(self):
        q = self._qs()
        days = min(90, int((q.get('days') or ['30'])[0] or 30))
        cut = time.time() - days * 86400
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(['time', 'model', 'stream', 'ok', 'ms',
                    'prompt_tokens', 'completion_tokens', 'chars', 'error', 'src'])
        with db() as c:
            for r in c.execute('SELECT * FROM events WHERE ts > ? ORDER BY ts',
                               (cut,)):
                w.writerow([time.strftime('%Y-%m-%d %H:%M:%S',
                                          time.localtime(r['ts'])),
                            r['model'], r['stream'], r['ok'], r['ms'],
                            r['ptok'], r['ctok'], r['chars'], r['err'] or '',
                            r['src']])
        data = ('\ufeff' + buf.getvalue()).encode('utf-8')
        name = 'opencode-logs-%s.csv' % time.strftime('%Y%m%d-%H%M')
        self.send_response(200)
        self.send_header('Content-Type', 'text/csv; charset=utf-8')
        self.send_header('Content-Disposition',
                         'attachment; filename="%s"' % name)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def health(self):
        """三层链路体检 —— 用户主动点「体检」时才跑。"""
        out = {'serve': {}, 'upstream': {}, 'forward': {}}
        d, err = fwd('GET', '/health', timeout=10)
        out['forward'] = {'ok': not err, 'detail': d, 'error': err}

        try:
            with OPENER.open(SERVE + '/global/health', timeout=8) as r:
                out['serve'] = {'ok': True, 'detail': json.loads(r.read().decode())}
        except Exception as e:
            out['serve'] = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

        ok = probe_url('https://opencode.ai/zen/v1/models', timeout=8)
        out['upstream'] = {'ok': ok, 'url': 'https://opencode.ai/zen/v1/models',
                           'note': '拿得到任何 HTTP 响应即算可达（401 也算）'}
        return out


# ── 批量实测 ──────────────────────────────────────────────────
class Batch:
    def __init__(self):
        self.lock = threading.Lock()
        self.running = False
        self.cancel_flag = False
        self.total = 0
        self.done = 0
        self.current = None
        self.results = []
        self.started = None
        self.finished = None

    def snapshot(self):
        with self.lock:
            return {'running': self.running, 'total': self.total,
                    'done': self.done, 'current': self.current,
                    'results': list(self.results),
                    'started': self.started, 'finished': self.finished}

    def cancel(self):
        self.cancel_flag = True

    def start(self, models=None, scope='all'):
        with self.lock:
            if self.running:
                return {'ok': False, 'error': '已有批量任务在跑'}
            cfg, err = fwd('GET', '/admin/config', timeout=20)
            if err or not cfg:
                return {'ok': False, 'error': '拿不到模型列表: %s' % err}
            if models:
                ids = list(models)
            elif scope == 'free':
                ids = [m['id'] for m in (cfg.get('models') or [])
                       if m.get('enabled', True)]
            else:
                # 全通道：免费档 + 代理档 + 外部 provider（去重保序）
                ids = [m['id'] for m in (cfg.get('models') or [])
                       if m.get('enabled', True)]
                ids += list(cfg.get('proxy_models') or [])
                for e in (cfg.get('ext') or []):
                    ids += list(e.get('list') or [])
                seen = set()
                ids = [x for x in ids if not (x in seen or seen.add(x))]
            self.running = True
            self.cancel_flag = False
            self.total = len(ids)
            self.done = 0
            self.current = None
            self.results = []
            self.started = time.time()
            self.finished = None
        threading.Thread(target=self._run, args=(ids,), daemon=True).start()
        return {'ok': True, 'total': len(ids)}

    def _fresh(self, model, minutes):
        """最近 minutes 分钟内测过就有记录 —— 直接复用，别重复打上游。"""
        if minutes <= 0:
            return None
        with db() as c:
            r = c.execute('SELECT * FROM probes WHERE model=? ORDER BY id DESC '
                          'LIMIT 1', (model,)).fetchone()
        if not r:
            return None
        if time.time() - (r['ts'] or 0) > minutes * 60:
            return None
        return {'model': model, 'ok': bool(r['ok']), 'ms': r['ms'] or 0,
                'text': (r['text'] or '')[:120], 'error': r['error'] or '',
                'cached': True}

    def _run(self, ids):
        # 免费档（serve）额度有限，全通道体检一次就会触发 zen 限流。
        # 所以最近 10 分钟内测过的直接复用结果，只打真正过期的。
        fresh_min = 10
        skipped = 0
        for m in ids:
            if self.cancel_flag:
                break
            with self.lock:
                self.current = m
            cached = self._fresh(m, fresh_min)
            if cached:
                skipped += 1
                with self.lock:
                    self.results.append(cached)
                    self.done += 1
                continue
            try:
                rec = run_probe(m, kind='batch')
                item = {'model': m, 'ok': bool(rec[2]), 'ms': rec[3],
                        'text': (rec[4] or '')[:120], 'error': rec[5] or ''}
            except Exception as e:
                item = {'model': m, 'ok': False, 'ms': 0, 'text': '',
                        'error': repr(e)[:200]}
            with self.lock:
                self.results.append(item)
                self.done += 1
            time.sleep(1.5)
        with self.lock:
            self.running = False
            self.current = None
            self.finished = time.time()
        log('batch: 完成 %d/%d（复用 %d 个未过期的）'
            % (self.done, self.total, skipped))


BATCH = Batch()


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    init_db()
    log('console 启动 %s  port=%d  forward=%s' % (VER, PORT, FWD))
    threading.Thread(target=collector, daemon=True).start()
    threading.Thread(target=checker, daemon=True).start()
    threading.Thread(target=cleaner, daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
