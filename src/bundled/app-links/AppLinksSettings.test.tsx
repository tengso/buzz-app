// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLinksSettings } from "./AppLinksSettings";
import type { AppLink } from "./model";
import type { AppLinks, AppLinksSnapshot } from "./store";

const admin: AppLink = {
  id: "a1",
  title: "Research Admin",
  url: "/HaiChat/admin/",
  trusted: false,
};

function renderCard(snapshot: Partial<AppLinksSnapshot>) {
  const state = {
    status: "ready",
    community: [admin],
    personal: [],
    owner: false,
    personalAvailable: true,
    ...snapshot,
  } as AppLinksSnapshot;
  const save = vi.fn(async () => {});
  const links = {
    snapshot: () => state,
    subscribe: () => () => {},
    refresh: vi.fn(),
    save,
  } as unknown as AppLinks;
  render(<AppLinksSettings links={links} active={() => true} />);
  return save;
}

afterEach(cleanup);

describe("Apps settings", () => {
  it("lets members read community apps and manage their own", async () => {
    const save = renderCard({ owner: false });
    expect(
      screen.getByText("Chosen by the community owner for everyone."),
    ).toBeTruthy();
    const community = screen.getByRole("list", { name: "Community apps" });
    expect(within(community).getByText("Research Admin")).toBeTruthy();
    expect(
      screen.queryByRole("form", { name: "Add to Community apps" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove Research Admin" }),
    ).toBeNull();

    const user = userEvent.setup();
    const form = screen.getByRole("form", { name: "Add to My apps" });
    await user.type(within(form).getByLabelText("Name"), "Risk");
    await user.type(
      within(form).getByLabelText("Address"),
      "https://evil.example/",
    );
    await user.click(within(form).getByRole("button", { name: "Add app" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Only addresses on/);
    expect(save).not.toHaveBeenCalled();

    await user.clear(within(form).getByLabelText("Address"));
    await user.type(within(form).getByLabelText("Address"), "/HaiChat/risk/");
    await user.click(within(form).getByRole("button", { name: "Add app" }));
    expect(save).toHaveBeenCalledWith("personal", [
      expect.objectContaining({
        title: "Risk",
        url: "/HaiChat/risk/",
        trusted: false,
      }),
    ]);
  });

  it("lets the owner reorder, trust and remove community apps", async () => {
    const second = { ...admin, id: "b2", title: "Risk" };
    const save = renderCard({ owner: true, community: [admin, second] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Move Risk up" }));
    expect(save).toHaveBeenLastCalledWith("community", [second, admin]);
    const row = within(screen.getByRole("list", { name: "Community apps" }))
      .getByText("Research Admin")
      .closest("li") as HTMLElement;
    await user.click(within(row).getByRole("checkbox", { name: "Trusted" }));
    expect(save).toHaveBeenLastCalledWith("community", [
      { ...admin, trusted: true },
      second,
    ]);
    await user.click(screen.getByRole("button", { name: "Remove Risk" }));
    expect(save).toHaveBeenLastCalledWith("community", [admin]);
  });

  it("explains when personal apps need a NIP-44 capable signer", () => {
    renderCard({ personalAvailable: false });
    expect(screen.getByText(/Needs your key on this device/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add to My apps" })).toBeNull();
  });
});
