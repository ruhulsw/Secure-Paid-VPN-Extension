// Cross-browser shim. Firefox exposes `browser` (Promise-based); Chrome
// exposes `chrome` (callback-based, with Promise support on most APIs in
// Manifest V3). We normalize to a single `BX` global with the surface the
// rest of the extension uses.
(function (root) {
  'use strict';

  var native = (typeof browser !== 'undefined' && browser) ||
               (typeof chrome !== 'undefined' && chrome);

  if (!native) {
    throw new Error('No browser extension API available');
  }

  // Wrap a callback-style chrome API method into a Promise. The Firefox
  // `browser` namespace already returns Promises, so we detect by sniffing
  // the result and only wrap when needed.
  function callAsync(target, method) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var fn = target[method];
      if (typeof fn !== 'function') {
        return Promise.reject(new Error('Missing API: ' + method));
      }
      try {
        var ret = fn.apply(target, args);
        if (ret && typeof ret.then === 'function') return ret;
      } catch (_) { /* fall through to callback style */ }
      return new Promise(function (resolve, reject) {
        try {
          fn.apply(target, args.concat([function () {
            var lastErr = native.runtime && native.runtime.lastError;
            if (lastErr) return reject(new Error(lastErr.message || String(lastErr)));
            resolve(arguments.length <= 1 ? arguments[0] : Array.prototype.slice.call(arguments));
          }]));
        } catch (e) { reject(e); }
      });
    };
  }

  var storageArea = native.storage && native.storage.local;

  // Firefox detection via extension URL scheme. This is the only check
  // that's bulletproof against:
  //   - Chrome MV3 aliasing `browser` to `chrome` (made the naive
  //     `typeof browser !== 'undefined'` check return true on Chrome,
  //     pushing us into the Firefox auth-listener path with the wrong
  //     extraInfoSpec)
  //   - Firefox builds where `browser.runtime.getBrowserInfo` is gated
  //     or missing (made our subsequent feature-check return false on
  //     Firefox, dumping us into the Chromium proxy.settings path
  //     which Firefox rejects without the private-browsing permission)
  //
  // The URL prefix is determined by the host browser at install time
  // and can't be aliased away — `moz-extension://` is Firefox,
  // `chrome-extension://` is Chromium, full stop.
  function detectFirefox() {
    try {
      var ns = (typeof browser !== 'undefined' && browser) ||
               (typeof chrome !== 'undefined' && chrome);
      if (!ns || !ns.runtime || typeof ns.runtime.getURL !== 'function') {
        return false;
      }
      return ns.runtime.getURL('').indexOf('moz-extension://') === 0;
    } catch (_) {
      return false;
    }
  }

  var BX = {
    raw: native,
    isFirefox: detectFirefox(),

    runtime: {
      sendMessage: callAsync(native.runtime, 'sendMessage'),
      onMessage: native.runtime.onMessage,
      onInstalled: native.runtime.onInstalled,
      onStartup: native.runtime.onStartup,
      getURL: function (p) { return native.runtime.getURL(p); },
      openOptionsPage: callAsync(native.runtime, 'openOptionsPage'),
    },

    storage: {
      get: function (keys) {
        return new Promise(function (resolve, reject) {
          try {
            var ret = storageArea.get(keys, function (items) {
              var lastErr = native.runtime && native.runtime.lastError;
              if (lastErr) return reject(new Error(lastErr.message));
              resolve(items);
            });
            if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
          } catch (e) { reject(e); }
        });
      },
      set: function (items) {
        return new Promise(function (resolve, reject) {
          try {
            var ret = storageArea.set(items, function () {
              var lastErr = native.runtime && native.runtime.lastError;
              if (lastErr) return reject(new Error(lastErr.message));
              resolve();
            });
            if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
          } catch (e) { reject(e); }
        });
      },
      remove: function (keys) {
        return new Promise(function (resolve, reject) {
          try {
            var ret = storageArea.remove(keys, function () {
              var lastErr = native.runtime && native.runtime.lastError;
              if (lastErr) return reject(new Error(lastErr.message));
              resolve();
            });
            if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
          } catch (e) { reject(e); }
        });
      },
      onChanged: native.storage.onChanged,
    },

    proxy: native.proxy,
    webRequest: native.webRequest,
    alarms: native.alarms,
    notifications: native.notifications,
    action: native.action || native.browserAction,
    tabs: native.tabs,
  };

  root.BX = BX;
})(typeof self !== 'undefined' ? self : this);
