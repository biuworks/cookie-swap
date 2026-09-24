import { describeEffect, formatSavedAtExact, profileMeta } from "./format.js";
import { normalizeName, saveHint } from "./profiles.js";

const ONBOARD_KEY = "onboarded";

const bodyEl = document.getElementById("body");
const footEl = document.getElementById("foot");
const hostEl = document.getElementById("host");
const toastEl = document.getElementById("toast");
const toastTextEl = document.getElementById("toast-text");
const toastUndoEl = document.getElementById("toast-undo");
const toastTimerEl = document.getElementById("toast-timer");
const scrimEl = document.getElementById("scrim");
const infoPopEl = document.getElementById("info-pop");
const sheetEl = document.getElementById("sheet");
const infoToggleEl = document.getElementById("info-toggle");

const state = {
  phase: "loading",
  hostLabel: "",
  siteKey: "",
  reason: "",
  loggedIn: true,
  profiles: [],
  activeId: null,
  busy: false,
  busyId: null,
  menuId: null,
  detailId: null,
  renameId: null,
  renameName: "",
  draftOpen: false,
  draftName: "",
  toast: null,
  infoOpen: false,
  sheet: null,
};

let toastTimer = 0;

/* ---------------- 工具 ---------------- */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

const AVATAR_COLORS = ["#0c6b52", "#2f5d8a", "#8a5a12", "#7a3f6d", "#2c6d6a"];

function avatarColor(name) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initialOf(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "?";
  const first = trimmed[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

const ICON = {
  more: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>',
  check: '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>',
  caret: '<svg class="caret" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>',
  plus: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
  swap: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13l-3-3M20 16H7l3 3"></path></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"></path><path d="M21 3.5V9h-5.5"></path></svg>',
  shield: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>',
  empty: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#c9c0ae" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"></rect><path d="M3 10h18M8 15h4"></path></svg>',
};

/* ---------------- 与 background 通信 ---------------- */

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    return response;
  });
}

function createChromeRuntime() {
  async function tabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("找不到当前标签页");
    return tab.id;
  }
  return {
    async hasOnboarded() {
      const stored = await chrome.storage.local.get(ONBOARD_KEY);
      return stored[ONBOARD_KEY] === true;
    },
    async markOnboarded() {
      await chrome.storage.local.set({ [ONBOARD_KEY]: true });
    },
    async inspect() {
      return send({ type: "inspect", tabId: await tabId() });
    },
    async save(name) {
      return send({ type: "save", tabId: await tabId(), name });
    },
    async update(profileId) {
      return send({ type: "update", tabId: await tabId(), profileId });
    },
    async rename(profileId, name) {
      return send({ type: "rename", tabId: await tabId(), profileId, name });
    },
    async switchTo(profileId, confirmed) {
      return send({ type: "switch", tabId: await tabId(), profileId, confirmed: Boolean(confirmed) });
    },
    async remove(profileId) {
      return send({ type: "delete", tabId: await tabId(), profileId });
    },
    async restore(profileId) {
      return send({ type: "restore", tabId: await tabId(), profileId });
    },
    async fresh(confirmed) {
      return send({ type: "fresh", tabId: await tabId(), confirmed: Boolean(confirmed) });
    },
  };
}

/** 直接打开 popup.html（没有 chrome API）时的预览数据，方便对着设计稿看效果。
 *  加 ?onboard=1 预览首次安装那一屏。 */
