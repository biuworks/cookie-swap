import { expiredCookieCount, expirationTimes, identityEntries, matchActiveProfileId } from "./cookies.js";

export const PROFILE_KEY = "profiles";

/** 删除后 6 秒内可以撤销。超时由 sweepUndo 清掉被孤立的 capture。 */
export const UNDO_KEY = "pendingUndo";
export const UNDO_TTL_MS = 6_000;

export function captureKey(id) {
  return `capture:${id}`;
}

export function toListRecord(profile, now = profile?.savedAt) {
  return {
    id: profile.id,
    name: profile.name,
    siteKey: profile.siteKey,
    origin: profile.origin,
    hostLabel: profile.hostLabel,
    savedAt: now,
    cookieCount: profile.cookies?.length || 0,
    storageCount: Object.keys(profile.localStorage || {}).length + Object.keys(profile.sessionStorage || {}).length,
    expiryTimes: expirationTimes(profile.cookies),
    identity: identityEntries(profile),
  };
}

export const MAX_CAPTURE_BYTES = 8_000_000;

export function normalizeName(name) {
  const trimmed = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!trimmed) throw new Error("先给这个账号起个名字");
  if ([...trimmed].length > 40) throw new Error("名字最多 40 个字");
  return trimmed;
}

export function assertCapturable(capture) {
  const cookieCount = capture.cookies?.length || 0;
  const localCount = Object.keys(capture.localStorage || {}).length;
  const sessionCount = Object.keys(capture.sessionStorage || {}).length;
  if (cookieCount + localCount + sessionCount === 0) {
    throw new Error("这个页面没有 Cookie 或 localStorage / sessionStorage。只放在 IndexedDB 或内存里的登录态，这次还抓不到。");
  }
}

export function captureByteSize(capture) {
  return new TextEncoder().encode(JSON.stringify({
    cookies: capture.cookies,
    localStorage: capture.localStorage,
    sessionStorage: capture.sessionStorage,
  })).length;
}

export function assertCaptureSize(capture) {
  if (captureByteSize(capture) > MAX_CAPTURE_BYTES) {
    throw new Error("这份登录态太大（超过 8MB），没有保存");
  }
}

export function upsertProfile(profiles, draft, now = Date.now()) {
  const existing = profiles.find((item) => item.siteKey === draft.siteKey && item.name === draft.name);
  const profile = toListRecord({ ...draft, id: existing?.id ?? draft.id }, now);
  return [profile, ...profiles.filter((item) => item.id !== profile.id)];
}

export function replaceProfile(profiles, id, draft, now = Date.now()) {
  const existing = profiles.find((item) => item.id === id);
  if (!existing) throw new Error("找不到这个账号快照");
  if (existing.siteKey !== draft.siteKey) throw new Error("当前网站和这个快照不是同一个域名");
  const profile = toListRecord({
    ...draft,
    id,
    name: existing.name,
    siteKey: existing.siteKey,
  }, now);
  return [profile, ...profiles.filter((item) => item.id !== id)];
}

/**
 * 「用当前登录态更新某个快照」只允许作用于当前正在使用的那个账号。
 *
 * 读的是当前页面的登录态，所以一旦允许指定别的快照，A 账号的会话就会被
 * 写进 B 账号的快照里，而且没有任何提示。测试里对这条不变量有覆盖。
 */
export function assertUpdatable(activeId, profileId) {
  if (!profileId) throw new Error("找不到这个账号快照");
  if (activeId !== profileId) {
    throw new Error("只能更新当前正在使用的账号。先切换到它，再更新。");
  }
}

/**
 * 判断「当前页面正在使用哪个快照」。
 *
 * 页面能读出身份信息时，只认真正对得上的那个；对不上就说明这是个还没保存过的
 * 登录态，不能拿「上次切换过的账号」来顶替 —— 那个 hint 会过期。手动登出再登成
 * 另一个账号时，hint 还停在旧账号上；如果据此认为旧账号就是"正在使用"，
 * 一次「更新」就会把它整份覆盖掉。
 *
 * 只有页面完全读不出身份信息时（未登录），hint 才是唯一线索，才允许兜底。
 */
