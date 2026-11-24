/* opencode 上游控制台 —— 前端逻辑（原生 JS，无构建） */
'use strict';

const PAGES = {
  dashboard: { k: 'UPSTREAM OVERVIEW', t: '概览',     d: 'opencode 转发链路的实时状态与调用统计。' },
  models:    { k: 'MODEL DIRECTORY',   t: '模型管理', d: '启用、拉黑、实测每个免费档模型。' },
  logs:      { k: 'REQUEST LOG',       t: '请求日志', d: '30 天调用记录，可按模型与结果筛选。' },
  routing:   { k: 'ROUTING & POLICY',  t: '路由配置', d: '出网方式、默认模型、巡检与日志策略。' },
  test:      { k: 'LIVE REQUEST',      t: '测试台',   d: '对单个模型发真实请求，验证可用性。' },
  guide:     { k: 'INTEGRATION',       t: '接入指南', d: '把这条链路接进你的客户端。' },
};

const S = {
  page: 'dashboard',
  overview: null,
  models: [],
  proxyModels: [],
  proxyUpstream: '',
  config: {},
  blacklist: [],
  settings: {},
  batchTimer: null,
  lastProbe: {},
};

/* ── 工具 ── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtMs(ms) {
  if (ms == null || ms === '' || isNaN(ms)) return '—';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
}
function fmtNum(n) {
  if (n == null || n === '') return '—';
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const p = x => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function ago(ts) {
  if (!ts) return '从未';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return Math.floor(s) + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
function pct(ok, n) {
  if (!n) return '—';
  return (ok / n * 100).toFixed(1) + '%';
}

function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind === 'bad' ? ' bad' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

async function api(path, opts) {
  const r = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, opts || {}));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ── 路由 ── */
function go(page) {
  if (!PAGES[page]) page = 'dashboard';
  S.page = page;
  $$('.nav-item').forEach(b => b.classList.toggle('selected', b.dataset.page === page));
  $$('.page-panel').forEach(p => { p.hidden = p.id !== 'page-' + page; });
  const m = PAGES[page];
  $('#page-kicker').textContent = m.k;
  $('#page-title').innerHTML = esc(m.t) + '<span class="title-dot">.</span>';
  $('#page-desc').textContent = m.d;
  $('#breadcrumb').textContent = m.t;
  location.hash = '#' + page;
  if (page === 'models') loadModels();
  if (page === 'logs') loadLogs();
  if (page === 'routing') loadRouting();
  if (page === 'test') loadProbes();
  if (page === 'dashboard') refreshDashboard();
}

