const SAME_SITE = new Set(["lax", "strict", "no_restriction"]);
export const IDENTITY_AUTH_SOURCE = "session|token|auth|sid|jwt|login|uid|user|account|credential|remember";
export const IDENTITY_NOISE_SOURCE = "callback-url|csrf";
const AUTH_COOKIE = new RegExp(IDENTITY_AUTH_SOURCE, "i");
const NOISY_AUTH = new RegExp(IDENTITY_NOISE_SOURCE, "i");

export function cookieBelongsToSite(cookieDomain, siteKey) {
  const domain = String(cookieDomain ?? "").replace(/^\./, "").toLowerCase();
  const site = String(siteKey ?? "").toLowerCase();
  if (!domain || !site) return false;
  return domain === site || domain.endsWith(`.${site}`);
}

export function cookieKey(cookie) {
  const partition = cookie.partitionKey?.topLevelSite
    ? `${cookie.partitionKey.topLevelSite}\0${cookie.partitionKey.hasCrossSiteAncestor ? "1" : "0"}`
    : "";
  return `${cookie.name}\0${cookie.domain}\0${cookie.path}\0${partition}`;
}

export function mergeCookies(groups) {
  const merged = new Map();
  for (const cookie of groups.flat()) {
    if (!cookie?.name) continue;
    merged.set(cookieKey(cookie), cookie);
  }
  return [...merged.values()];
}

export function toSnapshot(cookie) {
  const session = cookie.session === true || cookie.expirationDate == null;
  const partitionKey = cookie.partitionKey?.topLevelSite
    ? {
        topLevelSite: cookie.partitionKey.topLevelSite,
        hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
      }
    : undefined;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || "unspecified",
    session,
    hostOnly: Boolean(cookie.hostOnly),
    expirationDate: session ? undefined : cookie.expirationDate,
    partitionKey,
  };
}

export function cookieMatchUrl(cookie) {
  const host = String(cookie.domain ?? "").replace(/^\./, "");
  const protocol = cookie.secure ? "https:" : "http:";
  const path = cookie.path?.startsWith("/") ? cookie.path : "/";
  return `${protocol}//${host}${path}`;
}

export function toCookieSetDetails(cookie, storeId) {
  const hostPrefixed = cookie.name.startsWith("__Host-");
  const securePrefixed = hostPrefixed || cookie.name.startsWith("__Secure-");
  const details = {
    url: cookieMatchUrl({
      ...cookie,
      secure: securePrefixed ? true : cookie.secure,
      path: hostPrefixed ? "/" : cookie.path,
    }),
    name: cookie.name,
    value: cookie.value,
    path: hostPrefixed ? "/" : (cookie.path || "/"),
    secure: securePrefixed ? true : Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    storeId,
  };
  if (!cookie.hostOnly && cookie.domain && !hostPrefixed) {
    details.domain = cookie.domain.replace(/^\./, "");
  }
  if (!cookie.session && typeof cookie.expirationDate === "number") {
    details.expirationDate = cookie.expirationDate;
  }
  if (SAME_SITE.has(cookie.sameSite)) details.sameSite = cookie.sameSite;
  if (cookie.partitionKey?.topLevelSite) {
    details.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite,
      hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
    };
  }
  return details;
}

export function toCookieRemoveDetails(cookie, storeId) {
  const details = {
    url: cookieMatchUrl(cookie),
    name: cookie.name,
    storeId,
  };
  if (cookie.partitionKey?.topLevelSite) {
    details.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite,
      hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
    };
  }
  return details;
}

export function isExpired(cookie, now = Date.now()) {
  return !cookie.session && typeof cookie.expirationDate === "number" && cookie.expirationDate * 1000 <= now;
}

export function cookiesForRestore(cookies, now = Date.now()) {
  return (cookies || []).filter((cookie) => cookie?.name && !isExpired(cookie, now));
}

/**
 * 把「哪些 Cookie 什么时候过期」压成一组数字，存进列表记录里。
 *
 * 只存时间戳、不存名字和值，所以列表记录里没有敏感内容；同时让弹窗
 * 不必为了算过期数去逐个读回完整的 capture（可能有几 MB）。
 */
export function expirationTimes(cookies) {
  return (cookies || [])
    .filter((cookie) => cookie && !cookie.session && typeof cookie.expirationDate === "number")
    .map((cookie) => cookie.expirationDate)
    .sort((left, right) => left - right);
}

/** 「过期」是时间的函数，不是保存时的属性，所以只能在渲染时现算。 */
export function expiredCookieCount(times, now = Date.now()) {
  const seconds = now / 1000;
  let count = 0;
  for (const time of times || []) {
    if (typeof time === "number" && time <= seconds) count += 1;
  }
  return count;
}

function normalizeCookieDomain(domain) {
  return String(domain ?? "").replace(/^\./, "").toLowerCase();
}

function isIdentityCookie(cookie) {
  return Boolean(cookie?.name) && AUTH_COOKIE.test(cookie.name) && !NOISY_AUTH.test(cookie.name);
}

function isIdentityStorageKey(key) {
  return AUTH_COOKIE.test(key) && !NOISY_AUTH.test(key);
}

export function identityEntries(snapshot) {
  if (Array.isArray(snapshot?.identity)) {
    return snapshot.identity.filter((entry) => Array.isArray(entry) && entry.length >= 2 && entry[0]);
  }
  const cookies = snapshot.cookies || [];
  const authCookies = cookies.filter(isIdentityCookie);
  const chosenCookies = authCookies.length > 0 ? authCookies : cookies.filter((cookie) => cookie?.name);
  const entries = chosenCookies.map((cookie) => [
    `c:${cookie.name}|${normalizeCookieDomain(cookie.domain)}|${cookie.path || "/"}`,
    String(cookie.value ?? ""),
  ]);

  const storage = snapshot.localStorage || {};
  const authKeys = Object.keys(storage).filter(isIdentityStorageKey);
  for (const key of authKeys.sort()) {
    entries.push([`s:${key}`, String(storage[key] ?? "")]);
  }

  if (entries.length === 0) {
    for (const key of Object.keys(storage).sort()) {
      entries.push([`s:${key}`, String(storage[key] ?? "")]);
    }
  }
  return entries;
}

export function needsFullIdentityStorage(capture, otherKeys = 0) {
  if (!otherKeys) return false;
  if ((capture?.cookies || []).some((cookie) => cookie?.name)) return false;
  return Object.keys(capture?.localStorage || {}).length === 0;
}

export function matchActiveProfileId(capture, profiles, hintId = null) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length === 0) return null;

  const live = new Map(identityEntries(capture));
  const hinted = hintId && list.some((profile) => profile.id === hintId) ? hintId : null;
  if (live.size === 0) return hinted;

  const scores = list.map((profile) => {
    let matches = 0;
    let mismatches = 0;
    for (const [key, value] of identityEntries(profile)) {
      if (!live.has(key)) continue;
      if (live.get(key) === value) matches += 1;
      else mismatches += 1;
    }
    return { id: profile.id, matches, mismatches };
  });

  const ranked = scores
    .filter((score) => score.matches > 0)
    .sort((left, right) => right.matches - left.matches || left.mismatches - right.mismatches);

  if (ranked.length > 0) {
    const best = ranked[0];
    const tied = ranked.filter((score) => (
      score.matches === best.matches && score.mismatches === best.mismatches
    ));
    if (tied.length === 1) return best.id;
    if (hinted && tied.some((score) => score.id === hinted)) return hinted;
    return null;
  }

  return hinted;
}
