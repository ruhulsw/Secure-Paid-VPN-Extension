// Popup controller. Talks to background.js exclusively via runtime messages
// — keeps the popup a pure render-and-event surface so closing it doesn't
// drop in-flight work.

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    root:        document.getElementById('root'),
    viewAuth:    $('view-auth'),
    viewLocked:  $('view-locked'),
    viewMain:    $('view-main'),
    viewLoading: $('view-loading'),

    settingsBtn: $('settings-btn'),
    brandSub:    $('brand-sub'),

    loginForm:     $('login-form'),
    loginEmail:    $('login-email'),
    loginPassword: $('login-password'),
    loginError:    $('login-error'),
    loginSubmit:   $('login-submit'),
    showSignup:    $('show-signup'),
    forgotLink:    $('forgot-link'),

    signupForm:     $('signup-form'),
    signupName:     $('signup-name'),
    signupEmail:    $('signup-email'),
    signupPassword: $('signup-password'),
    signupError:    $('signup-error'),
    signupSubmit:   $('signup-submit'),
    showLogin:      $('show-login'),

    openPricing:   $('open-pricing'),
    lockedRefresh: $('locked-refresh'),
    lockedLogout:  $('locked-logout'),

    statusPill:   $('status-pill'),
    serverPicker: $('server-picker'),
    statusFlag:   $('status-flag'),
    statusName:   $('status-name'),
    statusSub:    $('status-sub'),
    connectBtn:   $('connect-btn'),
    statusError:  $('status-error'),
    serverList:   $('server-list'),
    refreshServers: $('refresh-servers'),
    footerUser:   $('footer-user'),
    footerSettings: $('footer-settings'),
  };

  var state = null;

  // ---- Messaging ---------------------------------------------------------

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

  function refresh() {
    return send('get-state').then(function (data) {
      state = data;
      render();
    });
  }

  // ---- View routing ------------------------------------------------------

  function setActiveView(name) {
    [els.viewAuth, els.viewLocked, els.viewMain, els.viewLoading].forEach(function (v) {
      v.classList.add('hidden');
    });
    var v = name === 'auth' ? els.viewAuth
          : name === 'locked' ? els.viewLocked
          : name === 'main' ? els.viewMain
          : els.viewLoading;
    v.classList.remove('hidden');

    // Header chrome — only show StatusPill + Premium subtitle on the
    // main connect view. Auth/locked/loading views hide them so the
    // header stays a clean brand block (mirrors mobile app behaviour).
    var isMain = name === 'main';
    els.statusPill.hidden = !isMain;
    els.brandSub.hidden   = !isMain || !(state && state.isPremium);
  }

  function render() {
    if (!state) { setActiveView('loading'); return; }

    if (!state.isAuthenticated) {
      setActiveView('auth');
      return;
    }
    if (!state.isPremium) {
      setActiveView('locked');
      return;
    }
    setActiveView('main');
    renderMain();
  }

  // ---- Main view rendering ----------------------------------------------

  function renderMain() {
    var conn = state.connection || { status: 'disconnected' };
    var servers = state.servers || [];
    var selectedId = state.selectedServerId
      || (conn.status === 'connected' && conn.serverId)
      || (servers[0] && servers[0].id)
      || null;

    var selected = servers.find(function (s) { return s.id === selectedId; })
                || (conn.status === 'connected' ? conn.server : null);

    var status = conn.status || 'disconnected';
    els.root.dataset.status = status;

    els.statusPill.querySelector('.status-pill-text').textContent =
      status === 'connecting' ? 'Connecting'
      : status === 'connected' ? 'Protected'
      : status === 'disconnecting' ? 'Disconnecting'
      : status === 'error' ? 'Error'
      : 'Not Connected';

    if (selected) {
      els.statusFlag.textContent = selected.flag || flagEmoji(selected.countryCode) || '🌐';
      // Picker shows "City, Country" like the mobile app's server-picker.
      var city = selected.city || '';
      var country = selected.country || 'Server';
      els.statusName.textContent = city ? (city + ', ' + country) : country;
      els.statusSub.textContent  = (typeof selected.pingMs === 'number' && selected.pingMs > 0)
        ? (selected.pingMs + ' ms · ' + (selected.host || ''))
        : (selected.host || '');
    } else {
      els.statusFlag.textContent = '🌐';
      els.statusName.textContent = 'Choose a location';
      els.statusSub.textContent  = 'Pick a server from the list below';
    }

    var btnLabel = status === 'connected' ? 'Tap to Disconnect'
                 : status === 'connecting' ? 'Connecting…'
                 : status === 'disconnecting' ? 'Disconnecting…'
                 : 'Tap to Connect';
    els.connectBtn.querySelector('.connect-label').textContent = btnLabel;
    els.connectBtn.disabled = !selected || status === 'connecting' || status === 'disconnecting';

    if (status === 'error' && conn.error) {
      els.statusError.hidden = false;
      // Distinguish the generic browser fetch failure from real backend
      // messages so a user (or operator) can tell whether the connect
      // got rejected vs. simply couldn't reach the network.
      var detail = conn.error;
      if (conn.errorName === 'TypeError' || /failed to fetch/i.test(conn.error || '')) {
        detail = 'Couldn’t reach the API (' + conn.error + '). Check your network and try again.';
      } else if (conn.code === 'SUBSCRIPTION_REQUIRED') {
        detail = 'Active subscription required to connect.';
      } else if (conn.code === 'DEVICE_LIMIT') {
        detail = conn.error;
      }
      els.statusError.textContent = detail;
    } else {
      els.statusError.hidden = true;
      els.statusError.textContent = '';
    }

    renderServerList(servers, selectedId, conn);
    els.footerUser.textContent = (state.user && state.user.email) || '';
  }

  // DOM-construction (no innerHTML) — Mozilla's reviewers flag dynamic
  // innerHTML even when inputs are escaped, because they can't audit the
  // sanitizer. Building the tree node-by-node with textContent is the
  // canonical fix.
  function makeRow(s, isSelected, isConnected) {
    var li = document.createElement('li');
    li.className = 'server-row';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    li.dataset.id = s.id;

    var flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = s.flag || flagEmoji(s.countryCode) || '🌐';

    var meta = document.createElement('div');
    meta.className = 'meta';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.country || s.name || '';
    var sub = document.createElement('div');
    sub.className = 'sub';
    var subText = [s.city, typeof s.pingMs === 'number' && s.pingMs > 0 ? s.pingMs + ' ms' : null]
      .filter(Boolean).join(' · ');
    sub.textContent = subText || s.host || '';
    meta.appendChild(name);
    meta.appendChild(sub);

    li.appendChild(flag);
    li.appendChild(meta);

    if (isConnected || s.isPremium) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = isConnected ? 'Live' : 'Premium';
      li.appendChild(badge);
    }
    return li;
  }

  function renderServerList(servers, selectedId, conn) {
    els.serverList.replaceChildren();
    if (!servers.length) {
      var empty = document.createElement('li');
      empty.className = 'server-row server-row--empty';
      empty.textContent = 'No servers available yet.';
      els.serverList.appendChild(empty);
      return;
    }
    var connectedId = conn && conn.status === 'connected' ? conn.serverId : null;
    servers.forEach(function (s) {
      els.serverList.appendChild(makeRow(s, s.id === selectedId, s.id === connectedId));
    });
  }

  function flagEmoji(cc) {
    if (!cc || cc.length !== 2) return '';
    var A = 0x1f1e6;
    var a = 'A'.charCodeAt(0);
    return String.fromCodePoint(A + (cc.charCodeAt(0) - a)) +
           String.fromCodePoint(A + (cc.charCodeAt(1) - a));
  }

  // ---- Event wiring ------------------------------------------------------

  els.showSignup.addEventListener('click', function () {
    els.loginForm.classList.add('hidden');
    els.signupForm.classList.remove('hidden');
  });
  els.showLogin.addEventListener('click', function () {
    els.signupForm.classList.add('hidden');
    els.loginForm.classList.remove('hidden');
  });

  els.loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    els.loginError.textContent = '';
    setBusy(els.loginSubmit, true, 'Signing in…');
    send('login', {
      email: els.loginEmail.value.trim().toLowerCase(),
      password: els.loginPassword.value,
    }).then(function () {
      els.loginPassword.value = '';
      return refresh();
    }).catch(function (err) {
      els.loginError.textContent = err.message || 'Sign-in failed';
    }).then(function () {
      setBusy(els.loginSubmit, false, 'Sign in');
    });
  });

  els.signupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    els.signupError.textContent = '';
    setBusy(els.signupSubmit, true, 'Creating account…');
    send('signup', {
      name: els.signupName.value.trim(),
      email: els.signupEmail.value.trim().toLowerCase(),
      password: els.signupPassword.value,
    }).then(function () {
      els.signupPassword.value = '';
      return refresh();
    }).catch(function (err) {
      els.signupError.textContent = err.message || 'Could not create account';
    }).then(function () {
      setBusy(els.signupSubmit, false, 'Create account');
    });
  });

  els.forgotLink.addEventListener('click', function (e) {
    e.preventDefault();
    send('open-page', { path: '/forgot' }).catch(function () {});
  });

  els.openPricing.addEventListener('click', function () {
    send('open-page', { path: '/pricing' }).catch(function () {});
  });
  els.lockedRefresh.addEventListener('click', function () {
    setBusy(els.lockedRefresh, true, 'Refreshing…');
    send('refresh-me').then(refresh).catch(function () {})
      .then(function () { setBusy(els.lockedRefresh, false, 'I just subscribed — refresh'); });
  });
  els.lockedLogout.addEventListener('click', function () {
    send('logout').then(refresh);
  });

  els.connectBtn.addEventListener('click', function () {
    if (!state) return;
    var conn = state.connection || { status: 'disconnected' };
    if (conn.status === 'connected' || conn.status === 'connecting') {
      send('disconnect').then(refresh).catch(function () {});
      return;
    }
    var id = state.selectedServerId || (state.servers[0] && state.servers[0].id);
    if (!id) return;
    send('connect', { serverId: id }).catch(function () {}).then(refresh);
  });

  els.serverList.addEventListener('click', function (e) {
    var row = e.target.closest('.server-row');
    if (!row || !row.dataset.id) return;
    send('select-server', { serverId: row.dataset.id }).then(refresh);
  });

  els.refreshServers.addEventListener('click', function () {
    send('refresh-servers').then(refresh).catch(function () {});
  });

  els.settingsBtn.addEventListener('click', function () {
    BX.runtime.openOptionsPage().catch(function () {});
  });
  els.footerSettings.addEventListener('click', function () {
    BX.runtime.openOptionsPage().catch(function () {});
  });

  // Buttons now contain a leading SVG icon + a `.btn-label` span. Update
  // only the span so the icon survives. Falls back to textContent for
  // legacy buttons that don't yet have a `.btn-label`.
  function setBusy(btn, busy, label) {
    btn.disabled = !!busy;
    if (label == null) return;
    var lbl = btn.querySelector('.btn-label');
    if (lbl) lbl.textContent = label;
    else btn.textContent = label;
  }

  // Live updates from the background — re-render whenever connection /
  // premium state changes.
  BX.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'state-changed') refresh();
  });

  refresh().catch(function (err) {
    setActiveView('auth');
    console.error('[popup] init failed', err);
  });
})();
