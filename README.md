# SecurePaid VPN — Browser Extension

Chrome and Firefox extension that signs in with the same account as the
mobile app / web dashboard and routes the **browser's** traffic through a
SecurePaid VPN exit node.

> ⚠️ A browser extension cannot establish an OS-level VPN tunnel
> (WireGuard, OpenVPN, IKEv2). The only thing a browser sandbox can do is
> point itself at a SOCKS5 / HTTPS **proxy**. So the extension talks to a
> proxy daemon that lives on the same VPS as the existing VPN protocols
> and authenticates with the same per-user `vpnUsername` / `vpnPassword`.
> Outside-the-browser apps still use the mobile app's full-tunnel VPN.

## What's in the box

| Path | Purpose |
| --- | --- |
| `src/manifest.base.json` | Shared MV3 manifest (name, action, permissions, icons) |
| `src/manifest.chrome.json` | Chrome-specific overrides (service worker, `webRequestAuthProvider`) |
| `src/manifest.firefox.json` | Firefox-specific overrides (background scripts array, gecko id) |
| `src/background.js` | Auth, server list cache, proxy apply/clear, premium re-check alarm |
| `src/lib/browser.js` | Tiny `chrome` ↔ `browser` shim |
| `src/lib/storage.js` | Typed accessors over `storage.local` |
| `src/lib/api.js` | Backend client — same endpoints as the mobile app |
| `src/lib/proxy.js` | `chrome.proxy.settings` + `webRequest.onAuthRequired` for SOCKS5 user/pass |
| `src/popup.html / .css / .js` | Login + server list + Connect pill |
| `src/options.html / .css / .js` | Account, billing, preferences, advanced |
| `tools/make-icons.mjs` | Generates 16/32/48/128 PNG icons from raw pixels (no deps) |
| `tools/build.mjs` | Emits `dist/chrome/` and `dist/firefox/` |
| `tools/zip.mjs` | Packages each target as `dist/secure-paid-vpn-<target>.zip` |

The extension talks **only** to the existing backend at
`https://securepaidvpn.com` (or whatever you set `apiBase` to in
Settings → Advanced for self-host / dev).

## Build & install

```bash
# from this folder
node tools/build.mjs              # → dist/chrome/  + dist/firefox/
# or
npm run build:chrome              # one target only
npm run package                   # build + zip
```

### Load in Chrome / Edge / Brave

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → pick `dist/chrome/`

### Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`

