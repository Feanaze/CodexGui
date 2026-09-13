/*
 * 页面侧回归测试：
 *  1) 草稿状态下发第一条消息，页面上只能出现一条（不能是两条）；
 *  2) 发完消息后左侧对话列表要立刻出现这条对话，不用等这一轮跑完。
 * Usage: node tools\session-ui-test.js
 */
const { createApp } = require('./app-dom-stub');

const checks = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, extra });

function userMsg(ts, text) {
  return { role: 'user', ts, text, images: [] };
}

function sessionEntry(id, title, ts) {
  return { id, title, preview: title, workDir: 'D:\\cpp', createdAt: ts, updatedAt: ts, messageCount: 1 };
}

// ---------------------------------------------------------------- 场景 1
// 点「新建对话」→ 草稿 → 发第一条消息。宿主按修好之后的顺序推送消息。
{
  const app = createApp({ nativeDrag: true });
  app.host({
    t: 'state',
    config: { workDir: 'D:\\cpp', sandbox: 'workspace-write' },
    sessions: [],
    runningSessions: [],
    codex: { found: true, version: 'test', workDirExists: true, path: 'codex.cmd' },
    models: [],
  });

  app.evalIn('document.querySelector("#new-chat").onclick()');
  check('新建对话后是草稿状态', app.evalIn('state.session') === null);

  const ts = 1700000000000;
  const text = '帮我整理一下今天的笔记';
  // 宿主：先把空会话发过来（此时还没写入这条用户消息），再发 turn.user
  app.host({ t: 'session', session: { id: 'N1', title: '', workDir: 'D:\\cpp', messages: [] } });
  app.host({ t: 'turn.user', sessionId: 'N1', message: userMsg(ts, text), title: text });
  check('第一条消息只显示一条',
    app.evalIn('state.session.messages.length') === 1,
    'messages=' + app.evalIn('JSON.stringify(state.session.messages.map((m) => m.text))'));
  check('左侧列表立刻出现这条对话',
    app.evalIn('state.sessions.some((s) => s.id === "N1")'));
  check('侧栏 DOM 里有这条对话',
    app.evalIn('document.querySelector("#session-list").innerHTML').indexOf('data-session="N1"') >= 0);

  // 宿主随后回传权威的 sessions 列表，标题和预览要对得上，条数不能翻倍
  app.host({ t: 'sessions', sessions: [sessionEntry('N1', text, ts)] });
  check('宿主回传 sessions 后仍只有一条对话',
    app.evalIn('state.sessions.length') === 1);

  // 这一轮结束：助手回复补在用户消息后面，顺序不乱
  app.host({
    t: 'turn.event', sessionId: 'N1',
    event: { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '好的，已经整理完了。' } },
  });
  app.host({
    t: 'turn.status', sessionId: 'N1', status: 'done',
    usage: { input_tokens: 10, output_tokens: 5 }, durationMs: 1000,
  });
  check('结束后是 用户消息 + 助手回复',
    app.evalIn('state.session.messages.length') === 2
    && app.evalIn('state.session.messages[0].role') === 'user'
    && app.evalIn('state.session.messages[1].role') === 'assistant');
}

// ---------------------------------------------------------------- 场景 2
// 宿主把「整份会话（已含这条消息）」和 turn.user 都发过来时，页面也要去重。
{
  const app = createApp({ nativeDrag: true });
  app.host({
    t: 'state',
    config: { workDir: 'D:\\cpp', sandbox: 'workspace-write' },
    sessions: [],
    runningSessions: [],
    codex: { found: true, version: 'test', workDirExists: true, path: 'codex.cmd' },
    models: [],
  });

  const ts = 1700000005000;
  const text = '你好';
  app.host({
    t: 'session',
    session: { id: 'N2', title: text, workDir: 'D:\\cpp', messages: [userMsg(ts, text)] },
  });
  app.host({ t: 'turn.user', sessionId: 'N2', message: userMsg(ts, text), title: text });
  check('重复推送同一条消息时不会显示两遍',
    app.evalIn('state.session.messages.length') === 1,
    'messages=' + app.evalIn('state.session.messages.length'));

  app.host({ t: 'turn.user', sessionId: 'N2', message: userMsg(ts + 1, '第二条'), title: text });
  check('真正的新消息仍然会加上去',
    app.evalIn('state.session.messages.length') === 2);
}

// ---------------------------------------------------------------- 场景 3
// 在别的对话里发消息时，列表里的那一条也要马上刷新时间/标题。
{
  const app = createApp({ nativeDrag: true });
  app.host({
    t: 'state',
    config: { workDir: 'D:\\cpp', sandbox: 'workspace-write' },
    sessions: [sessionEntry('A', '旧标题', 1), sessionEntry('B', 'B 对话', 2)],
    runningSessions: [],
    codex: { found: true, version: 'test', workDirExists: true, path: 'codex.cmd' },
    models: [],
  });
  app.host({ t: 'session', session: { id: 'B', title: 'B 对话', workDir: 'D:\\cpp', messages: [] } });
  app.host({ t: 'turn.user', sessionId: 'B', message: userMsg(1700000009000, 'B 的新消息'), title: 'B 对话' });
  check('列表条数没有变多', app.evalIn('state.sessions.length') === 2);
  check('发消息的对话时间戳被刷新',
    app.evalIn('state.sessions.find((s) => s.id === "B").updatedAt') === 1700000009000
    || app.evalIn('state.sessions.find((s) => s.id === "B").updatedAt') > 2);
}

let failed = 0;
checks.forEach((c) => {
  if (!c.ok) failed++;
  console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.ok || !c.extra ? '' : '  -> ' + c.extra));
});
console.log(failed === 0 ? 'ALL PASS' : failed + ' CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);
