'use strict';

/* =============================== 小工具 =============================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ico = (id) => '<svg><use href="#' + id + '"></use></svg>';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(ms) {
  const d = new Date(ms || Date.now());
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function fmtTokens(n) {
  if (!n && n !== 0) return '';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

function dayGroup(ms) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= start) return '今天';
  if (ms >= start - 86400000) return '昨天';
  if (ms >= start - 7 * 86400000) return '过去 7 天';
  if (ms >= start - 30 * 86400000) return '过去 30 天';
  return '更早';
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

const SANDBOX_LABEL = {
  'read-only': '只读',
  'workspace-write': '工作目录可写',
  'danger-full-access': '完全访问',
};
const EFFORT_LABEL = { low: '快速', high: '深入', max: '最深入', minimal: '极简', medium: '中等' };

/* =============================== 与宿主通信 =============================== */
function createBridge() {
  const wv = window.chrome && window.chrome.webview;
  if (wv) {
    const handlers = [];
    wv.addEventListener('message', (e) => {
      let data = e.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_e) { return; }
      }
      handlers.forEach((h) => h(data));
    });
    return {
      mode: 'host',
      send: (obj) => wv.postMessage(obj),
      onMessage: (h) => handlers.push(h),
    };
  }
  return createDemoBridge();
}

const bridge = createBridge();

/* =============================== 状态 =============================== */
const state = {
  config: {
    workDir: '', model: '', reasoningEffort: '', sandbox: 'workspace-write',
    theme: 'dark', fontSize: 15, showReasoning: true, autoCollapseTools: true,
    sendOnEnter: true, recentDirs: [], sidebarWidth: 272, dataDir: '',
  },
  codex: { found: true, path: '', version: '', admin: false },
  // 服务商（API 链接 / 模型 / 密钥）状态，由宿主在启动和保存后推送
  provider: { configured: true, baseUrl: '', model: '', hasApiKey: false, providerId: 'deepseek', configPath: '' },
  models: [],
  defaultModel: null,
  defaultEffort: null,
  sessions: [],
  session: null,
  live: {},            // sessionId -> 正在流式输出的内容（可同时有多个对话在跑）
  runningIds: new Set(),
  attachments: [],
  openCards: new Set(),
  scrollPinned: true,
  copyBuffer: new Map(),
  imageCache: new Map(),
  search: '',
  maximized: false,
};

/* =============================== 主题 / 字号 =============================== */
function effectiveTheme() {
  const t = state.config.theme || 'dark';
  if (t === 'system') {
    const boot = window.__CODEX_BOOT__ || {};
    return boot.dark === false ? 'light' : 'dark';
  }
  return t;
}

function applyConfig() {
  document.documentElement.setAttribute('data-theme', effectiveTheme());
  document.documentElement.style.setProperty('--font-size', (state.config.fontSize || 15) + 'px');
  document.documentElement.style.setProperty('--sidebar-w', (state.config.sidebarWidth || 272) + 'px');
  $('#theme-label').textContent = state.config.theme === 'light' ? '浅色'
    : state.config.theme === 'system' ? '跟随系统' : '深色';
}

/* =============================== 启动 =============================== */
function init() {
  const boot = window.__CODEX_BOOT__ || {};
  if (boot.config) Object.assign(state.config, boot.config);
  if (boot.models) state.models = boot.models;
  state.defaultModel = boot.defaultModel || null;
  state.defaultEffort = boot.defaultEffort || null;
  if (boot.provider) state.provider = Object.assign(state.provider, boot.provider);

  applyConfig();
  wireUi();
  bridge.onMessage(onHostMessage);
  bridge.send({ t: 'init' });
  autoSizeInput();
  try { $('#input').focus(); } catch (_e) { /* ignore */ }

  // 首次使用（还没配过 API 链接）：直接把设置面板打开，省得用户找不到入口
  if (boot.provider && !state.provider.configured) {
    setTimeout(() => {
      openSettings();
      toast('info', '首次使用：先填写下面的 API 链接和密钥，保存后就能开始对话。');
    }, 400);
  }

  // 浏览器里预览用：?theme=light&view=empty|settings
  const qs = new URLSearchParams(location.search);
  if (qs.get('theme') === 'light') {
    state.config.theme = 'light';
    applyConfig();
    setTimeout(() => { state.config.theme = 'light'; applyConfig(); }, 600);
  }
  const view = qs.get('view');
  if (view) {
    setTimeout(() => {
      if (view === 'empty') {
        state.session = null;
        renderChat(true);
        renderSidebar();
      } else if (view === 'settings') {
        openSettings();
      }
    }, 400);
  }
}

/* =============================== 宿主消息 =============================== */
function onHostMessage(msg) {
  if (!msg || !msg.t) return;
  switch (msg.t) {
    case 'state':
      if (msg.config) Object.assign(state.config, msg.config);
      state.sessions = msg.sessions || [];
      state.runningIds = new Set(msg.runningSessions || []);
      state.models = msg.models || state.models;
      state.defaultModel = msg.defaultModel || state.defaultModel;
      state.defaultEffort = msg.defaultEffort || state.defaultEffort;
      state.codex = msg.codex || state.codex;
      applyConfig();
      renderSidebar();
      renderChat(true);
      updateChips();
      updateFooter();
      if (!state.codex.found) {
        toast('warn', '没有找到 codex 命令，请到「设置」里指定 codex.exe 的路径。');
      } else if (!state.codex.workDirExists) {
        toast('warn', '工作目录不存在：' + state.config.workDir);
      }
      maybeRequestSnapshot(currentSessionId());
      break;
    case 'session':
      state.session = msg.session || null;
      updateComposer();
      renderSidebar();
      renderChat(true);
      maybeRequestSnapshot(currentSessionId());
      break;
    case 'sessions':
      state.sessions = msg.sessions || [];
      renderSidebar();
      break;
    case 'turns':
      state.runningIds = new Set(msg.sessions || []);
      renderSidebar();
      updateComposer();
      break;
    case 'config':
      if (msg.config) Object.assign(state.config, msg.config);
      applyConfig();
      updateChips();
      updateFooter();
      if (settingsOpen()) renderSettings();
      break;
    case 'provider':
      state.provider = Object.assign(state.provider, msg);
      if (settingsOpen()) renderSettings();
      break;
    case 'codex':
      state.codex = msg.codex || state.codex;
      state.models = msg.models || state.models;
      state.defaultModel = msg.defaultModel || state.defaultModel;
      state.defaultEffort = msg.defaultEffort || state.defaultEffort;
      updateChips();
      updateFooter();
      if (settingsOpen()) renderSettings();
      toast(state.codex.found ? 'info' : 'error',
        state.codex.found ? '已检测到 codex：' + (state.codex.version || state.codex.path) : '没有找到 codex');
      break;
    case 'turn.user':
      onUserMessage(msg);
      break;
    case 'turn.event':
      onTurnEvent(msg);
      break;
    case 'turn.log':
      onTurnLog(msg);
      break;
    case 'turn.status':
      onTurnStatus(msg);
      break;
    case 'turn.snapshot':
      onTurnSnapshot(msg);
      break;
    case 'toast':
      toast(msg.level, msg.text);
      break;
    case 'image.data':
      if (msg.path) state.imageCache.set(msg.path, msg.data);
      renderChat();
      break;
    case 'window':
      state.maximized = !!msg.maximized;
      $('#win-max').innerHTML = ico(state.maximized ? 'i-restore' : 'i-max');
      if (state.maximized) document.body.style.cursor = '';
      break;
  }
}

/* 每个会话各有一份“正在输出”的现场：state.live[sessionId]。
   多个对话同时在跑时，只有当前显示的那个会重绘，其余留在内存里等切换回来。 */
function currentSessionId() {
  return state.session ? state.session.id : null;
}

