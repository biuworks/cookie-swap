function dumpStorage(storage) {
  const out = {};
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key == null) continue;
      const value = storage.getItem(key);
      if (typeof value === "string") out[key] = value;
    }
  } catch {
    return null;
  }
  return out;
}

window.addEventListener("pagehide", () => {
  const localStorageDump = dumpStorage(localStorage);
  const sessionStorageDump = dumpStorage(sessionStorage);
  if (!localStorageDump || !sessionStorageDump) return;
  chrome.runtime.sendMessage({
    type: "flush-storage",
    href: location.href,
    localStorage: localStorageDump,
    sessionStorage: sessionStorageDump,
  }).catch(() => {});
});
