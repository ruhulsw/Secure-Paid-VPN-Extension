// Popup controller. Talks to background.js exclusively via runtime messages
// — keeps the popup a pure render-and-event surface so closing it doesn't
// drop in-flight work.
//
// Layout mirrors the React Native mobile app: tabbed Home / Locations /
// Premium / Settings, single header chrome.

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    root:        $('root'),
    viewAuth:    $('view-auth'),
    viewLocked:  $('view-locked'),
    viewMain:    $('view-main'),
    viewLoading: $('view-loading'),
    brandSub:    $('brand-sub'),
    statusPill:  $('status-pill'),

    // Auth
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

    // Locked
    openPricing:   $('open-pricing'),
    lockedRefresh: $('locked-refresh'),
    lockedLogout:  $('locked-logout'),

    // Main / Home tab
    serverPicker: $('server-picker'),
    statusFlag:   $('status-flag'),
    statusName:   $('status-name'),
    statusSub:    $('status-sub'),
    connectBtn:   $('connect-btn'),
    statusError:  $('status-error'),

    // Locations tab
    locationsSub:  $('locations-sub'),
    serverSearch:  $('server-search'),
    serverList:    $('server-list'),
    refreshServers:$('refresh-servers'),

    // Premium tab
    premiumStatus:  $('premium-status'),
    premiumPlan:    $('premium-plan'),
    premiumPlanRow: $('premium-plan-row'),
    premiumRenew:   $('premium-renew'),
    premiumRenewRow:$('premium-renew-row'),
    manageBilling:  $('manage-billing'),
    openPricingMain:$('open-pricing-main'),

    // Settings tab
    settingsUser: $('settings-user'),
    openOptions:  $('open-options'),
    openHelp:     $('open-help'),
    settingsLogout:$('settings-logout'),

    // Tabs
    tabBtns:  document.querySelectorAll('.tab-btn'),
    tabPanes: document.querySelectorAll('.tab-pane'),
  };

  var state = null;
  var activeTab = 'home';
  var searchQuery = '';

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

    var isMain = name === 'main';
    els.statusPill.hidden = !isMain;
    els.brandSub.hidden   = !isMain || !(state && state.isPremium);
  }

  function setActiveTab(name) {
    activeTab = name;
    els.tabPanes.forEach(function (p) {
      p.classList.toggle('hidden', p.dataset.tab !== name);
    });
    els.tabBtns.forEach(function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
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
      var city = selected.city || '';
      var country = selected.country || 'Server';
      els.statusName.textContent = city ? (city + ', ' + country) : country;
      els.statusSub.textContent  = (typeof selected.pingMs === 'number' && selected.pingMs > 0)
        ? (selected.pingMs + ' ms · ' + (selected.host || ''))
        : (selected.host || 'Tap to change');
    } else {
      els.statusFlag.textContent = '🌐';
      els.statusName.textContent = 'Choose a location';
      els.statusSub.textContent  = 'Tap to pick a server';
    }

    var btnLabel = status === 'connected' ? 'Tap to Disconnect'
                 : status === 'connecting' ? 'Connecting…'
                 : status === 'disconnecting' ? 'Disconnecting…'
                 : 'Tap to Connect';
    els.connectBtn.querySelector('.connect-label').textContent = btnLabel;
    els.connectBtn.disabled = !selected || status === 'connecting' || status === 'disconnecting';

    if (status === 'error' && conn.error) {
      els.statusError.hidden = false;
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

    // Locations tab — list with optional search filter
    var filteredServers = filterServers(servers, searchQuery);
    if (els.locationsSub) {
      els.locationsSub.textContent = servers.length
        ? servers.length + ' server' + (servers.length === 1 ? '' : 's') + ' across the globe'
        : 'No servers available';
    }
    renderServerList(filteredServers, selectedId, conn);

    // Premium tab
    var sub = state.subscription || {};
    if (els.premiumStatus) {
      els.premiumStatus.textContent = sub.status || 'Active';
      els.premiumStatus.className = 'info-value premium-active';
    }
    if (els.premiumPlan) {
      var planName = sub.plan || sub.planName || sub.priceId || '';
      els.premiumPlan.textContent = planName || 'Premium';
      els.premiumPlanRow.hidden = false;
    }
    if (els.premiumRenew) {
      var renew = sub.currentPeriodEnd || sub.renewsAt || sub.nextBillingDate;
      if (renew) {
        var d = new Date(renew * (typeof renew === 'number' && renew < 1e12 ? 1000 : 1));
        els.premiumRenew.textContent = isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
        els.premiumRenewRow.hidden = false;
      } else {
        els.premiumRenewRow.hidden = true;
      }
    }

    // Settings tab — show user email
    if (els.settingsUser) {
      els.settingsUser.textContent = (state.user && state.user.email) || '';
    }
  }

  function filterServers(servers, q) {
    if (!q || !q.trim()) return servers;
    var query = q.trim().toLowerCase();
    return servers.filter(function (s) {
      return (s.country || '').toLowerCase().indexOf(query) !== -1
          || (s.city    || '').toLowerCase().indexOf(query) !== -1
          || (s.countryCode || '').toLowerCase().indexOf(query) !== -1;
    });
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
      empty.textContent = searchQuery ? 'No matches.' : 'No servers available yet.';
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

  // Tab switching
  els.tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setActiveTab(btn.dataset.tab);
    });
  });

  // Server picker on Home tab → jump to Locations tab
  if (els.serverPicker) {
    els.serverPicker.addEventListener('click', function () {
      setActiveTab('locations');
      setTimeout(function () { els.serverSearch && els.serverSearch.focus(); }, 50);
    });
  }

  // Search filter
  if (els.serverSearch) {
    els.serverSearch.addEventListener('input', function (e) {
      searchQuery = e.target.value;
      if (state) renderMain();
    });
  }

  // Auth — toggle login/signup
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

  // Connect / disconnect — disconnect MUST work even when status === 'connecting'
  // so users can cancel a stuck attempt.
  els.connectBtn.addEventListener('click', function () {
    if (!state) return;
    var conn = state.connection || { status: 'disconnected' };
    if (conn.status === 'connected' || conn.status === 'connecting' || conn.status === 'disconnecting') {
      send('disconnect').then(refresh).catch(function () { refresh(); });
      return;
    }
    var id = state.selectedServerId || (state.servers[0] && state.servers[0].id);
    if (!id) {
      setActiveTab('locations');
      return;
    }
    send('connect', { serverId: id }).catch(function () {}).then(refresh);
  });

  els.serverList.addEventListener('click', function (e) {
    var row = e.target.closest('.server-row');
    if (!row || !row.dataset.id) return;
    send('select-server', { serverId: row.dataset.id }).then(function () {
      // After picking, jump back to Home so the user sees the new selection.
      return refresh().then(function () { setActiveTab('home'); });
    });
  });

  els.refreshServers.addEventListener('click', function () {
    send('refresh-servers').then(refresh).catch(function () {});
  });

  // Premium tab
  if (els.manageBilling) {
    els.manageBilling.addEventListener('click', function () {
      send('open-portal').catch(function () {
        send('open-page', { path: '/dashboard' }).catch(function () {});
      });
    });
  }
  if (els.openPricingMain) {
    els.openPricingMain.addEventListener('click', function () {
      send('open-page', { path: '/pricing' }).catch(function () {});
    });
  }

  // Settings tab
  if (els.openOptions) {
    els.openOptions.addEventListener('click', function () {
      BX.runtime.openOptionsPage().catch(function () {});
    });
  }
  if (els.openHelp) {
    els.openHelp.addEventListener('click', function () {
      send('open-page', { path: '/help' }).catch(function () {});
    });
  }
  if (els.settingsLogout) {
    els.settingsLogout.addEventListener('click', function () {
      send('logout').then(refresh);
    });
  }

  function setBusy(btn, busy, label) {
    btn.disabled = !!busy;
    if (label == null) return;
    var lbl = btn.querySelector('.btn-label');
    if (lbl) lbl.textContent = label;
    else btn.textContent = label;
  }

  BX.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'state-changed') refresh();
  });

  refresh().catch(function (err) {
    setActiveView('auth');
    console.error('[popup] init failed', err);
  });
})();
