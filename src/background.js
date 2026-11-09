import { pageOrigin, readPageTarget } from "./domain.js";
import {
  cookieBelongsToSite,
  cookiesForRestore,
  mergeCookies,
  toCookieRemoveDetails,
  toCookieSetDetails,
  toSnapshot,
} from "./cookies.js";
import { readPageStorage, readUnsubmittedInput, writePageStorage } from "./page-storage.js";
import {
  blankPlan,
  dropUndo,
  normalizeName,
  readProfileCapture,
  readProfiles,
  removeProfileCapture,
  staleUndoIds,
  stashUndo,
  takeUndo,
  UNDO_KEY,
  writeProfiles,
} from "./profiles.js";
import { runSwitch } from "./swap.js";
import { RefreshService } from "./refresh-service.js";

let chain = Promise.resolve();

function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function getStoreIdForTab(tabId) {
  const stores = await chrome.cookies.getAllCookieStores();
  const match = stores.find((store) => store.tabIds.includes(tabId));
  if (!match) throw new Error("找不到这个标签页的 Cookie 存储");
  return match.id;
}

async function safeGetAll(details) {
  try {
    return await chrome.cookies.getAll(details);
  } catch {
    throw new Error("读不到登录 Cookie，原快照已保留");
  }
}

async function collectCookies(siteKey, pageUrl, storeId) {
  const hostname = new URL(pageUrl).hostname;
  const groups = await Promise.all([
    safeGetAll({ domain: siteKey, storeId }),
    safeGetAll({ url: pageUrl, storeId }),
    hostname === siteKey ? Promise.resolve([]) : safeGetAll({ domain: hostname, storeId }),
  ]);
  return mergeCookies(groups).filter((cookie) => cookieBelongsToSite(cookie.domain, siteKey));
}

const COOKIE_BATCH = 8;

async function eachCookie(cookies, task) {
  if (cookies.length === 0) return;
  let index = 0;
  const workers = Array.from({ length: Math.min(COOKIE_BATCH, cookies.length) }, async () => {
    while (index < cookies.length) {
      const cookie = cookies[index];
      index += 1;
      await task(cookie);
    }
  });
  await Promise.all(workers);
}

async function removeCookies(cookies, storeId) {
  await eachCookie(cookies, async (cookie) => {
    try {
      await chrome.cookies.remove(toCookieRemoveDetails(cookie, storeId));
    } catch {
      // A cookie that is already gone should not stop the switch.
    }
  });
}

async function applyCookies(siteKey, pageUrl, storeId, nextCookies) {
  const current = await collectCookies(siteKey, pageUrl, storeId);
  const backup = current.map(toSnapshot);
  const next = cookiesForRestore(nextCookies);
  if (nextCookies.length > 0 && next.length === 0) {
    throw new Error("这份快照里的 Cookie 都过期了，没有切换");
  }

  await removeCookies(current, storeId);
  const failed = [];
  await eachCookie(next, async (cookie) => {
    try {
      await chrome.cookies.set(toCookieSetDetails(cookie, storeId));
    } catch {
      failed.push(cookie.name);
    }
  });

  async function rollback() {
    const live = await collectCookies(siteKey, pageUrl, storeId);
    await removeCookies(live, storeId);
    await eachCookie(backup, async (cookie) => {
      try {
        await chrome.cookies.set(toCookieSetDetails(cookie, storeId));
      } catch {
        // Best effort: the caller reports that the original cookies could not be restored.
      }
    });
  }

  if (next.length > 0 && failed.length === next.length) {
    await rollback();
    throw new Error("没能写回登录 Cookie，已尝试恢复切换前的状态");
  }
  return { failedCount: failed.length, rollback };
}

async function readCapture(tab) {
  const target = readPageTarget(tab.url || "");
  if (!target.ok) throw new Error(target.reason);
  const storeId = await getStoreIdForTab(tab.id);
  const cookies = (await collectCookies(target.siteKey, tab.url, storeId)).map(toSnapshot);
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPageStorage,
    });
  } catch {
    throw new Error("读不到这个页面的本地存储");
  }
  const storage = injection?.result;
  if (!storage || storage.origin !== target.origin) {
    throw new Error("读到的本地存储和当前页面对不上");
  }
  return {
    siteKey: target.siteKey,
    origin: target.origin,
    hostLabel: target.hostLabel,
    documentId: injection.documentId,
    storeId,
    cookies,
    localStorage: storage.localStorage,
    sessionStorage: storage.sessionStorage,
  };
}