function createPreviewRuntime() {
  const now = Date.now();
  let onboarded = !/[?&]onboard=1/.test(globalThis.location?.search || "");
  let profiles = [
    {
      id: "work", name: "工作号", savedAt: now - 5 * 60 * 1000,
      origin: "https://shop.example.com", hostLabel: "shop.example.com",
      cookieCount: 8, storageCount: 3, expiredCount: 0, active: true,
    },
    {
      id: "personal", name: "个人号", savedAt: now - 26 * 60 * 60 * 1000,
      origin: "https://shop.example.com", hostLabel: "shop.example.com",
      cookieCount: 6, storageCount: 1, expiredCount: 3, active: false,
    },
  ];
  const removed = [];
  const view = (loggedIn = true) => ({
    view: {
      phase: "ready",
      siteKey: "example.com",
      hostLabel: "shop.example.com",
      origin: "https://shop.example.com",
      loggedIn,
      profiles: profiles.map((profile) => ({ ...profile })),
    },
  });
  const activeId = () => (profiles.find((profile) => profile.active) || {}).id || null;
  return {
    async hasOnboarded() { return onboarded; },
    async markOnboarded() { onboarded = true; },
    async inspect() { return view(); },
    async save(name) {
      const label = name.trim().replace(/\s+/g, " ");
      const existing = profiles.find((profile) => profile.name === label);
      const overwritten = Boolean(existing);
      const id = existing?.id || `p${Date.now()}`;
      profiles = [
        {
          id, name: label, savedAt: Date.now(), origin: "https://shop.example.com",
          hostLabel: "shop.example.com", cookieCount: 4, storageCount: 2, expiredCount: 0, active: true,
        },
        ...profiles.map((profile) => ({ ...profile, active: false })),
      ];
      return { ...view(), effect: { type: "saved", name: label, overwritten, cookieCount: 4, storageCount: 2 } };
    },
    async update(profileId) {
      const profile = profiles.find((item) => item.id === profileId);
      if (activeId() !== profileId) throw new Error("只能更新当前正在使用的账号。先切换到它，再更新。");
      profile.savedAt = Date.now();
      profile.expiredCount = 0;
      return { ...view(), effect: { type: "updated", name: profile.name } };
    },
    async rename(profileId, name) {
      const label = name.trim();
      if (profiles.some((item) => item.id !== profileId && item.name === label)) {
        throw new Error(`已经有一个叫「${label}」的账号了`);
      }
      const profile = profiles.find((item) => item.id === profileId);
      profile.name = label;
      return { ...view(), effect: { type: "renamed", name: label } };
    },
    async switchTo(profileId, confirmed) {
      const profile = profiles.find((item) => item.id === profileId);
      if (!confirmed) return { needsConfirm: true, confirm: { kind: "switch", name: profile.name } };
      profiles = profiles.map((item) => ({ ...item, active: item.id === profileId }));
      return { ...view(), effect: { type: "switched", name: profile.name, failedCount: 0, navigated: false } };
    },
    async remove(profileId) {
      const profile = profiles.find((item) => item.id === profileId);
      removed.push(profile);
      profiles = profiles.filter((item) => item.id !== profileId);
      return { ...view(), effect: { type: "deleted", name: profile.name } };
    },
    async restore() {
      const profile = removed.pop();
      if (!profile) throw new Error("撤销时间已过");
      profiles = [profile, ...profiles];
      return { ...view(), effect: { type: "restored", name: profile.name } };
    },
    async fresh() {
      profiles = profiles.map((profile) => ({ ...profile, active: false }));
      return { ...view(false), effect: { type: "fresh" } };
    },
  };
}

const runtime = globalThis.chrome?.runtime?.id ? createChromeRuntime() : createPreviewRuntime();

/* ---------------- 派生状态 ---------------- */

function currentProfile() {
  return state.profiles.find((profile) => profile.id === state.activeId) || null;
}

function applyView(view) {
  state.phase = view.phase || "ready";
  state.hostLabel = view.hostLabel || "";
  state.siteKey = view.siteKey || "";
  state.reason = view.reason || "";
  state.profiles = Array.isArray(view.profiles) ? view.profiles : [];
  state.loggedIn = view.loggedIn !== false;
  const active = state.profiles.find((profile) => profile.active);
  state.activeId = active ? active.id : null;
  state.menuId = null;
  state.detailId = null;
  state.renameId = null;
}

/* ---------------- 渲染片段 ---------------- */

function avatarHtml(profile) {
  return `<span class="av" style="background:${avatarColor(profile.name)}">${esc(initialOf(profile.name))}</span>`;
}

function subHtml(profile) {
  const when = profileMeta(profile);
  if (profile.expiredCount > 0) {
    return `<div class="sub is-warn" data-act="detail" data-id="${profile.id}" role="button" tabindex="0"`
      + ` aria-expanded="${state.detailId === profile.id}" title="有凭证已过期，点开看详情">`
      + `${esc(when)} · <b>${profile.expiredCount} 项凭证已过期</b>${ICON.caret}</div>`;
  }
  return `<div class="sub" title="${esc(formatSavedAtExact(profile.savedAt))}">${esc(when)}</div>`;
}

function detailHtml(profile) {
  const valid = Math.max(0, profile.cookieCount - profile.expiredCount);
  return '<div class="detail">'
    + `<div>本地凭证 <b>${profile.cookieCount}</b> 项，其中 <b>${valid}</b> 项仍有效，`
    + `<b class="warn-num">${profile.expiredCount}</b> 项已过期。</div>`
    + "<div>过期的是登录凭证，这份快照<b>可能已经登不上了</b>。</div>"
    + "<div>建议：切回该账号重新登录后，再用「更新」覆盖一次。</div>"
    + `<div class="detail-time">保存于 ${esc(formatSavedAtExact(profile.savedAt))}</div>`
    + "</div>";
}

