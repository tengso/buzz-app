import type { Event, EventTemplate } from "nostr-tools";

/** team-builder's Mission Control, proxied by the web host's nginx beside the app. */
export const missionControlUrl = (href = location.href) =>
  new URL("dashboard/", new URL(".", href)).href;

type Purpose = "login" | "reveal";
export type SignRequest = Readonly<{
  id: string;
  challenge: string;
  purpose: Purpose;
}>;

const CONTENT: Record<Purpose, string> = {
  login: "Sign in to Mission Control",
  reveal: "Reveal a Mission Control secret",
};

/** Mission Control only names a single-use challenge; anything else is ignored. */
export function parseSignRequest(data: unknown): SignRequest | null {
  if (!data || typeof data !== "object") return null;
  const { type, id, challenge, purpose } = data as Record<string, unknown>;
  if (
    type !== "mission-control/sign" ||
    typeof id !== "string" ||
    !/^[A-Za-z0-9-]{1,64}$/.test(id) ||
    typeof challenge !== "string" ||
    !/^[0-9a-f]{64}$/.test(challenge) ||
    (purpose !== "login" && purpose !== "reveal")
  )
    return null;
  return { id, challenge, purpose };
}

/** The only event this page signs for Mission Control (verified there against the owner key). */
export function challengeTemplate(
  request: SignRequest,
  now = Math.floor(Date.now() / 1000),
): EventTemplate {
  return {
    kind: 27235,
    created_at: now,
    tags: [
      ["u", "mission-control"],
      ["method", "POST"],
      ["challenge", request.challenge],
    ],
    content: CONTENT[request.purpose],
  };
}

/** Answer signing requests from the embedded dashboard frame only; returns the cleanup. */
export function answerSignRequests(
  frame: () => Window | null | undefined,
  sign: (template: EventTemplate) => Promise<Event>,
  host: Window = window,
): () => void {
  const origin = host.location.origin;
  const listener = async (message: MessageEvent) => {
    const target = frame();
    if (!target || message.source !== target || message.origin !== origin)
      return;
    const request = parseSignRequest(message.data);
    if (!request) return;
    let reply: Record<string, unknown>;
    try {
      reply = { event: await sign(challengeTemplate(request)) };
    } catch (error) {
      reply = {
        error:
          error instanceof Error ? error.message : "Buzz could not sign in",
      };
    }
    target.postMessage(
      { type: "mission-control/signed", id: request.id, ...reply },
      origin,
    );
  };
  host.addEventListener("message", listener);
  return () => host.removeEventListener("message", listener);
}
