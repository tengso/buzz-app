import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const sidebarWidth = (sidebar) =>
  sidebar.evaluate((element) =>
    Math.round(
      element
        .closest(".shell-sidebar, .shell-sidebar-default")
        .getBoundingClientRect().width,
    ),
  );

// Framed pages (Mission Control, sidebar apps) receive pointer events of their
// own document; only a real browser shows whether the drag keeps tracking.
test("dragging the sidebar edge across a framed page keeps resizing", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  const handle = page.getByRole("separator", {
    name: "Resize channel sidebar",
    exact: true,
  });
  await handle.press("Home");
  await expect.poll(() => sidebarWidth(sidebar)).toBe(220);
  const box = await handle.boundingBox();
  if (!box) throw new Error("resize handle not laid out");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // A frame filling the page right of the sidebar edge, like an app page.
  await page.evaluate((left) => {
    const frame = document.createElement("iframe");
    frame.title = "Framed app";
    frame.srcdoc = "<p>framed</p>";
    frame.style.cssText = `position:fixed;top:0;bottom:0;left:${left}px;right:0;width:auto;height:100vh;border:0;z-index:2147483647`;
    document.body.append(frame);
  }, box.x + box.width);
  await expect(
    page.frameLocator('iframe[title="Framed app"]').getByText("framed"),
  ).toBeVisible();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 10 });
  await page.mouse.move(x + 200, y, { steps: 10 });
  await expect.poll(() => sidebarWidth(sidebar)).toBe(420);
  await page.mouse.up();
  // The release over the frame ended the drag: later movement changes nothing.
  await page.mouse.move(x + 260, y, { steps: 5 });
  await expect.poll(() => sidebarWidth(sidebar)).toBe(420);
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-sidebar-resizing",
    "true",
  );
});
