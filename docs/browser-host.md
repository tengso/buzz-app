# Browser host

The browser host runs the shared Buzz UI as a static site that talks directly to a
standard [block/buzz](https://github.com/block/buzz) relay. There is no extra
backend: the relay serves the WebSocket, `/query`, `/count`, `/events`, `/upload`
and `/media/`; the browser signs with a NIP-07 extension (Alby, nos2x) and never
sees a private key.

This is separate from `just web`, which uses the development broker in
[`browser-host/`](../browser-host/README.md).

## How it works

- Build-time host selection: `BUZZ_HOST=browser` (exposed as
  `import.meta.env.VITE_BUZZ_HOST`). Without it, builds behave as before.
- Identity: `window.nostr.getPublicKey()` / `signEvent()`
  ([`identity/browser.ts`](../src/features/identity/browser.ts)). Every signature
  is verified and must come from the active viewer.
- Relay access ([`relay/browser.ts`](../src/features/relay/browser.ts)):
  - One WebSocket per community, logged in once with NIP-42. Plain reads, counts
    and publishes travel over it as `REQ`, `COUNT` and `EVENT`.
  - Queries that use HTTP-bridge extensions (`include_aux`, `top_level`,
    `include_summaries`, `consistency`, multi-letter tags such as
    `#buzz-channel`, presence kind 20001) fall back to NIP-98 signed HTTP.
  - Requests are same-origin only, with `credentials: "omit"` and
    `redirect: "error"`.
- Media: [`public/buzz-media-sw.js`](../public/buzz-media-sw.js) adds the relay's
  auth header to same-origin `/media/` requests so images and video load.

Signing cost with a standard relay: about 7 signatures per page load (5 NIP-98,
2 NIP-42) plus one per message. Configure the extension to always allow the
site, or each one prompts.

## Deploy

The app must be served on the relay's own HTTPS origin.

### 1. Relay

In the relay's `.env`, set `RELAY_URL` to the public address the browser uses,
e.g. `RELAY_URL=wss://buzz.example.com`, and restart it. NIP-42 login is checked
against this URL.

### 2. Build

```bash
git clone https://github.com/tengso/buzz-app.git && cd buzz-app
source bin/activate-hermit   # Node 24 and pnpm
pnpm install
BUZZ_HOST=browser \
BUZZ_RELAY_URL=wss://buzz.example.com \
BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1 \
pnpm exec vite build --outDir dist-web --emptyOutDir
sudo mkdir -p /srv/buzz-web && sudo cp -r dist-web/* /srv/buzz-web/
```

`BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1` adds the relay as the default
community on first launch.

### 3. nginx

`/` is both the app and the relay:

- WebSocket upgrades and NIP-11 requests (`Accept: application/nostr+json`) go to the relay.
- Other requests to `/` get `index.html`.
- Other paths are served from the build if the file exists, otherwise passed to the relay.

Copy [`browser-host.nginx.conf`](browser-host.nginx.conf), replace the domain,
certificate paths, web root and relay address, then:

```bash
sudo cp docs/browser-host.nginx.conf /etc/nginx/sites-available/buzz
sudo ln -s /etc/nginx/sites-available/buzz /etc/nginx/sites-enabled/buzz
sudo nginx -t && sudo systemctl reload nginx
```

Check both sides of `/`:

```bash
curl -s -H 'Accept: application/nostr+json' https://buzz.example.com/ | head -c 200  # relay JSON
curl -s https://buzz.example.com/ | head -c 100                                     # <!doctype html>
```

If the first returns HTML, the app fails with
`Unexpected token '<' ... is not valid JSON`.

### 4. Sign in

1. Install a NIP-07 extension and import the key of an account that is a member
   of the community.
2. Open `https://buzz.example.com`. Without an extension the app shows
   "Install a Nostr signer extension (NIP-07), such as Alby or nos2x, then retry."

## Limitations

- Saved groups and stars and "Me" placement need NIP-44 encryption, which the
  browser host does not implement yet.
- Desktop-only features (local agents, terminal, plugins, Git, pairing) are not
  available.
- Channel members → Refresh may show "Archived identities could not be checked"
  on a community that has never archived anyone: the relay publishes the kind
  13535 snapshot only after an archive change.
- Only tested with a NIP-07 test signer, not with Alby or nos2x.
