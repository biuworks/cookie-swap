import { formatExpiryLabel, formatRefreshLabel, statusLabelFor } from "./format.js";

/**
 * 里程碑 1：当前绑定账号的 Cookie 写回，加上过期标记。
 * 不包含闲置号心跳，也不改请求头、不读响应头。
 *
 * 防抖：尾随 1.5s，从第一次变化起最长再等 3s，整次写回预算 5s。
 * 绑定只放 chrome.storage.local（见 REFRESH_STATE_KEY），不放 storage.session。
 */

export const TRAIL_MS = 1_500;
export const MAX_WAIT_MS = 3_000;
export const WRITEBACK_BUDGET_MS = 5_000;
export const REFRESH_STATE_KEY = "refreshState";
export const COOKIE_RULES_KEY = "cookieClassBySite";
export const STALE_BADGE_MS = 7 * 86_400_000;
export const EXPIRY_BADGE_MS = 3 * 86_400_000;

/** 内置规则只覆盖能同时指出「会轮换的认证 Cookie」和「稳定身份 Cookie」的站点。对不上就落到下一层。 */
export const BUILTIN_SITE_RULES = {
  "github.com": {
    auth: ["user_session", "__Host-user_session_same_site"],
    identity: ["logged_in", "dotcom_user"],
  },
  "bilibili.com": {
    auth: ["SESSDATA", "bili_jct"],
    identity: ["DedeUserID"],
  },
  "twitter.com": {
    auth: ["auth_token"],
    identity: ["twid"],
  },
  "x.com": {
    auth: ["auth_token"],
    identity: ["twid"],
  },
};

export const FLUSH_SCRIPT_ID = "storage-flush";

export function initialRefreshState(overrides = {}) {
  return {
    bindings: { ...(overrides.bindings || {}) },
    debounces: { ...(overrides.debounces || {}) },
    locks: { ...(overrides.locks || {}) },
    generations: { ...(overrides.generations || {}) },
    notices: { ...(overrides.notices || {}) },
    writeCount: overrides.writeCount || 0,
    unboundEvents: overrides.unboundEvents || 0,
  };
}

export function bindingFor(state, site) {
  return state?.bindings?.[site] || null;
}

export function siteLocked(state, site) {
  return state?.locks?.[site] === true;
}

function withoutKey(map, key) {
  const next = { ...(map || {}) };
  delete next[key];
  return next;
}

function generationFor(state, site) {
  const value = state.generations?.[site];
  return typeof value === "number" ? value : 0;
}

/**
 * 重启时只丢掉仍处于切换锁里的那个站点。其他站点的绑定原样留下。
 * 兼容旧的单 binding 结构：锁着就清那一个站，没锁就放进对应站点。
 */
export function hydrateRefreshState(saved) {
  if (!saved || typeof saved !== "object") return { state: initialRefreshState(), changed: false };
  const bindings = saved.bindings && typeof saved.bindings === "object" ? { ...saved.bindings } : {};
  const locks = saved.locks && typeof saved.locks === "object" ? { ...saved.locks } : {};
  const notices = saved.notices && typeof saved.notices === "object" ? { ...saved.notices } : {};
  const generations = saved.generations && typeof saved.generations === "object" ? { ...saved.generations } : {};

  if (saved.binding && typeof saved.binding === "object" && saved.binding.site && !bindings[saved.binding.site]) {
    if (saved.locked === true) locks[saved.binding.site] = true;
    else bindings[saved.binding.site] = saved.binding;
  }
  if (saved.notice?.site && !notices[saved.notice.site]) notices[saved.notice.site] = saved.notice;
  if (typeof saved.generation === "number" && saved.binding?.site && generations[saved.binding.site] == null) {
    generations[saved.binding.site] = saved.generation;
  }

  let changed = saved.locked === true || saved.binding != null;
  for (const site of Object.keys(locks)) {
    if (!locks[site]) {
      delete locks[site];
      continue;
    }
    if (bindings[site]) delete bindings[site];
    delete locks[site];
    changed = true;
  }
  return {
    state: initialRefreshState({ bindings, locks, notices, generations }),
    changed,
  };
}

