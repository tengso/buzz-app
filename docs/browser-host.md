# Browser host

The browser host runs the shared Buzz UI as a static site that talks directly to a
standard [block/buzz](https://github.com/block/buzz) relay. There is no extra
backend: the relay serves the WebSocket, `/query`, `/count`, `/events`, `/upload`
and `/media/`. The browser signs either with a NIP-07 extension (Alby, nos2x) or
with the user's key held encrypted on the device (see [Sign-in methods](#sign-in-methods)).

This is separate from `just web`, which uses the development broker in
[`browser-host/`](../browser-host/README.md).

## How it works

- Build-time host selection: `BUZZ_HOST=browser` (exposed as
  `import.meta.env.VITE_BUZZ_HOST`). Without it, builds behave as before.
- Identity ([`identity/browser.ts`](../src/features/identity/browser.ts)): a NIP-07
  extension or a local NIP-49 key
  ([`identity/local-key.ts`](../src/features/identity/local-key.ts)). Every
  signature is verified and must come from the active viewer.
- Private records ([`relay/browser-private.ts`](../src/features/relay/browser-private.ts)):
  saved groups, stars, mutes and sort order, read state and private channel
  recipes are NIP-44 encrypted to the viewer's own key, with the same
  coordinates, tags and size limits as the desktop host. This needs the local key,
  or an extension that implements `window.nostr.nip44`.
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
2 NIP-42) plus one per message, across about 8–10 event kinds. With an extension,
each may prompt: nos2x can only remember approvals per event kind, Alby offers
"Don't ask again for any nostr requests". The local key never prompts.

## Sign-in methods

The first visit offers two choices; the choice is remembered in this browser.

- **Use my key on this device.** Paste an `nsec` (Buzz desktop: Settings →
  Profile → Reveal private key); Buzz shows the matching `npub`. Choose a
  passphrase (8+ characters). Only the NIP-49 `ncryptsec` is saved, in
  `localStorage`. The passphrase is asked once per browser; after that all
  signing and NIP-44 encryption happen in the page without prompts.
  - The unlock lasts across reloads, tabs and browser restarts: the key is kept
    in `localStorage` encrypted with a non-extractable AES-GCM key held in
    IndexedDB. That keeps the raw key out of storage files, but any script in
    the page can still unwrap it. Signing out removes both.
  - Settings → Sign out locks the key; signing out with "remove data" forgets it.
    The unlock screen also has **Forget key on this device**.
  - Trade-off: while unlocked, the key is usable by the page's JavaScript. Any
    script running in the page (an injection bug, a malicious extension) could
    read it, which an extension's separate process prevents. Serve the app with the
    Content-Security-Policy from the nginx configs below, and prefer this mode on
    private deployments such as the loopback setup.
- **Use a signer extension (NIP-07).** Buzz never sees the key. Saved groups,
  stars and "Me" work only if the extension implements NIP-44.

## Deploy

The app must be served on the relay's own origin. That origin is HTTPS for a
reachable relay. Plain HTTP works only on `127.0.0.1` / `localhost`, for a relay
reached through an SSH tunnel; see
[Loopback relay over an SSH tunnel](#loopback-relay-over-an-ssh-tunnel-team-builder).

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
pnpm exec vite build --outDir dist-web --emptyOutDir
sudo mkdir -p /srv/buzz-web && sudo cp -r dist-web/* /srv/buzz-web/
```

`BUZZ_RELAY_URL` is validated at build time. Builds do not add it as a community
automatically (`BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` applies to `just web`
only), so each user adds the community once after signing in.

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

1. Open `https://buzz.example.com` and pick a [sign-in method](#sign-in-methods)
   for an account that is a member of the community. With the extension method
   and no extension installed, the app shows "Install a Nostr signer extension
   (NIP-07), such as Alby or nos2x, then retry."
3. Click **+** in the community rail, enter `wss://buzz.example.com`, then
   **Continue**. Enter an invite code if the relay requires one, and publish a
   profile.

## Loopback relay over an SSH tunnel (team-builder)

[team-builder](https://github.com/tengso/triflection-team-builder) only accepts
`http://` advertised URLs, so its relay runs with `RELAY_URL=ws://<advertised
host:port>`. The relay derives the expected NIP-42 `relay` tag (`ws://…`) and NIP-98
`u` tag (`http://…`) from that URL. The browser host therefore accepts `ws://` and
`http://` communities, and their `/media/` URLs, when the host is `127.0.0.1`,
`localhost` or `[::1]`. It signs them with the same scheme. Plain HTTP to any other
host is rejected.

The browser must open exactly the advertised URL. Example: a relay created with
`team-builder init --advertised-url http://127.0.0.1:3102 --bind 127.0.0.1 --port 3100 …`:

```text
workstation browser http://127.0.0.1:3102
   │ ssh -L 127.0.0.1:3102:127.0.0.1:3180
   ▼
server nginx 127.0.0.1:3180   (app + same-origin proxy)
   ▼
relay 127.0.0.1:3100          (team-builder --bind/--port)
```

1. Build on the server with `BUZZ_RELAY_URL=ws://127.0.0.1:3102` (the advertised
   URL with `ws://`) and copy `dist-web/*` to `/srv/buzz-web/`.
2. Install [`browser-host.loopback.nginx.conf`](browser-host.loopback.nginx.conf).
   Set `proxy_pass` to the relay's `--bind:--port`. Keep
   `proxy_set_header Host $http_host`; `$host` drops the port and the relay
   rejects the request.
3. On the workstation, forward the advertised port to nginx, not to the relay:
   `ssh -N -L 127.0.0.1:3102:127.0.0.1:3180 user@server`. The desktop app keeps
   working through the same tunnel.
4. Check from the workstation:

   ```bash
   curl -s -H 'Accept: application/nostr+json' http://127.0.0.1:3102/ | head -c 200  # relay JSON
   curl -s http://127.0.0.1:3102/ | head -c 100                                     # <!doctype html>
   ```

5. Open `http://127.0.0.1:3102` (not `localhost`), then add the community
   `http://127.0.0.1:3102` with **+**.

## Limitations

- Saved groups, stars and "Me" placement need the local key or an extension with
  NIP-44 support.
- The Content-Security-Policy allows images and media only from the relay's
  origin, `data:` and `blob:`; profile pictures hosted elsewhere don't load. To
  allow them, add `https:` to `img-src` (this also lets an injected script leak
  data through image URLs).
- Desktop-only features (local agents, terminal, plugins, Git, pairing) are not
  available.
- Channel members → Refresh may show "Archived identities could not be checked"
  on a community that has never archived anyone: the relay publishes the kind
  13535 snapshot only after an archive change.
- Only tested with a NIP-07 test signer, not with Alby or nos2x.