function ensureLive(sessionId) {
  if (!sessionId) return null;
  if (!state.live[sessionId]) state.live[sessionId] = { items: new Map(), order: [], logs: [] };
  return state.live[sessionId];
}

function currentLive() {
  const id = currentSessionId();
  return id ? (state.live[id] || null) : null;
}

function isRunning(sessionId) {
  return !!sessionId && state.runningIds.has(sessionId);
}

function currentRunning() {
  return isRunning(currentSessionId());
}

// 页面刷新或切回某个正在跑的对话时，向宿主补一次当前产出
function maybeRequestSnapshot(sessionId) {
  if (sessionId && state.runningIds.has(sessionId) && !state.live[sessionId]) {
    bridge.send({ t: 'turn.snapshot', sessionId: sessionId });
  }
}

function onUserMessage(msg) {
  const sid = msg.sessionId;
  ensureLive(sid);
  state.runningIds.add(sid);

  const message = msg.message || { role: 'user', ts: Date.now(), text: '' };
  if (state.session && state.session.id === sid) {
    if (msg.title) state.session.title = msg.title;
    state.session.messages = state.session.messages || [];
    // 宿主可能刚把整份会话发过来（里面已经含这条消息），也可能同一轮发了两次
    // turn.user：按时间戳去重，避免同一条消息在页面上出现两遍。
    const dup = state.session.messages.some((m) => m && m.role === 'user' && m.ts === message.ts);
    if (!dup) state.session.messages.push(message);
    renderChat(true);
  } else if (!state.session) {
    state.session = {
      id: sid,
      title: msg.title || '',
      workDir: state.config.workDir,
      messages: [message],
    };
    renderChat(true);
  }

  rememberSessionEntry(sid, msg.title, message.text);
  updateComposer();
  renderSidebar();
}

