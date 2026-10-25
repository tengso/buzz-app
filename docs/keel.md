# Keel: the record behind the conversation

[Keel](https://github.com/tengso/keel) holds the governed record — objects with evidence,
proposals, tasks, approvals and audit. Buzz is where people and agents talk about it. The
bundled **Keel** plugin (`src/bundled/keel/`) joins the two the way Keel's design 14
describes: **reads** go to Keel's Gateway as the viewer; **decisions** are signed chat
replies that Keel verifies and applies. Nothing is written to Keel over HTTP from this app,
and no Keel credential is needed on a host that can sign.

## What it does

- **Panel.** A `keel://task/<id>` or `keel://<type>/<pk>` link in a message (what Keel's
  hand-off posts carry), or a workbench `/t/<id>` · `/o/<type>/<pk>` link once the
  workbench URL is set, opens the record beside the conversation: the task with its
  candidates and their evidence excerpts, or the object with its fields, provenance kind
  per field, open proposals and findings. Masked fields show as hidden; Keel decides that
  per viewer.
- **Deciding.** On an open `approve-action`, `confirm-proposal` or `resolve-conflict` task
  the panel offers Approve/Reject, Accept/Reject or Pick n/Reject with a reason. Pressing
  one sends an ordinary kind-9 reply in the current thread (or the thread Keel posted the
  task in): `approve task-84450d5a33 looks right`. The reply mentions Keel's own key when
  the Gateway reports one. Keel's follower (`osym intents follow`) verifies the signature,
  maps your key to your Keel subject, checks policy and applies it — an agent's key is
  refused for decisions there. Other task types are decided in the workbench.
- **Page.** **Keel** in the sidebar lists the open tasks waiting on you or your groups,
  shows one, lets you decide from there when Keel has posted it, and opens its thread.
- **Settings → Keel.** Gateway URL (default: same-origin `/keel`), optional workbench URL,
  and an optional Keel token for hosts that cannot sign. **Check connection** reads your
  inbox with the current values.

## Reads as the viewer

On the web host each read carries a NIP-98 `Authorization: Nostr …` event — kind 27235
with the request URL and method — signed with the viewer's key (local key or NIP-07
signer, as for Mission Control). Keel maps the key to a subject through its member links
(`osym member link <subject> <npub> -g <group>`); an unlinked key gets 401 and the panel
says so. The native app cannot sign reads yet; there, paste a token from
`osym token create` in Settings → Keel.

## Deployment

Browser host: proxy Keel's Gateway under the app's origin (`location /keel/` in
[`browser-host.gateway.nginx.conf`](browser-host.gateway.nginx.conf)); the app's
`connect-src 'self'` then covers it. Native app: the Tauri CSP allows `https:` and
loopback `http:` for the Gateway URL you configure. Run `osym intents follow` beside Keel
so replies are applied; its filters follow Keel's own recent posts and mentions of its key.

## Not yet

Composer forms generated from Keel's action schemas (`propose`, `submit-action` from the
composer), structured kind-1391 intents from the outbox, and the Keel workbench as a page.
