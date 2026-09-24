import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  cookieBelongsToSite,
  cookiesForRestore,
  expiredCookieCount,
  expirationTimes,
  IDENTITY_AUTH_SOURCE,
  IDENTITY_NOISE_SOURCE,
  identityEntries,
  matchActiveProfileId,
  mergeCookies,
  needsFullIdentityStorage,
  toCookieRemoveDetails,
  toCookieSetDetails,
  toSnapshot,
} from "../src/cookies.js";
import { readIdentityStorage } from "../src/page-storage.js";

test("expiry times keep only persistent cookies, as bare numbers", () => {
  const times = expirationTimes([
    { name: "b", expirationDate: 300 },
    { name: "a", expirationDate: 100 },
    { name: "session", session: true },
    { name: "no-date" },
    null,
  ]);
  assert.deepEqual(times, [100, 300]);
  assert.deepEqual(expirationTimes(undefined), []);
});

test("expired count is recomputed against the current time", () => {
  const times = [100, 200, 300];
  const at = (seconds) => expiredCookieCount(times, seconds * 1000);
  assert.equal(at(50), 0);
  assert.equal(at(150), 1);
  assert.equal(at(300), 3);
  assert.equal(at(9_999), 3);
  assert.equal(expiredCookieCount([], 0), 0);
  assert.equal(expiredCookieCount(undefined, 0), 0);
  assert.equal(expiredCookieCount(["nope"], 0), 0);
});

test("site cookie matching does not treat a suffix as the same site", () => {
  assert.equal(cookieBelongsToSite(".example.com", "example.com"), true);
  assert.equal(cookieBelongsToSite("shop.example.com", "example.com"), true);
  assert.equal(cookieBelongsToSite("notexample.com", "example.com"), false);
  assert.equal(cookieBelongsToSite("example.com.evil.test", "example.com"), false);
});

test("cookie snapshots keep host-only and session cookies settable", () => {
  const hostOnly = toSnapshot({
    name: "__Host-session",
    value: "abc",
    domain: "shop.example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    session: true,
    hostOnly: true,
  });
  const details = toCookieSetDetails(hostOnly, "0");
  assert.equal(details.url, "https://shop.example.com/");
  assert.equal(details.domain, undefined);
  assert.equal(details.path, "/");
  assert.equal(details.secure, true);
  assert.equal(details.expirationDate, undefined);
  assert.equal(details.httpOnly, true);

  const domainCookie = toSnapshot({
    name: "sid",
    value: "persist",
    domain: ".example.com",
    path: "/app",
    secure: true,
    httpOnly: false,
    sameSite: "unspecified",
    session: false,
    hostOnly: false,
    expirationDate: 2_000_000_000,
  });
  const setDetails = toCookieSetDetails(domainCookie, "1");
  assert.equal(setDetails.domain, "example.com");
  assert.equal(setDetails.url, "https://example.com/app");
  assert.equal(setDetails.expirationDate, 2_000_000_000);
  assert.equal(setDetails.sameSite, undefined);

  const securePrefixed = toCookieSetDetails({
    name: "__Secure-next-auth.session-token",
    value: "jwt",
    domain: "example.com",
    path: "/",
    secure: false,
    httpOnly: true,
    hostOnly: false,
    session: true,
  }, "0");
  assert.equal(securePrefixed.secure, true);
  assert.equal(securePrefixed.url, "https://example.com/");
  assert.equal(securePrefixed.domain, "example.com");

  const removeDetails = toCookieRemoveDetails({
    ...domainCookie,
    partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false },
  }, "1");
  assert.deepEqual(removeDetails.partitionKey, {
    topLevelSite: "https://example.com",
    hasCrossSiteAncestor: false,
  });
});

