/** A web app shown as its own page: a path on this site's origin. */
export type AppLink = Readonly<{
  id: string;
  title: string;
  /** Absolute path (with optional query and fragment) on the app's own origin. */
  url: string;
  /** Run without the iframe sandbox: same-origin access, including this page's storage. */
  trusted: boolean;
}>;

/** Community list: public, authored by the community owner. */
export const COMMUNITY_D = "buzz.app-links";
/** Personal list: NIP-44 encrypted to the viewer's own key. */
export const PERSONAL_D = "buzz.app-links.private";
export const MAX_LINKS = 20;
const MAX_TITLE = 40;
const ID = /^[a-z0-9]{1,16}$/;

/** Normalize to a path on `base`'s origin, or explain why the address is refused. */
export function appPath(input: string, base = location.href): string {
  let url: URL;
  try {
    url = new URL(input.trim(), base);
  } catch {
    throw new Error("Enter a path such as /HaiChat/my_app/ or a full address");
  }
  if (url.origin !== new URL(base).origin || !/^https?:$/.test(url.protocol))
    throw new Error(
      `Only addresses on ${new URL(base).host} are allowed; open other sites in their own tab`,
    );
  return `${url.pathname}${url.search}${url.hash}`;
}

export const newLinkId = () =>
  [...crypto.getRandomValues(new Uint8Array(6))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** Validate one link as typed in Settings; throws a user-facing message. */
export function validLink(link: AppLink, base = location.href): AppLink {
  const title = link.title.trim();
  if (!title || title.length > MAX_TITLE)
    throw new Error(`Give the app a name of 1–${MAX_TITLE} characters`);
  if (!ID.test(link.id)) throw new Error("Invalid app identifier");
  return Object.freeze({
    id: link.id,
    title,
    url: appPath(link.url, base),
    trusted: link.trusted === true,
  });
}

export function serializeLinks(
  links: readonly AppLink[],
  base = location.href,
) {
  if (links.length > MAX_LINKS)
    throw new Error(`A list holds at most ${MAX_LINKS} apps`);
  const valid = links.map((link) => validLink(link, base));
  if (new Set(valid.map((link) => link.id)).size !== valid.length)
    throw new Error("Duplicate app identifier");
  return JSON.stringify({ version: 1, links: valid });
}

/** Lenient read: drop entries this client cannot show instead of hiding the list. */
export function parseLinks(text: string, base = location.href): AppLink[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The saved app list is not valid");
  }
  const raw = (value as { version?: unknown; links?: unknown })?.links;
  if ((value as { version?: unknown })?.version !== 1 || !Array.isArray(raw))
    throw new Error("The saved app list is not valid");
  const links: AppLink[] = [];
  for (const entry of raw.slice(0, MAX_LINKS)) {
    const { id, title, url, trusted } = (entry ?? {}) as Record<
      string,
      unknown
    >;
    if (
      typeof id !== "string" ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      links.some((link) => link.id === id)
    )
      continue;
    try {
      links.push(
        validLink({ id, title, url, trusted: trusted === true }, base),
      );
    } catch {}
  }
  return links;
}
