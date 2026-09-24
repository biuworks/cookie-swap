import test from "node:test";

test("background module loads against a chrome stub", async () => {
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} } },
    cookies: {},
    tabs: { onUpdated: { addListener() {}, removeListener() {} } },
    scripting: {},
    storage: { local: {} },
  };
  await import(`../src/background.js?test=${Date.now()}`);
});