export function flushScriptMatches(bindings) {
  const matches = [];
  for (const binding of Object.values(bindings || {})) {
    if (!binding?.snapshotId || !binding.origin) continue;
    let url;
    try {
      url = new URL(binding.origin);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const match = `${url.origin}/*`;
    if (!matches.includes(match)) matches.push(match);
  }
  matches.sort();
  return matches;
}

let flushScriptSignature = null;

export function resetFlushScriptCache() {
  flushScriptSignature = null;
}

/** 按当前绑定重注册页面关闭脚本。matches 没变就跳过；注册失败留在这里，不抛给弹窗。 */
export async function syncFlushScript(scripting, bindings) {
  const matches = flushScriptMatches(bindings);
  const signature = matches.join("\n");
  if (flushScriptSignature === signature) {
    return { matches, unregistered: matches.length === 0, skipped: true };
  }
  if (!scripting?.unregisterContentScripts && !scripting?.registerContentScripts) {
    return { matches, unregistered: matches.length === 0, skipped: false };
  }
  try {
    if (matches.length === 0) {
      if (scripting.unregisterContentScripts) {
        await scripting.unregisterContentScripts({ ids: [FLUSH_SCRIPT_ID] });
      }
      flushScriptSignature = signature;
      return { matches, unregistered: true, skipped: false };
    }
    if (scripting.unregisterContentScripts) {
      await scripting.unregisterContentScripts({ ids: [FLUSH_SCRIPT_ID] }).catch(() => {});
    }
    if (!scripting.registerContentScripts) {
      return { matches, unregistered: true, skipped: false };
    }
    await scripting.registerContentScripts([{
      id: FLUSH_SCRIPT_ID,
      matches,
      js: ["src/page-hide.js"],
      runAt: "document_start",
      persistAcrossSessions: true,
    }]);
    flushScriptSignature = signature;
    return { matches, unregistered: false, skipped: false };
  } catch {
    return { matches, unregistered: matches.length === 0, skipped: false, failed: true };
  }
}

/**
 * 等绑定从 storage 恢复后再判定这次 Cookie 变化。
 * `at` 由调用方在等待之前记下，防抖起点不跟着 hydrate 往后推。
 */
export async function ingestCookieChange({ hydrate, at, site, storeId, readBinding, apply }) {
  await hydrate;
  const binding = readBinding(site);
  if (binding?.storeId && storeId && storeId !== binding.storeId) {
    return { effect: { type: "ignore-store", site, writeCount: 0 } };
  }
  return apply({
    type: "cookie",
    at,
    site,
    snapshotId: binding?.snapshotId || null,
  });
}

export function debounceDelay(startedAt, now, trailMs = TRAIL_MS, maxWaitMs = MAX_WAIT_MS) {
  const remaining = maxWaitMs - Math.max(0, now - startedAt);
  if (remaining <= 0) return 0;
  return Math.min(trailMs, remaining);
}

export function writebackBudgetRemaining(startedAt, now, budgetMs = WRITEBACK_BUDGET_MS) {
  return Math.max(0, budgetMs - Math.max(0, now - startedAt));
}

function normalizeDomain(domain) {
  return String(domain ?? "").replace(/^\./, "").toLowerCase();
}

function slotKey(cookie) {
  return `${cookie.name}\0${normalizeDomain(cookie.domain)}\0${cookie.path || "/"}`;
}

function cookieStamp(cookie) {
  const expiry = cookie.session === true || cookie.expirationDate == null
    ? "s"
    : String(cookie.expirationDate);
  return `${cookie.value ?? ""}\0${expiry}`;
}

export function materiallyChanged(baseline, live) {
  const left = new Map();
  for (const cookie of baseline || []) {
    if (!cookie?.name) continue;
    left.set(slotKey(cookie), cookieStamp(cookie));
  }
  const right = new Map();
  for (const cookie of live || []) {
    if (!cookie?.name) continue;
    right.set(slotKey(cookie), cookieStamp(cookie));
  }
  if (left.size !== right.size) return true;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return true;
  }
  return false;
}

