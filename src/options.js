(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function send(type, msg) {
    msg = Object.assign({ type: type }, msg || {});
    return BX.runtime.sendMessage(msg).then(function (resp) {
      if (resp && resp.ok) return resp.data;
      var err = new Error((resp && resp.error) || 'Unknown error');
      err.code = resp && resp.code;
      err.status = resp && resp.status;
      throw err;
    });
  }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  function render(state) {
    var user = state.user || {};
    $('account-email').textContent = user.email || '—';
    $('account-premium').textContent = state.isPremium ? 'Active' : 'Not subscribed';
    $('account-premium').style.color = state.isPremium ? 'var(--accent)' : 'var(--text-muted)';
    $('account-plan').textContent = (state.subscription && state.subscription.planKey) || '—';
    $('account-expires').textContent = fmtDate(state.subscription && state.subscription.expiresAt);

    var conn = state.connection || { status: 'disconnected' };
    $('conn-state').textContent = conn.status || 'disconnected';
    $('conn-server').textContent = conn.server
      ? (conn.server.country + (conn.server.city ? ' · ' + conn.server.city : ''))
      : '—';
    $('conn-proxy').textContent = conn.proxy
      ? (conn.proxy.type.toUpperCase() + ' · ' + conn.proxy.host + ':' + conn.proxy.port)
      : '—';

    var s = state.settings || {};
    $('setting-notifications').checked = !!s.showNotifications;
    $('setting-autoconnect').checked = !!s.autoConnectOnStartup;
    $('setting-api-base').value = s.apiBase || '';
  }

  function refresh() {
    return send('get-state').then(render).catch(function (err) {
      console.error('[options] state load failed', err);
    });
  }

  $('manage-billing').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true; btn.textContent = 'Opening…';
    send('open-portal').catch(function () {
      send('open-page', { path: '/dashboard/subscription' });
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Manage billing';
    });
  });

  $('logout').addEventListener('click', function () {
    if (!confirm('Sign out and disconnect?')) return;
    send('logout').then(refresh);
  });

  $('refresh-state').addEventListener('click', function () {
    send('refresh-me').then(refresh).catch(refresh);
  });
  $('force-disconnect').addEventListener('click', function () {
    send('disconnect').then(refresh).catch(refresh);
  });

  $('setting-notifications').addEventListener('change', function (e) {
    send('set-settings', { patch: { showNotifications: e.target.checked } }).then(refresh);
  });
  $('setting-autoconnect').addEventListener('change', function (e) {
    send('set-settings', { patch: { autoConnectOnStartup: e.target.checked } }).then(refresh);
  });

  $('save-advanced').addEventListener('click', function () {
    var url = $('setting-api-base').value.trim();
    if (!/^https?:\/\//i.test(url)) {
      alert('API base must start with http:// or https://');
      return;
    }
    send('set-settings', { patch: { apiBase: url } }).then(refresh);
  });

  $('reset-advanced').addEventListener('click', function () {
    send('set-settings', { patch: { apiBase: 'https://securepaidvpn.com' } }).then(refresh);
  });

  $('open-help').addEventListener('click', function (e) {
    e.preventDefault();
    send('open-page', { path: '/help' });
  });
  $('open-privacy').addEventListener('click', function (e) {
    e.preventDefault();
    send('open-page', { path: '/privacy' });
  });

  // Mirror manifest version into the footer.
  try {
    var mf = (BX.raw.runtime.getManifest && BX.raw.runtime.getManifest()) || {};
    if (mf.version) $('ext-version').textContent = mf.version;
  } catch (_) {}

  BX.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'state-changed') refresh();
  });

  refresh();
})();
