// Web builds set these from BUZZ_BRAND_DIR (see docs/browser-host.md); desktop keeps Buzz.
export const BRAND_NAME: string =
  import.meta.env?.VITE_BUZZ_BRAND_NAME || "Buzz";

/** Build-relative path of the brand's sidebar logo, or "" for the Buzz mark. */
export const BRAND_LOGO: string = import.meta.env?.VITE_BUZZ_BRAND_LOGO || "";

/** Build-relative path of the brand's loading-screen image, or "" for the Buzz mark. */
export const BRAND_LOADING: string =
  import.meta.env?.VITE_BUZZ_BRAND_LOADING || "";