/* 左侧列表要立刻出现/更新这条对话，不然得等这一轮跑完（宿主回传 sessions）才看得到。 */
function rememberSessionEntry(id, title, text) {
  if (!id) return;
  const now = Date.now();
  const entry = state.sessions.find((s) => s && s.id === id);
  if (!entry) {
    state.sessions.unshift({
      id: id,
      title: title || '',
      preview: String(text || '').slice(0, 90),
      workDir: state.config.workDir,
      messageCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  if (title) entry.title = title;
  if (!entry.preview && text) entry.preview = String(text).slice(0, 90);
  entry.updatedAt = now;
}

function onTurnEvent(msg) {
  const ev = msg.event;
  if (!ev || !ev.type) return;
  const live = ensureLive(msg.sessionId);
  if (!live) return;

  if (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') {
    const item = ev.item;
    if (item && item.id) {
      if (!live.items.has(item.id)) live.order.push(item.id);
      live.items.set(item.id, item);
    }
  } else if (ev.type === 'turn.completed') {
    live.usage = ev.usage;
  }

  if (currentSessionId() === msg.sessionId) updateLive();
}

function onTurnLog(msg) {
  const live = ensureLive(msg.sessionId);
  if (!live) return;
  live.logs.push(msg.text);
  if (live.logs.length > 40) live.logs.shift();
  if (currentSessionId() === msg.sessionId) updateLive();
}

function onTurnSnapshot(msg) {
  const sid = msg.sessionId;
  if (!sid) return;
  const live = ensureLive(sid);
  live.items = new Map();
  live.order = [];
  (msg.items || []).forEach((item) => {
    if (!item || !item.id) return;
    live.order.push(item.id);
    live.items.set(item.id, item);
  });
  live.usage = msg.usage || null;
  live.logs = msg.logs || [];
  if (msg.workDir && state.session && state.session.id === sid) {
    state.session.workDir = msg.workDir;
    updateChips();
  }
  if (currentSessionId() === sid) renderChat(true);
}

function onTurnStatus(msg) {
  const sid = msg.sessionId;
  const live = ensureLive(sid);
  const isCurrent = !!state.session && state.session.id === sid;

  if (msg.status === 'running') {
    state.runningIds.add(sid);
    renderSidebar();
    if (isCurrent) {
      updateComposer();
      renderChat(true);
    }
    return;
  }

  state.runningIds.delete(sid);
  const items = live ? live.order.map((id) => live.items.get(id)) : [];
  if (isCurrent && state.session && (items.length || msg.error)) {
    state.session.messages = state.session.messages || [];
    state.session.messages.push({
      role: 'assistant',
      ts: Date.now(),
      items: items,
      usage: msg.usage || (live && live.usage) || null,
      error: msg.error || null,
      durationMs: msg.durationMs || null,
    });
  }
  delete state.live[sid];

  updateComposer();
  renderSidebar();
  if (isCurrent) renderChat(true);
  if (msg.status === 'error' && msg.error) toast('error', msg.error);
  if (msg.status === 'stopped' && isCurrent) toast('info', '已停止。');
}

/* =============================== 侧栏 =============================== */
function sessionTitle(s) {
  if (s.title && s.title.trim()) return s.title.trim();
  if (s.preview && s.preview.trim()) return s.preview.trim().slice(0, 32);
  return '新对话';
}

function renderSidebar() {
  const list = $('#session-list');
  const filter = state.search.trim().toLowerCase();
  const sessions = state.sessions.filter((s) => {
    if (!filter) return true;
    return (sessionTitle(s) + ' ' + (s.preview || '')).toLowerCase().includes(filter);
  });

  if (!sessions.length) {
    list.innerHTML = '<div class="group-title">' + (filter ? '没有匹配的对话' : '还没有对话记录') + '</div>';
    return;
  }

  const groups = new Map();
  sessions.forEach((s) => {
    const key = dayGroup(s.updatedAt || s.createdAt || Date.now());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });

  const html = [];
  groups.forEach((items, key) => {
    html.push('<div class="group-title">' + esc(key) + '</div>');
    items.forEach((s) => {
      const active = state.session && state.session.id === s.id;
      const running = state.runningIds.has(s.id);
      html.push(
        '<div class="session' + (active ? ' active' : '') + (running ? ' running' : '') +
        '" data-session="' + esc(s.id) + '" title="' +
        esc(s.preview || sessionTitle(s)) + '">' +
        '<span class="s-title">' + esc(sessionTitle(s)) + '</span>' +
        (running ? '<span class="s-run" title="正在运行"></span>' : '') +
        '<button class="s-more" data-session-menu="' + esc(s.id) + '">' + ico('i-dots') + '</button>' +
        '</div>');
    });
  });
  list.innerHTML = html.join('');
}

/* =============================== 聊天区 =============================== */
function renderChat(resetScroll) {
  const chat = $('#chat');
  const messages = (state.session && state.session.messages) || [];
  const live = currentLive();
  if (!messages.length && !live) {
    chat.innerHTML = emptyStateHtml();
    return;
  }

  const parts = messages.map((m, i) => messageHtml(m, i));
  if (live) parts.push(liveMessageHtml());
  chat.innerHTML = parts.join('');

  messages.forEach((m) => {
    (m.images || []).forEach((p) => {
      if (!state.imageCache.has(p)) bridge.send({ t: 'image.read', path: p, id: p });
    });
  });

  if (resetScroll !== false) scrollToBottom();
}

function emptyStateHtml() {
  return '' +
    '<div class="empty-state">' +
    '<div class="logo">' + ico('i-spark') + '</div>' +
    '<div>' +
    '<h1>今天想让它做点什么？</h1>' +
    '<p>当前工作目录：' + esc(currentWorkDir() || '') + '</p>' +
    '</div>' +
    '<div class="quick-grid">' +
    quickHtml('i-folder', '介绍一下这个项目的结构') +
    quickHtml('i-terminal', '跑一下构建，看看有没有报错') +
    quickHtml('i-file', '给这个项目补一个 CMakeLists.txt') +
    quickHtml('i-bulb', '找出代码里可能出 bug 的地方') +
    '</div>' +
    '</div>';
}

function quickHtml(icon, text) {
  return '<button class="quick" data-quick="' + esc(text) + '">' + ico(icon) + '<span>' + esc(text) + '</span></button>';
}

function messageHtml(m, idx) {
  if (m.role === 'user') {
    const images = (m.images || []).map((p) => {
      const data = state.imageCache.get(p);
      return data ? '<img src="' + data + '" alt="">' : '<div class="mini-chip">' + esc(basename(p)) + '</div>';
    }).join('');
    return '<div class="msg user" data-idx="' + idx + '">' +
      '<div class="body">' +
      '<div class="bubble-user">' + (images ? '<div class="attach-row">' + images + '</div>' : '') +
      (m.text ? '<div class="md">' + MD.render(m.text) + '</div>' : '') + '</div>' +
      '<div class="msg-tools">' +
      '<button class="tool-btn" data-copy-msg="' + idx + '">' + ico('i-copy') + '复制</button>' +
      '<button class="tool-btn" data-resend="' + idx + '">' + ico('i-send') + '重新发送</button>' +
      '</div></div></div>';
  }

  return '<div class="msg assistant" data-idx="' + idx + '">' +
    '<div class="avatar">' + ico('i-spark') + '</div>' +
    '<div class="body">' + turnInnerHtml(m.items || [], m.error, false) + metaHtml(m) + '</div></div>';
}

function liveMessageHtml() {
  return '<div class="msg assistant" id="live-msg"><div class="avatar">' + ico('i-spark') + '</div>' +
    '<div class="body" id="live-body">' + liveInnerHtml() + '</div></div>';
}

function liveInnerHtml() {
  const live = currentLive();
  const items = live ? live.order.map((id) => live.items.get(id)) : [];
  const logs = live ? live.logs : [];
  if (!items.length) {
    const box = logs.length ? '<div class="log-box">' + esc(logs.slice(-4).join('\n')) + '</div>' : '';
    return '<div class="status-line"><span class="dot-pulse"><i></i><i></i><i></i></span>正在思考…</div>' + box;
  }
  return turnInnerHtml(items, null, true, logs);
}

function updateLive() {
  const body = $('#live-body');
  if (!body) { renderChat(false); return; }
  body.innerHTML = liveInnerHtml();
  if (state.scrollPinned) scrollToBottom();
}

function turnInnerHtml(items, error, streaming, logs) {
  const out = items.map((item, i) => itemHtml(item, (streaming ? 'live-' : 'h-') + (item.id || i)));
  if (error) out.push('<div class="error-box"><b>出错了：</b>' + esc(error) + '</div>');
  if (streaming) {
    out.push('<div class="status-line"><span class="dot-pulse"><i></i><i></i><i></i></span>正在工作…</div>');
    if (logs && logs.length) out.push('<div class="log-box">' + esc(logs.slice(-4).join('\n')) + '</div>');
  }
  return out.join('');
}

function metaHtml(m) {
  const bits = [];
  if (m.usage) {
    const cached = m.usage.cached_input_tokens;
    let t = '↑ ' + fmtTokens(m.usage.input_tokens) + ' ↓ ' + fmtTokens(m.usage.output_tokens);
    if (cached) t += '（缓存 ' + fmtTokens(cached) + '）';
    bits.push(t);
  }
  if (m.durationMs) bits.push((m.durationMs / 1000).toFixed(1) + 's');
  const copyBtn = '<button class="tool-btn" data-copy-turn="' + esc(String(m.ts)) + '">' + ico('i-copy') + '复制</button>';
  return '<div class="msg-meta"><span>' + esc(bits.join(' · ')) + '</span>' + copyBtn + '</div>';
}

/* ------------------------------ 单个条目 ------------------------------ */

function itemHtml(item, key) {
  if (!item || !item.type) return '';
  switch (item.type) {
    case 'agent_message':
      return '<div class="md">' + MD.render(item.text || '') + '</div>';
    case 'reasoning': {
      const text = item.text || item.summary || '';
      if (!text) return '';
      const open = state.openCards.has(key) ? ' open' : '';
      return '<details class="reason"' + open + ' data-reason="' + esc(key) + '">' +
        '<summary>' + ico('i-chevron') + '思考过程</summary>' +
        '<div class="reason-body">' + esc(text) + '</div></details>';
    }
    case 'command_execution':
      return commandCard(item, key);
    case 'file_change':
    case 'patch':
    case 'file_changes':
      return fileChangeCard(item, key);
    case 'todo_list':
    case 'todos':
      return todoCard(item, key);
    case 'error':
      return '<div class="error-box"><b>出错了：</b>' + esc(item.message || item.text || '') + '</div>';
    case 'web_search':
    case 'web_search_call':
      return genericCard(item, key, 'i-search', '联网搜索', item.query || '');
    case 'mcp_tool_call':
    case 'tool_call':
    case 'function_call':
      return genericCard(item, key, 'i-terminal', item.name || item.tool || '工具调用',
        item.arguments ? JSON.stringify(item.arguments).slice(0, 200) : '');
    default:
      return genericCard(item, key, 'i-chevron', item.type, '');
  }
}

function statusBadge(item) {
  const status = item.status || '';
  if (status === 'in_progress' || status === 'running') return '<span class="badge run">运行中</span>';
  if (typeof item.exit_code === 'number') {
    return item.exit_code === 0
      ? '<span class="badge ok">退出码 0</span>'
      : '<span class="badge err">退出码 ' + item.exit_code + '</span>';
  }
  if (status === 'completed') return '<span class="badge ok">完成</span>';
  if (status === 'failed') return '<span class="badge err">失败</span>';
  return '';
}

function commandCard(item, key) {
  const cmd = item.command || '';
  const out = item.aggregated_output || '';
  const running = item.status === 'in_progress' || item.status === 'running';
  state.copyBuffer.set(key, out);
  const lines = out ? out.split('\n').length : 0;
  const open = state.openCards.has(key) || running ||
    (!state.config.autoCollapseTools && lines > 0) || (lines > 0 && lines <= 12);
  return '<div class="card' + (open ? ' open' : '') + '" data-card="' + esc(key) + '">' +
    '<div class="card-head" data-toggle>' + ico('i-terminal') +
    '<span class="card-title">命令</span>' +
    '<span class="card-sub">$ ' + esc(cmd) + '</span>' +
    statusBadge(item) + '<span class="c-chev">' + ico('i-chevron') + '</span></div>' +
    '<div class="card-body">' +
    (out ? '<pre>' + esc(out) + '</pre>' : '<div class="empty">' + (running ? '执行中…' : '（没有输出）') + '</div>') +
    '<div class="card-foot"><span>' + (lines ? lines + ' 行输出' : '无输出') + '</span><span class="spacer"></span>' +
    '<button class="tool-btn" data-copy-key="' + esc(key) + '">' + ico('i-copy') + '复制输出</button></div>' +
    '</div>' +
    '</div>';
}

function fileChangeCard(item, key) {
  const changes = item.changes || item.files || [];
  const rows = [];
  const list = Array.isArray(changes) ? changes : Object.keys(changes).map((k) => ({ path: k, kind: changes[k] }));
  list.forEach((c) => {
    const rawKind = c.kind && typeof c.kind === 'object' ? c.kind.type : c.kind;
    const kind = String(rawKind || 'update');
    const label = kind.startsWith('add') ? '新增' : kind.startsWith('del') ? '删除' : '修改';
    const cls = kind.startsWith('add') ? 'add' : kind.startsWith('del') ? 'del' : '';
    rows.push('<div class="file-row"><span class="f-kind ' + cls + '">' + label + '</span>' +
      '<span class="f-path" title="' + esc(c.path || '') + '">' + esc(c.path || '') + '</span></div>');
  });
  const diff = item.diff || item.patch || '';
  return '<div class="card" data-card="' + esc(key) + '">' +
    '<div class="card-head" data-toggle>' + ico('i-file') +
    '<span class="card-title">修改文件</span>' +
    '<span class="card-sub">' + (rows.length ? rows.length + ' 个文件' : esc(item.path || '')) + '</span>' +
    '<span class="c-chev">' + ico('i-chevron') + '</span></div>' +
    '<div class="card-body">' + (rows.join('') || '<div class="empty">没有文件明细</div>') +
    (diff ? '<pre>' + MD.highlight(diff, 'diff') + '</pre>' : '') + '</div></div>';
}

function todoCard(item, key) {
  const todos = item.items || item.todos || item.plan || [];
  const rows = (Array.isArray(todos) ? todos : []).map((t) => {
    const text = t.text || t.title || t.content || t.finding || JSON.stringify(t);
    const status = String(t.status || t.state || '');
    const done = status === 'completed' || status === 'done';
    const active = status === 'in_progress' || status === 'running';
    return '<div class="todo-row' + (done ? ' done' : active ? ' active' : '') + '">' +
      '<span class="t-dot"></span><span class="t-text">' + esc(text) + '</span></div>';
  });
  return '<div class="card open" data-card="' + esc(key) + '">' +
    '<div class="card-head" data-toggle>' + ico('i-bulb') +
    '<span class="card-title">任务清单</span>' +
    '<span class="card-sub">' + rows.length + ' 项</span>' +
    '<span class="c-chev">' + ico('i-chevron') + '</span></div>' +
    '<div class="card-body">' + (rows.join('') || '<div class="empty">空</div>') + '</div></div>';
}

function genericCard(item, key, icon, title, sub) {
  const json = JSON.stringify(item, null, 2);
  const open = state.openCards.has(key);
  return '<div class="card' + (open ? ' open' : '') + '" data-card="' + esc(key) + '">' +
    '<div class="card-head" data-toggle>' + ico(icon) +
    '<span class="card-title">' + esc(title) + '</span>' +
    '<span class="card-sub">' + esc(sub || '') + '</span>' +
    '<span class="c-chev">' + ico('i-chevron') + '</span></div>' +
    '<div class="card-body"><pre>' + esc(json) + '</pre></div></div>';
}

/* =============================== 滚动 =============================== */
function scrollToBottom() {
  const el = $('#chat-scroll');
  el.scrollTop = el.scrollHeight;
  state.scrollPinned = true;
  $('#scroll-bottom').classList.add('hidden');
}

/* =============================== 顶部信息 =============================== */
function currentModelLabel() {
  const slug = state.config.model || state.defaultModel;
  if (!slug) return '默认模型';
  const m = state.models.find((x) => x.slug === slug);
  return (m && m.displayName) || slug;
}

function currentWorkDir() {
  return (state.session && state.session.workDir) ? state.session.workDir : (state.config.workDir || '');
}

function updateChips() {
  const workDir = currentWorkDir();
  $('#workdir-label').textContent = workDir;
  $('#workdir-label').title = workDir;
  const effort = state.config.reasoningEffort;
  const suffix = effort ? ' · ' + (EFFORT_LABEL[effort] || effort) : '';
  $('#model-label').textContent = currentModelLabel() + suffix;
  $('#perm-label').textContent = SANDBOX_LABEL[state.config.sandbox] || state.config.sandbox;
}

function updateFooter() {
  $('#foot-left').textContent = state.codex.version || (state.codex.path ? basename(state.codex.path) : '');
  if (state.codex.admin) {
    $('#foot-left').textContent += ($('#foot-left').textContent ? ' · ' : '') + '管理员';
  }
  $('#foot-right').textContent = state.codex.found ? '' : '未找到 codex';
}

function updateComposer() {
  const btn = $('#send');
  if (currentRunning()) {
    btn.classList.add('stop');
    btn.innerHTML = ico('i-stop');
    btn.title = '停止';
  } else {
    btn.classList.remove('stop');
    btn.innerHTML = ico('i-send');
    btn.title = '发送';
  }
  const others = Array.from(state.runningIds).filter((id) => id !== currentSessionId()).length;
  $('#status-text').textContent = currentRunning()
    ? '正在处理…'
    : (others ? others + ' 个其他对话正在运行' : '');
  updateChips();
}

/* =============================== 输入区 =============================== */
function autoSizeInput() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}

function renderAttachments() {
  const box = $('#attachments');
  if (!state.attachments.length) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = state.attachments.map((a, i) =>
    '<div class="attachment"><img src="' + a.data + '" alt=""><button data-remove-attach="' + i + '">' +
    ico('i-close') + '</button></div>').join('');
}

function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (currentRunning() || (!text && !state.attachments.length)) return;
  bridge.send({
    t: 'send',
    sessionId: state.session ? state.session.id : null,
    text: text,
    images: state.attachments.map((a) => ({ name: a.name, data: a.data })),
  });
  input.value = '';
  state.attachments = [];
  renderAttachments();
  autoSizeInput();
  input.focus();
}

function addFiles(files) {
  Array.from(files || []).forEach((f) => {
    if (f.type && f.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        state.attachments.push({ name: f.name || 'image.png', data: String(reader.result) });
        renderAttachments();
      };
      reader.readAsDataURL(f);
    } else {
      const input = $('#input');
      input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + f.name;
      autoSizeInput();
    }
  });
}

