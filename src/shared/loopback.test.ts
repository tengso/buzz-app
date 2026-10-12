import { expect, it } from "vitest";
import { isSecureOrLoopbackUrl } from "./loopback";
import { safeMessageUrl } from "../features/relay/message-content";
import { avatarSource } from "./avatar-source";

it.each([
  ["https://cdn.example/a.png", true],
  ["http://127.0.0.1:3102/media/a.png", true],
  ["http://localhost/media/a.png", true],
  ["http://cdn.example/a.png", false],
  ["http://127.0.0.1.evil.example/a.png", false],
  ["ftp://127.0.0.1/a.png", false],
])("%s secure or loopback: %s", (url, expected) => {
  expect(isSecureOrLoopbackUrl(new URL(url))).toBe(expected);
});

it("keeps plain-http avatars only for loopback hosts", () => {
  expect(avatarSource("http://127.0.0.1:3102/media/a.png")).toBe(
    "http://127.0.0.1:3102/media/a.png",
  );
  expect(avatarSource("http://cdn.example/a.png")).toBeUndefined();
});

it("keeps plain-http message media only for loopback hosts", () => {
  expect(safeMessageUrl("http://127.0.0.1:3102/media/a.png")).toBe(
    "http://127.0.0.1:3102/media/a.png",
  );
  expect(safeMessageUrl("http://cdn.example/a.png")).toBeUndefined();
  expect(safeMessageUrl("https://cdn.example/a.png")).toBe(
    "https://cdn.example/a.png",
  );
});
