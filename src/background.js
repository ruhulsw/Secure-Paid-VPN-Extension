// SecurePaid VPN — background script.
// Chrome MV3 runs this as a service worker; Firefox MV3 runs it as a
// non-persistent event page. Both load classic scripts via importScripts
// (Chromium) or the manifest's `background.scripts` array (Firefox).

(function () {
  'use strict';

  // ---- Cross-browser script loading ---------------------------------------
  // Firefox loads each entry in `background.scripts` itself, so the shared
  // libs are already in scope by the time this file runs. Chrome's MV3
  // service_worker only loads one entry — we pull in the libs via
  // importScripts (which exists in worker scope only).
  if (typeof importScripts === 'function') {
    try {
      importScripts('lib/browser.js', 'lib/storage.js', 'lib/api.js', 'lib/proxy.js', 'lib/pow.js');
    } catch (e) {
      console.error('[bg] importScripts failed', e);
    }
  }

  var api = new Api();
  var STATE = {
    bootstrapped: false,
    refreshing: false,
  };

  // ---- Helpers ------------------------------------------------------------

  function setBadge(text, color) {
    try {
      if (BX.action && BX.action.setBadgeText) BX.action.setBadgeText({ text: text || '' });
      if (color && BX.action && BX.action.setBadgeBackgroundColor) {
        BX.action.setBadgeBackgroundColor({ color: color });
      }
    } catch (_) { /* badge isn't critical */ }
  }

  function notify(title, message) {
    Storage.getSettings().then(function (s) {
      if (!s.showNotifications) return;
      if (!BX.notifications) return;
      try {
        BX.notifications.create('', {
          type: 'basic',
          iconUrl: BX.runtime.getURL('icons/icon-128.png'),
          title: title || 'SecurePaid VPN',
          message: message || '',
        });
      } catch (_) {}
    }).catch(function () {});
  }

  function configureApi() {
    return Promise.all([
      Storage.getSettings(),
      Storage.getAuthToken(),
    ]).then(function (results) {
      api.configure(results[0].apiBase, results[1]);
      // Keep the control plane off the data plane even when apiBase is
      // not the stock host: the proxy layer bypasses this hostname on
      // both browsers (Chromium bypassList + Firefox onRequest matcher).
      try {
        var apiHost = new URL(results[0].apiBase).hostname;
        if (ProxyCtl.setControlPlaneHost) ProxyCtl.setControlPlaneHost(apiHost);
      } catch (_) { /* unparseable apiBase — defaults still bypassed */ }
      return { settings: results[0], token: results[1] };
    });
  }

  // ---- Auth + premium refresh --------------------------------------------

  function refreshMe() {
    if (STATE.refreshing) return Promise.resolve(null);
    STATE.refreshing = true;
    // .finally guarantees the lock is released even if configureApi() or
    // any storage call throws synchronously. The earlier hand-rolled
    // resets missed the configureApi-rejects case and could leave the
    // flag stuck `true` for the rest of the SW lifetime.
    var p = configureApi().then(function (cfg) {
      if (!cfg.token) return null;
      return api.me().then(function (resp) {
        return Promise.all([
          Storage.setUser(resp.user || null),
          Storage.setPremium(!!resp.isPremium, resp.subscription || null),
        ]).then(function () { return resp; });
      }).catch(function (err) {
        // Token is invalid / expired → drop it and force user to re-auth.
        if (err && (err.status === 401 || err.status === 403)) {
          return Storage.clearAuth().then(function () {
            return disconnect('auth-expired');
          }).then(function () { throw err; });
        }
        throw err;
      });
    });
    return p.finally(function () { STATE.refreshing = false; });
  }

  // ---- Connect / disconnect ----------------------------------------------

  function connect(serverId) {
    console.log('[bg] connect() begin serverId=', serverId);
    return configureApi().then(function (cfg) {
      if (!cfg.token) {
        var err = new Error('Sign in first');
        err.code = 'NOT_AUTHENTICATED';
        throw err;
      }
      // Defensive: clear any leftover proxy first. Without this, a bad
      // proxy from a prior failed attempt would route the API call we're
      // about to make, breaking it with the same "Failed to fetch" you'd
      // see if the network were down.
      return ProxyCtl.clear().catch(function () { /* may not be set */ })
        .then(function () { return Storage.getOrCreateDeviceUuid(); })
        .then(function (deviceUuid) {
          return Storage.setConnection({ status: 'connecting', serverId: serverId, startedAt: Date.now() })
            .then(function () { broadcastState(); return deviceUuid; });
        })
        .then(function (deviceUuid) {
          console.log('[bg] requesting proxy descriptor');
          return api.requestProxy(serverId, deviceUuid, navigator && navigator.userAgent ? navigator.userAgent : 'browser');
        })
        .then(function (resp) {
          console.log('[bg] proxy descriptor received', resp.proxy && resp.proxy.host + ':' + resp.proxy.port);
          var proxy = resp.proxy;
          var bypass = resp.bypassList || [];
          return ProxyCtl.apply(proxy, bypass).then(function () {
            console.log('[bg] proxy applied');
            var conn = {
              status: 'connected',
              serverId: serverId,
              server: resp.server,
              proxy: { type: proxy.type, host: proxy.host, port: proxy.port },
              connectedAt: Date.now(),
            };
            return Storage.setConnection(conn).then(function () {
              setBadge('ON', '#d4a04c');
              broadcastState();
              notify('Connected', 'Routing browser traffic through ' + (resp.server.city || resp.server.country) + '.');
              // Kick off the public-IP lookup in the background — it runs
              // through the freshly-applied proxy (api.ipify.org isn't in
              // the bypass list) and updates the connection state when it
              // resolves. force:true skips the TTL cache since the exit
              // IP just changed. Don't await: connect() should return the
              // moment the proxy is live.
              updatePublicIp({ force: true });
              return conn;
            });
          });
        })
        .catch(function (err) {
          // Log the real error with name + stack for the SW DevTools console.
          console.error('[bg] connect() failed:', err && err.name, err && err.message, err && err.stack);
          // If anything failed *after* we may have applied the proxy,
          // tear it back down so the next connect can run cleanly.
          return ProxyCtl.clear().catch(function () {})
            .then(function () {
              return Storage.setConnection({
                status: 'error',
                error: err && err.message ? err.message : String(err),
                errorName: err && err.name,
                code: err && err.code,
                at: Date.now(),
              });
            })
            .then(function () {
              setBadge('', '#000000');
              broadcastState();
              throw err;
            });
        });
    });
  }

  function disconnect(reason) {
    var clearError = null;
    // Snapshot the live session length BEFORE we clear it, so the
    // uninstall-feedback "usageMinutes" reflects time-actually-used
    // and not just installs-with-zero-connects.
    var sessionStartedAt = null;
    return Storage.getConnection().then(function (conn) {
      if (conn && conn.status === 'connected' && conn.connectedAt) {
        sessionStartedAt = conn.connectedAt;
      }
      return ProxyCtl.clear();
    })
      .catch(function (err) {
        console.error('[bg] disconnect: ProxyCtl.clear failed:', err && err.message, err);
        clearError = err;
      })
      .then(function () {
        if (sessionStartedAt) {
          var seconds = Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000));
          return Storage.addUsageSeconds(seconds);
        }
      })
      .then(function () {
        var connState = clearError
          ? {
              status: 'error',
              error: 'Failed to release proxy: ' + (clearError.message || String(clearError)) +
                     '. The browser may still be routing traffic — try reloading your tabs.',
              at: Date.now(),
            }
          : { status: 'disconnected', reason: reason || null, at: Date.now() };
        return Storage.setConnection(connState);
      })
      .then(function () {
        setBadge(clearError ? '!' : '', clearError ? '#f78a8a' : '#000000');
        broadcastState();

        // Force-reload http(s) tabs so they drop any keep-alive socket
        // they had established to the now-disconnected proxy host. This
        // is the only reliable way — Chrome doesn't expose an API to
        // close existing TCP connections, and proxy.settings.set only
        // affects NEW sockets. Without this, requests on long-lived
        // tabs continued routing through the dead proxy and surfaced
        // as HTTP 407 errors. Skip on 'logout' / 'subscription-expired'
        // teardowns where the user's already going somewhere else.
        if (!clearError && (reason === 'user' || reason == null)) {
          reloadHttpTabs();
        }

        if (clearError) {
          notify('Disconnect failed', 'Browser may still be using the VPN. Reload your tabs.');
        } else if (!reason || reason === 'user') {
          notify('Disconnected', 'Browser is now using its direct connection.');
        }
      });
  }

  // ---- Free-tier guest mode ----------------------------------------------
  //
  // Same shape as the paid `connect()` above: hit /api/guest/start, get
  // back a proxy descriptor, ProxyCtl.apply() the same way. The only
  // differences: no auth token required (guest endpoints are anonymous,
  // identified by deviceId), and a periodic /api/guest/heartbeat alarm
  // ticks down the 20-min/day quota and tears the session down when it
  // hits zero (or when the next-day reset window crosses).

  function guestConnect() {
    console.log('[bg] guestConnect() begin');
    return configureApi().then(function (cfg) {
      // Make sure no leftover proxy from a previous failed attempt is
      // routing the API call we're about to make.
      return ProxyCtl.clear().catch(function () {})
        .then(function () { return Storage.getOrCreateDeviceUuid(); })
        .then(function (deviceUuid) {
          return Storage.setConnection({ status: 'connecting', startedAt: Date.now(), guest: true })
            .then(function () { broadcastState(); return deviceUuid; });
        })
        .then(function (deviceUuid) {
          console.log('[bg] requesting guest session');
          return api.guestStart(deviceUuid).then(function (resp) {
            return { deviceUuid: deviceUuid, resp: resp };
          });
        })
        .then(function (state) {
          var resp = state.resp;
          if (!resp.proxy) {
            throw new Error('Free-tier proxy is not available on this exit node — try again shortly.');
          }
          var proxy = resp.proxy;
          var bypass = (resp.proxy && resp.proxy.bypassList) || [];
          return ProxyCtl.apply(proxy, bypass).then(function () {
            console.log('[bg] guest proxy applied, warming up...');
            // Same warmup gate as the email-tier path — wait for the
            // first proxied fetch to succeed before flipping the UI
            // to "connected", so a freshly-issued session can never
            // surface Chrome's native proxy-auth dialog.
            return warmupProxy().then(function () {
              console.log('[bg] guest proxy warmup passed');
              var guestSession = {
                deviceId: state.deviceUuid,
                sessionToken: resp.sessionToken,
                server: resp.server,
                remainingSeconds: resp.remainingSeconds,
                quotaSeconds: resp.quotaSeconds,
                resetAt: resp.resetAt,
                connectedAt: Date.now(),
                lastHeartbeatAt: Date.now(),
              };
              var conn = {
                status: 'connected',
                guest: true,
                serverId: resp.server.id,
                server: resp.server,
                proxy: { type: proxy.type, host: proxy.host, port: proxy.port },
                connectedAt: Date.now(),
              };
              return Promise.all([
                Storage.setGuestSession(guestSession),
                Storage.setConnection(conn),
              ]).then(function () {
                setBadge('FREE', '#d4a04c');
                broadcastState();
                ensureGuestHeartbeatAlarm();
                notify(
                  'Free trial connected',
                  'Routing browser traffic through ' + (resp.server.city || resp.server.country) +
                    '. ' + Math.floor(resp.remainingSeconds / 60) + ' min left today.'
                );
                updatePublicIp({ force: true });
                return conn;
              });
            });
          });
        })
        .catch(function (err) {
          console.error('[bg] guestConnect() failed:', err && err.name, err && err.message);
          return ProxyCtl.clear().catch(function () {})
            .then(function () {
              return Storage.setConnection({
                status: 'error',
                guest: true,
                error: err && err.message ? err.message : String(err),
                code: err && err.code,
                at: Date.now(),
              });
            })
            .then(function () {
              setBadge('', '#000000');
              broadcastState();
              throw err;
            });
        });
    });
  }

  // Generic guard for recurring alarms. Calling alarms.create with a
  // name that already exists REPLACES the existing alarm and resets
  // its next firing time — so a SW that restarts every <period (which
  // is common in MV3, ~30s idle eviction) would keep resetting the
  // heartbeat timer and it would never fire. Always check first.
  //
  // The Promise-vs-callback split mirrors the rest of this file:
  // Firefox's `alarms.get` is Promise-only and silently drops a
  // callback argument, while older Chromium builds only accept the
  // callback form. The .catch on the Promise path is a defensive
  // create — alarms.get failures are rare but we shouldn't lose the
  // alarm because of one.
  function ensureRecurringAlarm(name, periodInMinutes) {
    if (!BX.alarms || !BX.alarms.get || !BX.alarms.create) return;
    function maybeCreate(existing) {
      if (existing) return;
      try { BX.alarms.create(name, { periodInMinutes: periodInMinutes }); } catch (_) {}
    }
    try {
      var ret = BX.alarms.get(name);
      if (ret && typeof ret.then === 'function') {
        ret.then(maybeCreate).catch(function () {
          try { BX.alarms.create(name, { periodInMinutes: periodInMinutes }); } catch (_) {}
        });
        return;
      }
      BX.alarms.get(name, maybeCreate);
    } catch (_) {
      try { BX.alarms.create(name, { periodInMinutes: periodInMinutes }); } catch (__) {}
    }
  }

  // Heartbeat alarms. MV3 service workers can't keep a setInterval
  // going (they get killed after ~30s idle), so we use BX.alarms which
  // the browser persists across SW restarts. Period = 0.5 min (30s) —
  // the smallest Chromium permits — so disconnect lands within ~30s
  // of quota expiry. The backend caps secondsElapsed at 120s
  // server-side, so a long SW sleep can't burn through the whole
  // quota in one report.
  function ensureGuestHeartbeatAlarm() {
    ensureRecurringAlarm('guest-heartbeat', 0.5);
  }

  function clearGuestHeartbeatAlarm() {
    if (!BX.alarms || !BX.alarms.clear) return;
    try { BX.alarms.clear('guest-heartbeat'); } catch (_) {}
  }

  function guestHeartbeatTick() {
    return Storage.getGuestSession().then(function (session) {
      if (!session || !session.sessionToken) {
        clearGuestHeartbeatAlarm();
        return;
      }
      return configureApi().then(function () {
        var now = Date.now();
        var elapsed = Math.max(1, Math.round((now - (session.lastHeartbeatAt || now)) / 1000));
        return api.guestHeartbeat(session.deviceId, session.sessionToken, elapsed)
          .then(function (resp) {
            session.remainingSeconds = resp.remainingSeconds;
            session.lastHeartbeatAt = now;
            session.resetAt = resp.resetAt || session.resetAt;
            return Storage.setGuestSession(session).then(function () {
              if (resp.disconnect) {
                return guestDisconnect('quota-exhausted').then(function () {
                  notify('Free trial used up',
                    'Today\'s 20 minutes are gone. Resets at midnight UTC, or sign in for unlimited.');
                });
              }
              broadcastState();
            });
          })
          .catch(function (err) {
            console.warn('[bg] guest heartbeat failed:', err && err.code, err && err.message);
            // GUEST_SESSION_INVALID → server forgot us (restart, midnight reset).
            // Tear down so the popup goes back to "try free" CTA.
            if (err && (err.code === 'GUEST_SESSION_INVALID' || err.status === 401)) {
              return guestDisconnect('session-expired');
            }
          });
      });
    });
  }

  // ---- Email-verified user tier (2 hours/day) ----------------------------
  //
  // Same wire shape as guestConnect — backend keys quota by userId so we
  // don't need a deviceId here, the JWT in the Authorization header does
  // the work. Heartbeat alarm 'user-heartbeat' runs at the same 30-sec
  // cadence as the guest tier's; both can be active concurrently in
  // theory, but the UI gates a user from being in both at once.
  //
  // Tier transitions (emailVerified flips, premium kicks in, etc.) cause
  // the popup to tear this session down via userDisconnect.
  function userConnect() {
    console.log('[bg] userConnect() begin');
    return configureApi().then(function (cfg) {
      if (!cfg.token) {
        var err = new Error('Sign in first');
        err.code = 'NOT_AUTHENTICATED';
        throw err;
      }
      return ProxyCtl.clear().catch(function () {})
        .then(function () {
          return Storage.setConnection({ status: 'connecting', startedAt: Date.now(), userTier: true })
            .then(function () { broadcastState(); });
        })
        .then(function () {
          console.log('[bg] requesting user-tier session');
          return api.userSessionStart();
        })
        .then(function (resp) {
          if (!resp.proxy) {
            throw new Error('Email-tier proxy is not available on this exit node — try again shortly.');
          }
          var proxy = resp.proxy;
          var bypass = (resp.proxy && resp.proxy.bypassList) || [];
          return ProxyCtl.apply(proxy, bypass).then(function () {
            console.log('[bg] user-tier proxy applied, warming up...');
            // Warmup gates "connected" on a successful proxied fetch
            // so the user doesn't see Chrome's native proxy-auth
            // dialog if the SSH-push lost a race with Squid's first
            // request. Status stays 'connecting' until warmup passes.
            return warmupProxy().then(function () {
              console.log('[bg] user-tier proxy warmup passed');
              var userSession = {
                sessionToken: resp.sessionToken,
                server: resp.server,
                remainingSeconds: resp.remainingSeconds,
                quotaSeconds: resp.quotaSeconds,
                resetAt: resp.resetAt,
                connectedAt: Date.now(),
                lastHeartbeatAt: Date.now(),
              };
              var conn = {
                status: 'connected',
                userTier: true,
                serverId: resp.server.id,
                server: resp.server,
                proxy: { type: proxy.type, host: proxy.host, port: proxy.port },
                connectedAt: Date.now(),
              };
              return Promise.all([
                Storage.setUserSession(userSession),
                Storage.setConnection(conn),
              ]).then(function () {
                setBadge('FREE', '#d4a04c');
                broadcastState();
                ensureUserHeartbeatAlarm();
                notify(
                  'Connected',
                  'Routing browser traffic through ' + (resp.server.city || resp.server.country) +
                    '. ' + Math.floor(resp.remainingSeconds / 60) + ' min left today.'
                );
                updatePublicIp({ force: true });
                return conn;
              });
            });
          });
        })
        .catch(function (err) {
          console.error('[bg] userConnect() failed:', err && err.name, err && err.message);
          return ProxyCtl.clear().catch(function () {})
            .then(function () {
              return Storage.setConnection({
                status: 'error',
                userTier: true,
                error: err && err.message ? err.message : String(err),
                code: err && err.code,
                at: Date.now(),
              });
            })
            .then(function () {
              setBadge('', '#000000');
              broadcastState();
              throw err;
            });
        });
    });
  }

  function ensureUserHeartbeatAlarm() {
    ensureRecurringAlarm('user-heartbeat', 0.5);
  }

  function clearUserHeartbeatAlarm() {
    if (!BX.alarms || !BX.alarms.clear) return;
    try { BX.alarms.clear('user-heartbeat'); } catch (_) {}
  }

  function userHeartbeatTick() {
    return Storage.getUserSession().then(function (session) {
      if (!session || !session.sessionToken) {
        clearUserHeartbeatAlarm();
        return;
      }
      return configureApi().then(function () {
        var now = Date.now();
        var elapsed = Math.max(1, Math.round((now - (session.lastHeartbeatAt || now)) / 1000));
        return api.userSessionHeartbeat(session.sessionToken, elapsed)
          .then(function (resp) {
            session.remainingSeconds = resp.remainingSeconds;
            session.lastHeartbeatAt = now;
            session.resetAt = resp.resetAt || session.resetAt;
            return Storage.setUserSession(session).then(function () {
              if (resp.disconnect) {
                return userDisconnect('quota-exhausted').then(function () {
                  notify("Today's 10 free minutes are used up",
                    'Quota resets at midnight UTC. Subscribe for unlimited.');
                });
              }
              broadcastState();
            });
          })
          .catch(function (err) {
            console.warn('[bg] user heartbeat failed:', err && err.code, err && err.message);
            if (err && (err.code === 'USER_SESSION_INVALID' || err.status === 401)) {
              return userDisconnect('session-expired');
            }
          });
      });
    });
  }

  function userDisconnect(reason) {
    var clearError = null;
    var sessionStartedAt = null;
    return Storage.getConnection().then(function (conn) {
      if (conn && conn.status === 'connected' && conn.connectedAt) {
        sessionStartedAt = conn.connectedAt;
      }
      return Storage.getUserSession();
    }).then(function (session) {
      var ended = (session && session.sessionToken)
        ? configureApi().then(function () {
            return api.userSessionEnd(session.sessionToken).catch(function () {});
          })
        : Promise.resolve();
      return ended.then(function () {
        return ProxyCtl.clear().catch(function (err) { clearError = err; });
      });
    }).then(function () {
      if (sessionStartedAt) {
        var seconds = Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000));
        return Storage.addUsageSeconds(seconds);
      }
    }).then(function () {
      clearUserHeartbeatAlarm();
      var connState = clearError
        ? {
            status: 'error',
            error: 'Failed to release proxy: ' + (clearError.message || String(clearError)),
            at: Date.now(),
          }
        : { status: 'disconnected', reason: reason || null, at: Date.now() };
      return Promise.all([
        Storage.clearUserSession(),
        Storage.setConnection(connState),
      ]);
    }).then(function () {
      setBadge(clearError ? '!' : '', clearError ? '#f78a8a' : '#000000');
      broadcastState();
      if (!clearError && (reason === 'user' || reason == null)) {
        reloadHttpTabs();
        notify('Disconnected', 'Browser is now using its direct connection.');
      }
    });
  }

  function guestDisconnect(reason) {
    var clearError = null;
    var sessionStartedAt = null;
    return Storage.getConnection().then(function (conn) {
      if (conn && conn.status === 'connected' && conn.connectedAt) {
        sessionStartedAt = conn.connectedAt;
      }
      return Storage.getGuestSession();
    }).then(function (session) {
      // Best-effort end-call — failures here just leave the row to
      // expire on its own when its TTL fires.
      var ended = (session && session.sessionToken)
        ? configureApi().then(function () {
            return api.guestEnd(session.deviceId, session.sessionToken).catch(function () {});
          })
        : Promise.resolve();
      return ended.then(function () {
        return ProxyCtl.clear().catch(function (err) { clearError = err; });
      });
    }).then(function () {
      if (sessionStartedAt) {
        var seconds = Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000));
        return Storage.addUsageSeconds(seconds);
      }
    }).then(function () {
      clearGuestHeartbeatAlarm();
      var connState = clearError
        ? {
            status: 'error',
            error: 'Failed to release proxy: ' + (clearError.message || String(clearError)),
            at: Date.now(),
          }
        : { status: 'disconnected', reason: reason || null, at: Date.now() };
      // Only drop the guest-mode-intent flag when the trial is over
      // for the day (quota) or the backend lost our session — on a
      // user-initiated disconnect the user is likely to want to
      // reconnect, so leave them on the main view.
      var clearIntent = (reason === 'quota-exhausted' || reason === 'session-expired')
        ? Storage.setGuestModeIntent(false)
        : Promise.resolve();
      return Promise.all([
        Storage.clearGuestSession(),
        Storage.setConnection(connState),
        clearIntent,
      ]);
    }).then(function () {
      setBadge(clearError ? '!' : '', clearError ? '#f78a8a' : '#000000');
      broadcastState();
      if (!clearError && (reason === 'user' || reason == null)) {
        reloadHttpTabs();
        notify('Disconnected', 'Browser is now using its direct connection.');
      }
    });
  }

  // ---- Public-IP lookup --------------------------------------------------
  // Fired right after a successful connect. Routes through the proxy
  // (api.ipify.org isn't in ALWAYS_BYPASS), so the IP we get back is the
  // exit-node's egress address — exactly what the user wants to see in
  // the Virtual IP card. Best-effort: any failure leaves publicIp unset
  // and the popup shows "—" rather than guessing.
  //
  // Rate-limit: in MV3 the SW restarts dozens of times per browsing day,
  // and bootstrap re-runs this for any still-connected session. Cap to
  // one lookup per PUBLIC_IP_TTL_MS unless `force` is set (used right
  // after a fresh connect when the IP definitely changed).
  var PUBLIC_IP_TTL_MS = 10 * 60 * 1000; // 10 minutes

  function updatePublicIp(opts) {
    var force = opts && opts.force;
    return Storage.getConnection().then(function (conn) {
      if (!conn || conn.status !== 'connected') return;
      if (!force && conn.publicIp && conn.publicIpAt &&
          (Date.now() - conn.publicIpAt) < PUBLIC_IP_TTL_MS) {
        return; // recent enough — don't hammer ipify
      }
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timeoutId = setTimeout(function () {
        if (controller) controller.abort();
      }, 10000);
      var fetchOpts = { credentials: 'omit', cache: 'no-store' };
      if (controller) fetchOpts.signal = controller.signal;

      return fetch('https://api.ipify.org?format=json', fetchOpts)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          return data && data.ip ? String(data.ip) : null;
        })
        .then(function (ip) {
          if (!ip) return;
          return Storage.getConnection().then(function (current) {
            // Race guard: if the user disconnected (or hit an error) while
            // ipify was in flight, don't write a stale IP into a
            // non-connected state.
            if (!current || current.status !== 'connected') return;
            current.publicIp = ip;
            current.publicIpAt = Date.now();
            return Storage.setConnection(current).then(function () { broadcastState(); });
          });
        })
        .catch(function (err) {
          console.warn('[bg] public IP lookup failed:', err && err.message);
        })
        .then(function () { clearTimeout(timeoutId); });
    });
  }

  function reloadHttpTabs() {
    if (!BX.tabs || typeof BX.tabs.query !== 'function') return;

    // Skip the currently focused tab. Reloading it steals focus from
    // the action popup, which Chrome auto-dismisses on focus loss —
    // so the user sees the popup vanish the instant they tap
    // Disconnect. Background tabs still get reloaded (that's where
    // most stale keep-alive sockets live anyway); the user can
    // reload the active tab themselves if they want.
    function processTabs(tabs) {
      (tabs || []).forEach(function (t) {
        if (!t || !t.id || t.discarded) return;
        if (t.active) return;
        if (!t.url || !/^https?:\/\//i.test(t.url)) return;
        try { BX.tabs.reload(t.id, { bypassCache: false }); } catch (_) {}
      });
    }

    // Cross-browser: Firefox's `browser.tabs.query` is Promise-only and
    // silently ignores a callback argument — the previous callback-style
    // call left tabs un-reloaded on Firefox, so disconnected sessions
    // kept tunneling through the dead proxy on long-lived tabs. Detect
    // the Promise return shape and fall back to the callback form for
    // older Chromium builds.
    try {
      var ret = BX.tabs.query({});
      if (ret && typeof ret.then === 'function') {
        ret.then(processTabs).catch(function (e) {
          console.warn('[bg] reloadHttpTabs query failed:', e && e.message);
        });
        return;
      }
      BX.tabs.query({}, processTabs);
    } catch (e) {
      console.warn('[bg] reloadHttpTabs failed:', e);
    }
  }

  function broadcastState() {
    // Tier / version / usage may have shifted — keep the post-uninstall
    // survey URL in sync. Fire-and-forget; never block the broadcast.
    updateUninstallUrl();
    BX.runtime.sendMessage({ type: 'state-changed' }).catch(function () { /* no listeners is fine */ });
  }

  // ---- Proxy warmup ------------------------------------------------------
  //
  // After ProxyCtl.apply() resolves, the proxy IS configured in the
  // browser — but on a brand-new session there can still be a small
  // window where the on-box Squid hasn't quite seen the cred (the
  // backend's SSH push is best-effort + the on-box agent's polling is
  // the fallback). In that window, the browser's first CONNECT lands
  // with 407, Chrome retries via onAuthRequired with the right creds,
  // Squid finally accepts — but if Chrome's retry count is exhausted
  // first the user sees its native proxy-auth dialog. (Squid also
  // caches the failure for `credentialsttl`, recently lowered from
  // 5 min → 30 sec on every box.)
  //
  // The warmup gates the popup's "connected" state on a successful
  // proxied fetch to api.ipify.org. On the happy path (SSH push
  // landed before this fired) it succeeds first try and adds zero
  // visible delay. On the slow path it retries every 4 sec for up to
  // 30 sec — the user sees the orb in its "connecting" state for the
  // duration, then it transitions to "connected" once the proxy is
  // verified usable.
  function warmupProxy() {
    var DEADLINE_MS = 30000;
    var BACKOFF_MS = 4000;
    var startedAt = Date.now();
    var attemptNo = 0;

    function attempt() {
      attemptNo += 1;
      var thisAttempt = attemptNo;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timeoutId = setTimeout(function () {
        if (controller) controller.abort();
      }, 6000);
      var fetchOpts = { credentials: 'omit', cache: 'no-store' };
      if (controller) fetchOpts.signal = controller.signal;

      console.log('[warmup] attempt ' + thisAttempt + ' → CONNECT via proxy to api.ipify.org');
      return fetch('https://api.ipify.org?format=json', fetchOpts)
        .then(function (res) {
          clearTimeout(timeoutId);
          console.log('[warmup] attempt ' + thisAttempt + ' got HTTP ' + res.status);
          // 407 means Squid still doesn't have our cred. Anything
          // else (200 / 5xx / etc.) means the CONNECT handshake
          // through the proxy did succeed — the request reached
          // the origin, which is all we need from a warmup.
          if (res.status === 407) {
            throw new Error('407');
          }
          return true;
        })
        .catch(function (err) {
          clearTimeout(timeoutId);
          console.warn('[warmup] attempt ' + thisAttempt + ' failed: ' +
            (err && err.name) + ' / ' + (err && err.message) +
            ' (elapsed ' + (Date.now() - startedAt) + 'ms)');
          if (Date.now() - startedAt > DEADLINE_MS) {
            throw err;
          }
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(attempt()); }, BACKOFF_MS);
          });
        });
    }

    return attempt();
  }

  // ---- Uninstall-feedback URL -------------------------------------------
  // chrome.runtime.setUninstallURL fires the URL exactly once after the
  // user removes the extension, with no payload control beyond the
  // querystring. We prefill the survey form with diagnostic context the
  // user can't supply themselves (their tier, version, how long they
  // actually used it) so a one-question form is enough.
  //
  // Tier mapping mirrors the future email-verified middle tier:
  //   - anonymous : never signed in
  //   - email     : signed in, not premium (today: locked screen, soon: 2h/day)
  //   - premium   : signed in + active subscription
  //
  // Called on every state change because the user's tier can shift
  // mid-session (sign in, subscription expires, etc.) and the API
  // doesn't give us a "current state" hook — easier to just rewrite the
  // URL each time something material moved.
  function updateUninstallUrl() {
    if (!BX.runtime || typeof BX.runtime.setUninstallURL !== 'function') return Promise.resolve();
    return Promise.all([
      Storage.getAuthToken(),
      Storage.getPremium(),
      Storage.getOrCreateDeviceUuid(),
      Storage.getUsageSeconds(),
      Storage.getSettings(),
    ]).then(function (r) {
      var token = r[0];
      var premium = r[1];
      var deviceUuid = r[2];
      var usageSeconds = r[3];
      var settings = r[4];
      var tier = !token ? 'anonymous' : (premium.isPremium ? 'premium' : 'email');
      var version = (BX.runtime.getManifest && BX.runtime.getManifest().version) || '';
      var base = (settings.apiBase || 'https://securepaidvpn.com').replace(/\/+$/, '');
      var url = base + '/uninstall-feedback' +
        '?d=' + encodeURIComponent(deviceUuid) +
        '&t=' + encodeURIComponent(tier) +
        '&v=' + encodeURIComponent(version) +
        '&u=' + Math.floor((usageSeconds || 0) / 60);
      try { BX.runtime.setUninstallURL(url); } catch (_) {}
    }).catch(function () { /* never let URL update break anything */ });
  }

  // ---- Periodic premium re-check -----------------------------------------
  // The mobile app re-pulls /api/auth/me when the user backgrounds/foregrounds
  // the app. The extension has no analogous lifecycle event, so we use an
  // alarm. This also catches "subscription expired during a connected
  // session" — we tear the proxy down rather than keep tunneling traffic
  // for a non-paying user.

  function ensureAlarm() {
    // Premium-refresh poll — 15 minute period. Uses the same
    // get-then-create guard ensureRecurringAlarm provides; if we
    // skipped the guard, a fast SW restart cycle would reset the
    // 15-min timer on every wake and the alarm could go indefinitely
    // without firing, which is how an expired subscription would keep
    // tunneling traffic.
    ensureRecurringAlarm('premium-refresh', 15);
  }

  if (BX.alarms && BX.alarms.onAlarm) {
    BX.alarms.onAlarm.addListener(function (alarm) {
      if (alarm.name === 'guest-heartbeat') {
        guestHeartbeatTick().catch(function () { /* ignore — next tick retries */ });
        return;
      }
      if (alarm.name === 'user-heartbeat') {
        userHeartbeatTick().catch(function () { /* ignore */ });
        return;
      }
      if (alarm.name !== 'premium-refresh') return;
      Storage.getAuthToken().then(function (token) {
        if (!token) return;
        return refreshMe().then(function (me) {
          if (!me) return;
          if (!me.isPremium) {
            return Storage.getConnection().then(function (conn) {
              if (conn && conn.status === 'connected') {
                return disconnect('subscription-expired').then(function () {
                  notify('Subscription required', 'Your VPN session ended because the subscription is no longer active.');
                });
              }
            });
          }
        });
      }).catch(function () { /* ignore */ });
    });
  }

  // ---- Message router (popup / options / auth pages) ---------------------

  var handlers = {
    'get-state': function () {
      return Promise.all([
        Storage.getAuthToken(),
        Storage.getUser(),
        Storage.getPremium(),
        Storage.getConnection(),
        Storage.getSelectedServerId(),
        Storage.getServers(),
        Storage.getSettings(),
        Storage.getGuestSession(),
        Storage.getOnboardingSeen(),
        Storage.getGuestModeIntent(),
        Storage.getUserSession(),
      ]).then(function (r) {
        return {
          isAuthenticated: !!r[0],
          user: r[1],
          isPremium: r[2].isPremium,
          subscription: r[2].subscription,
          connection: r[3],
          selectedServerId: r[4],
          servers: r[5].servers,
          serversFetchedAt: r[5].fetchedAt,
          settings: r[6],
          guestSession: r[7],
          onboardingSeen: r[8],
          guestModeIntent: r[9],
          userSession: r[10],
        };
      });
    },

    'set-onboarding-seen': function () {
      return Storage.setOnboardingSeen().then(function () {
        broadcastState();
        return { ok: true };
      });
    },

    // Combined onboarding dismissal + enter guest-mode intent. Atomic
    // Legacy onboarding-dismissal handler. The anonymous guest tier has
    // been removed, so this NEVER enables guest mode anymore — it only
    // records that onboarding was seen (the popup now sends
    // 'set-onboarding-seen' directly; this alias stays inert for any
    // stale/cached popup that might still send the old message).
    'dismiss-onboarding-to-main': function () {
      return Storage.setOnboardingSeen().then(function () {
        broadcastState();
        return { ok: true };
      });
    },

    // Resend the verification email. Backend gates auth + rate-limit.
    'resend-verify-email': function () {
      return configureApi().then(function () {
        return api.resendVerify();
      });
    },

    // Submit the 6-digit OTP the user typed into the popup. On
    // success the backend flips emailVerified=true; we refresh /me
    // so state.user.emailVerified updates and render() routes the
    // popup onward to the locked/main view.
    'submit-verify-code': function (msg) {
      return configureApi().then(function () {
        return api.verifyEmailCode(msg && msg.code);
      }).then(function (resp) {
        return refreshMe().then(function () {
          broadcastState();
          return resp;
        });
      });
    },

    // Password reset (public — the user is logged out). forgot-password emails
    // a 6-digit code; reset-password verifies it and sets the new password.
    // Both are unauthenticated, so no token is attached.
    'forgot-password': function (msg) {
      return configureApi().then(function () {
        return api.forgotPassword(msg && msg.email);
      });
    },
    'reset-password': function (msg) {
      return configureApi().then(function () {
        return api.resetPassword(msg && msg.email, msg && msg.code, msg && msg.password);
      });
    },

    // Anonymous guest tier removed — this is now inert. It never sets
    // guest intent; kept only so a stale popup sending the old message
    // gets a clean no-op instead of an "unknown action" error. The free
    // tier requires signup + email verification (see 'user-session-start').
    'guest-mode-enter': function () {
      return Promise.resolve({ ok: false, removed: true });
    },
    'guest-mode-exit': function () {
      return Storage.setGuestModeIntent(false).then(function () {
        broadcastState();
        return { ok: true };
      });
    },

    'login': function (msg) {
      return configureApi().then(function () {
        return api.login(msg.email, msg.password);
      }).then(function (resp) {
        return Promise.all([
          Storage.setAuthToken(resp.token),
          Storage.setUser(resp.user),
          Storage.setPremium(!!resp.isPremium, resp.subscription || null),
          // Signing in graduates the user out of guest mode — drop
          // the intent flag so the next render doesn't route them
          // back to the free-trial home view.
          Storage.setGuestModeIntent(false),
        ]).then(function () {
          api.configure(undefined, resp.token);
          return refreshServers().catch(function () { /* non-fatal */ });
        }).then(function () {
          broadcastState();
          return { ok: true };
        });
      });
    },

    'signup': function (msg) {
      // Two-step: fetch a fresh PoW challenge, solve it locally
      // (Pow.solve via crypto.subtle in the SW context — ~1-2 sec at
      // 20-bit difficulty), then call /signup with the solution. The
      // solve happens here in the background so the popup's UI thread
      // stays responsive; on a typical signup the user is still
      // skimming the email-pending screen by the time the network
      // round-trip completes.
      return configureApi().then(function () {
        return api.signupChallenge();
      }).then(function (challenge) {
        return Pow.solve(challenge.nonce, challenge.difficulty).then(function (solution) {
          return api.signup(msg.name, msg.email, msg.password, challenge.challengeId, solution);
        });
      }).then(function (resp) {
        return Promise.all([
          Storage.setAuthToken(resp.token),
          Storage.setUser(resp.user),
          Storage.setPremium(!!resp.isPremium, resp.subscription || null),
          Storage.setGuestModeIntent(false),
        ]).then(function () {
          api.configure(undefined, resp.token);
          return refreshServers().catch(function () { /* non-fatal */ });
        }).then(function () {
          broadcastState();
          return { ok: true };
        });
      });
    },

    'logout': function () {
      return disconnect('logout').then(function () {
        return Storage.clearAuth();
      }).then(function () {
        api.configure(undefined, null);
        broadcastState();
        return { ok: true };
      });
    },

    'refresh-me': function () {
      return refreshMe().then(function (me) {
        broadcastState();
        return me;
      });
    },

    'refresh-servers': function () {
      return refreshServers();
    },

    'select-server': function (msg) {
      return Storage.setSelectedServerId(msg.serverId).then(function () {
        broadcastState();
        return { ok: true };
      });
    },

    'connect': function (msg) {
      return connect(msg.serverId);
    },

    'disconnect': function () {
      return Storage.getUserSession().then(function (userSess) {
        if (userSess && userSess.sessionToken) return userDisconnect('user');
        return Storage.getGuestSession().then(function (session) {
          if (session && session.sessionToken) return guestDisconnect('user');
          return disconnect('user');
        });
      });
    },

    // Anonymous guest connect removed. Inert no-op (never calls
    // guestConnect) so a stale popup can't spin up an anonymous session.
    // Free access is signup + verify → 'user-session-start'.
    'guest-start': function () {
      return Promise.resolve({ ok: false, removed: true });
    },

    // Email-verified user-tier (2 hours/day) start. JWT-authed; the
    // backend's /api/user-session/start gates on emailVerified=true
    // and returns 403 EMAIL_NOT_VERIFIED for accounts that haven't
    // completed the OTP yet.
    'user-session-start': function () {
      return userConnect();
    },

    'set-settings': function (msg) {
      return Storage.setSettings(msg.patch || {}).then(function (settings) {
        return configureApi().then(function () { return settings; });
      });
    },

    'open-portal': function () {
      return configureApi().then(function () {
        return api.subscriptionPortalUrl();
      }).then(function (resp) {
        if (resp && resp.url) {
          BX.tabs.create({ url: resp.url });
        }
        return resp;
      });
    },

    // Strict allowlist for open-page. Earlier versions accepted any
    // /^https?:\/\// URL as a path, which would have been a phishing
    // vector if a content script (we don't have any today, but the
    // architecture allowed it) or a future call-site ever passed an
    // attacker-controlled URL: the user would see a SecurePaid-branded
    // popup launch a tab to an arbitrary host. Now: only known
    // marketing / dashboard paths on our own origin are allowed; the
    // path is matched against this set after stripping query +
    // fragment, and the host is locked to settings.apiBase.
    'open-page': function (msg) {
      var ALLOWED_PATHS = {
        '/': 1,
        '/pricing': 1,
        '/help': 1,
        '/download': 1,
        '/forgot': 1,
        '/privacy': 1,
        '/terms': 1,
        '/data-deletion': 1,
        '/features': 1,
        '/dashboard': 1,
        '/dashboard/subscription': 1,
        '/dashboard/subscribe': 1,
        '/dashboard/devices': 1,
        '/dashboard/profile': 1,
        '/login': 1,
        '/signup': 1,
        '/verify-email-code': 1,
      };
      return configureApi().then(function (cfg) {
        var base = (cfg.settings.apiBase || 'https://securepaidvpn.com').replace(/\/+$/, '');
        var rawPath = String((msg && msg.path) || '/');
        // Strip query + fragment for the allowlist check; preserve them
        // on the final URL so e.g. /dashboard/subscribe?plan=yearly
        // continues to work.
        var canonical = rawPath.split('?')[0].split('#')[0];
        if (!ALLOWED_PATHS[canonical]) {
          var err = new Error('Path not allowed: ' + canonical);
          err.code = 'OPEN_PAGE_DENIED';
          throw err;
        }
        var url = base + (rawPath[0] === '/' ? rawPath : '/' + rawPath);
        BX.tabs.create({ url: url });
        return { ok: true };
      });
    },
  };

  function refreshServers() {
    return configureApi().then(function (cfg) {
      if (!cfg.token) return { servers: [] };
      return api.listServers().then(function (resp) {
        var servers = (resp && resp.servers) || [];
        return Storage.setServers(servers).then(function () {
          broadcastState();
          return { servers: servers };
        });
      });
    });
  }

  BX.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;
    // Reject anything not originating from our own extension's
    // contexts (popup.js, options.js). Today we ship no content
    // scripts, but the moment one's added, an unvalidated listener
    // would let any page on <all_urls> trigger connect / disconnect /
    // login / logout / open-page. sender.id is set by the browser to
    // the originating extension's ID for same-extension runtime
    // messages; mismatched or missing IDs are reject candidates.
    var ownId = (BX.raw && BX.raw.runtime && BX.raw.runtime.id) || null;
    if (ownId && sender && sender.id && sender.id !== ownId) {
      try { sendResponse({ ok: false, error: 'sender not authorized' }); } catch (_) {}
      return false;
    }
    var handler = handlers[msg.type];
    if (!handler) {
      sendResponse({ error: 'Unknown message: ' + msg.type });
      return false;
    }
    Promise.resolve()
      .then(function () { return handler(msg); })
      .then(function (data) { sendResponse({ ok: true, data: data }); })
      .catch(function (err) {
        sendResponse({
          ok: false,
          error: err.message || String(err),
          code: err.code,
          status: err.status,
          // Forward the raw JSON body so the popup can read structured
          // fields like attemptsLeft (wrong verify/reset code) or retryAfter.
          payload: err.payload,
        });
      });
    return true; // async response
  });

  // ---- Lifecycle ----------------------------------------------------------

  // Returns true if the browser is currently routing through our proxy.
  // Chromium: chrome.proxy.settings persist across SW restarts, so we ask
  // the API directly. Firefox: proxy liveness is decided by
  // rehydrateFirefoxProxy (permanent top-level onRequest listener +
  // persisted state), not here — return false so the Chromium-only
  // proxy.settings probe below is skipped.
  function isProxyStillActive() {
    if (BX.isFirefox) return Promise.resolve(false);
    if (!BX.proxy || !BX.proxy.settings || !BX.proxy.settings.get) {
      return Promise.resolve(false);
    }
    return new Promise(function (resolve) {
      try {
        BX.proxy.settings.get({ incognito: false }, function (details) {
          var mode = details && details.value && details.value.mode;
          // Treat the dead-end (127.0.0.1:1) we use as a teardown step
          // as not-active; it'll get cleared to 'direct' shortly.
          var rules = details && details.value && details.value.rules;
          var single = rules && rules.singleProxy;
          var deadEnd = single && single.host === '127.0.0.1' && Number(single.port) === 1;
          resolve(mode === 'fixed_servers' && !deadEnd);
        });
      } catch (_) { resolve(false); }
    });
  }

  function bootstrap() {
    if (STATE.bootstrapped) return;
    STATE.bootstrapped = true;
    // The anonymous guest tier was removed — the free tier now requires
    // signup + email verification (10 min/day, matching the mobile app).
    // Wipe any guest state a previous version may have persisted so the
    // guest / tier-chooser UI can never surface post-update.
    Storage.setGuestModeIntent(false).catch(function () {});
    Storage.clearGuestSession().catch(function () {});
    try { BX.alarms.clear('guest-heartbeat'); } catch (_) {}
    ensureAlarm();
    ProxyCtl.installAuthListener();
    updateUninstallUrl();
    configureApi().then(function (cfg) {
      // Reconcile the persisted connection status against the browser's
      // *actual* proxy state. The SW gets terminated aggressively in MV3
      // (~30s idle), and on Chromium chrome.proxy.settings survives that
      // termination — so a stored "connected" with the proxy still in
      // fixed_servers mode is genuinely connected, not stale. Wiping it
      // unconditionally (an earlier version did this) made the popup show
      // "NOT CONNECTED" while the action badge still said ON and the
      // browser was still tunneling. Now: keep "connected" only if the
      // proxy verifies; otherwise reset.
      //
      // Critically: do NOT auto-reconnect here. Earlier versions
      // re-issued connect() if conn.status === 'connected', which
      // surprised users — opening the popup or any other event that
      // wakes the SW would silently start a connection attempt
      // without their consent.
      Storage.getConnection()
        .then(function (conn) {
          // A previous version's anonymous-guest connection may still be
          // live (proxy applied, creds dying server-side, no heartbeat —
          // the guest tier is gone). Tear it down fully instead of
          // rehydrating a zombie session that half-works until the exit
          // node drops the cred.
          if (conn && conn.guest && (conn.status === 'connected' || conn.status === 'connecting')) {
            return ProxyCtl.clear().catch(function () {})
              .then(function () {
                return Storage.setConnection({
                  status: 'disconnected',
                  reason: 'guest-tier-removed',
                  at: Date.now(),
                });
              })
              .then(function () {
                setBadge('', '#000000');
                broadcastState();
                return { conn: null, rehydratedFirefox: false, rehydratedChromium: false };
              });
          }
          // Two parallel rehydrate paths — only one applies per browser:
          //  - Firefox: re-register proxy.onRequest from persisted creds.
          //    Without this, every Firefox SW restart silently drops the
          //    VPN (popup looks disconnected, badge says ON).
          //  - Chromium: chrome.proxy.settings persists across SW
          //    restarts, but the in-memory credential cache and the
          //    onAuthRequired listener died with the SW. We need creds
          //    back in memory BEFORE the first buffered 407 is dispatched
          //    — otherwise the listener answers with cancel/empty and
          //    Chrome shows the native proxy-auth dialog. The listener
          //    is registered synchronously at SW boot; awaiting the
          //    storage load here closes the race window.
          return Promise.all([
            ProxyCtl.rehydrateFirefoxProxy(conn),
            ProxyCtl.rehydrateChromiumAuth(conn),
          ]).then(function (results) {
            return { conn: conn, rehydratedFirefox: results[0], rehydratedChromium: results[1] };
          });
        })
        .then(function (state) {
          var conn = state.conn;
          if (state.rehydratedFirefox) {
            // Firefox path: listener is back, treat as connected.
            setBadge('ON', '#d4a04c');
            broadcastState();
            updatePublicIp();
            return;
          }
          return isProxyStillActive().then(function (alive) {
            if (alive && conn && conn.status === 'connected') {
              // Chromium path: chrome.proxy.settings survives SW restarts.
              // rehydrateChromiumAuth has already pulled the persisted
              // creds back into memory, so the listener can answer the
              // next 407 immediately. Restore the badge and refresh the
              // public IP since the network path may have moved.
              setBadge('ON', '#d4a04c');
              broadcastState();
              updatePublicIp();
              return;
            }
            if (conn && conn.status !== 'disconnected') {
              return Storage.setConnection({ status: 'disconnected', at: Date.now() })
                .then(function () { broadcastState(); });
            }
          });
        })
        .catch(function () {});

      if (cfg.token) {
        refreshMe().catch(function () { /* token may be expired; UI handles */ });
      }

      // Re-arm the user-tier heartbeat alarm if a session is currently
      // active. Alarms persist across SW restarts on Chromium but are
      // wiped on Firefox SW restart — re-creating is idempotent (alarm
      // with the same name is replaced) so this is safe everywhere.
      // (No guest re-arm: the guest tier is removed, and bootstrap wipes
      // any persisted guest session above — re-arming would race that.)
      Storage.getUserSession().then(function (session) {
        if (session && session.sessionToken) ensureUserHeartbeatAlarm();
      });
    });
  }

  if (BX.runtime.onInstalled) {
    BX.runtime.onInstalled.addListener(function () { bootstrap(); });
  }
  if (BX.runtime.onStartup) {
    BX.runtime.onStartup.addListener(function () { bootstrap(); });
  }
  bootstrap();
})();
