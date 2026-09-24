import assert from "node:assert/strict";
import test from "node:test";
import { blankPlan } from "../src/profiles.js";

const session = {
  siteKey: "chatgpt.com",
  cookies: [{ name: "session", domain: "chatgpt.com", path: "/", value: "dao-xian" }],
  localStorage: { token: "dao-xian" },
  sessionStorage: {},
};

test("blanking a saved account does not require deleting the snapshot", () => {
  assert.equal(blankPlan(session, [{ id: "daoxian", ...session }]), "clear");
});

test("the only unsaved login must be added before the page is cleared", () => {
  assert.equal(blankPlan(session, []), "save-first");
});

test("a different live login asks for confirmation and keeps saved accounts", () => {
  const other = {
    ...session,
    cookies: [{ name: "session", domain: "chatgpt.com", path: "/", value: "other" }],
  };
  assert.equal(blankPlan(other, [session]), "confirm");
});

test("extra live cookies still count as the saved account", () => {
  const live = {
    ...session,
    cookies: [
      ...session.cookies,
      { name: "__Secure-next-auth.callback-url", domain: "chatgpt.com", path: "/", value: "https://chatgpt.com/" },
    ],
  };
  assert.equal(blankPlan(live, [{ id: "daoxian", ...session }]), "clear");
});

test("an already empty page can be refreshed", () => {
  assert.equal(blankPlan({
    siteKey: "chatgpt.com",
    cookies: [],
    localStorage: {},
    sessionStorage: {},
  }, []), "clear");
});
