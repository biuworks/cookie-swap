import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  applyDecision,
  assessKeyCookieExpiry,
  BUILTIN_SITE_RULES,
  buildRefreshView,
  debounceDelay,
  evaluateLiveCookies,
  initialRefreshState,
  MAX_WAIT_MS,
  reduceRefresh,
  resolveClassification,
  rollbackCapture,
  stageCapture,
  TRAIL_MS,
  WRITEBACK_BUDGET_MS,
  writebackBudgetRemaining,
} from "../src/refresh.js";

const SITE = "example.com";
const BOUND = { site: SITE, snapshotId: "a", status: "ok", pendingUpdate: false, paused: false };

function cookie(name, value, extra = {}) {
  return {
    name,
    value,
    domain: extra.domain || SITE,
    path: extra.path || "/",
    session: extra.session === true,
    expirationDate: extra.expirationDate,
  };
}

function createDriver(binding = BOUND) {
  let state = initialRefreshState({ binding });
  let due = null;
  const writes = [];
  function fireIfDue(at) {
    if (!due || at < due.at) return false;
    const when = due.at;
    const generation = due.generation;
    due = null;
    const fired = reduceRefresh(state, { type: "timer", at: when, generation });
    state = fired.state;
    if (fired.effect.type === "write") writes.push(when);
    return fired.effect.type === "write";
  }
  function send(event) {
    fireIfDue(event.at ?? 0);
    const result = reduceRefresh(state, event);
    state = result.state;
    if (result.effect.type === "schedule") {
      due = { at: event.at + result.effect.delay, generation: result.effect.generation };
    } else if (result.effect.type === "write") {
      writes.push(event.at);
      due = null;
    } else if (result.effect.type === "cancel" || result.effect.type === "drop") {
      due = null;
    }
    return result;
  }
  return {
    send,
    elapse(at) {
      return fireIfDue(at);
    },
    get writes() {
      return writes;
    },
    get state() {
      return state;
    },
    get due() {
      return due;
    },
  };
}

test("assertion 1: cookie changes during the switch lock are not written back, even after unlock", () => {
  const driver = createDriver();
  const scheduled = driver.send({ type: "cookie", at: 0, site: SITE, snapshotId: "a" });
  assert.equal(scheduled.effect.type, "schedule");
  const generation = scheduled.effect.generation;

  const locked = driver.send({ type: "lock" });
  assert.equal(locked.effect.type, "cancel");
  assert.equal(driver.state.locked, true);
  assert.equal(driver.state.binding, null);
  assert.equal(driver.due, null);

  for (const at of [10, 100, 1_000]) {
    const during = driver.send({ type: "cookie", at, site: SITE, snapshotId: "a" });
    assert.equal(during.effect.type, "ignore-locked");
    assert.equal(during.effect.writeCount, 0);
  }
  assert.equal(driver.due, null, "锁内变化不能排进防抖");

  driver.send({ type: "unlock" });
  assert.equal(driver.state.locked, false);
  assert.equal(driver.state.debounce, null);
  driver.elapse(60_000);
  const stale = driver.send({ type: "timer", at: 60_000, generation });
  assert.notEqual(stale.effect.type, "write");
  driver.send({
    type: "bind",
    binding: { site: SITE, snapshotId: "b", status: "ok" },
  });
  driver.elapse(120_000);
  assert.equal(driver.writes.length, 0);
  assert.equal(driver.state.writeCount, 0);
});

test("assertion 2: changes inside 1.5s collapse into one write, and a burst still writes by 3s", () => {
  assert.equal(TRAIL_MS, 1_500);
  assert.equal(MAX_WAIT_MS, 3_000);
  assert.equal(WRITEBACK_BUDGET_MS, 5_000);
  assert.equal(debounceDelay(0, 0), 1_500);
  assert.equal(debounceDelay(0, 1_000), 1_500);
  assert.equal(debounceDelay(0, 2_000), 1_000);
  assert.equal(debounceDelay(0, 3_000), 0);
  assert.equal(writebackBudgetRemaining(0, 1_500), 3_500);
  assert.equal(writebackBudgetRemaining(0, 3_000), 2_000);
  assert.equal(writebackBudgetRemaining(0, 5_000), 0);

  const merged = createDriver();
  merged.send({ type: "cookie", at: 0, site: SITE, snapshotId: "a" });
  merged.send({ type: "cookie", at: 500, site: SITE, snapshotId: "a" });
  merged.send({ type: "cookie", at: 1_000, site: SITE, snapshotId: "a" });
  assert.deepEqual(merged.writes, []);
  assert.equal(merged.due.at, 2_500, "尾随窗口从最后一次变化再等 1.5s");
  assert.equal(merged.elapse(2_499), false);
  assert.equal(merged.elapse(2_500), true);
  assert.deepEqual(merged.writes, [2_500]);
  assert.equal(merged.elapse(10_000), false);

  const burst = createDriver();
  for (let at = 0; at <= 3_000; at += 200) {
    burst.send({ type: "cookie", at, site: SITE, snapshotId: "a" });
  }
  assert.equal(burst.writes.length, 1);
  assert.ok(burst.writes[0] <= 3_000);
  assert.equal(burst.writes[0], 3_000);
});