function isAnalyticsCookieName(name) {
  return /^(?:_ga(?:_|$)|_gid$|_gat(?:_|$)|Hm_lvt_|Hm_lpvt_)/.test(String(name ?? ""));
}

/**
 * 只给尚未确认身份的绑定用：比的是名字和值的增删改，过期时间滑动不算。
 * 常见统计 Cookie 不参与这次判断，写回快照时仍会原样保存。
 */
export function unconfirmedMaterialChange(baseline, live) {
  const left = new Map();
  for (const cookie of baseline || []) {
    if (!cookie?.name || isAnalyticsCookieName(cookie.name)) continue;
    left.set(slotKey(cookie), cookie.value ?? "");
  }
  const right = new Map();
  for (const cookie of live || []) {
    if (!cookie?.name || isAnalyticsCookieName(cookie.name)) continue;
    right.set(slotKey(cookie), cookie.value ?? "");
  }
  if (left.size !== right.size) return true;
  for (const [key, value] of left) {
    if (!right.has(key) || right.get(key) !== value) return true;
  }
  return false;
}

function isLongLived(cookie) {
  return cookie?.session !== true && typeof cookie.expirationDate === "number";
}

function valuesFor(cookies, name) {
  return (cookies || [])
    .filter((cookie) => cookie?.name === name)
    .map((cookie) => `${normalizeDomain(cookie.domain)}|${cookie.path || "/"}=${cookie.value ?? ""}`)
    .sort()
    .join(",");
}

function identityChanged(names, baseline, live) {
  return (names || []).some((name) => {
    const before = valuesFor(baseline, name);
    if (!before) return false;
    return before !== valuesFor(live, name);
  });
}

function authCleared(names, live) {
  if (!names?.length) return false;
  const liveNames = new Set((live || []).map((cookie) => cookie?.name).filter(Boolean));
  return names.every((name) => !liveNames.has(name));
}

function pickRule(rule, cookies, source) {
  if (!rule || !Array.isArray(rule.auth) || !Array.isArray(rule.identity)) return null;
  const names = new Set((cookies || []).map((cookie) => cookie?.name).filter(Boolean));
  const auth = rule.auth.filter((name) => names.has(name));
  const identity = rule.identity.filter((name) => names.has(name));
  if (auth.length === 0 || identity.length === 0) return null;
  return { auth, identity, source, classified: true };
}

/**
 * 第一次轮换时学：值变了（或新出现）的算认证 Cookie，没变的长期 Cookie 算身份候选。
 * 两类缺一就认不出来，调用方走降级，不自动写回。
 */
export function learnFromRotation(baseline, live) {
  const before = new Map();
  for (const cookie of baseline || []) {
    if (!cookie?.name) continue;
    const list = before.get(cookie.name) || [];
    list.push(cookie);
    before.set(cookie.name, list);
  }
  const after = new Map();
  for (const cookie of live || []) {
    if (!cookie?.name) continue;
    const list = after.get(cookie.name) || [];
    list.push(cookie);
    after.set(cookie.name, list);
  }

  const auth = [];
  const identity = [];
  for (const [name, cookies] of after) {
    const prev = before.get(name);
    if (!prev) {
      auth.push(name);
      continue;
    }
    const changed = cookies.some((cookie) => {
      const match = prev.find((item) => slotKey(item) === slotKey(cookie));
      return !match || match.value !== cookie.value;
    }) || prev.some((cookie) => !cookies.some((item) => slotKey(item) === slotKey(cookie)));
    if (changed) auth.push(name);
    else if (cookies.some((cookie) => isLongLived(cookie))) identity.push(name);
  }

  if (auth.length === 0 || identity.length === 0) {
    return { auth: [], identity: [], source: "unknown", classified: false };
  }
  return { auth, identity, source: "learned", classified: true };
}