test("restore skips expired cookies and dedupes the same cookie", () => {
  const now = 1_700_000_000_000;
  const session = { name: "sid", value: "a", domain: "example.com", path: "/", session: true };
  const expired = {
    name: "old",
    value: "b",
    domain: "example.com",
    path: "/",
    session: false,
    expirationDate: 10,
  };
  assert.deepEqual(cookiesForRestore([session, expired], now).map((cookie) => cookie.name), ["sid"]);
  const merged = mergeCookies([
    [{ name: "sid", domain: "example.com", path: "/", value: "new" }],
    [{ name: "sid", domain: "example.com", path: "/", value: "old" }, { name: "", value: "x" }],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, "old");
});

test("account identity follows auth cookies, not incidental storage", () => {
  const cookieAccount = {
    cookies: [
      { name: "_ga", domain: "example.com", path: "/", value: "1" },
      { name: "session", domain: "example.com", path: "/", value: "alpha" },
    ],
    localStorage: { theme: "dark" },
  };
  // 只有会给登录态定性的键参与比对：_ga 变了、主题变了，仍然认得出是同一个账号
  assert.equal(matchActiveProfileId(cookieAccount, [
    { id: "same", siteKey: "example.com", identity: identityEntries({ cookies: [
      { name: "_ga", domain: "example.com", path: "/", value: "2" },
      { name: "session", domain: "example.com", path: "/", value: "alpha" },
    ], localStorage: { theme: "light" } }) },
  ]), "same");

  const other = identityEntries({
    cookies: [{ name: "session", domain: "example.com", path: "/", value: "beta" }],
    localStorage: {},
  });
  assert.equal(matchActiveProfileId(cookieAccount, [
    { id: "same", siteKey: "example.com", identity: identityEntries({ cookies: [
      { name: "session", domain: "example.com", path: "/", value: "alpha" },
    ], localStorage: {} }) },
    { id: "elsewhere", siteKey: "example.com", identity: other },
  ]), "same");

  // 登录态只放在 localStorage 里时也能认出来
  const tokenAccount = { cookies: [], localStorage: { token: "one" } };
  assert.equal(matchActiveProfileId(tokenAccount, [
    { id: "t1", siteKey: "example.com", identity: identityEntries({ cookies: [], localStorage: { token: "one" } }) },
    { id: "t2", siteKey: "example.com", identity: identityEntries({ cookies: [], localStorage: { token: "two" } }) },
  ]), "t1");
});

function account(id, session, extras = {}) {
  return {
    id,
    cookies: [
      { name: "session", domain: extras.domain || "chatgpt.com", path: "/", value: session },
      { name: "__Host-next-auth.csrf-token", domain: extras.domain || "chatgpt.com", path: "/", value: extras.csrf || "csrf" },
      ...(extras.cookies || []),
    ],
    localStorage: extras.localStorage || { token: session },
  };
}

test("current account still matches when extra cookies appear or domains lose the leading dot", () => {
  const daoxian = account("daoxian", "dao-xian", { domain: ".chatgpt.com" });
  const zhangsan = account("zhangsan", "zhang-san");
  const live = {
    cookies: [
      { name: "session", domain: "chatgpt.com", path: "/", value: "dao-xian" },
      { name: "__Secure-next-auth.callback-url", domain: "chatgpt.com", path: "/", value: "https://chatgpt.com/c/new" },
      { name: "__Host-next-auth.csrf-token", domain: "chatgpt.com", path: "/", value: "rotated-csrf" },
    ],
    localStorage: { token: "dao-xian", theme: "dark" },
  };
  assert.equal(matchActiveProfileId(live, [zhangsan, daoxian]), "daoxian");
});

test("a rotated session falls back to the last switched account", () => {
  const daoxian = account("daoxian", "dao-xian");
  const zhangsan = account("zhangsan", "zhang-san");
  const live = account("live", "rotated-after-reload");
  assert.equal(matchActiveProfileId(live, [zhangsan, daoxian]), null);
  assert.equal(matchActiveProfileId(live, [zhangsan, daoxian], "daoxian"), "daoxian");
});

test("a live match beats a stale last-switched hint", () => {
  const daoxian = account("daoxian", "dao-xian");
  const zhangsan = account("zhangsan", "zhang-san");
  assert.equal(matchActiveProfileId(zhangsan, [daoxian, zhangsan], "daoxian"), "zhangsan");
});

test("full storage is only needed when login is not in cookies or auth keys", () => {
  assert.equal(needsFullIdentityStorage({
    cookies: [{ name: "session", value: "a" }],
    localStorage: {},
  }, 4), false);
  assert.equal(needsFullIdentityStorage({
    cookies: [],
    localStorage: { token: "a" },
  }, 4), false);
  assert.equal(needsFullIdentityStorage({
    cookies: [],
    localStorage: {},
  }, 4), true);
  assert.equal(needsFullIdentityStorage({
    cookies: [],
    localStorage: {},
  }, 0), false);
});

test("identity storage read copies login keys and leaves the rest behind", () => {
  const entries = [
    ["token", "one"],
    ["theme", "dark"],
    ["__Host-next-auth.csrf-token", "csrf"],
  ];
  const result = vm.runInNewContext(
    `(${readIdentityStorage.toString()})(${JSON.stringify(IDENTITY_AUTH_SOURCE)}, ${JSON.stringify(IDENTITY_NOISE_SOURCE)})`,
    {
      localStorage: {
        get length() {
          return entries.length;
        },
        key(index) {
          return entries[index]?.[0] ?? null;
        },
        getItem(key) {
          return entries.find(([name]) => name === key)?.[1] ?? null;
        },
      },
      location: { origin: "https://chatgpt.com" },
    },
  );
  assert.deepEqual({ ...result.localStorage }, { token: "one" });
  assert.equal(result.otherKeys, 2);
  assert.equal(result.origin, "https://chatgpt.com");
});
