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

  root.Api = Api;
})(typeof self !== 'undefined' ? self : this);
