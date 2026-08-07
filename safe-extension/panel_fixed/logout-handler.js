// logout-handler.js — Uzantı verilerini temizleme düğmeleri
(function () {
  'use strict';

  function clearExtensionData(button) {
    if (button?.dataset.busy === '1') return;
    if (button) {
      button.dataset.busy = '1';
      button.disabled = true;
    }

    chrome.runtime.sendMessage({ type: 'CLEAR_EXTENSION_DATA' }, res => {
      if (button) {
        button.dataset.busy = '0';
        button.disabled = false;
      }
      if (!res?.ok) {
        console.error('[Takipçi Paneli] Uzantı verileri temizlenemedi:', res?.error || 'bilinmiyor');
      }
    });
  }

  function makeButton(id, label, title) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = 'dov-refresh';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = label;
    button.addEventListener('click', () => clearExtensionData(button));
    return button;
  }

  function addHeaderButton() {
    const header = document.querySelector('.dov-header');
    if (!header || document.getElementById('dov-logout-btn')) return;
    const button = makeButton(
      'dov-logout-btn',
      'Verileri temizle',
      'Uzantının yerel verilerini temizle',
    );
    button.style.marginLeft = '8px';
    const refreshButton = document.getElementById('dovRefreshBtn');
    if (refreshButton && refreshButton.parentElement === header) {
      header.insertBefore(button, refreshButton);
    } else {
      header.appendChild(button);
    }
  }

  function addFloatingButton() {
    if (document.getElementById('floating-logout-btn')) return;
    const button = makeButton(
      'floating-logout-btn',
      'Temizle',
      'Uzantının yerel verilerini temizle',
    );
    button.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      min-width: 64px;
      height: 32px;
      padding: 0 8px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(20,20,28,0.9);
      color: #f87171;
      cursor: pointer;
      backdrop-filter: blur(4px);
      transition: all 0.2s;
    `;
    document.body.appendChild(button);
  }

  function init() {
    addHeaderButton();
    addFloatingButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  const observer = new MutationObserver(init);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();