export function resolveClassification({
  siteKey,
  baseline = [],
  live = [],
  builtin = BUILTIN_SITE_RULES,
  user = {},
  learned = null,
} = {}) {
  const union = [...(baseline || []), ...(live || [])];
  return pickRule(builtin?.[siteKey], union, "builtin")
    || pickRule(user?.[siteKey], union, "user")
    || pickRule(learned, union, "learned")
    || learnFromRotation(baseline, live);
}

export function earliestKeyExpiryMs(cookies, names) {
  const wanted = new Set(names || []);
  if (wanted.size === 0) return null;
  let earliest = null;
  for (const cookie of cookies || []) {
    if (!wanted.has(cookie?.name)) continue;
    if (cookie.session === true || typeof cookie.expirationDate !== "number") continue;
    const ms = cookie.expirationDate * 1000;
    if (earliest == null || ms < earliest) earliest = ms;
  }
  return earliest;
}

export function earliestExpiryMs(times) {
  let earliest = null;
  for (const time of times || []) {
    if (typeof time !== "number") continue;
    const ms = time * 1000;
    if (earliest == null || ms < earliest) earliest = ms;
  }
  return earliest;
}

export function keyExpiryTimes(cookies, authNames) {
  const names = new Set(authNames || []);
  if (names.size === 0) return [];
  return (cookies || [])
    .filter((cookie) => names.has(cookie?.name) && cookie.session !== true && typeof cookie.expirationDate === "number")
    .map((cookie) => cookie.expirationDate)
    .sort((left, right) => left - right);
}

/** 关键 Cookie 的最早过期时间。已经过了就把状态标成 maybe-logged-out。 */
export function assessKeyCookieExpiry(cookies, authNames, now = Date.now()) {
  const expiresAt = earliestKeyExpiryMs(cookies, authNames);
  const expired = expiresAt != null && expiresAt <= now;
  return {
    expiresAt,
    status: expired ? "maybe-logged-out" : "ok",
  };
}

/** 用户点过更新（或保存/切换时已经按内置、手动规则确认）之后，learned 才会留在绑定上。 */
export function learnedIsConfirmed(binding) {
  const learned = binding?.learned;
  return Boolean(
    learned
    && Array.isArray(learned.auth) && learned.auth.length > 0
    && Array.isArray(learned.identity) && learned.identity.length > 0,
  );
}

/**
 * 身份还没确认时，切号前的 flush 只在 Cookie 真有变化时标待更新。
 * 页面存储单独变化（站内跳转、刷新也会触发）直接跳过：不写快照，也不标 pending。
 */
export function unconfirmedFlushAction({
  binding,
  decision = null,
  baselineCookies = null,
  liveCookies = null,
  storageChanged = false,
} = {}) {
  if (learnedIsConfirmed(binding)) return "confirmed";
  if (decision?.action === "pause" || decision?.action === "unbind") return decision.action;
  const cookiesChanged = baselineCookies != null
    && liveCookies != null
    && unconfirmedMaterialChange(baselineCookies, liveCookies);
  if (
    cookiesChanged
    || decision?.action === "write"
    || decision?.action === "pending"
    || decision?.pendingUpdate === true
  ) {
    return "pending";
  }
  if (decision?.action === "refresh-cookies") return "refresh-cookies";
  if (storageChanged) return "skip";
  return "skip";
}

/** pagehide 只负责已确认身份的存储合并。未确认时交给 Cookie 路径决定要不要待更新。 */
export function mergeStorageWhenUnconfirmed(binding) {
  return learnedIsConfirmed(binding) ? "merge" : "skip";
}

