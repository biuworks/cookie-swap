import { cookieKey } from './cookies.js';

export const TRAIL_MS = 1_500;
export const MAX_WAIT_MS = 3_000;
export const WRITEBACK_BUDGET_MS = 5_000;
export const REFRESH_STATE_KEY = 'refreshState';
export const RULE_VERSION = 1;
export const FLUSH_SCRIPT_ID = 'storage-flush';
export const BUILTIN_SITE_RULES = Object.freeze({
  'github.com': { auth: ['user_session'], identity: ['dotcom_user'] },
  'bilibili.com': { auth: ['SESSDATA'], identity: ['DedeUserID'] },
  'x.com': { auth: ['auth_token'], identity: ['twid'] },
  'twitter.com': { auth: ['auth_token'], identity: ['twid'] },
});

export const contextKey = (site, storeId) => JSON.stringify([site, storeId]);
export const debounceDelay = (start, now) => Math.max(0, Math.min(TRAIL_MS, MAX_WAIT_MS - (now - start)));
export const writebackBudgetRemaining = (start, now) => Math.max(0, WRITEBACK_BUDGET_MS - (now - start));
export const cloneCapture = (capture) => structuredClone({
  cookies: capture?.cookies || [], localStorage: capture?.localStorage || {}, sessionStorage: capture?.sessionStorage || {},
});

// Deterministic serialization also binds confirmations to exact captured content.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function captureStamp(capture) {
  const copy = cloneCapture(capture);
  copy.cookies.sort((a, b) => cookieKey(a).localeCompare(cookieKey(b)));
  return canonical(copy);
}
function cookiesStamp(cookies, material = false) {
  return canonical((cookies || []).filter(c => !material || !/^(_ga(?:$|_)|_gid$|_gat|Hm_l[vp]t_)/.test(c.name))
    .map(c => material ? { ...c, expirationDate: undefined } : c)
    .sort((a, b) => cookieKey(a).localeCompare(cookieKey(b))));
}
export const materiallyChanged = (a, b) => cookiesStamp(a) !== cookiesStamp(b);
export const unconfirmedMaterialChange = (a, b) => cookiesStamp(a, true) !== cookiesStamp(b, true);

