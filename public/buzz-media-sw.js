// Buzz web: relay /media/ reads need a Blossom `get` authorization header,
// which <img>/<video> cannot send. This worker adds one, asking the page to
// sign a short-lived, server-scoped token through the NIP-07 extension.
let token;
let pending;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

async function askPage() {
  const pages = await self.clients.matchAll({ type: "window" });
  for (const page of pages) {
    try {
      const reply = await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error("timeout")), 60000);
        channel.port1.onmessage = (message) => {
          clearTimeout(timer);
          resolve(message.data);
        };
        page.postMessage({ type: "buzz-media-auth" }, [channel.port2]);
      });
      if (
        reply &&
        typeof reply.token === "string" &&
        reply.expiresAt > Date.now()
      )
        return reply;
    } catch {
      // Try the next page.
    }
  }
  throw new Error("No page could authorize media");
}

async function authorization() {
  if (token && token.expiresAt - 60000 > Date.now()) return token.token;
  pending ??= askPage().finally(() => {
    pending = undefined;
  });
  token = await pending;
  return token.token;
}

// Behind a path-prefixed proxy the worker's scope is the app's base path, and
// `?cookies=1` keeps the gateway's login cookie on media reads.
const mediaPath = new URL("media/", self.registration.scope).pathname;
const credentials =
  new URL(self.location.href).searchParams.get("cookies") === "1"
    ? "same-origin"
    : "omit";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(mediaPath) ||
    !["GET", "HEAD"].includes(event.request.method)
  )
    return;
  event.respondWith(
    (async () => {
      const headers = new Headers({ Authorization: await authorization() });
      const range = event.request.headers.get("range");
      if (range) headers.set("Range", range);
      return fetch(url.href, {
        method: event.request.method,
        headers,
        credentials,
        redirect: "error",
      });
    })(),
  );
});