export function evaluateLiveCookies({
  classification,
  baseline,
  live,
  now = Date.now(),
  learnedConfirmed = true,
} = {}) {
  const auth = classification?.auth || [];
  const identity = classification?.identity || [];
  const expiresAt = earliestKeyExpiryMs(live, auth);
  const namesChanged = unconfirmedMaterialChange(baseline, live);
  const stampsChanged = materiallyChanged(baseline, live);
  const changed = learnedConfirmed === false ? namesChanged : stampsChanged;
  const freshLearn = classification?.source === "learned" && learnedConfirmed === false;

  if (!classification?.classified || freshLearn) {
    if (!changed) {
      if (learnedConfirmed === false && stampsChanged) {
        return {
          action: "refresh-cookies",
          status: "ok",
          pendingUpdate: false,
          expiresAt: null,
          write: true,
          prompt: null,
          authNames: [],
        };
      }
      return { action: "ignore", status: "ok", pendingUpdate: false, expiresAt, write: false, prompt: null };
    }
    return {
      action: "pending",
      status: "identity-unknown",
      pendingUpdate: true,
      expiresAt,
      write: false,
      prompt: null,
    };
  }

  if (authCleared(auth, live)) {
    return {
      action: "pause",
      status: "maybe-logged-out",
      pendingUpdate: false,
      expiresAt,
      write: false,
      prompt: null,
    };
  }

  if (identityChanged(identity, baseline, live)) {
    return {
      action: "unbind",
      status: "identity-changed",
      pendingUpdate: false,
      expiresAt,
      write: false,
      prompt: "save-as-new",
    };
  }

  if (expiresAt != null && expiresAt <= now) {
    return {
      action: "pause",
      status: "maybe-logged-out",
      pendingUpdate: false,
      expiresAt,
      write: false,
      prompt: null,
    };
  }

  if (!stampsChanged) {
    return { action: "ignore", status: "ok", pendingUpdate: false, expiresAt, write: false, prompt: null };
  }

  if (!namesChanged) {
    return {
      action: "refresh-cookies",
      status: "ok",
      pendingUpdate: false,
      expiresAt,
      write: true,
      prompt: null,
      authNames: auth,
    };
  }

  return { action: "write", status: "ok", pendingUpdate: false, expiresAt, write: true, prompt: null };
}

export function identityHint(cookies, identityNames) {
  return (identityNames || []).map((name) => {
    const cookie = (cookies || []).find((item) => item?.name === name);
    return `${name}=${cookie?.value ?? ""}`;
  }).join("&");
}

export function createSiteBinding({
  profile,
  storeId = null,
  cookies = [],
  classification = null,
  now = Date.now(),
} = {}) {
  const learned = classification?.classified
    ? { auth: classification.auth, identity: classification.identity }
    : null;
  return {
    site: profile.siteKey,
    snapshotId: profile.id,
    boundAt: now,
    origin: profile.origin || null,
    identityHint: identityHint(cookies, classification?.identity || []),
    storeId: storeId || null,
    status: "ok",
    pendingUpdate: false,
    paused: false,
    learned,
    expiresAt: earliestKeyExpiryMs(cookies, classification?.auth || []),
    lastRefreshedAt: now,
  };
}

function cloneCookies(cookies) {
  return (cookies || []).map((cookie) => ({ ...cookie }));
}

function cloneStorage(storage) {
  return { ...(storage || {}) };
}

/**
 * 只改当前这份 Cookie 和刷新时间。prev 原样留下，不另开一层回滚。
 * 用在过期时间滑动或统计 Cookie 变化，名字和值都没变的时候。
 */
export function refreshCookiesInPlace(capture, live) {
  const next = {
    cookies: cloneCookies(live),
    localStorage: cloneStorage(capture?.localStorage),
    sessionStorage: cloneStorage(capture?.sessionStorage),
  };
  if (capture?.prev && Array.isArray(capture.prev.cookies)) {
    next.prev = {
      cookies: cloneCookies(capture.prev.cookies),
      localStorage: cloneStorage(capture.prev.localStorage),
      sessionStorage: cloneStorage(capture.prev.sessionStorage),
    };
  }
  return next;
}

/**
 * 切号前的 flush：未确认，或存储没变，只就地改 Cookie。
 * 已确认并且 localStorage/sessionStorage 变了，则连同新存储写成一层可回滚的快照。
 */
export function planFlushCapture({
  confirmed = false,
  storageChanged = false,
  capture,
  live,
  localStorage,
  sessionStorage,
} = {}) {
  if (!confirmed || !storageChanged) {
    return { mode: "in-place", capture: refreshCookiesInPlace(capture, live) };
  }
  return {
    mode: "stage",
    capture: stageCapture(capture, { cookies: live, localStorage, sessionStorage }),
  };
}

