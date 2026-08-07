// background.js — Takipçi Paneli Service Worker (MV3)
'use strict';

// ── Global hata yakalama ──────────────────────────────────────────────
self.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  try { console.warn('[Takipçi Paneli] Yakalanmayan promise hatası:', String(event.reason ?? '').slice(0, 200)); } catch {}
});
self.addEventListener('error', event => {
  event.preventDefault();
  try { console.warn('[Takipçi Paneli] Global hata:', String(event.error ?? event.message ?? '').slice(0, 200)); } catch {}
});

// ── Sabitler ─────────────────────────────────────────────────────────
const STATE_KEY       = 'igAutoState';
const LOG_KEY         = '__analytics_log';
const DEBUG_LOG_KEY   = '__automation_debug_log';
const LIKED_KEY       = '__liked_media_ids';
const LIKED_CAP       = 5000; // son 5000 benzer ID'yi "zaten beğenilmiş" say
const REQUEST_CACHE_TTL_MS = 15_000;
const SAFE_AUTO_LIMITS = Object.freeze({
  minDelaySec: [300, 3600],
  maxDelaySec: [300, 3600],
  maxPerDay: [1, 10],
  maxPerHour: [1, 3],
  batchSize: [1, 1],
  batchPauseSec: [1800, 7200],
});
const requestInFlight = new Map();
const requestCache = new Map();
let autolikeInFlight = null;

function requestKey(endpoint, params, method = 'GET', body) {
  return JSON.stringify([
    method,
    endpoint,
    params ?? null,
    body ?? null,
  ]);
}

async function runOncePerKey(key, operation, cacheTtl = 0) {
  const now = Date.now();
  const cached = cacheTtl > 0 ? requestCache.get(key) : null;
  if (cached && cached.expiresAt > now) return cached.value;
  if (requestInFlight.has(key)) return requestInFlight.get(key);

  const pending = Promise.resolve().then(operation);
  requestInFlight.set(key, pending);
  try {
    const value = await pending;
    if (cacheTtl > 0) {
      requestCache.set(key, { value, expiresAt: Date.now() + cacheTtl });
    }
    return value;
  } finally {
    requestInFlight.delete(key);
  }
}

function isRateLimitMessage(error) {
  const message = String(error?.message ?? error ?? '');
  return /(?:\b429\b|rate[\s_-]*limit|feedback_required|please wait|try again later|spam)/i.test(message);
}

// Instagram checkpoint/doğrulama hataları — kullanıcı arayüzünden onay gerektirir.
// Bu hatalar bir kod hatası değil; kullanıcı Instagram'da manuel olarak
// doğrulama yaparsa otomasyon kaldığı yerden devam eder.
// Hata kodu 1357004 = "Challenge required" veya oturum yenileme isteği.
function isInstagramCheckpointError(error) {
  const message = String(error?.message ?? error ?? '');
  return /1357004|checkpoint[_\s]required|challenge[_\s]required|doğrulama gerekti|verification[_\s]required/i.test(message);
}

// Sekme/oturum kaynaklı geçici arızalar: executeScript'in null döndürmesi
// ("Yanıt boş") veya Instagram'ın API uç noktası yerine SPA'nın HTML
// kabuğunu döndürmesi ("beklenmeyen HTML sayfası"). İkisi de genelde 1-2
// deneme içinde kendiliğinden düzelir — gerçek bir hata değil, debug
// panelinde 'warn' olarak işaretlenmeli, 'error' olarak değil.
function isTransientTabIssue(error) {
  const message = String(error?.message ?? error ?? '');
  return message.includes('Yanıt boş')
    || message.includes('beklenmeyen HTML sayfası')
    || message.includes('HTML yanıt');   // REST endpoint'i JSON yerine HTML döndürdü
}


// ── OPFS Kalıcı Log Yazıcısı ─────────────────────────────────────────
// Tüm olaylar automation_log.ndjson dosyasına sürekli eklenir.
// Dosya 1 GB'ı aşarsa otomatik olarak silinip yeniden oluşturulur.
// DevTools → Uygulama → Depolama → OPFS bölümünden erişilebilir.
const OPFS_LOG_FILE    = 'automation_log.ndjson';
const OPFS_SIZE_LIMIT  = 1_000_000_000; // 1 GB

async function opfsWriteLog(kind, entry) {
  try {
    const root        = await navigator.storage.getDirectory();
    const fileHandle  = await root.getFileHandle(OPFS_LOG_FILE, { create: true });
    const file        = await fileHandle.getFile();
    const currentSize = file.size;

    const line = JSON.stringify({ kind, ...entry }) + '\n';

    if (currentSize >= OPFS_SIZE_LIMIT) {
      // 1 GB aşıldı — eski dosyayı sil ve yenisini başlat
      try { await root.removeEntry(OPFS_LOG_FILE); } catch {}
      const freshHandle  = await root.getFileHandle(OPFS_LOG_FILE, { create: true });
      const freshWritable = await freshHandle.createWritable();
      await freshWritable.write(line);
      await freshWritable.close();
    } else {
      // Mevcut dosyanın sonuna ekle
      const writable = await fileHandle.createWritable({ keepExistingData: true });
      await writable.seek(currentSize);
      await writable.write(line);
      await writable.close();
    }
  } catch {
    // OPFS yazma hatası — sessizce geç; storage.local yedek olarak çalışmaya devam eder
  }
}

const DEFAULT_STATE = {
  enabled: false,
  timeFrom: 0,
  timeTo: 24,
  minDelaySec: 300,
  maxDelaySec: 900,
  maxPerDay: 10,
  maxPerHour: 3,            // saatlik güvenlik sınırı
  targetType: 'reels',
  todayCount: 0,
  todayDate: '',
  hourlyCount: 0,           // mevcut saat dilimindeki beğeni sayısı
  hourlyWindowStart: 0,     // mevcut saat diliminin başlangıç zamanı (ms)
  nextRunAt: 0,
  backoffUntil: 0,
  consecutiveErrors: 0,
  lastActionLabel: '',
  batchSize: 1,             // her işlem ayrı bir güvenlik aralığı kullanır
  batchPauseSec: 1800,      // ardışık işlemler arasında en az 30 dk
  enabledContentTypes: ['story', 'post', 'reel'], // kullanıcı seçer
  sessionValid: false,
  sessionReason: '',
  sessionUsername: '',
  sessionUserId: '',
  sessionCheckedAt: 0,
};

function clampNumber(value, [min, max], fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeAutomationState(input) {
  const state = { ...DEFAULT_STATE, ...(input ?? {}) };
  state.timeFrom = 0;
  state.timeTo = 24;
  state.minDelaySec = clampNumber(state.minDelaySec, SAFE_AUTO_LIMITS.minDelaySec, DEFAULT_STATE.minDelaySec);
  state.maxDelaySec = clampNumber(state.maxDelaySec, SAFE_AUTO_LIMITS.maxDelaySec, DEFAULT_STATE.maxDelaySec);
  state.maxDelaySec = Math.max(state.maxDelaySec, state.minDelaySec);
  state.maxPerDay = clampNumber(state.maxPerDay, SAFE_AUTO_LIMITS.maxPerDay, DEFAULT_STATE.maxPerDay);
  state.maxPerHour = clampNumber(state.maxPerHour, SAFE_AUTO_LIMITS.maxPerHour, DEFAULT_STATE.maxPerHour);
  state.batchSize = clampNumber(state.batchSize, SAFE_AUTO_LIMITS.batchSize, DEFAULT_STATE.batchSize);
  state.batchPauseSec = clampNumber(state.batchPauseSec, SAFE_AUTO_LIMITS.batchPauseSec, DEFAULT_STATE.batchPauseSec);
  state.targetType = ['reels', 'posts', 'stories', 'all'].includes(state.targetType)
    ? state.targetType
    : DEFAULT_STATE.targetType;
  state.enabledContentTypes = Array.isArray(state.enabledContentTypes)
    ? [...new Set(state.enabledContentTypes.filter(type => ['story', 'post', 'reel'].includes(type)))]
    : [...DEFAULT_STATE.enabledContentTypes];
  if (state.enabledContentTypes.length === 0) {
    state.enabledContentTypes = [...DEFAULT_STATE.enabledContentTypes];
  }
  return state;
}

// ── "Zaten beğenilmiş" medya ID'leri (tekrar beğenmemek için) ─────────
// Instagram'ın "PolarisProfileLikeListQuery" döndüğü zaman bile nadiren
// yakın tarihli bir içeriği geri getirebiliyor + getFollowing() zaten
// büyük liste döndürüyor. Bu yüzden istemci tarafında da bir "beğenildi"
// set tutarız: önceden beğenilen medya ID'leri cache'lenir, autolikeTick
// döngüsünde aday seçerken bunlar filtrelenir.
// Set service worker yeniden başladığında storage'dan geri yüklenir.
const _likedCache = new Set();
let _likedLoaded = false;
let _likedPersistTimer = null;

async function loadLikedCache() {
  if (_likedLoaded) return;
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get([LIKED_KEY], resolve));
    const arr = Array.isArray(stored[LIKED_KEY]) ? stored[LIKED_KEY] : [];
    for (const e of arr) {
      if (e && e.id) _likedCache.add(String(e.id));
    }
    _likedLoaded = true;
  } catch {
    _likedLoaded = true; // hata olsa bile sonsuza dek retry yapma
  }
}

function markLiked(mediaId) {
  if (!mediaId) return;
  const id = String(mediaId);
  if (_likedCache.has(id)) return;
  _likedCache.add(id);
  scheduleLikedPersist();
}

function scheduleLikedPersist() {
  if (_likedPersistTimer) return;
  _likedPersistTimer = setTimeout(() => {
    _likedPersistTimer = null;
    persistLikedCache().catch(() => {});
  }, 4000);
}

async function persistLikedCache() {
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get([LIKED_KEY], resolve));
    const existing = Array.isArray(stored[LIKED_KEY]) ? stored[LIKED_KEY] : [];
    const now = Date.now();
    const existingIds = new Set(existing.map(e => e && e.id).filter(Boolean));
    const merged = existing.slice();
    for (const id of _likedCache) {
      if (!existingIds.has(id)) {
        merged.push({ id, ts: now });
        existingIds.add(id);
      }
    }
    merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const capped = merged.slice(0, LIKED_CAP);
    await chrome.storage.local.set({ [LIKED_KEY]: capped });
  } catch {
    // bir sonraki tick'te tekrar dener
  }
}

// Service worker yeniden başladığında cache'i geri yükle
chrome.runtime.onStartup?.addListener(() => {
  _likedCache.clear();
  _likedLoaded = false;
  loadLikedCache().catch(() => {});
});
chrome.runtime.onInstalled?.addListener(() => {
  loadLikedCache().catch(() => {});
});
// İlk mesajda da yüklemeyi tetikle (SW zaten ayakta olabilir)
loadLikedCache().catch(() => {});

// ── Storage yardımcıları ──────────────────────────────────────────────
function getState() {
  return new Promise(resolve =>
    chrome.storage.local.get([STATE_KEY], data => {
      const state = normalizeAutomationState(data[STATE_KEY]);
      // Clear any stale schedule-related label from older builds.
      if (state.lastActionLabel && (
        state.lastActionLabel.includes('izin verilen saatler') ||
        state.lastActionLabel.includes('Pencere dışı') ||
        state.lastActionLabel === 'Takip edilen adaylarda beğenilmemiş içerik bulunamadı'
      )) {
        state.lastActionLabel = 'Otomasyon 24 saat aktif — yeniden başlatıldı';
      }
      chrome.storage.local.set({ [STATE_KEY]: state });
      resolve(state);
    })
  );
}

function patchState(patch) {
  return new Promise(resolve =>
    chrome.storage.local.get([STATE_KEY], data => {
      const current = normalizeAutomationState(data[STATE_KEY]);
      const next = normalizeAutomationState({ ...current, ...(patch ?? {}) });
      chrome.storage.local.set({ [STATE_KEY]: next }, resolve);
    })
  );
}

