import { pageOrigin, readPageTarget } from "./domain.js";
import {
  cookieBelongsToSite,
  cookiesForRestore,
  IDENTITY_AUTH_SOURCE,
  IDENTITY_NOISE_SOURCE,
  identityEntries,
  matchActiveProfileId,
  mergeCookies,
  needsFullIdentityStorage,
  toCookieRemoveDetails,
  toCookieSetDetails,
  toSnapshot,
} from "./cookies.js";
import { readIdentityStorage, readPageStorage, readUnsubmittedInput, writePageStorage } from "./page-storage.js";
import {
  assertCapturable,
  assertCaptureSize,
  assertUpdatable,
  blankPlan,
  commitProfile,
  dropUndo,
  normalizeName,
  readProfileCapture,
  readProfiles,
  removeProfileCapture,
  replaceProfile,
  resolveActiveId,
  staleUndoIds,
  stashUndo,
  summarizeProfile,
  takeUndo,
  UNDO_KEY,
  upsertProfile,
  writeProfiles,
} from "./profiles.js";
import { runSwitch } from "./swap.js";

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
    return [];
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
    cookies,
    localStorage: storage.localStorage,
    sessionStorage: storage.sessionStorage,
  };
}

async function validatedCapture(tab) {
  const capture = await readCapture(tab);
  assertCapturable(capture);
  assertCaptureSize(capture);
  return capture;
}

async function profilesFor(tab) {
  const target = readPageTarget(tab.url || "");
  if (!target.ok) return { target, profiles: [] };
  const profiles = (await readProfiles())
    .filter((profile) => profile.siteKey === target.siteKey)
    .sort((left, right) => right.savedAt - left.savedAt);
  return { target, profiles };
}

function siteView(target, profiles, activeId, now = Date.now(), loggedIn = true) {
  const visible = profiles
    .filter((profile) => profile.siteKey === target.siteKey)
    .sort((left, right) => right.savedAt - left.savedAt);
  return {
    phase: "ready",
    siteKey: target.siteKey,
    hostLabel: target.hostLabel,
    origin: target.origin,
    loggedIn,
    profiles: visible.map((profile) => summarizeProfile(profile, activeId, now)),
  };
}

async function buildView(tab, activeId) {
  const { target, profiles } = await profilesFor(tab);
  if (!target.ok) return { phase: "unsupported", reason: target.reason };
  return siteView(target, profiles, activeId);
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

async function readLoginIdentity(tab, target) {
  const [cookies, storage] = await Promise.all([
    getStoreIdForTab(tab.id)
      .then((storeId) => collectCookies(target.siteKey, tab.url, storeId))
      .then((found) => found.map(toSnapshot))
      .catch(() => null),
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readIdentityStorage,
      args: [IDENTITY_AUTH_SOURCE, IDENTITY_NOISE_SOURCE],
    }).then((injections) => {
      const result = injections?.[0]?.result;
      if (!result || result.origin !== target.origin) return null;
      return result;
    }).catch(() => null),
  ]);

  const cookieList = cookies || [];
  let localStorage = storage?.localStorage || {};
  if (needsFullIdentityStorage({ cookies: cookieList, localStorage }, storage?.otherKeys || 0)) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: readPageStorage,
      });
      const full = injection?.result;
      if (full?.origin === target.origin) localStorage = full.localStorage || {};
    } catch {
      // Auth cookies and auth storage keys are still enough to identify the account.
    }
  }
  if (!cookies && !storage) return null;
  return { cookies: cookieList, localStorage };
}

/**
 * 一次读出「当前页面登录着没有」和「登录着的话是哪个快照」。
 *
 * 这两件事必须一起判断：没有任何匹配快照时，既可能是页面根本没登录，
 * 也可能是登录着一个还没保存过的账号 —— 界面上这两种情况的下一步完全不同
 * （前者要「登录新账号」，后者要「保存当前登录」）。
 */
async function readLoginState(tab, target, profiles, hintId) {
  const hinted = hintId && profiles.some((profile) => profile.id === hintId) ? hintId : null;
  let capture = null;
  try {
    capture = await readLoginIdentity(tab, target);
  } catch {
    capture = null;
  }
  if (!capture) return { activeId: hinted, confirmedId: null, loggedIn: false };
  const loggedIn = (capture.cookies?.length || 0) > 0
    || Object.keys(capture.localStorage || {}).length > 0;
  const hasIdentity = identityEntries(capture).length > 0;
  // 传入 null 当 hint：只有真的按身份信息匹配上才会返回非空，
  // 于是"上次切换过的账号"不会冒充成"正在使用"。
  const confirmedId = matchActiveProfileId(capture, profiles, null);
  return {
    activeId: resolveActiveId({ confirmedId, hasIdentity, hinted }),
    confirmedId,
    loggedIn,
  };
}