/* =============================== 菜单 =============================== */
function closeMenu() {
  const menu = $('#menu');
  menu.classList.add('hidden');
  menu.innerHTML = '';
}

function openMenu(anchor, html, width) {
  const menu = $('#menu');
  menu.style.width = (width || 260) + 'px';
  menu.innerHTML = html;
  menu.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + menuRect.width > window.innerWidth - 10) left = window.innerWidth - menuRect.width - 10;
  if (top + menuRect.height > window.innerHeight - 10) top = Math.max(10, rect.top - menuRect.height - 6);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
  return menu;
}

function menuItems(items) {
  return items.map((it) => {
    if (it.sep) return '<div class="menu-sep"></div>';
    if (it.title) return '<div class="menu-title">' + esc(it.title) + '</div>';
    return '<button class="menu-item' + (it.danger ? ' danger' : '') + '" data-value="' +
      esc(it.value == null ? '' : it.value) + '">' +
      '<span class="m-main"><span>' + esc(it.label) + '</span>' +
      (it.sub ? '<div class="m-sub">' + esc(it.sub) + '</div>' : '') + '</span>' +
      (it.checked ? '<span class="m-check">' + ico('i-check') + '</span>' : '') +
      '</button>';
  }).join('');
}

function showWorkdirMenu(anchor) {
  const workDir = currentWorkDir();
  const dirs = (state.config.recentDirs || []).filter((d) => d !== workDir);
  const items = [
    { label: '选择文件夹…', value: '__pick' },
    { label: '在资源管理器中打开', value: '__open' },
  ];
  if (dirs.length) {
    items.push({ sep: true }, { title: '最近使用' });
    dirs.forEach((d) => items.push({ label: d, value: d }));
  }
  const menu = openMenu(anchor, menuItems(items), 340);
  menu.onclick = (e) => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    const value = btn.getAttribute('data-value');
    closeMenu();
    if (value === '__pick') bridge.send({ t: 'dialog.workdir', start: workDir });
    else if (value === '__open') bridge.send({ t: 'shell.open', path: workDir });
    else patchConfig({ workDir: value });
  };
}

