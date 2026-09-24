import { readPageTarget } from "./domain.js";

function assertProfile(profile) {
  const target = readPageTarget(profile?.origin);
  if (!profile?.id || !profile.name || !target.ok || target.origin !== profile.origin) {
    throw new Error("快照数据不可用");
  }
  if (!Array.isArray(profile.cookies) || profile.siteKey !== target.siteKey) {
    throw new Error("快照数据不可用");
  }
}

export async function runSwitch({
  tab,
  profile,
  storeId,
  applyCookies,
  writeStorage,
  reload,
  navigate,
  getTab,
}) {
  const target = readPageTarget(tab?.url || "");
  if (!target.ok) throw new Error(target.reason);
  assertProfile(profile);
  if (target.siteKey !== profile.siteKey) throw new Error("这个快照属于别的网站，没有切换");

  const applied = await applyCookies(profile.siteKey, tab.url, storeId, profile.cookies);
  const navigated = target.origin !== profile.origin;
  try {
    if (navigated) {
      await navigate(tab.id, profile.origin);
      const arrived = await getTab(tab.id);
      const arrivedTarget = readPageTarget(arrived?.url || "");
      if (!arrivedTarget.ok || arrivedTarget.origin !== profile.origin) {
        throw new Error("没能打开保存这个账号时的页面");
      }
    }
    await writeStorage(tab.id, {
      origin: profile.origin,
      localStorage: profile.localStorage || {},
      sessionStorage: profile.sessionStorage || {},
    });
    await reload(tab.id);
  } catch (error) {
    try {
      await applied.rollback();
    } catch {
      throw new Error("切换失败，而且没能恢复原来的 Cookie", { cause: error });
    }
    const message = error?.message || "切换失败";
    throw new Error(`${message}。原来的 Cookie 已恢复`);
  }
  return { failedCount: applied.failedCount, navigated };
}
