// Minimal CDP driver for headless playtesting (Node 22+ global WebSocket/fetch). No npm install:
// the Chrome DevTools Protocol over a plain WebSocket is the whole dependency.
//
// env: CDP_PORT (devtools port, default 9351), BASE_URL (page origin, default
//      http://127.0.0.1:5253/), VIEWPORT=WxHxDPR (emulated viewport for the fit scenarios)
//
//   node tools/playtest.cjs open <url>          fresh tab at <url>, prints boot logs
//   node tools/playtest.cjs eval '<expr>'       evaluate, await promises, print result
//   node tools/playtest.cjs eval '<expr>' nonav don't navigate first
//   node tools/playtest.cjs scenario <name>     inject tools/scenarios.js, run __ng.<name>()
//   node tools/playtest.cjs input               trusted mouse / touch / key presses via CDP
//   node tools/playtest.cjs shot <file.png>
//   node tools/playtest.cjs logs
//
// Which page to attach to is decided by BASE_URL's origin, never by a hard-coded port: an
// `eval` that silently lands on an about:blank target reads like a broken deploy.
//
// `input` is the only command that goes through the browser's own input queue instead of
// dispatching synthetic events inside the page. Real mouse, real touch, real keys — because
// "mouse, touch and keyboard drive the same state" is exactly the claim a synthetic event can
// be talked into passing.
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9351);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5253/';
const ORIGIN = new URL(BASE).origin;
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