function showModelMenu(anchor) {
  const items = [{ label: '跟随 config.toml 默认值', value: '', checked: !state.config.model }];
  state.models.forEach((m) => {
    items.push({
      label: m.displayName || m.slug, value: m.slug, sub: m.description || '',
      checked: state.config.model === m.slug,
    });
  });
  const model = state.models.find((m) => m.slug === (state.config.model || state.defaultModel));
  const levels = (model && model.levels && model.levels.length) ? model.levels.map((l) => l.effort)
    : ['low', 'high', 'max'];
  items.push({ sep: true }, { title: '推理强度' });
  items.push({ label: '跟随默认', value: '__effort:', checked: !state.config.reasoningEffort });
  levels.forEach((lv) => items.push({
    label: EFFORT_LABEL[lv] || lv, value: '__effort:' + lv, sub: lv,
    checked: state.config.reasoningEffort === lv,
  }));

  const menu = openMenu(anchor, menuItems(items), 330);
  menu.onclick = (e) => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    const value = btn.getAttribute('data-value');
    closeMenu();
    if (value.startsWith('__effort:')) patchConfig({ reasoningEffort: value.slice(9) });
    else patchConfig({ model: value });
  };
}

function showPermMenu(anchor) {
  const items = [
    { label: '只读', value: 'read-only', sub: '只能读取文件，不会改动任何东西', checked: state.config.sandbox === 'read-only' },
    { label: '工作目录可写（推荐）', value: 'workspace-write', sub: '可以在工作目录里改文件、跑命令', checked: state.config.sandbox === 'workspace-write' },
    { label: '完全访问', value: 'danger-full-access', sub: '不加限制，能改动系统任何位置，请谨慎', checked: state.config.sandbox === 'danger-full-access' },
  ];
  const menu = openMenu(anchor, menuItems(items), 340);
  menu.onclick = (e) => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    closeMenu();
    const value = btn.getAttribute('data-value');
    if (value === 'danger-full-access') {
      confirmDialog('“完全访问”会跳过沙箱限制，Codex 可以执行任意命令、改动任意文件。确定要切换吗？', () => {
        patchConfig({ sandbox: value });
      });
    } else {
      patchConfig({ sandbox: value });
    }
  };
}

function showSessionMenu(anchor, id) {
  const items = [
    { label: '重命名', value: 'rename' },
    { label: '删除对话', value: 'delete', danger: true },
  ];
  const menu = openMenu(anchor, menuItems(items), 200);
  menu.onclick = (e) => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    const value = btn.getAttribute('data-value');
    closeMenu();
    const session = state.sessions.find((s) => s.id === id);
    if (value === 'rename') {
      promptDialog('重命名对话', session ? sessionTitle(session) : '', (text) => {
        bridge.send({ t: 'session.rename', id: id, title: text });
      });
    } else if (value === 'delete') {
      confirmDialog('删除这个对话？聊天记录会同时删掉，无法恢复。', () => {
        bridge.send({ t: 'session.delete', id: id });
      });
    }
  };
}

function patchConfig(patch) {
  Object.assign(state.config, patch);
  applyConfig();
  updateChips();
  bridge.send({ t: 'config.patch', patch: patch });
}

/* =============================== 对话框 =============================== */
function confirmDialog(text, onOk) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = '<div class="modal" style="width:min(440px,100%)">' +
    '<div class="modal-head"><h2>确认</h2></div>' +
    '<div class="modal-body"><p style="margin:6px 0 8px">' + esc(text) + '</p></div>' +
    '<div class="modal-foot"><span class="modal-note"></span>' +
    '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>确定</button></div></div>';
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('[data-no]').onclick = close;
  mask.querySelector('[data-yes]').onclick = () => { close(); onOk(); };
  mask.onclick = (e) => { if (e.target === mask) close(); };
}

function promptDialog(title, initial, onOk) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = '<div class="modal" style="width:min(460px,100%)">' +
    '<div class="modal-head"><h2>' + esc(title) + '</h2></div>' +
    '<div class="modal-body"><input class="text-input" id="prompt-input" value="' + esc(initial) + '"></div>' +
    '<div class="modal-foot"><span class="modal-note"></span>' +
    '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>确定</button></div></div>';
  document.body.appendChild(mask);
  const input = mask.querySelector('#prompt-input');
  input.focus();
  input.select();
  const close = () => mask.remove();
  const ok = () => { const v = input.value.trim(); close(); onOk(v); };
  mask.querySelector('[data-no]').onclick = close;
  mask.querySelector('[data-yes]').onclick = ok;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
  mask.onclick = (e) => { if (e.target === mask) close(); };
}

function toast(level, text) {
  if (!text) return;
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (level === 'error' ? ' err' : level === 'warn' ? ' warn' : '');
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, level === 'error' ? 7000 : 3600);
}

/* =============================== 设置面板 =============================== */
const settingsOpen = () => !$('#settings-mask').classList.contains('hidden');

function openSettings() {
  renderSettings();
  $('#settings-mask').classList.remove('hidden');
}

function closeSettings() {
  $('#settings-mask').classList.add('hidden');
}

