// popup-init.js — Popup canlı güncelleme desteği
'use strict';

// ── "Paneli Aç" butonunda tekli sekme garantisi ──────────────────────
// popup.js (module, defer) henüz çalışmadan bu dosya yürütülür.
// chrome.tabs.create'i sarmala: panel.html URL'si için varolan sekmeyi
// yeniden açmak yerine öne getir; böylece her girişte yeni sekme açılmaz.
(function () {
  if (!window.chrome || !chrome.tabs) return;
  const _origCreate = chrome.tabs.create.bind(chrome.tabs);
  chrome.tabs.create = function (props, callback) {
    const panelBase = chrome.runtime.getURL('panel.html');
    if (props && props.url && props.url.startsWith(panelBase)) {
      chrome.tabs.query({}, function (tabs) {
        const existing = tabs.find(t => t.url && t.url.startsWith(panelBase));
        if (existing && existing.id != null) {
          // Zaten açık → sadece öne getir
          chrome.tabs.update(existing.id, { active: true });
          if (typeof callback === 'function') callback(existing);
          window.close(); // popup'ı kapat
        } else {
          _origCreate(props, callback);
        }
      });
      return;
    }
    return _origCreate(props, callback);
  };
})();

// ── igUser veya igUserTs değiştiğinde popupu yenile ──────────────────
(function () {
  if (!window.chrome || !chrome.storage || !chrome.storage.onChanged) return;
  let _reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.igUser && !changes.igUserTs) return;
    // Çift tetiklemeyi önlemek için kısa bir debounce
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => window.location.reload(), 300);
  });
})();
