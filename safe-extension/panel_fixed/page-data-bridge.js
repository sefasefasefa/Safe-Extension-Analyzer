/*
 * Runs in Instagram's MAIN world so it can observe the same network
 * responses the page receives. No cookies, headers, or credentials are
 * forwarded to the extension; only the JSON response body is emitted.
 */
'use strict';

(function installInstagramResponseBridge() {
  if (window.__takipciPanelResponseBridgeInstalled) return;
  window.__takipciPanelResponseBridgeInstalled = true;

  const interestingUrl = (url) =>
    /\/api\/graphql(?:\?|$)|\/api\/v1\/(?:accounts\/current_user|users\/web_profile_info|users\/\d+\/info)/i.test(url);

  const isFollowListUrl = (url) =>
    /\/api\/v1\/friendships\/\d+\/(followers|following)\//i.test(url);

  const normalizeFollowUser = (value) => {
    if (!value || typeof value !== 'object') return null;
    const user = value.user_dict ?? value.user ?? value.node ?? value;
    const pk = String(user.pk ?? user.id ?? user.fbid_v2 ?? '').trim();
    const username = String(user.username ?? '').trim();
    if (!pk || !username) return null;
    return {
      pk,
      username,
      full_name: user.full_name ?? '',
      profile_pic_url: user.profile_pic_url ?? user.hd_profile_pic_url_info?.url ?? '',
      is_private: user.is_private ?? false,
      is_verified: user.is_verified ?? false,
      follower_count: user.follower_count,
      following_count: user.following_count,
    };
  };

  const dedupeFollowUsers = (values) => {
    const users = [];
    const seen = new Set();
    for (const value of values) {
      const user = normalizeFollowUser(value);
      if (!user || seen.has(user.pk)) continue;
      seen.add(user.pk);
      users.push(user);
    }
    return users;
  };

  const isUserLike = (value) =>
    value && typeof value === 'object' &&
    (value.pk != null || value.id != null || value.fbid_v2 != null) &&
    (value.username != null || value.follower_count != null ||
      value.following_count != null || value.profile_pic_url != null);

  const collectUsers = (value, users, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 10) return;
    const candidate = value.user_dict ?? value.user ?? value.node ?? value;
    if (isUserLike(candidate)) users.push(candidate);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') collectUsers(child, users, depth + 1);
    }
  };

  const findLegacyCursor = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 10) return null;
    if (Array.isArray(value)) {
      for (const child of value) {
        const cursor = findLegacyCursor(child, depth + 1);
        if (cursor) return cursor;
      }
      return null;
    }
    for (const key of ['next_max_id', 'nextMaxId', 'max_id']) {
      if (value[key] != null && String(value[key])) return String(value[key]);
    }
    for (const child of Object.values(value)) {
      const cursor = findLegacyCursor(child, depth + 1);
      if (cursor) return cursor;
    }
    return null;
  };

  const inferFollowKind = (url, requestText, payload) => {
    const pathKind = String(window.location.pathname)
      .match(/\/(followers|following)\/?/i)?.[1];
    if (pathKind) return pathKind.toLowerCase();
    const source = `${url} ${requestText} ${JSON.stringify(payload).slice(0, 50000)}`.toLowerCase();
    if (/followers|follower|edge_followed_by|followed_by/.test(source)) return 'followers';
    if (/following|edge_follow(?:["'_:]|$)/.test(source)) return 'following';
    return '';
  };

  function emitFollowList(url, payload, requestText = '') {
    try {
      if (!payload) return;

      const directUsers = Array.isArray(payload.users) ? payload.users : [];
      const nestedUsers = [];
      if (!directUsers.length) collectUsers(payload, nestedUsers);
      const users = dedupeFollowUsers(directUsers.length ? directUsers : nestedUsers);

      // A profile response can contain one or two users. Require multiple
      // users so profile/bootstrap responses are not mistaken for a list.
      if (users.length < 2) return;

      const kind = inferFollowKind(url, requestText, payload);
      if (!kind) return;

      const detail = JSON.stringify({
        kind,
        users,
        next_max_id: isFollowListUrl(url) ? findLegacyCursor(payload) : null,
      });

      // The page bridge runs at document_start while the isolated content
      // script runs at document_idle. Keep a DOM handoff for late listeners.
      document.documentElement?.setAttribute(
        'data-takipci-panel-follow-list',
        detail.slice(0, 300000),
      );
      document.dispatchEvent(new CustomEvent('takipci-panel:follow-list', {
        detail,
      }));
    } catch {
      // Never interfere with Instagram's own request handling.
    }
  }

  const emit = (url, payload) => {
    try {
      if (!interestingUrl(url) || !payload) return;
      const users = [];
      collectUsers(payload, users);
      if (!users.length) return;
      const serialized = JSON.stringify({ url, users });
      document.documentElement?.setAttribute('data-takipci-panel-user', serialized);
      document.dispatchEvent(new CustomEvent('takipci-panel:instagram-response', {
        detail: serialized,
      }));
    } catch {
      // Never interfere with Instagram's own request handling.
    }
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function takipciPanelFetch(...args) {
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
      const requestText = (() => {
        try {
          const requestBody = args[1]?.body;
          return typeof requestBody === 'string'
            ? requestBody
            : requestBody?.toString?.() ?? '';
        } catch {
          return '';
        }
      })();

      const requestResult = nativeFetch.apply(this, args);
      requestResult.then((response) => {
        const responseUrl = requestUrl || response.url;
        if (isFollowListUrl(responseUrl) || /\/api\/graphql(?:\?|$)/i.test(responseUrl)) {
          response.clone().text().then((text) => {
            try {
              const payload = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ''));
              emitFollowList(responseUrl, payload, requestText);
            } catch {}
          });
        }
        if (!interestingUrl(responseUrl)) return;
        response.clone().text().then((text) => {
          try {
            emit(responseUrl, JSON.parse(text.replace(/^for\s*\(;;\);\s*/, '')));
          } catch {}
        });
      }).catch(() => {});
      return requestResult;
    };
  }

  const NativeXHR = window.XMLHttpRequest;
  if (typeof NativeXHR === 'function') {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function takipciPanelOpen(method, url, ...rest) {
      this.__takipciPanelUrl = String(url ?? '');
      return nativeOpen.call(this, method, url, ...rest);
    };
    NativeXHR.prototype.send = function takipciPanelSend(...args) {
      try {
        this.__takipciPanelBody = typeof args[0] === 'string'
          ? args[0]
          : args[0]?.toString?.() ?? '';
      } catch {
        this.__takipciPanelBody = '';
      }
      this.addEventListener('load', () => {
        const url = this.__takipciPanelUrl || this.responseURL || '';
        if (isFollowListUrl(url) || /\/api\/graphql(?:\?|$)/i.test(url)) {
          try {
            emitFollowList(
              url,
              JSON.parse(String(this.responseText).replace(/^for\s*\(;;\);\s*/, '')),
              this.__takipciPanelBody,
            );
          } catch {}
        }
        if (!interestingUrl(url)) return;
        try {
          emit(url, JSON.parse(String(this.responseText).replace(/^for\s*\(;;\);\s*/, '')));
        } catch {}
      });
      return nativeSend.apply(this, args);
    };
  }
})();