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
      importScripts('lib/browser.js', 'lib/storage.js', 'lib/api.js', 'lib/proxy.js');
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
      return { settings: results[0], token: results[1] };
    });
  }

  // ---- Auth + premium refresh --------------------------------------------

  function refreshMe() {
    if (STATE.refreshing) return Promise.resolve(null);
    STATE.refreshing = true;
    return configureApi().then(function (cfg) {
      if (!cfg.token) {
        STATE.refreshing = false;
        return null;
      }
      return api.me().then(function (resp) {
        STATE.refreshing = false;
        return Promise.all([
          Storage.setUser(resp.user || null),
          Storage.setPremium(!!resp.isPremium, resp.subscription || null),
        ]).then(function () { return resp; });
      }).catch(function (err) {
        STATE.refreshing = false;
        // Token is invalid / expired → drop it and force user to re-auth.
        if (err && (err.status === 401 || err.status === 403)) {
          return Storage.clearAuth().then(function () {
            return disconnect('auth-expired');
          }).then(function () { throw err; });
        }
        throw err;
      });
    });
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
    return ProxyCtl.clear().catch(function () { /* clear is best-effort */ })
      .then(function () {
        return Storage.setConnection({ status: 'disconnected', reason: reason || null, at: Date.now() });
      })
      .then(function () {
        setBadge('', '#000000');
        broadcastState();
        if (!reason || reason === 'user') {
          notify('Disconnected', 'Browser is now using its direct connection.');
        }
      });
  }

  function broadcastState() {
    BX.runtime.sendMessage({ type: 'state-changed' }).catch(function () { /* no listeners is fine */ });
  }

  // ---- Periodic premium re-check -----------------------------------------
  // The mobile app re-pulls /api/auth/me when the user backgrounds/foregrounds
  // the app. The extension has no analogous lifecycle event, so we use an
  // alarm. This also catches "subscription expired during a connected
  // session" — we tear the proxy down rather than keep tunneling traffic
  // for a non-paying user.

  function ensureAlarm() {
    if (!BX.alarms) return;
    BX.alarms.get && BX.alarms.get('premium-refresh', function (existing) {
      if (existing) return;
      try { BX.alarms.create('premium-refresh', { periodInMinutes: 15 }); } catch (_) {}
    });
  }

  if (BX.alarms && BX.alarms.onAlarm) {
    BX.alarms.onAlarm.addListener(function (alarm) {
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
        };
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
      return configureApi().then(function () {
        return api.signup(msg.name, msg.email, msg.password);
      }).then(function (resp) {
        return Promise.all([
          Storage.setAuthToken(resp.token),
          Storage.setUser(resp.user),
          Storage.setPremium(!!resp.isPremium, resp.subscription || null),
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
      return disconnect('user');
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

    'open-page': function (msg) {
      return configureApi().then(function (cfg) {
        var base = cfg.settings.apiBase || 'https://securepaidvpn.com';
        var url = msg.path && /^https?:\/\//i.test(msg.path)
          ? msg.path
          : (base.replace(/\/+$/, '') + (msg.path || '/'));
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
        });
      });
    return true; // async response
  });

  // ---- Lifecycle ----------------------------------------------------------

  function bootstrap() {
    if (STATE.bootstrapped) return;
    STATE.bootstrapped = true;
    ensureAlarm();
    ProxyCtl.installAuthListener();
    configureApi().then(function (cfg) {
      // Clear any stale `error` connection status from a previous session.
      // Without this the popup would keep surfacing yesterday's failure
      // ("Couldn't reach the API…") long after the underlying issue is
      // gone — the conn record persists in storage.local and is never
      // overwritten until the next connect/disconnect.
      Storage.getConnection().then(function (conn) {
        if (conn && conn.status === 'error') {
          return Storage.setConnection({ status: 'disconnected', at: Date.now() })
            .then(function () { broadcastState(); });
        }
      }).catch(function () {});

      if (cfg.token) {
        // Re-issue the proxy if we were connected before the worker restart.
        // Chrome wipes proxy.settings when the SW dies, so we re-apply.
        Storage.getConnection().then(function (conn) {
          if (conn && conn.status === 'connected' && conn.serverId) {
            connect(conn.serverId).catch(function () { /* swallow — UI shows error */ });
          }
        }).catch(function () {});
        refreshMe().catch(function () { /* token may be expired; UI handles */ });
      }
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
