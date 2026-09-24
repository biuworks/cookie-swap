import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/**
 * popup.js 是个在导入时就跑起来的模块，所以这里给它一个够用的 DOM 桩，
 * 真实渲染各个状态，然后检查产出的 HTML。
 *
 * 两条经验写进了这个文件的结构里：
 * 1. 卡片 div 没闭合这类问题浏览器不报错，但结构会错 —— 所以验标签配平。
 * 2. 光测处理函数不够：曾经有三个静态按钮（知道了 / 撤销 / ✕）忘了写
 *    data-act，处理函数明明是对的，按钮却完全没反应。所以这里点击时
 *    一律按元素 id 去真实 popup.html 里查 data-act，查不到就判定失败。
 */

const POPUP_HTML = fs.readFileSync(new URL("../src/popup.html", import.meta.url), "utf8");

function staticWiring() {
  const map = new Map();
  for (const match of POPUP_HTML.matchAll(/<button\b[^>]*>/g)) {
    const tag = match[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1] ?? null;
    const act = /\bdata-act="([^"]+)"/.exec(tag)?.[1] ?? null;
    map.set(id, act);
  }
  return map;
}

function makeDom() {
  const elements = new Map();
  const listeners = new Map();
  const element = (id) => ({
    id,
    hidden: false,
    className: "",
    innerHTML: "",
    textContent: "",
    style: {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    select() {},
    click() {},
    addEventListener(type, fn) { listeners.set(`${id}:${type}`, fn); },
  });
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
    addEventListener(type, fn) { listeners.set(`document:${type}`, fn); },
    querySelector() { return null; },
  };
  return { elements, listeners };
}