function selectCookie(cookies, name, site) {
  const matches = (cookies || []).filter(c => c.name === name
    && String(c.domain).replace(/^\./, '').toLowerCase() === site
    && (c.path || '/') === '/' && !c.partitionKey && c.secure === true);
  return matches.length === 1 && matches[0].value ? matches[0] : null;
}
export function accountIdentity(site, cookies, now = Date.now()) {
  const rule = BUILTIN_SITE_RULES[site];
  const unknown = { status: 'unknown', accountKey: null, authNames: [], expiresAt: null, ruleVersion: RULE_VERSION };
  if (!rule) return unknown;
  const auth = selectCookie(cookies, rule.auth[0], site);
  const id = selectCookie(cookies, rule.identity[0], site);
  const expiresAt = auth && !auth.session && Number.isFinite(auth.expirationDate) ? auth.expirationDate * 1000 : null;
  if (!auth || (expiresAt != null && expiresAt <= now)) return { ...unknown, status: 'logged-out', expiresAt };
  if (!id || (!id.session && Number.isFinite(id.expirationDate) && id.expirationDate * 1000 <= now)) return unknown;
  let value = String(id.value);
  if (site === 'github.com') {
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value)) return unknown;
    value = value.toLowerCase();
  } else if (site === 'bilibili.com') {
    if (!/^[1-9]\d*$/.test(value)) return unknown;
  } else {
    try { value = decodeURIComponent(value); } catch { return unknown; }
    const match = /^u=([1-9]\d*)$/.exec(value);
    if (!match) return unknown;
    value = match[1];
  }
  return { status: 'verified', accountKey: `${site}:${value}`, authNames: rule.auth, expiresAt, ruleVersion: RULE_VERSION };
}
export function compareIdentity(site, baseline, live, now = Date.now()) {
  const before = accountIdentity(site, baseline, now);
  const current = accountIdentity(site, live, now);
  // A previously saved identity can still identify the account after its token expires.
  const saved = before.accountKey ? before : accountIdentity(site, baseline, 0);
  const status = current.status === 'logged-out' ? 'logged-out'
    : !saved.accountKey || !current.accountKey ? 'unknown'
    : saved.accountKey === current.accountKey ? 'same' : 'different';
  return { ...current, status };
}
export function resolveClassification({ siteKey, baseline = [], live = [] } = {}) {
  const before = accountIdentity(siteKey, baseline, 0);
  const current = accountIdentity(siteKey, live);
  const rule = BUILTIN_SITE_RULES[siteKey];
  return { siteKey, auth: rule?.auth || [], identity: rule?.identity || [], source: rule ? 'builtin' : 'unknown',
    classified: Boolean(before.accountKey && current.accountKey), ruleVersion: RULE_VERSION };
}
export function createSiteBinding({ profile, storeId = null, cookies = [], now = Date.now(), owner = null, manualOnly = false } = {}) {
  const identity = accountIdentity(profile.siteKey, cookies, now);
  return { site: profile.siteKey, origin: profile.origin, snapshotId: profile.id, storeId,
    generation: crypto.randomUUID(), boundAt: now, owner, manualOnly,
    accountKey: identity.accountKey, ruleVersion: RULE_VERSION, paused: false, status: identity.status === 'verified' ? 'same' : identity.status };
}
// Retained name for consumers; legacy learned rules never pass this check.
export const learnedIsConfirmed = binding => Boolean(binding?.accountKey && binding.ruleVersion === RULE_VERSION && !binding.manualOnly);
export function evaluateLiveCookies({ classification, baseline = [], live = [], now = Date.now() } = {}) {
  const identity = compareIdentity(classification?.siteKey, baseline, live, now);
  const action = identity.status === 'different' ? 'unbind' : identity.status === 'logged-out' ? 'pause'
    : identity.status !== 'same' ? 'pending' : !materiallyChanged(baseline, live) ? 'ignore'
    : unconfirmedMaterialChange(baseline, live) ? 'write' : 'refresh-cookies';
  return { ...identity, action, write: action === 'write' || action === 'refresh-cookies' };
}
export function stageCapture(current, next) {
  return { ...cloneCapture(next), prev: cloneCapture(current) };
}
export const canRollbackCapture = capture => Boolean(capture?.prev?.cookies);
export function rollbackCapture(current) {
  return canRollbackCapture(current) ? { capture: { ...cloneCapture(current.prev), prev: null }, canRollback: false }
    : { capture: current, canRollback: false };
}
export const refreshCookiesInPlace = (capture, cookies) => ({ ...structuredClone(capture), cookies: structuredClone(cookies) });

export function hydrateRefreshState(saved) {
  const bindings = {};
  for (const [key, old] of Object.entries(saved?.bindings || {})) {
    if (!old?.snapshotId || !old.site || !old.storeId) continue;
    const locked = old.locked || saved?.locks?.[key];
    bindings[contextKey(old.site, old.storeId)] = {
      ...old, generation: old.generation || crypto.randomUUID(),
      paused: Boolean(old.paused || locked), status: locked ? 'interrupted' : old.status,
      accountKey: old.ruleVersion === RULE_VERSION ? old.accountKey : null,
      manualOnly: Boolean(old.manualOnly || saved?.version !== 2),
      owner: saved?.version === 2 ? old.owner : null, locked: false,
    };
  }
  return { version: 2, bindings };
}
export function flushScriptMatches(bindings) {
  return [...new Set(Object.values(bindings || {}).filter(b => !b.paused && !b.manualOnly && b.accountKey && b.owner)
    .map(b => `${b.origin}/*`).filter(s => /^https?:\/\//.test(s)))].sort();
}
export async function syncFlushScript(scripting, bindings) {
  const matches = flushScriptMatches(bindings);
  if (!scripting?.getRegisteredContentScripts) return;
  const old = (await scripting.getRegisteredContentScripts({ ids: [FLUSH_SCRIPT_ID] }))[0];
  if (canonical(old?.matches || []) === canonical(matches)) return;
  if (old) await scripting.unregisterContentScripts({ ids: [FLUSH_SCRIPT_ID] });
  if (matches.length) await scripting.registerContentScripts([{ id: FLUSH_SCRIPT_ID, matches, js: ['src/page-hide.js'], runAt: 'document_start', persistAcrossSessions: true }]);
}