function menuHtml(profile, className = "menu") {
  return `<div class="${className}">`
    + `<button class="mi" data-act="rename" data-id="${profile.id}">重命名</button>`
    + `<button class="mi danger" data-act="delete" data-id="${profile.id}">删除这个快照`
    + '<span class="note">可撤销</span></button>'
    + "</div>";
}

function renameHtml(profile) {
  return '<div class="draft">'
    + "<h3>重命名</h3>"
    + `<input class="input" id="rename-name" maxlength="40" autocomplete="off" spellcheck="false"`
    + ` data-lpignore="true" data-1p-ignore value="${esc(state.renameName)}">`
    + '<div class="caps">改名不影响已保存的登录态。</div>'
    + '<div class="acts">'
    + '<button class="btn sec sm" data-act="rename-cancel" type="button">取消</button>'
    + '<button class="btn primary sm" data-act="rename-save" data-id="' + profile.id + '" type="button">保存</button>'
    + "</div></div>";
}

function cardHtml(profile) {
  const busy = state.busyId === profile.id;
  let html = `<div class="card${busy ? " is-busy" : ""}" data-id="${profile.id}">`;
  if (state.renameId === profile.id) return html + renameHtml(profile) + "</div>";
  html += '<div class="row">'
    + avatarHtml(profile)
    + `<div class="ident"><div class="name-row"><span class="name">${esc(profile.name)}</span></div>`
    + `${subHtml(profile)}</div>`
    + `<button class="btn sec sm" data-act="switch" data-id="${profile.id}" type="button"`
    + `${state.busy ? " disabled" : ""}>切换</button>`
    + `<button class="icon" data-act="menu" data-id="${profile.id}" type="button" aria-label="更多操作"`
    + ` aria-expanded="${state.menuId === profile.id}">${ICON.more}</button>`
    + "</div>";
  if (busy) html += '<div class="load">正在写入会话…<span class="prog"><i></i></span></div>';
  if (state.menuId === profile.id) html += menuHtml(profile);
  if (state.detailId === profile.id) html += detailHtml(profile);
  return html + "</div>";
}

function statusCardHtml(profile) {
  let html = `<div class="status" data-id="${profile.id}">`
    + avatarHtml(profile)
    + '<div class="status-txt"><div class="status-name">'
    + `<b>${esc(profile.name)}</b><span class="pill">${ICON.check}使用中</span></div>`
    + `${subHtml(profile)}</div>`
    + `<button class="icon" data-act="menu" data-id="${profile.id}" type="button" aria-label="更多操作"`
    + ` aria-expanded="${state.menuId === profile.id}">${ICON.more}</button>`
    + "</div>";
  if (state.menuId === profile.id) html += menuHtml(profile, "menu panel");
  if (state.detailId === profile.id) html += detailHtml(profile);
  return html;
}

function barHtml(online, text) {
  return `<div class="bar"><span class="dot${online ? "" : " off"}"></span><span>${text}</span></div>`;
}

function draftHtml() {
  const label = state.draftName.trim();
  const conflict = label ? saveHint(label, state.profiles) : "";
  return '<div class="draft">'
    + "<h3>保存当前登录为新快照</h3>"
    + `<input class="input" id="draft-name" maxlength="40" autocomplete="off" spellcheck="false"`
    + ` data-lpignore="true" data-1p-ignore placeholder="例如：工作号" value="${esc(state.draftName)}">`
    + `<div class="caps over" id="draft-hint"${conflict ? "" : " hidden"}>${esc(conflict)}</div>`
    + '<div class="acts">'
    + '<button class="btn sec sm" data-act="draft-cancel" type="button">取消</button>'
    + `<button class="btn primary sm" data-act="draft-save" type="button" id="draft-save"${label ? "" : " disabled"}>`
    + `${conflict ? "覆盖" : "保存"}</button>`
    + "</div></div>";
}

/**
 * 草稿输入时只更新受影响的两处，不重渲染整个弹窗 ——
 * 重渲染会把输入框换掉，光标位置就丢了。
 */