async function appendLikeLog(type, username, label, thumbnailUrl = '', mediaId = '') {
  const entry = {
    ts: Date.now(),
    date: todayStr(),
    type,
    count: 1,
    username,
    label: `${label} (${username})`,
    thumbnailUrl,
    mediaId: mediaId ? String(mediaId) : '',
  };
  // Kalıcı OPFS dosyasına yaz
  opfsWriteLog('like', entry).catch(() => {});
  // Dashboard için storage.local kaydını koru
  const stored = await new Promise(resolve => chrome.storage.local.get([LOG_KEY], resolve));
  const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  const duplicate = log.some(item =>
    item?.label === entry.label && Math.abs(Number(item.ts) - entry.ts) < 10000
  );
  if (!duplicate) {
    await new Promise(resolve =>
      chrome.storage.local.set({ [LOG_KEY]: [entry, ...log].slice(0, 2000) }, resolve)
    );
  }
}

async function appendDebugLog(level, message, context = {}) {
  const entry = {
    ts: Date.now(),
    date: todayStr(),
    level,
    message: String(message).slice(0, 500),
    context: JSON.parse(JSON.stringify(context, (_key, value) => {
      if (typeof value === 'string' && value.length > 300) return value.slice(0, 300) + '…';
      return value;
    })),
  };
  // Kalıcı OPFS dosyasına yaz
  opfsWriteLog('debug', entry).catch(() => {});
  // Dashboard için storage.local kaydını koru
  const stored = await new Promise(resolve => chrome.storage.local.get([DEBUG_LOG_KEY], resolve));
  const logs = Array.isArray(stored[DEBUG_LOG_KEY]) ? stored[DEBUG_LOG_KEY] : [];
  await new Promise(resolve => {
    chrome.storage.local.set({ [DEBUG_LOG_KEY]: [entry, ...logs].slice(0, 500) }, () => {
      // Chrome may expose a storage error through lastError in the callback.
      // Consume it so a diagnostic log can never break the service worker.
      void chrome.runtime.lastError;
      resolve();
    });
  });
  // Rate-limit yanıtı beklenen bir Instagram korumasıdır; debug paneline
  // kaydedilir ama DevTools'u gerçek bir uzantı hatası gibi kirletmez.
  // Böylece aynı yanıtın GraphQL + otomasyon katmanlarından gelen tekrarları
  // kullanıcıyı yanıltmaz.
  // Rate-limit ve checkpoint hataları beklenen Instagram korumaları; DevTools'u
  // gerçek uzantı hatası gibi kirletmemeleri için console.error'dan gizlenir.
  const isSuppressedFromConsole = isRateLimitMessage(message) || isInstagramCheckpointError(message);
  if (!isSuppressedFromConsole) {
    try {
      const method = level === 'error' ? 'error' : 'log';
      console[method]('[Takipçi Paneli] [%s] %s', level, String(message).slice(0, 200));
    } catch {
      // console must never break the service worker
    }
  }
}

async function runGraphQLMutation(docId, variables, friendlyName) {
  const storage = await new Promise(resolve =>
    chrome.storage.local.get(['igUser', 'igGqlTokens'], resolve)
  );
  const igUser      = storage.igUser;
  const igGqlTokens = storage.igGqlTokens;
  const userId      = String(igUser?.pk ?? igUser?.fbid_v2 ?? '');

  const tabId = await getInstagramTab();
  try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (docId, variablesStr, friendlyNameArg, actorId, fbDtsg, lsd, csrf) => {
          const win = window;
          let dtsg = fbDtsg, lsdTok = lsd;
          try { dtsg   = win.require?.('DTSGInitData')?.token ?? fbDtsg; } catch {}
          try { lsdTok = win.require?.('LSD')?.token ?? lsd; } catch {}

          const jazoest   = '2' + String(Array.from(dtsg).reduce((a, c) => a + c.charCodeAt(0), 0));
          const variables = JSON.parse(variablesStr);
          if (variables.input && (!variables.input.actor_id || variables.input.actor_id === '__actor_id__')) {
            variables.input.actor_id = actorId;
          }

          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 20000);

          const resp = await fetch('https://www.instagram.com/api/graphql', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-asbd-id': '359341',
              'x-csrftoken': csrf,
              'x-fb-lsd': lsdTok,
              'x-fb-friendly-name': friendlyNameArg,
              'x-ig-app-id': '936619743392459',
              'x-ig-max-touch-points': '1',
              'x-ig-www-claim': '0',
            },
            body: new URLSearchParams({
              av: actorId, __d: 'www', __user: '0', __a: '1',
              fb_dtsg: dtsg, jazoest, lsd: lsdTok,
              variables: JSON.stringify(variables),
              doc_id: docId,
              fb_api_req_friendly_name: friendlyNameArg,
              server_timestamps: 'true',
            }).toString(),
            signal: ctrl.signal,
          });

          const text = await resp.text();
          if (!text || text.trimStart().startsWith('<')) {
            return { ok: false, error: `HTML yanıt (${resp.status})` };
          }
          try {
            const json = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ''));
            if (json.errors?.length) return { ok: false, error: json.errors[0]?.message ?? JSON.stringify(json.errors) };
            // Instagram checkpoint/doğrulama yanıtı: {"__ar":1,"error":NNNN,"errorSummary":"...","errorDescription":"..."}
            // Bu format json.data olmadan gelir; ham JSON yerine okunabilir mesaj döndür.
            if (json.__ar === 1 && json.error) {
              const summary = json.errorSummary ?? json.errorDescription ?? `Instagram hata kodu ${json.error}`;
              return { ok: false, error: `Instagram API hatası (${json.error}): ${summary}` };
            }
            if (json.data == null) return { ok: false, error: `GraphQL data boş: ${JSON.stringify(json).slice(0, 300)}` };
            return { ok: true, data: json };
          } catch {
            return { ok: false, error: text.slice(0, 200) };
          }
        },
        args: [docId, JSON.stringify(variables), friendlyName, userId,
               igGqlTokens?.fbDtsg ?? '', igGqlTokens?.lsd ?? '', igGqlTokens?.csrf ?? ''],
      });

      const res = results[0]?.result;
      if (!res?.ok) {
        const errMsg = res?.error ?? 'Mutation hatası';
        throw new Error(errMsg);
      }
      return res.data;
  } catch (error) {
    throw error;
  }
}

async function callGraphQLMutationUncached(docId, variables, friendlyName) {
  try {
    const data = await runGraphQLMutation(docId, variables, friendlyName);
    if (!data || typeof data !== 'object') throw new Error('GraphQL veri gövdesi boş');
    if (Array.isArray(data.errors) && data.errors.length) {
      throw new Error(data.errors.map(error => error?.message || JSON.stringify(error)).join(' | '));
    }
    return data;
  } catch (error) {
    // Rate-limit ve checkpoint hataları beklenen Instagram korumaları — 'warn' yeterli.
    const isSoftError = isRateLimitMessage(error) || isInstagramCheckpointError(error);
    await appendDebugLog(isSoftError ? 'warn' : 'error', error.message || error, {
      operation: friendlyName,
      docId,
      variables,
    });
    throw error;
  }
}

async function callGraphQLMutation(docId, variables, friendlyName) {
  const key = `graphql:${requestKey(friendlyName, variables, 'POST')}`;
  return runOncePerKey(
    key,
    () => callGraphQLMutationUncached(docId, variables, friendlyName),
    REQUEST_CACHE_TTL_MS,
  );
}

