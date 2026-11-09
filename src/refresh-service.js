import { readPageTarget, registrableDomain } from './domain.js';
import { toSnapshot } from './cookies.js';
import { readPageStorage } from './page-storage.js';
import { readProfiles, readProfileCapture, readProtectedBackup, protectedBackup, backupKey, commitProfile,
  replaceProfile, upsertProfile, normalizeName, summarizeProfile, assertCaptureSize, assertCapturable } from './profiles.js';
import { accountIdentity, compareIdentity, contextKey, captureStamp, canonical, cloneCapture, createSiteBinding,
  stageCapture, rollbackCapture, refreshCookiesInPlace, unconfirmedMaterialChange, materiallyChanged,
  hydrateRefreshState, REFRESH_STATE_KEY, debounceDelay, writebackBudgetRemaining, syncFlushScript } from './refresh.js';
import { formatRefreshLabel, formatExpiryLabel } from './format.js';

const labels = { unknown: '身份待确认 · 自动更新已暂停', different: '检测到其他账号，请另存',
  'logged-out': '登录凭据缺失或过期 · 自动更新已暂停', recovered: '快照已恢复 · 自动更新已暂停',
  'other-source': '已在其他页面绑定 · 此处自动更新已暂停',
  interrupted: '上次操作中断 · 请重新切换或更新', 'write-failed': '写入失败 · 原快照已保留' };
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');