function syncDraft() {
  const label = state.draftName.trim();
  const conflict = label ? saveHint(label, state.profiles) : "";
  const hint = document.getElementById("draft-hint");
  const save = document.getElementById("draft-save");
  if (hint) {
    hint.textContent = conflict;
    hint.hidden = !conflict;
  }
  if (save) {
    save.disabled = !label;
    save.textContent = conflict ? "覆盖" : "保存";
  }
}

function emptyHtml() {
  return `<div class="empty">${ICON.empty}<h3>还没有快照</h3>`
    + "<p>登录这个网站后，点下面的「保存当前登录」，之后就能在这里一键换号。</p></div>";
}

function onboardHtml() {
  return '<div class="onboard">'
    + `<div class="badge">${ICON.shield}</div>`
    + "<h3>开始之前，三件事</h3>"
    + "<p>这份说明只出现这一次，之后随时点右上角 ⓘ 可以再看。</p>"
    + '<div class="onb-list">'
    + '<div><span class="num">1</span><span>快照只存在这台浏览器里，<b>没有上传到任何服务器</b>。</span></div>'
    + '<div class="warn"><span class="num">2</span><span>它包含可直接登录的会话，<b>不要在公司或公用电脑上保存</b>。</span></div>'
    + '<div><span class="num">3</span><span>切换账号会刷新当前页面；只有页面里有没提交的内容时，才会先问你一次。</span></div>'
    + "</div>"
    + '<button class="btn primary block" data-act="onboard-done" type="button">知道了，开始使用</button>'
    + "</div>";
}

function bodyHtml() {
  if (state.phase === "onboard") return onboardHtml();
  if (state.phase === "loading") return '<div class="hintline">正在读取当前页面…</div>';
  if (state.phase === "unsupported") {
    return `<div class="empty"><h3>这个页面用不了</h3><p>${esc(state.reason || "先打开一个普通网页，再点这个图标。")}</p></div>`;
  }

  if (state.profiles.length === 0) return emptyHtml();

  const current = currentProfile();
  const others = state.profiles.filter((profile) => profile.id !== state.activeId);
  let html = "";

  html += '<div class="sec"><h2>正在使用</h2></div><div class="group">';
  if (!state.loggedIn) {
    html += barHtml(false, "<b>当前页面未登录</b> · 先登录才能保存新快照");
  } else if (current) {
    html += statusCardHtml(current);
  } else {
    html += barHtml(true, "<b>当前页面的登录态还没保存</b> · 点下面保存成快照");
  }
  if (state.draftOpen) html += draftHtml();
  html += "</div>";

  html += `<div class="sec"><h2>可切换 <span class="count">${others.length}</span></h2></div>`;
  html += '<div class="group">';
  if (others.length === 0) {
    html += `<div class="hintline">${state.loggedIn
      ? "只有这一个账号。点下面的「换个号」登录后再保存，就能在这里一键切回。"
      : "没有其他账号可切。先登录，再把新账号保存下来。"}</div>`;
  } else {
    for (const profile of others) html += cardHtml(profile);
  }
  html += "</div>";

  return html;
}

function footHtml() {
  if (state.phase === "onboard") {
    return '<span class="ft-note">安全说明随时可在右上角 ⓘ 查看</span>';
  }
  if (state.phase !== "ready") return "";
  const lock = state.busy ? " disabled" : "";
  const current = currentProfile();
  if (current) {
    return `<button class="btn primary" data-act="update" data-id="${current.id}" type="button"${lock}>`
      + `${ICON.refresh}更新「${esc(current.name)}」</button>`
      + `<button class="btn sec" data-act="fresh" type="button"${lock}>${ICON.swap}换个号</button>`;
  }
  if (state.loggedIn) {
    return `<button class="btn primary" data-act="open-draft" type="button"${lock}>`
      + `${ICON.plus}保存当前登录</button>`
      + `<button class="btn sec" data-act="fresh" type="button"${lock}>${ICON.swap}换个号</button>`;
  }
  return `<button class="btn primary" data-act="fresh" type="button">${ICON.swap}登录新账号</button>`
    + '<button class="btn sec" type="button" disabled title="先登录才能保存">保存当前登录</button>';
}

