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

  function setProxyChromium(proxy, bypassList) {
    // Chrome / Edge / Firefox MV3 — proxy.settings.set with a fixed_servers
    // config. `singleProxy` with scheme:socks5 is documented to apply to
    // all protocols (http, https, ftp, ws, wss). Using fallbackProxy works
    // too but is more error-prone in some Chrome versions, so prefer
    // singleProxy as the canonical shape.
    var scheme = (proxy.type || 'socks5').toLowerCase();
    var pacScheme = scheme === 'socks5' ? 'socks5'
                  : scheme === 'socks4' ? 'socks4'
                  : scheme === 'https'  ? 'https'
                  : 'http';

    var server = {
      scheme: pacScheme,
      host: proxy.host,
      port: Number(proxy.port),
    };

    var requestedBypass = (bypassList && bypassList.length ? bypassList : BYPASS_DEFAULT).slice();
    // Merge ALWAYS_BYPASS in (deduped) — see comment on ALWAYS_BYPASS.
    var seen = Object.create(null);
    var mergedBypass = [];
    requestedBypass.concat(ALWAYS_BYPASS).forEach(function (h) {
      var k = String(h).toLowerCase();
      if (!seen[k]) { seen[k] = 1; mergedBypass.push(h); }
    });

    var config = {
      mode: 'fixed_servers',
      rules: {
        singleProxy: server,
        bypassList: mergedBypass,
      },
    };

    console.log('[proxy] setting', pacScheme + '://' + proxy.host + ':' + proxy.port,
                'bypass=', mergedBypass.join(','));

    return new Promise(function (resolve, reject) {
      try {
        BX.proxy.settings.set({ value: config, scope: 'regular' }, function () {
          var lastErr = BX.raw.runtime && BX.raw.runtime.lastError;
          if (lastErr) {
            console.error('[proxy] settings.set failed:', lastErr.message);
            return reject(new Error('Proxy config rejected: ' + lastErr.message));
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
    return new Promise(function (resolve, reject) {
      try {
        BX.proxy.settings.clear({ scope: 'regular' }, function () {
          var lastErr = BX.raw.runtime && BX.raw.runtime.lastError;
          if (lastErr) return reject(new Error(lastErr.message));
          resolve();
        });
      } catch (e) { reject(e); }
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
    var raw = (bypassList && bypassList.length ? bypassList : BYPASS_DEFAULT)
      .concat(ALWAYS_BYPASS);
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
    var pacType = (proxy.type || 'https').toLowerCase();
    if (pacType === 'socks5') pacType = 'socks';
    if (pacType === 'socks4') pacType = 'socks4';
    // Firefox's ProxyInfo `type` accepts: direct, http, https, socks, socks4
    if (['http', 'https', 'socks', 'socks4'].indexOf(pacType) === -1) {
      pacType = 'http';
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
  var STORAGE_KEY = '__proxyCredentials';

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
  function installAuthListener() {
    if (!BX.webRequest || !BX.webRequest.onAuthRequired) {
      console.warn('[proxy] webRequest.onAuthRequired unavailable');
      return;
    }
    if (installAuthListener._installed) return;
    installAuthListener._installed = true;

    var extraInfoSpec = ['asyncBlocking'];
    BX.webRequest.onAuthRequired.addListener(
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
            console.warn('[proxy] proxy auth requested but no creds in storage — cancelling');
            if (asyncCallback) asyncCallback({ cancel: true });
            return;
          }
          console.log('[proxy] supplying creds (loaded from storage) for', loaded.username);
          if (asyncCallback) {
            asyncCallback({ authCredentials: { username: loaded.username, password: loaded.password } });
          }
        }).catch(function (e) {
          console.error('[proxy] storage load failed inside auth listener', e);
          if (asyncCallback) asyncCallback({ cancel: true });
        });
      },
      { urls: ['<all_urls>'] },
      extraInfoSpec
    );
    console.log('[proxy] onAuthRequired listener installed');
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
      return BX.isFirefox ? clearProxyFirefox() : clearProxyChromium();
    },
    installAuthListener: installAuthListener,
    getActiveCredentials: getActiveCredentials,
  };

  root.ProxyCtl = ProxyCtl;
})(typeof self !== 'undefined' ? self : this);
