// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MissionControlPage } from "./MissionControlPage";
import { missionControlUrl } from "./signing";

const violation = (effectiveDirective: string, blockedURI: string) =>
  Object.assign(new Event("securitypolicyviolation"), {
    effectiveDirective,
    blockedURI,
  });

describe("MissionControlPage", () => {
  it("frames the dashboard and explains a host policy that blocks it", () => {
    render(<MissionControlPage />);
    expect(screen.getByTitle("Mission Control").getAttribute("src")).toBe(
      missionControlUrl(),
    );
    act(() => {
      document.dispatchEvent(violation("img-src", missionControlUrl()));
      document.dispatchEvent(violation("frame-src", "https://other.example/"));
    });
    expect(screen.getByTitle("Mission Control")).toBeTruthy();
    act(() => {
      document.dispatchEvent(violation("frame-src", missionControlUrl()));
    });
    expect(screen.queryByTitle("Mission Control")).toBeNull();
    expect(screen.getByText("This server blocks Mission Control")).toBeTruthy();
    expect(screen.getByText(/frame-src 'self'/)).toBeTruthy();
  });
});