// ── REST v1 beğeni (doc_id bağımsız, daha kararlı) ───────────────────
// Instagram'ın GraphQL beğeni mutasyonları sabit (hardcoded) doc_id değerlerine
// bağlıdır. Instagram web uygulamasını güncellediğinde bu ID'ler değişir ve
// eski ID ile gelen her istek 1357004 ("Üzgünüz, bir hata oluştu") hatasıyla
// reddedilir — kullanıcı Instagram'da herhangi bir doğrulama ekranı GÖRMEZ
// çünkü bu bir challenge değil, "bilinmeyen sorgu" reddidir.
// Mobil uygulamaların kullandığı REST v1 endpoint'i doc_id gerektirmez ve
// bu yüzden çok daha kararlıdır.
async function likeMediaWithRESTInternal(mediaId) {
  const tabId = await getInstagramTab();
  try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (mediaId) => {
          const csrf = document.cookie.split(';')
            .find(c => c.trim().startsWith('csrftoken='))
            ?.split('=').slice(1).join('=') ?? '';
          if (!csrf) return { ok: false, error: 'CSRF token bulunamadı — instagram.com sekmesinde oturum açık mı?' };

          // Instagram'ın API'si için gerekli token'ları sayfadan al
          const win = window;
          let lsd = '';
          let wwwClaim = '0';
          try { lsd = win.require?.('LSD')?.token ?? ''; } catch {}
          try { wwwClaim = win.require?.('IGSCRP')?.claimValue ?? win.__wwwClaim ?? '0'; } catch {}

          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 20000);

          let resp;
          try {
            resp = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/like/`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'x-csrftoken': csrf,
                'x-ig-app-id': '936619743392459',
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded',
                'x-asbd-id': '359341',
                ...(lsd ? { 'x-fb-lsd': lsd } : {}),
                'x-ig-www-claim': wwwClaim,
              },
              body: new URLSearchParams({ d: '1' }).toString(),
              signal: ctrl.signal,
            });
          } catch (e) {
            return { ok: false, error: 'fetch hatası: ' + String(e?.message ?? e) };
          }

          const text = await resp.text();
          if (!text || text.trimStart().startsWith('<')) {
            return { ok: false, error: `HTML yanıt (${resp.status}) — Instagram sekmeye yönlendirdi` };
          }
          try {
            const json = JSON.parse(text);
            if (json.status === 'ok') return { ok: true };
            const msg = json.message ?? json.error_title ?? JSON.stringify(json).slice(0, 200);
            return { ok: false, error: `REST beğeni reddedildi (${resp.status}): ${msg}`, status: resp.status };
          } catch {
            return { ok: false, error: text.slice(0, 200), status: resp.status };
          }
        },
        args: [String(mediaId)],
      });

      const res = results[0]?.result;
      if (!res) throw new Error('Yanıt boş');
      if (!res.ok) throw new Error(res.error ?? `REST beğeni başarısız (${res.status})`);
      return true;
  } catch (error) {
    throw error;
  }
}

async function likeMediaWithREST(mediaId) {
  return runOncePerKey(
    `like:${String(mediaId)}`,
    () => likeMediaWithRESTInternal(mediaId),
    5 * 60_000,
  );
}

async function likeMediaWithGraphQL(mediaId, type) {
  // Tüm içerik türleri için yalnızca REST v1 kullan.
  // Başarısız bir mutasyonu ikinci bir ağ isteğiyle tekrarlama; ilk isteğin
  // sunucuda işlenip yanıtın kaybolduğu belirsiz durumda çift beğeniyi önler.
  try {
    await likeMediaWithREST(mediaId);
    await appendDebugLog('info', `${type} beğeni REST ile başarılı`, { mediaId: String(mediaId) });
    return;
  } catch (restError) {
    const restMsg = restError?.message ?? '';
    if (isRateLimitMessage(restError)) throw restError;
    await appendDebugLog('warn', `${type} beğeni REST başarısız — ikinci istek gönderilmedi`, {
      mediaId: String(mediaId), type, error: restMsg,
    });
    throw restError;
  }
}

// ── Tarih / saat yardımcıları ─────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createContentStatus(enabled = true) {
  return {
    enabled,
    checked: false,
    found: false,
    unliked: false,
    error: '',
    reasonCode: enabled ? 'not_checked' : 'disabled',
    reason: enabled ? 'Kontrol henüz tamamlanmadı' : 'Bu içerik türü ayarlarda kapalı',
    source: '',
    responseCount: 0,
  };
}

function setContentStatus(status, patch) {
  Object.assign(status, patch);
  return status;
}

function describeContentStatus(status) {
  if (!status?.enabled) return 'kapalı (ayarlarda seçilmemiş)';
  if (status.error) {
    return `hata [${status.reasonCode || 'request_error'}]: ${status.error}`;
  }
  if (!status.checked) {
    return `kontrol edilmedi [${status.reasonCode || 'not_checked'}]: ${status.reason || 'Kontrol tamamlanmadı'}`;
  }
  if (status.reasonCode === 'empty_response') {
    return `içerik yok [empty_response]: ${status.reason || 'Instagram yanıtında bu tür içerik bulunmadı'}`;
  }
  if (status.reasonCode === 'invalid_response') {
    return `yanıt anlaşılamadı [invalid_response]: ${status.reason || 'Instagram beklenen medya alanlarını döndürmedi'}`;
  }
  if (status.reasonCode === 'all_liked') return 'içerik var, hepsi zaten beğenilmiş';
  if (status.unliked) return 'beğenilebilir içerik var';
  if (!status.found) {
    return `içerik yok [${status.reasonCode || 'empty_response'}]: ${status.reason || 'Sonuç dönmedi'}`;
  }
  return `içerik bulundu, beğenilebilir değil [${status.reasonCode || 'no_unliked_media'}]`;
}

function normalizeMediaList(response) {
  const output = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 10) return;
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const media = value.media && typeof value.media === 'object' ? value.media : value;
    const id = media.pk ?? media.id ?? media.media_id ?? media.pk_id ?? media.strong_id__;
    const looksLikeMedia = id != null && (
      media.media_type != null || media.image_versions2 || media.video_versions ||
      media.caption != null || media.like_count != null || media.has_liked != null ||
      media.hasLiked != null || media.viewer_has_liked != null || media.code != null ||
      media.product_type != null || media.taken_at != null ||
      media.carousel_media != null || media.thumbnail_src != null ||
      media.display_url != null || media.is_video != null
    );
    if (looksLikeMedia) {
      const key = String(id);
      if (!seen.has(key)) {
        seen.add(key);
        output.push(media);
      }
    }
    // Instagram has returned items/feed_items, sections and nested data
    // under different keys across endpoints and account types.
    for (const [key, child] of Object.entries(value)) {
      if (['user', 'owner', 'caption', 'image_versions2', 'video_versions'].includes(key)) continue;
      if (Array.isArray(child) || (child && typeof child === 'object')) visit(child, depth + 1);
    }
  };
  visit(response);
  return output;
}

function isLikedValue(value) {
  return value === true || value === 1 || value === '1' ||
    (typeof value === 'string' && value.toLowerCase() === 'true');
}

function isUnlikedMedia(media) {
  return !isLikedValue(media?.has_liked ?? media?.hasLiked ?? media?.viewer_has_liked);
}

function getMediaId(media) {
  const raw = media?.pk ?? media?.id ?? media?.media_id ?? media?.pk_id ?? media?.strong_id__ ?? '';
  return String(raw).split('_')[0];
}

function getMediaThumbnail(media) {
  if (media?.image_versions2?.candidates?.length) {
    return media.image_versions2.candidates[0].url;
  }
  if (media?.thumbnail_src) return media.thumbnail_src;
  if (media?.display_url) return media.display_url;
  if (media?.video_versions?.length) {
    return media.video_versions[0].url;
  }
  return '';
}

// Chrome rejects tab activation while the user is dragging/reordering tabs.
// Panel navigation is optional, so never let that transient state create an
// unhandled promise rejection or interrupt the automation.
function focusTabSafely(tab) {
  if (!tab?.id) return;
  Promise.resolve(chrome.tabs.update(tab.id, { active: true }))
    .catch(() => {});
  if (tab.windowId != null) {
    Promise.resolve(chrome.windows.update(tab.windowId, { focused: true }))
      .catch(() => {});
  }
}

// ── Takip listesi önbelleği (4 saat) ─────────────────────────────────
let _followingCache = [];
let _followingCacheTs = 0;
let followingInFlight = null;

// Yanıt nesnesinden kullanıcı listesini çıkar — Instagram farklı şekillerde döndürebilir.
function extractFollowUsers(data) {
  // 1. Standart REST yanıtı: { users: [...] }
  if (Array.isArray(data?.users) && data.users.length > 0) return data.users;
  // 2. Alternatif REST sarmalayıcı: { data: { users: [...] } }
  if (Array.isArray(data?.data?.users) && data.data.users.length > 0) return data.data.users;
  // 3. GraphQL kenar listesi: { data: { user: { edge_follow: { edges: [{node}] } } } }
  const edges = data?.data?.user?.edge_follow?.edges;
  if (Array.isArray(edges) && edges.length > 0) return edges.map(e => e.node ?? e);
  // 4. Bazı GraphQL yanıtlarında doğrudan items/list alanı
  if (Array.isArray(data?.items) && data.items.length > 0) return data.items;
  return [];
}

function normalizeFollowEntry(u) {
  const id       = String(u.pk ?? u.id ?? u.fbid_v2 ?? '').trim();
  const username = String(u.username ?? '').trim();
  if (!username) return null;
  // pk yoksa username'i id olarak kabul et (otomasyon için yeterli)
  return { id: id || username, username };
}

// content-script'in requestJson'ına tabs.sendMessage ile istek gönderir.
// execRestInTab'dan farklı olarak izole world'de çalışır ve x-ig-www-claim
// başlığını asla göndermez (yanlış '0' değeri friendship endpoint'ini bozuyor).
async function igFetchViaContentScript(endpoint, params) {
  const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
  const tab = tabs.find(t => t.id != null && !t.url?.includes('/accounts/'))
           ?? tabs.find(t => t.id != null);
  if (!tab?.id) throw new Error('Açık Instagram sekmesi bulunamadı');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IG_FETCH zaman aşımı (30s)')), 30000);
    chrome.tabs.sendMessage(
      tab.id,
      { type: 'IG_FETCH', endpoint, params },
      response => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message ?? 'sendMessage hatası'));
        }
        if (response?.ok) resolve(response.data);
        else reject(new Error(response?.error ?? 'IG_FETCH başarısız'));
      }
    );
  });
}

async function getFollowingInternal(userId) {
  if (_followingCache.length > 0 && Date.now() - _followingCacheTs < 4 * 3600000) {
    return _followingCache;
  }

  // KAT 1: Panel'in IG_API handler'ından doldurulan __cached_following deposu.
  // Kullanıcı liste sekmesini açmışsa bu veri zaten hazır olabilir.
  try {
    const stored = await new Promise(resolve =>
      chrome.storage.local.get(['__cached_following'], resolve)
    );
    const cached = stored.__cached_following;
    const cacheAge = cached?.ts ? Date.now() - cached.ts : Infinity;
    if (Array.isArray(cached?.users) && cached.users.length > 0 && cacheAge < 4 * 3600000) {
      const allUsers = cached.users.map(normalizeFollowEntry).filter(Boolean);
      if (allUsers.length > 0) {
        _followingCache   = allUsers;
        _followingCacheTs = Date.now();
        await appendDebugLog('info', `getFollowing: storage cache'ten ${allUsers.length} kullanıcı yüklendi`);
        return _followingCache;
      }
    }
  } catch {}

  // İki yöntemi sırayla dene; her ikisi de başarısızsa hatayı fırlat.
  let lastError = null;

  // KAT 2: tabs.sendMessage → content-script IG_FETCH (isolated world).
  // execRestInTab x-ig-www-claim: 0 gönderiyor ve bu friendship endpoint'ini
  // reddettiriyor; content-script o başlığı hiç göndermez.
  try {
    const allUsers = [];
    let maxId = null;
    let pages = 0;
    const MAX_PAGES = 3;
    do {
      const params = { count: '50' };
      if (maxId) params.max_id = maxId;
      const data = await igFetchViaContentScript(
        `/api/v1/friendships/${userId}/following/`, params
      );
      const rawUsers = extractFollowUsers(data);
      for (const u of rawUsers) {
        const entry = normalizeFollowEntry(u);
        if (entry) allUsers.push(entry);
      }
      await appendDebugLog('info', `getFollowing (CS): sayfa ${pages + 1} — ${rawUsers.length} ham, ${allUsers.length} toplam`, {
        responseKeys: Object.keys(data ?? {}).slice(0, 15),
        sampleUser: rawUsers[0] ? Object.keys(rawUsers[0]) : [],
      });
      maxId = data.next_max_id ?? null;
      pages++;
    } while (maxId && pages < MAX_PAGES);

    _followingCache   = allUsers;
    _followingCacheTs = Date.now();
    if (allUsers.length > 0) {
      // Service worker yeniden başladığında bellek sıfırlanır; storage'a da yaz.
      chrome.storage.local.set({ __cached_following: { users: allUsers, ts: Date.now() } });
      return _followingCache;
    }
    // 0 kullanıcı döndü — KAT 3'e geç
    lastError = new Error('Content-script isteği 0 kullanıcı döndürdü');
  } catch (err) {
    if (isRateLimitMessage(err)) throw err;
    lastError = err;
    await appendDebugLog('warn', `getFollowing CS hata: ${String(err.message ?? err).slice(0, 200)}`);
  }

  // KAT 3: execRestInTab (executeScript tabanlı yedek).
  try {
    const allUsers = [];
    let maxId = null;
    let pages = 0;
    const MAX_PAGES = 3;
    do {
      const params = { count: '50' };
      if (maxId) params.max_id = maxId;
      const data = await apiCall(`/api/v1/friendships/${userId}/following/`, params);
      const rawUsers = extractFollowUsers(data);
      for (const u of rawUsers) {
        const entry = normalizeFollowEntry(u);
        if (entry) allUsers.push(entry);
      }
      await appendDebugLog('info', `getFollowing (exec): sayfa ${pages + 1} — ${rawUsers.length} ham, ${allUsers.length} toplam`, {
        responseKeys: Object.keys(data ?? {}).slice(0, 15),
        sampleUser: rawUsers[0] ? Object.keys(rawUsers[0]) : [],
      });
      maxId = data.next_max_id ?? null;
      pages++;
    } while (maxId && pages < MAX_PAGES);

    _followingCache   = allUsers;
    _followingCacheTs = Date.now();
    if (allUsers.length > 0) {
      // Service worker yeniden başladığında bellek sıfırlanır; storage'a da yaz.
      chrome.storage.local.set({ __cached_following: { users: allUsers, ts: Date.now() } });
    }
    lastError = null;
  } catch (error) {
    if (isRateLimitMessage(error)) throw error;
    lastError = error;
    await appendDebugLog('error', `getFollowing exec hata: ${String(error.message ?? error).slice(0, 300)}`);
  }

  // Her iki kat da başarısız olduysa hatayı fırlat (caller mesaj üzerine yazar)
  if (_followingCache.length === 0 && lastError) {
    throw new Error(`Takip listesi alınamadı: ${String(lastError.message ?? lastError).slice(0, 150)}`);
  }

  return _followingCache;
}

async function getFollowing(userId) {
  if (followingInFlight) return followingInFlight;
  followingInFlight = getFollowingInternal(userId);
  try {
    return await followingInFlight;
  } finally {
    followingInFlight = null;
  }
}

