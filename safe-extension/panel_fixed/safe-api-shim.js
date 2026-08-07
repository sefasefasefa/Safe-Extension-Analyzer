/*
 * Safe compatibility layer for the UI.
 *
 * The extension intentionally does not request the "cookies" permission.
 * Older bundled UI code still asks whether a session cookie exists; answer
 * from the extension's own cached profile marker instead of touching browser
 * cookies. This is only a compatibility response and is never a credential.
 */
'use strict';

(function installSafeCookieCompatibility() {
  if (!globalThis.chrome || globalThis.chrome.cookies) return;

  const getLocalUser = (callback) => {
    try {
      chrome.storage.local.get(['igUser'], (data) => {
        callback(data?.igUser?.pk ? { value: 'local-session-marker' } : null);
      });
    } catch {
      callback(null);
    }
  };

  globalThis.chrome.cookies = {
    get(_details, callback) {
      getLocalUser(callback);
    },
    getAll(_details, callback) {
      getLocalUser((cookie) => callback(cookie ? [cookie] : []));
    },
  };
})();