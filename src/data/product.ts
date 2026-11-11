// Facts about the product that the site repeats in many places. Change them here.

export const PRODUCT = {
  // The npm package is called "pdf-editor"; the repository is vr-patel/editmypdf.
  name: "Edit My PDF",
  nameIsProvisional: false,
  tagline: "Edit the text in a PDF without disturbing the page.",
  description:
    "Edit My PDF is a free PDF editor that runs entirely in your browser. Click any heading, line or paragraph and retype it in the page's own font, size, colour and spacing. Nothing is uploaded, and no account is needed.",
  shortDescription: "Free browser PDF editor that edits the page's own text in its own font. No uploads, no account.",
  repository: "https://github.com/vr-patel/editmypdf",
  issues: "https://github.com/vr-patel/editmypdf/issues",
  licenseUrl: "https://github.com/vr-patel/editmypdf/blob/main/LICENSE",
  // Who made it, and where to reach them. The footer shows these.
  author: {
    name: "VR Patel",
    linkedin: "https://www.linkedin.com/in/vr-patel",
    x: "https://x.com/_vrpatel",
    xHandle: "@_vrpatel",
  },
  // The stack the privacy claims rest on. Verified against the source: pdf.js parses and renders in
  // a web worker, pdf-lib writes the file, IndexedDB and localStorage hold the sessions, and the
  // download is a blob URL. The app's own fetch() calls load its own files: the sample PDF, the
  // supplement fonts and the emoji images; pdf.js fetches its helper files from the same origin.
  libraries: {
    reader: { name: "pdf.js", version: "6", url: "https://mozilla.github.io/pdf.js/" },
    writer: { name: "pdf-lib", version: "1.17", url: "https://pdf-lib.js.org/" },
  },
  // Month the comparison facts were last checked.
  comparisonsCheckedAt: "November 2026",
} as const;

// Visit counting, off unless the build sets one of two variables. VITE_CF_BEACON_TOKEN turns on
// Cloudflare Web Analytics, a cookieless counter with no identifier, on the site's pages and the
// documents screen (src/counter.ts). VITE_GA_MEASUREMENT_ID (a GA4 id such as G-XXXXXXX) turns on
// Google Analytics on the site's pages only, behind a notice the visitor must accept
// (src/site/Analytics.tsx). The privacy page, FAQ, terms and landing page describe whichever is
// on; with neither set, every page says the site runs no analytics, and that is true.
export const ANALYTICS = {
  id: (import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined) || undefined,
  cloudflareToken: (import.meta.env.VITE_CF_BEACON_TOKEN as string | undefined) || undefined,
  // Google Analytics is configured.
  get enabled(): boolean {
    return Boolean(this.id);
  },
  // The cookieless counter is configured.
  get counter(): boolean {
    return Boolean(this.cloudflareToken);
  },
  get any(): boolean {
    return this.enabled || this.counter;
  },
} as const;

export const ROUTES = {
  home: "/",
  app: "/app",
  edit: (id: string) => `/edit/${id}`,
  blog: "/blog",
  post: (slug: string) => `/blog/${slug}`,
  compare: "/compare",
  comparison: (slug: string) => `/compare/${slug}`,
  howItWorks: "/how-it-works",
  pricing: "/pricing",
  features: "/#features",
  privacy: "/privacy",
  terms: "/terms",
  faq: "/faq",
} as const;

// The path the site is served under, without a trailing slash: "" at the root of a host and
// "/<repo>" on GitHub Pages (Vite's base URL, set with VITE_BASE at build time).
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

// The address of a route as the browser sees it, for a plain <a href>. react-router's Link and
// navigate() add the base themselves and take the route path.
export function routeHref(path: string): string {
  return `${BASE_PATH}${path}`;
}

// The address of a file in public/, which is served under the base path.
export function publicUrl(file: string): string {
  return `${import.meta.env.BASE_URL}${file.replace(/^\//, "")}`;
}

// The site's address including the base path, without a trailing slash, for absolute URLs in meta
// tags and JSON-LD: VITE_SITE_URL when it is set (the full address the site is served at, such as
// https://owner.github.io/repo), otherwise the browser's origin plus the base path, and at build time
// with nothing configured the base path alone, which makes the URLs root-relative.
export function siteOrigin(): string {
  const configured = import.meta.env.VITE_SITE_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") return `${window.location.origin}${BASE_PATH}`;
  return BASE_PATH;
}