// ── Instagram sekmesi bulma / açma ───────────────────────────────────
async function getInstagramTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
  const tab =
    tabs.find(t => t.id != null && t.status === 'complete' && !t.url?.includes('/accounts/')) ??
    tabs.find(t => t.id != null && t.status === 'complete') ??
    tabs.find(t => t.id != null);

  if (tab?.id != null) {
    if (tab.status !== 'complete') {
      await new Promise(resolve => {
        const id = tab.id;
        // NOT: Bu süre panel.js'teki IG_API mesaj zaman aşımından (60sn) kısa
        // tutulmalı — aksi halde panel "Veriler yüklenemedi" hatasını sekme
        // hâlâ background'da yüklenirken gösterir. 35sn, gerçek fetch için
        // yeterli tampon bırakır.
        const timeout = setTimeout(resolve, 35000);
        const listener = (tabId, info) => {
          if (tabId !== id || info.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    }
    return tab.id;
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: 'https://www.instagram.com/', active: false }, newTab => {
      if (!newTab.id) return reject(new Error('Sekme açılamadı'));
      const id = newTab.id;
      // Instagram can take longer than ten seconds to finish its document
      // while the user is browsing another tab. The tab is still usable as
      // soon as its document exists, so do not turn a slow navigation into a
      // false "page load timeout" login error.
      // NOT: 35sn tavanı, panel.js'teki 60sn'lik IG_API mesaj zaman aşımıyla
      // yarışmayı önler — sekme açılışı + gerçek istek toplamda panel'in
      // beklediği süreyi aşmamalı, aksi halde "takipçiler/takip yüklenemedi"
      // hatası sekme hâlâ hazırlanırken tetiklenir.
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(id);
      }, 35000);
      const listener = (tabId, info) => {
        if (tabId !== id || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        setTimeout(() => resolve(id), 500);
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ── Content script üzerinden REST API çağrısı ─────────────────────────
async function execRestInTab(tabId, url, method, bodyObj) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url, method, bodyStr) => {
      const csrf = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] ?? '';

      // www-claim başlığını bul — yanıt başlığından okumak Chrome tarafından
      // engellendiği için (unsafe header) sayfa içindeki kaynaklardan okunur.
      let wwwClaim = '0';
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const v = localStorage.getItem(localStorage.key(i) ?? '') ?? '';
          if (v.startsWith('hmac.')) { wwwClaim = v; break; }
        }
      } catch {}
      if (wwwClaim === '0') {
        for (const v of Object.values(window)) {
          if (typeof v === 'string' && v.startsWith('hmac.')) { wwwClaim = v; break; }
        }
      }
      if (wwwClaim === '0') {
        for (const el of document.querySelectorAll('script:not([src])')) {
          const m = (el.textContent ?? '').match(/hmac\.[A-Za-z0-9_\-+=/.]{20,}/);
          if (m) { wwwClaim = m[0]; break; }
        }
      }

      const headers = {
        'x-asbd-id': '359341',
        'x-csrftoken': csrf,
        'x-ig-app-id': '936619743392459',
        'x-ig-www-claim': wwwClaim,
        'x-ig-max-touch-points': '0',
        'x-requested-with': 'XMLHttpRequest',
        'accept': '*/*',
      };
      if (bodyStr) headers['content-type'] = 'application/x-www-form-urlencoded';

      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 60000);

      const resp = await fetch(url, {
        method,
        credentials: 'include',
        headers,
        body: bodyStr ? new URLSearchParams(JSON.parse(bodyStr)).toString() : undefined,
        signal: ctrl.signal,
      });

      const text = await resp.text();
      if (!text || text.trimStart().startsWith('<')) {
        const lower = text.toLowerCase();
        const finalPath = resp.redirected ? (() => { try { return new URL(resp.url).pathname; } catch { return ''; } })() : '';
        const redirectedAway = resp.redirected && finalPath.startsWith('/accounts/login');
        if (
          lower.includes('/accounts/login') ||
          lower.includes('login_required') ||
          lower.includes('checkpoint_required') ||
          redirectedAway
        ) {
          return { ok: false, body: '__SESSION_EXPIRED__', status: resp.status };
        }
        const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
        const diag = JSON.stringify({
          title: titleMatch?.[1] ?? null,
          respUrl: resp.url,
          redirected: resp.redirected,
          requestedUrl: url,
          currentPage: location.href,
          snippet: text.slice(0, 1500),
        });
        return { ok: false, body: `__HTML_RESPONSE__:${diag}`, status: resp.status };
      }

      try {
        const json = JSON.parse(text);
        if (json.message === 'feedback_required') {
          return { ok: false, body: JSON.stringify(json).slice(0, 200), status: resp.status };
        }
        // Instagram also uses status:"fail" for transient API errors,
        // throttling, stale page data, and malformed requests. Treating every
        // such response as a logout makes the extension ask for login again
        // while the session cookie is still valid.
        const explicitLoginRequired =
          json.message === 'login_required' ||
          json.error_type === 'login_required' ||
          json.require_login === true;
        if (explicitLoginRequired) {
          return {
            ok: false,
            body: '__SESSION_EXPIRED__',
            status: resp.status,
          };
        }
        if (json.status === 'fail') {
          return {
            ok: false,
            body: String(json.message ?? json.error_title ?? 'Instagram geçici API hatası'),
            status: resp.status,
          };
        }
        return { ok: true, data: json };
      } catch {
        return { ok: false, body: text.slice(0, 200), status: resp.status };
      }
    },
    args: [url, method, bodyObj ? JSON.stringify(bodyObj) : null],
  });

  const result = results[0];
  if (result?.error) throw new Error('executeScript hatası: ' + result.error.message);
  const res = result?.result;
  if (!res) throw new Error('Yanıt boş');
  if (!res.ok) {
    const msg = String(res.body ?? '');
    if (msg === '__SESSION_EXPIRED__') throw new Error("Oturum süresi dolmuş — Instagram'a yeniden giriş yapın");
    if (msg === '__API_REJECTED__') throw new Error('Instagram bu isteği reddetti — kısa süre bekleyip tekrar deneyin');
    if (msg.startsWith('__HTML_RESPONSE__')) {
      const raw = msg.slice('__HTML_RESPONSE__:'.length);
      throw new Error(`Instagram beklenmeyen HTML sayfası döndürdü (durum ${res.status}, geçici yönlendirme/throttle olabilir): ${raw}`);
    }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return res.data;
}

// ── Ana API çağrısı (tek çağrı; otomatik retry yok) ─────────────────────
async function apiCall(endpoint, params, method = 'GET', body) {
  if (!/^\/api\/[A-Za-z0-9_/?=&.%:+-]+$/.test(String(endpoint ?? ''))) {
    throw new Error('Geçersiz Instagram API yolu');
  }
  if (!['GET', 'POST'].includes(method)) {
    throw new Error('Desteklenmeyen API yöntemi');
  }

  // Kullanıcı bilgisi endpoint'i için GraphQL yolunu kullan
  if (endpoint === '/api/v1/accounts/current_user/?edit=true' && method === 'GET') {
    // The content script may already have received the browser's downloaded
    // GraphQL response. Reuse that complete snapshot before opening a new
    // GraphQL request, which avoids false USER_ID errors.
    const stored = await new Promise(resolve => chrome.storage.local.get(['igUser'], resolve));
    const cachedUser = stored?.igUser;
    if (cachedUser?.pk && cachedUser.follower_count != null && cachedUser.following_count != null) {
      return cachedUser;
    }
    const tabId = await getInstagramTab();
    return getUserViaGraphQL(tabId);
  }

  // REST API çağrıları: content-script'in o() fonksiyonu üzerinden yap
  // (executeScript yerine sendMessage → daha güvenilir, cookies otomatik)
  const igTabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
  const csTabId = igTabs.find(t => t.id != null)?.id ?? null;

  // Doğrudan execRestInTab — sendMessage yolu her seferinde başarısız olduğundan atlanır
  let tabId = csTabId ?? await getInstagramTab();
  let url = endpoint.startsWith('http') ? endpoint : `https://www.instagram.com${endpoint}`;
  if (params && Object.keys(params).length > 0) url += '?' + new URLSearchParams(params).toString();

  const key = requestKey(endpoint, params, method, body);
  return runOncePerKey(
    `api:${key}`,
    async () => {
      const data = await execRestInTab(tabId, url, method, body ?? null);
      await appendDebugLog('info', 'execRestInTab başarılı', { endpoint, method });
      return data;
    },
    method === 'GET' ? REQUEST_CACHE_TTL_MS : 0,
  );
}

// ── GraphQL ile kullanıcı verisi çekme ───────────────────────────────
async function getUserViaGraphQL(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const win = window;
      let fbDtsg = '', lsd = '', userId = '';

      // En güvenilir yöntem: ds_user_id çerezi login'deyken direk userId'yi taşır
      try {
        const dsCookie = document.cookie.match(/(?:^|;)\s*ds_user_id=(\d+)/);
        if (dsCookie?.[1]) userId = dsCookie[1];
      } catch {}

      try { fbDtsg = win.require?.('DTSGInitData')?.token ?? ''; } catch {}
      try { lsd    = win.require?.('LSD')?.token ?? ''; } catch {}
      // Sadece gerçek değer varsa userId'yi güncelle (boş string ile üzerine yazma)
      try {
        const u = win.require?.('CurrentUserInitialData');
        const cand = String(u?.USER_ID ?? u?.userId ?? '');
        if (cand && cand !== '0') userId = cand;
      } catch {}

      // __bbox modüllerini daha güvenli şekilde tara (her iterasyon ayrı try/catch)
      for (const c of win.__bbox?.require ?? []) {
        try {
          if (!Array.isArray(c)) continue;
          const name = c[0];
          const cfg  = Array.isArray(c[3]) ? c[3][0] : c[3];
          if (!cfg || typeof cfg !== 'object') continue;
          if (name === 'DTSGInitData' && cfg.token) fbDtsg = cfg.token;
          if (name === 'LSD' && cfg.token) lsd = cfg.token;
          if (name === 'CurrentUserInitialData' && !userId) {
            const cand = String(cfg.USER_ID ?? cfg.userId ?? '');
            if (cand && cand !== '0') userId = cand;
          }
        } catch {}
      }

      if (!fbDtsg || !lsd) {
        for (const script of document.querySelectorAll('script')) {
          const t = script.textContent ?? '';
          if (!t) continue;
          if (!fbDtsg) { const m = t.match(/"DTSGInitData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/); if (m) fbDtsg = m[1]; }
          if (!lsd)    { const m = t.match(/"LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/); if (m) lsd = m[1]; }
          if (!userId || userId === '0') { const m = t.match(/"USER_ID"\s*:\s*"(\d+)"/); if (m) userId = m[1]; }
          if (fbDtsg && lsd && userId && userId !== '0') break;
        }
      }

      /*
       * A complete profile object can already be present in the page's
       * downloaded bootstrap data. Do not fail with USER_ID bulunamadı just
       * because one GraphQL token is hidden by an isolated-world boundary.
       */
      const downloadedUsers = [];
      const addDownloadedUser = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return;
        const candidate = value.user_dict ?? value.user ?? value;
        if (candidate && typeof candidate === 'object') {
          const pk = String(candidate.pk ?? candidate.id ?? candidate.fbid_v2 ?? '').trim();
          if (pk || candidate.username || candidate.follower_count != null || candidate.following_count != null) {
            downloadedUsers.push(candidate);
          }
        }
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') addDownloadedUser(child, depth + 1);
        }
      };
      try {
        addDownloadedUser(win.__additionalDataCurrentUser?.data?.user);
        addDownloadedUser(win._sharedData?.config?.viewer);
        addDownloadedUser(win.__initialData);
        for (const script of document.querySelectorAll('script')) {
          const text = script.textContent ?? '';
          for (const raw of [text, text.replace(/^for\s*\(;;\);\s*/, '')]) {
            try { addDownloadedUser(JSON.parse(raw)); } catch {}
          }
        }
      } catch {}
      const downloadedUser = downloadedUsers
        .filter((candidate) => candidate.pk || candidate.id || candidate.fbid_v2)
        .sort((a, b) =>
          Number(b.follower_count != null) + Number(b.following_count != null) -
          Number(a.follower_count != null) - Number(a.following_count != null)
        )[0];
      if (downloadedUser && (!fbDtsg || !lsd ||
          (downloadedUser.follower_count != null && downloadedUser.following_count != null))) {
        const downloadedId = String(downloadedUser.pk ?? downloadedUser.id ?? downloadedUser.fbid_v2);
        return {
          ok: true,
          user: {
            ...downloadedUser,
            pk: downloadedId,
            follower_count: Number(downloadedUser.follower_count ?? 0),
            following_count: Number(downloadedUser.following_count ?? 0),
            media_count: Number(downloadedUser.media_count ?? 0),
          },
          fbDtsg, lsd, csrf: document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] ?? '',
        };
      }

      if (!fbDtsg || !lsd) return { ok: false, errors: [`Instagram sayfa verisi eksik — fb_dtsg:${!!fbDtsg} lsd:${!!lsd}`] };

      const csrf = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] ?? '';
      const jazoest = '2' + String(Array.from(fbDtsg).reduce((a, c) => a + c.charCodeAt(0), 0));

      const doGql = async (docId, variables, actorId = '0', friendlyName = '') => {
        const body = new URLSearchParams({
          av: actorId, __d: 'www', __user: '0', __a: '1', __req: 'g',
          __comet_req: '7', __spin_b: 'trunk', __spin_r: '1043716065', __spin_t: '0',
          fb_dtsg: fbDtsg, jazoest, lsd,
          variables: JSON.stringify(variables),
          doc_id: docId,
          server_timestamps: 'true',
          fb_api_caller_class: 'RelayModern',
        });
        if (friendlyName) body.set('fb_api_req_friendly_name', friendlyName);
        const resp = await fetch('https://www.instagram.com/api/graphql', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-asbd-id': '359341',
            'x-csrftoken': csrf,
            'x-fb-lsd': lsd,
            'x-ig-app-id': '936619743392459',
            'x-fb-friendly-name': friendlyName || 'PolarisProfilePageContentQuery',
            'x-ig-max-touch-points': '1',
            'x-ig-www-claim': '0',
          },
          body: body.toString(),
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 60000); return c.signal; })(),
        });
        const text = await resp.text();
        if (!text || text.trimStart().startsWith('<')) throw new Error(`HTML yanıt (${resp.status})`);
        const json = JSON.parse(text);
        if (json.errors?.length) throw new Error(JSON.stringify(json.errors).slice(0, 100));
        return json;
      };

      // Profile sorgusu için yardımcı vars
      const profileVars = (uid) => ({
        userID: String(uid),
        __relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider: false,
      });

      // 1. userId yoksa /api/v1/accounts/current_user/?edit=true dene (REST → sayılar zaten var)
      if (!userId || userId === '0') {
        try {
          const resp = await fetch('https://www.instagram.com/api/v1/accounts/current_user/?edit=true', {
            method: 'GET',
            credentials: 'include',
            headers: {
              'x-csrftoken': csrf, 'x-ig-app-id': '936619743392459',
              'x-requested-with': 'XMLHttpRequest', 'accept': '*/*',
            },
          });
          if (resp.ok) {
            const j = await resp.json();
            userId = String(j?.user?.pk ?? j?.user?.fbid_v2 ?? '');
            if (userId && userId !== '0') {
              // REST sayılar var — direkt döndür
              const u = j.user || {};
              return {
                ok: true,
                user: {
                  pk: String(u.pk ?? userId),
                  username: u.username,
                  full_name: u.full_name,
                  profile_pic_url: u.profile_pic_url,
                  follower_count: u.follower_count ?? 0,
                  following_count: u.following_count ?? 0,
                  media_count: u.media_count ?? 0,
                  is_verified: !!u.is_verified,
                  is_private: !!u.is_private,
                  biography: u.biography,
                },
                fbDtsg, lsd, csrf,
              };
            }
          }
        } catch {}
      }

      // 2. GraphQL ile user_dict + sayılar
      // doc_id runtime'da Polaris bundle'ından çekiliyor.
      // HAR'da sabit gömdüğümüz değer artık sadece son çare olarak kullanılır.
      const resolveProfileDocId = () => {
        try {
          for (const mod of win.__bbox?.require ?? []) {
            if (!Array.isArray(mod)) continue;
            const [name] = mod;
            if (name && /^PolarisProfilePageContent(Content)?Query_instagramRelayOperation$/.test(name)) {
              const cfg = mod[3]?.[0];
              const id = typeof cfg === 'string' ? cfg : cfg?.id;
              if (id && /^\d{10,20}$/.test(String(id))) return String(id);
            }
          }
          const direct = win.require?.('PolarisProfilePageContentQuery_instagramRelayOperation');
          if (direct && /^\d{10,20}$/.test(String(direct))) return String(direct);
        } catch {}
        // HAR'dan son bilinen doc_id (Instagram her release'de değiştirir;
        // bu eskiyse options/users_info REST fallback'i sayıları getirir)
        return '26785645987802781';
      };
      const profileDocId = resolveProfileDocId();

      if (!userId || userId === '0') {
        try {
          const r = await doGql(profileDocId, profileVars('1'), '0', 'PolarisProfilePageContentQuery');
          userId = String(r.data?.viewer?.user?.pk ?? r.data?.viewer?.user?.fbid_v2 ?? '');
        } catch {}
      }
      if (!userId || userId === '0') return { ok: false, errors: ['USER_ID bulunamadı'] };

      try {
        const r = await doGql(profileDocId, profileVars(userId), userId, 'PolarisProfilePageContentQuery');
        const dict = r.data?.xig_user_by_igid_v2?.user_dict;
        const pk   = dict?.pk ?? dict?.fbid_v2 ?? userId;
        if (!dict) return { ok: false, errors: ['user_dict boş — ' + JSON.stringify(r.data).slice(0, 200)] };
        return {
          ok: true,
          user: {
            pk: String(pk),
            username: dict.username,
            full_name: dict.full_name,
            profile_pic_url: dict.profile_pic_url ?? (dict.hd_profile_pic_url_info?.url ?? null),
            follower_count:  Number(dict.follower_count  ?? 0),
            following_count: Number(dict.following_count ?? 0),
            media_count:     Number(dict.media_count     ?? 0),
            is_verified:     !!dict.is_verified,
            is_private:      !!dict.is_private,
            biography:       dict.biography ?? null,
            fbid_v2:         dict.fbid_v2,
          },
          fbDtsg, lsd, csrf,
        };
      } catch (e) {
        return { ok: false, errors: ['GraphQL hatası: ' + e.message] };
      }
    },
    args: [],
  });

  const result = results[0];
  if (result?.error) throw new Error('executeScript hatası: ' + result.error.message);
  const res = result?.result;
  if (!res) throw new Error('executeScript boş sonuç döndü');
  if (!res.ok) throw new Error(res.errors?.join(' | ') ?? 'bilinmeyen hata');

  // Tokenleri kaydet
  if (res.fbDtsg && res.lsd) {
    chrome.storage.local.set({ igGqlTokens: { fbDtsg: res.fbDtsg, lsd: res.lsd, csrf: res.csrf ?? '', ts: Date.now() } });
  }
  return res.user;
}

