'use strict';

/*
 * Instagram changes the REST response and user-agent checks frequently.
 * The web page already has the profile payload that the browser downloaded,
 * so read that payload first and use the HAR-observed GraphQL request only
 * when the page data is incomplete.
 */
const INSTAGRAM_GRAPHQL_DOC_ID = '26785645987802781';
const INSTAGRAM_APP_ID = '936619743392459';
let downloadedResponseUser = null;
let userPublishInFlight = null;
let lastUserPublishAt = 0;
const USER_REFRESH_COOLDOWN_MS = 60_000;
const requestInFlight = new Map();
const responseCache = new Map();
const RESPONSE_CACHE_TTL_MS = 15_000;

function csrfToken() {
  return document.cookie
    .split(';')
    .find((value) => value.trim().startsWith('csrftoken='))
    ?.split('=')
    .slice(1)
    .join('=') ?? '';
}

function cookieUserId() {
  return document.cookie.match(/(?:^|;)\s*ds_user_id=(\d+)/)?.[1] ?? '';
}

function normalizeUser(value) {
  if (!value || typeof value !== 'object') return null;
  const user = value.user_dict ?? value.user ?? value;
  if (!user || typeof user !== 'object') return null;

  const pk = String(user.pk ?? user.id ?? user.fbid_v2 ?? '').trim();
  const username = String(user.username ?? '').trim();
  const hasProfileFields =
    user.follower_count != null ||
    user.following_count != null ||
    user.media_count != null ||
    user.profile_pic_url != null;

  if (!pk && !username) return null;
  if (!pk && !hasProfileFields) return null;

  return {
    ...user,
    pk: pk || undefined,
    id: user.id != null ? String(user.id) : undefined,
    fbid_v2: user.fbid_v2 != null ? String(user.fbid_v2) : undefined,
    username: username || undefined,
    follower_count: user.follower_count != null ? Number(user.follower_count) : undefined,
    following_count: user.following_count != null ? Number(user.following_count) : undefined,
    media_count: user.media_count != null ? Number(user.media_count) : undefined,
  };
}

function mergeUsers(...values) {
  const users = values.map(normalizeUser).filter(Boolean);
  if (!users.length) return null;

  const merged = {};
  for (const user of users) {
    for (const [key, value] of Object.entries(user)) {
      // Do not replace a real zero with undefined or an older partial value.
      if (value !== undefined && value !== null && value !== '') merged[key] = value;
    }
  }
  if (!merged.pk) merged.pk = String(merged.id ?? merged.fbid_v2 ?? '').trim();
  return merged.pk || merged.username ? merged : null;
}

function walkForUsers(value, output, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 9) return;
  const candidate = normalizeUser(value);
  if (candidate) output.push(candidate);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') walkForUsers(child, output, depth + 1);
  }
}

function parseJsonText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || trimmed.length > 8_000_000) return null;
  const candidates = [trimmed, trimmed.replace(/^for\s*\(;;\);\s*/, '')];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Most script tags are JavaScript, not standalone JSON.
    }
  }
  return null;
}

function readStorageObjects(storage) {
  const values = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      const value = storage.getItem(key);
      const parsed = parseJsonText(value);
      if (parsed) values.push(parsed);
    }
  } catch {
    // Storage can be unavailable in a private or restricted frame.
  }
  return values;
}