export function cookieRefreshMeta(profile, decision, now) {
  return {
    savedAt: profile?.savedAt,
    lastRefreshedAt: now,
    canRollback: profile?.canRollback === true,
    authNames: Array.isArray(decision?.authNames) ? decision.authNames : [],
  };
}

/** 只保留一层上一版。再写一次会丢掉更早的那版。 */
export function stageCapture(current, next) {
  return {
    cookies: cloneCookies(next?.cookies ?? current?.cookies),
    localStorage: cloneStorage(next?.localStorage ?? current?.localStorage),
    sessionStorage: cloneStorage(next?.sessionStorage ?? current?.sessionStorage),
    prev: {
      cookies: cloneCookies(current?.cookies),
      localStorage: cloneStorage(current?.localStorage),
      sessionStorage: cloneStorage(current?.sessionStorage),
    },
  };
}

export function canRollbackCapture(capture) {
  return Boolean(capture?.prev && Array.isArray(capture.prev.cookies));
}

export function rollbackCapture(current) {
  if (!canRollbackCapture(current)) {
    return { capture: current, canRollback: false };
  }
  return {
    capture: {
      cookies: cloneCookies(current.prev.cookies),
      localStorage: cloneStorage(current.prev.localStorage),
      sessionStorage: cloneStorage(current.prev.sessionStorage),
      prev: null,
    },
    canRollback: false,
  };
}

function boundTo(state, event) {
  const binding = bindingFor(state, event.site);
  return Boolean(binding && binding.snapshotId && binding.snapshotId === event.snapshotId);
}

function writeEffect(binding, startedAt, generation, extra = {}) {
  return {
    type: "write",
    site: binding.site,
    snapshotId: binding.snapshotId,
    startedAt,
    generation,
    writeCount: 0,
    ...extra,
  };
}

/**
 * 纯状态机。绑定和防抖都按站点分桶。
 * 切换锁只盖住正在切换的那个站点：锁内变化丢掉且解锁后不补写，其他站点照常计时。
 */