const logs = [];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) this.consume(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  consume(m) {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push(`[log:error] ${e.text} ${e.url || ''}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not bound yet */
    }
    if (Date.now() > deadline) throw new Error(`devtools never bound on :${PORT}`);
    await sleep(250);
  }
}

async function main() {
  const info = await waitForDevTools();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) {
      if (t.type === 'page' && isOurs(t.url)) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* already gone */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let sessionId;
  if (existing) {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: existing.id || existing.targetId, flatten: true }));
  } else {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Input.enable', {}, sessionId).catch(() => {});

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 900000 },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 120; i++) {
      const ready = await evaluate('document.readyState').catch(() => 'loading');
      if (ready === 'complete') break;
      await sleep(100);
    }
  };

  // A real emulated viewport, so a "420 px" claim is a layout fact and not a stubbed getter:
  // media queries, innerWidth and the scroll box all agree with a phone at this point.
  const applyViewport = async () => {
    const spec = process.env.VIEWPORT;
    if (!spec) {
      // The override lives on the *target*, not on this connection: without clearing it, a `fit`
      // run at 420 px would still be squeezing every later scenario.
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId).catch(() => {});
      return null;
    }
    const [w, h, d] = spec.split(/[x×@]/).map(Number);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h || 900,
      deviceScaleFactor: d || 1,
      mobile: (d || 1) > 1,
    }, sessionId);
    await sleep(150);
    return { w, h: h || 900, d: d || 1 };
  };

  if (cmd === 'open') {
    await navigate(arg || BASE);
    await sleep(400);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const out = await evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else if (cmd === 'scenario') {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    const vp = await applyViewport();
    await navigate(BASE);
    // Headless reports the page as hidden, and the render loop is allowed to skip frames when
    // hidden — so a scenario that waits on animation would time out against a browser that is
    // only pretending to be in the background.
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});'ok'`);
    const out = await evaluate(`(async()=>{
      if (!window.__ng) throw new Error('scenarios.js never installed');
      if (!window.syllogism) throw new Error('js/main.js never booted');
      const r = await window.__ng[${JSON.stringify(arg)}]();
      return JSON.stringify(r);
    })()`);
    // Console noise first, machine-readable line last: the parser in verify.sh takes the
    // final RESULT line, so a stray '{' in a log cannot hijack the report.
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + out);
  } else if (cmd === 'input') {
    // The three input kinds, through the browser's real event queue.
    await applyViewport();
    await navigate(BASE);
    await sleep(250);
    const rows = [];
    const ck = (test, cond, detail) => rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
    // `state()` is stringified inside the page because Runtime.evaluate hands back a primitive
    // by value — a raw object would arrive as RemoteObject, not data. Parse it here: reading
    // `.known[0]` off that string used to raise "Cannot read properties of undefined (reading
    // '0')" and take the whole scenario down before its first assertion.
    const read = async () => JSON.parse(await evaluate('JSON.stringify(window.syllogism.state())'));
    const fresh = (value) => evaluate(`(()=>{
      const A = window.syllogism;
      A.begin({tier:'trainee', seed:'browser|input'});
      A.restart();
      const i = A.slotFor(0, ${value});
      const c = A.slotCenter(i);
      return JSON.stringify({ i, x: c.x, y: c.y, known: A.known[0], moves: A.game.moves });
    })()`).then(JSON.parse);

    const KNIGHT = 1;
    await evaluate('window.syllogism ? 1 : (function(){ throw new Error("window.syllogism never booted") })()');

    // 1. real mouse
    let s = await fresh(KNIGHT);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.x, y: s.y, button: 'left', clickCount: 1, buttons: 1 }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x, y: s.y, button: 'left', clickCount: 1, buttons: 0 }, sessionId);
    await sleep(80);
    let m = await read();
    ck('真实鼠标点骑士牌落下身份', m.known[0] === KNIGHT && m.moves === 1, JSON.stringify({ ...m, known: m.known[0] }));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.x, y: s.y, button: 'left', clickCount: 1, buttons: 1 }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x, y: s.y, button: 'left', clickCount: 1, buttons: 0 }, sessionId);
    await sleep(80);
    m = await read();
    ck('真实鼠标再点同一张牌收回身份', m.known[0] === -1 && m.moves === 2, JSON.stringify(m.known));

    // 2. real touch
    s = await fresh(KNIGHT);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: s.x, y: s.y, id: 1 }] }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await sleep(120);
    const t = await read();
    ck('真实触摸落下同一个身份', t.known[0] === KNIGHT && t.moves === 1, JSON.stringify({ known: t.known[0], moves: t.moves }));

    // 3. real keyboard, on the canvas that owns focus
    s = await fresh(KNIGHT);
    await evaluate(`(()=>{ const c = document.querySelector('#board'); c.focus(); return document.activeElement.id; })()`);
    await sleep(40);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', text: '1', windowsVirtualKeyCode: 49 }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 }, sessionId);
    await sleep(120);
    const k = await read();
    ck('真实键盘 1 落下同一个身份', k.known[0] === KNIGHT && k.moves === 1, JSON.stringify({ known: k.known[0], moves: k.moves }));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'u', code: 'KeyU', text: 'u', windowsVirtualKeyCode: 85 }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', text: 'u', windowsVirtualKeyCode: 85 }, sessionId);
    await sleep(120);
    const ku = await read();
    ck('真实键盘 u 撤销这一步', ku.known[0] === -1 && ku.moves === 0 && ku.hints === 0, JSON.stringify(ku.known));
    ck('三种输入记的是同一笔账', m.moves === 2 && t.moves === 1 && k.moves === 1 && k.hints === 0 && t.hints === 0,
      JSON.stringify({ mouse: m.moves, touch: t.moves, key: k.moves }));

    // Tab really moves focus, and the ring is drawn on the canvas
    await evaluate(`(()=>{ const c=document.querySelector('#board'); c.focus(); })()`);
    const beforeTab = await evaluate('window.syllogism.game.focus');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId);
    await sleep(120);
    const afterTab = await evaluate('window.syllogism.game.focus');
    ck('真实 Tab 换到下一个人的卡', afterTab !== beforeTab, `${beforeTab} → ${afterTab}`);
    ck('焦点仍在画布上（键盘不会跑掉）', await evaluate('document.activeElement.id') === 'board');

    const fail = rows.filter((r) => !r.pass).length;
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + JSON.stringify({ rows, fail, mouse: m.moves, touch: t.moves, key: k.moves }));
  } else if (cmd === 'shot') {
    // A background tab only pushes compositor frames when something repaints it, so a
    // capture taken right after a pure CSS state change (hiding one screen, showing
    // another) can return the previous frame. Bringing the target forward forces one.
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
  } else if (cmd === 'logs') {
    console.log(logs.join('\n') || '(clean)');
  } else if (cmd === 'reload-logs') {
    await navigate(BASE);
    console.log(logs.join('\n') || '(clean)');
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(64);
  }
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR ' + (err.message || err));
  if (logs.length) console.error(logs.slice(-12).join('\n'));
  process.exit(1);
});
