// settings-card.js — Otomasyon için içerik türü seçimi ayarları
//
// İki farklı sayfada yaşayabilir:
//   1) DOM'da #dov-s-slot varsa → içine otomatik enjekte (popup.html için)
//   2) React-rendered "AYARLAR" başlığı varsa → ondan hemen sonra enjekte
//      (panel.html'nin React AYARLAR sayfası için)
// Hiçbiri yoksa sessizce bekler, hata vermez.

'use strict';

(function () {
  const DOV_S_STYLE = `
.dov-s-card { display:block; width:100%; box-sizing:border-box; margin:0 0 14px; padding:14px; background:rgba(10,10,18,.72); border:1px solid rgba(255,255,255,.08); border-radius:12px; }
.dov-s-head { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
.dov-s-title { font-size:12px; font-weight:700; color:#f0f0f8; letter-spacing:-0.2px; }
.dov-s-sub { font-size:9px; font-family:monospace; color:#6b7280; text-transform:uppercase; letter-spacing:1px; }
.dov-s-row { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
.dov-s-tog { min-width:0; padding:12px 6px; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06); border-radius:10px; cursor:pointer; text-align:center; transition:.15s; font-family:monospace; user-select:none; }
.dov-s-tog:hover { border-color:rgba(131,52,180,.5); }
.dov-s-tog.active { background:linear-gradient(135deg,#833ab4,#fd1d1d); color:#fff; border-color:transparent; box-shadow:0 4px 14px rgba(131,52,180,.25); }
.dov-s-tog-icon { font-size:22px; line-height:1; }
.dov-s-tog-lbl { font-size:10px; font-weight:700; margin-top:6px; text-transform:uppercase; letter-spacing:1px; }
.dov-s-tog-sub { font-size:8px; opacity:.65; margin-top:3px; }
@media (max-width:560px) { .dov-s-row { grid-template-columns:repeat(2,minmax(0,1fr)); } }
.dov-s-save { width:100%; margin-top:12px; padding:9px; font-size:11px; font-weight:700; letter-spacing:.5px; background:linear-gradient(135deg,#833ab4,#fd1d1d); color:#fff; border:none; border-radius:7px; cursor:pointer; transition:.15s; font-family:monospace; }
.dov-s-save:hover { opacity:.92; }
.dov-s-save:active { transform:scale(.98); }
.dov-s-save:disabled { opacity:.5; cursor:not-allowed; }
.dov-s-status { margin-top:8px; font-size:10px; font-family:monospace; color:#6b7280; min-height:14px; }
.dov-s-status.ok  { color:#4ade80; }
.dov-s-status.err { color:#fb7185; }
.dov-s-section-title { margin:10px 12px 4px; font-family:monospace; font-size:9px; color:#c084fc; text-transform:uppercase; letter-spacing:1.4px; font-weight:700; }
`;

  function ensureStyles() {
    if (document.getElementById('dov-s-style')) return;
    const s = document.createElement('style');
    s.id = 'dov-s-style';
    s.textContent = DOV_S_STYLE;
    document.head.appendChild(s);
  }

  function dovInjectSettingsCard(targetEl) {
    const target = targetEl || document.getElementById('dov-s-slot') || document.body;
    if (!target) return;
    if (document.getElementById('dov-s-card')) return;
    ensureStyles();

    const TYPES_META = [
      { key: 'story', icon: '📖', label: 'Hikaye',  sub: '24 saat' },
      { key: 'post',  icon: '📸', label: 'Gönderi', sub: 'kalıcı' },
      { key: 'reel',  icon: '🎬', label: 'Reels',   sub: 'kısa' },
      { key: 'all',   icon: '✦',  label: 'Hepsini Beğen', sub: 'tüm içerikler' },
    ];
    const LABELS = { story: 'Hikâye', post: 'Gönderi', reel: 'Reels' };

    const card = document.createElement('div');
    card.className = 'dov-s-card';
    card.id = 'dov-s-card';
    card.innerHTML = `
      <div class="dov-s-head">
        <div class="dov-s-title">⚙ Otomasyon Ayarları</div>
        <div class="dov-s-sub" style="margin-left:auto">Ne beğenilsin?</div>
      </div>
      <div class="dov-s-row">
        ${TYPES_META.map(t => `
          <div class="dov-s-tog" data-type="${t.key}">
            <div class="dov-s-tog-icon">${t.icon}</div>
            <div class="dov-s-tog-lbl">${t.label}</div>
            <div class="dov-s-tog-sub">${t.sub}</div>
          </div>
        `).join('')}
      </div>
      <button class="dov-s-save" id="dov-s-save">Kaydet</button>
      <div class="dov-s-status" id="dov-s-status">Mevcut ayar yükleniyor…</div>
    `;
    target.appendChild(card);

    const toggles = card.querySelectorAll('.dov-s-tog');
    const saveBtn = card.querySelector('#dov-s-save');
    const status  = card.querySelector('#dov-s-status');
    const selected = new Set(['story', 'post', 'reel']);

    function renderSelection() {
      const order = ['story', 'post', 'reel'].filter(k => selected.has(k));
      return order.map(k => LABELS[k]).join(' + ') || '(hiçbiri)';
    }

    function setAllToggleState() {
      const allToggle = card.querySelector('[data-type="all"]');
      if (allToggle) {
        allToggle.classList.toggle('active', selected.size === 3);
      }
    }

    toggles.forEach(el => {
      el.addEventListener('click', () => {
        const t = el.dataset.type;
        if (t === 'all') {
          const selectAll = selected.size !== 3;
          selected.clear();
          if (selectAll) ['story', 'post', 'reel'].forEach(type => selected.add(type));
          toggles.forEach(toggle => {
            const type = toggle.dataset.type;
            if (type === 'all') return;
            toggle.classList.toggle('active', selected.has(type));
          });
          setAllToggleState();
          status.className = 'dov-s-status';
          status.textContent = selectAll
            ? 'Hepsi seçildi. Kaydetmek için "Kaydet"e bas.'
            : 'İçerik türü seç. Kaydetmek için "Kaydet"e bas.';
          return;
        }
        if (selected.has(t)) {
          if (selected.size === 1) {
            status.className = 'dov-s-status err';
            status.textContent = 'En az bir tür seçili olmalı.';
            el.animate(
              [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
              { duration: 220 }
            );
            return;
          }
          selected.delete(t);
          el.classList.remove('active');
        } else {
          selected.add(t);
          el.classList.add('active');
        }
        setAllToggleState();
        status.className = 'dov-s-status';
        status.textContent = 'Seçili: ' + renderSelection() + '. Kaydetmek için "Kaydet"e bas.';
      });
    });

    // ── Toggleları storage'daki değerlere göre güncelle ─────────────
    function _applyStorageToToggles(igAutoState) {
      const cfg = igAutoState || {};
      const types = Array.isArray(cfg.enabledContentTypes) && cfg.enabledContentTypes.length > 0
        ? cfg.enabledContentTypes.filter(t => ['story', 'post', 'reel'].includes(t))
        : ['story', 'post', 'reel'];
      selected.clear();
      toggles.forEach(el => {
        const t = el.dataset.type;
        if (t === 'all') return;
        if (types.includes(t)) { selected.add(t); el.classList.add('active'); }
        else { el.classList.remove('active'); }
      });
      setAllToggleState();
    }

    // Mevcut değerleri storage'dan yükle
    if (window.chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['igAutoState'], ({ igAutoState }) => {
        _applyStorageToToggles(igAutoState);
        status.className = 'dov-s-status';
        status.textContent = '';
      });

      // ── Canlı güncelleme: storage değiştiğinde toggleları anlık yansıt ──
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes.igAutoState) return;
        // Kullanıcı şu an kaydetme işlemi yapıyorsa (buton disabled) güncelleme yapma
        if (saveBtn.disabled) return;
        _applyStorageToToggles(changes.igAutoState.newValue);
        status.className = 'dov-s-status';
        status.textContent = '';
      });
    } else {
      status.className = 'dov-s-status';
      status.textContent = '';
    }

    saveBtn.addEventListener('click', () => {
      if (selected.size === 0) {
        status.className = 'dov-s-status err';
        status.textContent = 'En az bir tür seçili olmalı.';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Kaydediliyor…';
      const payload = ['story', 'post', 'reel'].filter(k => selected.has(k));
      chrome.runtime.sendMessage(
        { type: 'IG_AUTO_SET', patch: { enabledContentTypes: payload } },
        (resp) => {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Kaydet';
          if (chrome.runtime.lastError) {
            status.textContent = 'Hata: ' + chrome.runtime.lastError.message;
            status.className = 'dov-s-status err';
            return;
          }
          if (resp && resp.ok) {
            status.textContent = payload.length === 3
              ? '✓ Kaydedildi: Hepsi (Hikâye + Gönderi + Reels)'
              : '✓ Kaydedildi: ' + payload.map(k => LABELS[k]).join(' + ');
            status.className = 'dov-s-status ok';
          } else {
            status.textContent = 'Kaydedilemedi — uzantıyı yeniden yüklemeyi dene.';
            status.className = 'dov-s-status err';
          }
        }
      );
    });
  }

  // Globale expose — sayfada slot yoksa elle çağrılabilsin
  window.dovInjectSettingsCard = dovInjectSettingsCard;

  // ── Path 1: #dov-s-slot varsa oraya doğrudan enjekte ─────────────
  function _injectViaSlot() {
    const slot = document.getElementById('dov-s-slot');
    if (!slot) return false;
    if (document.getElementById('dov-s-card')) return true;
    try {
      dovInjectSettingsCard(slot);
      return !!document.getElementById('dov-s-card');
    } catch (e) {
      console.warn('[settings-card] slot inject failed:', e);
      return false;
    }
  }

  // ── Path 2: React "AYARLAR" başlığının hemen altına enjekte ───────
  //
  // ÖNEMLİ TAKİP/AYARLAR FARKINI YAP:
  // React uygulamasında "AYARLAR" kelimesi hem alt navigasyonda bir tab
  // (orada "AYARLAR" yazıyor) hem de bazı sayfa içi bölümlerde
  // (özellikle TAKİP sayfasında kullanıcı eylemi etiketi olarak) geçebiliyor.
  // Hangi sayfada olduğumuzu öğrenmek için ALT NAV'daki AYARLAR butonunun
  // active / aria-current durumuna bakıyoruz. Aktif değilse → sessizce geç.
  function _isInsideNav(el) {
    let p = el;
    while (p && p !== document.body) {
      const tag = (p.tagName || '').toLowerCase();
      if (tag === 'nav' || p.getAttribute('role') === 'navigation') return true;
      p = p.parentElement;
    }
    return false;
  }

  function _findAyarHeading() {
    const candidates = Array.from(document.querySelectorAll(
      'h1,h2,h3,h4,h5,h6,div,p,span,strong,li'
    ));
    return candidates.find(el => {
      if (el.children.length > 0) return false;
      const t = (el.textContent || '').trim();
      if (t !== 'AYARLAR' && t !== 'Ayarlar' && t !== 'ƏYARLAR') return false;
      // nav/footer içinde olmasın — sadece sayfa-içi başlıkları hedefle
      if (_isInsideNav(el)) return false;
      return true;
    });
  }

  function _isAyarTabActive() {
    // React navigasyonu history API ile yaptığı için nav öğesinde "active"
    // sınıfı olmayabilir. Önce gerçek rotayı kontrol et; bu, kartın Ayarlar
    // ekranında güvenilir şekilde görünmesini sağlar.
    try {
      const routeSources = [
        window.location.pathname,
        window.location.hash.replace(/^#/, ''),
        new URLSearchParams(window.location.search).get('path') || '',
      ];
      if (routeSources.some(route => /(?:^|\/)settings(?:\/|$)/i.test(route))) {
        return true;
      }
    } catch (e) {
      // Aşağıdaki DOM tabanlı algılama yedek olarak devam eder.
    }

    // Alt navigasyondaki AYARLAR butonunun aktif olup olmadığını kontrol et
    const links = Array.from(document.querySelectorAll('button, a, div, li'));
    const ayar = links.find(el => {
      if (el.children.length > 0) return false;
      const t = (el.textContent || '').trim().toUpperCase();
      return t === 'AYARLAR' || t === 'ƏYARLAR';
    });
    if (!ayar) return false;
    if (_isInsideNav(ayar) === false) return false; // AYARLAR etiketi nav içinde olmalı
    // Aktif göstergeleri: class, aria, data attribute, parent'a tırmanma
    if (ayar.classList.contains('active')) return true;
    if (ayar.classList.contains('selected')) return true;
    if (ayar.getAttribute('aria-current') === 'page') return true;
    if (ayar.getAttribute('aria-selected') === 'true') return true;
    if (ayar.getAttribute('data-state') === 'active') return true;
    if (ayar.getAttribute('data-active') === 'true') return true;
    // 2 seviye üste kadar active class ara
    let p = ayar.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      if (p.classList && p.classList.contains('active')) return true;
      p = p.parentElement;
    }
    return false;
  }

  function _injectAfterAyar() {
    if (document.getElementById('dov-s-card')) return true;
    if (!_isAyarTabActive()) return false; // kullanıcı AYARLAR sayfasında değil
    const heading = _findAyarHeading();
    if (!heading) return false;
    // Önce geçici kaba yükle, sonra başlık satırının altına taşı.
    // Başlığın kendisi bir flex satırının içindedir; kartı doğrudan
    // başlığın yanına eklemek kartı o satırın dar bir flex item'ı yapar.
    const tmp = document.createElement('div');
    tmp.style.cssText = 'display:contents';
    document.body.appendChild(tmp);
    try {
      dovInjectSettingsCard(tmp);
    } catch (e) {
      console.warn('[settings-card] ayar-page inject failed:', e);
      tmp.remove();
      return false;
    }
    const card = tmp.querySelector('#dov-s-card');
    if (!card) { tmp.remove(); return false; }
    const headingRow = heading.parentElement;
    if (!headingRow || !headingRow.parentNode) {
      card.remove();
      tmp.remove();
      return false;
    }
    headingRow.parentNode.insertBefore(card, headingRow.nextSibling);
    tmp.remove();
    return true;
  }

  // ── Orquestrator: önce slot dene, sonra AYARLAR başlığını bekle ────
  let _done = false;
  function _tryOnce() {
    if (_injectViaSlot())  { _done = true; return true; }
    if (_injectAfterAyar()) { _done = true; return true; }
    // Kart React tarafından route değişiminde kaldırıldıysa daha sonra
    // yeniden eklenebilmesi için kilitli kalma.
    _done = false;
    return false;
  }

  function _startObserver() {
    let attempts = 0;
    const maxAttempts = 60; // ~30 sn (500 ms aralıkla)
    const tick = () => {
      attempts++;
      if (_done) return;
      if (_tryOnce()) return;
      if (attempts >= maxAttempts) return;
      setTimeout(tick, 500);
    };
    tick();

    // React DOM değişikliklerini de dinle (klavye tıklamasıyla AYARLAR sayfası
    // açılınca sayfa yenilenmeden DOM'a gelir)
    try {
      const obs = new MutationObserver(() => {
        _tryOnce();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      // observer başarısızsa sadece tarama modu devam eder
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      _tryOnce();
      _startObserver();
    });
  } else {
    _tryOnce();
    _startObserver();
  }
})();
