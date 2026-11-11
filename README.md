# Edit My PDF

A PDF editor that runs entirely in the browser. It edits the text a page already has, in the page's
own embedded font, and writes the result back as real text. It also annotates: pencil, shapes,
text boxes, emoji and signatures. Nothing is uploaded; pdf.js reads the file in a web worker and
pdf-lib writes the new one in the same tab.

Live at **[editmypdf.dev](https://editmypdf.dev/)**, published from
`main` by GitHub Actions; [How a change goes live](#how-a-change-goes-live) describes the path from a
pull request to the site.

## Run it

```bash
npm install
npm run dev
```

`npm run build` type-checks, builds to `dist/` and prerenders the site (below); `npm run preview`
serves that build the way a static host would; `npm run lint` runs oxlint.

Two build-time variables describe where the site will live:

- `VITE_SITE_URL`: the full address the site is served at, such as
  `https://example.com` or `https://owner.github.io/editmypdf`. It makes canonical links,
  `og:url`, `sitemap.xml`, `feed.xml` and `robots.txt` absolute; without it they are root-relative.
- `VITE_BASE`: the path the site is served under, `/` by default. Set it to `/<repo>/` when the
  site lives in a sub-path, as a GitHub Pages project site does; every script, stylesheet, image,
  route and public file is then addressed under that path.

## Prerendering

Every public page ships as its own HTML file, so crawlers and link previews get the title, meta
tags, JSON-LD and text without running JavaScript. `npm run build` runs `tsc -b`, `vite build` and
then `node scripts/prerender.mjs`:

1. The script bundles `src/entry-server.tsx` with Vite's server build (into `dist/.prerender`,
   removed afterwards).
2. For every route in `src/data/routes.ts` (the list the sitemap uses) it renders the site with
   react-router's static router and `renderToString`.
3. `useMeta` records each page's meta during that render instead of setting it in an effect; the
   script writes those tags into `<head>` of the built `index.html` and the markup into `#root`,
   stamped `data-prerendered="<route>"`, and saves the file as `dist/<route>/index.html` (the
   landing page is `dist/index.html`).

In the browser `src/main.tsx` hydrates the markup when the stamp matches the address, and renders
from scratch otherwise, so a file served for another address still works. Everything a page draws
on first render must be the same at build time and in the browser: read `localStorage`,
`matchMedia` and the like in effects, or through `useSyncExternalStore` with a server snapshot.

`/app` (the documents screen), `dist/200.html` and `dist/404.html` are the empty shell. A host
must serve one of them for every address it has no file for, which is `/edit/<id>` and unknown
paths: GitHub Pages picks up `404.html` by itself, Cloudflare Pages and similar hosts use
`200.html`. A host that answers those addresses with `/index.html` instead also works, with a flash
of the landing page before the app takes over. The build also writes an empty `.nojekyll` so GitHub
Pages serves files whose names begin with an underscore.

## How a change goes live

The site is served by GitHub Pages at https://editmypdf.dev/, the repository's custom domain, and is rebuilt from
`main` by the workflow in `.github/workflows/pages.yml`. Nothing is deployed by hand, and no branch
other than `main` is ever deployed.

1. Work on a branch and open a pull request against `main`. While the pull request is open its page
   says "This branch has not been deployed"; that is expected, since pull request branches are not
   built or published anywhere.
2. Merge the pull request. The merge is a push to `main`, which starts the "Publish to GitHub
   Pages" run under the **Actions** tab.
3. The run installs dependencies (`npm ci`), reads the site's address from the Pages settings
   (`actions/configure-pages`, which sets `VITE_BASE` to `/`, since the custom domain serves the site at
   the root, and `VITE_SITE_URL` to `https://editmypdf.dev`), runs `npm run build`, uploads `dist/` and deploys it. It takes about a minute.
   The run's summary and the merge commit on GitHub both link to the deployment.
4. The site is updated as soon as the run is green. A failed run leaves the previous deployment in
   place, so a broken build never takes the site down; the run's log says what failed.

A run can also be started by hand from the Actions tab (**Run workflow** on "Publish to GitHub
Pages"), for example to redeploy without a code change. Only one deployment runs at a time; a run
already in progress finishes before the next one starts.

A tab that loaded the site before a deployment still refers to the previous build's files, which
the deployment replaced, so the next route it opens would fail to load. `src/main.tsx` catches that
(Vite's `vite:preloadError`) and reloads the tab once, so visitors land on the new build instead of
an error screen. A second failure within a minute is shown as an error, so a file that is really
missing cannot cause a reload loop.

The editor's documents live in the browser's IndexedDB under the site's origin; a deployment does
not touch them.

### Setting up Pages for a new copy of the repository

The workflow is already in the repository; a fork or a fresh copy only needs Pages switched on:

1. Get the code onto `main`.
2. In the repository on GitHub, open **Settings → Pages** and under **Build and deployment** set
   **Source** to **GitHub Actions**. Nothing else needs choosing there.
3. Open the **Actions** tab. The "Publish to GitHub Pages" run that the push started (or one you
   start with **Run workflow**) builds the site and deploys it; the first run takes two or three
   minutes.
4. The site is at `https://<owner>.github.io/<repo>/`, in lowercase. The address is also shown on
   the workflow run and under Settings → Pages.

### A custom domain

1. Add the domain under Settings → Pages → **Custom domain** and point its DNS at GitHub Pages as
   the instructions there describe.
2. Add a `public/CNAME` file containing just the domain, so every deployment keeps it.
3. Nothing else changes: with a custom domain `actions/configure-pages` reports an empty base path
   and the domain as the address, so the workflow builds with `VITE_BASE=/` and
   `VITE_SITE_URL=https://<domain>`.

### Checking the Pages build locally

```bash
VITE_BASE=/editmypdf/ VITE_SITE_URL=http://localhost:5180/editmypdf npm run build
npx vite preview --base /editmypdf/ --port 5180
```

Then open `http://localhost:5180/editmypdf/`. The preview serves the prerendered pages under the
prefix the way GitHub Pages does; unknown addresses fall back to the landing page here rather than
to `404.html`.

## Search and analytics

The site ships what search engines need without configuration: one title and description per
page, canonical links, Open Graph cards, JSON-LD, `sitemap.xml` with a date per page, `feed.xml`,
`robots.txt`, a web manifest and prerendered HTML for every public page. Two things are optional
and read from repository variables at build time (Settings → Secrets and variables → Actions →
Variables; the Pages workflow passes them on):

- `VITE_GOOGLE_SITE_VERIFICATION`: the `content` value from Search Console's *HTML tag* method
  for a URL-prefix property. The tag is added to every page's head; verify, then submit
  `sitemap.xml` under Sitemaps.
- `VITE_CF_BEACON_TOKEN`: the `token` from a Cloudflare Web Analytics site (set up with the bare
  hostname, such as `vr-patel.github.io`). A cookieless counter with no identifier loads on the
  site's pages and the documents screen, once per full page load, never on the editing page; it
  needs no notice. The privacy page, FAQ, terms and landing page describe it automatically.
- `VITE_GA_MEASUREMENT_ID`: a Google Analytics 4 id (`G-…`). With it set, the site's pages show a
  short notice and load the script only after the visitor chooses OK; the editor pages never load
  it. The same pages describe that state automatically.

Without either variable the site stays script-free and says so.

### For AI agents

Agents and other readers that want text without the chrome get it from the build, not from
content negotiation (GitHub Pages cannot vary a response by `Accept`): `scripts/prerender.mjs`
converts each prerendered page's `<main>` to Markdown (turndown with GFM tables, decoration and
sample content stripped) and writes it next to the HTML at the same address with `.md` appended
(`/how-it-works.md`, `/blog/<slug>.md`, the home page at `/index.md`). `/llms.txt` lists every page
with one line each in the [llms.txt](https://llmstxt.org) format, `/llms-full.txt` holds all of
them in one file, every HTML page links its twin with `<link rel="alternate" type="text/markdown">`,
and `robots.txt` says where they are. The files are static, so no request is made at runtime.

## Routes

| Path                | What it is                                                  |
| ------------------- | ----------------------------------------------------------- |
| `/`                 | Landing page                                                |
| `/app`              | Documents: open a PDF, start blank, continue a saved one    |
| `/edit/:id`         | The editor for one document (lives only in this browser)    |
| `/blog`, `/blog/:slug` | Engineering posts                                        |
| `/compare`, `/compare/:slug` | Comparison roundup and one page per competitor     |
| `/how-it-works`, `/pricing`, `/privacy`, `/faq` | Supporting pages                |

## Where things live

- `src/index.css`: design tokens (palette, type scale, spacing, radii, shadows) and the editor's
  surface aliases. Both the site and the editor are built from these.
- `src/site/`: the marketing site (layout, pages, `site.css`, Markdown renderer, page meta).
- `src/data/posts.ts`: blog posts as Markdown, with dates and tags; `scripts/blog-cards.mjs` draws each
  post's link-preview card and card picture into `public/blog/cards/`.
- `src/data/competitors.ts`: every comparison fact, with sources and the date it was checked.
- `src/data/faq.ts`, `src/data/product.ts`: FAQ entries; product name, description, routes and
  the base-path helpers (`publicUrl`, `routeHref`, `siteOrigin`).
- `src/site/Logo.tsx`, `public/favicon.svg`, `public/og.svg`: the mark, a document with a folded
  corner and "PDF" inside it. `public/og.png` and `public/apple-touch-icon.png` are rendered from
  the SVGs (with sharp, outside the project).
- `.github/workflows/pages.yml`: the GitHub Pages deployment (see How a change goes live).
- `src/main.tsx`: the browser entry: hydrates prerendered pages and reloads a tab once when a
  deployment has replaced the files it loaded.
- `src/data/routes.ts`: every public route, for the sitemap and the prerender.
- `src/entry-server.tsx`, `scripts/prerender.mjs`: build-time rendering of the site (above).
- `src/App.tsx`, `src/App.css`, `src/AppHome.tsx`: the editor shell and the documents screen.
- `src/content.ts`, `src/textLayout.ts`, `src/SpanEditor.tsx`, `src/contentEdit.ts`,
  `src/PageStage.tsx`, `src/exportPdf.ts`, `src/fontFix.ts`: reading, editing and exporting the
  page's own content. The blog posts describe what these do.

## Updating the comparisons

Edit `src/data/competitors.ts`. Each entry carries `checkedAt` and a `sources` list; update both when
a price or a limit changes. The roundup table, the per-tool pages, the landing teaser and the
sitemap all read from that file.

## Contributing and licence

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run, test and change the editor and the site.
Edit My PDF is released under the MIT licence; see [LICENSE](LICENSE).
