// dashboard.js — Takipçi Paneli Dashboard (MV3 CSP uyumlu)
'use strict';

// ── Dashboard state ──────────────────────────────────────────────────
const LOG_KEY = '__analytics_log';
const DEBUG_LOG_KEY = '__automation_debug_log';
const CANDIDATE_REPORTS_KEY = 'lastCandidateReports';
let dovLogs = [];
let dovDebugLogs = [];
let dovCandidateReports = [];
let dovCandidateLastScanAt = 0;
let dovTab_current = 'all';
// (charts removed)

function openDashboard() {
  document.getElementById('dash-overlay').classList.add('open');
  const fab = document.getElementById('dash-fab');
  if (fab) fab.classList.add('hidden');
  // Overlay kapalıyken birikmiş değişiklik varsa taze veri çek
  _dovPendingUpdate = false;
  dovLoadData();
}

function closeDashboard() {
  document.getElementById('dash-overlay').classList.remove('open');
  const fab = document.getElementById('dash-fab');
  if (fab) fab.classList.remove('hidden');
}

// ── Yardımcılar ──────────────────────────────────────────────────────
function dovFmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function dovFmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

// ── Veri Yükleme ─────────────────────────────────────────────────────
async function dovLoadData() {
  const btn = document.getElementById('dovRefreshBtn');
  btn.classList.add('spin');
  try {
    const storage = await new Promise(r => chrome.storage.local.get(null, r));

    // Profil / otomasyon durumu
    const cfgEntry = Object.entries(storage).find(([k, v]) => v && typeof v === 'object' && 'todayCount' in v);
    if (cfgEntry) {
      const cfg = cfgEntry[1];
      const today = cfg.todayCount || 0;
      const maxD  = cfg.maxPerDay || cfg.maxLikesPerRun || 100;
      document.getElementById('dov-today').textContent = today;
      document.getElementById('dov-limit').textContent = '/ ' + maxD + ' limit';
      document.getElementById('dov-prog').style.width = Math.min(100, (today / maxD) * 100) + '%';
      if (cfg.lastActionLabel) {
        document.getElementById('dov-last-action').style.display = 'flex';
        document.getElementById('dov-la-val').textContent = cfg.lastActionLabel;
        document.getElementById('dov-la-ts').textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      }
      dovCandidateReports = Array.isArray(cfg[CANDIDATE_REPORTS_KEY]) ? cfg[CANDIDATE_REPORTS_KEY] : [];
      dovCandidateLastScanAt = Number(cfg.lastScanAt) || 0;
      dovRenderCandidateReports();
    }

    // Gerçek log verisi — yoksa boş göster, ASLA sahte veri kullanma
    dovLogs = Array.isArray(storage[LOG_KEY]) ? storage[LOG_KEY] : [];
    dovDebugLogs = Array.isArray(storage[DEBUG_LOG_KEY]) ? storage[DEBUG_LOG_KEY] : [];
    dovRenderStats();
    dovRenderTable();
    dovRenderDebugLogs();
  } catch (e) {
    // Hata durumunda da gerçek veri yok, boş göster
    dovLogs = [];
    dovRenderStats();
    dovRenderTable();
  } finally {
    btn.classList.remove('spin');
  }
}

function dovRenderDebugLogs() {
  const body = document.getElementById('dov-debug-body');
  const count = document.getElementById('dov-debug-count');
  if (!body || !count) return;
  count.textContent = dovDebugLogs.length + ' kayıt';
  if (!dovDebugLogs.length) {
    body.textContent = 'Henüz otomasyon logu yok. Yenilemeden sonra istek ve hata sonuçları burada görünür.';
    return;
  }
  body.innerHTML = dovDebugLogs.slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0)).slice(0, 80).map(log => {
    const time = log.ts ? new Date(log.ts).toLocaleTimeString('tr-TR') : '--:--:--';
    const level = String(log.level || 'info').toLowerCase();
    const label = level === 'error' ? 'HATA' : level === 'warn' ? 'UYARI' : 'BİLGİ';
    const ctx = log.context ? ` ${dovEscapeHtml(JSON.stringify(log.context))}` : '';
    return `<div class="dov-debug-row ${dovEscapeHtml(level)}">[${time}] ${label}: ${dovEscapeHtml(String(log.message || ''))}${ctx}</div>`;
  }).join('');
}

function dovEscapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char]));
}

