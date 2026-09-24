import assert from "node:assert/strict";
import test from "node:test";
import { readUnsubmittedInput, writePageStorage } from "../src/page-storage.js";

function field({
  tag = "INPUT", type = "text", value = "", defaultValue = "", disabled = false, readOnly = false,
} = {}) {
  return {
    tagName: tag,
    value,
    defaultValue,
    disabled,
    readOnly,
    getAttribute: (name) => (name === "type" ? type : null),
  };
}

function detect(fields) {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  globalThis.location = { origin: "https://shop.example.com" };
  globalThis.document = {
    querySelectorAll: Array.isArray(fields)
      ? () => fields
      : () => { throw new Error("boom"); },
  };
  try {
    return readUnsubmittedInput();
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }
}

test("an untouched page is not considered to have unsaved input", () => {
  assert.deepEqual(detect([]), { origin: "https://shop.example.com", dirty: false });
  assert.equal(detect([field()]).dirty, false);
  assert.equal(detect([field({ value: "   " })]).dirty, false, "只有空白不算填过内容");
});

test("only values that differ from the default count as unsaved input", () => {
  assert.equal(detect([field({ value: "hello", defaultValue: "" })]).dirty, true);
  assert.equal(detect([field({ value: "hello", defaultValue: "hello" })]).dirty, false);
  assert.equal(detect([field({ value: "你好", defaultValue: "hi" })]).dirty, true);
  assert.equal(detect([field({ tag: "TEXTAREA", value: "草稿", defaultValue: "" })]).dirty, true);
});

test("non-text fields and unwritable fields are ignored", () => {
  assert.equal(detect([field({ type: "checkbox", value: "on" })]).dirty, false);
  assert.equal(detect([field({ type: "submit", value: "提交" })]).dirty, false);
  assert.equal(detect([field({ value: "typed", disabled: true })]).dirty, false);
  assert.equal(detect([field({ value: "typed", readOnly: true })]).dirty, false);
});

test("a page that cannot be inspected is treated as clean rather than blocking", () => {
  assert.deepEqual(detect(null), { origin: "https://shop.example.com", dirty: false });
});

function makeStorage(initial = []) {
  const data = new Map(initial);
  return {
    data,
    get length() { return data.size; },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

function withGlobals({ local, session, origin }, run) {
  const previous = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    location: globalThis.location,
  };
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  globalThis.location = { origin };
  try {
    return run();
  } finally {
    globalThis.localStorage = previous.localStorage;
    globalThis.sessionStorage = previous.sessionStorage;
    globalThis.location = previous.location;
  }
}

test("writing storage clears keys the snapshot does not contain", () => {
  const local = makeStorage([["keep", "1"], ["stale", "2"]]);
  const session = makeStorage([["draft", "x"]]);
  withGlobals({ local, session, origin: "https://shop.example.com" }, () => {
    assert.deepEqual(
      writePageStorage({ origin: "https://shop.example.com", localStorage: { keep: "9" } }),
      { ok: true, origin: "https://shop.example.com" },
    );
    assert.deepEqual([...local.data.entries()], [["keep", "9"]]);
    assert.deepEqual([...session.data.entries()], [], "快照里没有的 sessionStorage 也要清掉");
  });
});

test("writing storage refuses to touch a page on another origin", () => {
  const local = makeStorage([["keep", "1"]]);
  withGlobals({ local, session: makeStorage(), origin: "https://shop.example.com" }, () => {
    assert.deepEqual(
      writePageStorage({ origin: "https://other.test", localStorage: {} }),
      { ok: false, origin: "https://shop.example.com" },
    );
    assert.deepEqual([...local.data.entries()], [["keep", "1"]], "拒绝时不能改动任何东西");
  });
});
