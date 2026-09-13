/*
 * Minimal DOM/bridge stub that runs the real wwwroot/app.js under Node.
 * Used by window-chrome-test.js and concurrency-test.js.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.resolve(__dirname, '..', 'wwwroot', 'app.js');
const MD_JS = path.resolve(__dirname, '..', 'wwwroot', 'md.js');

function makeEvent(type, props) {
  return Object.assign({
    type,
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    clientX: 0,
    clientY: 0,
    target: null,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  }, props || {});
}

function makeElement(name) {
  const listeners = [];
  const attrs = new Map();
  const classes = new Set();
  const style = {
    setProperty(k, v) { style[k] = v; },
    removeProperty(k) { delete style[k]; },
    getPropertyValue(k) { return style[k] || ''; },
  };
  return {
    __name: name,
    listeners,
    style,
    dataset: {},
    children: [],
    disabled: false,
    classList: {
      add(...c) { c.forEach((x) => classes.add(x)); },
      remove(...c) { c.forEach((x) => classes.delete(x)); },
      toggle(c) { classes.has(c) ? classes.delete(c) : classes.add(c); },
      contains(c) { return classes.has(c); },
    },
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener() {},
    dispatch(type, props) {
      const ev = makeEvent(type, Object.assign({ target: this, currentTarget: this }, props));
      listeners.filter((l) => l.type === type).forEach((l) => l.fn(ev));
      return ev;
    },
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {}, insertBefore(c) { return c; }, remove() {},
    setAttribute(k, v) { attrs.set(k, String(v)); },
    removeAttribute(k) { attrs.delete(k); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    querySelector() { return makeElement(name + ' > q'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    scrollTo() {}, insertAdjacentHTML() {}, replaceChildren() {}, animate() {},
    textContent: '', innerHTML: '', value: '', id: '', className: '', hidden: false,
    scrollHeight: 0, clientWidth: 0, clientHeight: 0, offsetWidth: 0, offsetHeight: 0,
  };
}

function createApp(bootFlags) {
  const sent = [];                     // page -> host
  const webviewListeners = [];         // host -> page
  const topbar = makeElement('#topbar');
  const sideHead = makeElement('.side-head');
  const docListeners = [];
  const cache = new Map();

  const document = makeElement('#document');
  document.addEventListener = (type, fn, capture) => docListeners.push({ type, fn, capture: !!capture });
  document.removeEventListener = () => {};
  document.querySelector = (sel) => {
    if (sel === '#topbar') return topbar;
    if (!cache.has(sel)) cache.set(sel, makeElement(sel));
    return cache.get(sel);
  };
  document.querySelectorAll = (sel) => (
    sel.indexOf('.topbar') >= 0 && sel.indexOf('.side-head') >= 0 ? [topbar, sideHead] : []
  );
  document.body = makeElement('body');
  document.documentElement = makeElement('html');
  document.createElement = (tag) => makeElement('<' + tag + '>');
  document.readyState = 'complete';

  const window = {
    innerWidth: 1360,
    innerHeight: 860,
    listeners: [],
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    removeEventListener() {},
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    matchMedia() { return { matches: false, addEventListener() {} }; },
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    location: { search: '', href: 'https://codexgui.local/index.html' },
    chrome: {
      webview: {
        addEventListener(type, fn) { webviewListeners.push({ type, fn }); },
        postMessage(msg) { sent.push(msg); },
      },
    },
  };
  window.document = document;
  window.window = window;
  window.__CODEX_BOOT__ = Object.assign({ config: {}, dark: true }, bootFlags);

  const sandbox = {
    window,
    document,
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
    location: window.location,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: window.requestAnimationFrame,
    MouseEvent: function MouseEvent(type, props) { return makeEvent(type, props); },
    console, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    URLSearchParams, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MD_JS, 'utf8'), sandbox, { filename: 'md.js' });
  vm.runInContext('globalThis.MD = window.MD;', sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });
  docListeners.filter((l) => l.type === 'DOMContentLoaded').forEach((l) => l.fn({ type: 'DOMContentLoaded' }));

  return {
    sent,
    document,
    topbar,
    sideHead,
    /** deliver a host -> page message */
    host(msg) {
      webviewListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({ data: msg }));
    },
    /** evaluate an expression inside the page context (e.g. app state) */
    evalIn(expr) { return vm.runInContext(expr, sandbox); },
    /** last message of a given type that the page sent to the host */
    lastSent(type) {
      for (let i = sent.length - 1; i >= 0; i--) {
        if (sent[i] && sent[i].t === type) return sent[i];
      }
      return null;
    },
    fireDocMousedown(x, y) {
      docListeners
        .filter((l) => l.type === 'mousedown' && l.capture)
        .forEach((l) => l.fn(makeEvent('mousedown', { clientX: x, clientY: y, target: makeElement('page') })));
    },
  };
}

module.exports = { createApp, makeElement, makeEvent };