test("assertion 3: rollback restores only the previous capture and then canRollback is false", () => {
  const v1 = { cookies: [cookie("sid", "1")], localStorage: { token: "1" }, sessionStorage: {} };
  const v2 = stageCapture(v1, { cookies: [cookie("sid", "2")], localStorage: { token: "2" }, sessionStorage: {} });
  const v3 = stageCapture(v2, { cookies: [cookie("sid", "3")], localStorage: { token: "3" }, sessionStorage: { tab: "x" } });

  assert.equal(v3.cookies[0].value, "3");
  assert.equal(v3.prev.cookies[0].value, "2", "只留一层上一版，更早的 v1 被丢掉");
  assert.equal(v3.prev.prev, undefined);

  const rolled = rollbackCapture(v3);
  assert.equal(rolled.canRollback, false);
  assert.equal(rolled.capture.prev, null);
  assert.equal(rolled.capture.cookies[0].value, "2");
  assert.equal(rolled.capture.localStorage.token, "2");

  const again = rollbackCapture(rolled.capture);
  assert.equal(again.canRollback, false);
  assert.equal(again.capture.cookies[0].value, "2");

  const view = buildRefreshView({
    view: {
      phase: "ready",
      siteKey: SITE,
      profiles: [{ id: "a", name: "工作号", active: true, savedAt: 1 }],
    },
    profiles: [{ id: "a", canRollback: false, savedAt: 1, keyExpiryTimes: [] }],
    refreshState: { binding: { site: SITE, snapshotId: "a", status: "ok", pendingUpdate: false }, notice: null },
    now: 10_000,
  });
  assert.equal(view.canRollback, false);
  assert.equal(view.boundProfileId, "a");
});

test("assertion 4: when all three layers miss, status is identity-unknown and nothing is written", () => {
  const baseline = [cookie("session", "old", { session: true })];
  const live = [cookie("session", "new", { session: true })];
  const classification = resolveClassification({
    siteKey: "unknown.test",
    baseline,
    live,
    builtin: BUILTIN_SITE_RULES,
    user: { "other.test": { auth: ["session"], identity: ["uid"] } },
    learned: { auth: ["missing-auth"], identity: ["missing-uid"] },
  });
  assert.equal(classification.classified, false);
  assert.equal(classification.source, "unknown");

  const decision = evaluateLiveCookies({ classification, baseline, live, now: 0 });
  assert.equal(decision.status, "identity-unknown");
  assert.equal(decision.pendingUpdate, true);
  assert.equal(decision.write, false);
  assert.notEqual(decision.action, "write");

  const applied = applyDecision(initialRefreshState({
    binding: { site: "unknown.test", snapshotId: "a", status: "ok", pendingUpdate: false },
  }), decision);
  assert.equal(applied.committed, false);
  assert.equal(applied.state.writeCount, 0);
  assert.equal(applied.state.binding.status, "identity-unknown");
  assert.equal(applied.state.binding.pendingUpdate, true);

  const follow = reduceRefresh(applied.state, {
    type: "cookie",
    at: 5_000,
    site: "unknown.test",
    snapshotId: "a",
  });
  assert.equal(follow.effect.type, "ignore-paused");
  assert.equal(follow.effect.writeCount, 0);
  assert.equal(follow.state.writeCount, 0);
});

test("assertion 5: an expired key cookie sets maybe-logged-out and expiresAt is the earliest", () => {
  const now = 200_000;
  const cookies = [
    cookie("sid", "a", { expirationDate: 100 }),
    cookie("token", "b", { expirationDate: 500 }),
    cookie("uid", "1", { expirationDate: 9_000 }),
  ];
  const assessed = assessKeyCookieExpiry(cookies, ["sid", "token"], now);
  assert.equal(assessed.status, "maybe-logged-out");
  assert.equal(assessed.expiresAt, 100_000);

  const stillValid = assessKeyCookieExpiry(cookies, ["sid", "token"], 50_000);
  assert.equal(stillValid.status, "ok");
  assert.equal(stillValid.expiresAt, 100_000, "还没过期时也取最早的那个时间");

  const decision = evaluateLiveCookies({
    classification: { classified: true, auth: ["sid", "token"], identity: ["uid"], source: "builtin" },
    baseline: cookies,
    live: cookies,
    now,
  });
  assert.equal(decision.status, "maybe-logged-out");
  assert.equal(decision.write, false);
  assert.equal(decision.expiresAt, 100_000);

  const view = buildRefreshView({
    view: {
      phase: "ready",
      siteKey: SITE,
      profiles: [{ id: "a", name: "工作号", active: true, savedAt: 1 }],
    },
    profiles: [{
      id: "a",
      savedAt: 1,
      keyExpiryTimes: [100, 500],
      lastRefreshedAt: now - 2 * 86_400_000,
      canRollback: false,
    }],
    refreshState: {
      binding: { site: SITE, snapshotId: "a", status: "ok", pendingUpdate: true, expiresAt: 500_000 },
      notice: null,
    },
    now,
  });
  assert.equal(view.status, "maybe-logged-out");
  assert.equal(view.expiresAt, 100_000);
  assert.equal(view.pendingUpdate, false);
  assert.equal(view.statusLabel, "可能已登出");
});