/* ── 概览 ── */
async function refreshDashboard() {
  let d;
  try {
    d = await api('/api/overview');
  } catch (e) {
    $('#load-error').hidden = false;
    $('#load-error').textContent = '控制台后端不可达：' + e.message;
    return;
  }
  $('#load-error').hidden = true;
  S.overview = d;

  const c = d.counts || {}, db = d.db || {}, ch = d.chain || {};
  // 全通路口径：免费档 + 代理档 + 外部 provider
  const aReady = (c.all_ready == null) ? (c.healthy || 0) : c.all_ready;
  const aTotal = (c.all_total == null) ? (c.models || 0) : c.all_total;
  $('#dash-models').textContent = `${aReady}/${aTotal}`;
  $('#dash-models-note').textContent = (c.free == null)
    ? (c.unknown ? `${c.unknown} 个尚未实测` : '全部模型均已实测')
    : (d.rate_limited
        ? `免费档被上游限流，稍后自动恢复 · 代理 ${c.proxy} / 外部 ${c.ext} 不受影响`
        : `免费档 ${c.free} · 代理 ${c.proxy} · 外部 ${c.ext}`);
  $('#dash-req').textContent = fmtNum(db.day_total);
  $('#dash-req-note').textContent = db.all_total
    ? `累计 ${fmtNum(db.all_total)} 条` : '尚未接到请求';
  $('#dash-ok').textContent = (db.day_total - (db.day_interrupted || 0)) > 0
    ? pct(db.day_ok, db.day_total - (db.day_interrupted || 0)) : '—';
  $('#dash-ok-note').textContent = db.day_total
    ? `失败 ${fmtNum(db.day_failed)} 条` +
      (db.day_interrupted ? ` · 中断 ${fmtNum(db.day_interrupted)} 条` : '')
    : '还没有 24h 数据';
  $('#dash-p95').textContent = db.day_p95_ms ? fmtMs(db.day_p95_ms) : '—';
  $('#dash-p95-note').textContent = db.day_avg_ms
    ? `平均 ${fmtMs(db.day_avg_ms)}，最大 ${fmtMs(db.day_max_ms)}`
    : '中位数为准，均值易被长尾拉高';

  $('#dash-fwd').textContent = ch.forward?.ok
    ? (ch.forward.ver || 'ok') : '离线';
  $('#dash-serve').textContent = ch.serve?.ok ? '就绪' : '不可用';
  $('#dash-black').textContent = (c.blacklist || 0) + ' 个';
  $('#dash-avg').textContent = db.day_total ? fmtMs(db.day_avg_ms) : '—';

  const dot = $('#side-dot'), st = $('#side-state');
  if (ch.forward?.ok) {
    dot.className = 'status-dot';
    st.textContent = ch.serve?.ok ? '链路正常' : 'serve 异常';
  } else {
    dot.className = 'status-dot bad';
    st.textContent = '转发层离线';
  }

  // 链路明细
  $('#chain-list').innerHTML = [
    ['转发层 :8893', ch.forward?.ok ? 'ok' : '离线', ch.forward?.ok],
    ['serve :5099', ch.serve?.ok ? 'ok' : '不可用', ch.serve?.ok],
    ['运行时长', ch.forward?.uptime ? fmtMs(ch.forward.uptime * 1000) : '—', true],
    ['已采事件', fmtNum(db.all_total), true],
  ].map(([k, v, ok]) =>
    `<div class="chain-item"><span>${esc(k)}</span><span class="cv ${ok ? 'ok' : 'bad'}">${esc(v)}</span></div>`
  ).join('');

  $('#dash-since').textContent = ch.forward?.uptime
    ? `转发层已运行 ${(ch.forward.uptime / 3600).toFixed(1)} 小时`
    : '';

  // 巡检
  const la = d.last_check_at;
  $('#check-pill').textContent = la ? ago(la) : '未巡检';
  $('#check-pill').className = 'pill' + (la ? ' green' : '');
  const bad = d.last_check_bad || [];
  $('#check-note').textContent = la
    ? (bad.length ? `本轮发现 ${bad.length} 个异常模型` : '本轮全部通过')
    : '尚未巡检';
  $('#check-bad').innerHTML = bad.slice(0, 6).map(([m, e]) =>
    `<div class="bad-item">${esc(m)}<br>${esc(String(e).slice(0, 90))}</div>`
  ).join('');

  renderMatrix(d);
  renderSpark(d.series || []);
  renderRecent(d.recent || []);
}

function renderMatrix(d) {
  const groups = d.matrix;
  const box = $('#model-grid');
  if (!groups || !groups.length) {
    // 兼容旧接口：只渲染免费档
    const models = (S.models || []).filter(m => m.enabled !== false);
    if (!models.length) {
      box.innerHTML = '<div class="spark-empty">正在读取模型列表…</div>';
      return;
    }
    box.innerHTML = '<div class="model-grid">' + models.map(m => {
      const p = m.probe || {};
      let cls = 'unknown', tag = '未测';
      if (p.ok === true) { cls = 'ok'; tag = '正常'; }
      else if (p.ok === false) { cls = 'bad'; tag = '异常'; }
      return cardHtml(m.id, m.alias || m.id,
                      `${m.provider}${p.ms ? ' · ' + fmtMs(p.ms) : ''}`, cls, tag);
    }).join('') + '</div>';
    bindCards();
    return;
  }

  const TAG = { ok: ['ok', '正常'], bad: ['bad', '异常'],
                mixed: ['mixed', '部分失败'], limited: ['limited', '限流中'],
                unknown: ['unknown', '未测'] };
  box.innerHTML = groups.map(g => {
    if (!g.models.length) {
      return `<div class="matrix-group">
        <div class="mg-head"><b>${esc(g.label)}</b><small>0 个</small></div>
        <div class="spark-empty">${esc(g.note || '暂无模型')}</div></div>`;
    }
    return `<div class="matrix-group">
      <div class="mg-head">
        <b>${esc(g.label)}</b>
        <small>${g.models.length} 个${g.note ? ' · ' + esc(g.note) : ''}</small>
      </div>
      <div class="model-grid">${g.models.map(it => {
        const [cls, tag] = TAG[it.state] || TAG.unknown;
        const bits = [it.prov];
        if (it.ms) bits.push(fmtMs(it.ms) + (it.src === 'live' ? '' : ''));
        if (it.calls) bits.push(`${it.ok_calls}/${it.calls} 次`);
        if (it.tools === 'emulated') bits.push('tools·模拟');
        else if (it.tools) bits.push('tools');
        return cardHtml(it.id, it.label, bits.join(' · '), cls, tag);
      }).join('')}</div>
    </div>`;
  }).join('');

  bindCards();
  const total = groups.reduce((n, g) => n + g.models.length, 0);
  $('#dash-matrix-note').textContent = `${total} 个模型 · 点击任一进入测试台`;
}

