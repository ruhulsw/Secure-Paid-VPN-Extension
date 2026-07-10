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

  Api.prototype.signup = function (name, email, password, challengeId, solution) {
    return this.request('/api/auth/signup', {
      method: 'POST',
      body: {
        name: name,
        email: email,
        password: password,
        challengeId: challengeId,
        solution: solution,
      },
    });
  };

  // Fetch a fresh proof-of-work challenge. The popup pre-fetches one
  // when the signup form mounts so the solve can run in parallel with
  // the user filling out the form — by the time they hit Submit, the
  // solution is usually already cached.
  Api.prototype.signupChallenge = function () {
    return this.request('/api/auth/signup-challenge');
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

  // Email verification — submits the 6-digit OTP that was emailed to
  // the user. JWT-authed because we use the bearer to scope the code
  // check to the right account. Server rate-limits to 5 wrong codes
  // per round; user can tap Resend to reset.
  Api.prototype.verifyEmailCode = function (code) {
    return this.request('/api/auth/verify-email-code', {
      method: 'POST',
      body: { code: String(code || '').trim() },
    });
  };

  // Resend the verification email — requires JWT, 60-sec floor per
  // account. Server returns 429 with retryAfter when throttled.
  Api.prototype.resendVerify = function () {
    return this.request('/api/auth/resend-verify', { method: 'POST' });
  };

  // Password reset — public (the user is logged out). forgotPassword emails a
  // 6-digit code (always 200, never reveals whether the email exists);
  // resetPassword verifies the code and sets the new password. Unauthenticated
  // like the guest calls — no Authorization header is required or used.
  Api.prototype.forgotPassword = function (email) {
    return this.request('/api/auth/forgot', {
      method: 'POST',
      body: { email: email },
    });
  };

  Api.prototype.resetPassword = function (email, code, password) {
    return this.request('/api/auth/reset-password', {
      method: 'POST',
      body: { email: email, code: code, password: password },
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

  // --- Free tier: signup + verify → 10 min/day (matches the mobile app) ----
  //
  // JWT-authed; the backend keys the daily quota by userId. `tier:'mobile'`
  // gives 600s/day (10 min) and rotates the exit node via pickGuestServer,
  // exactly like the mobile app — the response carries the same proxy
  // descriptor + sessionToken as the premium path. The tier MUST be sent on
  // EVERY call: start/heartbeat/end share one daily bucket keyed by
  // (userId, tier), so a missing tier would look in the wrong bucket (the
  // start would 200 but heartbeats/end would 401).

  Api.prototype.userSessionStart = function () {
    return this.request('/api/user-session/start', {
      method: 'POST',
      body: { tier: 'mobile' },
    });
  };

  Api.prototype.userSessionHeartbeat = function (sessionToken, secondsElapsed) {
    return this.request('/api/user-session/heartbeat', {
      method: 'POST',
      body: { tier: 'mobile', sessionToken: sessionToken, secondsElapsed: secondsElapsed },
    });
  };

  Api.prototype.userSessionEnd = function (sessionToken) {
    return this.request('/api/user-session/end', {
      method: 'POST',
      body: { tier: 'mobile', sessionToken: sessionToken },
    });
  };

  root.Api = Api;
})(typeof self !== 'undefined' ? self : this);
