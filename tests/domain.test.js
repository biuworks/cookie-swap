import assert from "node:assert/strict";
import test from "node:test";
import { pageOrigin, readPageTarget, registrableDomain } from "../src/domain.js";

test("registrable domain keeps the site, not the public suffix", () => {
  assert.equal(registrableDomain("shop.example.com"), "example.com");
  assert.equal(registrableDomain("example.com"), "example.com");
  assert.equal(registrableDomain("a.b.example.com"), "example.com");
  assert.equal(registrableDomain("www.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("www.example.com.cn"), "example.com.cn");
  assert.equal(registrableDomain("foo.github.io"), "foo.github.io");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(registrableDomain("app.localhost"), "app.localhost");
  assert.equal(registrableDomain("127.0.0.1"), "127.0.0.1");
});

test("page target accepts websites and refuses browser pages", () => {
  assert.deepEqual(readPageTarget("https://shop.example.com:8443/cart?q=1"), {
    ok: true,
    origin: "https://shop.example.com:8443",
    siteKey: "example.com",
    hostLabel: "shop.example.com:8443",
  });
  assert.equal(readPageTarget("chrome://settings").ok, false);
  assert.equal(readPageTarget("").ok, false);
  assert.equal(pageOrigin("https://shop.example.com/cart"), "https://shop.example.com");
});