function cardHtml(id, label, sub, cls, tag) {
  return `<button class="model-card ${cls}" data-model="${esc(id)}">
      <span class="mc-tag">${tag}</span>
      <b>${esc(label)}</b>
      <small>${esc(sub)}</small>
    </button>`;
}

function bindCards() {
  $$('#model-grid .model-card').forEach(el => {
    el.onclick = () => {
      $('#test-model').value = el.dataset.model;
      go('test');
    };
  });
}

function renderSpark(series) {
  const box = $('#spark');
  if (!series.length) {
    box.innerHTML = '<div class="spark-empty">最近 24 小时还没有调用记录</div>';
    return;
  }
  // 补齐 24 小时桶（0 = 最近一小时）
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const h = 23 - i;
    const f = series.find(x => x.hour_offset === h);
    return { h, n: f ? f.n : 0, ok: f ? f.ok : 0 };
  });
  const max = Math.max(1, ...buckets.map(b => b.n));
  const W = 640, H = 110, gap = 3;
  const bw = (W - gap * 23) / 24;
  const bars = buckets.map((b, i) => {
    const x = i * (bw + gap);
    const hn = (b.n / max) * (H - 18);
    const ho = (b.ok / max) * (H - 18);
    return `<g><rect x="${x.toFixed(1)}" y="${(H - 18 - hn).toFixed(1)}" width="${bw.toFixed(1)}"
      height="${Math.max(1, hn).toFixed(1)}" rx="2" fill="#dfe8dc"></rect>
      <rect x="${x.toFixed(1)}" y="${(H - 18 - ho).toFixed(1)}" width="${bw.toFixed(1)}"
      height="${Math.max(0, ho).toFixed(1)}" rx="2" fill="#4f8a63"></rect></g>`;
  }).join('');
  box.innerHTML = `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>
    <div class="spark-legend">
      <span><i style="background:#4f8a63"></i>成功</span>
      <span><i style="background:#dfe8dc"></i>总计（含失败）</span>
      <span style="margin-left:auto">峰值 ${max} 次/小时</span>
    </div>`;
}

// 事件来源 → 人话。ext:kilo 这类直接显示 provider 名。
function srcLabel(s) {
  if (!s) return '—';
  if (s.indexOf('ext:') === 0) return s.slice(4);
  const M = { chat: '免费档', 'chat-proxy': '代理档',
              messages: '免费档', 'messages-proxy': '代理档' };
  return M[s] || s;
}

