import type { Event, EventTemplate } from "nostr-tools";

/** Reads go to Keel's Gateway as the viewer, authorized by a NIP-98 event the viewer's
 * key signs (or a Keel token when a build cannot sign); writes never go here — a decision
 * is a signed chat reply Keel follows (design 14). */
export type KeelSettings = Readonly<{
  /** Gateway base URL; same-origin `/keel` by default, so the web host's CSP allows it. */
  gateway: string;
  /** Optional workbench origin, so its `/t/<id>` and `/o/<type>/<pk>` links open here. */
  workbench: string;
  /** Optional Keel token for hosts that cannot sign; the signed path is preferred. */
  token: string;
}>;

const STORAGE_KEY = "buzz.keel.settings";
const listeners = new Set<() => void>();
let cached: KeelSettings | undefined;

export const defaultSettings = (): KeelSettings => ({
  gateway: new URL("keel/", new URL(".", location.href)).href.replace(
    /\/$/,
    "",
  ),
  workbench: "",
  token: "",
});

export function keelSettings(): KeelSettings {
  if (cached) return cached;
  let stored: Partial<KeelSettings> = {};
  try {
    stored = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    ) as Partial<KeelSettings>;
  } catch {
    /* an unreadable preference is the default */
  }
  cached = {
    ...defaultSettings(),
    ...Object.fromEntries(
      Object.entries(stored).filter(([, v]) => typeof v === "string"),
    ),
  };
  return cached;
}

export function saveKeelSettings(next: KeelSettings) {
  cached = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

export function subscribeKeelSettings(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type Signer = (template: EventTemplate) => Promise<Event>;

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** NIP-98: the request URL and method, signed just now, as `Authorization: Nostr <base64 event>`. */
export async function nip98(
  sign: Signer,
  url: string,
  method: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const event = await sign({
    kind: 27235,
    created_at: now,
    tags: [
      ["u", url],
      ["method", method],
    ],
    content: "",
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

const explain: Record<number, string> = {
  401: "Keel does not know this key. Ask an admin to link it (osym member link).",
  403: "Keel's policy does not allow this for you.",
  404: "Not found, or hidden from you by policy.",
};

export async function keelFetch<T>(
  path: string,
  options: {
    sign?: Signer | undefined;
    signal?: AbortSignal | undefined;
    settings?: KeelSettings;
  } = {},
): Promise<T> {
  const settings = options.settings ?? keelSettings();
  const url = `${settings.gateway.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
  else if (options.sign)
    headers.Authorization = await nip98(options.sign, url, "GET");
  const response = await fetch(url, {
    headers,
    signal: options.signal ?? null,
    credentials: "omit",
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = String((await response.json()).error ?? "");
    } catch {
      /* no JSON body */
    }
    throw new GatewayError(
      response.status,
      explain[response.status] ?? detail ?? `Keel answered ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

/** The reply Keel reads as a decision (design 14 §3): `<verb> <task id> [choice] [reason]`. */
export function decisionText(
  verb: "approve" | "reject" | "accept" | "pick",
  taskId: string,
  reason: string,
  choice?: string,
) {
  return [verb, taskId, choice, reason.trim()].filter(Boolean).join(" ");
}

export type KeelTask = {
  id: string;
  type: string;
  title: string;
  state: string;
  assignee: string;
  claimed_by?: string | null;
  due_at?: string | null;
  created_by?: string;
  version: number;
  subject: Record<string, unknown> & {
    object_type?: string;
    pk?: string;
    property?: string;
    proposal?: string;
    proposals?: string[];
    action?: string;
    action_type?: string;
    params?: Record<string, unknown>;
    quorum?: number;
  };
  resolution?: Record<string, unknown> | null;
  /** Where Keel posted it: the chat channel and thread a decision reply belongs in. */
  post?: {
    channel: string;
    chat_channel?: string | null;
    thread?: string | null;
    message_id?: string | null;
  } | null;
};

export type KeelProposal = {
  id: string;
  property: string;
  value: unknown;
  confidence?: number | null;
  state: string;
  producer?: { kind?: string; name?: string; version?: string } | null;
  evidence?: {
    source?: { document?: string; page?: number; excerpt?: string } | null;
  } | null;
};

export type KeelObject = {
  object: Record<string, unknown> & { _version: number };
  evidence?: {
    property: string;
    kind: string;
    evidence: Record<string, unknown>;
  }[];
  proposals?: KeelProposal[];
  findings?: { id: string; rule: string; severity: string; message: string }[];
  context?: { masked?: string[] };
};

export type KeelConversation = {
  adapter: string;
  pubkey?: string | null;
  channels: Record<string, string>;
};
