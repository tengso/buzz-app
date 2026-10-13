// @vitest-environment jsdom
import type { Event, EventTemplate } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import {
  answerSignRequests,
  challengeTemplate,
  missionControlUrl,
  parseSignRequest,
} from "./signing";

const challenge = "ab".repeat(32);
const request = {
  type: "mission-control/sign",
  id: "4f1c2d3e-0000-4000-8000-000000000001",
  challenge,
  purpose: "login",
};

describe("Mission Control signing", () => {
  it("resolves the dashboard beside the app, at the root or behind a gateway prefix", () => {
    expect(missionControlUrl("http://127.0.0.1:3102/")).toBe(
      "http://127.0.0.1:3102/dashboard/",
    );
    expect(
      missionControlUrl(
        "https://gw.example/HaiChat/hti_research_team/#buzz=%7B%7D",
      ),
    ).toBe("https://gw.example/HaiChat/hti_research_team/dashboard/");
  });

  it("accepts only a well-formed challenge request", () => {
    expect(parseSignRequest(request)).toEqual({
      id: request.id,
      challenge,
      purpose: "login",
    });
    for (const change of [
      { type: "other" },
      { challenge: "not-hex" },
      { challenge: challenge.toUpperCase() },
      { purpose: "publish" },
      { id: "x".repeat(65) },
      { id: "<script>" },
    ])
      expect(parseSignRequest({ ...request, ...change })).toBeNull();
    expect(parseSignRequest("text")).toBeNull();
    expect(parseSignRequest(null)).toBeNull();
  });

  it("signs a fixed Mission Control template, never caller-supplied content", () => {
    const parsed = parseSignRequest({
      ...request,
      purpose: "reveal",
      kind: 1,
      content: "post this",
      tags: [["p", "x"]],
    });
    if (!parsed) throw new Error("request rejected");
    expect(challengeTemplate(parsed, 1_800_000_000)).toEqual({
      kind: 27235,
      created_at: 1_800_000_000,
      tags: [
        ["u", "mission-control"],
        ["method", "POST"],
        ["challenge", challenge],
      ],
      content: "Reveal a Mission Control secret",
    });
  });

  it("answers its own frame only, and reports signer failures", async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const stranger = { postMessage: vi.fn() } as unknown as Window;
    const sign = vi.fn(
      async (template: EventTemplate) =>
        ({ ...template, id: "e", pubkey: "p", sig: "s" }) as Event,
    );
    const stop = answerSignRequests(() => frame, sign);
    const send = (data: unknown, source: Window, origin = location.origin) =>
      window.dispatchEvent(
        new MessageEvent("message", { data, source, origin }),
      );

    send(request, stranger);
    send(request, frame, "https://evil.example");
    send({ ...request, challenge: "zz" }, frame);
    send(request, frame);
    await vi.waitFor(() => expect(frame.postMessage).toHaveBeenCalledTimes(1));
    expect(sign).toHaveBeenCalledTimes(1);
    expect(stranger.postMessage).not.toHaveBeenCalled();
    const [reply, target] = vi.mocked(frame.postMessage).mock.calls[0] ?? [];
    expect(target).toBe(location.origin);
    expect(reply).toMatchObject({
      type: "mission-control/signed",
      id: request.id,
      event: { kind: 27235, sig: "s" },
    });

    sign.mockRejectedValueOnce(new Error("Unlock your key first."));
    send({ ...request, id: "second" }, frame);
    await vi.waitFor(() => expect(frame.postMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(frame.postMessage).mock.calls[1]?.[0]).toEqual({
      type: "mission-control/signed",
      id: "second",
      error: "Unlock your key first.",
    });

    stop();
    send({ ...request, id: "after-stop" }, frame);
    expect(sign).toHaveBeenCalledTimes(2);
  });
});