function renderSettings() {
  const c = state.config;
  const modelOptions = ['<option value="">跟随 config.toml 默认值（' +
    esc(state.defaultModel || '未设置') + '）</option>'].concat(
    state.models.map((m) => '<option value="' + esc(m.slug) + '"' + (c.model === m.slug ? ' selected' : '') + '>' +
      esc(m.displayName || m.slug) + '</option>'));

  const recent = (c.recentDirs || []).map((d) =>
    '<button class="mini-chip" data-recent="' + esc(d) + '" title="' + esc(d) + '">' + esc(d) + '</button>').join('');

  $('#settings-body').innerHTML = '' +
    '<div class="section">' +
    '<h3>API 配置</h3>' +
    '<p class="desc">填好链接、模型和密钥就能直接用。内容写入 ' +
    esc(state.provider.configPath || 'codex-home\\config.toml') + '，只保存在本机，不会上传。</p>' +
    '<div class="row"><label class="lbl">API 链接</label><input class="text-input grow" id="set-provider-url" ' +
    'placeholder="https://api.deepseek.com/" value="' + esc(state.provider.baseUrl || 'https://api.deepseek.com/') + '"></div>' +
    '<div class="row"><label class="lbl">模型</label><input class="text-input grow" id="set-provider-model" ' +
    'placeholder="deepseek-flash" value="' + esc(state.provider.model || '') + '"></div>' +
    '<div class="row"><label class="lbl">API Key</label><input class="text-input grow" id="set-provider-key" type="password" ' +
    'placeholder="' + (state.provider.hasApiKey ? '已保存，留空表示不修改' : 'sk-...') + '"></div>' +
    '<div class="row"><button class="btn" id="set-provider-save">保存并启用</button>' +
    '<span class="kv">' + (state.provider.configured
      ? '当前：' + esc(state.provider.baseUrl || '') + (state.provider.hasApiKey ? '' : '（缺密钥）')
      : '尚未配置') + '</span></div>' +
    '</div>' +

    '<div class="section">' +
    '<h3>工作目录</h3>' +
    '<p class="desc">Codex 在这里读取和修改文件。改一次就会记住，下次启动不再询问。</p>' +
    '<div class="row"><input class="text-input grow" id="set-workdir" value="' + esc(c.workDir) + '">' +
    '<button class="btn" id="set-workdir-pick">浏览…</button>' +
    '<button class="btn" id="set-workdir-open">打开</button></div>' +
    (recent ? '<div class="chips-row">' + recent + '</div>' : '') +
    '</div>' +

    '<div class="section">' +
    '<h3>模型</h3>' +
    '<p class="desc">模型清单来自 ~/.codex/models.json，选“跟随默认”就用 config.toml 里的设置。</p>' +
    '<div class="row"><label class="lbl">模型</label><select class="text-input" id="set-model">' +
    modelOptions.join('') + '</select></div>' +
    '<div class="row"><label class="lbl">推理强度</label><select class="text-input" id="set-effort">' +
    effortOptions(c.reasoningEffort) + '</select></div>' +
    '</div>' +

    '<div class="section">' +
    '<h3>权限</h3>' +
    '<p class="desc">决定 Codex 能改动什么。平时用“工作目录可写”就够了。</p>' +
    '<div class="choices">' +
    choiceHtml('read-only', '只读', '只能读取文件，适合只想问问、不想被改动', c.sandbox) +
    choiceHtml('workspace-write', '工作目录可写（推荐）', '可以在工作目录里编译、改文件、跑测试', c.sandbox) +
    choiceHtml('danger-full-access', '完全访问', '不加沙箱限制，可改动系统任意位置', c.sandbox) +
    '</div></div>' +

    '<div class="section">' +
    '<h3>外观与习惯</h3>' +
    '<div class="row"><label class="lbl">主题</label><select class="text-input" id="set-theme">' +
    themeOptions(c.theme) + '</select></div>' +
    toggleHtml('font-big', '大字号', '把聊天字号调大一点', (c.fontSize || 15) >= 16) +
    toggleHtml('show-reasoning', '显示思考过程', '展示模型的推理内容（如果模型提供）', c.showReasoning) +
    toggleHtml('auto-collapse', '自动折叠命令输出', '长输出默认折叠，点一下展开', c.autoCollapseTools) +
    toggleHtml('send-enter', 'Enter 发送', '关闭后需要 Ctrl+Enter 才发送', c.sendOnEnter) +
    '</div>' +

    '<div class="section">' +
    '<h3>Codex 命令</h3>' +
    '<p class="desc">留空则自动在 PATH 里查找 codex；也可以指定 codex.exe 的完整路径。运行权限：' +
    (state.codex.admin ? '管理员（已提权）' : '普通用户（未提权）') + '。</p>' +
    '<div class="row"><input class="text-input grow" id="set-codexpath" placeholder="自动检测" value="' +
    esc(c.codexPath || '') + '"></div>' +
    '<div class="row"><button class="btn small" id="set-codex-detect">重新检测</button>' +
    '<span class="kv">' + esc(state.codex.version || '') + '<br>' + esc(state.codex.path || '未找到') + '</span></div>' +
    '</div>' +

    '<div class="section">' +
    '<h3>数据</h3>' +
    '<p class="desc">对话记录和设置都保存在本机：' + esc(c.dataDir || '') + '</p>' +
    '<div class="row"><button class="btn small" id="set-open-data">打开数据目录</button>' +
    '<button class="btn small danger" id="set-clear-session">清空当前对话记录</button></div>' +
    '</div>';

  $('#set-workdir').onchange = (e) => patchConfig({ workDir: e.target.value.trim() });
  $('#set-workdir-pick').onclick = () => bridge.send({ t: 'dialog.workdir', start: c.workDir });
  $('#set-workdir-open').onclick = () => bridge.send({ t: 'shell.open', path: c.workDir });
  $('#set-model').onchange = (e) => patchConfig({ model: e.target.value });
  $('#set-effort').onchange = (e) => patchConfig({ reasoningEffort: e.target.value });
  $('#set-theme').onchange = (e) => patchConfig({ theme: e.target.value });
  $('#set-codexpath').onchange = (e) => {
    patchConfig({ codexPath: e.target.value.trim() });
    bridge.send({ t: 'codex.refresh' });
  };
  $('#set-codex-detect').onclick = () => bridge.send({ t: 'codex.refresh' });
  $('#set-provider-save').onclick = () => {
    bridge.send({
      t: 'provider.save',
      baseUrl: $('#set-provider-url').value.trim(),
      model: $('#set-provider-model').value.trim(),
      apiKey: $('#set-provider-key').value,
      providerId: state.provider.providerId || 'deepseek',
    });
    $('#set-provider-key').value = '';
  };
  $('#set-open-data').onclick = () => bridge.send({ t: 'shell.open', path: c.dataDir });
  $('#set-clear-session').onclick = () => {
    if (!state.session) { toast('info', '当前没有正在编辑的对话。'); return; }
    const id = state.session.id;
    confirmDialog('清空当前对话的聊天记录？', () => bridge.send({ t: 'session.delete', id: id }));
  };

  $$('#settings-body [data-recent]').forEach((el) => {
    el.onclick = () => patchConfig({ workDir: el.getAttribute('data-recent') });
  });
  $$('#settings-body .choice').forEach((el) => {
    el.onclick = () => {
      const value = el.getAttribute('data-value');
      if (value === 'danger-full-access') {
        confirmDialog('“完全访问”会跳过沙箱限制，确定要切换吗？', () => patchConfig({ sandbox: value }));
      } else {
        patchConfig({ sandbox: value });
      }
      renderSettings();
    };
  });
  $$('#settings-body .switch').forEach((el) => {
    el.onclick = () => {
      const key = el.getAttribute('data-key');
      if (key === 'font-big') patchConfig({ fontSize: (c.fontSize || 15) >= 16 ? 15 : 17 });
      else if (key === 'show-reasoning') patchConfig({ showReasoning: !c.showReasoning });
      else if (key === 'auto-collapse') patchConfig({ autoCollapseTools: !c.autoCollapseTools });
      else if (key === 'send-enter') patchConfig({ sendOnEnter: !c.sendOnEnter });
      renderSettings();
      renderChat(false);
    };
  });
}

function effortOptions(current) {
  const model = state.models.find((m) => m.slug === (state.config.model || state.defaultModel));
  const levels = (model && model.levels && model.levels.length) ? model.levels.map((l) => l.effort)
    : ['low', 'high', 'max'];
  return ['<option value=""' + (current ? '' : ' selected') + '>跟随默认（' +
    esc(state.defaultEffort || 'high') + '）</option>']
    .concat(levels.map((lv) => '<option value="' + esc(lv) + '"' + (current === lv ? ' selected' : '') + '>' +
      esc((EFFORT_LABEL[lv] || lv) + '（' + lv + '）') + '</option>')).join('');
}

function themeOptions(current) {
  const themes = [
    ['dark', '深色（黑色）'],
    ['light', '浅色（白色）'],
    ['system', '跟随系统'],
  ];
  return themes.map(([value, label]) =>
    '<option value="' + value + '"' + (current === value ? ' selected' : '') + '>' + label + '</option>'
  ).join('');
}

function choiceHtml(value, name, desc, current) {
  return '<div class="choice' + (current === value ? ' on' : '') + '" data-value="' + esc(value) + '">' +
    '<span class="dot"></span><div class="c-main"><div class="c-name">' + esc(name) + '</div>' +
    '<div class="c-desc">' + esc(desc) + '</div></div></div>';
}

function toggleHtml(key, name, desc, on) {
  return '<div class="switch' + (on ? ' on' : '') + '" data-key="' + esc(key) + '">' +
    '<span class="track"></span><div><div class="s-label">' + esc(name) + '</div>' +
    '<div class="s-desc">' + esc(desc) + '</div></div></div>';
}

