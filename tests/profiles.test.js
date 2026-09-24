import assert from "node:assert/strict";
import test from "node:test";
import { describeEffect, formatSavedAt, formatSavedAtExact, profileMeta } from "../src/format.js";
import {
  assertCapturable,
  assertCaptureSize,
  assertUpdatable,
  dropUndo,
  normalizeName,
  replaceProfile,
  resolveActiveId,
  saveHint,
  staleUndoIds,
  stashUndo,
  summarizeProfile,
  takeUndo,
  upsertProfile,
  UNDO_TTL_MS,
} from "../src/profiles.js";

test("account names collapse whitespace and reject empties", () => {
  assert.equal(normalizeName("  工作  号 \n"), "工作 号");
  assert.throws(() => normalizeName("   "), /名字/);
  assert.throws(() => normalizeName("字".repeat(41)), /40/);
  assert.equal(normalizeName("字".repeat(40)), "字".repeat(40));
});

test("saving the same name on a site replaces that snapshot", () => {
  const first = upsertProfile([], {
    id: "new",
    name: "工作号",
    siteKey: "example.com",
    origin: "https://shop.example.com",
    hostLabel: "shop.example.com",
    cookies: [{ name: "sid", value: "a" }],
    localStorage: { token: "a" },
    sessionStorage: {},
  }, 10);
  const second = upsertProfile(first, {
    id: "other",
    name: "工作号",
    siteKey: "example.com",
    origin: "https://shop.example.com",
    hostLabel: "shop.example.com",
    cookies: [{ name: "sid", value: "b" }],
    localStorage: {},
    sessionStorage: { tab: "1" },
  }, 20);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, "new");
  assert.equal(second[0].cookies, undefined);
  assert.equal(second[0].cookieCount, 1);
  assert.equal(second[0].identity.find(([key]) => key.startsWith("c:sid|"))[1], "b");
  assert.equal(second[0].savedAt, 20);

  const otherSite = upsertProfile(second, {
    id: "elsewhere",
    name: "工作号",
    siteKey: "other.test",
    origin: "https://other.test",
    hostLabel: "other.test",
    cookies: [],
    localStorage: { token: "c" },
    sessionStorage: {},
  }, 30);
  assert.equal(otherSite.length, 2);
});

test("summary shown in the popup does not include session values", () => {
  const [profile] = upsertProfile([], {
    id: "id",
    name: "个人号",
    siteKey: "example.com",
    origin: "https://example.com",
    hostLabel: "example.com",
    cookies: [{ name: "sid", value: "secret" }],
    localStorage: { token: "secret" },
    sessionStorage: { a: "b" },
  }, 5);
  const summary = summarizeProfile(profile, "id");
  assert.deepEqual(Object.keys(summary).sort(), [
    "active", "cookieCount", "expiredCount", "hostLabel", "id", "name", "origin", "savedAt", "storageCount",
  ]);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
  assert.equal(summary.cookieCount, 1);
  assert.equal(summary.storageCount, 2);
  assert.equal(summary.expiredCount, 0);
  assert.equal(summary.active, true);
  assert.equal(saveHint("个人号", [summary]), "将覆盖「个人号」");
  assert.equal(saveHint("新号", [summary]), "");
});

test("expired credential count is computed from stored expiry times", () => {
  const now = new Date(2026, 8, 22, 15, 30, 0).getTime();
  const seconds = now / 1000;
  const [profile] = upsertProfile([], {
    id: "id",
    name: "工作号",
    siteKey: "example.com",
    origin: "https://example.com",
    hostLabel: "example.com",
    cookies: [
      { name: "a", value: "1", expirationDate: seconds - 60 },
      { name: "b", value: "2", expirationDate: seconds + 60 },
      { name: "session", value: "3", session: true },
    ],
    localStorage: {},
    sessionStorage: {},
  }, now);

  // 只存时间戳，列表记录里没有 Cookie 的名字和值
  assert.deepEqual(profile.expiryTimes, [seconds - 60, seconds + 60]);
  assert.equal(profile.cookieCount, 3);
  assert.equal(summarizeProfile(profile, "id", now).expiredCount, 1);
  // 时间往后走，同样的记录会算出不同的过期数 —— 这就是不能存进索引的原因
  assert.equal(summarizeProfile(profile, "id", now + 120_000).expiredCount, 2);
});

test("delete undo can be taken back within the window and expires after it", () => {
  const now = 1000;
  const profile = { id: "p1", name: "工作号", siteKey: "example.com" };
  let map = stashUndo({}, profile, now);
  assert.deepEqual(Object.keys(map), ["p1"]);

  const taken = takeUndo(map, "p1", now + UNDO_TTL_MS - 1);
  assert.equal(taken.profile, profile);
  assert.deepEqual(taken.map, {}, "取回后撤销记录应当被清掉");

  map = stashUndo({}, profile, now);
  const late = takeUndo(map, "p1", now + UNDO_TTL_MS + 1);
  assert.equal(late.profile, null, "超过时限就不能再撤销");
  assert.deepEqual(late.map, {});

  map = stashUndo(stashUndo({}, profile, now), { id: "p2" }, now);
  assert.deepEqual(staleUndoIds(map, now + UNDO_TTL_MS - 1), [], "还没到点的不算过期");
  assert.deepEqual(staleUndoIds(map, now + UNDO_TTL_MS + 1).sort(), ["p1", "p2"]);
  assert.deepEqual(dropUndo(map, ["p1"]), { p2: map.p2 });
  assert.deepEqual(staleUndoIds({}, 999), []);
});