function dovRenderCandidateReports() {
  const body = document.getElementById('dov-candidate-body');
  const count = document.getElementById('dov-candidate-count');
  if (!body || !count) return;
  count.textContent = dovCandidateReports.length + ' hesap';
  if (!dovCandidateReports.length) {
    body.textContent = 'Henüz hesap kontrolü tamamlanmadı.';
    return;
  }
  const labels = { story: 'Hikaye', post: 'Gönderi', reel: 'Reels' };
  body.innerHTML = dovCandidateReports.map(report => {
    const summaries = ['story', 'post', 'reel'].map(type => {
      const status = report[type] || {};
      const stateClass = status.error
        ? 'error'
        : status.reasonCode === 'empty_response'
        ? 'empty'
        : status.reasonCode === 'all_liked'
        ? 'liked'
        : 'ok';
      return `<span class="dov-candidate-status ${stateClass}"><b>${labels[type]}:</b> ${dovEscapeHtml(status.display || status.reason || 'Kontrol edilmedi')}</span>`;
    }).join('');
    return `<div class="dov-candidate-row"><span class="dov-candidate-user">${dovEscapeHtml(report.username || 'Bilinmeyen hesap')}</span><span class="dov-candidate-summary">${summaries}</span></div>`;
  }).join('');
}

function dovRenderStats() {
  const likes = dovLogs.filter(dovIsLikeEntry);
  const posts   = likes.filter(l => l.type === 'post').length;
  const stories = likes.filter(l => l.type === 'story').length;
  const reels   = likes.filter(l => l.type === 'reel').length;
  const total   = likes.length;
  document.getElementById('dov-posts').textContent   = dovFmt(posts);
  document.getElementById('dov-stories').textContent = dovFmt(stories);
  document.getElementById('dov-reels').textContent   = dovFmt(reels);
  document.getElementById('dov-total').textContent   = dovFmt(total);
  document.getElementById('dov-posts-sub').textContent   = posts + ' kayıt';
  document.getElementById('dov-stories-sub').textContent = stories + ' kayıt';
  document.getElementById('dov-reels-sub').textContent = reels + ' kayıt';
  const first = likes[likes.length - 1];
  document.getElementById('dov-total-sub').textContent = first ? 'İlk: ' + new Date(first.ts).toLocaleDateString('tr-TR') : '—';
}

function dovTab(tab, el) {
  dovTab_current = tab;
  document.querySelectorAll('.dov-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  dovRenderTable();
}

function dovGetUsername(entry) {
  // New entries have a dedicated username field
  if (entry.username) return entry.username;
  // Old entries: label format is "Hikaye beğenildi (username)"
  const m = (entry.label || '').match(/\(([^)]+)\)$/);
  return m ? m[1] : 'bilinmiyor';
}


function dovMediaToShortcode(mediaId) {
  // Instagram media ID → URL shortcode (base64url)
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(String(mediaId).split('_')[0]); // "_userId" suffix varsa kes
    let code = '';
    while (id > 0n) { code = alphabet[Number(id % 64n)] + code; id /= 64n; }
    return code;
  } catch { return ''; }
}

function dovCardUrl(l) {
  const username = dovGetUsername(l);
  if (l.reportEntry) {
    return username && username !== 'bilinmiyor'
      ? 'https://www.instagram.com/' + encodeURIComponent(username) + '/'
      : '';
  }
  // Hikayelerin kalıcı bir /p/{code}/ adresi yoktur — 24 saat içinde
  // kaybolurlar ve medya ID'si post shortcode'una çevrilemez. O yüzden
  // hikaye kayıtları için doğrudan kullanıcı profiline yönlendir; aksi
  // hâlde Instagram "Sorry, this page isn't available" gösterir.
  if (l.mediaId && l.type !== 'story') {
    const code = dovMediaToShortcode(l.mediaId);
    if (code) {
      const base = l.type === 'reel' ? 'reel' : 'p';
      return `https://www.instagram.com/${base}/${code}/`;
    }
  }
  return username && username !== 'bilinmiyor'
    ? 'https://www.instagram.com/' + encodeURIComponent(username) + '/'
    : '';
}

function dovIsLikeEntry(entry) {
  // Only show actual like entries, not status messages
  if (entry.username) return true;
  if (/beğenildi/i.test(entry.label || '')) return true;
  return false;
}

function dovReportStatusClass(status) {
  if (status?.error || status?.reasonCode === 'request_error') return 'error';
  if (status?.reasonCode === 'all_liked') return 'liked';
  if (status?.reasonCode === 'unliked_available') return 'available';
  if (status?.reasonCode === 'disabled' || status?.reasonCode === 'not_checked') return 'muted';
  return 'empty';
}

