// BUZZ_BRAND_DIR: rebrand a browser build from a folder holding brand.json and optional images.
import fs from "node:fs";
import path from "node:path";

const SLOTS = {
  logo: ["svg", "png", "webp"],
  loading: ["svg", "gif", "png", "webp"],
  favicon: ["ico", "png", "svg"],
  "apple-touch-icon": ["png"],
};
const TYPES = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
};

const text = (value) => (typeof value === "string" ? value.trim() : "");
const escapeHtml = (value) =>
  value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export function loadBrand(dir) {
  const root = path.resolve(dir);
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "brand.json"), "utf8"),
  );
  const name = text(config.name);
  if (!name) throw new Error(`${root}/brand.json needs a non-empty "name".`);
  const themeColor = text(config.themeColor);
  if (themeColor && !/^#[0-9a-f]{3,8}$/i.test(themeColor))
    throw new Error(`${root}/brand.json "themeColor" must be a #hex colour.`);
  const files = {};
  for (const [slot, extensions] of Object.entries(SLOTS)) {
    const ext = extensions.find((e) =>
      fs.existsSync(path.join(root, `${slot}.${e}`)),
    );
    if (ext)
      files[slot] = {
        file: `brand/${slot}.${ext}`,
        source: path.join(root, `${slot}.${ext}`),
        type: TYPES[ext],
      };
  }
  return { name, title: text(config.title) || name, themeColor, files };
}

export function brandDefines(brand) {
  const logo = brand?.files.logo?.file ?? "";
  return {
    "import.meta.env.VITE_BUZZ_BRAND_NAME": JSON.stringify(brand?.name ?? ""),
    "import.meta.env.VITE_BUZZ_BRAND_LOGO": JSON.stringify(logo),
    "import.meta.env.VITE_BUZZ_BRAND_LOADING": JSON.stringify(
      brand?.files.loading?.file ?? logo,
    ),
  };
}

export function rebrandHtml(html, brand, base) {
  const name = escapeHtml(brand.name);
  const { favicon, logo, loading } = brand.files;
  let out = html
    .replace(
      /<title>[^<]*<\/title>/,
      `<title>${escapeHtml(brand.title)}</title>`,
    )
    .replace('aria-label="Opening Buzz"', `aria-label="Opening ${name}"`)
    .replace(/alt="Buzz"/g, `alt="${name}"`);
  if (brand.themeColor)
    out = out.replace(
      /(<meta name="theme-color" content=")[^"]*"/,
      `$1${brand.themeColor}"`,
    );
  if (favicon)
    out = out
      .replace(/[ \t]*<link rel="icon"[^>]*>\n?/g, "")
      .replace(
        "</title>",
        `</title>\n    <link rel="icon" type="${favicon.type}" href="${base}${favicon.file}" />`,
      );
  const appleTouch = brand.files["apple-touch-icon"];
  if (appleTouch)
    out = out.replace(
      /(<link rel="apple-touch-icon" href=")[^"]*"/,
      `$1${base}${appleTouch.file}"`,
    );
  const launch = loading ?? logo;
  if (launch)
    out = out.replace(
      /<picture>[\s\S]*?<\/picture>/,
      `<picture><img src="${base}${launch.file}" alt="${name}" width="72" height="72" /></picture>`,
    );
  return out;
}

export function brandPlugin(brand) {
  let base = "/";
  const assets = Object.values(brand.files);
  return {
    name: "buzz-brand",
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const asset = assets.find(
          (a) => req.url?.split("?")[0] === `/${a.file}`,
        );
        if (!asset) return next();
        res.setHeader("Content-Type", asset.type);
        res.end(fs.readFileSync(asset.source));
      });
    },
    generateBundle() {
      for (const asset of assets)
        this.emitFile({
          type: "asset",
          fileName: asset.file,
          source: fs.readFileSync(asset.source),
        });
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => rebrandHtml(html, brand, base),
    },
  };
}