// All public mutators run on background.js's queue. Cookie revisions advance immediately,
// even while a capture/confirmation is awaiting Chrome APIs on that queue.
export class RefreshService {
  constructor({ api, enqueue, getStoreId, collectCookies, readCapture, now = Date.now }) {
    Object.assign(this, { api, enqueue, getStoreId, collectCookies, readCapture, now });
    this.state = { version: 2, bindings: {} };
    this.revisions = new Map(); this.timers = new Map(); this.pending = new Map();
    this.ready = Promise.resolve();
  }
  start() {
    this.api.cookies?.onChanged?.addListener(info => {
      const c = info?.cookie;
      if (!c?.domain || !c.storeId) return;
      const key = contextKey(registrableDomain(c.domain.replace(/^\./, '')), c.storeId);
      this.revisions.set(key, this.rev(key) + 1);
      const at = this.now();
      // Events observed under a lock or pause cannot be replayed after rebinding.
      const observed = this.binding(key);
      const dropped = Boolean(observed?.locked || observed?.paused);
      const generation = observed?.generation;
      this.enqueue(async () => {
        await this.ready;
        if (dropped || (generation && this.binding(key)?.generation !== generation)) return;
        this.schedule(key, at);
      }).catch(() => {});
    });
    this.api.tabs?.onUpdated?.addListener((id, info) => {
      if (info.status !== 'complete') return;
      this.enqueue(async () => {
        await this.ready;
        for (const [key, b] of Object.entries(this.state.bindings)) if (b.owner?.tabId === id && !b.paused && !b.locked) await this.attach(key, true);
      }).catch(() => {});
    });
    this.api.tabs?.onRemoved?.addListener(id => this.enqueue(async () => {
      await this.ready;
      const next = structuredClone(this.state);
      for (const b of Object.values(next.bindings)) if (b.owner?.tabId === id) b.owner = null;
      await this.persist(next);
    }).catch(() => {}));
    this.api.runtime?.onStartup?.addListener(() => this.enqueue(async () => {
      await this.ready;
      const next = structuredClone(this.state);
      for (const b of Object.values(next.bindings)) b.owner = null;
      await this.persist(next);
    }).catch(() => {}));
    this.ready = (async () => {
      if (!this.api.storage.local.get) return;
      this.state = hydrateRefreshState((await this.api.storage.local.get(REFRESH_STATE_KEY))[REFRESH_STATE_KEY]);
      // Revalidate cookies before any restored binding can write.
      for (const [key, b] of Object.entries(this.state.bindings)) {
        if (b.paused || b.manualOnly) continue;
        try {
          const live = await this.live(b);
          const id = accountIdentity(b.site, live, this.now());
          if (!b.accountKey || id.accountKey !== b.accountKey) { b.paused = true; b.status = id.accountKey ? 'different' : id.status; }
        } catch { b.paused = true; b.status = 'unknown'; }
        if (!b.paused) await this.attach(key, false);
      }
      await this.persist(this.state);
    })();
    this.ready.catch(() => {});
    return this.ready;
  }
  rev(key) { return this.revisions.get(key) || 0; }
  binding(key) { return this.state.bindings[key]; }
  async live(b) { return (await this.collectCookies(b.site, b.origin, b.storeId)).map(toSnapshot); }
  async persist(next) {
    await this.api.storage.local.set({ [REFRESH_STATE_KEY]: next });
    this.state = next;
    await this.sync();
  }
  async sync() {
    await syncFlushScript(this.api.scripting, this.state.bindings).catch(() => {});
    await this.badge().catch(() => {});
  }
  async badge() {
    if (!this.api.action?.setBadgeText) return;
    const list = await readProfiles();
    const count = list.filter(p => (p.keyExpiryTimes || []).some(t => t * 1000 <= this.now() + 3 * 86400000)
      || this.now() - (p.lastRefreshedAt || p.savedAt) >= 7 * 86400000).length;
    await this.api.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : '' }).catch(() => {});
  }
  clearTimer(key) { const t = this.timers.get(key); if (t) clearTimeout(t.timer); this.timers.delete(key); }
  schedule(key, at) {
    const b = this.binding(key);
    if (!b || b.paused || b.locked || b.manualOnly || !b.accountKey) return;
    const startedAt = this.timers.get(key)?.startedAt ?? at;
    this.clearTimer(key);
    const generation = b.generation;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.enqueue(() => this.autoWrite(key, generation, startedAt)).catch(() => {});
    }, debounceDelay(startedAt, this.now()));
    this.timers.set(key, { timer, startedAt });
  }
  async pause(key, status) {
    const b = this.binding(key); if (!b) return;
    this.clearTimer(key);
    const next = structuredClone(this.state);
    next.bindings[key] = { ...b, status, paused: true, locked: false, generation: crypto.randomUUID(), owner: null };
    await this.persist(next);
  }
  check(key, generation, revision) {
    const b = this.binding(key);
    if (!b || b.generation !== generation || b.locked || b.paused || this.rev(key) !== revision) throw new Error('登录态已变化，请重试');
  }
  async captureAt(tab) {
    const target = readPageTarget(tab.url || '');
    if (!target.ok) throw new Error(target.reason);
    const storeId = await this.getStoreId(tab.id);
    const key = contextKey(target.siteKey, storeId); const revision = this.rev(key);
    const capture = await this.readCapture(tab);
    assertCapturable(capture); assertCaptureSize(capture);
    const context = { key, revision, tabId: tab.id, storeId, documentId: capture.documentId, origin: capture.origin };
    await this.verifyCapture(context, capture);
    return { capture, context };
  }
  async verifyCapture(ctx, capture) {
    const current = await this.api.tabs.get(ctx.tabId);
    if (readPageTarget(current.url || '').origin !== ctx.origin || await this.getStoreId(ctx.tabId) !== ctx.storeId) throw new Error('页面已变化，请重试');
    const live = (await this.collectCookies(capture.siteKey, ctx.origin, ctx.storeId)).map(toSnapshot);
    if (materiallyChanged(capture.cookies, live) || this.rev(ctx.key) !== ctx.revision) throw new Error('登录态已变化，请重试');
    const [doc] = await this.api.scripting.executeScript({ target: { tabId: ctx.tabId }, func: () => location.origin });
    if (!ctx.documentId || doc?.documentId !== ctx.documentId || doc?.result !== ctx.origin) throw new Error('页面已变化，请重新确认');
  }
  newBinding(profile, capture, ctx, manualOnly = false) {
    return createSiteBinding({ profile, cookies: capture.cookies, storeId: ctx.storeId, now: this.now(), manualOnly,
      owner: { tabId: ctx.tabId, documentId: ctx.documentId } });
  }
  bind(nextState, key, binding) {
    // A snapshot has one selected storage source, including across cookie stores.
    for (const [otherKey, previous] of Object.entries(nextState.bindings)) {
      if (otherKey !== key && previous.snapshotId === binding.snapshotId) {
        this.clearTimer(otherKey);
        Object.assign(previous, { paused: true, locked: false, owner: null, status: 'other-source', generation: crypto.randomUUID() });
      }
    }
    nextState.bindings[key] = binding;
  }
  async commit(profile, profiles, capture, { nextState = this.state, old = null, initial = false, guard = () => {}, savedAt = profile.savedAt } = {}) {
    let backup = await readProtectedBackup(profile.id);
    const extra = { [REFRESH_STATE_KEY]: nextState };
    if (!backup) {
      const source = initial ? 'initial-save' : old?.prev ? 'migration-prev' : 'migration-current';
      backup = protectedBackup(initial ? capture : old?.prev || old || capture, source, this.now());
      extra[backupKey(profile.id)] = backup;
    }
    const id = accountIdentity(profile.siteKey, capture.cookies, this.now());
    const draft = { ...profile, ...capture, savedAt, lastRefreshedAt: this.now(), canRollback: Boolean(capture.prev),
      accountKey: profile.accountKey || id.accountKey, backupAt: backup.at, backupSource: backup.source,
      keyExpiryTimes: id.expiresAt == null ? [] : [id.expiresAt / 1000] };
    const next = initial ? upsertProfile(profiles, draft, savedAt) : replaceProfile(profiles, profile.id, draft, savedAt);
    guard();
    try { await commitProfile(next, profile.id, capture, extra); }
    catch (error) {
      for (const [key, b] of Object.entries(this.state.bindings)) if (b.snapshotId === profile.id) {
        this.clearTimer(key); b.paused = true; b.status = 'write-failed'; b.generation = crypto.randomUUID();
      }
      throw error;
    }
    this.state = nextState;
    await this.sync();
    return next;
  }
  async save(tab, name) {
    await this.ready;
    const label = normalizeName(name); const { capture, context: ctx } = await this.captureAt(tab);
    const profiles = await readProfiles();
    if (profiles.some(p => p.siteKey === capture.siteKey && p.name === label)) throw new Error(`已经有一个叫「${label}」的账号了，请使用不同名字另存`);
    const profile = { ...capture, name: label, id: crypto.randomUUID(), savedAt: this.now() };
    const nextState = structuredClone(this.state);
    this.bind(nextState, ctx.key, this.newBinding(profile, capture, ctx));
    this.clearTimer(ctx.key);
    await this.commit(profile, profiles, cloneCapture(capture), { nextState, initial: true, guard: () => { if (this.rev(ctx.key) !== ctx.revision) throw new Error('登录态已变化，请重试'); } });
    await this.attach(ctx.key, false);
    return { view: await this.inspect(tab), effect: { type: 'saved', name: label, cookieCount: capture.cookies.length,
      storageCount: Object.keys(capture.localStorage).length + Object.keys(capture.sessionStorage).length } };
  }
  async confirm(kind, profile, stamp, supplied) {
    const fingerprint = await digest(stamp); const now = this.now();
    for (const [token, p] of this.pending) if (p.expires < now) this.pending.delete(token);
    const previous = supplied ? this.pending.get(supplied) : null;
    if (supplied) this.pending.delete(supplied);
    if (previous && previous.kind === kind && previous.profileId === profile.id && previous.fingerprint === fingerprint) return null;
    if (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value);
    const token = crypto.randomUUID();
    this.pending.set(token, { kind, profileId: profile.id, fingerprint, expires: now + 60_000 });
    return { needsConfirm: true, confirm: { kind, profileId: profile.id, name: profile.name, token, changed: Boolean(supplied) } };
  }
  async update(tab, profileId, token) {
    await this.ready;
    const profiles = await readProfiles(); const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('找不到这个账号快照');
    const previous = await readProfileCapture(profileId);
    if (!previous) throw new Error('找不到这个账号的登录态');
    const { capture, context: ctx } = await this.captureAt(tab);
    if (profile.origin !== capture.origin || profile.siteKey !== capture.siteKey) throw new Error('请先打开保存这个账号时的页面');
    const id = compareIdentity(profile.siteKey, previous?.cookies, capture.cookies, this.now());
    if (profile.accountKey && id.accountKey && profile.accountKey !== id.accountKey) id.status = 'different';
    if (id.status === 'different' || id.status === 'logged-out') throw new Error('当前账号与快照不符或登录凭据已失效，请另存或重新登录');
    const b = this.binding(ctx.key);
    const manual = id.status !== 'same' || b?.manualOnly;
    if (manual) {
      if (b?.snapshotId !== profileId) throw new Error('身份待确认，请先切换到目标快照或另存');
      const confirmation = await this.confirm('update', profile, canonical({ ctx, generation: b.generation, before: captureStamp(previous), next: captureStamp(capture) }), token);
      if (confirmation) return confirmation;
    }
    await this.verifyCapture(ctx, capture);
    const nextState = structuredClone(this.state);
    this.bind(nextState, ctx.key, this.newBinding(profile, capture, ctx, Boolean(manual)));
    this.clearTimer(ctx.key);
    await this.commit(profile, profiles, stageCapture(previous, capture), { nextState, old: previous, savedAt: this.now(), guard: () => {
      if (this.rev(ctx.key) !== ctx.revision) throw new Error('登录态已变化，请重新确认');
    } });
    await this.attach(ctx.key, false);
    return { view: await this.inspect(tab), effect: { type: 'updated', name: profile.name } };
  }
  async autoWrite(key, generation, startedAt = this.now(), storage = null) {
    await this.ready;
    const b = this.binding(key);
    if (!b || b.generation !== generation || b.paused || b.locked || b.manualOnly || !b.accountKey || !writebackBudgetRemaining(startedAt, this.now())) return false;
    const revision = this.rev(key);
    const profiles = await readProfiles(); const profile = profiles.find(p => p.id === b.snapshotId);
    const old = profile && await readProfileCapture(profile.id);
    if (!old) { await this.pause(key, 'unknown'); return false; }
    const cookies = await this.live(b);
    const identity = compareIdentity(b.site, old.cookies, cookies, this.now());
    if (identity.status !== 'same' || identity.accountKey !== b.accountKey || (profile.accountKey && profile.accountKey !== b.accountKey)) {
      await this.pause(key, identity.accountKey && identity.accountKey !== b.accountKey ? 'different' : identity.status); return false;
    }
    const next = { ...cloneCapture(old), cookies, ...(storage || {}) };
    if (captureStamp(old) === captureStamp(next)) return true;
    const storageChanged = canonical([old.localStorage, old.sessionStorage]) !== canonical([next.localStorage, next.sessionStorage]);
    const staged = storageChanged || unconfirmedMaterialChange(old.cookies, cookies) ? stageCapture(old, next) : refreshCookiesInPlace(old, cookies);
    this.check(key, generation, revision);
    const again = await this.live(b);
    if (materiallyChanged(cookies, again)) return false;
    if (!writebackBudgetRemaining(startedAt, this.now())) return false;
    await this.commit(profile, profiles, staged, { old, guard: () => {
      this.check(key, generation, revision);
      if (!writebackBudgetRemaining(startedAt, this.now())) throw new Error('自动更新超时，原快照已保留');
    } });
    return true;
  }
  async attach(key, navigation) {
    const b = this.binding(key);
    if (!b?.owner || b.paused || b.locked || b.manualOnly || !b.accountKey) return;
    try {
      const tab = await this.api.tabs.get(b.owner.tabId);
      if (new URL(tab.url).origin !== b.origin || await this.getStoreId(tab.id) !== b.storeId) return;
      const id = accountIdentity(b.site, await this.live(b), this.now());
      if (id.accountKey !== b.accountKey) return;
      const [doc] = await this.api.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.origin });
      if (!doc?.documentId || doc.result !== b.origin) return;
      if (!navigation && doc.documentId !== b.owner.documentId) return;
      if (this.binding(key)?.generation !== b.generation) return;
      // Navigation may advance only the selected source tab; other tabs never acquire ownership.
      if (doc.documentId !== b.owner.documentId) {
        const next = structuredClone(this.state); next.bindings[key].owner.documentId = doc.documentId;
        await this.persist(next);
      }
      await this.api.scripting.executeScript({ target: { tabId: tab.id, documentIds: [doc.documentId] }, files: ['src/page-hide.js'] });
    } catch { /* A missing/restricted page cannot replace saved storage with an empty read. */ }
  }
  async observer(message, sender) {
    await this.ready;
    if (sender?.id !== this.api.runtime.id || sender.frameId !== 0 || !sender.tab?.id || !sender.documentId || !sender.origin) return null;
    const target = readPageTarget(sender.url || '');
    if (!target.ok || target.origin !== sender.origin) return null;
    const storeId = await this.getStoreId(sender.tab.id); const key = contextKey(target.siteKey, storeId);
    const b = this.binding(key);
    if (!b || b.paused || b.locked || b.manualOnly || b.origin !== sender.origin || b.owner?.tabId !== sender.tab.id || b.owner.documentId !== sender.documentId) return null;
    if (message.type === 'observer-ready') {
      if (accountIdentity(b.site, await this.live(b), this.now()).accountKey !== b.accountKey) return null;
      return { generation: b.generation, origin: b.origin };
    }
    if (message.generation !== b.generation || message.origin !== b.origin) return null;
    const valid = v => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');
    if (!valid(message.localStorage) || !valid(message.sessionStorage)) return null;
    await this.autoWrite(key, b.generation, this.now(), { localStorage: message.localStorage, sessionStorage: message.sessionStorage });
    return null;
  }
  async beforeSwitch(tab, site) {
    await this.ready;
    const key = contextKey(site, await this.getStoreId(tab.id)); const b = this.binding(key);
    if (b && !b.paused && b.owner?.tabId === tab.id) {
      try {
        const [read] = await this.api.scripting.executeScript({ target: { tabId: tab.id }, func: readPageStorage });
        if (read?.documentId === b.owner.documentId && read.result?.origin === b.origin) await this.autoWrite(key, b.generation, this.now(), {
          localStorage: read.result.localStorage, sessionStorage: read.result.sessionStorage,
        });
      } catch { /* Failing a best-effort flush never clears the stored capture. */ }
    }
    this.clearTimer(key);
    const next = structuredClone(this.state);
    next.bindings[key] = { ...(b || { site, origin: new URL(tab.url).origin, storeId: await this.getStoreId(tab.id) }),
      locked: true, paused: true, status: 'interrupted', owner: null, generation: crypto.randomUUID() };
    await this.persist(next); return key;
  }
  async afterSwitch(tab, profile, failedCount = 0) {
    const storeId = await this.getStoreId(tab.id); const key = contextKey(profile.siteKey, storeId);
    if (failedCount) { await this.pause(key, 'interrupted'); return; }
    const cookies = await this.live({ site: profile.siteKey, origin: profile.origin, storeId });
    const saved = await readProfileCapture(profile.id);
    const id = compareIdentity(profile.siteKey, saved.cookies, cookies, this.now());
    if (id.status === 'different' || id.status === 'logged-out' || (profile.accountKey && id.accountKey && profile.accountKey !== id.accountKey)) {
      await this.pause(key, id.status === 'logged-out' ? 'logged-out' : 'different'); return;
    }
    const [doc] = await this.api.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.origin });
    const next = structuredClone(this.state);
    this.bind(next, key, createSiteBinding({ profile, storeId, cookies, now: this.now(), owner: doc?.result === profile.origin && doc.documentId ? { tabId: tab.id, documentId: doc.documentId } : null }));
    await this.persist(next); await this.attach(key, false);
  }
  async forget(profileId) {
    const next = structuredClone(this.state);
    for (const [key, b] of Object.entries(next.bindings)) if (b.snapshotId === profileId) { this.clearTimer(key); delete next.bindings[key]; }
    await this.persist(next);
  }
  async backupAction(tab, profileId, action, token) {
    await this.ready;
    const profiles = await readProfiles(); const profile = profiles.find(p => p.id === profileId);
    const current = profile && await readProfileCapture(profileId);
    if (!current) throw new Error('找不到这个账号快照');
    if (readPageTarget(tab.url).siteKey !== profile.siteKey) throw new Error('当前网站和这个快照不一致');
    if (action === 'set-protected-backup') {
      const confirmation = await this.confirm('set-protected-backup', profile, captureStamp(current), token);
      if (confirmation) return confirmation;
      const backup = protectedBackup(current, 'user-confirmed', this.now());
      await this.api.storage.local.set({ [backupKey(profileId)]: backup,
        profiles: profiles.map(p => p.id === profileId ? { ...p, backupAt: backup.at, backupSource: backup.source } : p) });
      return { view: await this.inspect(tab), effect: { type: 'backup-set', name: profile.name } };
    }
    let next;
    if (action === 'rollback') {
      if (!current.prev) throw new Error('没有可撤销的上一版');
      next = rollbackCapture(current).capture;
    } else {
      const backup = await readProtectedBackup(profileId);
      if (!backup) throw new Error('没有保护备份');
      next = stageCapture(current, backup.capture);
    }
    const nextState = structuredClone(this.state);
    for (const [key, b] of Object.entries(nextState.bindings)) if (b.snapshotId === profileId) {
      this.clearTimer(key); Object.assign(b, { paused: true, status: 'recovered', owner: null, locked: false, generation: crypto.randomUUID() });
    }
    await this.commit(profile, profiles, next, { old: current, nextState });
    return { view: await this.inspect(tab), effect: { type: 'snapshot-restored', name: profile.name } };
  }
  async inspect(tab) {
    await this.ready;
    const target = readPageTarget(tab.url || '');
    if (!target.ok) return { phase: 'unsupported', reason: target.reason };
    const storeId = await this.getStoreId(tab.id); const b = this.binding(contextKey(target.siteKey, storeId));
    const all = await readProfiles(); const profiles = all.filter(p => p.siteKey === target.siteKey);
    const live = await this.live({ site: target.siteKey, origin: target.origin, storeId });
    const id = accountIdentity(target.siteKey, live, this.now());
    const matches = [];
    for (const p of profiles) {
      const accountKey = p.accountKey || accountIdentity(p.siteKey, (await readProfileCapture(p.id))?.cookies, 0).accountKey;
      if (id.accountKey && id.accountKey === accountKey) matches.push(p.id);
    }
    const currentProfileId = matches.includes(b?.snapshotId) ? b.snapshotId : matches.length === 1 ? matches[0] : null;
    const bound = b && profiles.find(p => p.id === b.snapshotId);
    let identityStatus = id.status === 'verified' ? (bound && currentProfileId !== b.snapshotId ? 'different' : 'same') : id.status;
    if (bound && b.manualOnly && identityStatus === 'same') identityStatus = 'unknown';
    const status = b?.paused ? b.status : identityStatus;
    const canConfirmUpdate = Boolean(bound && identityStatus === 'unknown' && target.origin === bound.origin);
    const canUpdate = Boolean(currentProfileId && identityStatus === 'same' && profiles.find(p => p.id === currentProfileId)?.origin === target.origin);
    return { phase: 'ready', ...target, loggedIn: id.status !== 'logged-out',
      boundProfileId: bound?.id || null, currentProfileId: identityStatus === 'unknown' ? null : currentProfileId,
      identityStatus, status, statusLabel: labels[status] || '', canUpdate, canConfirmUpdate,
      autoRefreshEnabled: Boolean(bound && !b.paused && !b.manualOnly && identityStatus === 'same'),
      pendingUpdate: canConfirmUpdate, prompt: identityStatus === 'different' || identityStatus === 'unknown' ? 'save-as-new' : null,
      profiles: profiles.map(p => ({ ...summarizeProfile(p, identityStatus === 'unknown' ? null : currentProfileId, this.now()),
        canRollback: p.canRollback === true, backupAt: p.backupAt || null, backupSource: p.backupSource || null,
        refreshLabel: formatRefreshLabel(p.lastRefreshedAt, this.now()),
        expiryLabel: formatExpiryLabel((p.keyExpiryTimes || []).length ? Math.min(...p.keyExpiryTimes) * 1000 : null, this.now()) })) };
  }
  dispose() { for (const key of this.timers.keys()) this.clearTimer(key); }
}
