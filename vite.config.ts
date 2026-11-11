import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import { POSTS } from "./src/data/posts.ts";
import { canonicalPath, PUBLIC_ROUTES } from "./src/data/routes.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// An RSS feed of the blog, for readers and for crawlers that follow it.
function feed(origin: string): string {
  const items = POSTS.map(
    (post) =>
      `  <item>\n    <title>${escapeXml(post.title)}</title>\n    <link>${origin}${canonicalPath(`/blog/${post.slug}`)}</link>\n    <guid isPermaLink="true">${origin}${canonicalPath(`/blog/${post.slug}`)}</guid>\n    <pubDate>${new Date(`${post.date}T09:00:00Z`).toUTCString()}</pubDate>\n    <description>${escapeXml(post.description)}</description>\n  </item>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n  <title>Edit My PDF blog</title>\n  <link>${origin}${canonicalPath("/blog")}</link>\n  <description>Engineering notes on editing PDF text in the browser.</description>\n  <language>en</language>\n${items.join("\n")}\n</channel>\n</rss>\n`;
}

// Development only: answers a request for a path under the base path with the file `lookup` returns
// for the part below the base, and leaves every other request to Vite. The query string is ignored.
function serveUnderBase(server: ViteDevServer, lookup: (name: string) => { type: string; body: string | Buffer } | undefined) {
  const base = server.config.base;
  server.middlewares.use((request, response, next) => {
    const [pathname = ""] = (request.url ?? "").split("?");
    const file = pathname.startsWith(base) ? lookup(pathname.slice(base.length)) : undefined;
    if (!file) {
      next();
      return;
    }
    response.setHeader("Content-Type", file.type);
    response.end(file.body);
  });
}

// Crawlers' files: sitemap.xml, feed.xml and robots.txt, served in development and written into the
// build. Their addresses are absolute when VITE_SITE_URL is set (the full address the site is served
// at, such as https://owner.github.io/repo) and root-relative under the base path otherwise. The
// route list is src/data/routes.ts, shared with the prerender.
function siteFiles(siteUrl: string): Plugin {
  // Resolved once the config is final, so a base given on the command line counts too.
  let base = "/";
  let origin = siteUrl;
  const sitemap = () =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PUBLIC_ROUTES
      .map(
        (route) =>
          `  <url><loc>${origin}${canonicalPath(route.path)}</loc>${route.lastmod ? `<lastmod>${route.lastmod}</lastmod>` : ""}</url>`,
      )
      .join("\n")}\n</urlset>\n`;
  // Editor documents exist only in one browser, so /edit/ is kept out of search results.
  const robots = () =>
    [
      "User-agent: *",
      `Allow: ${base}`,
      `Disallow: ${base}edit/`,
      "",
      `Sitemap: ${origin}/sitemap.xml`,
      "",
      "# For AI agents and other readers that prefer text: every page has a Markdown version at",
      "# its address with .md appended (the home page at /index.md), listed with one line each in",
      `# ${origin}/llms.txt and concatenated in ${origin}/llms-full.txt.`,
      "",
    ].join("\n");
  // The web app manifest: installable, with the icons under the base path.
  const manifest = () =>
    JSON.stringify(
      {
        name: "Edit My PDF",
        short_name: "Edit My PDF",
        description: "Free browser PDF editor that edits the page's own text in its own font. No upload, no account.",
        start_url: `${base}app`,
        scope: base,
        display: "standalone",
        background_color: "#f8f7f3",
        theme_color: "#1e59cd",
        icons: [
          { src: `${base}icon-192.png`, sizes: "192x192", type: "image/png" },
          { src: `${base}icon-512.png`, sizes: "512x512", type: "image/png" },
          { src: `${base}icon-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      null,
      2,
    );
  const files: Record<string, { type: string; body: () => string }> = {
    "sitemap.xml": { type: "application/xml", body: sitemap },
    "feed.xml": { type: "application/rss+xml", body: () => feed(origin) },
    "robots.txt": { type: "text/plain", body: robots },
    "site.webmanifest": { type: "application/manifest+json", body: manifest },
  };
  return {
    name: "site-files",
    // The prerender's server build (scripts/prerender.mjs) needs none of these.
    apply: (_config, env) => !env.isSsrBuild,
    configResolved(config) {
      base = config.base;
      if (!siteUrl) origin = base.replace(/\/$/, "");
    },
    configureServer(server) {
      serveUnderBase(server, (name) => {
        const file = Object.hasOwn(files, name) ? files[name] : undefined;
        return file ? { type: file.type, body: file.body() } : undefined;
      });
    },
    generateBundle() {
      for (const [fileName, file] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName, source: file.body() });
      }
    },
  };
}

// `vite preview` answers /pricing with /index.html, which after prerendering is the landing page; a
// static host answers it with /pricing/index.html. This makes the preview do the same, so the
// prerendered pages can be checked with `npm run preview` (under the base path, when there is one).
function prerenderedPages(): Plugin {
  return {
    name: "prerendered-pages",
    configurePreviewServer(server) {
      const outDir = path.resolve(root, server.config.build.outDir);
      const base = server.config.base;
      server.middlewares.use((request, _response, next) => {
        const [pathname = "", query] = (request.url ?? "").split("?");
        const route = pathname.startsWith(base) ? pathname.slice(base.length) : "";
        if (
          request.method === "GET" &&
          route.length > 0 &&
          !route.endsWith("/") &&
          !route.includes("..") &&
          !path.extname(route) &&
          existsSync(path.join(outDir, route, "index.html"))
        ) {
          request.url = `${pathname}/index.html${query ? `?${query}` : ""}`;
        }
        next();
      });
    },
  };
}

// Google Search Console's HTML-tag verification: the tag goes into every page's head when the build
// has VITE_GOOGLE_SITE_VERIFICATION (the content value Search Console shows), and nowhere otherwise.
function searchVerification(content: string | undefined): Plugin {
  return {
    name: "search-verification",
    transformIndexHtml() {
      if (!content) return [];
      return [{ tag: "meta", attrs: { name: "google-site-verification", content }, injectTo: "head" }];
    },
  };
}

// pdf.js loads some of its resources while a document is open, from directory addresses it appends
// file names to: the WebAssembly decoders for JPEG 2000 and JBIG2 images and for ICC colour (wasm/),
// the predefined CMaps that CJK fonts use (cmaps/), the CMYK profile (iccs/) and the standard 14
// fonts for PDFs that do not embed theirs (standard_fonts/). This copies them from pdfjs-dist into
// the build under one folder, beside the other hashed assets, named after a hash of their contents,
// so they cache for ever and move when pdf.js is updated, and serves them from node_modules in
// development. src/pdf.ts reads the folder's address from the virtual module
// "virtual:pdfjs-resources" and hands it to pdf.js; nothing is fetched from a CDN, so every request
// stays on the site's own origin. The files are not imported by any chunk: pdf.js fetches each one
// the first time a document needs it.
const PDFJS_RESOURCE_DIRS = ["wasm", "cmaps", "iccs", "standard_fonts"];
// The QuickJS sandbox runs form scripts in pdf.js's own viewer, which this app does not use.
const PDFJS_RESOURCE_SKIP = /^quickjs-/;
const PDFJS_RESOURCE_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".bcmap": "application/octet-stream",
  ".icc": "application/vnd.iccprofile",
  ".pfb": "application/x-font-type1",
  ".ttf": "font/ttf",
};
function pdfjsResources(): Plugin {
  const virtualId = "virtual:pdfjs-resources";
  const resolvedId = `\0${virtualId}`;
  // The package folder, found from the entry point (build/pdf.mjs) rather than from package.json,
  // which an exports map could hide one day.
  const packageDir = path.resolve(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist")), "..");
  const files = PDFJS_RESOURCE_DIRS.flatMap((dir) =>
    readdirSync(path.join(packageDir, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && !PDFJS_RESOURCE_SKIP.test(entry.name))
      .map((entry) => `${dir}/${entry.name}`)
      .sort(),
  );
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(path.join(packageDir, file)));
  const digest = hash.digest("hex").slice(0, 8);
  // "assets/pdfjs-<digest>/" by default; set once the config is final, in case assetsDir is changed.
  let folder = "";
  return {
    name: "pdfjs-resources",
    configResolved(config) {
      folder = `${config.build.assetsDir.replace(/\/+$/, "")}/pdfjs-${digest}/`;
    },
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      // An empty folder would send pdf.js to the wrong addresses without a word, so fail here instead.
      if (!folder) throw new Error("pdfjs-resources: the resource folder is not known yet; configResolved has not run.");
      return `export const PDFJS_RESOURCES = ${JSON.stringify(folder)};`;
    },
    configureServer(server) {
      serveUnderBase(server, (name) => {
        const file = name.startsWith(folder) ? name.slice(folder.length) : "";
        if (!files.includes(file)) return undefined;
        return {
          type: PDFJS_RESOURCE_TYPES[path.extname(file)] ?? "application/octet-stream",
          body: readFileSync(path.join(packageDir, file)),
        };
      });
    },
    generateBundle() {
      // The prerender's server bundle (scripts/prerender.mjs) renders no documents.
      if (this.environment.config.consumer !== "client") return;
      for (const file of files) {
        this.emitFile({ type: "asset", fileName: `${folder}${file}`, source: readFileSync(path.join(packageDir, file)) });
      }
    },
  };
}

// The path the site is served under: "/" (the default) or "/<repo>/" for a GitHub Pages project
// site. Read from VITE_BASE at build time; either "/repo" or "/repo/" is accepted.
function basePath(value: string | undefined): string {
  const trimmed = (value ?? "").replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "VITE_");
  const siteUrl = (env.VITE_SITE_URL ?? "").replace(/\/$/, "");
  return {
    base: basePath(env.VITE_BASE),
    plugins: [
      react(),
      tailwindcss(),
      pdfjsResources(),
      siteFiles(siteUrl),
      searchVerification(env.VITE_GOOGLE_SITE_VERIFICATION),
      prerenderedPages(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(root, "src"),
      },
    },
  };
});
