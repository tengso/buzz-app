import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { brandDefines, loadBrand, rebrandHtml } from "./brand.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function brandDir(config, files = []) {
  const dir = mkdtempSync(join(tmpdir(), "buzz-brand-"));
  writeFileSync(join(dir, "brand.json"), JSON.stringify(config));
  for (const file of files) writeFileSync(join(dir, file), "x");
  return dir;
}

it("rebrands the page title, launch mark and icons", () => {
  const brand = loadBrand(
    brandDir({ name: "HTI <Research>", themeColor: "#123456" }, [
      "logo.png",
      "favicon.png",
      "apple-touch-icon.png",
    ]),
  );
  const out = rebrandHtml(html, brand, "./");
  expect(out).toContain("<title>HTI &lt;Research&gt;</title>");
  expect(out).toContain('aria-label="Opening HTI &lt;Research&gt;"');
  expect(out).toContain('content="#123456"');
  expect(out).toContain(
    '<link rel="icon" type="image/png" href="./brand/favicon.png" />',
  );
  expect(out).not.toContain("/favicon.ico");
  expect(out).toContain('href="./brand/apple-touch-icon.png"');
  expect(out).toContain(
    '<img src="./brand/logo.png" alt="HTI &lt;Research&gt;"',
  );
  expect(out).not.toContain("buzz-loading-mark.svg");
  expect(brandDefines(brand)).toEqual({
    "import.meta.env.VITE_BUZZ_BRAND_NAME": '"HTI <Research>"',
    "import.meta.env.VITE_BUZZ_BRAND_LOGO": '"brand/logo.png"',
    "import.meta.env.VITE_BUZZ_BRAND_LOADING": '"brand/logo.png"',
  });
});

it("keeps Buzz images when the brand only sets a name", () => {
  const brand = loadBrand(brandDir({ name: "Acme", title: "Acme Chat" }));
  const out = rebrandHtml(html, brand, "/");
  expect(out).toContain("<title>Acme Chat</title>");
  expect(out).toContain("/favicon.ico");
  expect(out).toContain("buzz-loading-mark.svg");
  expect(brandDefines(brand)["import.meta.env.VITE_BUZZ_BRAND_LOGO"]).toBe(
    '""',
  );
  expect(brandDefines(undefined)["import.meta.env.VITE_BUZZ_BRAND_NAME"]).toBe(
    '""',
  );
});

it("rejects a brand without a name or with a bad colour", () => {
  expect(() => loadBrand(brandDir({ name: " " }))).toThrow(/non-empty "name"/);
  expect(() => loadBrand(brandDir({ name: "A", themeColor: "red" }))).toThrow(
    /#hex/,
  );
});