async function inspect(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const { target, profiles } = await profilesFor(tab);
  if (!target.ok) return { phase: "unsupported", reason: target.reason };
  await sweepUndo();
  const hintId = await readActiveHint(target.siteKey);
  const { activeId, confirmedId, loggedIn } = await readLoginState(tab, target, profiles, hintId);
  // 对不上就顺手把过期的 hint 清掉，别让它一直留着误导下一次判断
  if (confirmedId !== hintId) await writeActiveHint(target.siteKey, confirmedId);
  return siteView(target, profiles, activeId, Date.now(), loggedIn);
}

async function saveProfile(tab, name) {
  const label = normalizeName(name);
  const capture = await validatedCapture(tab);
  const profiles = await readProfiles();
  const overwritten = profiles.some((profile) => profile.siteKey === capture.siteKey && profile.name === label);
  const next = upsertProfile(profiles, { ...capture, name: label, id: crypto.randomUUID() });
  await commitProfile(next, next[0].id, capture);
  await writeActiveHint(capture.siteKey, next[0].id);
  return {
    view: siteView(capture, next, next[0].id),
    effect: {
      type: "saved",
      name: label,
      overwritten,
      cookieCount: capture.cookies.length,
      storageCount: Object.keys(capture.localStorage || {}).length
        + Object.keys(capture.sessionStorage || {}).length,
    },
  };
}

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

/**
 * 用当前页面的登录态覆盖一个已有快照。
 *
 * 只有「当前正在使用的那个账号」才允许被覆盖：updateProfile 读的是当前页面的
 * 登录态，如果允许指定任意快照，就会把 A 账号的会话写进 B 账号的快照里，
 * 而且没有任何提示。所以这里要求目标快照必须就是当前激活账号。
 */
async function updateProfile(tab, profileId) {
  const profiles = await readProfiles();
  const existing = profiles.find((profile) => profile.id === profileId);
  if (!existing) throw new Error("找不到这个账号快照");
  const target = readPageTarget(tab.url || "");
  if (!target.ok) throw new Error(target.reason);
  const siteProfiles = profiles.filter((profile) => profile.siteKey === target.siteKey);
  const hintId = await readActiveHint(target.siteKey);
  const { activeId } = await readLoginState(tab, target, siteProfiles, hintId);
  assertUpdatable(activeId, profileId);

  const capture = await validatedCapture(tab);
  const next = replaceProfile(profiles, profileId, capture);
  await commitProfile(next, profileId, capture);
  await writeActiveHint(capture.siteKey, profileId);
  return {
    view: siteView(capture, next, profileId),
    effect: { type: "updated", name: existing.name },
  };
}

async function deleteProfile(tab, profileId) {
  const profiles = await readProfiles();
  const existing = profiles.find((profile) => profile.id === profileId);
  if (!existing) throw new Error("找不到这个账号快照");
  await sweepUndo();
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

  const current = await chrome.tabs.get(tab.id);
  await writeActiveHint(capture.siteKey, null);
  return {
    view: await buildView(current, null),
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
  const stored = { ...profile, ...capture };
  const storeId = await getStoreIdForTab(tab.id);
  const result = await runSwitch({
    tab,
    profile: stored,
    storeId,
    applyCookies,
    writeStorage,
    reload: (tabId) => chrome.tabs.reload(tabId),
    navigate: navigateToOrigin,
    getTab: (tabId) => chrome.tabs.get(tabId),
  });
  const current = await chrome.tabs.get(tab.id);
  const landed = readPageTarget(current.url || "");
  await writeActiveHint(stored.siteKey, stored.id);
  return {
    view: siteView(landed.ok ? landed : stored, profiles, stored.id),
    effect: {
      type: "switched",
      name: profile.name,
      failedCount: result.failedCount,
      navigated: result.navigated,
    },
  };
}

async function mutate(message) {
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
  if (message.type === "update") return updateProfile(tab, message.profileId);
  if (message.type === "switch") {
    return switchProfile(tab, message.profileId, Boolean(message.confirmed));
  }
  if (message.type === "fresh") return startFreshLogin(tab, Boolean(message.confirmed));
  throw new Error("无效请求");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const task = message?.type === "inspect"
    ? inspect(message.tabId)
    : enqueue(() => mutate(message));
  task
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || "操作失败" }));
  return true;
});