function readDownloadedProfileData() {
  const candidates = [];
  if (downloadedResponseUser) candidates.push(downloadedResponseUser);
  try {
    const retained = document.documentElement?.getAttribute('data-takipci-panel-user');
    if (retained) {
      const parsed = JSON.parse(retained);
      for (const user of parsed?.users ?? []) candidates.push(user);
    }
  } catch {}

  // These are the shapes used by Instagram's current page bootstrap data.
  try {
    candidates.push(window.__additionalDataCurrentUser?.data?.user);
    candidates.push(window._sharedData?.config?.viewer);
    candidates.push(window.__initialData?.viewer?.user);
  } catch {
    // A missing page global is expected on newer Instagram builds.
  }

  for (const value of readStorageObjects(window.localStorage)) candidates.push(value);
  for (const value of readStorageObjects(window.sessionStorage)) candidates.push(value);

  // The HAR response shape is often embedded in a bootstrap script or
  // retained by the page as JSON: data.xig_user_by_igid_v2.user_dict and
  // data.viewer.user. Parse standalone JSON scripts and walk both branches.
  for (const script of document.querySelectorAll('script')) {
    const parsed = parseJsonText(script.textContent);
    if (parsed) candidates.push(parsed);
  }

  const found = [];
  for (const candidate of candidates) walkForUsers(candidate, found);

  // A page can expose the viewer ID separately from the profile dictionary.
  // Keep it as a useful identity fallback and merge it with profile data.
  const pageUserId = cookieUserId();
  const best = found
    .filter((user) => user.pk || user.username)
    .sort((left, right) => {
      const leftScore = Number(left.follower_count != null) * 4 +
        Number(left.following_count != null) * 4 +
        Number(left.media_count != null) * 2 +
        Number(Boolean(left.username));
      const rightScore = Number(right.follower_count != null) * 4 +
        Number(right.following_count != null) * 4 +
        Number(right.media_count != null) * 2 +
        Number(Boolean(right.username));
      return rightScore - leftScore;
    })[0];

  return mergeUsers(best, pageUserId ? { pk: pageUserId } : null);
}

function consumeDownloadedResponse(serialized) {
  try {
    const event = JSON.parse(String(serialized ?? ''));
    const found = Array.isArray(event?.users) ? event.users.map(normalizeUser).filter(Boolean) : [];
    if (found.length) {
      const best = found.sort((left, right) => {
        const leftScore = Number(left.follower_count != null) * 4 +
          Number(left.following_count != null) * 4 +
          Number(left.media_count != null) * 2 +
          Number(Boolean(left.username));
        const rightScore = Number(right.follower_count != null) * 4 +
          Number(right.following_count != null) * 4 +
          Number(right.media_count != null) * 2 +
          Number(Boolean(right.username));
        return rightScore - leftScore;
      })[0];
      downloadedResponseUser = mergeUsers(downloadedResponseUser, best);
      publishUser().catch(() => {});
    }
  } catch {
    // A response may be streamed or not be JSON; ignore that response.
  }
}

function getPageTokens() {
  let fbDtsg = '';
  let lsd = '';
  try {
    fbDtsg = String(window.require?.('DTSGInitData')?.token ?? '');
    lsd = String(window.require?.('LSD')?.token ?? '');
  } catch {}

  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent ?? '';
    if (!fbDtsg) {
      fbDtsg = text.match(/"DTSGInitData"[\s\S]{0,300}?"token"\s*:\s*"([^"]+)"/)?.[1] ?? '';
    }
    if (!lsd) {
      lsd = text.match(/"LSD"[\s\S]{0,300}?"token"\s*:\s*"([^"]+)"/)?.[1] ?? '';
    }
    if (fbDtsg && lsd) break;
  }
  return { fbDtsg, lsd };
}

async function requestJson(endpoint, params, method = 'GET', body) {
  const urlObject = new URL(endpoint, window.location.origin);
  if (urlObject.origin !== window.location.origin || !urlObject.pathname.startsWith('/api/')) {
    throw new Error('Güvenlik nedeniyle yalnızca Instagram API yollarına izin verilir');
  }
  let url = urlObject.toString();
  if (params && Object.keys(params).length) url += `?${new URLSearchParams(params).toString()}`;
  const headers = {
    'X-CSRFToken': csrfToken(),
    'X-IG-App-ID': INSTAGRAM_APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: '*/*',
    Referer: 'https://www.instagram.com/',
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const bodyText = body ? new URLSearchParams(body).toString() : '';
  const key = `${method}:${url}:${bodyText}`;
  const now = Date.now();
  const cached = responseCache.get(key);
  if (method === 'GET' && cached && cached.expiresAt > now) return cached.data;
  if (requestInFlight.has(key)) return requestInFlight.get(key);

  const request = (async () => {
    const response = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      body: bodyText || undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ''));
    if (method === 'GET') responseCache.set(key, { data, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
    return data;
  })();
  requestInFlight.set(key, request);
  try {
    return await request;
  } finally {
    requestInFlight.delete(key);
  }
}

async function requestProfileGraphQL() {
  const { fbDtsg, lsd } = getPageTokens();
  if (!fbDtsg || !lsd) return null;
  const jazoest = `2${Array.from(fbDtsg).reduce((sum, character) => sum + character.charCodeAt(0), 0)}`;

  const call = async (userID, actorId = '0') => {
    const body = new URLSearchParams({
      av: actorId,
      __d: 'www',
      __user: '0',
      __a: '1',
      __req: 'g',
      __comet_req: '7',
      fb_dtsg: fbDtsg,
      jazoest,
      lsd,
      variables: JSON.stringify({
        userID: String(userID),
        __relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider: false,
      }),
      doc_id: INSTAGRAM_GRAPHQL_DOC_ID,
      server_timestamps: 'true',
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'PolarisProfilePageContentQuery',
    });
    const response = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-asbd-id': '359341',
        'x-csrftoken': csrfToken(),
        'x-fb-lsd': lsd,
        'x-ig-app-id': INSTAGRAM_APP_ID,
        'x-fb-friendly-name': 'PolarisProfilePageContentQuery',
        'x-ig-max-touch-points': '0',
        'x-ig-www-claim': '0',
      },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
    return JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ''));
  };

  const viewerResponse = await call('1');
  const viewer = viewerResponse?.data?.viewer?.user;
  const userId = String(viewer?.id ?? viewer?.pk ?? cookieUserId()).trim();
  if (!userId || userId === '0') return null;

  const profileResponse = await call(userId, userId);
  const userDict = profileResponse?.data?.xig_user_by_igid_v2?.user_dict;
  return mergeUsers(userDict, profileResponse?.data?.user, viewer, { pk: userId });
}

