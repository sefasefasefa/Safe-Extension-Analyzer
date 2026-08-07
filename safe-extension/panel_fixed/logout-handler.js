// logout-handler.js — Paneldeki herhangi bir "Çıkış / Logout" butonunu gerçek çıkışa bağlar
(function () {
  'use strict';

  function doLogout() {
    chrome.runtime.sendMessage({ type: 'IG_LOGOUT' }, res => {
      if (res?.ok) {
        window.location.href = 'https://www.instagram.com/accounts/login/';
      } else {
        console.error('[Takipçi Paneli] Çıkış hatası:', res?.error || 'bilinmiyor');
      }
    });
  }

  // Leaf element kontrolü — textContent dahil tam eşleşme.
  // Sadece attachLogoutListeners'da (belirli buton/link taraması) kullanılır.
  function isLogoutElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').toLowerCase();
    const className = (el.className || '').toString().toLowerCase();
    const labels = ['çıkış', 'logout', 'log out', 'sign out', 'signout', 'oturum kapat', 'kapat', 'exit', 'leave'];
    const matchesText = labels.some(l => text.includes(l));
    const matchesClass = /logout|signout|sign-out|oturum-kapat|çıkış/.test(className);
    return matchesText || matchesClass;
  }

  // Capture-phase ata yürüyüşü için KATI kontrol.
  // textContent KULLANMAZ çünkü ata elementin tüm alt ağacındaki metni içerir.
  // (Örn: Instagram <nav> içinde "Çıkış Yap" varsa, nav'daki her tıklama logout tetikler.)
  // Sadece elementin kendi aria-label / title / className'ini kontrol eder.
  // Ayrıca 'kapat' / 'leave' / 'exit' gibi çok genel kelimeleri dışarıda bırakır.
  function isLogoutElementStrict(el) {
    if (!el || el.nodeType !== 1) return false;
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
    const className = (el.className || '').toString().toLowerCase();
    const strictLabels = ['çıkış', 'logout', 'log out', 'sign out', 'signout', 'oturum kapat'];
    const matchesLabel = strictLabels.some(l => label.includes(l));
    const matchesClass = /logout|signout|sign-out|oturum-kapat|çıkış/.test(className);
    return matchesLabel || matchesClass;
  }

  // Eklentinin kendi UI elementleri olup olmadığını kontrol et — bunlar asla logout tetiklememeli
  function isExtensionElement(el) {
    return !!(
      el.id === 'dash-nav-btn' ||
      el.id === 'dash-overlay' ||
      el.closest?.('#dash-overlay') ||
      el.closest?.('#dash-nav-btn') ||
      el.closest?.('.dov-s-card') ||
      el.closest?.('#dov-s-card')
    );
  }

  // Doküman seviyesinde capture-phase dinleyici — React sentetik event'lerden önce çalışır.
  // DÜZELTME: Ata yürüyüşünde textContent yerine isLogoutElementStrict kullanılır;
  // böylece Instagram nav'ının "Çıkış Yap" metnini içermesi Dashboard butonunu tetiklemez.
  document.addEventListener('click', (e) => {
    // Eklentinin kendi elementlerine tıklandıysa hiçbir şey yapma
    if (isExtensionElement(e.target)) return;

    let el = e.target;
    while (el && el !== document.body) {
      if (isLogoutElementStrict(el)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        doLogout();
        return;
      }
      el = el.parentElement;
    }
  }, true);

  // Mevcut sayfadaki "Çıkış" yazılı butonları doğrudan yakala (yedek)
  function attachLogoutListeners() {
    const selectors = 'button, a, [role="button"], [role="menuitem"], div[onclick], svg';
    const elements = Array.from(document.querySelectorAll(selectors));
    for (const el of elements) {
      if (el.dataset.logoutBound || el.closest('[data-logout-bound]')) continue;
      // Eklentinin kendi elementlerini atla
      if (isExtensionElement(el)) continue;
      if (isLogoutElement(el)) {
        el.dataset.logoutBound = '1';
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          doLogout();
        }, true);
      }
    }
  }

  // Ekstra güvenlik için dashboard başlığına görünür çıkış butonu ekle
  function addHeaderLogoutButton() {
    const header = document.querySelector('.dov-header');
    if (!header || document.getElementById('dov-logout-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'dov-logout-btn';
    btn.className = 'dov-refresh';
    btn.title = 'Çıkış Yap';
    btn.style.marginLeft = '8px';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>`;
    btn.addEventListener('click', doLogout);
    const refreshBtn = document.getElementById('dovRefreshBtn');
    if (refreshBtn && refreshBtn.parentElement === header) {
      header.insertBefore(btn, refreshBtn);
    } else {
      header.appendChild(btn);
    }
  }

  // Panel başlığında (sağ üst) her zaman görünür küçük bir çıkış ikonu ekle
  function addFloatingLogoutButton() {
    if (document.getElementById('floating-logout-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'floating-logout-btn';
    btn.title = 'Çıkış Yap';
    btn.setAttribute('aria-label', 'Çıkış Yap');
    btn.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(20,20,28,0.9);
      color: #f87171;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      backdrop-filter: blur(4px);
      transition: all 0.2s;
    `;
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>`;
    btn.addEventListener('click', doLogout);
    document.body.appendChild(btn);
  }

  function init() {
    attachLogoutListeners();
    addHeaderLogoutButton();
    addFloatingLogoutButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  const observer = new MutationObserver(init);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