// ── Panel'e durum yayını ──────────────────────────────────────────────
function broadcastStatus() {
  const panelUrl = chrome.runtime.getURL('panel.html');
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      // startsWith kullan: React Router hash/path değiştiğinde URL panel.html#/... şeklinde olur,
      // tam eşleşme (===) bu durumda mesajı hiç göndermez.
      if (tab.url && tab.url.startsWith(panelUrl) && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'IG_AUTO_STATUS' }).catch(() => {});
      }
    }
  });
}

// ── Ana otomasyon tiki ────────────────────────────────────────────────
async function autolikeTickInternal() {
  const state = await getState();
  if (!state.enabled) return;

  // Beğeni cache'ini yükle (service worker restartından sonra da çalışsın)
  await loadLikedCache();
  const now = Date.now();
  if (state.backoffUntil > now) {
    await patchState({
      lastActionLabel: `Otomasyon bekliyor: ${Math.ceil((state.backoffUntil - now) / 60000)} dk bekleme`,
    });
    broadcastStatus();
    return;
  }
  const today = todayStr();
  if (state.todayDate !== today) {
    await patchState({ todayCount: 0, todayDate: today });
    state.todayCount = 0;
  }

  if (state.todayCount >= state.maxPerDay) return;
  if (state.nextRunAt > now) return;

  // ── Saatlik güvenlik sınırı ─────────────────────────────────────────
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const hourlyWindowStart = state.hourlyWindowStart || 0;
  const hourlyElapsed = now - hourlyWindowStart;
  if (hourlyElapsed > ONE_HOUR_MS) {
    // Saat dilimi doldu — sayacı sıfırla
    await patchState({ hourlyCount: 0, hourlyWindowStart: now });
    state.hourlyCount = 0;
    state.hourlyWindowStart = now;
  }
  const maxPerHour = Number(state.maxPerHour) || 35;
  if ((state.hourlyCount || 0) >= maxPerHour) {
    const waitMs  = Math.max(ONE_HOUR_MS - hourlyElapsed, 60000);
    const waitMin = Math.ceil(waitMs / 60000);
    await patchState({
      nextRunAt: now + waitMs,
      lastActionLabel: `Saatlik limit (${maxPerHour}) aşıldı — ${waitMin} dk bekleniyor`,
    });
    broadcastStatus();
    return;
  }

  // Kullanıcı ve token bilgilerini al
  const storage = await new Promise(resolve =>
    chrome.storage.local.get(['igUser', 'igGqlTokens'], resolve)
  );
  const igUser      = storage.igUser;
  const igGqlTokens = storage.igGqlTokens;
  const userId = String(igUser?.pk ?? igUser?.fbid_v2 ?? '');
  if (!userId) {
    await patchState({ lastActionLabel: 'Otomasyon bekliyor: Instagram kullanıcı bilgisi yok' });
    broadcastStatus();
    return;
  }

  let following;
  try {
    following = await getFollowing(userId);
  } catch (error) {
    if (isRateLimitMessage(error)) {
      const errCount = state.consecutiveErrors + 1;
      const backoffMs = Math.min(
        30 * 60000 * (2 ** Math.max(0, errCount - 1)),
        6 * 60 * 60000,
      );
      const backoffMinutes = Math.max(1, Math.ceil(backoffMs / 60000));
      await patchState({
        consecutiveErrors: errCount,
        backoffUntil: now + backoffMs,
        nextRunAt: now + backoffMs,
        lastActionLabel: `Instagram istek sınırı uyguladı — otomasyon duraklatıldı, ${backoffMinutes} dk boyunca yeni istek gönderilmeyecek`,
      });
      await appendDebugLog('warn', error.message || error, {
        phase: 'following',
        rateLimit: true,
        consecutiveErrors: errCount,
        backoffMinutes,
      });
    } else {
      // getFollowing() hata fırlattı (her iki kat da başarısız).
      // Gerçek hata mesajını göster; "bulunamadı" ile üzerine yazma.
      await patchState({
        lastActionLabel: String(error.message ?? error).slice(0, 200),
        nextRunAt: now + 60000,
      });
      await appendDebugLog('error', error.message || error, { phase: 'following' });
    }
    broadcastStatus();
    return;
  }
  if (following.length === 0) {
    await patchState({
      lastActionLabel: 'Otomasyon bekliyor: takip edilen kullanıcı bulunamadı',
      nextRunAt: now + 60000,
    });
    broadcastStatus();
    return;
  }

  // Her tick'te 5 farklı aday kullanıcı seç (rastgele karıştır)
  const shuffled   = [...following].sort(() => Math.random() - 0.5);
  const candidates = shuffled.slice(0, 3);

  try {
    let liked = false;
    let actionLabel = '';
    const candidateReports = [];

    // Kullanıcının seçtiği içerik türleri — sadece bunlar işlenir.
    // Sıra: Hikâye → Gönderi → Reels (öncelik korunur).
    const enabledAll = Array.isArray(state.enabledContentTypes)
      ? state.enabledContentTypes.filter(t => ['story', 'post', 'reel'].includes(t))
      : ['story', 'post', 'reel'];
    const enabled = enabledAll.length > 0 ? enabledAll : ['story', 'post', 'reel'];
    const hasStory = enabled.includes('story');
    const hasPost  = enabled.includes('post');
    const hasReel  = enabled.includes('reel');

    // Aday kullanıcı verilerini hazırla — rawUsername @ içermez, displayUsername gösterim için.
    // Her aday ve her içerik türü raporda mutlaka yer alır; kontrol edilmemiş alan
    // yanlışlıkla "içerik yok" olarak gösterilmez.
    const candidateData = candidates.map(candidate => ({
      candidate,
      targetId: candidate.id,
      rawUsername: candidate.username.replace(/^@/, ''),
      username: candidate.username.startsWith('@') ? candidate.username : `@${candidate.username}`,
      contentStatus: {
        story: createContentStatus(hasStory),
        post:  createContentStatus(hasPost),
        reel:  createContentStatus(hasReel),
      },
    }));

    // ═══════════════════════════════════════════════════════════════
    // 1. TUR — HİKAYELER (global öncelik)
    // Önce tüm adayların hikayelerine bak; biri beğenilene kadar posta geçme.
    // ═══════════════════════════════════════════════════════════════
    let _storyIdx = 0;
    if (hasStory) for (const cd of candidateData) {
      if (_storyIdx++ > 0) await new Promise(r => setTimeout(r, randInt(1500, 4000)));
      const { candidate, targetId, username, rawUsername, contentStatus } = cd;
      try {
        const resp = await callGraphQLMutation(
          '28026812547006985',
          {
            initial_reel_id: targetId,
            reel_ids: [targetId],
            first: 50,
            last: 0,
            __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
          },
          'PolarisStoriesV3ReelPageGalleryQuery',
        );
        const items  = normalizeMediaList(resp);
        const unliked = items.filter(isUnlikedMedia).filter(item => {
          const id = getMediaId(item);
          return id && !_likedCache.has(String(id));
        });
        const storyStatus = setContentStatus(contentStatus.story, {
          checked: true,
          found: items.length > 0,
          unliked: unliked.length > 0,
          responseCount: items.length,
          source: 'PolarisStoriesV3ReelPageGalleryQuery',
          reasonCode: items.length > 0
            ? (unliked.length > 0 ? 'unliked_available' : 'all_liked')
            : 'empty_response',
          reason: items.length > 0
            ? (unliked.length > 0
              ? `${items.length} hikaye bulundu, ${unliked.length} tanesi beğenilebilir`
              : `${items.length} hikaye bulundu; tamamı daha önce beğenilmiş`)
            : 'Instagram hikaye yanıtı boş döndü; bu hesapta şu anda aktif hikaye bulunamadı',
        });
        await appendDebugLog('info', 'Hikaye kontrolü tamamlandı', {
          username: candidate.username, found: items.length, unliked: unliked.length,
          reasonCode: storyStatus.reasonCode, reason: storyStatus.reason,
        });
        if (unliked.length > 0 && !liked) {
          // En baştaki (en eski) hikayeden başlayarak sırayla dene. Önizleme
          // görseli olmayan medya nesneleri genelde eksik/geçersiz veridir
          // (silinmiş, süresi dolmuş ya da yarım yüklenmiş hikaye) — bu tür
          // medyaya beğeni denemesi Instagram'dan "başarılı" görünen ama
          // aslında hiçbir şeyi beğenmeyen bir yanıt döndürebiliyor. Bu yüzden
          // önizlemesi olan ilk hikayeyi seçiyoruz; hiçbirinde yoksa hiç
          // beğeni denemiyoruz ve sahte bir "beğenildi" kaydı oluşturmuyoruz.
          const sortedUnliked = [...unliked].sort((a, b) => (a.taken_at ?? 0) - (b.taken_at ?? 0));
          const media   = sortedUnliked.find(m => getMediaThumbnail(m)) || null;
          const mediaId = media ? getMediaId(media) : '';
          const thumbUrl = media ? getMediaThumbnail(media) : '';
          if (mediaId && thumbUrl) {
            await likeMediaWithGraphQL(mediaId, 'story');
            liked = true;
            actionLabel = `Hikaye beğenildi (${username})`;
            markLiked(mediaId);
            await appendLikeLog('story', rawUsername, 'Hikaye beğenildi', thumbUrl, mediaId);
          } else if (sortedUnliked.length > 0) {
            await appendDebugLog('warn', 'Hikayelerin hiçbirinde önizleme görseli yok — beğeni denenmedi', {
              username: candidate.username, count: sortedUnliked.length,
            });
          }
        }
      } catch (e) {
        if (isRateLimitMessage(e) || isInstagramCheckpointError(e)) throw e;
        const isEmptyResponse = isTransientTabIssue(e);
        const errorMessage = e?.message || String(e);
        setContentStatus(contentStatus.story, {
          checked: true,
          error: errorMessage,
          reasonCode: 'request_error',
          reason: `Hikaye isteği başarısız oldu: ${errorMessage}`,
          source: 'PolarisStoriesV3ReelPageGalleryQuery',
        });
        await appendDebugLog(isEmptyResponse ? 'warn' : 'error', errorMessage, {
          username: candidate.username, contentType: 'story', reasonCode: 'request_error',
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 2. TUR — GÖNDERİLER (hikaye bulunamadıysa)
    // ═══════════════════════════════════════════════════════════════
    if (hasPost && !liked) {
      // Bir önceki bölümden gelen istekler arasında insan gibi mola ver
      if (hasStory) await new Promise(r => setTimeout(r, randInt(2000, 5000)));
      let _postIdx = 0;
      for (const cd of candidateData) {
        if (_postIdx++ > 0) await new Promise(r => setTimeout(r, randInt(1500, 4000)));
        const { candidate, targetId, username, rawUsername, contentStatus } = cd;
        try {
          let resp;
          try {
            resp = await apiCall(
              `/api/v1/feed/user/${encodeURIComponent(candidate.username)}/username/`,
              { count: '12' },
            );
          } catch (usernameError) {
            await appendDebugLog('warn', 'Gönderi kullanıcı adı isteği başarısız, kimlik ile tekrar deneniyor', {
              username: candidate.username,
              contentType: 'post',
              reasonCode: 'username_endpoint_error',
              error: usernameError?.message || String(usernameError),
            });
            resp = await apiCall(`/api/v1/feed/user/${targetId}/`, { count: '12' });
          }
          const postItems = normalizeMediaList(resp);
          const unliked = postItems.filter(isUnlikedMedia).filter(item => {
            const id = getMediaId(item);
            return id && !_likedCache.has(String(id));
          });
          const postStatus = setContentStatus(contentStatus.post, {
            checked: true,
            found: postItems.length > 0,
            unliked: unliked.length > 0,
            responseCount: postItems.length,
            source: 'feed/user',
            reasonCode: postItems.length > 0
              ? (unliked.length > 0 ? 'unliked_available' : 'all_liked')
              : 'empty_response',
            reason: postItems.length > 0
              ? (unliked.length > 0
                ? `${postItems.length} gönderi bulundu, ${unliked.length} tanesi beğenilebilir`
                : `${postItems.length} gönderi bulundu; tamamı daha önce beğenilmiş`)
              : 'Instagram gönderi yanıtı boş döndü; bu hesapta erişilebilir gönderi bulunamadı',
          });
          await appendDebugLog('info', 'Gönderi kontrolü tamamlandı', {
            username: candidate.username, found: postItems.length, unliked: unliked.length,
            reasonCode: postStatus.reasonCode, reason: postStatus.reason,
          });
          if (unliked.length > 0 && !liked) {
            const post    = unliked[Math.floor(Math.random() * unliked.length)];
            const mediaId = getMediaId(post);
            if (mediaId) {
              const thumbUrl = getMediaThumbnail(post);
              await likeMediaWithGraphQL(mediaId, 'post');
              liked = true;
              actionLabel = `Gönderi beğenildi (${username})`;
              markLiked(mediaId);
              await appendLikeLog('post', rawUsername, 'Gönderi beğenildi', thumbUrl, mediaId);
            }
          }
        } catch (e) {
          if (isRateLimitMessage(e) || isInstagramCheckpointError(e)) throw e;
          const isEmptyResponse = isTransientTabIssue(e);
          const errorMessage = e?.message || String(e);
          setContentStatus(contentStatus.post, {
            checked: true,
            error: errorMessage,
            reasonCode: 'request_error',
            reason: `Gönderi isteği başarısız oldu: ${errorMessage}`,
            source: 'feed/user',
          });
          await appendDebugLog(isEmptyResponse ? 'warn' : 'error', errorMessage, {
            username: candidate.username, contentType: 'post', reasonCode: 'request_error',
          });
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 3. TUR — REELS (hikaye ve gönderi bulunamadıysa)
    // ═══════════════════════════════════════════════════════════════
    if (hasReel && !liked) {
      // Bir önceki bölümden gelen istekler arasında insan gibi mola ver
      if (hasStory || hasPost) await new Promise(r => setTimeout(r, randInt(2000, 5000)));
      let _reelIdx = 0;
      for (const cd of candidateData) {
        if (_reelIdx++ > 0) await new Promise(r => setTimeout(r, randInt(1500, 4000)));
        const { candidate, targetId, username, rawUsername, contentStatus } = cd;
        try {
          const resp = await apiCall('/api/v1/clips/user/', undefined, 'POST', {
            target_user_id: targetId,
            page_size: '6',
            include_feed_video: 'true',
          });
          const reelItems = normalizeMediaList(resp);
          const unliked = reelItems
            .map(item => item.media ?? item)
            .filter(isUnlikedMedia)
            .filter(item => {
              const id = getMediaId(item);
              return id && !_likedCache.has(String(id));
            });
          const reelStatus = setContentStatus(contentStatus.reel, {
            checked: true,
            found: reelItems.length > 0,
            unliked: unliked.length > 0,
            responseCount: reelItems.length,
            source: '/api/v1/clips/user/',
            reasonCode: reelItems.length > 0
              ? (unliked.length > 0 ? 'unliked_available' : 'all_liked')
              : 'empty_response',
            reason: reelItems.length > 0
              ? (unliked.length > 0
                ? `${reelItems.length} reels bulundu, ${unliked.length} tanesi beğenilebilir`
                : `${reelItems.length} reels bulundu; tamamı daha önce beğenilmiş`)
              : 'Instagram reels yanıtı boş döndü; bu hesapta erişilebilir reels bulunamadı',
          });
          await appendDebugLog('info', 'Reels kontrolü tamamlandı', {
            username: candidate.username, found: reelItems.length, unliked: unliked.length,
            reasonCode: reelStatus.reasonCode, reason: reelStatus.reason,
          });
          if (unliked.length > 0 && !liked) {
            const media   = unliked[Math.floor(Math.random() * unliked.length)];
            const mediaId = getMediaId(media);
            if (mediaId) {
              const thumbUrl = getMediaThumbnail(media);
              await likeMediaWithGraphQL(mediaId, 'reel');
              liked = true;
              actionLabel = `Reel beğenildi (${username})`;
              markLiked(mediaId);
              await appendLikeLog('reel', rawUsername, 'Reel beğenildi', thumbUrl, mediaId);
            }
          }
        } catch (e) {
          if (isRateLimitMessage(e) || isInstagramCheckpointError(e)) throw e;
          const isEmptyResponse = isTransientTabIssue(e);
          const errorMessage = e?.message || String(e);
          setContentStatus(contentStatus.reel, {
            checked: true,
            error: errorMessage,
            reasonCode: 'request_error',
            reason: `Reels isteği başarısız oldu: ${errorMessage}`,
            source: '/api/v1/clips/user/',
          });
          await appendDebugLog(isEmptyResponse ? 'warn' : 'error', errorMessage, {
            username: candidate.username, contentType: 'reel', reasonCode: 'request_error',
          });
        }
      }
    }

    for (const cd of candidateData) {
      const { username, contentStatus } = cd;
      candidateReports.push(
        `${username} — Hikaye: ${describeContentStatus(contentStatus.story)}, ` +
        `Gönderi: ${describeContentStatus(contentStatus.post)}, ` +
        `Reels: ${describeContentStatus(contentStatus.reel)}`
      );
    }
    const candidateReportDetails = candidateData.map(({ username, contentStatus }) => ({
      username,
      story: { ...contentStatus.story, display: describeContentStatus(contentStatus.story) },
      post: { ...contentStatus.post, display: describeContentStatus(contentStatus.post) },
      reel: { ...contentStatus.reel, display: describeContentStatus(contentStatus.reel) },
    }));

    const newCount       = state.todayCount + (liked ? 1 : 0);
    const newHourlyCount = (state.hourlyCount || 0) + (liked ? 1 : 0);
    const batchSize      = Number(state.batchSize)      || 0;
    const batchPauseSec  = Number(state.batchPauseSec)  || 0;
    let   nextRunAt      = now + randInt(state.minDelaySec, state.maxDelaySec) * 1000;
    let   batchNote      = '';
    if (liked && batchSize > 0 && batchPauseSec > 0 && newCount % batchSize === 0) {
      nextRunAt = now + batchPauseSec * 1000;
      const mins = Math.max(1, Math.round(batchPauseSec / 60));
      batchNote = ` · Batch tamamlandı (${newCount}/${state.maxPerDay}) → ${mins} dk bekleniyor`;
    }
    await patchState({
      todayCount: newCount,
      hourlyCount: newHourlyCount,
      todayDate: today,
      nextRunAt,
      consecutiveErrors: 0,
      lastCandidateReports: candidateReportDetails,
      lastScanAt: Date.now(),
      lastActionLabel: actionLabel
        ? `${actionLabel} · Kontrol edilen adaylar: ${candidateReports.join(' | ')}${batchNote}`
        : `İçerik durumu — ${candidateReports.join(' | ') || 'Kontrol edilecek aday bulunamadı'}`,
    });
    broadcastStatus();

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isRateLimit = isRateLimitMessage(msg);
    // 1357004 = Instagram'ın eski/geçersiz doc_id'ye verdiği "bilinmeyen sorgu" yanıtı.
    // Bu bir reCAPTCHA/checkpoint DEĞİL — kullanıcı Instagram'a girdiğinde doğrulama görmez.
    // Gerçek challenge: checkpoint_required, challenge_required gibi anahtar kelimeler içerir
    // ve genellikle instagram.com/challenge/ adresinde görünür ekranla birlikte gelir.
    const isDocIdError = /\b1357004\b/.test(msg);
    const isChallenge = !isDocIdError && (isInstagramCheckpointError(msg) || /captcha|recaptcha/i.test(msg));
    const isEmptyResponse = isTransientTabIssue(msg);
    // Oturumun kesin olarak süresi dolduğu doğrulandıysa (yönlendirme takibiyle
    // tespit edildi), her dakika aynı isteği tekrar tekrar deneyip aynı hatayı
    // loglamanın anlamı yok — kullanıcı tarayıcıdan yeniden giriş yapana kadar
    // otomasyonu tamamen duraklat (sessionid çerezi kontrolüyle aynı davranış).
    let isSessionExpired = msg.includes('Oturum süresi dolmuş');
    // Instagram ana sayfasına yönlendirme = throttle/anti-bot sinyali.
    // Rate-limit gibi davran: 30 dk bekle, otomasyonu kapatma.
    // apiCall bu hatayı artık loglamıyor — burada tek seferlik kaydedilir.
    if (isEmptyResponse && !isSessionExpired) {
      const emptyBackoffMs = 30 * 60000;
      const emptyErrCount  = state.consecutiveErrors + 1;
      await patchState({
        consecutiveErrors: emptyErrCount,
        backoffUntil: now + emptyBackoffMs,
        nextRunAt:    now + emptyBackoffMs,
        lastActionLabel: 'Instagram istekleri geçici olarak kısıtladı — otomasyon 30 dk duraklatıldı',
      });
      await appendDebugLog('warn', msg, {
        phase: 'autolikeTick',
        consecutiveErrors: emptyErrCount,
        htmlRedirect: true,
        backoffMinutes: 30,
      });
      broadcastStatus();
      return;
    }
    const errCount = state.consecutiveErrors + 1;
    let backoffMs;
    if (isSessionExpired) {
      backoffMs = 30 * 60000;
    } else if (isChallenge) {
      backoffMs = 60 * 60000;  // 1 saat — kullanıcı tarayıcıda challenge'ı çözsün
    } else if (isDocIdError) {
      backoffMs = 5 * 60000;   // 5 dk — geçici, doc_id hatası gerçek engel değil
    } else if (isRateLimit) {
      backoffMs = Math.min(30 * 60000 * (2 ** Math.max(0, errCount - 1)), 6 * 60 * 60000);
    } else {
      backoffMs = Math.min(errCount * 5 * 60000, 60 * 60000);
    }
    const backoffMinutes = Math.max(1, Math.ceil(backoffMs / 60000));
    const statusLabel = isSessionExpired
      ? 'Oturum süresi dolmuş — instagram.com\'a tarayıcıdan yeniden giriş yapıp otomasyonu tekrar aç'
      : isChallenge
      ? 'Instagram doğrulama istedi (reCAPTCHA/checkpoint) — instagram.com sekmesinde doğrulamayı tamamla, otomasyon 60 dk sonra yeniden deneyecek'
      : isDocIdError
      ? `Hikaye beğeni isteği reddedildi (geçici API sorunu) — ${backoffMinutes} dk sonra yeniden denecek`
      : isRateLimit
      ? `Instagram istek sınırı uyguladı — otomasyon duraklatıldı, ${backoffMinutes} dk boyunca yeni istek gönderilmeyecek`
      : `Hata: ${msg.slice(0, 80)}`;

    await patchState({
      consecutiveErrors: errCount,
      backoffUntil: now + backoffMs,
      nextRunAt: now + backoffMs,
      lastActionLabel: statusLabel,
      ...(isSessionExpired ? { enabled: false } : {}),
    });
    await appendDebugLog(isRateLimit || isChallenge || isEmptyResponse || isSessionExpired ? 'warn' : 'error', msg, {
      phase: 'autolikeTick',
      consecutiveErrors: errCount,
      rateLimit: isRateLimit,
      challenge: isChallenge,
      sessionExpired: isSessionExpired,
      backoffMinutes,
    });
    broadcastStatus();
  }
}

async function autolikeTick() {
  if (autolikeInFlight) return autolikeInFlight;
  autolikeInFlight = autolikeTickInternal();
  try {
    return await autolikeInFlight;
  } finally {
    autolikeInFlight = null;
  }
}

// ── Instagram listelerini sayfa yönlendirme ile çekme ─────────────────
// Instagram, eklenti içinden yapılan fetch isteklerini (hem executeScript
// hem content-script isolated world) algılayıp login sayfasına yönlendiriyor.
// Tek güvenilir yol: Instagram'ın kendi sayfasını (followers/following)
// yüklemek, Instagram'ın kendi JS'inin API'yi çağırmasını beklemek ve
// page-data-bridge aracılığıyla yanıtı yakalamak.
async function fetchFollowListViaContentScript(endpoint, params, method, body, cacheKey, reply) {
  const storage = await new Promise(resolve => chrome.storage.local.get(['igUser'], resolve));
  const user = storage?.igUser;
  if (!user?.username) {
    return 'Kullanıcı adı bulunamadı — paneli yeniden aç';
  }

  // Instagram sekmesi bul (yoksa arka planda aç)
  let tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
  let tab = tabs.find(t => t.id != null && t.status === 'complete' && !t.url?.includes('/accounts/'))
          ?? tabs.find(t => t.id != null && t.status === 'complete')
          ?? tabs.find(t => t.id != null);

  const kind = endpoint.includes('/followers') ? 'followers' : 'following';
  const targetUrl = 'https://www.instagram.com/' + user.username + '/' + kind + '/';

  // Sekme yoksa arka planda Instagram'ı aç
  if (!tab?.id) {
    try {
      const newTab = await chrome.tabs.create({ url: targetUrl, active: false });
      tab = { id: newTab.id };
    } catch {
      return 'Instagram sekmesi açılamadı — instagram.com adresini manuel açıp tekrar dene';
    }
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve('Instagram sayfası zaman aşımı. instagram.com sekmesini kontrol edip tekrar dene.');
    }, 45000);

    const listener = (msg) => {
      if (msg.type !== 'IG_FOLLOW_LIST') return;
      try {
        const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        if (payload?.kind !== kind) return;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        const users = Array.isArray(payload.users) ? payload.users : [];
        if (users.length > 0) {
          chrome.storage.local.set({
            [cacheKey]: { users, next_max_id: payload.next_max_id ?? null, ts: Date.now() },
          });
        }
        reply({ ok: true, data: { users, next_max_id: payload.next_max_id ?? null } });
        resolve(null);
      } catch {}
    };
    chrome.runtime.onMessage.addListener(listener);

    // Sekmeyi takipçi/takip sayfasına yönlendir (yeni açıldıysa zaten orada)
    if (tab?.id) {
      chrome.tabs.update(tab.id, { url: targetUrl }).catch(() => {});
    }
    appendDebugLog('info', 'Liste yükleniyor — sayfa: ' + targetUrl).catch(() => {});
  });
}




// ── Mesaj dinleyicileri ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const senderUrl = String(_sender?.url ?? _sender?.tab?.url ?? '');
  const isExtensionSender = senderUrl.startsWith(chrome.runtime.getURL(''));
  const isInstagramSender = /^https:\/\/(?:www\.)?instagram\.com\//i.test(senderUrl);
  const panelMessages = new Set(['REFRESH_USER_DATA', 'IG_GQL_MUTATION', 'DOM_LIKE_STORY', 'IG_AUTO_GET', 'IG_SESSION_PROBE', 'IG_AUTO_SET', 'IG_AUTO_CLEAR_CACHE', 'IG_API', 'IG_LOGOUT']);
  const pageMessages = new Set(['IG_USER_DATA', 'IG_FOLLOW_LIST']);
  if ((panelMessages.has(msg?.type) && !isExtensionSender) || (pageMessages.has(msg?.type) && !isInstagramSender)) {
    reply({ ok: false, error: 'Yetkisiz mesaj kaynağı' });
    return false;
  }

  if (msg.type === 'IG_USER_DATA') {
    chrome.storage.local.set({ igUser: msg.user, igUserTs: Date.now() });
    const panelUrl = chrome.runtime.getURL('panel.html');
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) {
        // startsWith kullan: React Router hash/path değiştiğinde URL panel.html#/... şeklinde olur
        if (tab.url && tab.url.startsWith(panelUrl) && tab.id != null) {
          chrome.tabs.sendMessage(tab.id, { type: 'IG_USER_UPDATED', user: msg.user }).catch(() => {});
        }
      }
    });
  

  return false;
  }

  // Panel "sayılar 0 — yenile" dediğinde içerik-script'e tarama tetikleyip
  // güncel kullanıcı verisini zorla çekmesini istiyoruz. Tüm IG sekmelerinde.
  if (msg.type === 'REFRESH_USER_DATA') {
    chrome.tabs.query({ url: '*://*.instagram.com/*' }, tabs => {
      for (const tab of tabs) {
        if (tab.id == null) continue;
        chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_USER_DATA' }).catch(() => {});
      }
    });
    reply({ ok: true });
    return false;
  }

  if (msg.type === 'IG_GQL_MUTATION') {
    if (!msg.docId || typeof msg.variables !== 'object' || typeof msg.friendlyName !== 'string') {
      reply({ ok: false, error: 'Geçersiz GraphQL isteği' });
      return false;
    }
    runGraphQLMutation(msg.docId, msg.variables, msg.friendlyName)
      .then(data => reply({ ok: true, data }))
      .catch(e => {
        appendDebugLog('error', e.message || e, {
          operation: msg.friendlyName, docId: msg.docId, variables: msg.variables,
        }).catch(() => {});
        reply({ ok: false, error: e.message });
      });
    return true;
  }

  if (msg.type === 'DOM_LIKE_STORY') {
    if (typeof msg.like !== 'boolean') {
      reply({ ok: false, error: 'Geçersiz hikaye işlemi' });
      return false;
    }
    chrome.tabs.query({ url: '*://*.instagram.com/*' }, tabs => {
      const igTabs = tabs.filter(t => t.id != null);
      if (igTabs.length === 0) { reply({ ok: false, error: 'Açık Instagram sekmesi bulunamadı' }); return; }
      let done = false;
      let remaining = igTabs.length;
      for (const tab of igTabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'DOM_LIKE_STORY', like: msg.like }, res => {
          remaining--;
          if (chrome.runtime.lastError || !res) {
            if (!done && remaining === 0) reply({ ok: false, error: 'Content script yanıt vermedi' });
            return;
          }
          if (!done && res.ok) { done = true; reply({ ok: true }); }
          else if (!done && remaining === 0) reply({ ok: false, error: "Hikaye butonu DOM'da bulunamadı" });
        });
      }
    });
    return true;
  }

  if (msg.type === 'IG_AUTO_GET') {
    getState().then(s => reply(s));
    return true;
  }

  if (msg.type === 'IG_SESSION_PROBE') {
    // Canlı oturum probe'u — SADECE açık bir instagram.com sekmesi varsa
    // o sekmenin içinden çalışır. Çerezler orada otomatik, istek normal
    // sayfa içi XHR gibi görünür → Instagram rate-limit/reCAPTCHA tetiklemez.
    // Yoksa kendi başına fetch atmaz, kullanıcının sekme açmasını ister.
    chrome.tabs.query({ url: '*://*.instagram.com/*' }, (tabs) => {
      const usable = tabs.find(t => t.id != null && t.status === 'complete' && !t.url?.includes('/accounts/'))
                  ?? tabs.find(t => t.id != null && t.status === 'complete')
                  ?? tabs.find(t => t.id != null);
      if (!usable?.id) {
        reply({
          ok: false,
          reason: 'no-ig-tab',
          message: 'instagram.com sekmesini aç ve tekrar dene — uzantı bu sekmenin içinden doğrulama yapacak',
          sessionCheckedAt: Date.now(),
        });
        patchState({
          sessionReason: 'IG sekmesi açık değil — instagram.com sekmesi aç',
          sessionCheckedAt: Date.now(),
        }).catch(() => {});
        broadcastStatus();
        return;
      }
      // IG sekmesinin içinden gerçek bir fetch — cookie'ler otomatik
      chrome.scripting.executeScript({
        target: { tabId: usable.id },
        func: async () => {
          let resp;
          try {
            resp = await fetch('https://www.instagram.com/api/v1/accounts/current_user/?edit=true', {
              method: 'GET',
              credentials: 'include',
              redirect: 'follow',
              headers: {
                'accept': 'application/json',
                'x-ig-app-id': '936619743392459',
                'x-requested-with': 'XMLHttpRequest',
              },
            });
          } catch (e) {
            return { ok: false, error: 'fetch:' + (e?.message || String(e)) };
          }
          try {
            const text = await resp.text();
            return {
              ok: true,
              status: resp.status,
              ct: (resp.headers.get('content-type') || '').toLowerCase(),
              redirected: resp.redirected,
              url: resp.url,
              body: text.slice(0, 800),
            };
          } catch (e) {
            return { ok: false, error: 'read:' + (e?.message || String(e)) };
          }
        },
      }).then(results => {
        const r = results?.[0]?.result;
        if (!r?.ok) throw new Error(r?.error || 'sekme içi probe başarısız');
        const lower = (r.body || '').toLowerCase();
        // Content-type html TEK BAŞINA yeterli değil — Instagram anti-bot olarak
        // JSON endpoint'e HTML dönebiliyor. Gerçek login yönlendirmesi için
        // body'de login/logout spesifik anahtar kelimeler de olmalı.
        const isRealLoginRedirect = lower.includes('/accounts/login')
          || lower.includes('login_required')
          || r.status === 401
          || r.status === 403;
        const looksLogin = isRealLoginRedirect;
        let valid = false, username = '', userId = '', reason = '';
        if (!looksLogin) {
          try {
            const j = JSON.parse(r.body);
            const u = j?.user ?? j?.data?.user;
            if (u?.username || u?.pk) {
              valid = true;
              username = u.username || '';
              userId = String(u.pk || '');
              reason = 'oturum geçerli (IG sekmesi yoluyla)';
            } else if (j?.status === 'fail' || j?.require_login || j?.message === 'login_required') {
              reason = 'API login_required döndü';
            } else {
              reason = 'tanımsız JSON — user alanı yok';
            }
          } catch {
            if (r.redirected && r.status >= 300 && r.status < 400) {
              reason = 'IG sekmesi login\'e yönlendirdi';
            } else {
              reason = 'JSON parse hatası';
            }
          }
        } else {
          if (r.status === 429) reason = 'rate-limit (429) — yavaşlat';
          else if (r.status === 401 || r.status === 403) reason = `HTTP ${r.status} reddedildi`;
          else reason = 'IG sekmesi login sayfası yükledi';
        }
        patchState({
          sessionValid: valid,
          sessionReason: reason,
          sessionUsername: username,
          sessionUserId: userId,
          sessionCheckedAt: Date.now(),
        }).catch(() => {});
        if (valid && username) {
          chrome.storage.local.get(['igUser'], ({ igUser }) => {
            const merged = { ...(igUser ?? {}), username, pk: userId || igUser?.pk };
            chrome.storage.local.set({ igUser: merged, igUserTs: Date.now() });
          });
        } else if (!valid && isRealLoginRedirect) {
          // Gerçek login yönlendirmesi → otomasyonu duraklat
          patchState({
            backoffUntil: Date.now() + 30 * 60000,
            enabled: false,
            lastActionLabel: 'Oturum geçersizleşti — instagram.com\'a tarayıcıdan giriş yap ve otomasyonu tekrar aç',
          }).catch(() => {});
        }
        // valid=false ama isRealLoginRedirect=false → geçici API sorunu, extension'ı kapatma
        broadcastStatus();
        reply({
          ok: true,
          valid,
          reason,
          httpStatus: r.status,
          username,
          userId,
          sessionidPresent: true,
          probePath: 'ig-tab',
          tabUrl: r.url,
          checkedAt: Date.now(),
        });
      }).catch(e => reply({ ok: false, error: e.message || String(e) }));
    });
    return true;
  }

  if (msg.type === 'IG_AUTO_SET') {
    const allowed = ['enabled', 'timeFrom', 'timeTo', 'minDelaySec', 'maxDelaySec', 'maxPerDay', 'maxPerHour', 'targetType', 'batchSize', 'batchPauseSec', 'enabledContentTypes'];
    const patch = {};
    const incoming = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
    for (const key of allowed) {
      if (key in incoming) patch[key] = incoming[key];
    }
    if (patch.enabled === true) { patch.nextRunAt = 0; patch.backoffUntil = 0; }
    patchState(patch).then(() => {
      broadcastStatus();
      reply({ ok: true });
      if (patch.enabled === true) {
        // Start immediately instead of waiting for the next one-minute alarm.
        setTimeout(() => autolikeTick().catch(error => {
          patchState({ lastActionLabel: `Otomasyon hatası: ${String(error.message ?? error).slice(0, 120)}` });
          broadcastStatus();
        }), 0);
      }
    });
    return true;
  }

  if (msg.type === 'IG_AUTO_CLEAR_CACHE') {
    _followingCache   = [];
    _followingCacheTs = 0;
    reply({ ok: true });
    return false;
  }

  if (msg.type === 'IG_FOLLOW_LIST') {
    // Instagram sayfasının kendi isteğinden yakalanan liste yalnızca destekleyici
    // bir önbellektir. Panelin sayfalama cursor'ını asla bununla değiştirme:
    // aksi halde ilk sayfa tekrar tekrar dönüyor ve "Daha Fazla Yükle" kilitleniyor.
    try {
      const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
      if (payload?.kind && Array.isArray(payload.users) && payload.users.length > 0) {
        const key = payload.kind === 'followers' ? '__cached_followers' : '__cached_following';
        chrome.storage.local.get([key], existing => {
          const prev = existing[key] ?? { users: [], next_max_id: null, ts: 0 };
          const merged = [...(Array.isArray(prev.users) ? prev.users : [])];
          const seen = new Set(merged.map(u => String(u?.pk ?? u?.id ?? '')));
          for (const u of payload.users) {
            const id = String(u?.pk ?? u?.id ?? '');
            if (id && !seen.has(id)) { merged.push(u); seen.add(id); }
          }
          chrome.storage.local.set({
            [key]: {
              users: merged,
              // Do not overwrite an API pagination cursor with an unsolicited
              // page response from Instagram's UI.
              next_max_id: prev.next_max_id ?? null,
              ts: Date.now(),
            },
          });
        });
      }
    } catch {}
    return false;
  }

  if (msg.type === 'IG_API') {
    const endpoint = String(msg.endpoint ?? '');
    const method = String(msg.method ?? 'GET').toUpperCase();
    if (!/^\/api\//.test(endpoint) || !['GET', 'POST'].includes(method)) {
      reply({ ok: false, error: 'Yalnızca Instagram /api/ uç noktaları desteklenir' });
      return false;
    }
    const isFollowList = endpoint.includes('/friendships/') &&
      (endpoint.includes('/followers') || endpoint.includes('/following'));

    if (isFollowList) {
      const kind = endpoint.includes('/followers') ? 'followers' : 'following';
      const cacheKey = kind === 'followers' ? '__cached_followers' : '__cached_following';

      (async () => {
        // 1. Cache'te veri varsa ve ilk sayfa isteniyorsa cache'ten döndür
        const stored = await new Promise(resolve => chrome.storage.local.get([cacheKey], resolve));
        const cached = stored[cacheKey];
        if (cached?.users?.length > 0 && !msg.params?.max_id) {
          reply({ ok: true, data: { users: cached.users, next_max_id: cached.next_max_id ?? null } });
          return;
        }

        // 2. execRestInTab üzerinden doğrudan API isteği yap
        //    (Sayfa-yönlendirme yaklaşımı Instagram SPA'sında çalışmıyor:
        //     SPA navigasyonu yeni bir ağ isteği tetiklemiyor, bu nedenle
        //     page-data-bridge hiçbir zaman yanıt yakalayamıyor.)
        try {
          const data = await apiCall(endpoint, msg.params, method, msg.body);
          const users = Array.isArray(data.users) ? data.users : [];
          if (users.length > 0) {
            chrome.storage.local.set({
              [cacheKey]: { users, next_max_id: data.next_max_id ?? null, ts: Date.now() },
            });
          }
          reply({ ok: true, data: { users, next_max_id: data.next_max_id ?? null } });
        } catch (e) {
          let errorMsg = e.message ?? String(e);
          if (errorMsg.includes('beklenmeyen HTML sayfası')) {
            errorMsg = 'Instagram liste erişimini geçici olarak kısıtladı. Birkaç dakika bekleyip tekrar deneyin.';
          } else if (errorMsg.includes('No tab with id')) {
            errorMsg = 'Açık bir Instagram sekmesi bulunamadı. instagram.com\'u açık tutun ve tekrar deneyin.';
          } else if (errorMsg.includes('Oturum süresi dolmuş')) {
            errorMsg = 'Instagram oturumu sona ermiş. instagram.com\'a yeniden giriş yapın.';
          }
          reply({ ok: false, error: errorMsg });
        }
      })();
      return true;
    }

    // Takipçi/takip listesi dışındaki IG_API çağrıları
    apiCall(endpoint, msg.params, method, msg.body)
      .then(data => reply({ ok: true, data }))
      .catch(e => {
        let errorMsg = e.message ?? String(e);
        if (errorMsg.includes('beklenmeyen HTML sayfası')) {
          errorMsg = 'Instagram bu işlemi geçici olarak kısıtladı. Birkaç dakika bekleyip tekrar deneyin.';
        } else if (errorMsg.includes('No tab with id')) {
          errorMsg = 'Açık bir Instagram sekmesi bulunamadı. instagram.com\'u açık tutun ve tekrar deneyin.';
        } else if (errorMsg.includes('Oturum süresi dolmuş')) {
          errorMsg = 'Instagram oturumu sona ermiş. instagram.com\'a yeniden giriş yapın.';
        }
        reply({ ok: false, error: errorMsg });
      });
    return true;
  }

  if (msg.type === 'IG_LOGOUT') {
    performLogout()
      .then(() => reply({ ok: true }))
      .catch(e => reply({ ok: false, error: e.message }));
    return true;
  }

  return false;
});

