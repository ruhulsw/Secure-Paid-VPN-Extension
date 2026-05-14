# SecurePaid VPN — Browser Extension

Chrome, Edge, and Firefox extension that signs in with your
SecurePaid VPN account and routes the **browser's** traffic through
a TLS-encrypted HTTPS proxy on the exit node you select. Your operating system's
network stack and other applications are not affected — only browser
traffic flows through the tunnel.

A subscription is required (Weekly, Monthly, or Yearly). The same
account works on the mobile app, the website, and this extension.

- 🌐 Marketing site / sign-up: <https://securepaidvpn.com>
- 🔒 Privacy policy: <https://securepaidvpn.com/privacy>
- 📄 License: [MIT](LICENSE)

---

## Install

### Chrome / Brave

Once published in the Chrome Web Store, install with one click. To
test or build from source:

1. `node tools/build.mjs` to produce `dist/chrome/`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → pick the `dist/chrome/` folder

### Microsoft Edge

Once published in the Edge Add-ons store, install with one click.
To test from source:

1. `node tools/build.mjs edge` to produce `dist/edge/` (byte-identical
   to `dist/chrome/`; emitted to a separate folder so the Edge
   Add-ons store gets its own upload artifact)
2. Open `edge://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → pick the `dist/edge/` folder

### Firefox

Once published on AMO, install with one click. To test from source:

1. `node tools/build.mjs firefox` to produce `dist/firefox/`
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`

---

## How it works (high level)

```
┌──────────────┐                ┌────────────────────┐
│  Extension   │   sign-in      │ securepaidvpn.com  │
│ (popup + bg) │ ─────────────▶ │  (auth, server     │
│              │   server list  │   list, premium)   │
└──────┬───────┘                └────────────────────┘
       │ click Connect
       │ apply HTTPS proxy
       ▼
┌──────────────┐   TLS+Basic    ┌────────────────────┐
│  Browser     │ ─────────────▶ │  Exit node         │
│  net stack   │                │  (HTTPS proxy)     │
└──────────────┘                └────────────────────┘
                                          │
                                          ▼
                                       Internet
```

1. The popup signs you in via the same `/api/auth/*` endpoints the
   mobile app uses. The auth token is stored in `storage.local`.
2. Background polls `/api/auth/me` every 15 minutes to keep
   subscription state fresh. If your subscription expires, the proxy
   is torn down automatically.
3. When you click **Connect**, the extension fetches a per-user proxy
   descriptor (host, port, credentials), then configures the browser
   to route every HTTP/HTTPS request through that proxy over a
   TLS-wrapped connection.
4. On disconnect, sign-out, or subscription expiry, the proxy is
   cleared and traffic flows direct again.

---

## Permissions

| Permission | Why the extension needs it |
| --- | --- |
| `proxy` | Configure the browser's proxy settings to point at the chosen exit node. |
| `webRequest` | Answer the proxy's `407` authentication challenge with the credentials issued for the signed-in user (no UI prompt). |
| `webRequestAuthProvider` *(Chrome only)* | Lets a Manifest V3 listener answer `onAuthRequired` in blocking form. |
| `webRequestBlocking` *(Firefox only)* | Same purpose on Firefox. |
| `storage` | Auth token, settings, last-selected server, connection state — all browser-local, scoped to the extension. |
| `alarms` | The 15-minute subscription re-check. |
| `notifications` | Optional connect / disconnect desktop toasts. The popup's Settings page has an off-switch. |
| `<all_urls>` host permission | The proxy applies to every site the user chooses to visit. |

The extension contains no analytics SDKs and no remote-code-loading
mechanism (`eval`, `new Function`, dynamic `import`, `setTimeout` with a
string — none are used). Every script that runs is in the .zip.

---

## Privacy

- The extension never reads or transmits the URLs you visit. The
  browser routes proxy traffic internally; the extension code never
  sees per-request data.
- The exit-node proxies operate under a strict no-logs policy — no
  timestamps, source IPs, destination hosts, or bandwidth-per-session
  are written to disk.
- Full privacy policy: <https://securepaidvpn.com/privacy>

---

## Source layout

```
src/
  manifest.base.json     shared MV3 manifest
  manifest.chrome.json   Chromium overlay (used by Chrome AND Edge builds)
  manifest.firefox.json  Firefox-only overrides
  background.js          auth + connect/disconnect + alarm
  popup.html / .css / .js   sign-in + server list + Connect pill
  options.html / .css / .js account, settings, advanced
  lib/
    browser.js           cross-browser API shim
    storage.js           keyed wrappers over storage.local
    api.js               backend client
    proxy.js             apply / clear proxy + onAuthRequired listener
  icons/                 brand icons (regenerated via tools/make-icons.mjs)
tools/
  build.mjs              merges manifests + copies src to dist (no bundler)
  make-icons.mjs         resamples icons via sips/magick/convert
  zip.mjs                packages dist/<target>/ into a .zip for upload
```

The build is plain JavaScript — no transpiler, no bundler, no minifier.
Every file in `dist/<browser>/` is a 1:1 copy of the corresponding
`src/` file, except `manifest.json` which is the JSON-merge of
`manifest.base.json` + `manifest.<browser>.json`.

---

## Build, package, publish

```bash
node tools/build.mjs       # → dist/chrome/ + dist/firefox/ + dist/edge/
npm run build:chrome       # one target only
npm run build:edge         # ditto for Edge (Chromium overlay)
npm run build:firefox      # ditto for Firefox
npm run package            # build + zip all three
npm run icons              # regenerate icon PNGs from src/icons/source-logo.png
```

To cut a new release:

1. Bump `version` in `src/manifest.base.json`.
2. `npm run package` to produce `dist/secure-paid-vpn-{chrome,edge,firefox}.zip`.
3. Upload the Chrome zip to the Chrome Web Store dashboard.
4. Upload the Edge zip to <https://partner.microsoft.com/dashboard/microsoftedge/>.
5. Upload the Firefox zip to <https://addons.mozilla.org/developers/>
   (or sign for self-distribution via `web-ext sign`).

---

## Contributing

Issues and pull requests welcome. The extension is intentionally small
(no build pipeline, no framework, no dependencies) so that anyone can
audit it end-to-end from this repo to the published .zip.

## License

MIT — see [LICENSE](LICENSE).
