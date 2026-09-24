import assert from "node:assert/strict";
import test from "node:test";
import { runSwitch } from "../src/swap.js";

function profile(overrides = {}) {
  return {
    id: "work",
    name: "工作号",
    siteKey: "example.com",
    origin: "https://shop.example.com",
    hostLabel: "shop.example.com",
    cookies: [{ name: "sid", value: "work", domain: "example.com", path: "/", session: true, hostOnly: false }],
    localStorage: { token: "work" },
    sessionStorage: {},
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  let cookies = "before";
  const io = {
    tab: { id: 7, url: "https://shop.example.com/cart" },
    profile: profile(),
    storeId: "0",
    async applyCookies() {
      calls.push("cookies");
      cookies = "after";
      return {
        failedCount: 0,
        async rollback() {
          calls.push("rollback");
          cookies = "before";
        },
      };
    },
    async writeStorage(_tabId, payload) {
      calls.push("storage");
      io.storagePayload = payload;
    },
    async reload(tabId) {
      calls.push(`reload:${tabId}`);
    },
    async navigate() {
      calls.push("navigate");
    },
    async getTab() {
      return { id: 7, url: "https://shop.example.com/" };
    },
    ...overrides,
  };
  return { io, calls, cookies: () => cookies };
}

test("same-origin switch replaces cookies, then storage, then reloads", async () => {
  const { io, calls } = harness();
  const result = await runSwitch(io);
  assert.deepEqual(calls, ["cookies", "storage", "reload:7"]);
  assert.equal(result.navigated, false);
  assert.deepEqual(Object.keys(io.storagePayload).sort(), ["localStorage", "origin", "sessionStorage"]);
  assert.equal(io.storagePayload.localStorage.token, "work");
});

test("a different origin is opened before storage is written", async () => {
  const { io, calls } = harness({
    tab: { id: 7, url: "https://www.example.com/home" },
    async getTab() {
      return { id: 7, url: "https://shop.example.com/dashboard" };
    },
  });
  const result = await runSwitch(io);
  assert.deepEqual(calls, ["cookies", "navigate", "storage", "reload:7"]);
  assert.equal(result.navigated, true);
});

test("failed storage write restores the previous cookies and does not reload", async () => {
  const box = harness({
    async writeStorage() {
      throw new Error("没能写入页面的本地存储");
    },
  });
  await assert.rejects(() => runSwitch(box.io), /原来的 Cookie 已恢复/);
  assert.deepEqual(box.calls, ["cookies", "rollback"]);
  assert.equal(box.cookies(), "before");
});

test("landing on the wrong origin restores cookies", async () => {
  const box = harness({
    tab: { id: 7, url: "https://www.example.com/" },
    async getTab() {
      return { id: 7, url: "https://accounts.example.org/login" };
    },
  });
  await assert.rejects(() => runSwitch(box.io), /没能打开保存这个账号时的页面/);
  assert.equal(box.calls.includes("reload:7"), false);
  assert.equal(box.calls.at(-1), "rollback");
});

test("a snapshot from another site is refused before cookies change", async () => {
  const box = harness({
    profile: profile({ siteKey: "other.test", origin: "https://other.test" }),
  });
  await assert.rejects(() => runSwitch(box.io), /别的网站/);
  assert.deepEqual(box.calls, []);
});