const ACTIVE_KEY = "activeBySite";

async function readActiveHint(siteKey) {
  const stored = await chrome.storage.local.get(ACTIVE_KEY);
  const map = stored[ACTIVE_KEY];
  return map && typeof map === "object" ? map[siteKey] || null : null;
}

async function writeActiveHint(siteKey, profileId) {
  const stored = await chrome.storage.local.get(ACTIVE_KEY);
  const map = { ...(stored[ACTIVE_KEY] && typeof stored[ACTIVE_KEY] === "object" ? stored[ACTIVE_KEY] : {}) };
  if (profileId) map[siteKey] = profileId;
  else delete map[siteKey];
  await chrome.storage.local.set({ [ACTIVE_KEY]: map });
}

/* ---------------- 删除撤销 ----------------
   删除时记录从索引里摘掉，capture 先留着；撤销就是把记录放回去。
   超时后由 sweepUndo 删掉那些孤儿 capture。
*/

async function readUndo() {
  const stored = await chrome.storage.local.get(UNDO_KEY);
  const map = stored[UNDO_KEY];
  return map && typeof map === "object" ? map : {};
}

async function writeUndo(map) {
  if (Object.keys(map).length === 0) {
    await chrome.storage.local.remove(UNDO_KEY);
    return;
  }
  await chrome.storage.local.set({ [UNDO_KEY]: map });
}

async function sweepUndo(now = Date.now()) {
  const map = await readUndo();
  const stale = staleUndoIds(map, now);
  if (stale.length === 0) return;
  // 撤销记录一律清掉，但只删那些确实已经不在索引里的孤儿 capture ——
  // 万一同一个 id 又回到了索引里，绝不能把它删掉。
  const live = new Set((await readProfiles()).map((profile) => profile.id));
  const orphans = stale.filter((id) => !live.has(id));
  await writeUndo(dropUndo(map, stale));
  await Promise.all(orphans.map((id) => removeProfileCapture(id).catch(() => {})));
}

async function inspect(tabId) {
  await refresh.ready;
  await sweepUndo();
  return refresh.inspect(await chrome.tabs.get(tabId));
}

async function saveProfile(tab, name) { return refresh.save(tab, name); }

async function renameProfile(tab, profileId, name) {
  const label = normalizeName(name);
  const profiles = await readProfiles();
  const existing = profiles.find((profile) => profile.id === profileId);
  if (!existing) throw new Error("找不到这个账号快照");
  const clash = profiles.some((profile) => profile.id !== profileId
    && profile.siteKey === existing.siteKey && profile.name === label);
  if (clash) throw new Error(`已经有一个叫「${label}」的账号了`);
  await writeProfiles(profiles.map((profile) => (
    profile.id === profileId ? { ...profile, name: label } : profile
  )));
  return {
    view: await inspect(tab.id),
    effect: { type: "renamed", name: label },
  };
}

async function deleteProfile(tab, profileId) {
  const profiles = await readProfiles();
  const existing = profiles.find((profile) => profile.id === profileId);
  if (!existing) throw new Error("找不到这个账号快照");
  await sweepUndo();
  await refresh.forget(profileId);
  await writeProfiles(profiles.filter((profile) => profile.id !== profileId));
  await writeUndo(stashUndo(await readUndo(), existing));
  if (existing.siteKey && (await readActiveHint(existing.siteKey)) === profileId) {
    await writeActiveHint(existing.siteKey, null);
  }
  return {
    view: await inspect(tab.id),
    effect: { type: "deleted", name: existing.name },
  };
}

/** 撤销删除：把记录放回索引，capture 一直还在原处。 */
async function restoreProfile(tab, profileId) {
  const { profile, map } = takeUndo(await readUndo(), profileId);
  if (!profile) throw new Error("撤销时间已过，这个快照已经删掉了");
  const profiles = await readProfiles();
  if (profiles.some((item) => item.id === profileId)) throw new Error("这个快照已经恢复过了");
  await writeProfiles([profile, ...profiles]);
  await writeUndo(map);
  await writeActiveHint(profile.siteKey, profileId);
  return {
    view: await inspect(tab.id),
    effect: { type: "restored", name: profile.name },
  };
}