function dovReportStatusText(status) {
  if (!status) return 'Kontrol sonucu yok';
  const detail = status.display || status.reason || status.error || 'Kontrol sonucu yok';
  if (status.reasonCode === 'all_liked') return 'Beğenilmedi — içerik var, hepsi zaten beğenilmiş';
  if (status.reasonCode === 'empty_response') return 'Beğenilmedi — bu tür içerik bulunamadı';
  if (status.reasonCode === 'request_error') return `Beğenilmedi — istek hatası: ${detail}`;
  if (status.reasonCode === 'unliked_available') return `Bu turda beğenilmedi — ${detail}`;
  if (status.reasonCode === 'disabled') return `Kontrol edilmedi — ${detail}`;
  if (status.reasonCode === 'not_checked') return `Kontrol edilmedi — ${detail}`;
  return detail;
}

function dovGetReportEntries() {
  return dovCandidateReports.flatMap(report => ['story', 'post', 'reel'].map(type => {
    const status = report?.[type];
    if (!status) return null;
    return {
      reportEntry: true,
      ts: dovCandidateLastScanAt,
      type,
      username: String(report.username || '').replace(/^@/, ''),
      status,
      statusDisplay: dovReportStatusText(status),
    };
  }).filter(Boolean));
}

function dovRenderTable() {
  try {
    const byType = dovTab_current === 'all' ? dovLogs : dovLogs.filter(l => l.type === dovTab_current);
    const likeEntries = byType.filter(dovIsLikeEntry);
    const reportEntries = dovGetReportEntries().filter(l =>
      dovTab_current === 'all' || l.type === dovTab_current
    );
    const filtered = [...likeEntries, ...reportEntries].sort((a, b) => {
      const ta = typeof a.ts === 'number' ? a.ts : (parseInt(a.ts, 10) || 0);
      const tb = typeof b.ts === 'number' ? b.ts : (parseInt(b.ts, 10) || 0);
      return tb - ta;
    });
    const countEl = document.getElementById('dov-log-count');
    if (countEl) {
      countEl.textContent = reportEntries.length
        ? `${likeEntries.length} beğeni · ${reportEntries.length} kontrol`
        : `${likeEntries.length} beğeni`;
    }
    // Ensure the card grid container exists
    let grid = document.getElementById('dov-card-grid');
    if (!grid) {
      const logCard = document.querySelector('.dov-log-card');
      if (logCard) {
        grid = document.createElement('div');
        grid.className = 'dov-card-grid';
        grid.id = 'dov-card-grid';
        logCard.appendChild(grid);
      } else {
        return;
      }
    }
    // Remove any overflow clipping on parent
    const logCard = grid.closest && grid.closest('.dov-log-card');
    if (logCard) logCard.style.overflow = 'visible';

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="dov-empty">
          <div style="font-size:28px">📭</div>
          <p style="color:#6b7280;margin-top:8px;">Henüz beğeni veya kontrol sonucu yok.</p>
          <p style="color:#4b5563;font-size:10px;margin-top:4px;">Otomasyon çalıştığında beğeniler ve neden beğenilmediği burada görünür.</p>
        </div>`;
      return;
    }

    const typeMeta = {
      story: { label: 'Hikaye', icon: '🎬', color: '#a855f7', bg: 'rgba(168,85,247,0.15)' },
      post:  { label: 'Gönderi', icon: '📸', color: '#fb7185', bg: 'rgba(251,113,133,0.15)' },
      reel:  { label: 'Reels', icon: '▶', color: '#fbbf24', bg: 'rgba(251,191,36,0.15)' },
    };

    if (!grid._dovClickBound) {
      grid._dovClickBound = true;
      grid.addEventListener('click', e => {
        const card = e.target.closest('[data-href]');
        if (card) chrome.tabs.create({ url: card.dataset.href, active: true });
      });
    }
    grid.innerHTML = filtered.slice(0, 150).map(l => {
      const meta = typeMeta[l.type] || typeMeta.post;
      const username = dovGetUsername(l);
      const isNamed = username !== 'bilinmiyor';
      if (l.reportEntry) {
        return `
        <div class="dov-user-card dov-status-card ${dovReportStatusClass(l.status)}"${(h => h ? ' data-href="' + h + '"' : '')(dovCardUrl(l))}>
          <div class="dov-card-thumb-wrap"><div class="dov-card-thumb dov-card-thumb-fallback">${meta.icon}</div></div>
          <div class="dov-card-body">
            <div class="dov-card-username">${isNamed ? '@' + dovEscapeHtml(username) : 'Bilinmeyen hesap'}</div>
            <div class="dov-card-reason">${dovEscapeHtml(l.statusDisplay)}</div>
            <div class="dov-card-meta">
              <span class="dov-card-badge" style="color:${meta.color};background:${meta.bg}">${meta.icon} ${meta.label} · Kontrol</span>
              <span class="dov-card-time">${l.ts ? dovFmtDate(l.ts) : 'Son tarama'}</span>
            </div>
          </div>
          <div class="dov-card-count dov-card-status-mark">—</div>
        </div>`;
      }
      const thumb = l.thumbnailUrl
        ? `<img class="dov-card-thumb" src="${l.thumbnailUrl}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="dov-card-thumb dov-card-thumb-fallback">${meta.icon}</div>`;
      return `
        <div class="dov-user-card"${(h => h ? ' data-href="' + h + '"' : '')(dovCardUrl(l))}>
          <div class="dov-card-thumb-wrap">${thumb}</div>
          <div class="dov-card-body">
            <div class="dov-card-username">${isNamed ? '@' + username : (l.label || 'Bilinmeyen')}</div>
            <div class="dov-card-meta">
              <span class="dov-card-badge" style="color:${meta.color};background:${meta.bg}">${meta.icon} ${meta.label}</span>
              <span class="dov-card-time">${dovFmtDate(l.ts)}</span>
            </div>
          </div>
          <div class="dov-card-count">+1</div>
        </div>`;
    }).join('');
  } catch (e) {
    console.warn('[Dashboard] Kart render hatası:', e);
  }
}