test("assertion 6: manifest permissions are unchanged", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, ["cookies", "storage", "tabs", "scripting", "unlimitedStorage"]);
  assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.permissions.includes("declarativeNetRequest"), false);
  assert.equal(manifest.permissions.includes("webRequest"), false);
  assert.equal(manifest.permissions.includes("notifications"), false);
});

test("assertion 7: an unbound site never increments the writeback count", () => {
  let state = initialRefreshState();
  let writes = 0;
  for (const site of ["a.test", "b.test", SITE]) {
    const result = reduceRefresh(state, { type: "cookie", at: 0, site, snapshotId: "x" });
    state = result.state;
    assert.equal(result.effect.type, "ignore-unbound");
    assert.equal(result.effect.writeCount, 0);
    if (result.effect.type === "write") writes += 1;
  }
  assert.equal(writes, 0);
  assert.equal(state.writeCount, 0);
  assert.equal(state.unboundEvents, 3);

  const bound = createDriver();
  const other = bound.send({ type: "cookie", at: 0, site: "other.test", snapshotId: "a" });
  assert.equal(other.effect.type, "ignore-unbound");
  assert.equal(other.effect.writeCount, 0);
  bound.elapse(10_000);
  assert.equal(bound.writes.length, 0);
  assert.equal(bound.state.writeCount, 0);

  const background = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
  const refresh = fs.readFileSync(new URL("../src/refresh.js", import.meta.url), "utf8");
  assert.equal(background.includes("chrome.storage.session"), false);
  assert.equal(refresh.includes("chrome.storage.session"), false);
  assert.match(background, /cookies\?\.onChanged|cookies\.onChanged/);
  assert.doesNotMatch(`${background}\n${refresh}`, /chrome\.declarativeNetRequest|chrome\.webRequest/);
});

test("builtin rules win, then per-site user rules, then a learned rotation", () => {
  const github = resolveClassification({
    siteKey: "github.com",
    baseline: [],
    live: [
      cookie("user_session", "old", { domain: "github.com" }),
      cookie("dotcom_user", "octocat", { domain: "github.com", expirationDate: 9_000 }),
    ],
    builtin: BUILTIN_SITE_RULES,
    user: { "github.com": { auth: ["custom"], identity: ["custom-id"] } },
  });
  assert.equal(github.source, "builtin");
  assert.deepEqual(github.auth, ["user_session"]);
  assert.deepEqual(github.identity, ["dotcom_user"]);

  const configured = resolveClassification({
    siteKey: "shop.test",
    baseline: [],
    live: [cookie("session", "a", { domain: "shop.test" }), cookie("uid", "1", { domain: "shop.test", expirationDate: 50 })],
    builtin: BUILTIN_SITE_RULES,
    user: { "shop.test": { auth: ["session"], identity: ["uid"] } },
    learned: { auth: ["other"], identity: ["thing"] },
  });
  assert.equal(configured.source, "user");

  const learned = resolveClassification({
    siteKey: "shop.test",
    baseline: [
      cookie("session", "a", { session: true }),
      cookie("uid", "1", { expirationDate: 50 }),
    ],
    live: [
      cookie("session", "b", { session: true }),
      cookie("uid", "1", { expirationDate: 50 }),
    ],
    builtin: {},
    user: {},
    learned: null,
  });
  assert.equal(learned.source, "learned");
  assert.deepEqual(learned.auth, ["session"]);
  assert.deepEqual(learned.identity, ["uid"]);

  const rotated = evaluateLiveCookies({
    classification: learned,
    baseline: [
      cookie("session", "a", { session: true }),
      cookie("uid", "1", { expirationDate: 50 }),
    ],
    live: [
      cookie("session", "b", { session: true }),
      cookie("uid", "1", { expirationDate: 80 }),
    ],
    now: 1_000,
  });
  assert.equal(rotated.action, "write");
  assert.equal(rotated.write, true);

  const switched = evaluateLiveCookies({
    classification: learned,
    baseline: [
      cookie("session", "a", { session: true }),
      cookie("uid", "1", { expirationDate: 50 }),
    ],
    live: [
      cookie("session", "c", { session: true }),
      cookie("uid", "2", { expirationDate: 50 }),
    ],
    now: 1_000,
  });
  assert.equal(switched.action, "unbind");
  assert.equal(switched.status, "identity-changed");
  assert.equal(switched.prompt, "save-as-new");
  assert.equal(switched.write, false);

  const loggedOut = evaluateLiveCookies({
    classification: learned,
    baseline: [
      cookie("session", "a", { session: true }),
      cookie("uid", "1", { expirationDate: 50 }),
    ],
    live: [cookie("uid", "1", { expirationDate: 50 })],
    now: 1_000,
  });
  assert.equal(loggedOut.action, "pause");
  assert.equal(loggedOut.status, "maybe-logged-out");
  assert.equal(loggedOut.write, false);
});
