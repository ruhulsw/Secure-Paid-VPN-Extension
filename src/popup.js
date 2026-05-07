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
    guestBtn:       $('guest-btn'),

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

    // Stats
    statUptime:   $('stat-uptime'),
    statIp:       $('stat-ip'),

    // Tabs
    tabBtns:  document.querySelectorAll('.tab-btn'),
    tabPanes: document.querySelectorAll('.tab-pane'),
  };

  var state = null;
  var activeTab = 'home';
  var searchQuery = '';
  var uptimeTimer = null;

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
    var isGuest = !!(state && state.guestSession);
    els.statusPill.hidden = !isMain;
    // Header sub-line: "Premium · Unlimited" for paid users,
    // "Free trial · MM:SS left" for guests, hidden otherwise.
    if (isMain && isGuest) {
      var remaining = computeGuestRemainingSeconds();
      els.brandSub.hidden = false;
      els.brandSub.textContent = 'Free trial · ' + formatMmSs(remaining) + ' left today';
    } else {
      els.brandSub.hidden = !isMain || !(state && state.isPremium);
      if (isMain && state && state.isPremium) els.brandSub.textContent = 'Premium · Unlimited';
    }
  }

  // Best-effort local countdown — heartbeat updates state.guestSession.
  // remainingSeconds every 30s, so between ticks we extrapolate using
  // the connectedAt + lastHeartbeatAt timestamps to keep the counter
  // smooth instead of frozen.
  function computeGuestRemainingSeconds() {
    if (!state || !state.guestSession) return 0;
    var s = state.guestSession;
    var elapsedSinceHeartbeat = Math.max(0, Math.floor((Date.now() - (s.lastHeartbeatAt || Date.now())) / 1000));
    return Math.max(0, (s.remainingSeconds || 0) - elapsedSinceHeartbeat);
  }

  function formatMmSs(totalSeconds) {
    var t = Math.max(0, Math.floor(totalSeconds || 0));
    var m = Math.floor(t / 60);
    var s = t % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
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

    // Guest free-tier session takes priority over the auth gate — when
    // a guest session exists we show the main view (with a free-trial
    // countdown badge) regardless of whether the user is signed in or
    // premium. Disconnecting (manually or quota-exhausted) clears the
    // guestSession in storage and the next render() reverts to the
    // appropriate auth/locked/main view.
    if (state.guestSession) {
      setActiveView('main');
      renderMain();
      return;
    }

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
                 : 'Tap to Connect';
    els.connectBtn.querySelector('.connect-label').textContent = btnLabel;
    els.connectBtn.disabled = !selected || status === 'connecting';

    if (status === 'error' && conn.error) {
      els.statusError.hidden = false;
      var detail = conn.error;
      if (conn.errorName === 'TypeError' || /failed to fetch/i.test(conn.error || '')) {
        detail = 'Couldn’t reach the API (' + conn.error + '). Check your network and try again.';
      } else if (conn.code === 'SUBSCRIPTION_REQUIRED') {
        detail = 'Active subscription required to connect.';
      } else if (conn.code === 'DEVICE_LIMIT') {
        detail = conn.error;
      } else if (conn.code === 'PROXY_CONTROLLED_BY_OTHER_EXTENSION') {
        detail = 'Another extension (or system policy) is controlling the browser proxy. ' +
                 'Disable it and try Connect again.';
      } else if (conn.code === 'UNSUPPORTED_PROXY_TYPE') {
        detail = 'This server returned an unsupported proxy type. Try a different server, ' +
                 'or contact support if the problem persists.';
      } else if (conn.code === 'CHROME_SOCKS_AUTH_UNSUPPORTED') {
        // setProxyChromium rejects SOCKS proxies that carry credentials —
        // Chrome can't authenticate to them. Surface the helpful message
        // verbatim so the user knows it's not a transient network blip.
        detail = conn.error;
      }
      els.statusError.textContent = detail;
    } else {
      els.statusError.hidden = true;
      els.statusError.textContent = '';
    }

    // Stats grid (Home tab) — UPTIME ticks via setInterval, others state-driven
    updateUptime(conn);
    if (els.statIp) {
      // background.js looks up the real exit IP via api.ipify.org right
      // after the proxy is applied and writes it back into conn.publicIp.
      // Until that resolves we show "…" so the card doesn't flash a stale
      // value or claim "—" while a lookup is in flight.
      if (status === 'connected') {
        els.statIp.textContent = conn.publicIp || '…';
      } else {
        els.statIp.textContent = '—';
      }
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
    var subView = formatSubscription(state.subscription);
    if (els.premiumStatus) {
      els.premiumStatus.textContent = subView.status;
      els.premiumStatus.className = 'info-value premium-active';
    }
    if (els.premiumPlan) {
      els.premiumPlan.textContent = subView.plan;
      els.premiumPlanRow.hidden = false;
    }
    if (els.premiumRenew) {
      if (subView.renewLabel) {
        els.premiumRenew.textContent = subView.renewLabel;
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

  // Format elapsed milliseconds as HH:MM:SS, tabular-nums via CSS.
  function formatDuration(ms) {
    if (!ms || ms < 0) return '00:00:00';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return (h < 10 ? '0' : '') + h + ':' +
           (m < 10 ? '0' : '') + m + ':' +
           (sec < 10 ? '0' : '') + sec;
  }

  function updateUptime(conn) {
    if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
    if (!els.statUptime) return;
    if (!conn || conn.status !== 'connected' || !conn.connectedAt) {
      els.statUptime.textContent = '00:00:00';
      // Guest countdown still needs to tick even when uptime element is
      // unset, so fall through to install the secondary timer below.
    } else {
      var startedAt = conn.connectedAt;
      var paintUptime = function () {
        els.statUptime.textContent = formatDuration(Date.now() - startedAt);
      };
      paintUptime();
    }
    var isGuest = !!(state && state.guestSession);
    var paint = function () {
      if (els.statUptime && conn && conn.status === 'connected' && conn.connectedAt) {
        els.statUptime.textContent = formatDuration(Date.now() - conn.connectedAt);
      }
      if (isGuest && !els.brandSub.hidden) {
        els.brandSub.textContent = 'Free trial · ' + formatMmSs(computeGuestRemainingSeconds()) + ' left today';
      }
    };
    if ((conn && conn.status === 'connected' && conn.connectedAt) || isGuest) {
      uptimeTimer = setInterval(paint, 1000);
    }
  }

  // Backend subscription objects come in two shapes depending on whether
  // the row was last touched by the website or the mobile app. Normalize
  // here so popup + options render the same fields and one place owns
  // the field-name fallbacks. Keep this function in sync with
  // options.js's renderer (it imports the same shape).
  function formatSubscription(sub) {
    sub = sub || {};
    var rawPlan = sub.plan || sub.planKey || sub.planName || sub.priceId || 'Premium';
    // Backend planKey arrives lowercase ("yearly", "monthly", "weekly").
    // Title-case it for display so the Premium tab doesn't read like a
    // database dump. Hand-untouched values (already capitalized) pass
    // through unchanged.
    var plan = String(rawPlan).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    var status = sub.status || 'Active';
    var renew = sub.expiresAt || sub.currentPeriodEnd || sub.renewsAt || sub.nextBillingDate;
    var renewLabel = '';
    if (renew) {
      // Numeric values < 1e12 are unix-seconds; everything else (ISO
      // strings, ms timestamps) goes straight to Date.
      var d = new Date(typeof renew === 'number' && renew < 1e12 ? renew * 1000 : renew);
      // Medium format: "May 2, 2026" — unambiguous across locales,
      // unlike the default short form "5/2/2026" which means different
      // dates in US vs EU formatting.
      renewLabel = isNaN(d.getTime())
        ? ''
        : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
    return { plan: plan, status: status, renewLabel: renewLabel };
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

  // "Try free — 20 min/day" — anonymous guest connect. Backend issues
  // a per-device session and short-lived proxy creds; background.js
  // applies the proxy and starts a 30-sec heartbeat alarm that ticks
  // the daily quota down. No account required.
  if (els.guestBtn) {
    els.guestBtn.addEventListener('click', function () {
      els.loginError.textContent = '';
      setBusy(els.guestBtn, true, 'Starting free trial…');
      send('guest-start')
        .then(refresh)
        .catch(function (err) {
          var msg = err.message || 'Free trial unavailable right now';
          if (err.code === 'GUEST_QUOTA_EXHAUSTED') {
            msg = "Today's 20 minutes are gone. Resets at midnight UTC, or sign in for unlimited.";
          } else if (err.code === 'IP_RATE_LIMIT') {
            msg = 'Too many free trials from this network today. Try again tomorrow or sign in.';
          } else if (err.code === 'NO_GUEST_SERVER') {
            msg = 'Free-trial server is busy — try again in a minute.';
          }
          els.loginError.textContent = msg;
        })
        .then(function () {
          setBusy(els.guestBtn, false, 'Try free — 20 min/day, no account');
        });
    });
  }

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
    if (conn.status === 'connected' || conn.status === 'connecting') {
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

  // Fire-and-forget refresh of the server list on every popup open so newly
  // added locations show up without the user having to click "Refresh list".
  // Cached state already painted above; this triggers a state-changed
  // broadcast on completion that re-renders with the fresh list.
  send('refresh-servers').catch(function () {});
})();