async function boot({ search = "" } = {}) {
  const dom = makeDom();
  globalThis.location = { search };
  await import(`../src/popup.js?t=${Date.now()}${Math.random()}`);
  await tick();
  return dom;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function count(html, tag) {
  return (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
}

function closeCount(html, tag) {
  return (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
}

function assertBalanced(html, where) {
  for (const tag of ["div", "span", "button"]) {
    assert.equal(count(html, tag), closeCount(html, tag),
      `${where}: <${tag}> 开合不匹配 (${count(html, tag)} vs ${closeCount(html, tag)})`);
  }
}

/** 渲染出来的按钮也必须都接上线，否则点了没反应。 */
function assertButtonsWired(html, where) {
  for (const match of html.matchAll(/<button\b[^>]*>/g)) {
    const tag = match[0];
    if (/\bdisabled\b/.test(tag)) continue;
    assert.match(tag, /data-act="[^"]+"/, `${where}: 这个按钮没接上线 -> ${tag.slice(0, 90)}`);
  }
}

function click(dom, act, id) {
  dom.listeners.get("document:click")({ target: { closest: () => ({ dataset: { act, id } }) } });
}

/** 按 id 点 popup.html 里的静态按钮，data-act 从真实文件里查。 */
function clickStatic(dom, id) {
  const act = staticWiring().get(id);
  assert.ok(act, `popup.html 的 #${id} 没写 data-act —— 点了不会有反应`);
  click(dom, act, undefined);
}

function type(dom, id, value) {
  dom.listeners.get("document:input")({ target: { id, value } });
}

test("every static button in popup.html is wired to an action", () => {
  const wiring = staticWiring();
  assert.ok(wiring.size >= 4, `popup.html 里应当有若干按钮，实际 ${wiring.size}`);
  for (const [id, act] of wiring) {
    assert.ok(id, `有个按钮没有 id，无法被测试定位`);
    assert.ok(act, `popup.html 的 #${id} 缺 data-act`);
  }
});

test("ready state renders two sections and a state-aware primary button", async () => {
  const dom = await boot();
  const body = dom.elements.get("body").innerHTML;
  const foot = dom.elements.get("foot").innerHTML;

  assert.match(body, /正在使用/);
  assert.match(body, /可切换/);
  assert.match(body, /使用中/);
  assertBalanced(body, "body");
  assertBalanced(foot, "footer");
  assertButtonsWired(body, "body");
  assertButtonsWired(foot, "footer");

  // 当前登录态已经存过了，主按钮就不该再是「新建」
  assert.match(foot, /更新「工作号」/);
  assert.doesNotMatch(body + foot, /保存当前登录/);
  assert.match(foot, /换个号/);

  const switchable = body.slice(body.indexOf("可切换"));
  assert.doesNotMatch(switchable, /工作号/, "当前账号不该出现在可切换列表里");
  assert.match(switchable, /个人号/);
});

test("the info popover opens from the header and closes from its own button", async () => {
  const dom = await boot();
  assert.equal(dom.elements.get("info-pop").hidden, true);

  clickStatic(dom, "info-toggle");
  assert.equal(dom.elements.get("info-pop").hidden, false, "点 ⓘ 应当打开说明");
  assert.equal(dom.elements.get("scrim").hidden, false);

  clickStatic(dom, "info-close");
  assert.equal(dom.elements.get("info-pop").hidden, true, "点「知道了」应当关闭说明");
  assert.equal(dom.elements.get("scrim").hidden, true);
});

test("an expired snapshot surfaces a warning, and detail only appears when opened", async () => {
  const dom = await boot();
  let body = dom.elements.get("body").innerHTML;

  assert.match(body, /3 项凭证已过期/);
  assert.match(body, /class="sub is-warn" data-act="detail"/);
  assert.doesNotMatch(body, /本地凭证/, "详情默认不该展开");

  click(dom, "detail", "personal");
  body = dom.elements.get("body").innerHTML;
  assert.match(body, /本地凭证/);
  assert.match(body, /可能已经登不上了/);
  assert.doesNotMatch(body, /站点：/);
  assert.doesNotMatch(body, /个 Cookie/);
  assertBalanced(body, "expanded detail");
});

test("the menu only offers rename and delete, and delete can be undone", async () => {
  const dom = await boot();
  click(dom, "menu", "personal");
  const body = dom.elements.get("body").innerHTML;
  const menu = body.slice(body.indexOf('class="menu"'), body.indexOf("</div>", body.indexOf('class="menu"')));

  assert.match(menu, /重命名/);
  assert.match(menu, /删除这个快照/);
  assert.doesNotMatch(menu, /更新/, "「更新」不该再出现在任何卡片菜单里");
  assert.doesNotMatch(menu, /详情/, "「详情」这一项已经删掉了");

  click(dom, "delete", "personal");
  await tick();
  assert.match(dom.elements.get("toast-text").textContent, /已删除「个人号」/);
  assert.equal(dom.elements.get("toast-undo").hidden, false, "删除后应当能撤销");
  assert.doesNotMatch(dom.elements.get("body").innerHTML, /个人号/);

  // 点真实存在的那个「撤销」按钮
  clickStatic(dom, "toast-undo");
  await tick();
  assert.match(dom.elements.get("toast-text").textContent, /已恢复「个人号」/);
  assert.match(dom.elements.get("body").innerHTML, /个人号/, "撤销后账号应当回来");

  clickStatic(dom, "toast-close");
  assert.equal(dom.elements.get("toast").hidden, true, "✕ 应当关掉 toast");
});

test("switching asks first when the page has unsaved input", async () => {
  const dom = await boot();
  click(dom, "switch", "personal");
  await tick();

  const sheet = dom.elements.get("sheet");
  assert.equal(sheet.hidden, false);
  assert.match(sheet.innerHTML, /没提交的内容/);
  assertButtonsWired(sheet.innerHTML, "sheet");

  click(dom, "sheet-cancel");
  await tick();
  assert.equal(dom.elements.get("sheet").hidden, true);
});

test("first run explains the three things and then never again", async () => {
  const dom = await boot({ search: "?onboard=1" });
  const body = dom.elements.get("body").innerHTML;

  assert.match(body, /没有上传到任何服务器/);
  assert.match(body, /不要在公司或公用电脑上保存/);
  assert.match(body, /没提交的内容/);
  assert.match(body, /只出现这一次/);
  assertBalanced(body, "onboard");
  assertButtonsWired(body, "onboard");

  click(dom, "onboard-done");
  await tick();
  assert.match(dom.elements.get("body").innerHTML, /正在使用/, "看完说明应当进入正常界面");
});

test("profile names cannot inject markup", async () => {
  const dom = await boot();
  click(dom, "open-draft");
  await tick();
  assert.match(dom.elements.get("body").innerHTML, /保存当前登录为新快照/);
  assertBalanced(dom.elements.get("body").innerHTML, "draft");

  type(dom, "draft-name", '<img src=x onerror="alert(1)">');
  click(dom, "draft-save");
  await tick();

  const body = dom.elements.get("body").innerHTML;
  assert.doesNotMatch(body, /<img/, "用户输入不能被当成标签解析");
  assert.match(body, /&lt;img/, "应当以转义后的文本显示");
  assertBalanced(body, "after injection attempt");

  clickStatic(dom, "toast-close");
});
