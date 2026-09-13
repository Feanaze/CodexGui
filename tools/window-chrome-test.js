/*
 * Regression check for the frameless window plumbing in wwwroot/app.js:
 *   - the resize edges map to { t:'window', action:'resize', edge:<side> }
 *   - the title bar drag fallback only fires when the host could not enable
 *     WebView2 native non-client regions (boot.nativeDrag)
 * Usage: node tools\window-chrome-test.js
 */
const { createApp } = require('./app-dom-stub');

const expectedEdges = ['bottomright', 'bottomleft', 'right', 'left', 'top', 'bottom', null];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function run(bootFlags) {
  const app = createApp(bootFlags);

  const before = app.sent.length;
  app.topbar.dispatch('mousedown', { clientX: 680, clientY: 20 });
  const dragSent = app.sent.slice(before)
    .filter((m) => m && m.t === 'window' && m.action === 'drag').length;

  const edges = [];
  const probe = (x, y) => {
    const mark = app.sent.length;
    app.fireDocMousedown(x, y);
    const msg = app.sent.slice(mark).find((m) => m && m.t === 'window' && m.action === 'resize');
    edges.push(msg ? msg.edge : null);
  };
  probe(1359, 859);   // bottom right
  probe(1, 859);      // bottom left
  probe(1359, 30);    // right
  probe(1, 30);       // left
  probe(60, 1);       // top
  probe(60, 858);     // bottom
  probe(400, 400);    // middle: nothing

  return { dragSent, edges };
}

const fallback = run({ nativeDrag: false });
const native = run({ nativeDrag: true });

console.log('nativeDrag=false: drag messages =', fallback.dragSent, '| edges =', fallback.edges.join(','));
console.log('nativeDrag=true : drag messages =', native.dragSent, '| edges =', native.edges.join(','));

const ok = fallback.dragSent === 1 && same(fallback.edges, expectedEdges)
  && native.dragSent === 0 && same(native.edges, expectedEdges);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
