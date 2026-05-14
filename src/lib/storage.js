// Thin keyed wrapper over BX.storage. All extension state lives here so
// background.js, popup.js, options.js and auth.js share one source of truth.
(function (root) {
  'use strict';

  var KEYS = {
    AUTH_TOKEN: 'authToken',
    USER: 'user',
    IS_PREMIUM: 'isPremium',
    SUBSCRIPTION: 'subscription',
    SERVERS: 'servers',
    SERVERS_FETCHED_AT: 'serversFetchedAt',
    SELECTED_SERVER_ID: 'selectedServerId',
    CONNECTION: 'connection',
    DEVICE_UUID: 'deviceUuid',
    SETTINGS: 'settings',
    // Stored only while a proxy session is active. Owned by lib/proxy.js;
    // listed here so clearAuth() can wipe it on sign-out (otherwise SOCKS
    // creds for the dead session linger in storage.local until the next
    // connect overwrites them).
    PROXY_CREDS: '__proxyCredentials',
    // Free-tier guest session — only present when the user clicked
    // "Try free", absent for both signed-out users and signed-in
    // paid users. Cleared on sign-in, on disconnect, and when the
    // backend reports the daily 20-min quota is used up.
    GUEST_SESSION: 'guestSession',
    // Email-verified user tier — 2 hours/day, account-scoped. Same
    // shape as GUEST_SESSION (deviceId, sessionToken, server, remaining,
    // quota, resetAt) but issued by /api/user-session/start under the
    // user's JWT. Populated only after sign-in + email verification.
    USER_SESSION: 'userSession',
    // Two-step guest flow: tapping "Try free" sets this intent flag
    // and routes the popup to the main view; the proxy + countdown
    // start only when the user actually taps the Connect orb. Without
    // this we burn the daily 20-min quota the moment they explore the
    // app — the original UI auto-connected on the auth screen. The
    // flag survives popup close but is cleared on sign-in (they
    // upgraded), quota-exhausted (today is over), or session-expired.
    GUEST_MODE_INTENT: 'guestModeIntent',
    // Set once the first-run onboarding card has been seen + dismissed.
    // The card explains the "browser traffic only" scope so users
    // expecting a system-wide VPN aren't surprised on first connect.
    ONBOARDING_SEEN: 'onboardingSeen',
    // Best-effort cumulative connected seconds, used as the
    // `usageMinutes` field on the uninstall-feedback survey. Updated
    // every time disconnect() runs by adding (Date.now() -
    // connectedAt). Lets us tell "uninstalled before ever trying" from
    // "tried and bounced."
    USAGE_SECONDS: 'usageSeconds',
  };

  var DEFAULT_SETTINGS = {
    // Backend lives at the same origin as the marketing site / dashboard.
    // Mobile app's app.json sets `extra.apiBase` to the same value.
    apiBase: 'https://securepaidvpn.com',
    autoConnectOnStartup: false,
    showNotifications: true,
    proxyType: 'socks5',
  };

  function uuidv4() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    var buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    var hex = [];
    for (var i = 0; i < 16; i++) hex.push(buf[i].toString(16).padStart(2, '0'));
    return hex.slice(0,4).join('') + '-' +
           hex.slice(4,6).join('') + '-' +
           hex.slice(6,8).join('') + '-' +
           hex.slice(8,10).join('') + '-' +
           hex.slice(10,16).join('');
  }

  var Storage = {
    KEYS: KEYS,

    get: function (keys) { return BX.storage.get(keys); },
    set: function (obj) { return BX.storage.set(obj); },
    remove: function (keys) { return BX.storage.remove(keys); },

    getAuthToken: function () {
      return BX.storage.get(KEYS.AUTH_TOKEN).then(function (r) { return r[KEYS.AUTH_TOKEN] || null; });
    },
    setAuthToken: function (token) {
      var obj = {}; obj[KEYS.AUTH_TOKEN] = token; return BX.storage.set(obj);
    },
    clearAuth: function () {
      // Wipe the persisted connection record too — otherwise after logout
      // the next user (or the locked screen) would see the previous
      // session's serverId, server, connectedAt, public IP, etc. The
      // disconnect('logout') that runs before this writes a {status:
      // 'disconnected'} record but leaves the rest of the metadata; this
      // ensures the slot is fully cleared. Also wipes any guest session
      // so the next sign-in attempt doesn't look "half free, half paid".
      return BX.storage.remove([
        KEYS.AUTH_TOKEN,
        KEYS.USER,
        KEYS.IS_PREMIUM,
        KEYS.SUBSCRIPTION,
        KEYS.PROXY_CREDS,
        KEYS.CONNECTION,
        KEYS.GUEST_SESSION,
        KEYS.USER_SESSION,
        KEYS.GUEST_MODE_INTENT,
      ]);
    },

    // ---- Guest free-tier session ----------------------------------------

    getGuestSession: function () {
      return BX.storage.get(KEYS.GUEST_SESSION).then(function (r) {
        return r[KEYS.GUEST_SESSION] || null;
      });
    },
    setGuestSession: function (session) {
      var obj = {}; obj[KEYS.GUEST_SESSION] = session || null;
      return BX.storage.set(obj);
    },
    clearGuestSession: function () {
      return BX.storage.remove(KEYS.GUEST_SESSION);
    },

    getUserSession: function () {
      return BX.storage.get(KEYS.USER_SESSION).then(function (r) {
        return r[KEYS.USER_SESSION] || null;
      });
    },
    setUserSession: function (session) {
      var obj = {}; obj[KEYS.USER_SESSION] = session || null;
      return BX.storage.set(obj);
    },
    clearUserSession: function () {
      return BX.storage.remove(KEYS.USER_SESSION);
    },

    getGuestModeIntent: function () {
      return BX.storage.get(KEYS.GUEST_MODE_INTENT).then(function (r) {
        return !!r[KEYS.GUEST_MODE_INTENT];
      });
    },
    setGuestModeIntent: function (value) {
      if (value) {
        var obj = {}; obj[KEYS.GUEST_MODE_INTENT] = true;
        return BX.storage.set(obj);
      }
      return BX.storage.remove(KEYS.GUEST_MODE_INTENT);
    },

    getUser: function () {
      return BX.storage.get(KEYS.USER).then(function (r) { return r[KEYS.USER] || null; });
    },
    setUser: function (user) {
      var obj = {}; obj[KEYS.USER] = user; return BX.storage.set(obj);
    },

    getPremium: function () {
      return BX.storage.get([KEYS.IS_PREMIUM, KEYS.SUBSCRIPTION]).then(function (r) {
        return { isPremium: !!r[KEYS.IS_PREMIUM], subscription: r[KEYS.SUBSCRIPTION] || null };
      });
    },
    setPremium: function (isPremium, subscription) {
      var obj = {};
      obj[KEYS.IS_PREMIUM] = !!isPremium;
      obj[KEYS.SUBSCRIPTION] = subscription || null;
      return BX.storage.set(obj);
    },

    getServers: function () {
      return BX.storage.get([KEYS.SERVERS, KEYS.SERVERS_FETCHED_AT]).then(function (r) {
        return {
          servers: r[KEYS.SERVERS] || [],
          fetchedAt: r[KEYS.SERVERS_FETCHED_AT] || 0,
        };
      });
    },
    setServers: function (servers) {
      var obj = {};
      obj[KEYS.SERVERS] = servers || [];
      obj[KEYS.SERVERS_FETCHED_AT] = Date.now();
      return BX.storage.set(obj);
    },

    getSelectedServerId: function () {
      return BX.storage.get(KEYS.SELECTED_SERVER_ID).then(function (r) {
        return r[KEYS.SELECTED_SERVER_ID] || null;
      });
    },
    setSelectedServerId: function (id) {
      var obj = {}; obj[KEYS.SELECTED_SERVER_ID] = id; return BX.storage.set(obj);
    },

    getConnection: function () {
      return BX.storage.get(KEYS.CONNECTION).then(function (r) {
        return r[KEYS.CONNECTION] || { status: 'disconnected' };
      });
    },
    setConnection: function (conn) {
      var obj = {}; obj[KEYS.CONNECTION] = conn || { status: 'disconnected' };
      return BX.storage.set(obj);
    },

    // Stable per-install device id — generated once, persisted, used as
    // the deviceUuid the backend's device-limit logic counts against.
    getOrCreateDeviceUuid: function () {
      return BX.storage.get(KEYS.DEVICE_UUID).then(function (r) {
        if (r[KEYS.DEVICE_UUID]) return r[KEYS.DEVICE_UUID];
        var id = 'ext-' + uuidv4();
        var obj = {}; obj[KEYS.DEVICE_UUID] = id;
        return BX.storage.set(obj).then(function () { return id; });
      });
    },

    getOnboardingSeen: function () {
      return BX.storage.get(KEYS.ONBOARDING_SEEN).then(function (r) {
        return !!r[KEYS.ONBOARDING_SEEN];
      });
    },
    setOnboardingSeen: function () {
      var obj = {}; obj[KEYS.ONBOARDING_SEEN] = true;
      return BX.storage.set(obj);
    },

    getUsageSeconds: function () {
      return BX.storage.get(KEYS.USAGE_SECONDS).then(function (r) {
        return Number(r[KEYS.USAGE_SECONDS]) || 0;
      });
    },
    addUsageSeconds: function (delta) {
      var d = Math.max(0, Math.min(86400, Math.floor(Number(delta) || 0)));
      if (!d) return Promise.resolve();
      return Storage.getUsageSeconds().then(function (cur) {
        var obj = {}; obj[KEYS.USAGE_SECONDS] = cur + d;
        return BX.storage.set(obj);
      });
    },

    getSettings: function () {
      return BX.storage.get(KEYS.SETTINGS).then(function (r) {
        return Object.assign({}, DEFAULT_SETTINGS, r[KEYS.SETTINGS] || {});
      });
    },
    setSettings: function (patch) {
      return Storage.getSettings().then(function (current) {
        var next = Object.assign({}, current, patch || {});
        var obj = {}; obj[KEYS.SETTINGS] = next;
        return BX.storage.set(obj).then(function () { return next; });
      });
    },
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  };

  root.Storage = Storage;
})(typeof self !== 'undefined' ? self : this);
