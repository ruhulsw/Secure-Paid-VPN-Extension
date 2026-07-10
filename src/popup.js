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
    viewOnboarding: $('view-onboarding'),
    onboardingDone: $('onboarding-done'),
    onboardingGetApp: $('onboarding-get-app'),
    // Tier chooser — shown when a guest-pending user taps the orb.
    viewChooser: $('view-chooser'),
    chooserSignup: $('chooser-signup'),
    chooserGuest: $('chooser-guest'),
    chooserBack: $('chooser-back'),
    // Email-pending — shown after signup. The user got a 6-digit code
    // in their inbox and types it into the input below.
    viewEmailPending: $('view-email-pending'),
    emailPendingAddress: $('email-pending-address'),
    emailPendingForm: $('email-pending-form'),
    emailPendingCode: $('email-pending-code'),
    emailPendingVerify: $('email-pending-verify'),
    emailPendingResend: $('email-pending-resend'),
    emailPendingChange: $('email-pending-change'),
    emailPendingMsg: $('email-pending-msg'),
    brandSub:    $('brand-sub'),
    statusPill:  $('status-pill'),

    // Password reset (in-popup, code-based)
    viewReset:         $('view-reset'),
    resetRequestForm:  $('reset-request-form'),
    resetEmail:        $('reset-email'),
    resetRequestMsg:   $('reset-request-msg'),
    resetRequestSubmit:$('reset-request-submit'),
    resetEnterForm:    $('reset-enter-form'),
    resetAddress:      $('reset-address'),
    resetCode:         $('reset-code'),
    resetPassword:     $('reset-password'),
    resetConfirm:      $('reset-confirm'),
    resetEnterMsg:     $('reset-enter-msg'),
    resetEnterSubmit:  $('reset-enter-submit'),
    resetResend:       $('reset-resend'),
    resetBack:         $('reset-back'),

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
  // True while the logged-out password-reset flow is on screen, so
  // render() keeps showing it instead of the sign-in form on broadcasts.
  var resetMode = false;
  // While true, the popup ignores `state-changed` broadcasts so the
  // user doesn't see intermediate views flicker by during a multi-step
  // flow (onboarding-dismiss → guest-start fires several broadcasts:
  // onboardingSeen flip, status='connecting', status='connected'. The
  // middle one transiently looks like the auth view because
  // guestSession isn't set yet). Set true before the chain, cleared
  // in the final .then().
  var renderLocked = false;

  // ---- Messaging ---------------------------------------------------------

  function send(type, msg) {
    msg = Object.assign({ type: type }, msg || {});
    return BX.runtime.sendMessage(msg).then(function (resp) {
      if (resp && resp.ok) return resp.data;
      var err = new Error((resp && resp.error) || 'Unknown error');
      err.code = resp && resp.code;
      err.status = resp && resp.status;
      err.payload = resp && resp.payload;
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
    [els.viewAuth, els.viewLocked, els.viewMain, els.viewLoading, els.viewOnboarding,
     els.viewChooser, els.viewEmailPending, els.viewReset].forEach(function (v) {
      if (v) v.classList.add('hidden');
    });
    var v = name === 'auth' ? els.viewAuth
          : name === 'locked' ? els.viewLocked
          : name === 'main' ? els.viewMain
          : name === 'onboarding' ? els.viewOnboarding
          : name === 'chooser' ? els.viewChooser
          : name === 'email-pending' ? els.viewEmailPending
          : name === 'reset' ? els.viewReset
          : els.viewLoading;
    if (v) v.classList.remove('hidden');

    var isMain = name === 'main';
    var isGuest = !!(state && state.guestSession);
    var isGuestPending = !!(state && state.guestModeIntent && !state.guestSession && !state.isAuthenticated);
    var isUserTierConnected = !!(state && state.userSession);
    var isUserTierPending = !!(
      state && state.isAuthenticated && state.user && state.user.emailVerified === true &&
      !state.isPremium && !state.userSession
    );
    els.statusPill.hidden = !isMain;
    // Header sub-line:
    //   - Premium · Unlimited (paid)
    //   - Email plan · HH:MM:SS left (verified user, 2hr countdown)
    //   - Email plan · 2 hours/day available (verified, not yet connected)
    //   - Free trial · MM:SS left (anonymous session, 20-min countdown)
    //   - Free trial · 20 min/day available (intent set, not yet connected)
    if (isMain && isUserTierConnected) {
      var userRemaining = computeUserRemainingSeconds();
      els.brandSub.hidden = false;
      els.brandSub.textContent = 'Free · ' + formatMmSs(userRemaining) + ' left today';
    } else if (isMain && isUserTierPending) {
      els.brandSub.hidden = false;
      els.brandSub.textContent = 'Free · 10 minutes/day available';
    } else if (isMain && isGuest) {
      var remaining = computeGuestRemainingSeconds();
      els.brandSub.hidden = false;
      els.brandSub.textContent = 'Free trial · ' + formatMmSs(remaining) + ' left today';
    } else if (isMain && isGuestPending) {
      els.brandSub.hidden = false;
      els.brandSub.textContent = 'Free trial · 20 min/day available';
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

  // Same shape for the email-verified user tier (2 hours/day).
  function computeUserRemainingSeconds() {
    if (!state || !state.userSession) return 0;
    var s = state.userSession;
    var elapsedSinceHeartbeat = Math.max(0, Math.floor((Date.now() - (s.lastHeartbeatAt || Date.now())) / 1000));
    return Math.max(0, (s.remainingSeconds || 0) - elapsedSinceHeartbeat);
  }

  function formatHhMmSs(totalSeconds) {
    var t = Math.max(0, Math.floor(totalSeconds || 0));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    return (h < 10 ? '0' : '') + h + ':' +
           (m < 10 ? '0' : '') + m + ':' +
           (s < 10 ? '0' : '') + s;
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

    // First-run gate — show the "browser traffic only / get the
    // desktop app for whole-computer" card BEFORE any auth/main view.
    // The card sets expectations so users don't bounce on the first
    // connect when they realize the extension doesn't tunnel non-
    // browser apps. Dismissed once and never shown again
    // (storage.onboardingSeen).
    if (state.onboardingSeen === false) {
      setActiveView('onboarding');
      return;
    }

    // Guest free-tier takes priority over the auth gate. Two states
    // both land on the main view:
    //   1. guestSession  — proxy is up, countdown ticking.
    //   2. guestModeIntent && !auth — user has chosen "free tier" but
    //      hasn't tapped Connect yet (onboarding direct-route or
    //      auth-screen Try-free). Orb tap from this state opens the
    //      tier chooser; orb tap inside the chooser is what actually
    //      fires /api/guest/start. The intent flag persists across
    //      popup closes; cleared on sign-in or quota-exhausted.
    if (state.guestSession || (state.guestModeIntent && !state.isAuthenticated)) {
      setActiveView('main');
      renderMain();
      return;
    }

    if (!state.isAuthenticated) {
      // Keep the (logged-out) password-reset flow on screen if the user
      // opened it — a background state broadcast must not yank them back
      // to the sign-in form mid-reset.
      if (resetMode) { setActiveView('reset'); return; }
      setActiveView('auth');
      return;
    }
    // Signed in but email not verified yet → "Check your email" card
    // with the 6-digit OTP input. Holds the user here until /api/auth/me
    // returns emailVerified=true.
    if (state.user && state.user.emailVerified === false) {
      renderEmailPending();
      setActiveView('email-pending');
      return;
    }
    // Email-verified + premium → existing main view, full server list.
    // Email-verified + NOT premium → main view in user-tier mode:
    //   pending state ("Tap to Connect — 2 hours/day"), or connected
    //   state with the HH:MM:SS countdown if userSession is live.
    //   No more "Subscription required" wall — that's gated behind
    //   the locations tab + paywall now.
    if (state.user && state.user.emailVerified === true) {
      setActiveView('main');
      renderMain();
      return;
    }
    if (!state.isPremium) {
      setActiveView('locked');
      return;
    }
    setActiveView('main');
    renderMain();
  }

  function renderEmailPending() {
    if (els.emailPendingAddress) {
      els.emailPendingAddress.textContent = (state.user && state.user.email) || 'your inbox';
    }
    if (els.emailPendingMsg) {
      els.emailPendingMsg.hidden = true;
      els.emailPendingMsg.textContent = '';
      els.emailPendingMsg.classList.remove('ep-msg--error');
    }
    if (els.emailPendingCode) {
      els.emailPendingCode.value = '';
      // Focus the code input after a tick so the popup paint settles
      // first (focus during a hidden→visible transition is dropped
      // on some browsers).
      setTimeout(function () {
        try { els.emailPendingCode.focus(); } catch (_) {}
      }, 50);
    }
  }

  function setEmailPendingMessage(text, isError) {
    if (!els.emailPendingMsg) return;
    els.emailPendingMsg.hidden = !text;
    els.emailPendingMsg.textContent = text || '';
    els.emailPendingMsg.classList.toggle('ep-msg--error', !!isError);
  }

  // ---- Main view rendering ----------------------------------------------

  function renderMain() {
    var conn = state.connection || { status: 'disconnected' };
    var servers = state.servers || [];
    var isGuestPending = !!(state.guestModeIntent && !state.guestSession && !state.isAuthenticated);
    var isUserTier = !!state.userSession;
    var isUserTierPending = !!(
      state.isAuthenticated && state.user && state.user.emailVerified === true &&
      !state.isPremium && !state.userSession
    );
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
    } else if (isUserTierPending) {
      // Email-verified-not-premium user pre-connect: backend picks
      // the tier server at /api/user-session/start, so surface
      // "auto-selected" instead of a dead-end "Choose a location" CTA.
      els.statusFlag.textContent = '📧';
      els.statusName.textContent = 'Email-tier server';
      els.statusSub.textContent  = 'Auto-selected on connect';
    } else if (isGuestPending) {
      // Anonymous popup has no server list (no JWT). Backend assigns
      // the free-tier server at /api/guest/start time — surface as
      // "auto-selected".
      els.statusFlag.textContent = '🎁';
      els.statusName.textContent = 'Free trial server';
      els.statusSub.textContent  = 'Auto-selected on connect';
    } else {
      els.statusFlag.textContent = '🌐';
      els.statusName.textContent = 'Choose a location';
      els.statusSub.textContent  = 'Tap to pick a server';
    }

    var btnLabel = status === 'connected' ? 'Tap to Disconnect'
                 : status === 'connecting' ? 'Connecting…'
                 : 'Tap to Connect';
    els.connectBtn.querySelector('.connect-label').textContent = btnLabel;
    // User-tier pending and guest-pending both let the user tap
    // connect without a selected server (backend picks). Everyone
    // else still needs a selection.
    els.connectBtn.disabled = status === 'connecting' ||
      (!isUserTierPending && !isGuestPending && !selected);

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

    // Settings tab — show user email for signed-in users, repurpose
    // the "Sign out" row as "Sign in / Create account" for guest-mode
    // users so they have a clean exit back to auth.
    var inGuestMode = isGuestPending || !!state.guestSession;
    // isUserTier / isUserTierPending are computed above and consumed
    // by the server-picker block + orb disabled-state. The settings
    // row labels here only care about anonymous-vs-signed-in, so they
    // don't branch on the user tier explicitly.
    void isUserTier; void isUserTierPending;
    if (els.settingsUser) {
      if (state.user && state.user.email) {
        els.settingsUser.textContent = state.user.email;
      } else if (inGuestMode) {
        els.settingsUser.textContent = 'Free trial mode';
      } else {
        els.settingsUser.textContent = '—';
      }
    }
    if (els.settingsLogout) {
      var logoutLabel = els.settingsLogout.querySelector('.setting-label');
      if (logoutLabel) {
        logoutLabel.textContent = (!state.isAuthenticated && inGuestMode)
          ? 'Sign in / Create account'
          : 'Sign out';
      }
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
    var isUserTier = !!(state && state.userSession);
    var paint = function () {
      if (els.statUptime && conn && conn.status === 'connected' && conn.connectedAt) {
        els.statUptime.textContent = formatDuration(Date.now() - conn.connectedAt);
      }
      if (isUserTier && !els.brandSub.hidden) {
        els.brandSub.textContent = 'Email plan · ' + formatHhMmSs(computeUserRemainingSeconds()) + ' left today';
      } else if (isGuest && !els.brandSub.hidden) {
        els.brandSub.textContent = 'Free trial · ' + formatMmSs(computeGuestRemainingSeconds()) + ' left today';
      }
    };
    if ((conn && conn.status === 'connected' && conn.connectedAt) || isGuest || isUserTier) {
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

  // Tier chooser — shown after the guest-pending user taps the orb.
  // Two paths:
  //   1. "Sign up — 2 hours/day" → switches the popup to the auth
  //      view with the signup form visible. After signup the
  //      email-pending view takes over until verification.
  //   2. "Free 20 min/day" → kicks off /api/guest/start (the same
  //      anonymous flow the Try-free button on the auth view uses).
  //   3. "Back" → returns to the main pending view.
  if (els.chooserSignup) {
    els.chooserSignup.addEventListener('click', function () {
      // Exit guest mode so the auth view actually shows (render()
      // would otherwise route us back to main pending).
      send('guest-mode-exit').then(function () {
        // Force the signup tab to be the visible one on auth view.
        els.loginForm && els.loginForm.classList.add('hidden');
        els.signupForm && els.signupForm.classList.remove('hidden');
        return refresh();
      });
    });
  }
  if (els.chooserGuest) {
    els.chooserGuest.addEventListener('click', function () {
      setBusy(els.chooserGuest, true, 'Connecting…');
      send('guest-start')
        .catch(function (err) {
          var msg = err.message || 'Free trial unavailable right now';
          if (err.code === 'GUEST_QUOTA_EXHAUSTED') {
            msg = "Today's 20 minutes are gone. Resets at midnight UTC, or sign up for 2 hours/day.";
          } else if (err.code === 'IP_RATE_LIMIT') {
            msg = 'Too many free trials from this network today. Try again tomorrow or sign up.';
          } else if (err.code === 'NO_GUEST_SERVER') {
            msg = 'Free-trial server is busy — try again in a minute.';
          }
          // Surface via the main view's status-error after refresh.
          alert(msg);
        })
        .then(refresh)
        .then(function () {
          setBusy(els.chooserGuest, false, 'Continue free — 20 min/day');
        });
    });
  }
  if (els.chooserBack) {
    els.chooserBack.addEventListener('click', function () {
      // Just re-render — guestModeIntent is still set, so render()
      // routes back to the main view in pending state.
      refresh();
    });
  }

  // Email-pending view — user types the 6-digit code from their
  // inbox into the input. Submit hits /api/auth/verify-email-code;
  // success refreshes /me (emailVerified flips true) and render()
  // routes onward. Resend rotates the code and re-sends the email.
  // Change email signs them out so they can re-signup with a
  // different address.
  if (els.emailPendingForm) {
    els.emailPendingForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var raw = (els.emailPendingCode && els.emailPendingCode.value) || '';
      var code = raw.replace(/\D/g, '');
      if (code.length !== 6) {
        setEmailPendingMessage('Enter the 6-digit code from your email.', true);
        return;
      }
      setEmailPendingMessage('', false);
      setBusy(els.emailPendingVerify, true, 'Verifying…');
      send('submit-verify-code', { code: code })
        .then(function () { return refresh(); })
        .catch(function (err) {
          var msg = err.message || 'Verification failed.';
          if (err.code === 'VERIFY_CODE_WRONG' && err.payload && err.payload.attemptsLeft != null) {
            msg = 'Wrong code. ' + err.payload.attemptsLeft + ' tries left before you need to resend.';
          } else if (err.code === 'VERIFY_CODE_EXPIRED') {
            msg = 'That code expired. Tap Resend to get a new one.';
          } else if (err.code === 'VERIFY_CODE_LOCKED') {
            msg = 'Too many wrong codes. Tap Resend to get a new one.';
          }
          setEmailPendingMessage(msg, true);
        })
        .then(function () {
          setBusy(els.emailPendingVerify, false, 'Verify');
        });
    });
  }
  // Strip non-digits live so a paste of "123 456" still works.
  if (els.emailPendingCode) {
    els.emailPendingCode.addEventListener('input', function (e) {
      var v = (e.target.value || '').replace(/\D/g, '').slice(0, 6);
      if (v !== e.target.value) e.target.value = v;
      // Auto-submit when the 6th digit is entered — saves a click
      // and matches how Apple / Google's OTP UIs feel.
      if (v.length === 6 && els.emailPendingForm) {
        els.emailPendingForm.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  }
  if (els.emailPendingResend) {
    els.emailPendingResend.addEventListener('click', function () {
      setBusy(els.emailPendingResend, true, 'Sending…');
      send('resend-verify-email')
        .then(function () {
          setEmailPendingMessage('Sent — check your inbox (and spam).', false);
          if (els.emailPendingCode) {
            els.emailPendingCode.value = '';
            try { els.emailPendingCode.focus(); } catch (_) {}
          }
        })
        .catch(function (err) {
          var msg = err.message || 'Could not resend right now.';
          if (err.code === 'RESEND_THROTTLED' && err.payload && err.payload.retryAfter) {
            msg = 'Wait ' + err.payload.retryAfter + 's before requesting another code.';
          }
          setEmailPendingMessage(msg, true);
        })
        .then(function () {
          setBusy(els.emailPendingResend, false, 'Resend code');
        });
    });
  }
  if (els.emailPendingChange) {
    els.emailPendingChange.addEventListener('click', function () {
      send('logout').then(refresh);
    });
  }

  // Onboarding — first-run card dismissal. "Got it" routes the user
  // directly to the main screen in guest-pending state ("Tap to
  // Connect", no countdown yet) — no spinner, no auth wall in
  // between. The actual /api/guest/start call happens later when the
  // user taps the connect orb and picks "Free 20 min" from the
  // chooser. "Get the desktop app" opens /download and dismisses
  // onboarding without entering guest mode (they're heading
  // elsewhere).
  if (els.onboardingDone) {
    els.onboardingDone.addEventListener('click', function () {
      send('dismiss-onboarding-to-main')
        .then(refresh)
        .catch(function () { refresh(); });
    });
  }
  if (els.onboardingGetApp) {
    els.onboardingGetApp.addEventListener('click', function () {
      send('open-page', { path: '/download' }).catch(function () {});
      send('set-onboarding-seen').then(refresh).catch(function () { refresh(); });
    });
  }

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
      // Signup leaves emailVerified=false on the backend; the next
      // refresh() will route the popup to the email-pending view via
      // render(). User completes verification from their inbox.
      return refresh();
    }).catch(function (err) {
      els.signupError.textContent = err.message || 'Could not create account';
    }).then(function () {
      setBusy(els.signupSubmit, false, 'Create account');
    });
  });

  // Password reset — handled IN the popup (code-based), no longer opens the
  // website. forgot-link → reset request step (email prefilled from login).
  function setResetMsg(el, text, isError) {
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('ep-msg--error', !!isError);
  }

  function showResetView() {
    resetMode = true;
    setResetMsg(els.resetRequestMsg, '', false);
    setResetMsg(els.resetEnterMsg, '', false);
    if (els.resetEnterForm) els.resetEnterForm.classList.add('hidden');
    if (els.resetRequestForm) els.resetRequestForm.classList.remove('hidden');
    if (els.resetResend) els.resetResend.classList.add('hidden');
    if (els.resetCode) els.resetCode.value = '';
    if (els.resetPassword) els.resetPassword.value = '';
    if (els.resetConfirm) els.resetConfirm.value = '';
    // Prefill the email the user already typed on the sign-in form.
    if (els.resetEmail) {
      els.resetEmail.value = (els.loginEmail && els.loginEmail.value.trim()) || '';
    }
    setActiveView('reset');
    try { els.resetEmail.focus(); } catch (_) {}
  }

  function exitResetView() {
    resetMode = false;
    setActiveView('auth');
  }

  if (els.forgotLink) {
    els.forgotLink.addEventListener('click', function (e) {
      e.preventDefault();
      showResetView();
    });
  }

  // Step 1 — request a code.
  if (els.resetRequestForm) {
    els.resetRequestForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = (els.resetEmail && els.resetEmail.value.trim().toLowerCase()) || '';
      if (!email) { setResetMsg(els.resetRequestMsg, 'Enter your email address.', true); return; }
      setResetMsg(els.resetRequestMsg, '', false);
      setBusy(els.resetRequestSubmit, true, 'Sending…');
      send('forgot-password', { email: email })
        .then(function () {
          // Advance to the code + new-password step (privacy: always).
          if (els.resetAddress) els.resetAddress.textContent = email;
          if (els.resetRequestForm) els.resetRequestForm.classList.add('hidden');
          if (els.resetEnterForm) els.resetEnterForm.classList.remove('hidden');
          if (els.resetResend) els.resetResend.classList.remove('hidden');
          try { els.resetCode.focus(); } catch (_) {}
        })
        .catch(function (err) {
          setResetMsg(els.resetRequestMsg, err.message || 'Could not send the code. Try again.', true);
        })
        .then(function () { setBusy(els.resetRequestSubmit, false, 'Send code'); });
    });
  }

  // Step 2 — verify the code + set the new password.
  if (els.resetEnterForm) {
    els.resetEnterForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = (els.resetEmail && els.resetEmail.value.trim().toLowerCase()) || '';
      var code = ((els.resetCode && els.resetCode.value) || '').replace(/\D/g, '');
      var password = (els.resetPassword && els.resetPassword.value) || '';
      var confirm = (els.resetConfirm && els.resetConfirm.value) || '';
      if (code.length !== 6) { setResetMsg(els.resetEnterMsg, 'Enter the 6-digit code from your email.', true); return; }
      if (password.length < 8) { setResetMsg(els.resetEnterMsg, 'Password must be at least 8 characters.', true); return; }
      if (password !== confirm) { setResetMsg(els.resetEnterMsg, 'Passwords do not match.', true); return; }
      setResetMsg(els.resetEnterMsg, '', false);
      setBusy(els.resetEnterSubmit, true, 'Updating…');
      send('reset-password', { email: email, code: code, password: password })
        .then(function () {
          // Done — back to the sign-in form with the email prefilled.
          resetMode = false;
          if (els.loginEmail) els.loginEmail.value = email;
          if (els.loginPassword) els.loginPassword.value = '';
          if (els.loginError) els.loginError.textContent = '';
          if (els.signupForm) els.signupForm.classList.add('hidden');
          if (els.loginForm) els.loginForm.classList.remove('hidden');
          setActiveView('auth');
          if (els.loginError) els.loginError.textContent = 'Password updated — sign in with your new password.';
          try { els.loginPassword.focus(); } catch (_) {}
        })
        .catch(function (err) {
          var msg = err.message || 'Could not reset your password.';
          if (err.code === 'RESET_CODE_WRONG' && err.payload && err.payload.attemptsLeft != null) {
            msg = 'Wrong code. ' + err.payload.attemptsLeft + ' tries left before you need a new one.';
          } else if (err.code === 'RESET_CODE_LOCKED') {
            msg = 'Too many wrong codes. Tap Resend to get a new one.';
          }
          setResetMsg(els.resetEnterMsg, msg, true);
        })
        .then(function () { setBusy(els.resetEnterSubmit, false, 'Update password'); });
    });
  }

  // Strip non-digits + auto-focus friendliness on the reset code field.
  if (els.resetCode) {
    els.resetCode.addEventListener('input', function (e) {
      var v = (e.target.value || '').replace(/\D/g, '').slice(0, 6);
      if (v !== e.target.value) e.target.value = v;
    });
  }

  if (els.resetResend) {
    els.resetResend.addEventListener('click', function () {
      var email = (els.resetEmail && els.resetEmail.value.trim().toLowerCase()) || '';
      if (!email) return;
      setBusy(els.resetResend, true, 'Sending…');
      send('forgot-password', { email: email })
        .then(function () { setResetMsg(els.resetEnterMsg, 'Sent — check your inbox (and spam).', false); })
        .catch(function (err) { setResetMsg(els.resetEnterMsg, err.message || 'Could not resend.', true); })
        .then(function () { setBusy(els.resetResend, false, 'Resend code'); });
    });
  }

  if (els.resetBack) {
    els.resetBack.addEventListener('click', function () { exitResetView(); });
  }

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
    // Email-verified-not-premium: tapping the orb fires
    // /api/user-session/start for the 2hr/day tier. Higher priority
    // than the guest chooser since a verified user has already made
    // the "sign up" choice. We intentionally don't gate on
    // !state.userSession here — startOrResume on the backend is
    // idempotent (rotates the sessionToken in place), so a stale
    // userSession in storage just gets re-issued cleanly rather than
    // falling through to /api/extension/proxy and surfacing
    // "Active subscription required."
    if (state.isAuthenticated && state.user && state.user.emailVerified === true &&
        !state.isPremium) {
      send('user-session-start').catch(function (err) {
        var msg = err.message || 'Could not start your session';
        if (err.code === 'USER_TIER_QUOTA_EXHAUSTED') {
          msg = "Today's 10 free minutes are gone. Resets at midnight UTC, or subscribe for unlimited.";
        } else if (err.code === 'EMAIL_NOT_VERIFIED') {
          msg = 'Verify your email first.';
        } else if (err.code === 'NO_TIER_SERVER' || err.code === 'NO_TIER_PROTOCOL') {
          msg = 'Email-tier server is busy — try again in a minute.';
        }
        if (els.statusError) {
          els.statusError.hidden = false;
          els.statusError.textContent = msg;
        }
      }).then(refresh);
      return;
    }
    // Guest-pending (intent set, no session yet) — show the tier
    // chooser. Picking "Free 20 min" inside the chooser calls
    // /api/guest/start.
    if (!state.isAuthenticated && state.guestModeIntent && !state.guestSession) {
      setActiveView('chooser');
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
      // Context-aware: signed-in users sign out; guest-mode users
      // exit guest mode (and tear down any live session) so they
      // can return to the auth screen and sign in / create account.
      if (!state) return;
      var inGuestMode = !state.isAuthenticated && (state.guestModeIntent || state.guestSession);
      if (inGuestMode) {
        var teardown = state.guestSession ? send('disconnect') : Promise.resolve();
        teardown
          .then(function () { return send('guest-mode-exit'); })
          .catch(function () {})
          .then(refresh);
      } else {
        send('logout').then(refresh);
      }
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
    if (msg && msg.type === 'state-changed') {
      if (renderLocked) return; // suppress mid-chain flicker
      refresh();
    }
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
