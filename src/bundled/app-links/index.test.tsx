// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PagesService } from "../../features/pages/service";
import { APP_SANDBOX, AppLinkPage } from "./AppLinkPage";
import { showAppPages } from "./index";
import type { AppLink } from "./model";
import type { AppLinks, AppLinksSnapshot } from "./store";

const admin: AppLink = {
  id: "a1",
  title: "Research Admin",
  url: "/HaiChat/admin/",
  trusted: false,
};
const risk: AppLink = {
  id: "b2",
  title: "Risk",
  url: "/HaiChat/risk/?x=1",
  trusted: true,
};

function fakeLinks() {
  let state = {
    status: "ready",
    community: [admin],
    personal: [],
    owner: false,
    personalAvailable: true,
  } as AppLinksSnapshot;
  const listeners = new Set<() => void>();
  const links = {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AppLinks;
  return {
    links,
    set(next: Partial<AppLinksSnapshot>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
}

describe("app link pages", () => {
  it("adds and removes one sidebar page per link as the lists change", async () => {
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const pages = new PagesService(root);
    const { links, set } = fakeLinks();
    const fiber = root
      .extend({ pluginOwner: { id: "buzz.app-links", revision: "1" } })
      .plugin((ctx: Context) => showAppPages(ctx, links));
    await fiber.await();
    const listed = () =>
      pages.snapshot().map((page) => [page.key, page.title, page.primary]);
    await expect
      .poll(listed)
      .toEqual([["buzz.app-links/app-c-a1", "Research Admin", true]]);
    set({ personal: [risk] });
    await expect.poll(listed).toEqual([
      ["buzz.app-links/app-c-a1", "Research Admin", true],
      ["buzz.app-links/app-p-b2", "Risk", true],
    ]);
    set({ community: [], personal: [] });
    await expect.poll(listed).toEqual([]);
    await fiber.dispose();
    await root.fiber.dispose();
  });

  it("sandboxes untrusted apps and frames trusted ones with full access", () => {
    const { unmount } = render(<AppLinkPage link={admin} />);
    const frame = screen.getByTitle("Research Admin");
    expect(frame.getAttribute("src")).toBe(`${location.origin}/HaiChat/admin/`);
    expect(frame.getAttribute("sandbox")).toBe(APP_SANDBOX);
    expect(APP_SANDBOX).not.toContain("allow-same-origin");
    unmount();
    render(<AppLinkPage link={risk} />);
    expect(screen.getByTitle("Risk").hasAttribute("sandbox")).toBe(false);
    expect(screen.getByTitle("Risk").getAttribute("src")).toBe(
      `${location.origin}/HaiChat/risk/?x=1`,
    );
  });
});