For permanent install, sign the zip via AMO ([web-ext sign](https://extensionworkshop.com/documentation/publish/distribute-sideloading/)).

## How it works

```
┌────────────┐  /api/auth/login        ┌────────────────┐
│ popup.html │ ─────────────────────▶  │  VpnBackend    │
│            │  /api/extension/servers │  (Express)     │
│ background │ ─────────────────────▶  │                │
│  service   │  /api/extension/proxy/* │                │
│  worker    │ ─────────────────────▶  └─────┬──────────┘
└─────┬──────┘                                │
      │ chrome.proxy.settings.set             │ Mongo:
      ▼                                       │ User.vpnUsername / vpnPassword
┌──────────────┐  SOCKS5 user/pass     ┌──────▼──────┐
│ Browser net  │ ────────────────────▶ │ Poland VPS  │
│ stack        │                       │ socks daemon│
└──────────────┘                       │ + IKEv2/WG  │
                                       └─────────────┘
```

1. Popup hands credentials to `background.js`, which calls
   `POST /api/auth/login` and stashes the JWT in `storage.local`.
2. `background.js` polls `GET /api/auth/me` on alarm (every 15 min) to
   keep `isPremium` fresh. If the subscription expires while connected,
   the proxy is torn down automatically.
3. When the user taps Connect, background calls
   `POST /api/extension/proxy/:serverId` → backend issues the SOCKS5
   descriptor (host = exit-node IP, port = 1080, user/pass = the same
   stable per-user `vpnUsername` / `vpnPassword` the strongSwan box
   already accepts).
4. Background calls `chrome.proxy.settings.set({ ... fixed_servers ... })`
   to point the browser at the proxy, and registers a
   `webRequest.onAuthRequired` listener that hands the username / password
   to the browser when the proxy challenges.
5. On disconnect (or sign-out, subscription expiry, browser shutdown) the
   proxy settings are cleared with `chrome.proxy.settings.clear`.

## What this needs on the backend

A new endpoint has been added to `VpnBackend`:

```
POST /api/extension/proxy/:serverId
GET  /api/extension/servers
```

— see [`VpnBackend/src/controllers/api/extensionController.js`](../VpnBackend/src/controllers/api/extensionController.js)
and the route additions in [`VpnBackend/src/routes/api.js`](../VpnBackend/src/routes/api.js).

The endpoint reuses `isUserPremium`, `getOrCreateVpnCredentials` and the
`Device` model exactly the same way `serverController.issueConfig` does
for the mobile app, so:

- Subscription gating is identical (HTTP 402 with `code: SUBSCRIPTION_REQUIRED`).
- Credentials are the same per-user pair the `vpn-secrets-agent` already
  syncs to `/etc/ipsec.secrets` on each strongSwan box. That means the
  on-box agent only needs to be extended (not replaced) to also write
  the credential pair into the SOCKS5 daemon's user database.
- The concurrent-device-limit (`env.deviceLimit`) applies to the browser
  install too — the extension passes a stable `deviceUuid` (`ext-<uuid>`)
  and `platform: 'browser'`. (`Device.platform` enum has been extended
  with `'browser'`.)

Env tunables (all optional):

| Var | Default | Purpose |
| --- | --- | --- |
| `EXTENSION_PROXY_TYPE` | `socks5` | `socks5` or `https` — what proxy daemon you put on the box |
| `EXTENSION_PROXY_PORT` | `1080` | TCP port the daemon listens on |

## What this needs on the VPN exit node

A SOCKS5 daemon listening on the chosen port, authenticating against the
same per-user creds the strongSwan box already holds. Easiest option is
`dante-server`:

### 1. Install dante on the Poland VPS

```bash
ssh poland
sudo apt update
sudo apt install -y dante-server
```

### 2. Drop in a config

`/etc/danted.conf`:

```conf
logoutput: /var/log/danted.log
internal: ens3 port = 1080
external: ens3
socksmethod: username
user.privileged: root
user.unprivileged: nobody

client pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    log: connect disconnect error
}

socks pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    socksmethod: username
    log: connect disconnect error
}
```

### 3. Open port 1080 in iptables (the box uses raw iptables, not ufw)

```bash
sudo iptables -A INPUT -p tcp --dport 1080 -j ACCEPT
sudo netfilter-persistent save
```

### 4. Sync credentials

dante uses PAM for user auth, which means the SOCKS user list is the same
as `/etc/passwd`. The simplest way to reuse `User.vpnUsername` /
`vpnPassword` is to extend the existing `vpn-secrets-agent` (see
`VpnBackend/tools/vpn-secrets-agent`) so that on each pull it also:

- Creates / updates a Linux user matching `vpnUsername` (with `nologin`
  shell, no home dir).
- Sets that user's PAM password to `vpnPassword`.

Pseudocode:

```bash
useradd --no-create-home --shell /usr/sbin/nologin <vpnUsername> 2>/dev/null
echo "<vpnUsername>:<vpnPassword>" | chpasswd
```

When a user's subscription expires, `Subscription.isActive` flips false →
the agent's filter excludes them on the next pull → it deletes the Linux
user, which evicts them from both strongSwan **and** SOCKS5 in one shot.

### 5. Start the daemon

```bash
sudo systemctl enable --now danted
sudo systemctl status danted
```

### Alternative: 3proxy

If you'd rather not touch system users, `3proxy` reads its own user file
and the agent can write that file directly. The on-extension wire format
doesn't change.

## Configuration (extension side)

Open the extension's options page (right-click the toolbar icon → Options,
or click the gear icon in the popup). Available knobs:

- **API base URL** — defaults to `https://securepaidvpn.com`. Change
  to `http://<lan-host>:2000` for local dev against `npm run dev` in
  `VpnBackend`.
- **Show desktop notifications** — connect / disconnect toasts.
- **Reconnect on browser startup** — re-applies the proxy when the
  background service worker boots.

## Permissions explained

| Permission | Why |
| --- | --- |
| `storage` | JWT, settings, server list cache, selected server, connection state |
| `proxy` | Set / clear `chrome.proxy.settings` |
| `alarms` | 15-minute premium re-check |
| `webRequest` | Listen for `onAuthRequired` to answer SOCKS5 user/pass challenge |
| `webRequestAuthProvider` (Chrome only) | Allows blocking response from `onAuthRequired` in MV3 without `webRequestBlocking` |
| `webRequestBlocking` (Firefox only) | FF's MV3 still uses this for blocking listeners |
| `notifications` | Connect / disconnect toasts (gated by user preference) |
| `<all_urls>` host permission | Required for the proxy to handle any tab the user opens |

## Privacy

- Auth token stays in `storage.local`. It's namespaced to the extension
  ID and not accessible to web pages.
- The extension sends **zero** browsing data to our backend. The proxy
  flow is exactly the same as if the user typed credentials into a
  browser proxy dialog manually.
- No analytics SDK is included. (The mobile app uses Firebase + Meta SDKs
  for ad attribution — not relevant for browser extensions, and
  Mozilla's add-on policy is allergic to them.)

## Updating

Bump `version` in `src/manifest.base.json`, then:

```bash
npm run build
npm run package        # produces dist/secure-paid-vpn-{chrome,firefox}.zip
```

Upload the chrome zip to the Chrome Web Store dashboard and the firefox
zip to AMO (or self-host signed builds via `web-ext sign`).
# Secure-Paid-VPN-Extension