function waitForOrigin(tabId, origin) {
  let settled = false;
  let resolvePromise = () => {};
  let rejectPromise = () => {};
  let interval = 0;
  let timeout = 0;
  const cleanup = () => {
    clearTimeout(timeout);
    clearInterval(interval);
    chrome.tabs.onUpdated.removeListener(listener);
  };
  const finish = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectPromise(error);
    else resolvePromise();
  };
  const listener = (id, info, updatedTab) => {
    if (id !== tabId || info.status !== "complete") return;
    if (pageOrigin(updatedTab?.url) === origin) finish();
  };
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    chrome.tabs.onUpdated.addListener(listener);
    interval = setInterval(() => {
      chrome.tabs.get(tabId).then((current) => {
        if (current.status === "complete" && pageOrigin(current.url) === origin) finish();
      }).catch((error) => finish(error));
    }, 250);
    timeout = setTimeout(() => finish(new Error("打开账号页面超时")), 20000);
  });
  return {
    promise,
    cancel() {
      finish();
    },
  };
}

async function navigateToOrigin(tabId, origin) {
  const pending = waitForOrigin(tabId, origin);
  pending.promise.catch(() => {});
  try {
    await chrome.tabs.update(tabId, { url: `${origin}/` });
    await pending.promise;
  } catch (error) {
    pending.cancel();
    throw error;
  }
}

async function writeStorage(tabId, payload) {
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: writePageStorage,
      args: [payload],
    });
  } catch {
    throw new Error("没能写入页面的本地存储");
  }
  if (!injection?.result?.ok) throw new Error("当前页面和快照不是同一个地址，没有改本地存储");
}

function waitForReload(tabId) {
  let settled = false;
  let sawLoading = false;
  let resolvePromise = () => {};
  let rejectPromise = () => {};
  let timeout = 0;
  const cleanup = () => {
    clearTimeout(timeout);
    chrome.tabs.onUpdated.removeListener(listener);
  };
  const finish = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectPromise(error);
    else resolvePromise();
  };
  const listener = (id, info) => {
    if (id !== tabId) return;
    if (info.status === "loading") sawLoading = true;
    if (info.status === "complete" && sawLoading) finish();
  };
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    chrome.tabs.onUpdated.addListener(listener);
    timeout = setTimeout(() => finish(new Error("页面刷新超时")), 20000);
  });
  return {
    promise,
    cancel() {
      finish();
    },
  };
}

async function clearStorageOnReload(tabId, origin) {
  const scriptId = `blank-${tabId}`;
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: scriptId,
    matches: [`${origin}/*`],
    js: ["src/blank-document.js"],
    runAt: "document_start",
    persistAcrossSessions: false,
  }]);
  const pending = waitForReload(tabId);
  pending.promise.catch(() => {});
  try {
    await chrome.tabs.reload(tabId);
    await pending.promise;
  } finally {
    pending.cancel();
    await chrome.scripting.unregisterContentScripts({ ids: [scriptId] }).catch(() => {});
  }
}

async function startFreshLogin(tab, confirmed) {
  const capture = await readCapture(tab);
  const plan = blankPlan(capture, await readProfiles());
  if (plan === "save-first") {
    throw new Error("先把当前账号添加上，再登录新账号。现在清空的话，这个登录态就找不回来了。");
  }
  if (plan === "confirm" && !confirmed) {
    return { needsConfirm: true };
  }

  const storeId = await getStoreIdForTab(tab.id);
  const lockKey = await refresh.beforeSwitch(tab, capture.siteKey);
  const applied = await applyCookies(capture.siteKey, tab.url, storeId, []);
  try {
    await clearStorageOnReload(tab.id, capture.origin);
  } catch {
    try {
      await applied.rollback();
      await writeStorage(tab.id, {
        origin: capture.origin,
        localStorage: capture.localStorage,
        sessionStorage: capture.sessionStorage,
      });
    } catch {
      throw new Error("没能清空页面，而且原来的登录态也没能恢复");
    }
    throw new Error("没能清空页面，原来的登录态已尽量恢复");
  }

  await refresh.pause(lockKey, "logged-out");
  const current = await chrome.tabs.get(tab.id);
  await writeActiveHint(capture.siteKey, null);
  return {
    view: await refresh.inspect(current),
    effect: { type: "fresh" },
  };
}