test("empty and oversized captures are refused", () => {
  assert.throws(() => assertCapturable({ cookies: [], localStorage: {}, sessionStorage: {} }), /IndexedDB/);
  assert.doesNotThrow(() => assertCapturable({ cookies: [{ name: "sid" }], localStorage: {}, sessionStorage: {} }));
  const huge = { cookies: [], localStorage: { blob: "x".repeat(8_000_001) }, sessionStorage: {} };
  assert.throws(() => assertCaptureSize(huge), /8MB/);
});

test("only the account currently in use may be overwritten", () => {
  // 这是那次真实的数据丢失：以 A 登录着去点 B 的「更新」，B 会被 A 的会话覆盖
  assert.throws(() => assertUpdatable("work", "personal"), /只能更新当前正在使用的账号/);
  assert.throws(() => assertUpdatable(null, "personal"), /只能更新当前正在使用的账号/);
  assert.throws(() => assertUpdatable("work", ""), /找不到这个账号快照/);
  assert.doesNotThrow(() => assertUpdatable("work", "work"));
});

test("a stale last-switched hint cannot masquerade as the account in use", () => {
  // 手动登出再登成另一个还没保存的账号：身份信息读得出来，但对不上任何快照。
  // 此时那个 hint 已经过期，不能拿它当"正在使用"——否则「更新」会覆盖错快照。
  assert.equal(resolveActiveId({ confirmedId: null, hasIdentity: true, hinted: "work" }), null);
  // 真的匹配上了就用匹配结果
  assert.equal(resolveActiveId({ confirmedId: "personal", hasIdentity: true, hinted: "work" }), "personal");
  // 页面完全读不出身份信息（未登录）时，hint 是唯一线索，才允许兜底
  assert.equal(resolveActiveId({ confirmedId: null, hasIdentity: false, hinted: "work" }), "work");
  assert.equal(resolveActiveId({}), null);
});

test("update keeps the name and refuses a different site", () => {  const profiles = [{
    id: "id",
    name: "工作号",
    siteKey: "example.com",
    origin: "https://example.com",
    hostLabel: "example.com",
    savedAt: 1,
    cookies: [],
    localStorage: { token: "old" },
    sessionStorage: {},
  }];
  const next = replaceProfile(profiles, "id", {
    siteKey: "example.com",
    origin: "https://www.example.com",
    hostLabel: "www.example.com",
    cookies: [{ name: "sid", value: "new" }],
    localStorage: {},
    sessionStorage: {},
  }, 9);
  assert.equal(next[0].name, "工作号");
  assert.equal(next[0].origin, "https://www.example.com");
  assert.throws(() => replaceProfile(profiles, "id", { siteKey: "other.test" }), /域名/);
});

test("times and switch results are phrased for the popup", () => {
  const now = new Date(2026, 8, 22, 15, 30, 0).getTime();
  assert.equal(formatSavedAt(now - 10_000, now), "刚刚");
  assert.equal(formatSavedAt(new Date(2026, 8, 22, 11, 5, 0).getTime(), now), "今天 11:05");
  assert.equal(formatSavedAt(new Date(2026, 8, 21, 9, 4, 0).getTime(), now), "昨天 09:04");
  assert.equal(formatSavedAt(new Date(2026, 8, 2, 8, 0, 0).getTime(), now), "9月2日 08:00");
  assert.equal(formatSavedAtExact(new Date(2026, 8, 2, 8, 0, 5).getTime()), "2026/09/02 08:00:05");

  // 副标题只留时间：Cookie 数量这类统计不再出现在列表里
  assert.equal(profileMeta({ savedAt: now - 5_000, cookieCount: 2, storageCount: 1 }, now), "刚刚保存");
  assert.equal(profileMeta({ savedAt: now - 3_600_000, cookieCount: 2, storageCount: 1 }, now), "今天 14:30 保存");

  assert.deepEqual(describeEffect({ type: "switched", name: "工作号", failedCount: 0, navigated: false }), {
    kind: "ok",
    text: "已切换到「工作号」，页面正在刷新",
  });
  assert.equal(describeEffect({ type: "switched", name: "工作号", failedCount: 2, navigated: true }).kind, "warn");
  assert.equal(describeEffect({ type: "fresh" }).text, "当前页面已清空并刷新。登录新账号后，点「保存当前登录」存下来。");
  assert.equal(describeEffect({ type: "renamed", name: "新名字" }).text, "已重命名为「新名字」");
  assert.equal(describeEffect({ type: "restored", name: "工作号" }).text, "已恢复「工作号」");

  // 凭证数量只在保存成功这一刻出现一次
  assert.equal(
    describeEffect({ type: "saved", name: "工作号", overwritten: false, cookieCount: 15, storageCount: 28 }).text,
    "已保存「工作号」 · 15 个 Cookie · 28 项本地存储",
  );
  assert.equal(
    describeEffect({ type: "saved", name: "工作号", overwritten: true, cookieCount: 15, storageCount: 28 }).text,
    "已覆盖「工作号」 · 15 个 Cookie · 28 项本地存储",
  );
  assert.equal(describeEffect({ type: "saved", name: "工作号", overwritten: false }).text, "已保存「工作号」");
});
