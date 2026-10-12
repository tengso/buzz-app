export type BrandAsset = { file: string; source: string; type: string };
export type Brand = {
  name: string;
  title: string;
  themeColor: string;
  files: Partial<
    Record<"logo" | "loading" | "favicon" | "apple-touch-icon", BrandAsset>
  >;
};
export function loadBrand(dir: string): Brand;
export function brandDefines(brand: Brand | undefined): Record<string, string>;
export function rebrandHtml(html: string, brand: Brand, base: string): string;
export function brandPlugin(brand: Brand): import("vite").Plugin;
