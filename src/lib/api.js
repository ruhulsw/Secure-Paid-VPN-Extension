// Backend client. Mirrors the same endpoints the mobile app and dashboard
// already use — the extension is just another consumer of the existing
// /api/* surface, plus the new /api/extension/* additions.
(function (root) {
  'use strict';

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('Request timed out')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); },
                   function (e) { clearTimeout(t); reject(e); });
    });
  }

  function buildUrl(base, path) {
    var b = String(base || '').replace(/\/+$/, '');
    var p = path[0] === '/' ? path : '/' + path;
    return b + p;
  }

  function Api() {
    this.base = null;
    this.token = null;
  }

  Api.prototype.configure = function (base, token) {
    if (base) this.base = base;
    this.token = token || null;
  };

  Api.prototype.request = function (path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
    var body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    if (this.token && !headers.Authorization) {
      headers.Authorization = 'Bearer ' + this.token;
    }
    var url = buildUrl(this.base, path);
    var fetchPromise = fetch(url, {
      method: method,
      headers: headers,
      body: body,
      credentials: 'omit',
    }).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parser = ct.indexOf('application/json') >= 0 ? res.json() : res.text();
      return parser.then(function (data) {
        if (!res.ok) {
          var err = new Error(
            (data && data.error) || ('HTTP ' + res.status)
          );
          err.status = res.status;
          err.code = data && data.code;
          err.payload = data;
          throw err;
        }
        return data;
      });
    });
    return withTimeout(fetchPromise, opts.timeoutMs || 20000);
  };

  // --- Auth ----------------------------------------------------------------

  Api.prototype.login = function (email, password) {
    return this.request('/api/auth/login', {
      method: 'POST',
      body: { email: email, password: password },
    });
  };

  Api.prototype.signup = function (name, email, password) {
    return this.request('/api/auth/signup', {
      method: 'POST',
      body: { name: name, email: email, password: password },
    });
  };

  Api.prototype.me = function () {
    return this.request('/api/auth/me');
  };

  Api.prototype.changePassword = function (oldPassword, newPassword) {
    return this.request('/api/auth/change-password', {
      method: 'POST',
      body: { oldPassword: oldPassword, newPassword: newPassword },
    });
  };

  // --- Subscription --------------------------------------------------------

  Api.prototype.subscriptionStatus = function () {
    return this.request('/api/subscription/status');
  };

  Api.prototype.subscriptionPortalUrl = function () {
    return this.request('/api/subscription/portal-url', { method: 'POST' });
  };

  // --- Servers / proxy -----------------------------------------------------

  Api.prototype.listServers = function () {
    return this.request('/api/extension/servers');
  };

  Api.prototype.requestProxy = function (serverId, deviceUuid, deviceName) {
    return this.request('/api/extension/proxy/' + encodeURIComponent(serverId), {
      method: 'POST',
      body: { deviceUuid: deviceUuid, deviceName: deviceName || 'Browser extension' },
    });
  };

  // --- Plans ---------------------------------------------------------------

  Api.prototype.listPlans = function () {
    return this.request('/api/plans');
  };

  // --- Guest free-tier (20 min/day, no account) ----------------------------
  //
  // Same backend endpoints the Cross / Mac SwiftUI / mobile clients use.
  // We don't send the Authorization header for guest calls — these
  // routes are deliberately unauthenticated and identify the device by
  // the deviceId payload field (a hashed per-install UUID).

  Api.prototype.guestStart = function (deviceId) {
    var url = buildUrl(this.base, '/api/guest/start');
    return withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId }),
        credentials: 'omit',
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var err = new Error((data && data.error) || ('HTTP ' + res.status));
            err.status = res.status;
            err.code = data && data.code;
            err.payload = data;
            throw err;
          }
          return data;
        });
      }),
      20000
    );
  };

  Api.prototype.guestHeartbeat = function (deviceId, sessionToken, secondsElapsed) {
    var url = buildUrl(this.base, '/api/guest/heartbeat');
    return withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: deviceId,
          sessionToken: sessionToken,
          secondsElapsed: secondsElapsed,
        }),
        credentials: 'omit',
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var err = new Error((data && data.error) || ('HTTP ' + res.status));
            err.status = res.status;
            err.code = data && data.code;
            err.payload = data;
            throw err;
          }
          return data;
        });
      }),
      10000
    );
  };

  Api.prototype.guestEnd = function (deviceId, sessionToken) {
    var url = buildUrl(this.base, '/api/guest/end');
    return withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId, sessionToken: sessionToken }),
        credentials: 'omit',
      }).then(function (res) { return res.text().then(function () { return null; }); }),
      5000
    );
  };

  root.Api = Api;
})(typeof self !== 'undefined' ? self : this);