// ── Storage değişiklik izleme (canlı güncelleme) ─────────────────────
// Bekleyen güncelleme bayrağı: overlay kapalıyken değişiklik gelirse,
// overlay açılır açılmaz dovLoadData çağrılsın diye işaretlenir.
let _dovPendingUpdate = false;

if (chrome && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const overlayOpen = document.getElementById('dash-overlay')
      && document.getElementById('dash-overlay').classList.contains('open');

    // Overlay kapalıysa güncellemeyi işaretle; açıldığında dovLoadData çağrılır.
    if (!overlayOpen) {
      _dovPendingUpdate = true;
      return;
    }

    if (changes[LOG_KEY]) {
      const newVal = changes[LOG_KEY].newValue;
      dovLogs = Array.isArray(newVal) ? newVal : [];
      dovRenderStats();
      dovRenderTable();
    }
    if (changes[DEBUG_LOG_KEY]) {
      dovDebugLogs = Array.isArray(changes[DEBUG_LOG_KEY].newValue) ? changes[DEBUG_LOG_KEY].newValue : [];
      dovRenderDebugLogs();
    }
    if (changes[CANDIDATE_REPORTS_KEY]) {
      dovCandidateReports = Array.isArray(changes[CANDIDATE_REPORTS_KEY].newValue)
        ? changes[CANDIDATE_REPORTS_KEY].newValue : [];
      dovRenderCandidateReports();
    }

    const cfgChg = Object.entries(changes).find(
      ([, v]) => v.newValue && typeof v.newValue === 'object' && 'todayCount' in (v.newValue || {})
    );
    if (cfgChg) {
      const cfg = cfgChg[1].newValue;
      document.getElementById('dov-today').textContent = cfg.todayCount || 0;
      const m = cfg.maxPerDay || cfg.maxLikesPerRun || 100;
      document.getElementById('dov-limit').textContent = '/ ' + m + ' limit';
      document.getElementById('dov-prog').style.width = Math.min(100, ((cfg.todayCount || 0) / m) * 100) + '%';
      if (cfg.lastActionLabel) {
        document.getElementById('dov-last-action').style.display = 'flex';
        document.getElementById('dov-la-val').textContent = cfg.lastActionLabel;
        document.getElementById('dov-la-ts').textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      }
      dovCandidateReports = Array.isArray(cfg[CANDIDATE_REPORTS_KEY]) ? cfg[CANDIDATE_REPORTS_KEY] : [];
      dovCandidateLastScanAt = Number(cfg.lastScanAt) || 0;
      dovRenderCandidateReports();
      dovRenderTable();
    }
  });
}

// ── Background'dan gelen anlık durum güncellemeleri ─────────────────────
if (chrome && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'IG_AUTO_STATUS') {
      dovLoadData();
    }
  });
}

// ── Dashboard açıkken düzenli aralıklarla yenile (yedek: 2 sn) ──────────
setInterval(() => {
  const overlay = document.getElementById('dash-overlay');
  if (overlay && overlay.classList.contains('open')) {
    dovLoadData();
  }
}, 2000);

// ── Olay dinleyicileri (MV3 CSP: inline onclick yasak) ───────────────
document.addEventListener('DOMContentLoaded', function () {
  const fab = document.getElementById('dash-fab');
  if (fab) fab.addEventListener('click', openDashboard);

  const refreshBtn = document.getElementById('dovRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', dovLoadData);

  document.querySelectorAll('.dov-tab').forEach(function (btn) {
    const tab = btn.getAttribute('data-tab');
    btn.addEventListener('click', function () { dovTab(tab, btn); });
  });
});