export function reduceRefresh(state, event, options = {}) {
  const trailMs = options.trailMs ?? TRAIL_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const site = event.site || event.binding?.site || null;

  if (event.type === "lock") {
    if (!site) return { state, effect: { type: "none", writeCount: 0 } };
    return {
      state: {
        ...state,
        bindings: withoutKey(state.bindings, site),
        debounces: withoutKey(state.debounces, site),
        locks: { ...state.locks, [site]: true },
        generations: { ...state.generations, [site]: generationFor(state, site) + 1 },
      },
      effect: { type: "cancel", site, writeCount: 0 },
    };
  }

  if (event.type === "unlock") {
    if (!site) return { state, effect: { type: "none", writeCount: 0 } };
    return {
      state: { ...state, locks: withoutKey(state.locks, site) },
      effect: { type: "none", site, writeCount: 0 },
    };
  }

  if (event.type === "bind") {
    const binding = event.binding;
    if (!binding?.site) return { state, effect: { type: "none", writeCount: 0 } };
    return {
      state: {
        ...state,
        bindings: { ...state.bindings, [binding.site]: binding },
        notices: withoutKey(state.notices, binding.site),
        locks: withoutKey(state.locks, binding.site),
      },
      effect: { type: "none", site: binding.site, writeCount: 0 },
    };
  }

  if (event.type === "unbind") {
    if (!site) return { state, effect: { type: "none", writeCount: 0 } };
    const notices = { ...state.notices };
    if (event.notice) notices[site] = { ...event.notice, site };
    else delete notices[site];
    return {
      state: {
        ...state,
        bindings: withoutKey(state.bindings, site),
        debounces: withoutKey(state.debounces, site),
        notices,
      },
      effect: { type: "cancel", site, writeCount: 0 },
    };
  }

  if (event.type === "cookie") {
    if (siteLocked(state, site)) {
      return { state, effect: { type: "ignore-locked", site, writeCount: 0 } };
    }
    const binding = bindingFor(state, site);
    if (!binding || !boundTo(state, event)) {
      return {
        state: { ...state, unboundEvents: state.unboundEvents + 1 },
        effect: { type: "ignore-unbound", site, writeCount: 0 },
      };
    }
    if (binding.paused || binding.status === "maybe-logged-out" || binding.status === "identity-unknown") {
      return { state, effect: { type: "ignore-paused", site, writeCount: 0 } };
    }
    const startedAt = state.debounces?.[site]?.startedAt ?? event.at;
    const generation = generationFor(state, site);
    const delay = debounceDelay(startedAt, event.at, trailMs, maxWaitMs);
    if (delay === 0) {
      return {
        state: { ...state, debounces: withoutKey(state.debounces, site) },
        effect: writeEffect(binding, startedAt, generation),
      };
    }
    return {
      state: { ...state, debounces: { ...state.debounces, [site]: { startedAt, generation } } },
      effect: {
        type: "schedule",
        delay,
        generation,
        site,
        snapshotId: binding.snapshotId,
        writeCount: 0,
      },
    };
  }

  if (event.type === "timer") {
    const debounce = site ? state.debounces?.[site] : null;
    const binding = bindingFor(state, site);
    if (!site || siteLocked(state, site) || !debounce || debounce.generation !== event.generation || !binding) {
      const dropDebounce = Boolean(site && debounce && debounce.generation === event.generation);
      return {
        state: dropDebounce ? { ...state, debounces: withoutKey(state.debounces, site) } : state,
        effect: { type: "drop", site, writeCount: 0 },
      };
    }
    return {
      state: { ...state, debounces: withoutKey(state.debounces, site) },
      effect: writeEffect(binding, debounce.startedAt, event.generation),
    };
  }

  if (event.type === "flush") {
    const debounce = site ? state.debounces?.[site] : null;
    const binding = bindingFor(state, site);
    if (!site || siteLocked(state, site) || !debounce || !binding) {
      return { state, effect: { type: "none", site, writeCount: 0 } };
    }
    return {
      state: { ...state, debounces: withoutKey(state.debounces, site) },
      effect: writeEffect(binding, debounce.startedAt, generationFor(state, site), { flush: true }),
    };
  }

  return { state, effect: { type: "none", writeCount: 0 } };
}

function withBinding(state, site, binding, extra = {}) {
  return {
    ...state,
    ...extra,
    bindings: binding ? { ...state.bindings, [site]: binding } : withoutKey(state.bindings, site),
  };
}

export function applyDecision(state, decision) {
  const site = decision.site;
  const binding = bindingFor(state, site);
  if (!binding) return { state, committed: false };
  const expiresAt = decision.expiresAt ?? binding.expiresAt ?? null;
  if (decision.action === "write") {
    return {
      state: withBinding(state, site, {
        ...binding,
        status: "ok",
        pendingUpdate: false,
        paused: false,
        expiresAt,
        learned: decision.learned || binding.learned || null,
        lastRefreshedAt: decision.now ?? binding.lastRefreshedAt,
      }, { writeCount: state.writeCount + 1, notices: withoutKey(state.notices, site) }),
      committed: true,
    };
  }
  if (decision.action === "refresh-cookies") {
    const keepExpiry = Array.isArray(decision.authNames) && decision.authNames.length > 0;
    return {
      state: withBinding(state, site, {
        ...binding,
        status: "ok",
        pendingUpdate: false,
        paused: false,
        learned: binding.learned || null,
        expiresAt: keepExpiry ? (decision.expiresAt ?? binding.expiresAt ?? null) : (binding.expiresAt ?? null),
        lastRefreshedAt: decision.now ?? binding.lastRefreshedAt,
      }),
      committed: true,
    };
  }
  if (decision.action === "pending") {
    return {
      state: withBinding(state, site, {
        ...binding,
        status: "identity-unknown",
        pendingUpdate: true,
        paused: true,
        expiresAt,
      }),
      committed: false,
    };
  }
  if (decision.action === "pause") {
    return {
      state: withBinding(state, site, {
        ...binding,
        status: "maybe-logged-out",
        pendingUpdate: false,
        paused: true,
        expiresAt,
      }),
      committed: false,
    };
  }
  if (decision.action === "unbind") {
    return {
      state: {
        ...state,
        bindings: withoutKey(state.bindings, site),
        debounces: withoutKey(state.debounces, site),
        notices: {
          ...state.notices,
          [site]: {
            site,
            status: "identity-changed",
            prompt: decision.prompt || "save-as-new",
          },
        },
      },
      committed: false,
    };
  }
  return { state, committed: false };
}

