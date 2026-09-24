export function readIdentityStorage(authSource, noiseSource) {
  const auth = new RegExp(authSource, "i");
  const noise = new RegExp(noiseSource, "i");
  const kept = {};
  let otherKeys = 0;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key == null) continue;
    const value = localStorage.getItem(key);
    if (typeof value !== "string") continue;
    if (auth.test(key) && !noise.test(key)) kept[key] = value;
    else otherKeys += 1;
  }
  return { origin: location.origin, localStorage: kept, otherKeys };
}

export function readPageStorage() {
  const dumpStorage = (storage) => {
    const out = {};
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key == null) continue;
      const value = storage.getItem(key);
      if (typeof value === "string") out[key] = value;
    }
    return out;
  };
  return {
    origin: location.origin,
    localStorage: dumpStorage(localStorage),
    sessionStorage: dumpStorage(sessionStorage),
  };
}

export function writePageStorage(payload) {  if (location.origin !== payload.origin) {
    return { ok: false, origin: location.origin };
  }
  const replaceStorage = (storage, data) => {
    const next = data || {};
    const nextKeys = new Set(Object.keys(next));
    for (const [key, value] of Object.entries(next)) storage.setItem(key, value);
    const stale = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key != null && !nextKeys.has(key)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  };
  replaceStorage(localStorage, payload.localStorage);
  replaceStorage(sessionStorage, payload.sessionStorage);
  return { ok: true, origin: location.origin };
}

const TEXTUAL_INPUTS = new Set([
  "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local",
]);

/**
 * 尽力判断页面里有没有「填了但没提交」的内容。切换会刷新页面，这些东西会丢，
 * 所以只在检测到时才拦一下。
 *
 * 这是个启发式：只看 input / textarea 里「值不等于默认值」的文本类字段。
 * 富文本编辑器、只存在内存里的草稿、自定义组件都看不出来 —— 检测不到时
 * 一律当作没有（宁可少打扰，也不要每次都弹确认）。
 */
export function readUnsubmittedInput() {
  const isEdited = (element) => {
    if (element.disabled || element.readOnly) return false;
    if (element.tagName === "INPUT") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (!TEXTUAL_INPUTS.has(type)) return false;
    }
    const value = element.value;
    if (typeof value !== "string" || value.trim() === "") return false;
    return value !== (element.defaultValue ?? "");
  };
  try {
    const fields = document.querySelectorAll("input, textarea");
    for (const field of fields) {
      if (isEdited(field)) return { origin: location.origin, dirty: true };
    }
    return { origin: location.origin, dirty: false };
  } catch {
    return { origin: location.origin, dirty: false };
  }
}
