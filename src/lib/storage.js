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
      return BX.storage.remove([KEYS.AUTH_TOKEN, KEYS.USER, KEYS.IS_PREMIUM, KEYS.SUBSCRIPTION]);
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