export function resolveActiveId({ confirmedId = null, hasIdentity = false, hinted = null } = {}) {
  if (confirmedId) return confirmedId;
  return hasIdentity ? null : hinted;
}

export function summarizeProfile(profile, activeId, now = Date.now()) {
  return {
    id: profile.id,
    name: profile.name,
    savedAt: profile.savedAt,
    origin: profile.origin,
    hostLabel: profile.hostLabel,
    cookieCount: profile.cookieCount || 0,
    storageCount: profile.storageCount || 0,
    expiredCount: expiredCookieCount(profile.expiryTimes, now),
    active: profile.id === activeId,
  };
}

/* ---------------- 删除撤销 ----------------
   删除时只把记录从索引里摘掉，capture 原样留着；撤销就是把记录放回去，
   所以不需要复制那份可能有好几 MB 的数据。代价是索引里没了的 capture
   会短暂成为孤儿，由 sweepUndo 在超时后清理。
*/

export function stashUndo(map, profile, now = Date.now()) {
  return { ...(map || {}), [profile.id]: { profile, at: now } };
}

/** 取出并移除一条撤销记录。超过时限的返回 null（同时也会被移除）。 */
export function takeUndo(map, id, now = Date.now()) {
  const entry = map?.[id];
  const next = { ...(map || {}) };
  delete next[id];
  if (!entry || typeof entry.at !== "number" || now - entry.at > UNDO_TTL_MS) {
    return { profile: null, map: next };
  }
  return { profile: entry.profile, map: next };
}

/** 找出已经超时、可以彻底清理的撤销记录 id。 */
export function staleUndoIds(map, now = Date.now()) {
  return Object.entries(map || {})
    .filter(([, entry]) => !entry || typeof entry.at !== "number" || now - entry.at > UNDO_TTL_MS)
    .map(([id]) => id);
}

export function dropUndo(map, ids) {
  const next = { ...(map || {}) };
  for (const id of ids) delete next[id];
  return next;
}

function hasLoginState(capture) {
  return (capture.cookies?.length || 0) > 0
    || Object.keys(capture.localStorage || {}).length > 0
    || Object.keys(capture.sessionStorage || {}).length > 0;
}

export function blankPlan(capture, profiles) {
  if (!hasLoginState(capture)) return "clear";
  const siteProfiles = (profiles || []).filter((profile) => profile.siteKey === capture.siteKey);
  if (siteProfiles.length === 0) return "save-first";
  if (matchActiveProfileId(capture, siteProfiles)) return "clear";
  return "confirm";
}

export function saveHint(name, profiles) {
  let normalized = "";
  try {
    normalized = normalizeName(name);
  } catch {
    return "";
  }
  return profiles.some((profile) => profile.name === normalized) ? `将覆盖「${normalized}」` : "";
}

export async function readProfiles() {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  return Array.isArray(stored[PROFILE_KEY]) ? stored[PROFILE_KEY] : [];
}

export async function writeProfiles(profiles) {
  await chrome.storage.local.set({ [PROFILE_KEY]: profiles });
}

export async function readProfileCapture(id) {
  const key = captureKey(id);
  const stored = await chrome.storage.local.get(key);
  const capture = stored[key];
  if (!capture || !Array.isArray(capture.cookies)) return null;
  return {
    cookies: capture.cookies,
    localStorage: capture.localStorage || {},
    sessionStorage: capture.sessionStorage || {},
  };
}

export async function removeProfileCapture(id) {
  await chrome.storage.local.remove(captureKey(id));
}

export async function commitProfile(index, id, capture) {
  await chrome.storage.local.set({
    [PROFILE_KEY]: index,
    [captureKey(id)]: {
      cookies: capture.cookies || [],
      localStorage: capture.localStorage || {},
      sessionStorage: capture.sessionStorage || {},
    },
  });
}