function sheetHtml() {
  if (!state.sheet) return "";
  if (state.sheet.kind === "switch") {
    return '<div class="sheet"><h3>页面里有没提交的内容</h3>'
      + `<p>切换到「<b>${esc(state.sheet.name)}</b>」会刷新当前页面，`
      + "<b>已经填进表单但没提交的内容会丢失</b>。</p>"
      + '<div class="acts"><button class="btn sec" data-act="sheet-cancel" type="button">先不切</button>'
      + '<button class="btn primary" data-act="sheet-ok" type="button">仍然切换</button></div></div>';
  }
  return '<div class="sheet"><h3>把当前页面变成未登录？</h3>'
    + "<p>已添加的账号都还在，可以随时切回来。"
    + "<b>但这个页面当前的登录态会被清空</b>，之后要重新登录。</p>"
    + '<div class="acts"><button class="btn sec" data-act="sheet-cancel" type="button">取消</button>'
    + '<button class="btn primary" data-act="sheet-ok" type="button">清空并刷新</button></div></div>';
}

/* ---------------- 渲染 ---------------- */

function renderToast() {
  if (!state.toast) {
    toastEl.hidden = true;
    return;
  }
  toastEl.hidden = false;
  const kind = state.toast.kind || "ok";
  toastEl.className = kind === "ok" ? "toast" : `toast ${kind}`;
  toastTextEl.textContent = state.toast.text;
  toastUndoEl.hidden = !state.toast.undoId;
  const showTimer = Boolean(state.toast.ttl);
  toastTimerEl.hidden = !showTimer;
  if (showTimer) toastTimerEl.style.animationDuration = `${state.toast.ttl}ms`;
}

function showToast({ text, kind = "ok", undoId = null, ttl = 0 }) {
  clearTimeout(toastTimer);
  state.toast = { text, kind, undoId, ttl };
  if (ttl > 0) {
    toastTimer = setTimeout(() => {
      state.toast = null;
      render();
    }, ttl);
  }
}

function render() {
  hostEl.hidden = state.phase === "onboard";
  hostEl.textContent = state.phase === "loading"
    ? "正在读取当前页面…"
    : (state.phase === "unsupported" ? "无法读取当前页面" : (state.hostLabel || ""));

  infoToggleEl.setAttribute("aria-expanded", String(state.infoOpen));
  infoToggleEl.className = state.infoOpen ? "icon is-on" : "icon";
  scrimEl.hidden = !state.infoOpen;
  infoPopEl.hidden = !state.infoOpen;

  bodyEl.innerHTML = bodyHtml();
  footEl.innerHTML = footHtml();

  const hasSheet = Boolean(state.sheet);
  sheetEl.hidden = !hasSheet;
  if (hasSheet) sheetEl.innerHTML = sheetHtml();

  renderToast();
}

/* ---------------- 动作 ---------------- */

async function run(task, options = {}) {
  if (state.busy) return;
  state.busy = true;
  state.menuId = null;
  render();
  try {
    const response = await task();
    if (response?.needsConfirm) {
      // 提问由弹窗的确认面板负责，不走 describeEffect（那里只描述"已经发生了什么"）。
      // 没有 confirm 处理器却收到确认请求，说明调用点漏了 —— 报出来，别静默吞掉。
      if (!options.confirm) {
        showToast({ text: "这个操作需要确认，但界面没有处理它", kind: "error", ttl: 0 });
        return;
      }
      state.sheet = options.confirm(response.confirm);
      return;
    }
    if (response?.view) applyView(response.view);
    if (options.onSuccess) options.onSuccess(response);
    const effect = describeEffect(response?.effect);
    if (effect) {
      const undoId = options.undoId || null;
      const ok = effect.kind === "ok";
      showToast({
        text: effect.text,
        kind: ok ? "ok" : "warn",
        undoId,
        ttl: ok ? (undoId ? 6000 : 3200) : 0,
      });
    }
  } catch (error) {
    showToast({ text: error?.message || "操作失败", kind: "error", ttl: 0 });
  } finally {
    state.busy = false;
    state.busyId = null;
    render();
  }
}

async function refresh() {
  try {
    const response = await runtime.inspect();
    applyView(response.view || response);
  } catch (error) {
    state.phase = "unsupported";
    state.reason = error?.message || "读不到当前页面";
  }
  render();
}

/* ---------------- 事件 ---------------- */

function startDraft() {
  state.draftOpen = true;
  state.draftName = "";
  render();
  const input = document.getElementById("draft-name");
  if (input) input.focus();
}

