// Browser proxy controller. Wraps the native chrome.proxy / browser.proxy
// settings APIs in a tiny apply/clear surface plus an auth-prompt handler
// for SOCKS5 user/pass.
(function (root) {
  'use strict';

  var BYPASS_DEFAULT = ['localhost', '127.0.0.1', '<local>'];

  // Always bypass the SecurePaid backend host. Without this, once the
  // SOCKS5 proxy is applied, the extension's own /api/auth/me poll, the
  // billing-portal redirect, etc. would themselves flow through the
  // proxy — so any transient SOCKS auth blip would brick the extension's
  // ability to recover. Routing API traffic direct keeps the control
  // plane independent of the data plane.
  var ALWAYS_BYPASS = [
    'securepaidvpn.com',
    '*.securepaidvpn.com',
  ];

  // Recognized proxy schemes. Anything outside this set used to silently
  // downgrade to plain `http://`, which would tunnel the user's browser
  // traffic over an unencrypted proxy. Hard-fail instead.
  var SUPPORTED_SCHEMES_CHROMIUM = { socks5: 1, socks4: 1, https: 1, http: 1 };

  function mergeBypassList(bypassList) {
    // Always include BYPASS_DEFAULT (`localhost`, `127.0.0.1`, `<local>`)
    // and ALWAYS_BYPASS regardless of what the backend sends. If the
    // backend ever returns an empty bypassList, we'd otherwise route
    // localhost through the proxy and break dev tools / internal hosts.
    var seen = Object.create(null);
    var merged = [];
    [].concat(BYPASS_DEFAULT, bypassList || [], ALWAYS_BYPASS).forEach(function (h) {
      var k = String(h).toLowerCase();
      if (!seen[k]) { seen[k] = 1; merged.push(h); }
    });
    return merged;
  }

  function setProxyChromium(proxy, bypassList) {
    // Chrome / Edge / Firefox MV3 — proxy.settings.set with a fixed_servers
    // config. `singleProxy` with scheme:socks5 is documented to apply to
    // all protocols (http, https, ftp, ws, wss). Using fallbackProxy works
    // too but is more error-prone in some Chrome versions, so prefer
    // singleProxy as the canonical shape.
    var scheme = (proxy.type || 'socks5').toLowerCase();
    if (!SUPPORTED_SCHEMES_CHROMIUM[scheme]) {
      var typeErr = new Error('Unsupported proxy type from server: "' + proxy.type + '"');
      typeErr.code = 'UNSUPPORTED_PROXY_TYPE';
      return Promise.reject(typeErr);
    }

    var server = {
      scheme: scheme,
      host: proxy.host,
      port: Number(proxy.port),
    };

    var mergedBypass = mergeBypassList(bypassList);

    var config = {
      mode: 'fixed_servers',
      rules: {
        singleProxy: server,
        bypassList: mergedBypass,
      },
    };

    console.log('[proxy] setting', scheme + '://' + proxy.host + ':' + proxy.port,
                'bypass=', mergedBypass.join(','));

    return new Promise(function (resolve, reject) {
      try {
        BX.proxy.settings.set({ value: config, scope: 'regular' }, function () {
          var lastErr = BX.raw.runtime && BX.raw.runtime.lastError;
          if (lastErr) {
            console.error('[proxy] settings.set failed:', lastErr.message);
            // Map Chrome's "controlled by another extension" error to a
            // typed code so the popup can show a friendlier banner.
            var msg = lastErr.message || '';
            var err = new Error('Proxy config rejected: ' + msg);
            if (/controlled by other extensions/i.test(msg) ||
                /controlled_by_other_extensions/i.test(msg)) {
              err.code = 'PROXY_CONTROLLED_BY_OTHER_EXTENSION';
              err.message =
                'Another extension (or system policy) is controlling Chrome’s ' +
                'proxy settings. Disable it and try again.';
            }
            return reject(err);
          }
          resolve();
        });
      } catch (e) {
        console.error('[proxy] settings.set threw:', e);
        reject(e);
      }
    });
  }

  function clearProxyChromium() {
    // Three steps. The dead-end step is what makes Disconnect actually
    // disconnect — without it, Chrome happily reuses keep-alive sockets
    // to the old proxy host even after mode:direct is in effect, which
    // is what produced the user-reported "still routing through the
    // VPN after Disconnect" / 407 errors.
    //
    // 1. Switch to a deliberate dead-end proxy (loopback unused port).
    //    This invalidates Chrome's cached proxy decisions and tears
    //    down existing TCP connections to the real proxy host. Any
    //    in-flight requests fail with ERR_PROXY_CONNECTION_FAILED for
    //    a moment — a short, intentional outage to force a clean slate.
    // 2. Switch to mode:'direct'. New requests go straight to the
    //    real internet, no proxy.
    // 3. Verify settings.get() reports 'direct'. Retry once if not.
    function applyDeadEnd() {
      return new Promise(function (resolve) {
        try {
          BX.proxy.settings.set({
            value: {
              mode: 'fixed_servers',
              rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 1 } },
            },
            scope: 'regular',
          }, function () {
            // Don't reject on lastError — best-effort. If the dead-end
            // didn't take, the direct step still runs.
            resolve();
          });
        } catch (_) { resolve(); }
      });
    }

    function applyDirect() {
      return new Promise(function (resolve, reject) {
        try {
          BX.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }, function () {
            var lastErr = BX.raw.runtime && BX.raw.runtime.lastError;
            if (lastErr) return reject(new Error(lastErr.message));
            resolve();
          });
        } catch (e) { reject(e); }
      });
    }

    function verifyDirect() {
      return new Promise(function (resolve) {
        try {
          BX.proxy.settings.get({ incognito: false }, function (details) {
            console.log('[proxy] post-clear settings:',
              'mode=' + (details && details.value && details.value.mode),
              'levelOfControl=' + (details && details.levelOfControl));
            resolve(details && details.value && details.value.mode === 'direct');
          });
        } catch (e) {
          console.warn('[proxy] settings.get failed during verify:', e);
          resolve(false);
        }
      });
    }

    function flushHandlerCache() {
      // Nudges Chrome to drop cached webRequest decisions so any
      // in-flight request handlers re-evaluate. Doesn't kill open
      // TCP connections (Chrome can't expose that), but stops new
      // requests on long-lived tabs from silently reusing the dead
      // proxy. Best-effort — guarded for browsers without webRequest.
      try {
        if (BX.webRequest && typeof BX.webRequest.handlerBehaviorChanged === 'function') {
          BX.webRequest.handlerBehaviorChanged();
        }
      } catch (_) { /* ignore */ }
    }

    return applyDeadEnd().then(applyDirect).then(verifyDirect).then(function (ok) {
      if (ok) { flushHandlerCache(); return; }
      console.warn('[proxy] direct mode did NOT take effect after first try, retrying');
      return applyDirect().then(verifyDirect).then(function (ok2) {
        if (!ok2) {
          console.error('[proxy] FAILED to put proxy into direct mode after 2 tries — ' +
            'another extension or system policy may be holding the proxy slot');
          throw new Error('Proxy did not switch to direct mode (mode is still fixed_servers)');
        }
        flushHandlerCache();
      });
    });
  }

  // ─── Firefox ────────────────────────────────────────────────────────────
  // Firefox's `browser.proxy.settings` doesn't share Chrome's
  // `mode:'fixed_servers'` shape — it uses a different schema and won't
  // accept ours, AND it requires the user to grant "Run in Private
  // Windows" permission before it'll do anything at all.
  //
  // The Firefox-native API is `browser.proxy.onRequest`: a per-request
  // listener that returns a `ProxyInfo` object. It supports https proxies
  // with username/password auth baked in (no separate onAuthRequired
  // round-trip), needs no private-browsing permission, and matches the
  // way every Firefox VPN extension actually ships.
  var firefoxListener = null;
  var firefoxProxyInfo = null;

  function buildBypassMatcher(bypassList) {
    // Mirror mergeBypassList: always include BYPASS_DEFAULT + ALWAYS_BYPASS
    // regardless of what the backend sends, so localhost / 127.0.0.1 /
    // securepaidvpn.com always bypass even if bypassList is missing.
    var raw = [].concat(BYPASS_DEFAULT, bypassList || [], ALWAYS_BYPASS);
    var exact = Object.create(null);
    var suffixes = [];
    raw.forEach(function (h) {
      var s = String(h).toLowerCase();
      if (s === '<local>') return; // not meaningful for hostnames in onRequest
      if (s.indexOf('*.') === 0) {
        suffixes.push(s.slice(1)); // ".securepaidvpn.com"
      } else {
        exact[s] = true;
        suffixes.push('.' + s);    // also bypass deeper subdomains
      }
    });
    return function (host) {
      var h = String(host || '').toLowerCase();
      if (exact[h]) return true;
      for (var i = 0; i < suffixes.length; i++) {
        if (h.endsWith(suffixes[i])) return true;
      }
      return false;
    };
  }

  function setProxyFirefox(proxy, bypassList) {
    // Defensive: BX.isFirefox is just `typeof browser !== 'undefined'`,
    // which can be true on Chromium variants that ship a `browser`
    // polyfill (Edge with webextension-polyfill, some Brave builds).
    // On those, `browser.proxy.onRequest` does NOT exist, and calling
    // .addListener on it throws "Cannot read properties of undefined".
    // Detect and fall through to the Chromium path instead.
    if (!BX.raw || !BX.raw.proxy || !BX.raw.proxy.onRequest ||
        typeof BX.raw.proxy.onRequest.addListener !== 'function') {
      console.warn('[proxy] firefox path unavailable (proxy.onRequest missing); using chromium path');
      return setProxyChromium(proxy, bypassList);
    }

    // Firefox's ProxyInfo `type` accepts: direct, http, https, socks, socks4.
    // Map the backend's `socks5` to Firefox's `socks`. Anything outside this
    // set is rejected — see SUPPORTED_SCHEMES_CHROMIUM rationale: silent
    // downgrade to plain `http` would tunnel traffic over an unencrypted
    // proxy.
    var rawType = (proxy.type || '').toLowerCase();
    var pacType = rawType === 'socks5' ? 'socks' : rawType;
    if (['http', 'https', 'socks', 'socks4'].indexOf(pacType) === -1) {
      var typeErr = new Error('Unsupported proxy type from server: "' + proxy.type + '"');
      typeErr.code = 'UNSUPPORTED_PROXY_TYPE';
      return Promise.reject(typeErr);
    }

    firefoxProxyInfo = {
      type: pacType,
      host: proxy.host,
      port: Number(proxy.port),
      username: proxy.username || undefined,
      password: proxy.password || undefined,
      // For SOCKS5, route DNS through the proxy too (no leaks). Harmless
      // for http/https proxy types.
      proxyDNS: pacType === 'socks',
    };

    var isBypassed = buildBypassMatcher(bypassList);

    if (firefoxListener) {
      BX.raw.proxy.onRequest.removeListener(firefoxListener);
      firefoxListener = null;
    }
    firefoxListener = function (requestInfo) {
      try {
        var url = new URL(requestInfo.url);
        if (isBypassed(url.hostname)) return { type: 'direct' };
      } catch (_) { /* ignore parse errors, default to proxying */ }
      return firefoxProxyInfo;
    };

    console.log('[proxy] firefox: registering proxy.onRequest →',
      pacType + '://' + proxy.host + ':' + proxy.port);
    BX.raw.proxy.onRequest.addListener(firefoxListener, { urls: ['<all_urls>'] });

    // Errors fire on the onError event — log them so they show in the
    // background console (most often: "wrong username/password").
    if (BX.raw.proxy.onError && !setProxyFirefox._onErrorInstalled) {
      setProxyFirefox._onErrorInstalled = true;
      BX.raw.proxy.onError.addListener(function (err) {
        console.error('[proxy] firefox proxy error:', err && err.message);
      });
    }

    return Promise.resolve();
  }

  function clearProxyFirefox() {
    // Mirror the fallback in setProxyFirefox: BX.isFirefox is just
    // `typeof browser !== 'undefined'`, which is also true on Chromium
    // variants that ship a `browser` polyfill (Edge with
    // webextension-polyfill, some Brave packagers). On those,
    // browser.proxy.onRequest doesn't exist — so the per-request
    // listener never got installed, and nothing about the actual
    // proxy will get cleared here. Without this fallback, Disconnect
    // appears to succeed (logs show "firefox: listener removed") but
    // the chromium-style proxy.settings stays at fixed_servers and
    // the browser keeps routing traffic through the dead proxy host.
    if (!BX.raw || !BX.raw.proxy || !BX.raw.proxy.onRequest ||
        typeof BX.raw.proxy.onRequest.removeListener !== 'function') {
      console.warn('[proxy] clearProxyFirefox: onRequest unavailable, falling back to chromium clear');
      return clearProxyChromium();
    }

    if (firefoxListener) {
      try { BX.raw.proxy.onRequest.removeListener(firefoxListener); } catch (_) {}
      firefoxListener = null;
    }
    firefoxProxyInfo = null;
    console.log('[proxy] firefox: proxy.onRequest listener removed');
    return Promise.resolve();
  }

  // Stash creds for the active proxy so onAuthRequired can answer the
  // browser's prompt without round-tripping to the API.
  //
  // Persisted in storage.local because MV3 service workers get terminated
  // aggressively (idle for ~30s → killed). When Chrome wakes the SW to
  // call onAuthRequired, the in-memory copy would otherwise be gone and
  // the listener would cancel the auth challenge — which surfaces as
  // ERR_SOCKS_CONNECTION_FAILED (the SOCKS handshake never completes).
  var activeCredentials = null;
  // Single source of truth for the storage key — same one Storage.clearAuth
  // wipes on logout (Storage.KEYS.PROXY_CREDS).
  var STORAGE_KEY = (typeof Storage !== 'undefined' && Storage.KEYS && Storage.KEYS.PROXY_CREDS) || '__proxyCredentials';

  function setActiveCredentials(creds) {
    activeCredentials = creds && creds.username ? {
      username: creds.username,
      password: creds.password || '',
    } : null;
    var payload = {};
    payload[STORAGE_KEY] = activeCredentials;
    return BX.storage.set(payload).catch(function (e) {
      console.warn('[proxy] could not persist creds', e);
    });
  }

  function getActiveCredentials() {
    return activeCredentials;
  }

  // Synchronously try to reload from cached value. Async load happens at
  // module load time below — this getter is the fast-path for callers
  // that just want the in-memory copy.
  function loadActiveCredentialsFromStorage() {
    return BX.storage.get(STORAGE_KEY).then(function (r) {
      activeCredentials = r && r[STORAGE_KEY] ? r[STORAGE_KEY] : null;
      return activeCredentials;
    });
  }

  // Kick off the load immediately so a fresh SW wake-up has creds ready
  // before Chrome's first onAuthRequired event fires. The promise isn't
  // awaited (callers that need the value go through getActiveCredentials
  // after this resolves), but Chrome buffers webRequest events while the
  // SW is starting, so by the time the listener runs the load is usually
  // already complete.
  loadActiveCredentialsFromStorage().catch(function () {});

  // The browser fires onAuthRequired when the proxy challenges for creds.
  // For SOCKS5 + user/pass auth (RFC 1929) Chromium and Firefox both route
  // the challenge through this same hook, so a single listener covers both.
  var authListenerFn = null;

  function uninstallAuthListener() {
    if (!BX.webRequest || !BX.webRequest.onAuthRequired) return;
    if (!authListenerFn) return;
    try { BX.webRequest.onAuthRequired.removeListener(authListenerFn); } catch (_) {}
    authListenerFn = null;
    installAuthListener._installed = false;
    console.log('[proxy] onAuthRequired listener uninstalled');
  }

  function installAuthListener() {
    // Firefox doesn't need this hook: ProxyInfo.{username,password} in the
    // proxy.onRequest return value is sent inline. The auth-required path
    // only fires for HTTP-layer 407s, which a correctly configured SOCKS5
    // proxy never raises in Firefox. Skipping it avoids touching
    // webRequestBlocking on Firefox installs that didn't grant it.
    if (BX.isFirefox) return;
    if (!BX.webRequest || !BX.webRequest.onAuthRequired) {
      console.warn('[proxy] webRequest.onAuthRequired unavailable');
      return;
    }
    if (installAuthListener._installed) return;
    installAuthListener._installed = true;

    var extraInfoSpec = ['asyncBlocking'];
    authListenerFn =
      function (details, asyncCallback) {
        // Verbose log so we can confirm whether Chrome actually fires this
        // hook for SOCKS5 user/pass auth. There's an open question about
        // whether MV3's webRequest surface covers SOCKS auth (which lives
        // below the HTTP layer) — this log resolves it definitively.
        console.log('[proxy] onAuthRequired:',
          'isProxy=' + details.isProxy,
          'scheme=' + details.scheme,
          'realm=' + (details.realm || ''),
          'challenger=' + (details.challenger ? (details.challenger.host + ':' + details.challenger.port) : ''),
          'url=' + details.url);

        if (!details.isProxy) {
          if (asyncCallback) asyncCallback({});
          return;
        }

        // Fast path: in-memory creds already loaded.
        var creds = activeCredentials;
        if (creds) {
          console.log('[proxy] supplying cached creds for', creds.username);
          if (asyncCallback) {
            asyncCallback({ authCredentials: { username: creds.username, password: creds.password } });
          }
          return;
        }

        // Slow path: SW just woke up and the in-memory copy is gone.
        // Fall back to storage. asyncBlocking lets us respond from a
        // Promise — Chrome holds the connection open in the meantime.
        loadActiveCredentialsFromStorage().then(function (loaded) {
          if (!loaded) {
            // No credentials available means we've already been
            // disconnected. Returning `cancel:true` here surfaces an
            // explicit HTTP 407 in the user's tab, which is worse
            // than letting Chrome handle the missing auth itself.
            // Returning `{}` (no credentials) lets Chrome close the
            // connection naturally; the next request on that origin
            // will go via mode:'direct' and bypass the proxy entirely.
            console.warn('[proxy] proxy auth requested but no creds — letting Chrome drop the connection');
            if (asyncCallback) asyncCallback({});
            return;
          }
          console.log('[proxy] supplying creds (loaded from storage) for', loaded.username);
          if (asyncCallback) {
            asyncCallback({ authCredentials: { username: loaded.username, password: loaded.password } });
          }
        }).catch(function (e) {
          console.error('[proxy] storage load failed inside auth listener', e);
          if (asyncCallback) asyncCallback({});
        });
      };
    BX.webRequest.onAuthRequired.addListener(
      authListenerFn,
      { urls: ['<all_urls>'] },
      extraInfoSpec
    );
    console.log('[proxy] onAuthRequired listener installed');
  }

  // Firefox-only: re-register proxy.onRequest after a background script
  // restart. Firefox MV3 background gets terminated like Chrome's SW; the
  // in-memory listener dies with it and the browser silently switches to
  // direct browsing. Returning false means "could not rehydrate, treat as
  // disconnected"; true means the listener is back and the proxy is live.
  function rehydrateFirefoxProxy(connection) {
    if (!BX.isFirefox) return Promise.resolve(false);
    if (!connection || connection.status !== 'connected' || !connection.proxy) {
      return Promise.resolve(false);
    }
    return loadActiveCredentialsFromStorage().then(function (creds) {
      if (!creds || !creds.username) return false;
      var fullProxy = {
        type: connection.proxy.type,
        host: connection.proxy.host,
        port: connection.proxy.port,
        username: creds.username,
        password: creds.password,
      };
      // bypassList isn't persisted per-server; mergeBypassList /
      // buildBypassMatcher always include the safe defaults anyway.
      return setProxyFirefox(fullProxy, []).then(function () { return true; })
        .catch(function (e) {
          console.warn('[proxy] firefox rehydrate failed:', e && e.message);
          return false;
        });
    });
  }

  var ProxyCtl = {
    apply: function (proxy, bypassList) {
      setActiveCredentials({ username: proxy.username, password: proxy.password });
      installAuthListener();
      return BX.isFirefox
        ? setProxyFirefox(proxy, bypassList)
        : setProxyChromium(proxy, bypassList);
    },
    clear: function () {
      setActiveCredentials(null);
      // Removing the auth listener BEFORE switching the proxy means
      // any in-flight onAuthRequired event for the dying connection
      // resolves through Chrome's default path (silent fail) instead
      // of our extension responding. No more 407 splash pages from
      // returning cancel:true on a connection we no longer care about.
      uninstallAuthListener();
      return BX.isFirefox ? clearProxyFirefox() : clearProxyChromium();
    },
    rehydrateFirefoxProxy: rehydrateFirefoxProxy,
    installAuthListener: installAuthListener,
    getActiveCredentials: getActiveCredentials,
  };

  root.ProxyCtl = ProxyCtl;
})(typeof self !== 'undefined' ? self : this);
