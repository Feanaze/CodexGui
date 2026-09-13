/*
 * 页面侧回归测试：设置面板里的「API 配置」
 *  1) 未配置时 boot 里的 provider 状态能被读进来，并渲染出 API 配置区；
 *  2) 点「保存并启用」会把链接/模型/密钥按 provider.save 发给宿主，并清空密钥输入框；
 *  3) 宿主回传 provider 状态后面板能回显，缺密钥时给出提示。
 * Usage: node tools\provider-settings-test.js
 */
const { createApp } = require('./app-dom-stub');

const checks = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, extra });

// ---------------------------------------------------------------- 场景 1
{
  const app = createApp({
    provider: {
      configured: false, baseUrl: '', model: '', hasApiKey: false,
      providerId: 'deepseek', configPath: 'C:\\data\\codex-home\\config.toml',
    },
  });

  check('boot 里的 provider 状态被读进来', app.evalIn('state.provider.configured') === false);

  app.evalIn('openSettings()');
  const html = app.evalIn('document.querySelector("#settings-body").innerHTML');
  check('设置面板渲染了 API 配置区',
    html.indexOf('set-provider-url') >= 0 && html.indexOf('set-provider-save') >= 0);
  check('默认填入服务商地址与配置文件路径',
    html.indexOf('https://api.deepseek.com/') >= 0 && html.indexOf('config.toml') >= 0);
}

// ---------------------------------------------------------------- 场景 2
{
  const app = createApp({ provider: { configured: false, providerId: 'deepseek' } });
  app.evalIn('openSettings()');
  app.evalIn('$("#set-provider-url").value = "https://api.deepseek.com/"');
  app.evalIn('$("#set-provider-model").value = "deepseek-chat"');
  app.evalIn('$("#set-provider-key").value = "sk-test-not-real"');
  app.evalIn('$("#set-provider-save").onclick()');

  const msg = app.lastSent('provider.save');
  check('发送了 provider.save', !!msg, JSON.stringify(msg));
  check('带上地址 / 模型 / 密钥',
    msg && msg.baseUrl === 'https://api.deepseek.com/'
      && msg.model === 'deepseek-chat'
      && msg.apiKey === 'sk-test-not-real',
    msg ? JSON.stringify(msg) : '');
  check('发送后清空密钥输入框', app.evalIn('$("#set-provider-key").value') === '');
}

// ---------------------------------------------------------------- 场景 3
{
  const app = createApp({ provider: { configured: false, providerId: 'deepseek' } });
  app.evalIn('openSettings()');
  app.host({
    t: 'provider', configured: true, baseUrl: 'https://proxy.example.com/v1',
    model: 'deepseek-v4-pro', hasApiKey: false,
  });

  const html = app.evalIn('document.querySelector("#settings-body").innerHTML');
  check('回显当前 API 地址', html.indexOf('https://proxy.example.com/v1') >= 0);
  check('缺密钥时给出提示', html.indexOf('缺密钥') >= 0);
}

let failed = 0;
for (const item of checks) {
  console.log((item.ok ? 'PASS  ' : 'FAIL  ') + item.name + (item.ok || !item.extra ? '' : '  -> ' + item.extra));
  if (!item.ok) failed++;
}
console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
