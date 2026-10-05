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

export function initialRefreshState(overrides = {}) {
  return {
    locked: false,
    generation: 0,
    binding: null,
    notice: null,
    debounce: null,
    writeCount: 0,
    unboundEvents: 0,
    ...overrides,
  };
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

export function evaluateLiveCookies({ classification, baseline, live, now = Date.now() }) {
  const auth = classification?.auth || [];
  const identity = classification?.identity || [];
  const expiresAt = earliestKeyExpiryMs(live, auth);
  const changed = materiallyChanged(baseline, live);

  if (!classification?.classified) {
    if (!changed) {
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

  if (!changed) {
    return { action: "ignore", status: "ok", pendingUpdate: false, expiresAt, write: false, prompt: null };
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
  const binding = state.binding;
  return Boolean(
    binding
    && binding.snapshotId
    && binding.site === event.site
    && binding.snapshotId === event.snapshotId,
  );
}

/**
 * 纯状态机。锁住期间的 cookie 事件直接丢掉，不进防抖队列，
 * 所以解锁之后也不会把这段变化补写回去。
 */
export function reduceRefresh(state, event, options = {}) {
  const trailMs = options.trailMs ?? TRAIL_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;

  if (event.type === "lock") {
    return {
      state: {
        ...state,
        locked: true,
        generation: state.generation + 1,
        debounce: null,
        binding: null,
      },
      effect: { type: "cancel", writeCount: 0 },
    };
  }

  if (event.type === "unlock") {
    return {
      state: { ...state, locked: false },
      effect: { type: "none", writeCount: 0 },
    };
  }

  if (event.type === "bind") {
    return {
      state: {
        ...state,
        binding: event.binding || null,
        notice: event.binding ? null : state.notice,
      },
      effect: { type: "none", writeCount: 0 },
    };
  }

  if (event.type === "unbind") {
    return {
      state: {
        ...state,
        binding: null,
        debounce: null,
        notice: event.notice ?? null,
      },
      effect: { type: "cancel", writeCount: 0 },
    };
  }

  if (event.type === "cookie") {
    if (state.locked) {
      return { state, effect: { type: "ignore-locked", writeCount: 0 } };
    }
    if (!boundTo(state, event)) {
      return {
        state: { ...state, unboundEvents: state.unboundEvents + 1 },
        effect: { type: "ignore-unbound", writeCount: 0 },
      };
    }
    if (state.binding.paused || state.binding.status === "maybe-logged-out" || state.binding.status === "identity-unknown") {
      return { state, effect: { type: "ignore-paused", writeCount: 0 } };
    }
    const startedAt = state.debounce?.startedAt ?? event.at;
    const generation = state.generation;
    const delay = debounceDelay(startedAt, event.at, trailMs, maxWaitMs);
    if (delay === 0) {
      return {
        state: { ...state, debounce: null },
        effect: {
          type: "write",
          site: state.binding.site,
          snapshotId: state.binding.snapshotId,
          startedAt,
          generation,
          writeCount: 0,
        },
      };
    }
    return {
      state: { ...state, debounce: { startedAt, generation } },
      effect: {
        type: "schedule",
        delay,
        generation,
        site: state.binding.site,
        snapshotId: state.binding.snapshotId,
        writeCount: 0,
      },
    };
  }

  if (event.type === "timer") {
    if (state.locked || !state.debounce || state.debounce.generation !== event.generation || !state.binding) {
      const dropDebounce = state.debounce?.generation === event.generation;
      return {
        state: { ...state, debounce: dropDebounce ? null : state.debounce },
        effect: { type: "drop", writeCount: 0 },
      };
    }
    const startedAt = state.debounce.startedAt;
    return {
      state: { ...state, debounce: null },
      effect: {
        type: "write",
        site: state.binding.site,
        snapshotId: state.binding.snapshotId,
        startedAt,
        generation: event.generation,
        writeCount: 0,
      },
    };
  }

  if (event.type === "flush") {
    if (state.locked || !state.debounce || !state.binding) {
      return { state, effect: { type: "none", writeCount: 0 } };
    }
    const startedAt = state.debounce.startedAt;
    return {
      state: { ...state, debounce: null },
      effect: {
        type: "write",
        site: state.binding.site,
        snapshotId: state.binding.snapshotId,
        startedAt,
        generation: state.generation,
        flush: true,
        writeCount: 0,
      },
    };
  }

  return { state, effect: { type: "none", writeCount: 0 } };
}

export function applyDecision(state, decision) {
  if (!state.binding) return { state, committed: false };
  const expiresAt = decision.expiresAt ?? state.binding.expiresAt ?? null;
  if (decision.action === "write") {
    return {
      state: {
        ...state,
        writeCount: state.writeCount + 1,
        binding: {
          ...state.binding,
          status: "ok",
          pendingUpdate: false,
          paused: false,
          expiresAt,
          learned: decision.learned || state.binding.learned || null,
          lastRefreshedAt: decision.now ?? state.binding.lastRefreshedAt,
        },
      },
      committed: true,
    };
  }
  if (decision.action === "pending") {
    return {
      state: {
        ...state,
        binding: {
          ...state.binding,
          status: "identity-unknown",
          pendingUpdate: true,
          paused: true,
          expiresAt,
        },
      },
      committed: false,
    };
  }
  if (decision.action === "pause") {
    return {
      state: {
        ...state,
        binding: {
          ...state.binding,
          status: "maybe-logged-out",
          pendingUpdate: false,
          paused: true,
          expiresAt,
        },
      },
      committed: false,
    };
  }
  if (decision.action === "unbind") {
    return {
      state: {
        ...state,
        binding: null,
        notice: {
          site: state.binding.site,
          status: "identity-changed",
          prompt: decision.prompt || "save-as-new",
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

  const binding = refreshState?.binding || null;
  const notice = refreshState?.notice || null;
  const site = view?.siteKey;
  const bound = binding && binding.site === site && binding.snapshotId && byId.has(binding.snapshotId)
    ? binding
    : null;
  const noticeHere = !bound && notice && notice.site === site ? notice : null;
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
