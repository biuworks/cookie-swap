function pad(value) {
  return String(value).padStart(2, "0");
}

function sameDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function formatSavedAt(timestamp, now = Date.now()) {
  const delta = now - timestamp;
  if (delta >= 0 && delta < 60_000) return "刚刚";
  const date = new Date(timestamp);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const current = new Date(now);
  if (sameDay(date, current)) return `今天 ${time}`;
  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** 精确到秒的时间。列表里放不下也不该放，做成悬停提示。 */
export function formatSavedAtExact(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 卡片副标题。只有时间 —— Cookie 数量这类统计放不进列表主行，
 * 它们在保存成功的那条提示里出现一次就够了（见下面的 describeEffect）。
 */
export function profileMeta(profile, now = Date.now()) {
  const at = formatSavedAt(profile.savedAt, now);
  return at === "刚刚" ? "刚刚保存" : `${at} 保存`;
}

/**
 * 把一次操作的结果翻译成给人看的一句话。
 * 这里只描述「已经发生了什么」；「要不要继续」这类提问由弹窗的确认面板负责。
 */
export function describeEffect(effect) {
  if (!effect) return null;
  if (effect.type === "saved") {
    const what = effect.overwritten ? `已覆盖「${effect.name}」` : `已保存「${effect.name}」`;
    const counts = typeof effect.cookieCount === "number"
      ? ` · ${effect.cookieCount} 个 Cookie · ${effect.storageCount || 0} 项本地存储`
      : "";
    return { kind: "ok", text: `${what}${counts}` };
  }
  if (effect.type === "updated") {
    return { kind: "ok", text: `已用当前登录态更新「${effect.name}」` };
  }
  if (effect.type === "renamed") {
    return { kind: "ok", text: `已重命名为「${effect.name}」` };
  }
  if (effect.type === "deleted") {
    return { kind: "ok", text: `已删除「${effect.name}」` };
  }
  if (effect.type === "restored") {
    return { kind: "ok", text: `已恢复「${effect.name}」` };
  }
  if (effect.type === "fresh") {
    return { kind: "ok", text: "当前页面已清空并刷新。登录新账号后，点「保存当前登录」存下来。" };
  }
  if (effect.type === "switched") {
    const where = effect.navigated ? "正在回到保存它的页面" : "页面正在刷新";
    if (effect.failedCount > 0) {
      return {
        kind: "warn",
        text: `已切换到「${effect.name}」，${where}。有 ${effect.failedCount} 个 Cookie 没能写回`,
      };
    }
    return { kind: "ok", text: `已切换到「${effect.name}」，${where}` };
  }
  return null;
}
