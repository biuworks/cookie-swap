const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "net.uk",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
  "com.hk", "com.tw", "org.tw", "gov.tw", "idv.tw",
  "com.sg", "com.my", "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "or.kr", "ne.kr",
  "com.au", "net.au", "org.au", "edu.au",
  "com.br", "com.mx", "co.nz", "co.za", "co.in", "com.tr",
  "github.io", "blogspot.com", "vercel.app", "netlify.app", "pages.dev",
  "workers.dev", "web.app", "firebaseapp.com", "herokuapp.com",
]);

function isIpAddress(host) {
  if (host.includes(":")) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split(".").every((part) => Number(part) <= 255);
}

export function registrableDomain(hostname) {
  const host = String(hostname ?? "").trim().replace(/\.$/, "").toLowerCase();
  if (!host || host.includes("..") || host.startsWith(".")) {
    throw new Error("无效的主机名");
  }
  if (host === "localhost" || host.endsWith(".localhost") || isIpAddress(host)) return host;

  const labels = host.split(".");
  if (labels.some((label) => !label)) throw new Error("无效的主机名");
  if (labels.length === 1) return host;

  const suffix = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(suffix)) {
    return labels.length < 3 ? host : labels.slice(-3).join(".");
  }
  return suffix;
}

export function pageOrigin(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "";
  }
}

export function readPageTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "先打开一个普通网页" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "这个页面没有网站登录态。打开要切换账号的网页后再试。" };
  }
  try {
    return {
      ok: true,
      origin: url.origin,
      siteKey: registrableDomain(url.hostname),
      hostLabel: url.host,
    };
  } catch {
    return { ok: false, reason: "无法识别这个网站的域名" };
  }
}