async function pageHasUnsubmittedInput(tab, target) {
  if (!target.ok) return false;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readUnsubmittedInput,
    });
    const result = injection?.result;
    if (!result || result.origin !== target.origin) return false;
    return Boolean(result.dirty);
  } catch {
    return false;
  }
}

async function switchProfile(tab, profileId, confirmed = false) {
  const profiles = await readProfiles();
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error("找不到这个账号快照");
  if (!confirmed) {
    const target = readPageTarget(tab.url || "");
    if (await pageHasUnsubmittedInput(tab, target)) {
      return { needsConfirm: true, confirm: { kind: "switch", name: profile.name } };
    }
  }
  const capture = await readProfileCapture(profile.id);
  if (!capture) throw new Error("找不到这个账号的登录态");
  const storeId = await getStoreIdForTab(tab.id);
  if (readPageTarget(tab.url).siteKey !== profile.siteKey) throw new Error("这个快照属于别的网站，没有切换");
  const key = await refresh.beforeSwitch(tab, profile.siteKey);
  let result;
  try {
    // The outgoing flush may update this same snapshot. Apply the committed version.
    const currentCapture = await readProfileCapture(profile.id);
    if (!currentCapture) throw new Error("找不到这个账号的登录态");
    const stored = { ...profile, ...currentCapture };
    result = await runSwitch({
      tab, profile: stored, storeId, applyCookies, writeStorage,
      reload: async (tabId) => {
        const pending = waitForReload(tabId);
        pending.promise.catch(() => {});
        try { await chrome.tabs.reload(tabId); await pending.promise; }
        finally { pending.cancel(); }
      },
      navigate: navigateToOrigin, getTab: (tabId) => chrome.tabs.get(tabId),
    });
    await refresh.afterSwitch(await chrome.tabs.get(tab.id), profile, result.failedCount);
  } catch (error) {
    await refresh.pause(key, 'interrupted');
    throw error;
  }
  const current = await chrome.tabs.get(tab.id);
  await writeActiveHint(profile.siteKey, profile.id);
  return {
    view: await refresh.inspect(current),
    effect: {
      type: "switched",
      name: profile.name,
      failedCount: result.failedCount,
      navigated: result.navigated,
    },
  };
}

async function mutate(message) {
  await refresh.ready;
  if (message.type === "delete" || message.type === "restore") {
    const tab = await chrome.tabs.get(message.tabId);
    return message.type === "delete"
      ? deleteProfile(tab, message.profileId)
      : restoreProfile(tab, message.profileId);
  }
  if (typeof message.tabId !== "number") throw new Error("找不到当前标签页");
  const tab = await chrome.tabs.get(message.tabId);
  if (message.type === "save") return saveProfile(tab, message.name);
  if (message.type === "rename") return renameProfile(tab, message.profileId, message.name);
  if (message.type === "update") return refresh.update(tab, message.profileId, message.confirmationToken);
  if (["rollback", "set-protected-backup", "restore-protected-backup"].includes(message.type)) {
    return refresh.backupAction(tab, message.profileId, message.type, message.confirmationToken);
  }
  if (message.type === "switch") {
    return switchProfile(tab, message.profileId, Boolean(message.confirmed));
  }
  if (message.type === "fresh") return startFreshLogin(tab, Boolean(message.confirmed));
  throw new Error("无效请求");
}

const refresh = new RefreshService({ api: chrome, enqueue, getStoreId: getStoreIdForTab, collectCookies, readCapture });
refresh.start().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const task = enqueue(async () => {
    await refresh.ready;
    if (message?.type === 'observer-ready' || message?.type === 'flush-storage') {
      return { observer: await refresh.observer(message, sender) };
    }
    // Page content scripts may only use the observer protocol.
    if (sender?.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) throw new Error('无效来源');
    return message?.type === 'inspect' ? { view: await inspect(message.tabId) } : mutate(message);
  });
  task.then(data => sendResponse({ ok: true, ...data }))
    .catch(error => sendResponse({ ok: false, error: error?.message || '操作失败' }));
  return true;
});