document.addEventListener("click", (event) => {
  const control = event.target.closest("[data-act]");
  if (!control) return;
  const { act, id } = control.dataset;

  if (act === "info") {
    state.infoOpen = !state.infoOpen;
    render();
    return;
  }
  if (act === "info-close") {
    state.infoOpen = false;
    render();
    return;
  }
  if (act === "onboard-done") {
    runtime.markOnboarded().catch(() => {});
    state.phase = "loading";
    render();
    refresh();
    return;
  }
  if (act === "toast-close") {
    clearTimeout(toastTimer);
    state.toast = null;
    render();
    return;
  }
  if (act === "toast-undo") {
    const undoId = state.toast?.undoId;
    clearTimeout(toastTimer);
    state.toast = null;
    if (undoId) {
      run(() => runtime.restore(undoId));
    } else {
      render();
    }
    return;
  }
  if (act === "sheet-cancel") {
    state.sheet = null;
    render();
    return;
  }
  if (act === "sheet-ok") {
    const sheet = state.sheet;
    state.sheet = null;
    if (!sheet) return;
    if (sheet.kind === "switch") {
      state.busyId = sheet.profileId;
      run(() => runtime.switchTo(sheet.profileId, true));
    } else {
      run(() => runtime.fresh(true));
    }
    return;
  }

  if (act === "open-draft") {
    startDraft();
    return;
  }
  if (act === "draft-cancel") {
    state.draftOpen = false;
    state.draftName = "";
    render();
    return;
  }
  if (act === "draft-save") {
    const name = state.draftName;
    run(() => runtime.save(name), {
      onSuccess: () => {
        state.draftOpen = false;
        state.draftName = "";
      },
    });
    return;
  }

  if (act === "menu") {
    state.menuId = state.menuId === id ? null : id;
    state.detailId = null;
    state.renameId = null;
    render();
    return;
  }
  if (act === "detail") {
    state.detailId = state.detailId === id ? null : id;
    render();
    return;
  }
  if (act === "rename") {
    const profile = state.profiles.find((item) => item.id === id);
    state.renameId = id;
    state.renameName = profile ? profile.name : "";
    state.menuId = null;
    render();
    const input = document.getElementById("rename-name");
    if (input) {
      input.focus();
      input.select();
    }
    return;
  }
  if (act === "rename-cancel") {
    state.renameId = null;
    render();
    return;
  }
  if (act === "rename-save") {
    let label;
    try {
      label = normalizeName(state.renameName);
    } catch (error) {
      showToast({ text: error.message, kind: "error", ttl: 0 });
      render();
      return;
    }
    const current = state.profiles.find((item) => item.id === id);
    if (current && current.name === label) {
      state.renameId = null;
      render();
      return;
    }
    run(() => runtime.rename(id, label));
    return;
  }

  if (act === "update") {
    run(() => runtime.update(id));
    return;
  }
  if (act === "switch") {
    state.busyId = id;
    run(() => runtime.switchTo(id, false), {
      confirm: (info) => ({ kind: "switch", profileId: id, name: info?.name || "" }),
    });
    return;
  }
  if (act === "delete") {
    run(() => runtime.remove(id), { undoId: id });
    return;
  }
  if (act === "fresh") {
    run(() => runtime.fresh(false), { confirm: () => ({ kind: "fresh" }) });
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "draft-name") {
    state.draftName = event.target.value;
    syncDraft();
    return;
  }
  if (event.target.id === "rename-name") {
    state.renameName = event.target.value;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.target.id === "draft-name") {
    if (event.key === "Enter") {
      event.preventDefault();
      document.querySelector('[data-act="draft-save"]')?.click();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      state.draftOpen = false;
      state.draftName = "";
      render();
    }
    return;
  }
  if (event.target.id === "rename-name") {
    if (event.key === "Enter") {
      event.preventDefault();
      document.querySelector('[data-act="rename-save"]')?.click();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      state.renameId = null;
      render();
    }
    return;
  }
  if (event.key === "Escape") {
    if (state.infoOpen) {
      state.infoOpen = false;
      render();
      return;
    }
    if (state.menuId || state.detailId) {
      state.menuId = null;
      state.detailId = null;
      render();
    }
    return;
  }
  if ((event.key === "Enter" || event.key === " ") && event.target.dataset?.act
    && event.target.tagName !== "BUTTON") {
    event.preventDefault();
    event.target.click();
  }
});

scrimEl.addEventListener("click", () => {
  state.infoOpen = false;
  render();
});

/* ---------------- 启动 ---------------- */

async function start() {
  render();
  let onboarded = true;
  try {
    onboarded = await runtime.hasOnboarded();
  } catch {
    onboarded = true;
  }
  if (!onboarded) {
    state.phase = "onboard";
    render();
    return;
  }
  await refresh();
}

start();
