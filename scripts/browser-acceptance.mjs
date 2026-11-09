/**
 * Real Chrome extension API regression checks against synthetic, intercepted sites.
 * Start an EMPTY, isolated Chrome for Testing with this extension, then pass its
 * browser WebSocket URL. No account credentials or website network responses are used.
 * agent-browser drives the browser; CDP supplements its missing worker/API controls.
 * This script refuses existing snapshots and closes only the tabs it creates.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const endpoint = process.argv[2];
if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d+\/devtools\/browser\//.test(endpoint || '')) {
  throw new Error('Usage: node scripts/browser-acceptance.mjs ws://127.0.0.1:PORT/devtools/browser/ID (isolated browser only)');
}
const socket = new WebSocket(endpoint);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let serial = 0;
const pending = new Map(); const handlers = new Map(); const created = [];
socket.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id) {
    const request = pending.get(msg.id); if (!request) return;
    pending.delete(msg.id); clearTimeout(request.timer);
    if (msg.error) request.reject(new Error(msg.error.message)); else request.resolve(msg.result);
  } else for (const fn of handlers.get(`${msg.sessionId || ''}:${msg.method}`) || []) fn(msg.params);
};
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
const on = (session, method, fn) => {
  const key = `${session}:${method}`;
  handlers.set(key, [...(handlers.get(key) || []), fn]);
};
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 7000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch { /* Page/worker may be restarting. */ }
    await delay(75);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
}
async function evaluate(session, expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function target(url = 'about:blank') {
  const { targetId } = await call('Target.createTarget', { url, background: true });
  created.push(targetId);
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}
let control;
const api = expression => evaluate(control.sessionId, expression);
const send = message => api(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
async function request(message) {
  const response = await send(message); assert.equal(response?.ok, true, response?.error);
  return response;
}
const data = key => api(`chrome.storage.local.get(${JSON.stringify(key)}).then(v=>v[${JSON.stringify(key)}])`);
const capture = id => data(`capture:${id}`);
const backup = id => data(`protectedBackup:${id}`);
const token = (value, name) => value.cookies.find(c => c.name === name)?.value;
const page = (tab, fn, ...args) => api(`chrome.scripting.executeScript({target:{tabId:${tab.tabId}},func:${fn.toString()},args:${JSON.stringify(args)}}).then(r=>r[0])`);
async function site(host) {
  const t = await target(); const contexts = new Map();
  on(t.sessionId, 'Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
  on(t.sessionId, 'Runtime.executionContextsCleared', () => contexts.clear());
  await call('Runtime.enable', {}, t.sessionId);
  on(t.sessionId, 'Fetch.requestPaused', event => {
    call('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from('<!doctype html><meta charset="utf-8"><title>Cookie Swap isolated fixture</title><h1>Synthetic account fixture</h1><textarea aria-label="Draft"></textarea>').toString('base64'),
    }, t.sessionId).catch(() => {});
  });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, t.sessionId);
  const origin = `https://${host}`;
  const url = `${origin}/fixture?case=${t.targetId}`;
  await call('Page.navigate', { url }, t.sessionId);
  const tab = await until(() => api(`chrome.tabs.query({}).then(t=>t.find(v=>v.url===${JSON.stringify(url)}&&v.status==='complete'))`), `open ${host}`);
  return { ...t, tabId: tab.id, origin, host, contexts };
}
const putCookie = (tab, name, value) => api(`chrome.cookies.set(${JSON.stringify({
  url: `${tab.origin}/`, domain: `.${tab.host}`, path: '/', secure: true, httpOnly: true,
  expirationDate: 2100000000, name, value,
})})`);
const storage = (tab, value) => page(tab, value => {
  localStorage.setItem('fixture', value); sessionStorage.setItem('fixture', value);
}, value);
const flush = tab => page(tab, () => window.dispatchEvent(new Event('pagehide')));
const observer = tab => page(tab, () => globalThis.__cookieSwapStorageObserverV2?.context);
let passed = 0;
const pass = name => { passed++; console.log(`PASS ${name}`); };

try {
  const workers = (await call('Target.getTargets')).targetInfos;
  const worker = workers.find(t => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  const extensionId = worker?.url.split('/')[2] || process.argv[3];
  assert.match(extensionId || '', /^[a-p]{32}$/, 'Pass the extension ID when its service worker is asleep');
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const workerUrl = `${extensionOrigin}/src/background.js`;
  control = await target(`${extensionOrigin}/src/popup.html`);
  await call('Target.activateTarget', { targetId: control.targetId });
  await until(() => api('Boolean(globalThis.chrome?.runtime?.id)'), 'extension controller');
  assert.equal(await api('chrome.runtime.getManifest().name'), '账号快照');
  assert.equal((await data('profiles') || []).length, 0, 'Refusing a browser that already has account snapshots');
  await api('chrome.storage.local.set({onboarded:true})');
  const github = await site('github.com');
  await putCookie(github, 'dotcom_user', 'alice-fixture');
  await putCookie(github, 'user_session', 'fixture-A1');
  await storage(github, 'A-initial');
  const saved = await request({ type: 'save', tabId: github.tabId, name: 'Fixture A' });
  const id = saved.view.boundProfileId;
  assert.equal(saved.view.currentProfileId, id); assert.equal(saved.view.autoRefreshEnabled, true);
  const fixed = await backup(id);
  assert.equal(fixed.source, 'initial-save'); assert.equal(fixed.capture.localStorage.fixture, 'A-initial');
  await until(async () => (await observer(github)).result?.generation, 'observer in already-open page');
  await storage(github, 'A-first-pagehide');
  await call('Page.reload', {}, github.sessionId);
  await until(async () => (await capture(id)).localStorage.fixture === 'A-first-pagehide', 'first document pagehide flush');
  await until(async () => (await observer(github)).result?.generation, 'observer after first navigation');
  pass('first save observes the already-open document and native pagehide flushes on its first reload');

  await api(`chrome.scripting.executeScript({target:{tabId:${github.tabId}},files:['src/page-hide.js']})`);
  await api(`chrome.scripting.executeScript({target:{tabId:${github.tabId}},files:['src/page-hide.js']})`);
  const isolated = [...github.contexts.values()].find(c => c.origin === extensionOrigin || c.name.includes(extensionId));
  assert.ok(isolated, `extension isolated execution context: ${JSON.stringify([...github.contexts.values()])}`);
  const win = await call('Runtime.evaluate', { expression: 'window', contextId: isolated.id }, github.sessionId);
  const listeners = await call('DOMDebugger.getEventListeners', { objectId: win.result.objectId }, github.sessionId);
  assert.equal(listeners.listeners.filter(l => l.type === 'pagehide').length, 1);
  pass('repeated injection installs one pagehide listener');

  for (const value of ['fixture-A2', 'fixture-A3']) {
    await putCookie(github, 'user_session', value);
    await until(async () => token(await capture(id), 'user_session') === value, `auto rotate ${value}`);
    assert.deepEqual(await backup(id), fixed);
  }
  pass('multiple real cookies.onChanged rotations update current and preserve protected backup');

  const second = await site('github.com');
  await page(second, () => sessionStorage.setItem('fixture', 'other-tab'));
  await flush(second); await delay(150);
  assert.equal((await capture(id)).sessionStorage.fixture, 'A-first-pagehide');
  const previousDoc = (await page(github, () => location.origin)).documentId;
  const previousContext = (await observer(github)).result;
  await call('Page.reload', {}, github.sessionId);
  await until(async () => {
    const value = await observer(github);
    return value.documentId !== previousDoc && value.result?.generation;
  }, 'source navigation reauthorization');
  await storage(github, 'A-after-navigation'); await flush(github);
  await until(async () => (await capture(id)).localStorage.fixture === 'A-after-navigation', 'new document storage');
  pass('other tabs cannot write sessionStorage; source-tab navigation reauthorizes its new document');

  await putCookie(github, 'dotcom_user', 'bob-fixture');
  await putCookie(github, 'user_session', 'fixture-B1');
  await until(async () => (await data('refreshState')).bindings['["github.com","0"]']?.paused, 'cross-account pause');
  const blocked = await send({ type: 'update', tabId: github.tabId, profileId: id });
  assert.equal(blocked.ok, false);
  await storage(github, 'B-live'); await flush(github); await delay(100);
  assert.equal(token(await capture(id), 'user_session'), 'fixture-A3');
  assert.deepEqual(await backup(id), fixed);
  const changedView = (await request({ type: 'inspect', tabId: github.tabId })).view;
  assert.equal(changedView.currentProfileId, null); assert.equal(changedView.canUpdate, false);
  pass('cross-account cookies and pagehide never overwrite A; UI view no longer calls A current');

  await request({ type: 'restore-protected-backup', tabId: github.tabId, profileId: id });
  assert.equal((await capture(id)).localStorage.fixture, 'A-initial');
  assert.equal(token(await capture(id), 'user_session'), 'fixture-A1');
  assert.equal((await page(github, () => localStorage.fixture)).result, 'B-live');
  assert.equal((await api(`chrome.cookies.get({url:${JSON.stringify(github.origin)},name:'user_session'})`)).value, 'fixture-B1');
  const versions = new Map();
  on(control.sessionId, 'ServiceWorker.workerVersionUpdated', ({ versions: list }) => list.forEach(v => versions.set(v.versionId, v)));
  await call('ServiceWorker.enable', {}, control.sessionId);
  const version = await until(() => [...versions.values()].find(v => v.scriptURL === workerUrl && v.runningStatus === 'running'), 'worker version');
  await call('ServiceWorker.stopWorker', { versionId: version.versionId }, control.sessionId);
  const restarted = (await request({ type: 'inspect', tabId: github.tabId })).view;
  assert.equal(restarted.status, 'recovered'); assert.equal(restarted.autoRefreshEnabled, false);
  await putCookie(github, 'user_session', 'fixture-B2'); await flush(github); await delay(1800);
  assert.equal(token(await capture(id), 'user_session'), 'fixture-A1');
  pass('restore changes snapshot only; durable pause survives actual service-worker termination');

  const switched = await request({ type: 'switch', tabId: github.tabId, profileId: id, confirmed: true });
  assert.equal(switched.view.autoRefreshEnabled, true);
  assert.equal((await page(github, () => localStorage.fixture)).result, 'A-initial');
  await page(github, old => chrome.runtime.sendMessage({ type: 'flush-storage', ...old,
    localStorage: { fixture: 'stale' }, sessionStorage: { fixture: 'stale' } }), previousContext);
  await delay(100);
  assert.equal((await capture(id)).localStorage.fixture, 'A-initial');
  assert.deepEqual(await backup(id), fixed);
  pass('explicit switch applies restored capture and rejects stale generation messages');

  await request({ type: 'delete', tabId: github.tabId, profileId: id });
  await request({ type: 'restore', tabId: github.tabId, profileId: id });
  await storage(github, 'A-live-without-binding');
  const unboundRecovery = await request({ type: 'restore-protected-backup', tabId: github.tabId, profileId: id });
  assert.equal(unboundRecovery.view.boundProfileId, null);
  assert.equal(unboundRecovery.view.currentProfileId, id);
  assert.equal((await page(github, () => localStorage.fixture)).result, 'A-live-without-binding');
  await api(`chrome.tabs.update(${github.tabId},{active:true})`);
  await call('Page.reload', {}, control.sessionId);
  const applySelector = `[data-act="switch"][data-id="${id}"]`;
  await until(() => api(`Boolean(document.querySelector(${JSON.stringify(applySelector)}))`), 'current snapshot apply button without binding');
  await api(`document.querySelector(${JSON.stringify(applySelector)}).click()`);
  await until(async () => (await page(github, () => localStorage.fixture)).result === 'A-initial', 'apply restored unbound current snapshot');
  pass('delete undo plus backup restore still allows the current snapshot to be applied through the popup');

  const unknown = await site('unknown.example.test');
  await storage(unknown, 'unknown-v1');
  const u = await request({ type: 'save', tabId: unknown.tabId, name: 'Unknown fixture' });
  const uid = u.view.boundProfileId;
  assert.equal(u.view.currentProfileId, null); assert.equal(u.view.canConfirmUpdate, true);
  assert.equal(u.view.loggedIn, true); assert.equal(u.view.autoRefreshEnabled, false);
  await storage(unknown, 'unknown-v2');
  const first = await request({ type: 'update', tabId: unknown.tabId, profileId: uid });
  assert.equal(first.needsConfirm, true);
  await storage(unknown, 'unknown-v3');
  const stale = await request({ type: 'update', tabId: unknown.tabId, profileId: uid, confirmationToken: first.confirm.token });
  assert.equal(stale.needsConfirm, true); assert.equal(stale.confirm.changed, true);
  const manual = await request({ type: 'update', tabId: unknown.tabId, profileId: uid, confirmationToken: stale.confirm.token });
  assert.equal(manual.view.autoRefreshEnabled, false);
  assert.equal((await capture(uid)).localStorage.fixture, 'unknown-v3');
  assert.equal((await backup(uid)).capture.localStorage.fixture, 'unknown-v1');
  await putCookie(unknown, 'sid', 'unknown-next'); await delay(1800);
  assert.equal((await capture(uid)).cookies.length, 0);
  pass('storage-only unknown site requires exact one-time confirmation and remains manual');

  // The popup page runs in the background while its actual target tab is active.
  // This uses its production click handlers, tabs.query and runtime.sendMessage.
  await api(`chrome.tabs.update(${unknown.tabId},{active:true})`);
  await call('Page.reload', {}, control.sessionId);
  await until(() => api('document.querySelector(\'[data-act="update"]\')?.textContent.includes("确认更新")'), 'popup unknown-account UI');
  assert.equal(await api('document.getElementById("body").textContent.includes("使用中")'), false);
  assert.match(await api('document.querySelector("#foot .primary").textContent'), /另存为新账号/);
  await storage(unknown, 'unknown-v4');
  await api('document.querySelector(\'[data-act="update"]\').click()');
  await until(() => api('!document.getElementById("sheet").hidden'), 'popup confirmation');
  assert.equal(await api('document.activeElement.dataset.act'), 'sheet-cancel');
  if (process.argv[4]) {
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, control.sessionId);
    await writeFile(process.argv[4], Buffer.from(screenshot.data, 'base64'));
  }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }, control.sessionId);
  assert.equal(await api('document.getElementById("sheet").hidden'), true);
  assert.equal((await capture(uid)).localStorage.fixture, 'unknown-v3');
  await api('document.querySelector(\'[data-act="update"]\').click()');
  await until(() => api('!document.getElementById("sheet").hidden'), 'reopened confirmation');
  await storage(unknown, 'unknown-v5');
  await api('document.querySelector(\'[data-act="sheet-ok"]\').click()');
  await until(() => api('document.getElementById("sheet").textContent.includes("内容已变化")'), 'changed content asks again');
  assert.equal((await capture(uid)).localStorage.fixture, 'unknown-v3');
  await api('document.querySelector(\'[data-act="sheet-ok"]\').click()');
  await until(async () => (await capture(uid)).localStorage.fixture === 'unknown-v5', 'confirmed popup update');
  assert.equal((await backup(uid)).capture.localStorage.fixture, 'unknown-v1');
  pass('real popup defaults to save-as, focuses Cancel, supports Escape and re-confirms changed content');

  for (const [host, idName, authName, accountA, accountB] of [
    ['bilibili.com', 'DedeUserID', 'SESSDATA', '10001', '10002'],
    ['x.com', 'twid', 'auth_token', 'u%3D10001', 'u%3D10002'],
    ['twitter.com', 'twid', 'auth_token', 'u%3D10001', 'u%3D10002'],
  ]) {
    const t = await site(host);
    await putCookie(t, idName, accountA); await putCookie(t, authName, 'fixture-token-1');
    await storage(t, 'fixture-storage');
    const r = await request({ type: 'save', tabId: t.tabId, name: `${host} fixture` });
    const sid = r.view.boundProfileId; assert.equal(r.view.autoRefreshEnabled, true);
    await putCookie(t, authName, 'fixture-token-2');
    await until(async () => token(await capture(sid), authName) === 'fixture-token-2', `${host} rotation`);
    await putCookie(t, idName, accountB); await putCookie(t, authName, 'fixture-other');
    await delay(1800); await flush(t); await delay(100);
    assert.equal(token(await capture(sid), authName), 'fixture-token-2');
    assert.equal((await request({ type: 'inspect', tabId: t.tabId })).view.canUpdate, false);
    pass(`${host} synthetic rule: same-account rotation accepted, different account blocked`);
  }
  console.log(JSON.stringify({ passed, scope: 'isolated Chrome; synthetic sites; real extension APIs', realWebsiteCompatibility: 'not tested' }));
} finally {
  for (const targetId of created.reverse()) await call('Target.closeTarget', { targetId }).catch(() => {});
  socket.close();
}