// ── Gerçek çıkış işlemi ───────────────────────────────────────────────
async function performLogout() {
  // Güvenli çıkış: yalnızca uzantının kendi kopyalarını temizle.
  // Instagram oturum çerezlerine ve açık sekmelerin URL'lerine dokunma.
  await chrome.storage.local.remove(['igUser', 'igUserTs', 'igGqlTokens', '__analytics_log', '__automation_debug_log']);
  await patchState({
    enabled: false,
    todayCount: 0,
    lastActionLabel: 'Oturum kapatıldı',
  });
}

// ── Uzantı simgesine tıklama ──────────────────────────────────────────
chrome.action.onClicked.addListener(() => {
  const panelUrl = chrome.runtime.getURL('panel.html');
  chrome.tabs.query({}, tabs => {
    // startsWith: React Router panel.html#/... formatındaki mevcut sekmeyi de yakalar
    const existing = tabs.find(t => t.url && t.url.startsWith(panelUrl));
    if (existing?.id != null) {
      focusTabSafely(existing);   // zaten açık → sadece öne getir, yeni sekme açma
    } else {
      Promise.resolve(chrome.tabs.create({ url: panelUrl })).catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════
// ANALİTİK LOGGER — her yeni beğeni işlemini storage'a yazar
// ═══════════════════════════════════════════════════════
(function () {
  let _prevCount = -1;
  let _prevDate  = '';
  let _prevLabel = '';

  async function findCfg() {
    const all = await new Promise(r => chrome.storage.local.get(null, r));
    return Object.values(all).find(v => v && typeof v === 'object' && 'todayCount' in v) || null;
  }

  async function appendLog(entry) {
    const stored = await new Promise(r => chrome.storage.local.get([LOG_KEY], r));
    const log = stored[LOG_KEY] || [];
    const duplicate = log.some(item =>
      item?.label === entry.label && Math.abs(Number(item.ts) - Number(entry.ts)) < 60000
    );
    if (duplicate) return;
    log.unshift(entry);
    await new Promise(r => chrome.storage.local.set({ [LOG_KEY]: log.slice(0, 2000) }, r));
  }

  async function poll() {
    try {
      const cfg = await findCfg();
      if (!cfg) return;
      const date  = cfg.todayDate  || new Date().toISOString().split('T')[0];
      const count = cfg.todayCount || 0;
      const label = cfg.lastActionLabel || '';

      if (date !== _prevDate) { _prevCount = 0; _prevDate = date; }

      if (count > _prevCount) {
        _prevCount = count;
        _prevLabel = label;
      }
    } catch {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type !== 'ANALYTICS_GET_STATE') return false;
    chrome.storage.local.get(null, all => reply({ ok: true, storage: all }));
    return true;
  });
})();