function renderRecent(rows) {
  const tb = $('#dash-recent-body');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5" style="color:#9aa5a0;text-align:center;padding:26px">还没有请求记录</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(r => `<tr>
    <td class="mono">${fmtTime(r.ts)}</td>
    <td class="log-model">${esc(r.model || '—')}</td>
    <td><small class="src-tag">${esc(srcLabel(r.src))}</small></td>
    <td><span class="pill ${r.ok ? 'green' : 'red'}">${r.ok ? '成功' : '失败'}</span></td>
    <td class="align-right">${fmtMs(r.ms)}</td>
  </tr>`).join('');
}

/* ── 模型管理 ── */
async function loadModels() {
  let d;
  try {
    d = await api('/api/models');
  } catch (e) {
    toast('读取模型失败：' + e.message, 'bad');
    return;
  }
  if (!d.ok) {
    toast('转发层不可达：' + (d.error || ''), 'bad');
    return;
  }
  S.models = (d.models || []).map(m => ({ ...m }));
  S.proxyModels = d.proxy_models || [];
  S.proxyUpstream = d.proxy_upstream || '';
  S.ext = d.ext || [];
  S.extConf = d.ext_conf || '';
  S.blacklist = d.blacklist || [];
  S.config = d.config || {};
  const live = S.models.filter(m => m.enabled !== false).length;
  $('#m-total').textContent = live;
  $('#m-black').textContent = S.blacklist.length + ' 个';
  $('#m-badge').textContent = live;
  $('#m-batch-note').textContent =
    `${live} 个在架模型，约需 ${Math.max(1, Math.round(live * 0.15))} 分钟`;
  renderModelTable();
  renderBlacklist();
  renderProxyGrid(d.proxy_models || [], d.proxy_upstream || '');
  renderExtGrid(d.ext || [], d.ext_conf || '');
  renderPipeLimits(d.pipe || {});
  // 概览页的矩阵也跟着更新
  if (S.overview) renderMatrix(S.overview);
  // 测试台下拉
  const sel = $('#test-model');
  const cur = sel.value;
  const freeOpts = S.models.filter(m => m.enabled !== false).map(m =>
    `<option value="${esc(m.id)}">${esc(m.alias ? m.alias + ' · ' + m.id : m.id)}</option>`
  ).join('');
  const pxOpts = S.proxyModels.map(m =>
    `<option value="${esc(m)}">${esc(m)} · 支持工具</option>`).join('');
  // 外部 provider：147 个全塞下拉太长，优先放 Kilo（免密可用）与
  // 已配 Key 的家；没配 Key 的 NVIDIA/OpenRouter 不放，免得一点就报错。
  const extList = (S.ext || []).filter(x => x.has_key || x.no_key);
  const extGroups = extList.map(x => {
    const ids = x.list || [];
    if (!ids.length) return '';
    return `<optgroup label="${esc(x.name || x.id)}">`
      + ids.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('')
      + '</optgroup>';
  }).join('');
  sel.innerHTML = (freeOpts || pxOpts)
    ? `<optgroup label="免费档（纯文本）">${freeOpts}</optgroup>`
      + (pxOpts ? `<optgroup label="代理档（支持 tools）">${pxOpts}</optgroup>` : '')
      + extGroups
    : '<option value="">无可用模型</option>';
  if (cur) sel.value = cur;
  else {
    const dflt = S.models.find(m => m.default && m.enabled !== false);
    if (dflt) sel.value = dflt.id;
  }
}

/* ── 代理档（协议代理，支持 tools）── */
function renderProxyGrid(list, upstream) {
  const box = $('#proxy-grid');
  if (!box) return;
  const badge = $('#px-badge');
  if (badge) badge.textContent = list.length + ' 个';
  const up = $('#px-up');
  if (up) up.textContent = (upstream || '—').replace(/^https?:\/\//, '');
  if (!list.length) {
    box.innerHTML = '<div class="spark-empty">代理上游不可达，或尚未配置</div>';
    return;
  }
  box.innerHTML = list.map(m => `<button class="model-card ok" data-model="${esc(m)}">
      <span class="mc-tag">tools</span>
      <b>${esc(m)}</b>
      <small>协议代理 · 支持工具</small>
    </button>`).join('');
  $$('#proxy-grid .model-card').forEach(el => {
    el.onclick = () => {
      const sel = $('#test-model');
      if (sel && !Array.from(sel.options).some(o => o.value === el.dataset.model)) {
        const og = document.createElement('optgroup');
        og.label = '代理档（支持 tools）';
        og.innerHTML = `<option value="${esc(el.dataset.model)}">${esc(el.dataset.model)}</option>`;
        sel.appendChild(og);
      }
      if (sel) sel.value = el.dataset.model;
      go('test');
    };
  });
}

/* 外部 provider（厂商官方免费层）：一家一张卡，只展示不管理。 */
function renderExtGrid(list, confPath) {
  const box = $('#ext-grid');
  if (!box) return;
  const badge = $('#ext-badge');
  if (badge) badge.textContent = list.length + ' 家';
  const note = $('#ext-note');
  const pp = $('#ext-conf-path');
  if (pp && confPath) pp.textContent = confPath;
  if (!list.length) {
    box.innerHTML = '<div class="spark-empty">还没配置外部 provider</div>';
    if (note) note.hidden = true;
    return;
  }
  if (note) note.hidden = list.every(x => x.has_key);
  box.innerHTML = list.map(x => {
    const ready = x.ready == null ? (x.models || 0) : x.ready;
    const total = x.models || 0;
    const meta = x.has_key
      ? `${total} 个模型`
      : `${ready}/${total} 可用 · 缺 Key 不进选择器`;
    return `<div class="ext-card">
      <div class="ec-head">
        <b>${esc(x.name || x.id)}</b>
        <span class="ec-pill ${x.has_key ? 'ok' : 'warn'}">${x.has_key ? '已配 Key' : '缺 Key'}</span>
      </div>
      <code>${esc(x.id)}/…</code>
      <div class="ec-meta">${esc(meta)} · ${esc(String(x.base || '').replace(/^https?:\/\//, ''))}</div>
    </div>`;
  }).join('');
}

/* pipe 档的体量/超时参数（只读）。客户端报 Connection error 时对着看。 */
function renderPipeLimits(pipe) {
  const box = $('#pipe-limits');
  if (!box) return;
  const rows = [
    ['思考档位（默认）', pipe.variant_default, '客户端没传档位时用这个'],
    ['思考档位（上限）', pipe.variant_cap, '客户端要 high 也只会给到这儿'],
    ['历史预算', pipe.history_budget, '字符，超了丢最老的'],
    ['首字超时', pipe.ttft_sec, '秒，迟迟不出第一个字就断'],
    ['停滞超时', pipe.stall_sec, '秒，中途不再出字就断'],
    ['流式总时限', pipe.stream_max_sec, '秒，硬上限'],
  ];
  if (!pipe || !pipe.variant_default) {
    box.innerHTML = '<div class="spark-empty">转发层版本过旧，没有这些参数</div>';
    return;
  }
  box.innerHTML = rows.map(([k, v, note]) => `<div class="limit-row">
      <span class="k">${esc(k)}</span>
      <span class="v">${v == null ? '—' : esc(String(v))}<small>${esc(note)}</small></span>
    </div>`).join('');
}

function modelState(m) {
  if (!m.enabled) return { cls: 'off', text: '已拉黑', kind: 'red' };
  const p = m.probe || {};
  if (p.ok === true) return { cls: 'ok', text: '正常', kind: 'green' };
  if (p.ok === false) return { cls: 'bad', text: '异常', kind: 'red' };
  return { cls: 'unknown', text: '未测', kind: 'amber' };
}

function renderModelTable() {
  const q = ($('#m-search').value || '').toLowerCase().trim();
  const f = $('#m-filter').value;
  const rows = S.models.filter(m => {
    if (q && !(m.id + ' ' + (m.alias || '')).toLowerCase().includes(q)) return false;
    const st = modelState(m);
    if (f === 'ok' && st.cls !== 'ok') return false;
    if (f === 'bad' && st.cls !== 'bad') return false;
    if (f === 'unknown' && st.cls !== 'unknown') return false;
    if (f === 'black' && st.cls !== 'off') return false;
    return true;
  });
  const tb = $('#models-body');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="8" style="color:#9aa5a0;text-align:center;padding:30px">没有匹配的模型</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(m => {
    const st = modelState(m);
    const p = m.probe || {};
    const s24 = m.stats || {};
    return `<tr data-id="${esc(m.id)}">
      <td><b class="log-model">${esc(m.id)}</b>${m.alias ? `<div class="cell-note">${esc(m.alias)}</div>` : ''}</td>
      <td><span class="pill">${esc(m.provider)}</span></td>
      <td><span class="pill ${st.kind}">${st.text}</span>${m.default ? ' <span class="pill green">默认</span>' : ''}</td>
      <td>${p.ts ? ago(p.ts) : '—'}<div class="cell-note">${p.ms ? fmtMs(p.ms) : ''}</div></td>
      <td>${p.ms ? fmtMs(p.ms) : '—'}</td>
      <td class="mono">${s24.n != null ? fmtNum(s24.n) : '0'}</td>
      <td>${s24.n ? pct(s24.ok, s24.n) : '—'}</td>
      <td class="align-right">
        <button class="text-button act-test" data-id="${esc(m.id)}">实测</button>
        ${m.enabled
          ? `<button class="text-button act-black" data-id="${esc(m.id)}">拉黑</button>`
          : `<button class="text-button act-unblack" data-id="${esc(m.id)}">恢复</button>`}
        ${m.default || m.enabled === false ? '' : `<button class="text-button act-default" data-id="${esc(m.id)}">设默认</button>`}
      </td>
    </tr>`;
  }).join('');

  $$('#models-body .act-test').forEach(b => b.onclick = () => runOne(b.dataset.id, b));
  $$('#models-body .act-black').forEach(b => b.onclick = () => setBlacklist(b.dataset.id, true));
  $$('#models-body .act-unblack').forEach(b => b.onclick = () => setBlacklist(b.dataset.id, false));
  $$('#models-body .act-default').forEach(b => b.onclick = () => setDefault(b.dataset.id));
}

async function runOne(id, btn) {
  const old = btn.textContent;
  btn.textContent = '测试中…';
  btn.disabled = true;
  try {
    const r = await api('/api/test', {
      method: 'POST',
      body: JSON.stringify({ model: id }),
    });
    toast(r.ok ? `${id} · ${fmtMs(r.ms)} · ${(r.text || '').slice(0, 20)}`
               : `${id} 失败：${(r.error || '').slice(0, 60)}`, r.ok ? '' : 'bad');
    await loadModels();
  } catch (e) {
    toast('测试失败：' + e.message, 'bad');
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

async function setBlacklist(id, add) {
  const list = new Set(S.blacklist);
  if (add) list.add(id); else list.delete(id);
  try {
    const r = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ blacklist: Array.from(list) }),
    });
    if (!r.ok) throw new Error(r.error || '保存失败');
    toast(add ? `已拉黑 ${id}` : `已恢复 ${id}`);
    await loadModels();
  } catch (e) {
    toast('操作失败：' + e.message, 'bad');
  }
}

async function setDefault(id) {
  try {
    const r = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ default_model: id }),
    });
    if (!r.ok) throw new Error(r.error || '保存失败');
    toast(`默认模型 → ${id}`);
    await loadModels();
  } catch (e) {
    toast('操作失败：' + e.message, 'bad');
  }
}

/* ── 批量实测 ── */
async function startBatch() {
  try {
    const r = await api('/api/batch-test', { method: 'POST', body: '{}' });
    if (!r.ok) { toast(r.error || '启动失败', 'bad'); return; }
    $('#m-batch-start').hidden = true;
    $('#m-batch-stop').hidden = false;
    pollBatch();
  } catch (e) {
    toast('启动失败：' + e.message, 'bad');
  }
}

function pollBatch() {
  clearInterval(S.batchTimer);
  S.batchTimer = setInterval(async () => {
    let b;
    try { b = await api('/api/batch'); } catch (e) { return; }
    if (b.running) {
      $('#m-batch').innerHTML = `${b.done}/${b.total}`;
      $('#m-batch-note').textContent = b.current ? '正在测 ' + b.current : '准备中…';
      $('#m-batch').className = 'stat-value';
    } else {
      clearInterval(S.batchTimer);
      S.batchTimer = null;
      $('#m-batch-start').hidden = false;
      $('#m-batch-stop').hidden = true;
      const ok = (b.results || []).filter(x => x.ok).length;
      $('#m-batch').innerHTML = `完成 <span class="spark">↗</span>`;
      $('#m-batch-note').textContent = `${ok}/${(b.results || []).length} 通过`;
      await loadModels();
    }
  }, 1500);
}

function renderBlacklist() {
  const box = $('#blacklist-box');
  if (!S.blacklist.length) {
    box.innerHTML = '<span class="black-empty">黑名单为空</span>';
    return;
  }
  box.innerHTML = S.blacklist.map(m =>
    `<span class="black-tag">${esc(m)}<button data-rm="${esc(m)}" title="移出黑名单">×</button></span>`
  ).join('');
  $$('#blacklist-box button[data-rm]').forEach(b => {
    b.onclick = () => setBlacklist(b.dataset.rm, false);
  });
}

/* ── 日志 ── */
async function loadLogs() {
  const model = ($('#logs-search').value || '').trim();
  const only = $('#logs-filter').value;
  const qs = new URLSearchParams({ limit: '200' });
  if (model) qs.set('model', model);
  if (only) qs.set('only', only);
  let d;
  try {
    d = await api('/api/logs?' + qs.toString());
  } catch (e) {
    toast('读取日志失败：' + e.message, 'bad');
    return;
  }
  const rows = d.logs || [];
  $('#logs-note').textContent =
    `最近 ${rows.length} 条 · 全库 ${fmtNum(d.total)} 条 · 30 天自动清理`;
  const tb = $('#logs-body');
  $('#logs-empty').hidden = rows.length > 0;
  tb.innerHTML = rows.map(r => {
    const interrupted = (r.err || '').indexOf('[中断]') === 0;
    const kind = r.ok ? 'green' : (interrupted ? 'amber' : 'red');
    const label = r.ok ? '成功' : (interrupted ? '中断' : '失败');
    return `<tr class="${r.ok ? '' : 'row-fail'}">
    <td class="mono">${fmtTime(r.ts)}</td>
    <td class="log-model">${esc(r.model || '—')}</td>
    <td><span class="pill">${r.stream ? '流式' : '同步'}</span></td>
    <td><span class="pill ${kind}">${label}</span></td>
    <td class="align-right">${fmtMs(r.ms)}</td>
    <td class="align-right mono">${r.ptok != null ? fmtNum(r.ptok) : '—'}</td>
    <td class="align-right mono">${r.ctok != null ? fmtNum(r.ctok) : '—'}</td>
    <td class="align-right mono">${r.chars != null ? fmtNum(r.chars) : '—'}</td>
    <td>${r.err ? `<span class="log-err" title="${esc(r.err)}">${esc(r.err)}</span>` : ''}</td>
  </tr>`;
  }).join('');
}

/* ── 路由配置 ── */
async function loadRouting() {
  await loadModels();
  const cfg = S.config || {};
  $$('input[name=net]').forEach(r => {
    r.checked = (r.value === (cfg.net_mode || 'auto'));
    r.closest('label').classList.toggle('on', r.checked);
  });
  await api('/api/settings').then(s => {
    S.settings = s;
    $('#check-enabled').checked = !!s.check_enabled;
    $('#check-interval').value = s.check_interval_min || 60;
    $('#retention').value = s.log_retention_days || 30;
    $('#test-prompt').value = s.test_prompt || '只回复两个字：在线';
  }).catch(() => {});

  const sel = $('#default-model');
  sel.innerHTML = '<option value="">（自动：列表第一个）</option>' +
    S.models.map(m => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');
  sel.value = cfg.default_model || '';
  renderBlacklist();
}

async function saveRouting() {
  const net = ($('input[name=net]:checked') || {}).value || 'auto';
  const def = $('#default-model').value || null;
  try {
    const r = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ net_mode: net, default_model: def }),
    });
    if (!r.ok) throw new Error(r.error || '保存失败');
    toast('路由配置已保存');
    await loadModels();
  } catch (e) {
    toast('保存失败：' + e.message, 'bad');
  }
}

async function saveMaint() {
  try {
    const r = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        check_enabled: $('#check-enabled').checked,
        check_interval_min: Number($('#check-interval').value) || 60,
        log_retention_days: Number($('#retention').value) || 30,
        test_prompt: $('#test-prompt').value || '只回复两个字：在线',
      }),
    });
    if (!r.ok) throw new Error('保存失败');
    toast('设置已保存');
  } catch (e) {
    toast('保存失败：' + e.message, 'bad');
  }
}

/* ── 测试台 ── */
async function loadProbes() {
  if (!S.models.length) await loadModels();
  let d;
  try {
    d = await api('/api/probes?limit=40');
  } catch (e) { return; }
  const rows = d.probes || [];
  const box = $('#probe-history');
  if (!rows.length) {
    box.innerHTML = '<p class="history-empty">还没有实测记录</p>';
    return;
  }
  box.innerHTML = rows.map(r => `<div class="history-row">
    <span class="mono" style="width:92px">${fmtTime(r.ts)}</span>
    <span class="log-model" style="flex:1">${esc(r.model)}</span>
    <span class="pill ${r.ok ? 'green' : 'red'}">${r.ok ? '通过' : '失败'}</span>
    <span class="mono" style="width:64px;text-align:right">${fmtMs(r.ms)}</span>
    <span style="flex:1.6;color:#8a9490;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
      title="${esc(r.text || r.error || '')}">${esc((r.text || r.error || '').slice(0, 60))}</span>
  </div>`).join('');
}

async function submitTest(ev) {
  ev.preventDefault();
  const model = $('#test-model').value;
  const prompt = $('#test-input').value;
  if (!model) { toast('没有可用模型', 'bad'); return; }
  const pill = $('#test-status');
  pill.textContent = '请求中…';
  pill.className = 'pill amber';
  $('#test-output').textContent = '等待上游返回…';
  $('#test-meta').textContent = '';
  const t0 = Date.now();
  try {
    const r = await api('/api/test', {
      method: 'POST',
      body: JSON.stringify({ model, prompt }),
    });
    const dt = Date.now() - t0;
    if (r.ok) {
      pill.textContent = '成功';
      pill.className = 'pill green';
      $('#test-output').textContent = r.text || '(空回复)';
      $('#test-meta').textContent =
        `${model} · 上游耗时 ${fmtMs(r.ms)} · 端到端 ${fmtMs(dt)}`;
    } else {
      pill.textContent = '失败';
      pill.className = 'pill red';
      $('#test-output').textContent = r.error || '(未知错误)';
      $('#test-meta').textContent = `${model} · ${fmtMs(dt)}`;
    }
  } catch (e) {
    pill.textContent = '异常';
    pill.className = 'pill red';
    $('#test-output').textContent = String(e);
  }
  loadProbes();
}

/* ── 体检 ── */
async function runHealth() {
  const btn = $('#dash-health');
  btn.textContent = '体检中…';
  btn.disabled = true;
  try {
    const h = await api('/api/health');
    const ok = (x) => x?.ok ? '通过' : '失败';
    // provider 维度：已配 Key（或免密）算可用
    const exts = S.ext || [];
    const extOk = exts.filter(x => x.has_key).length;
    const lines = [
      `转发层 8893：${ok(h.forward)}`,
      `serve 5099：${ok(h.serve)}`,
      `上游 opencode.ai：${ok(h.upstream)}`,
    ];
    if (exts.length) {
      lines.push(`provider：${extOk}/${exts.length} 可用`);
    }
    const allOk = h.forward?.ok && h.serve?.ok
      && (!exts.length || extOk > 0);
    toast(lines.join(' · '), allOk ? '' : 'bad');
    $('#dash-fwd').textContent = h.forward?.ok ? 'ok' : '离线';
    $('#dash-serve').textContent = h.serve?.ok ? '就绪' : '不可用';
  } catch (e) {
    toast('体检失败：' + e.message, 'bad');
  } finally {
    btn.textContent = '运行全链路体检';
    btn.disabled = false;
  }
}

/* ── 复制 ── */
function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(() => toast('已复制'))
      .catch(() => fallbackCopy(t));
  } else {
    fallbackCopy(t);
  }
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('已复制'); }
  catch (e) { toast('复制失败', 'bad'); }
  document.body.removeChild(ta);
}

/* ── 事件绑定 ── */
function bind() {
  $$('.nav-item').forEach(b => b.onclick = () => go(b.dataset.page));
  $$('[data-goto]').forEach(b => b.onclick = () => go(b.dataset.goto));

  $('#btn-refresh').onclick = () => {
    if (S.page === 'dashboard') refreshDashboard();
    else if (S.page === 'models') loadModels();
    else if (S.page === 'logs') loadLogs();
    else if (S.page === 'routing') loadRouting();
    else if (S.page === 'test') loadProbes();
  };

  $('#btn-refresh-all').onclick = async () => {
    toast('正在刷新模型列表…');
    try {
      const r = await api('/api/refresh', { method: 'POST', body: '{}' });
      toast(r.ok ? `已刷新，${r.count} 个模型` : '刷新失败：' + r.error,
            r.ok ? '' : 'bad');
      await loadModels();
    } catch (e) { toast('刷新失败：' + e.message, 'bad'); }
  };

  $('#dash-health').onclick = runHealth;
  $('#dash-copy').onclick = () => copyText('http://127.0.0.1:8893/v1');
  $$('[data-copy]').forEach(b => b.onclick = () => copyText(b.dataset.copy));

  $('#m-search').oninput = renderModelTable;
  $('#m-filter').onchange = renderModelTable;
  $('#m-batch-start').onclick = startBatch;
  $('#m-batch-stop').onclick = async () => {
    await api('/api/batch-cancel', { method: 'POST', body: '{}' });
    toast('已请求停止');
  };

  $('#logs-reload').onclick = loadLogs;
  $('#logs-search').oninput = () => { clearTimeout(bind._t); bind._t = setTimeout(loadLogs, 350); };
  $('#logs-filter').onchange = loadLogs;
  $('#logs-export').onclick = () => { location.href = '/api/logs/export?days=30'; };

  $$('input[name=net]').forEach(r => {
    r.onchange = () => {
      $$('input[name=net]').forEach(x => x.closest('label').classList.toggle('on', x.checked));
    };
  });
  $('#save-routing').onclick = saveRouting;
  $('#save-maint').onclick = saveMaint;
  $('#black-add-btn').onclick = () => {
    const v = ($('#black-add').value || '').trim();
    if (!v) return;
    setBlacklist(v, true);
    $('#black-add').value = '';
  };
  $('#reload-models').onclick = () => $('#btn-refresh-all').click();

  $('#test-form').onsubmit = submitTest;

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('#toast').hidden = true;
  });
}

/* ── 启动 ── */
(async function boot() {
  bind();
  await loadModels().catch(() => {});
  go((location.hash || '#dashboard').slice(1));
  refreshDashboard();
  setInterval(() => {
    if (S.page === 'dashboard') refreshDashboard();
  }, 15000);
})();
