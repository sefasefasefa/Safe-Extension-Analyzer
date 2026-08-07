// inject-nav.js — Dashboard sekmesini alt nav'a enjekte eder
'use strict';

(function () {
  var _dashOpen = false;

  /* ── Diğer nav öğelerinin aktif görünümünü kaldır / geri yükle ── */
  function _deactivateOthers() {
    var nav = document.querySelector('nav');
    if (!nav) return;
    nav.querySelectorAll('a, button').forEach(function (el) {
      if (el.id === 'dash-nav-btn') return;
      // React nav: aktif buton text-white sınıfına sahip olur
      if (el.classList.contains('text-white')) {
        el.dataset.dashWasActive = '1';
        el.classList.remove('text-white');
        el.classList.add('text-muted-foreground');
      }
      // Framer Motion / React gradient arka plan div'ini gizle
      var bg = el.querySelector('.absolute.inset-1');
      if (bg && bg.style.display !== 'none') {
        bg.dataset.dashBgHidden = '1';
        bg.style.display = 'none';
      }
    });
  }

  function _restoreOthers() {
    var nav = document.querySelector('nav');
    if (!nav) return;
    nav.querySelectorAll('[data-dash-was-active="1"]').forEach(function (el) {
      el.classList.add('text-white');
      el.classList.remove('text-muted-foreground');
      delete el.dataset.dashWasActive;
    });
    nav.querySelectorAll('[data-dash-bg-hidden="1"]').forEach(function (bg) {
      bg.style.display = '';
      delete bg.dataset.dashBgHidden;
    });
  }

  /* ── Overlay aç / kapat ─────────────────────────────── */
  function _open() {
    _dashOpen = true;
    _deactivateOthers();
    var ov = document.getElementById('dash-overlay');
    if (ov) ov.classList.add('open');
    if (typeof dovLoadData === 'function') dovLoadData();
    _syncBtn();
  }
  function _close() {
    _dashOpen = false;
    _restoreOthers();
    var ov = document.getElementById('dash-overlay');
    if (ov) ov.classList.remove('open');
    _syncBtn();
  }
  function _syncBtn() {
    var btn = document.getElementById('dash-nav-btn');
    if (!btn) return;
    if (_dashOpen) btn.classList.add('active');
    else btn.classList.remove('active');
  }

  /* dashboard.js global fonksiyonlarını override et */
  window.openDashboard  = _open;
  window.closeDashboard = _close;

  /* ── Buton oluştur ──────────────────────────────────── */
  function _makeBtn() {
    var btn = document.createElement('button');
    btn.id    = 'dash-nav-btn';
    btn.title = 'Dashboard';
    btn.innerHTML =
      '<div class="dash-nav-bg"></div>' +
      '<div class="dash-nav-inner">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' +
        '</svg>' +
        '<span>Dashboard</span>' +
      '</div>';
    btn.addEventListener('click', function () {
      if (_dashOpen) _close(); else _open();
    });
    if (_dashOpen) btn.classList.add('active');
    return btn;
  }

  /* ── Nav'a enjekte et ───────────────────────────────── */
  function _inject(nav) {
    /* Diğer nav öğelerine tıklanınca overlay kapat */
    nav.querySelectorAll('a, button:not(#dash-nav-btn)').forEach(function (el) {
      if (!el.dataset._dashClose) {
        el.dataset._dashClose = '1';
        el.addEventListener('click', function () { if (_dashOpen) _close(); }, true);
      }
    });

    if (!nav.querySelector('#dash-nav-btn')) {
      nav.appendChild(_makeBtn());
    }
  }

  /* ── DOM hazır olduğunda ve React nav'ı eklediğinde tek observer ── */
  function _watchNav() {
    var nav = document.querySelector('nav');
    if (nav) _inject(nav);
  }

  _watchNav();
  var _observer = new MutationObserver(_watchNav);
  _observer.observe(document.documentElement, { childList: true, subtree: true });
})();