/* =============================== 事件绑定 =============================== */
function wireUi() {
  $$('.win-btn').forEach((b) => {
    b.onclick = () => bridge.send({ t: 'window', action: b.getAttribute('data-win') });
  });
  wireWindowChrome();

  $('#side-collapse').onclick = () => document.body.classList.toggle('collapsed');
  $('#side-toggle').onclick = () => document.body.classList.toggle('collapsed');
  $('#new-chat').onclick = () => {
    state.session = null;
    state.attachments = [];
    bridge.send({ t: 'session.new', create: false });
    updateComposer();
    renderChat(true);
    renderSidebar();
    renderAttachments();
    $('#input').focus();
  };
  $('#session-search').oninput = (e) => { state.search = e.target.value; renderSidebar(); };
  $('#open-settings').onclick = openSettings;
  $('#theme-toggle').onclick = () => patchConfig({ theme: state.config.theme === 'light' ? 'dark' : 'light' });
  $('#settings-close').onclick = closeSettings;
  $('#settings-done').onclick = closeSettings;
  $('#settings-mask').onclick = (e) => { if (e.target.id === 'settings-mask') closeSettings(); };

  $('#chip-workdir').onclick = (e) => showWorkdirMenu(e.currentTarget);
  $('#chip-model').onclick = (e) => showModelMenu(e.currentTarget);
  $('#chip-perm').onclick = (e) => showPermMenu(e.currentTarget);

  const input = $('#input');
  input.addEventListener('input', () => {
    autoSizeInput();
    if (!currentRunning()) $('#send').disabled = !input.value.trim() && !state.attachments.length;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const sendNow = state.config.sendOnEnter ? !e.shiftKey : (e.ctrlKey || e.metaKey);
      if (sendNow) { e.preventDefault(); sendMessage(); }
    }
  });
  input.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.files) || [];
    if (items.length) { e.preventDefault(); addFiles(items); }
  });
  $('#send').onclick = () => {
    if (currentRunning()) bridge.send({ t: 'stop', sessionId: currentSessionId() });
    else sendMessage();
  };
  $('#attach').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('#open-folder').onclick = () => bridge.send({ t: 'shell.open', path: currentWorkDir() });

  const composer = $('#composer');
  ['dragenter', 'dragover'].forEach((ev) => composer.addEventListener(ev, (e) => {
    e.preventDefault();
    composer.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => composer.addEventListener(ev, (e) => {
    e.preventDefault();
    composer.classList.remove('dragover');
  }));
  composer.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  const scroller = $('#chat-scroll');
  scroller.addEventListener('scroll', () => {
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    state.scrollPinned = gap < 100;
    $('#scroll-bottom').classList.toggle('hidden', state.scrollPinned);
  });
  $('#scroll-bottom').onclick = () => scrollToBottom();

  $('#session-list').onclick = (e) => {
    const more = e.target.closest('[data-session-menu]');
    if (more) {
      e.stopPropagation();
      showSessionMenu(more, more.getAttribute('data-session-menu'));
      return;
    }
    const item = e.target.closest('[data-session]');
    if (item) bridge.send({ t: 'session.load', id: item.getAttribute('data-session') });
  };

  $('#chat').addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      $('#input').value = quick.getAttribute('data-quick');
      autoSizeInput();
      $('#input').focus();
      return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const card = toggle.closest('.card');
      const key = card.getAttribute('data-card');
      card.classList.toggle('open');
      if (card.classList.contains('open')) state.openCards.add(key);
      else state.openCards.delete(key);
      return;
    }
    const reason = e.target.closest('[data-reason]');
    if (reason && e.target.tagName === 'SUMMARY') {
      const key = reason.getAttribute('data-reason');
      if (reason.open) state.openCards.delete(key);
      else state.openCards.add(key);
      return;
    }
    const copyCode = e.target.closest('[data-copy-code]');
    if (copyCode) {
      copyText(copyCode.closest('.code-block').querySelector('pre').textContent);
      return;
    }
    const copyKey = e.target.closest('[data-copy-key]');
    if (copyKey) {
      copyText(state.copyBuffer.get(copyKey.getAttribute('data-copy-key')) || '');
      return;
    }
    const copyMsg = e.target.closest('[data-copy-msg]');
    if (copyMsg) {
      const m = (state.session && state.session.messages[Number(copyMsg.getAttribute('data-copy-msg'))]) || null;
      if (m) copyText(m.text || '');
      return;
    }
    const copyTurn = e.target.closest('[data-copy-turn]');
    if (copyTurn) {
      const ts = Number(copyTurn.getAttribute('data-copy-turn'));
      const list = (state.session && state.session.messages) || [];
      const msg = list.find((x) => x.ts === ts);
      if (msg) copyText(plainTurnText(msg));
      return;
    }
    const resend = e.target.closest('[data-resend]');
    if (resend) {
      const m = (state.session && state.session.messages[Number(resend.getAttribute('data-resend'))]) || null;
      if (m && m.text) {
        $('#input').value = m.text;
        autoSizeInput();
        $('#input').focus();
      }
      return;
    }
    const link = e.target.closest('a[href]');
    if (link) {
      e.preventDefault();
      const href = link.getAttribute('href');
      if (/^https?:\/\//i.test(href)) bridge.send({ t: 'link.open', url: href });
      else bridge.send({ t: 'shell.open', path: href });
    }
  });

  $('#attachments').onclick = (e) => {
    const btn = e.target.closest('[data-remove-attach]');
    if (!btn) return;
    state.attachments.splice(Number(btn.getAttribute('data-remove-attach')), 1);
    renderAttachments();
  };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu') && !e.target.closest('[data-session-menu]') &&
        !e.target.closest('#chip-workdir') && !e.target.closest('#chip-model') && !e.target.closest('#chip-perm')) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#menu').classList.contains('hidden')) { closeMenu(); return; }
      if (settingsOpen()) { closeSettings(); return; }
      if (currentRunning()) bridge.send({ t: 'stop', sessionId: currentSessionId() });
      return;
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      document.body.classList.toggle('collapsed');
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#new-chat').click(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#session-search').focus(); }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); }
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
}

/* 无边框窗口：标题栏拖动、双击最大化、八向缩放。
   WebView2 铺满整个窗口，宿主拿不到非客户区命中测试，所以这里把意图发回宿主，
   由宿主调用系统的移动/缩放循环。 */
const RESIZE_EDGE = 4;              // 边缘热区宽度（px）
const DRAG_IGNORE = 'button, a, input, textarea, select, .win-buttons, .chip';
const EDGE_CURSOR = {
  left: 'ew-resize', right: 'ew-resize', top: 'ns-resize', bottom: 'ns-resize',
  topleft: 'nwse-resize', bottomright: 'nwse-resize',
  topright: 'nesw-resize', bottomleft: 'nesw-resize',
};

function edgeAtPoint(x, y) {
  if (state.maximized) return '';
  const w = window.innerWidth;
  const h = window.innerHeight;
  const left = x <= RESIZE_EDGE;
  const right = x >= w - RESIZE_EDGE;
  const top = y <= RESIZE_EDGE;
  const bottom = y >= h - RESIZE_EDGE;
  if (top && left) return 'topleft';
  if (top && right) return 'topright';
  if (bottom && left) return 'bottomleft';
  if (bottom && right) return 'bottomright';
  if (left) return 'left';
  if (right) return 'right';
  if (top) return 'top';
  if (bottom) return 'bottom';
  return '';
}

function wireWindowChrome() {
  // 宿主开启了 WebView2 的非客户区支持时，标题栏由系统的 app-region: drag 处理
  // （见 styles.css），这里只在旧运行时上做兜底：把拖动意图发回宿主。
  const nativeDrag = !!(window.__CODEX_BOOT__ && window.__CODEX_BOOT__.nativeDrag);
  if (!nativeDrag) {
    $$('.topbar, .side-head').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.detail > 1) return;
        if (e.target.closest && e.target.closest(DRAG_IGNORE)) return;
        bridge.send({ t: 'window', action: 'drag' });
      });
      handle.addEventListener('dblclick', (e) => {
        if (e.target.closest && e.target.closest(DRAG_IGNORE)) return;
        bridge.send({ t: 'window', action: 'maximize' });
      });
    });
  }

  // 缩放：系统只认标题栏，四边八向的缩放热区仍然由页面负责
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const edge = edgeAtPoint(e.clientX, e.clientY);
    if (!edge) return;
    e.preventDefault();
    e.stopPropagation();
    bridge.send({ t: 'window', action: 'resize', edge: edge });
  }, true);

  let lastCursor = '';
  document.addEventListener('mousemove', (e) => {
    const edge = edgeAtPoint(e.clientX, e.clientY);
    const cursor = edge ? EDGE_CURSOR[edge] : '';
    if (cursor === lastCursor) return;
    lastCursor = cursor;
    document.body.style.cursor = cursor;
  });
}

