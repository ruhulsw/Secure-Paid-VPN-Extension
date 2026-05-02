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

    // Chromium has no path for SOCKS authentication. `chrome.proxy.settings.set`
    // accepts only {scheme,host,port} for `singleProxy` — there is no
    // username/password slot — and `chrome.webRequest.onAuthRequired`
    // never fires for SOCKS RFC 1929 challenges (only HTTP-layer 407s).
    // If the backend hands us a SOCKS proxy with credentials, the
    // connection silently fails with ERR_SOCKS_CONNECTION_FAILED while
    // the popup shows "Connected." Hard-fail with a typed code so the
    // popup can render a clear error and the user can pick a different
    // server (or the backend can be fixed to issue an HTTPS proxy for
    // Chromium clients). Firefox is unaffected — it routes via
    // `proxy.onRequest`, which carries username/password natively.
    if ((scheme === 'socks5' || scheme === 'socks4') && proxy.username) {
      var socksAuthErr = new Error(
        'This browser cannot authenticate to SOCKS proxies. Please pick a ' +
        'different server, or contact support — your account should be ' +
        'served an HTTPS proxy on Chromium-based browsers.'
      );
      socksAuthErr.code = 'CHROME_SOCKS_AUTH_UNSUPPORTED';
      return Promise.reject(socksAuthErr);
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

  // ─── onAuthRequired listener — registered at module load ─────────────────
  //
  // Why module-load and not on-connect:
  //
  // Chrome MV3 service workers must register webRequest listeners during
  // the *synchronous top-level execution* of the script for Chrome to
  // wake the SW reliably for buffered events. The previous design
  // registered the listener inside `installAuthListener()`, called from
  // `bootstrap()`, called from background.js's IIFE. That's still
  // technically synchronous from the SW's first instruction — but
  // empirically Chrome was *not* invoking the listener for HTTPS-proxy
  // 407 challenges (every server location triggered the native
  // proxy-auth dialog regardless of which exit node we picked).
  //
  // Hoisting the addListener call directly into proxy.js's IIFE — with
  // zero function-call indirection between the script's first line and
  // the registration — is what every working Chromium MV3 webRequest
  // example does. The listener is now registered the moment proxy.js
  // is parsed, before any await/Promise/setTimeout could ever delay it.
  //
  // Why always-on:
  //
  // The previous design also un-installed on disconnect to avoid the
  // listener answering 407s for "stale" connections. But with the
  // listener gone, Chrome falls through to its native dialog for any
  // 407 that fires before chrome.proxy.settings has actually flipped
  // to direct mode (which is racy — proxy.settings.set is async).
  // Now: always registered. When `activeCredentials` is null
  // (disconnected or just-cleared state), the listener returns
  // `{cancel: true}` for proxy auth — the request fails cleanly with
  // ERR_BLOCKED_BY_CLIENT instead of prompting the user. When
  // creds are set (connected), it supplies them.

  function resolveCreds() {
    if (activeCredentials) return Promise.resolve(activeCredentials);
    // Slow path: SW just woke and the in-memory copy is gone.
    // 'asyncBlocking' (Chrome) and 'blocking'+Promise (Firefox) both
    // hold the connection open while we re-load from storage.
    return loadActiveCredentialsFromStorage();
  }

  // Browser-shape divergence:
  //   Chrome MV3 → 'asyncBlocking' + an asyncCallback the listener invokes
  //   Firefox    → 'blocking' + the listener returns a Promise<{...}>
  // The same listener function covers both: always builds a Promise,
  // fans the result out via asyncCallback when Chrome provided one.
  //
  // Scope: HTTP-layer 407 challenges only (HTTPS and HTTP proxy
  // schemes). Chromium does NOT route SOCKS RFC 1929 username/password
  // challenges through onAuthRequired (and chrome.proxy.settings has
  // no slot for SOCKS credentials), so setProxyChromium rejects
  // SOCKS+auth before we get here. Firefox doesn't need this hook for
  // SOCKS5 either — its proxy.onRequest ProxyInfo carries
  // username/password directly.
  function authListenerFn(details, asyncCallback) {
    console.log('[proxy] onAuthRequired:',
      'isProxy=' + details.isProxy,
      'scheme=' + details.scheme,
      'realm=' + (details.realm || ''),
      'challenger=' + (details.challenger ? (details.challenger.host + ':' + details.challenger.port) : ''),
      'url=' + details.url);

    var p;
    if (!details.isProxy) {
      // Origin-server auth — fall through to the browser's default
      // flow so the user can enter site credentials.
      p = Promise.resolve({});
    } else {
      p = resolveCreds().then(function (creds) {
        if (!creds || !creds.username) {
          // No creds → we're disconnected or storage was wiped.
          // Returning {} would make Chrome fall through to its
          // native proxy-auth dialog — the bug we're fixing.
          // cancel:true fails the request with ERR_BLOCKED_BY_CLIENT.
          console.warn('[proxy] proxy auth requested but no creds — cancelling to suppress native dialog');
          return { cancel: true };
        }
        console.log('[proxy] supplying creds for', creds.username);
        return { authCredentials: { username: creds.username, password: creds.password } };
      }).catch(function (e) {
        console.error('[proxy] storage load failed inside auth listener', e);
        return { cancel: true };
      });
    }

    if (asyncCallback) p.then(asyncCallback);
    return p;
  }

  // Top-level synchronous registration. This is THE critical line —
  // moving it inside any function broke onAuthRequired dispatch on
  // Chromium even when the function was called synchronously from the
  // IIFE.
  var _authListenerRegistered = false;
  if (BX.webRequest && BX.webRequest.onAuthRequired &&
      typeof BX.webRequest.onAuthRequired.addListener === 'function') {
    try {
      var _extraInfoSpec = BX.isFirefox ? ['blocking'] : ['asyncBlocking'];
      BX.webRequest.onAuthRequired.addListener(
        authListenerFn,
        { urls: ['<all_urls>'] },
        _extraInfoSpec
      );
      _authListenerRegistered = true;
      console.log('[proxy] onAuthRequired listener registered at module load (' + _extraInfoSpec[0] + ')');
    } catch (e) {
      console.error('[proxy] failed to register onAuthRequired at module load:', e);
    }
  } else {
    console.warn('[proxy] webRequest.onAuthRequired unavailable at module load');
  }

  // No-ops kept so existing call sites (apply(), bootstrap()) don't
  // need to change. The listener is registered above for the SW's
  // lifetime — install/uninstall churn is what caused the dispatch
  // races we just fixed.
  function installAuthListener() { /* always registered at module load */ }
  function uninstallAuthListener() { /* never uninstalled */ }

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

  // Chromium parallel of rehydrateFirefoxProxy. On SW restart Chrome's
  // chrome.proxy.settings persists in fixed_servers mode, so the proxy is
  // still live — but the in-memory `activeCredentials` and the
  // onAuthRequired listener both died with the SW. installAuthListener()
  // is called synchronously during top-level SW boot, but the storage
  // load that repopulates `activeCredentials` is async. Returning the
  // load promise here lets bootstrap() await it before declaring the
  // session ready, closing the race window where a 407 fires before the
  // listener has creds to answer it.
  function rehydrateChromiumAuth(connection) {
    if (BX.isFirefox) return Promise.resolve(false);
    if (!connection || connection.status !== 'connected') {
      return Promise.resolve(false);
    }
    return loadActiveCredentialsFromStorage().then(function (creds) {
      var ok = !!(creds && creds.username);
      if (!ok) console.warn('[proxy] chromium rehydrate: no creds in storage');
      return ok;
    });
  }

  var ProxyCtl = {
    apply: function (proxy, bypassList) {
      // The auth listener is already registered at module load. We
      // just need to seed the credentials before the proxy goes live
      // so the listener has them to supply when the first 407 fires.
      // Awaiting setActiveCredentials (in-memory + storage write)
      // guarantees that even if the SW dies right after connect
      // returns, the next SW wake will find creds in storage.
      return setActiveCredentials({ username: proxy.username, password: proxy.password })
        .then(function () {
          return BX.isFirefox
            ? setProxyFirefox(proxy, bypassList)
            : setProxyChromium(proxy, bypassList);
        });
    },
    clear: function () {
      // Listener stays registered (it's a module-load fixture now).
      // Clear the proxy first; only after it's confirmed in direct
      // mode do we wipe creds. While the proxy is still in
      // fixed_servers mode, the listener answers 407s with real
      // creds; once the proxy is direct, it answers with cancel:true
      // (creds null) — neither path lets Chrome's native dialog fire.
      var clearProxy = BX.isFirefox ? clearProxyFirefox : clearProxyChromium;
      return clearProxy().then(function () {
        return setActiveCredentials(null);
      });
    },
    rehydrateFirefoxProxy: rehydrateFirefoxProxy,
    rehydrateChromiumAuth: rehydrateChromiumAuth,
    installAuthListener: installAuthListener,
    getActiveCredentials: getActiveCredentials,
  };

  root.ProxyCtl = ProxyCtl;
})(typeof self !== 'undefined' ? self : this);
