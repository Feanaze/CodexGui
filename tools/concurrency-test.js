/*
 * Checks that two conversations can run at the same time and that the page
 * keeps their live output apart (each session has its own workDir + stream).
 * Usage: node tools\concurrency-test.js
 */
const { createApp } = require('./app-dom-stub');

function userMsg(text) {
  return { role: 'user', ts: Date.now(), text, images: [] };
}

function session(id, workDir, messages) {
  return { id, title: id, workDir, messages: messages || [] };
}

const app = createApp({ nativeDrag: true });
const checks = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, extra });

app.host({
  t: 'state',
  config: { workDir: 'D:\\a', sandbox: 'workspace-write' },
  sessions: [session('A', 'D:\\a'), session('B', 'D:\\b')],
  runningSessions: [],
  codex: { found: true, version: 'test', workDirExists: true, path: 'codex.cmd' },
  models: [],
});
app.host({ t: 'session', session: session('A', 'D:\\a') });

// --- turn 1 in conversation A (workdir D:\a)
app.host({ t: 'turn.user', sessionId: 'A', message: userMsg('A: 第一条'), title: 'A' });
app.host({ t: 'turn.status', sessionId: 'A', status: 'running' });
app.host({ t: 'turn.event', sessionId: 'A', event: { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'A 的输出' } } });
app.host({ t: 'turns', sessions: ['A'] });

check('A 运行时被标记', app.evalIn('state.runningIds.has("A")'));
check('A 有自己的现场', app.evalIn('Object.keys(state.live).join()') === 'A');
check('A 现场收到 1 条 item', app.evalIn('state.live.A.items.size') === 1);
check('A 视图显示停止按钮', app.evalIn('document.querySelector("#send").classList.contains("stop")'));

// --- conversation B starts while A is still running, with a different workdir
app.host({ t: 'session', session: session('B', 'D:\\b') });
app.host({ t: 'turn.user', sessionId: 'B', message: userMsg('B: 第一条'), title: 'B' });
app.host({ t: 'turn.status', sessionId: 'B', status: 'running' });
app.host({ t: 'turns', sessions: ['A', 'B'] });
app.host({
  t: 'turn.event',
  sessionId: 'B',
  event: { type: 'item.completed', item: { id: 'b1', type: 'agent_message', text: 'B 的输出' } },
});

check('两个对话同时在跑', app.evalIn('Array.from(state.runningIds).sort().join()') === 'A,B');
check('两份现场互不干扰',
  app.evalIn('Object.keys(state.live).sort().join()') === 'A,B'
  && app.evalIn('state.live.A.items.has("b1")') === false
  && app.evalIn('state.live.B.items.has("a1")') === false);
check('B 的工作目录是自己的', app.evalIn('currentWorkDir()') === 'D:\\b');
check('侧栏标出两个在跑的对话',
  app.evalIn('document.querySelector("#session-list").innerHTML').split('s-run').length - 1 === 2);

// --- A finishes in the background while B is on screen
app.host({ t: 'turn.status', sessionId: 'A', status: 'done', usage: null, durationMs: 1 });
check('A 结束后不再标记运行', app.evalIn('state.runningIds.has("A")') === false);
check('A 的现场被回收', app.evalIn('typeof state.live.A') === 'undefined');
check('B 仍在运行', app.evalIn('state.runningIds.has("B")') === true);
check('后台结束不会污染当前会话', app.evalIn('state.session.id') === 'B'
  && app.evalIn('state.session.messages.length') === 1);
check('B 的现场还在', app.evalIn('state.live.B.items.size') === 1);

// --- a third, idle conversation can be opened and used while B runs
app.evalIn('document.querySelector("#new-chat").onclick()');
const draftMsg = app.lastSent('session.new');
check('新建对话会解除当前会话绑定', !!draftMsg && draftMsg.create === false, JSON.stringify(draftMsg));
app.host({ t: 'session', session: session('C', 'D:\\c') });
app.host({ t: 'turns', sessions: ['B'] });
check('新对话可以立刻发消息', app.evalIn('document.querySelector("#send").classList.contains("stop")') === false);
check('提示还有其他对话在跑',
  String(app.evalIn('document.querySelector("#status-text").textContent')).indexOf('1 个其他对话正在运行') >= 0);

// --- B finishes while it is on screen: the assistant turn is appended once
app.host({ t: 'session', session: session('B', 'D:\\b') });
app.host({ t: 'turn.user', sessionId: 'B', message: userMsg('B: 第一条'), title: 'B' });
app.host({
  t: 'turn.status',
  sessionId: 'B',
  status: 'done',
  usage: { input_tokens: 1, output_tokens: 1 },
  durationMs: 5,
});
check('B 结束时补上助手回复', app.evalIn('state.session.id') === 'B'
  && app.evalIn('state.session.messages.length') === 2
  && app.evalIn('state.session.messages[1].role') === 'assistant');
check('全部结束后没有运行中的对话', app.evalIn('state.runningIds.size') === 0);

// --- stop button targets the conversation it belongs to
app.host({ t: 'session', session: session('C', 'D:\\c') });
app.host({ t: 'turn.status', sessionId: 'C', status: 'running' });
app.host({ t: 'turns', sessions: ['C'] });
app.evalIn('document.querySelector("#send").onclick()');
const stop = app.lastSent('stop');
check('停止按钮带上会话 id', !!stop && stop.sessionId === 'C', JSON.stringify(stop));

let failed = 0;
checks.forEach((c) => {
  if (!c.ok) failed++;
  console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.ok || !c.extra ? '' : '  -> ' + c.extra));
});
console.log(failed === 0 ? 'ALL PASS' : failed + ' CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);