export function badgeCount(profiles, now = Date.now()) {
  let count = 0;
  for (const profile of profiles || []) {
    const expiresAt = earliestExpiryMs(profile.keyExpiryTimes);
    const expiring = expiresAt != null && expiresAt - now <= EXPIRY_BADGE_MS;
    const stale = typeof profile.lastRefreshedAt === "number" && now - profile.lastRefreshedAt >= STALE_BADGE_MS;
    if (expiring || stale) count += 1;
  }
  return count;
}

function presentProfile(summary, source, now) {
  const expiresAt = earliestExpiryMs(source?.keyExpiryTimes);
  const lastRefreshedAt = typeof source?.lastRefreshedAt === "number" ? source.lastRefreshedAt : null;
  return {
    ...summary,
    lastRefreshedAt,
    expiresAt,
    refreshLabel: formatRefreshLabel(lastRefreshedAt, now),
    expiryLabel: formatExpiryLabel(expiresAt, now),
  };
}

/** 弹窗只读这里产出的字段，不自己推 status / pendingUpdate / expiresAt。 */
export function buildRefreshView({ view, profiles = [], refreshState = null, now = Date.now() } = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  const byId = new Map(list.map((profile) => [profile.id, profile]));
  const presented = (view?.profiles || []).map((summary) => presentProfile(summary, byId.get(summary.id), now));

  const site = view?.siteKey;
  const binding = bindingFor(refreshState, site);
  const notice = refreshState?.notices?.[site] || null;
  const bound = binding && binding.snapshotId && byId.has(binding.snapshotId) ? binding : null;
  const noticeHere = !bound && notice ? notice : null;
  const boundSource = bound ? byId.get(bound.snapshotId) : null;
  const expiresAt = boundSource
    ? earliestExpiryMs(boundSource.keyExpiryTimes) ?? bound.expiresAt ?? null
    : null;

  let status = bound ? (bound.status || "ok") : (noticeHere?.status || null);
  if (bound && typeof expiresAt === "number" && expiresAt <= now) status = "maybe-logged-out";

  const pendingUpdate = Boolean(bound && bound.pendingUpdate) && status !== "maybe-logged-out";
  const boundProfileId = bound ? bound.snapshotId : null;
  const profilesOut = presented.map((profile) => {
    const active = boundProfileId ? profile.id === boundProfileId : profile.active;
    if (profile.id !== boundProfileId || profile.expiresAt != null || typeof expiresAt !== "number") {
      return { ...profile, active };
    }
    return {
      ...profile,
      active,
      expiresAt,
      expiryLabel: formatExpiryLabel(expiresAt, now),
    };
  });
  const boundSummary = profilesOut.find((profile) => profile.id === boundProfileId) || null;

  return {
    ...view,
    profiles: profilesOut,
    boundProfileId,
    status,
    statusLabel: statusLabelFor(status),
    pendingUpdate,
    expiresAt: boundSummary?.expiresAt ?? expiresAt,
    canRollback: Boolean(boundSource?.canRollback),
    lastRefreshedAt: boundSummary?.lastRefreshedAt ?? null,
    refreshLabel: boundSummary?.refreshLabel || "",
    expiryLabel: boundSummary?.expiryLabel || "",
    prompt: status === "identity-changed" ? "save-as-new" : null,
  };
}