function copyText(text) {
  if (!text) return;
  bridge.send({ t: 'clipboard.write', text: text });
  toast('info', '已复制');
}

/* 自动化测试入口：走和点“发送”按钮完全一样的路径 */
window.__autorun = function (text) {
  const input = $('#input');
  input.value = text;
  autoSizeInput();
  sendMessage();
};

function plainTurnText(m) {
  const parts = [];
  (m.items || []).forEach((it) => {
    if (it.type === 'agent_message' && it.text) parts.push(it.text);
    else if (it.type === 'reasoning' && it.text) parts.push('[思考] ' + it.text);
    else if (it.type === 'command_execution' && it.command) parts.push('$ ' + it.command + '\n' + (it.aggregated_output || ''));
  });
  if (m.error) parts.push('[错误] ' + m.error);
  return parts.join('\n\n');
}

/* =============================== 演示模式 =============================== */
function createDemoBridge() {
  const handlers = [];
  const emit = (msg) => setTimeout(() => handlers.forEach((h) => h(msg)), 0);
  const now = Date.now();
  const sessions = [
    { id: 's1', title: '用 CMake 编译 helloworld', preview: '用 CMake 编译 helloworld', updatedAt: now - 3600e3, createdAt: now - 3600e3 },
    { id: 's2', title: '排查内存泄漏', preview: '排查内存泄漏', updatedAt: now - 86400e3, createdAt: now - 86400e3 },
    { id: 's3', title: '解释这个项目的结构', preview: '解释这个项目的结构', updatedAt: now - 86400e3 * 3, createdAt: now - 86400e3 * 3 },
  ];
  const sample = {
    id: 's1',
    title: '用 CMake 编译 helloworld',
    workDir: 'D:\\projects\\hello',
    messages: [
      { role: 'user', ts: now - 60000, text: '帮我看看 D:\\projects\\hello 下的 helloworld.cpp，然后写一个 CMakeLists.txt 并编译一下。' },
      {
        role: 'assistant', ts: now - 50000,
        usage: { input_tokens: 18432, cached_input_tokens: 16384, output_tokens: 812 },
        durationMs: 12800,
        items: [
          { id: 'r1', type: 'reasoning', text: '先读一下源文件，确认使用的 C++ 标准；然后写一个最小的 CMakeLists，最后用 cmake -S . -B build 构建验证。' },
          {
            id: 'c1', type: 'command_execution', status: 'completed', exit_code: 0,
            command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content D:\\projects\\hello\\helloworld.cpp"',
            aggregated_output: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n',
          },
          {
            id: 'f1', type: 'file_change',
            changes: [{ path: 'D:\\projects\\hello\\CMakeLists.txt', kind: 'add' }],
            diff: '--- /dev/null\n+++ b/CMakeLists.txt\n@@ -0,0 +1,8 @@\n+cmake_minimum_required(VERSION 3.16)\n+project(helloworld CXX)\n+\n+set(CMAKE_CXX_STANDARD 17)\n+set(CMAKE_CXX_STANDARD_REQUIRED ON)\n+\n+add_executable(helloworld helloworld.cpp)\n',
          },
          {
            id: 't1', type: 'todo_list',
            items: [
              { text: '读取 helloworld.cpp', status: 'completed' },
              { text: '生成 CMakeLists.txt', status: 'completed' },
              { text: '运行 cmake 构建验证', status: 'in_progress' },
            ],
          },
          {
            id: 'c2', type: 'command_execution', status: 'completed', exit_code: 0,
            command: 'cmake -S D:\\projects\\hello -B D:\\projects\\hello\\build',
            aggregated_output: '-- The CXX compiler identification is GNU 16.1.0\n-- Configuring done (0.4s)\n-- Generating done (0.0s)\n-- Build files have been written to: D:/projects/hello/build\n',
          },
          {
            id: 'a1', type: 'agent_message',
            text: '已经在 `D:\\projects\\hello` 下准备好了构建配置，编译也通过了。\n\n- 新增了 `CMakeLists.txt`，用的是 C++17\n- 构建目录：`D:\\projects\\hello\\build`\n\n编译命令：\n\n```bash\ncmake -S D:\\projects\\hello -B D:\\projects\\hello\\build\ncmake --build D:\\projects\\hello\\build\n```\n\n> 如果要用 MinGW 的 g++，记得先确认 `mingw32-make` 在 PATH 里。',
          },
        ],
      },
    ],
  };
  let timer = null;
  return {
    mode: 'demo',
    onMessage: (h) => handlers.push(h),
    send: (obj) => {
      if (obj.t === 'init') {
        emit({
          t: 'state',
          config: {
            workDir: 'D:\\projects\\hello', model: 'deepseek-flash', reasoningEffort: 'high',
            sandbox: 'workspace-write', theme: 'dark', fontSize: 15, showReasoning: true,
            autoCollapseTools: true, sendOnEnter: true, recentDirs: ['D:\\projects\\hello', 'D:\\projects'],
            sidebarWidth: 272, dataDir: 'C:\\Users\\you\\AppData\\Roaming\\CodexGui',
          },
          sessions: sessions,
          codex: {
            found: true, path: 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd',
            version: 'codex-cli 0.154.0', workDirExists: true,
          },
          models: [
            { slug: 'deepseek-flash', displayName: 'DeepSeek-Flash', description: 'Latest frontier agentic coding model with image input.', levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }] },
            { slug: 'deepseek-v4-pro', displayName: 'DeepSeek-V4-Pro', description: 'Most capable frontier agentic coding model.', levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }] },
          ],
          defaultModel: 'deepseek-flash',
          defaultEffort: 'high',
        });
        emit({ t: 'session', session: sample });
      } else if (obj.t === 'send') {
        const sid = 'demo-' + Date.now();
        emit({ t: 'turn.user', sessionId: sid, message: { role: 'user', ts: Date.now(), text: obj.text, images: [] }, title: obj.text.slice(0, 20) });
        emit({ t: 'turn.status', sessionId: sid, status: 'running' });
        const script = [
          { delay: 400, event: { type: 'item.completed', item: { id: 'd0', type: 'reasoning', text: '先看看当前目录里有什么，再决定怎么改。' } } },
          { delay: 900, event: { type: 'item.started', item: { id: 'd1', type: 'command_execution', status: 'in_progress', command: 'powershell -Command "Get-ChildItem D:\\projects\\hello"', aggregated_output: '' } } },
          { delay: 1600, event: { type: 'item.completed', item: { id: 'd1', type: 'command_execution', status: 'completed', exit_code: 0, command: 'powershell -Command "Get-ChildItem D:\\projects\\hello"', aggregated_output: 'helloworld.cpp\nCMakeLists.txt\nbuild\n' } } },
          { delay: 2200, event: { type: 'item.completed', item: { id: 'd2', type: 'agent_message', text: '这是演示模式的回复，真正的窗口里显示的是 Codex 的真实输出。' } } },
        ];
        clearTimeout(timer);
        script.forEach((s) => { timer = setTimeout(() => emit({ t: 'turn.event', sessionId: sid, event: s.event }), s.delay); });
        setTimeout(() => emit({
          t: 'turn.status', sessionId: sid, status: 'done',
          usage: { input_tokens: 9000, output_tokens: 120 }, durationMs: 2600,
        }), 2700);
      }
    },
  };
}

document.addEventListener('DOMContentLoaded', init);