async function fetchFullUser() {
  let user = readDownloadedProfileData();

  // The page/HAR path is primary. It may contain the complete profile
  // response, in which case no fragile REST endpoint is needed.
  const hasCounts = user &&
    user.follower_count != null &&
    user.following_count != null;
  if (!hasCounts) {
    try {
      user = mergeUsers(user, await requestProfileGraphQL());
    } catch {
      // Continue to the lightweight REST fallbacks below.
    }
  }

  if (user?.pk && (!user.username || user.follower_count == null || user.following_count == null)) {
    try {
      const response = await requestJson(`/api/v1/users/${user.pk}/info/`);
      user = mergeUsers(user, response?.user ?? response);
    } catch {}
  }

  if (user?.username && (user.follower_count == null || user.following_count == null)) {
    try {
      const response = await requestJson('/api/v1/users/web_profile_info/', { username: user.username });
      user = mergeUsers(user, response?.data?.user ?? response?.user);
    } catch {}
  }

  return user?.pk ? user : null;
}

async function publishUser() {
  const now = Date.now();
  if (userPublishInFlight) return userPublishInFlight;
  if (now - lastUserPublishAt < USER_REFRESH_COOLDOWN_MS) return null;
  lastUserPublishAt = now;
  userPublishInFlight = (async () => {
  const user = await fetchFullUser();
  if (user?.pk) chrome.runtime.sendMessage({ type: 'IG_USER_DATA', user });
  })().finally(() => {
    userPublishInFlight = null;
  });
  return userPublishInFlight;
}

// Tek başlangıç keşfi: sayfa açık kaldığı sürece periyodik istek atılmaz.
setTimeout(() => publishUser().catch(() => {}), 1000);

function clickLike(like) {
  const labels = like
    ? ['Beğen', 'Like', 'Gefällt mir', "J'aime", 'Me gusta', 'Curtir', 'Нравится', 'いいね！', 'أعجبني']
    : ['Beğenme', 'Unlike', 'Gefällt mir nicht mehr', "Je n'aime plus", 'Ya no me gusta', 'Não curtir', 'Не нравится', 'いいね！を取り消す', 'إلغاء الإعجاب'];
  let button = null;
  for (const label of labels) {
    button = document.querySelector(`button[aria-label="${label}"]`) ??
      document.querySelector(`svg[aria-label="${label}"]`)?.closest('button');
    if (button) break;
  }
  if (!button) button = document.querySelector('button[aria-label*="egen"]') ??
    document.querySelector('button[aria-label*="ike"]');
  if (!button) return false;
  for (const type of ['mousedown', 'mouseup', 'click']) {
    button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DOM_LIKE_STORY') {
    sendResponse({ ok: clickLike(message.like) });
    return false;
  }
  if (message.type === 'REFRESH_USER_DATA') {
    publishUser().catch(() => {});
    return false;
  }
  if (message.type !== 'IG_FETCH') return false;

  requestJson(message.endpoint, message.params, message.method ?? 'GET', message.body)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});