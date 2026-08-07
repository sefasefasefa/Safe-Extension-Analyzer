// popup-logout.js — Popup'a gerçek çıkış butonu ekler
(function () {
  'use strict';

  function doLogout() {
    chrome.runtime.sendMessage({ type: 'IG_LOGOUT' }, res => {
      if (res?.ok) {
        window.close();
      } else {
        alert('Çıkış yapılırken hata oluştu: ' + (res?.error || 'bilinmiyor'));
      }
    });
  }

  function addPopupLogoutButton() {
    const wrap = document.querySelector('.analytics-btn-wrap');
    if (!wrap || document.getElementById('popup-logout-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'popup-logout-btn';
    btn.className = 'analytics-btn';
    btn.style.marginTop = '8px';
    btn.style.borderColor = 'rgba(239,68,68,0.35)';
    btn.style.background = 'linear-gradient(135deg, rgba(239,68,68,0.15), rgba(153,27,27,0.1))';
    btn.style.color = '#f87171';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      Çıkış Yap`;
    btn.addEventListener('click', doLogout);
    wrap.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addPopupLogoutButton);
  } else {
    addPopupLogoutButton();
  }

  const observer = new MutationObserver(addPopupLogoutButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
