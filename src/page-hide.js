(() => {
  // Re-injection refreshes authorization, never installs a second listener.
  const key = '__cookieSwapStorageObserverV2';
  if (globalThis[key]) { globalThis[key].authorize(); return; }
  const state = { context: null, sequence: 0 };
  const dump = storage => {
    try {
      const out = Object.create(null);
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i); const value = storage.getItem(key);
        if (key != null && typeof value === 'string') out[key] = value;
      }
      return out;
    } catch { return null; }
  };
  state.authorize = () => {
    const sequence = ++state.sequence;
    state.context = null;
    chrome.runtime.sendMessage({ type: 'observer-ready' }).then(result => {
      if (sequence === state.sequence) state.context = result?.ok ? result.observer : null;
    }).catch(() => {});
  };
  const flush = () => {
    const context = state.context;
    if (!context || context.origin !== location.origin) return;
    const local = dump(localStorage); const session = dump(sessionStorage);
    if (!local || !session) return;
    chrome.runtime.sendMessage({ type: 'flush-storage', ...context, localStorage: local, sessionStorage: session }).catch(() => {});
  };
  globalThis[key] = state;
  window.addEventListener('pagehide', flush);
  window.addEventListener('pageshow', state.authorize);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  state.authorize();
})();
