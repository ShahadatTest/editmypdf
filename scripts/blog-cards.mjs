// Draws the blog's card pictures. For every post in src/data/posts.ts it writes two files to
// public/blog/cards/: <slug>.png, the 1200×630 link-preview card (the post's og:image) with the
// brand, the title and a scene drawn for the post, and <slug>.webp, the same scene alone at
// 1200×600 for the post cards on /blog and the landing page. Each scene is a small SVG written
// here in SCENES; the type is the site's own (Instrument Serif, Geist) read from node_modules.
// Rendered by headless Chrome over its debugging protocol, so there is no npm dependency; set
// CHROME to a Chromium binary (a path or a command on PATH) when none is found in the usual
// places. The script imports the posts' TypeScript directly, which needs Node 23.6 or later (or
// `node --experimental-strip-types` on Node 22.6+). Run after adding or retitling a post:
//
//   node scripts/blog-cards.mjs [slug ...]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.features?.typescript) {
  console.error("This script imports TypeScript; run it with Node 23.6 or later, or `node --experimental-strip-types scripts/blog-cards.mjs`.");
  process.exit(1);
}
const { POSTS, formatDate } = await import("../src/data/posts.ts");
const { ICONS } = await import("../src/site/blogIcons.ts");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = path.join(root, "public", "blog", "cards");
const only = process.argv.slice(2);

// CHROME is taken as given (a path or a command on PATH); otherwise the usual locations are tried.
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const CHROME = process.env.CHROME || CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!CHROME) {
  console.error("No Chromium binary found; set CHROME to a path or a command, e.g. CHROME=chromium.");
  process.exit(1);
}

/* ---- Palette (src/index.css, light theme) ------------------------------------------------- */

const HUES = {
  accent: { tone: "oklch(0.5 0.19 262)", ink: "oklch(0.42 0.18 262)" },
  coral: { tone: "oklch(0.62 0.17 40)", ink: "oklch(0.5 0.16 40)" },
  teal: { tone: "oklch(0.6 0.12 175)", ink: "oklch(0.46 0.1 175)" },
  violet: { tone: "oklch(0.55 0.17 300)", ink: "oklch(0.46 0.16 300)" },
};
const PAPER = "#f8f7f3";
const PAPER_2 = "#efede7";
const INK_0 = "#17160f";
const INK_1 = "#4b4941";
const INK_2 = "#7d7a70";
const LINE = "#c9c6be";
const LINE_DARK = "#8a877e";
const PAGE_EDGE = "#d3d0c8";
const BAD = "oklch(0.55 0.2 25)";
const GOOD = "oklch(0.55 0.15 150)";

const fontFile = (pkg, file) => pathToFileURL(path.join(root, "node_modules", pkg, "files", file)).href;
const FONTS = `
@font-face { font-family: "Instrument Serif"; font-style: normal; font-weight: 400; src: url("${fontFile("@fontsource/instrument-serif", "instrument-serif-latin-400-normal.woff2")}") format("woff2"); }
@font-face { font-family: "Instrument Serif"; font-style: italic; font-weight: 400; src: url("${fontFile("@fontsource/instrument-serif", "instrument-serif-latin-400-italic.woff2")}") format("woff2"); }
@font-face { font-family: "Geist Variable"; font-style: normal; font-weight: 100 900; src: url("${fontFile("@fontsource-variable/geist", "geist-latin-wght-normal.woff2")}") format("woff2"); }
@font-face { font-family: "Geist Mono Variable"; font-style: normal; font-weight: 100 900; src: url("${fontFile("@fontsource-variable/geist-mono", "geist-mono-latin-wght-normal.woff2")}") format("woff2"); }
`;
const SANS = '"Geist Variable", system-ui, sans-serif';
const SERIF = '"Instrument Serif", Georgia, serif';
const MONO = '"Geist Mono Variable", ui-monospace, monospace';

/* ---- Drawing helpers (SVG) ---------------------------------------------------------------- */

// A text line on a miniature page: a rounded bar.
const ln = (x, y, w, h = 6, fill = LINE) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;
// A white page with a soft shadow; `inner` is drawn in its own coordinates.
const page = (x, y, w, h, inner) =>
  `<g transform="translate(${x} ${y})"><rect width="${w}" height="${h}" rx="8" fill="#fff" stroke="${PAGE_EDGE}" filter="url(#shadow)"/>${inner}</g>`;
// The inner markup of a Lucide icon from the blog's set; a misspelled name fails here, not on the card.
function iconMarkup(name) {
  const markup = ICONS[name];
  if (!markup) throw new Error(`No icon named "${name}" in src/site/blogIcons.ts.`);
  return markup;
}
// A Lucide icon from the blog's set, as a nested svg.
const icon = (name, x, y, size, stroke, width = 2) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(name)}</svg>`;
// A rounded tile with an icon in the post's hue.
const tile = (x, y, name, size = 60) =>
  `<g transform="translate(${x} ${y})"><rect width="${size}" height="${size}" rx="${size * 0.28}" fill="var(--tone-soft)" stroke="var(--tone-edge)"/>${icon(name, size * 0.25, size * 0.25, size * 0.5, "var(--tone-ink)")}</g>`;
// A small round badge: a check (good) or a cross (bad).
const badge = (x, y, ok = true, r = 16) =>
  `<g transform="translate(${x} ${y})"><circle r="${r}" fill="${ok ? GOOD : BAD}"/>${icon(ok ? "check" : "x", -r * 0.6, -r * 0.6, r * 1.2, "#fff", 2.6)}</g>`;
// Display type, for the glyphs the covers used to carry.
const display = (x, y, size, text, fill = "var(--tone-ink)", extra = "") =>
  `<text x="${x}" y="${y}" font-family='${SERIF}' font-size="${size}" fill="${fill}" letter-spacing="-0.02em" ${extra}>${text}</text>`;
const mono = (x, y, size, text, fill = "var(--tone-ink)") =>
  `<text x="${x}" y="${y}" font-family='${MONO}' font-weight="600" font-size="${size}" fill="${fill}">${text}</text>`;
// A dashed connector.
const dashed = (d, stroke = "var(--tone)", width = 2) =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-dasharray="4 7" stroke-linecap="round"/>`;
// The usual block of body lines on a page.
const body = (x, y, widths, gap = 16, h = 6) => widths.map((w, i) => ln(x, y + i * gap, w, h)).join("");

/* ---- The scenes, one per post, each in a 480×420 box ------------------------------------ */

const SCENES = {
  "scans-cjk-text-and-colour-profiles": {
    pills: [["image", "Scanned pages"], ["languages", "CJK text"], ["palette", "ICC colour"]],
    svg: `
<defs><linearGradient id="photo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dfe4ee"/><stop offset=".55" stop-color="#9aa6bf"/><stop offset="1" stop-color="#4f5d7c"/></linearGradient></defs>
${page(40, 30, 260, 360, `
  ${ln(24, 28, 110, 9, LINE_DARK)}
  <rect x="24" y="52" width="212" height="104" rx="6" fill="url(#photo)"/>
  <circle cx="200" cy="80" r="11" fill="#fff" fill-opacity=".9"/>
  <path d="M24 156 L24 124 Q60 96 96 126 T168 130 T236 110 L236 156 Z" fill="#3f4b66" fill-opacity=".55"/>
  <text x="24" y="196" font-family='"Hiragino Sans", "Noto Sans JP", sans-serif' font-weight="600" font-size="26" fill="#2f2e2a">日本語テスト</text>
  ${body(24, 214, [212, 180], 16)}
  <rect x="24" y="254" width="212" height="46" rx="6" fill="#c8102e"/>
  ${body(24, 318, [212, 150], 16)}
`)}
${badge(300, 30)}
${dashed("M300 110 L340 110")}${tile(342, 80, "image")}
${dashed("M300 224 L340 224")}${tile(342, 194, "languages")}
${dashed("M300 338 L340 338")}${tile(342, 308, "palette")}
`,
  },
  "edit-pdf-online-free-without-uploading": {
    pills: [["cloud-off", "No upload"], ["ban", "No sign-up"], ["check", "No watermark"]],
    svg: `
${page(40, 70, 240, 320, `
  ${ln(22, 26, 100, 9, LINE_DARK)}
  ${body(22, 54, [196, 170, 188], 16)}
  <rect x="22" y="104" width="150" height="10" rx="5" fill="var(--tone)"/>
  <rect x="176" y="100" width="2" height="18" fill="var(--tone-ink)"/>
  ${body(22, 132, [196, 160, 190, 120], 16)}
  ${body(22, 214, [196, 184, 150], 16)}
`)}
${dashed("M280 150 C 330 150, 340 90, 400 72", INK_2, 2.5)}
<g transform="translate(378 40)"><rect width="64" height="64" rx="18" fill="#fff" stroke="${PAGE_EDGE}"/>${icon("cloud-off", 16, 16, 32, BAD, 2)}</g>
${badge(442, 40, false, 14)}
${display(300, 300, 96, "0 km")}
<text x="302" y="336" font-family='${SANS}' font-weight="500" font-size="17" fill="${INK_2}">travelled by your file</text>
`,
  },
  "sign-pdf-online-free-without-uploading": {
    pills: [["timer", "About a minute"], ["pen-line", "Typed or drawn"], ["cloud-off", "No upload"]],
    svg: `
${page(50, 30, 260, 360, `
  ${ln(24, 28, 120, 9, LINE_DARK)}
  ${body(24, 56, [212, 196, 204, 150], 16)}
  ${ln(24, 140, 60, 6, LINE_DARK)}${ln(92, 140, 144, 6)}
  ${ln(24, 166, 60, 6, LINE_DARK)}${ln(92, 166, 144, 6)}
  <line x1="24" y1="286" x2="236" y2="286" stroke="${LINE_DARK}" stroke-width="1.5"/>
  <text x="24" y="306" font-family='${SANS}' font-size="11" fill="${INK_2}">Signature</text>
  <text x="26" y="282" font-family='${SERIF}' font-size="16" fill="${INK_2}">×</text>
  <path d="M60 268 C 70 226, 92 222, 84 252 C 78 274, 62 282, 70 266 C 84 240, 118 230, 126 252 C 132 268, 112 284, 124 274 C 136 262, 150 236, 170 240 C 190 244, 176 280, 196 262 C 206 252, 218 250, 230 258" fill="none" stroke="var(--tone)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
`)}
${tile(330, 290, "pen-line", 64)}
${badge(310, 30)}
`,
  },
  "exporting-real-text": {
    pills: [["type", "Real text, not a picture"], ["package", "The page's font, subset"]],
    svg: `
${page(30, 50, 230, 320, `
  ${ln(22, 26, 90, 9, LINE_DARK)}
  ${body(22, 54, [186, 160], 16)}
  <text x="22" y="110" font-family='${SANS}' font-weight="600" font-size="18" fill="var(--tone-ink)">Revenue grew</text>
  ${body(22, 124, [186, 170, 140], 16)}
  ${body(22, 190, [186, 176, 150, 110], 16)}
`)}
<g transform="translate(290 70)">
${Array.from({ length: 32 }, (_, i) => {
  const lit = [3, 10, 14, 17, 22, 28].includes(i);
  return `<rect x="${(i % 8) * 22}" y="${Math.floor(i / 8) * 22}" width="18" height="18" rx="3" fill="${lit ? "var(--tone-soft)" : PAPER_2}" stroke="${lit ? "var(--tone)" : PAGE_EDGE}"/>`;
}).join("")}
</g>
<text x="290" y="178" font-family='${SANS}' font-size="12" fill="${INK_2}">every glyph the font has</text>
<path d="M360 192 L360 222" stroke="${INK_2}" stroke-width="2" marker-end="url(#arrow)"/>
<g transform="translate(327 236)">
${Array.from({ length: 6 }, (_, i) => `<rect x="${(i % 3) * 22}" y="${Math.floor(i / 3) * 22}" width="18" height="18" rx="3" fill="var(--tone-soft)" stroke="var(--tone)"/>`).join("")}
</g>
<text x="290" y="300" font-family='${SANS}' font-size="12" fill="${INK_2}">only the ones your edit uses</text>
<g transform="translate(300 330)"><rect width="76" height="40" rx="10" fill="#fff" stroke="${PAGE_EDGE}"/>${mono(16, 27, 20, "Tj")}</g>
`,
  },
  "what-the-editor-leaves-alone": {
    pills: [["table", "Tables"], ["eye-off", "Covered text"], ["type", "Type 3 fonts"]],
    svg: `
${page(50, 30, 280, 360, `
  ${ln(24, 28, 120, 9, LINE_DARK)}
  ${body(24, 56, [232, 200], 16)}
  <g transform="translate(24 100)">
    <rect width="232" height="84" rx="4" fill="none" stroke="var(--tone)" stroke-dasharray="4 5" stroke-width="1.5"/>
    ${[21, 42, 63].map((y) => `<line x1="0" y1="${y}" x2="232" y2="${y}" stroke="${PAGE_EDGE}"/>`).join("")}
    ${[78, 156].map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="84" stroke="${PAGE_EDGE}"/>`).join("")}
    ${[0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => ln(8 + c * 78, 8 + r * 21, 40 + ((r + c) % 3) * 8, 5)).join("")).join("")}
  </g>
  ${display(262, 108, 22, "Ø")}
  ${body(24, 204, [232, 210], 16)}
  <g transform="translate(24 244)">
    ${body(0, 4, [232, 188], 16)}
    <rect x="-4" y="-4" width="200" height="34" rx="4" fill="#fff" fill-opacity=".92" stroke="var(--tone)" stroke-dasharray="4 5" stroke-width="1.5"/>
  </g>
  ${display(230, 252, 22, "Ø")}
  ${body(24, 300, [232, 176, 120], 16)}
`)}
${tile(344, 320, "hand", 64)}
`,
  },
  "mixed-face-paragraphs": {
    pills: [["bold", "Bold, italic and regular"], ["blocks", "Edited as one block"]],
    svg: `
${page(40, 30, 300, 360, `
  ${ln(24, 28, 130, 9, LINE_DARK)}
  <g transform="translate(24 56)">
    <rect x="-10" y="-10" width="272" height="124" rx="6" fill="none" stroke="var(--tone)" stroke-width="1.5"/>
    ${[[-10, -10], [262, -10], [-10, 114], [262, 114]].map(([x, y]) => `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="2" fill="#fff" stroke="var(--tone)" stroke-width="1.5"/>`).join("")}
    ${ln(0, 0, 92, 8, INK_1)}${ln(100, 1, 152, 6)}
    ${ln(0, 20, 252, 6)}
    ${ln(0, 40, 70, 6)}<g transform="skewX(-14)">${ln(94, 40, 86, 6, LINE_DARK)}</g>${ln(176, 40, 76, 6)}
    ${ln(0, 60, 252, 6)}
    ${ln(0, 80, 60, 8, INK_1)}${ln(68, 81, 184, 6)}
    ${ln(0, 100, 150, 6)}
  </g>
  ${body(24, 206, [252, 236, 248, 140], 16)}
  ${body(24, 290, [252, 200], 16)}
`)}
<text x="330" y="372" font-family='${SERIF}' font-size="110" fill="var(--tone-ink)" letter-spacing="-0.03em"><tspan font-weight="700">A</tspan><tspan font-style="italic">a</tspan></text>
`,
  },
  "exactly-as-the-page-prints-it": {
    pills: [["ruler", "Every line at its printed width"], ["baseline", "On the page's baseline"]],
    svg: `
${page(40, 30, 280, 340, `
  ${ln(24, 28, 120, 9, LINE_DARK)}
  ${body(24, 56, [232, 214], 16)}
  <g transform="translate(24 96)">
    ${ln(0, 6, 44, 6, LINE_DARK)}${ln(54, 6, 70, 6, LINE_DARK)}${ln(134, 6, 36, 6, LINE_DARK)}${ln(180, 6, 52, 6, LINE_DARK)}
    <rect x="-3" y="-6" width="238" height="30" rx="3" fill="none" stroke="var(--tone)" stroke-width="1.5"/>
    <line x1="-3" y1="18" x2="235" y2="18" stroke="var(--tone)" stroke-width="1" stroke-dasharray="2 3"/>
    <line x1="-3" y1="-12" x2="-3" y2="30" stroke="var(--tone)" stroke-width="1.5"/>
    <line x1="235" y1="-12" x2="235" y2="30" stroke="var(--tone)" stroke-width="1.5"/>
  </g>
  ${body(24, 140, [232, 200, 224, 120], 16)}
  ${body(24, 222, [232, 180, 230], 16)}
  <g transform="translate(24 300)">
    <line x1="0" y1="0" x2="232" y2="0" stroke="var(--tone)" stroke-width="1.5"/>
    ${Array.from({ length: 30 }, (_, i) => `<line x1="${i * 8}" y1="0" x2="${i * 8}" y2="${i % 5 === 0 ? 10 : 5}" stroke="var(--tone)" stroke-width="1"/>`).join("")}
  </g>
`)}
<g transform="translate(340 300)"><rect width="88" height="44" rx="12" fill="#fff" stroke="${PAGE_EDGE}"/>${mono(18, 30, 22, "Tw")}</g>
${badge(320, 30)}
`,
  },
  "nothing-leaves-your-browser": {
    pills: [["server-off", "No server"], ["lock", "Nothing uploaded"], ["search", "Check it yourself"]],
    svg: `
<g transform="translate(30 50)">
  <rect width="330" height="300" rx="14" fill="#fff" stroke="${PAGE_EDGE}" filter="url(#shadow)"/>
  <rect width="330" height="38" rx="14" fill="${PAPER_2}"/><rect y="24" width="330" height="14" fill="${PAPER_2}"/>
  <circle cx="20" cy="19" r="5" fill="#e0a07a"/><circle cx="36" cy="19" r="5" fill="#d9c66e"/><circle cx="52" cy="19" r="5" fill="#8fc49a"/>
  <rect x="72" y="9" width="200" height="20" rx="10" fill="#fff" stroke="${PAGE_EDGE}"/>
  ${icon("lock", 80, 13, 12, "var(--tone-ink)")}
  <text x="98" y="23" font-family='${SANS}' font-weight="500" font-size="11" fill="${INK_1}">editmypdf.dev</text>
  <g transform="translate(85 64)">
    <rect width="160" height="210" rx="6" fill="#fff" stroke="${PAGE_EDGE}"/>
    ${ln(16, 18, 70, 7, LINE_DARK)}
    ${body(16, 38, [128, 110, 124], 14, 5)}
    <rect x="16" y="80" width="96" height="8" rx="4" fill="var(--tone)"/>
    ${body(16, 102, [128, 100, 120, 128, 80], 14, 5)}
  </g>
  <path d="M250 150 C 300 120, 300 200, 250 190" fill="none" stroke="var(--tone)" stroke-width="2" marker-end="url(#arrowTone)"/>
</g>
${dashed("M362 180 L410 180", INK_2)}
<g transform="translate(410 148)"><rect width="64" height="64" rx="18" fill="#fff" stroke="${PAGE_EDGE}"/>${icon("server-off", 16, 16, 32, BAD, 2)}</g>
${badge(474, 148, false, 14)}
${display(392, 300, 72, "{ }")}
`,
  },
  "why-editing-pdf-text-is-hard": {
    pills: [["pilcrow", "No paragraphs in a PDF"], ["type", "Only placed glyphs"]],
    svg: `
${page(40, 30, 300, 360, `
  ${ln(24, 28, 120, 9, LINE_DARK)}
  ${body(24, 56, [252, 230], 16)}
  <g transform="translate(24 96)" font-family='${SERIF}' font-size="22" fill="${INK_1}">
    ${[..."Revenue"].map((ch, i) => `<rect x="${i * 20}" y="0" width="18" height="30" rx="3" fill="none" stroke="var(--tone)" stroke-width="1"/><text x="${i * 20 + 9}" y="22" text-anchor="middle">${ch}</text>`).join("")}
    ${mono(146, 20, 10, "−278", "var(--tone-ink)")}
    ${[..."grew"].map((ch, i) => `<rect x="${182 + i * 20}" y="0" width="18" height="30" rx="3" fill="none" stroke="var(--tone)" stroke-width="1"/><text x="${182 + i * 20 + 9}" y="22" text-anchor="middle">${ch}</text>`).join("")}
    ${Array.from({ length: 13 }, (_, i) => `<line x1="${i * 20}" y1="36" x2="${i * 20}" y2="${i % 2 ? 40 : 44}" stroke="var(--tone)" stroke-width="1"/>`).join("")}
    <text x="0" y="58" font-family='${MONO}' font-size="9" fill="${INK_2}">72 700 Td</text>
  </g>
  ${body(24, 170, [252, 240, 226, 150], 16)}
  ${body(24, 252, [252, 236, 200], 16)}
  ${body(24, 318, [180], 16)}
`)}
${display(354, 376, 118, "¶")}
`,
  },
};

/* ---- Pages ---------------------------------------------------------------------------------- */

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The brand mark, as src/site/Logo.tsx and public/og.svg draw it.
const MARK = `<svg width="44" height="44" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#1e59cd"/><path d="M11 6.5h7.25L23 11.25V23.5a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Z" fill="#fff"/><path d="M18.25 6.5v4.75H23Z" fill="#9fbcf0"/><g fill="#1e59cd"><rect x="11.75" y="14.5" width="6.5" height="1.9" rx=".95"/><rect x="11.75" y="18.4" width="7" height="1.9" rx=".95"/><rect x="11.75" y="22.3" width="3.5" height="1.9" rx=".95"/></g><g transform="translate(19.74 20.26) rotate(45)"><rect x="-2" y="-8" width="4" height="11" rx="2" fill="#d75928"/><path d="M-2 2.6h4L0 6.2Z" fill="#3b2a22"/></g></svg>`;

const DEFS = `<defs>
<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="${INK_0}" flood-opacity=".12"/></filter>
<marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="${INK_2}"/></marker>
<marker id="arrowTone" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="var(--tone)"/></marker>
</defs>`;

function sceneOf(post) {
  const scene = SCENES[post.slug];
  if (!scene) throw new Error(`No scene for ${post.slug}; add one to SCENES in scripts/blog-cards.mjs.`);
  return scene;
}

function sceneSvg(post, size) {
  return `<svg width="${size}" height="${size * (420 / 480)}" viewBox="0 0 480 420" aria-hidden="true">${DEFS}${sceneOf(post).svg}</svg>`;
}

function styles(post) {
  const hue = HUES[post.cover.hue];
  return `
${FONTS}
:root { --tone: ${hue.tone}; --tone-ink: ${hue.ink}; --tone-soft: color-mix(in oklab, ${hue.tone} 12%, #fff); --tone-edge: color-mix(in oklab, ${hue.tone} 35%, ${PAGE_EDGE}); }
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body { position: relative; background: ${PAPER}; color: ${INK_0}; font-family: ${SANS}; -webkit-font-smoothing: antialiased; }
.dots { position: absolute; inset: 0; background-image: radial-gradient(color-mix(in oklab, var(--tone) 28%, transparent) 1.4px, transparent 1.6px); background-size: 28px 28px; }
.brand { position: absolute; top: 48px; left: 64px; display: flex; align-items: center; gap: 14px; font-weight: 600; font-size: 26px; letter-spacing: -0.025em; color: ${INK_0}; }
.site { position: absolute; top: 56px; right: 64px; font-weight: 500; font-size: 20px; color: ${INK_2}; }
.eyebrow { position: absolute; top: 146px; left: 64px; font-weight: 700; font-size: 15px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--tone-ink); }
.title { position: absolute; top: 180px; left: 64px; width: 600px; font-family: ${SERIF}; font-weight: 400; font-size: 62px; line-height: 1.02; letter-spacing: -0.012em; color: ${INK_0}; }
.pills { position: absolute; left: 64px; display: flex; flex-wrap: wrap; gap: 12px; width: 600px; }
.pill { display: inline-flex; align-items: center; gap: 9px; padding: 11px 18px 11px 14px; border: 1px solid rgb(23 22 15 / 0.1); border-radius: 999px; background: #fff; font-weight: 500; font-size: 19px; color: ${INK_1}; }
.pill svg { width: 20px; height: 20px; stroke: var(--tone-ink); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.date { position: absolute; left: 64px; bottom: 50px; font-weight: 500; font-size: 17px; color: ${INK_2}; }
.disc { position: absolute; right: -150px; bottom: -220px; width: 640px; height: 640px; border-radius: 50%; background: color-mix(in oklab, var(--tone) 17%, ${PAPER}); }
.scene { position: absolute; right: 70px; top: 112px; }
.card { background: color-mix(in oklab, var(--tone) 16%, ${PAPER_2}); }
.card .dots { background-image: radial-gradient(color-mix(in oklab, var(--tone) 35%, transparent) 1.6px, transparent 1.8px); background-size: 26px 26px; }
.card .scene { right: auto; top: auto; left: 50%; bottom: 0; transform: translateX(-50%) translateY(26px); }
`;
}

function ogHtml(post) {
  const pills = sceneOf(post)
    .pills.map(([name, text]) => `<span class="pill"><svg viewBox="0 0 24 24">${iconMarkup(name)}</svg>${esc(text)}</span>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${styles(post)}</style></head><body>
<div class="dots"></div>
<div class="disc"></div>
<div class="brand">${MARK}<span>Edit My PDF</span></div>
<div class="site">editmypdf.dev/blog</div>
<div class="eyebrow">${esc(post.tags.join(" · "))}</div>
<h1 class="title">${esc(post.title)}</h1>
<div class="pills">${pills}</div>
<div class="date">${esc(formatDate(post.date))}</div>
<div class="scene">${sceneSvg(post, 460)}</div>
<script>
// Fits the title to at most three lines, then seats the pills under it.
window.__fit = () => {
  const title = document.querySelector(".title");
  let size = 62;
  while (title.scrollHeight > size * 1.02 * 3 + 4 && size > 38) { size -= 2; title.style.fontSize = size + "px"; }
  document.querySelector(".pills").style.top = (title.offsetTop + title.offsetHeight + 30) + "px";
  return size;
};
</script>
</body></html>`;
}

function cardHtml(post) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${styles(post)}</style></head><body class="card">
<div class="dots"></div>
<div class="scene">${sceneSvg(post, 690)}</div>
<script>window.__fit = () => 0;</script>
</body></html>`;
}

/* ---- Chrome over the DevTools protocol ------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withChrome(work) {
  const profile = mkdtempSync(path.join(tmpdir(), "blog-cards-"));
  const chrome = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-gpu", "--allow-file-access-from-files", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chrome.stderr.on("data", () => {});
  // A browser that cannot start (a wrong CHROME, say) is reported, not waited for.
  const startFailure = new Promise((_, reject) =>
    chrome.once("error", (error) => reject(new Error(`Could not start ${CHROME}: ${error.message}`))),
  );
  startFailure.catch(() => {});
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    let url;
    for (let i = 0; i < 200 && !url; i++) {
      if (existsSync(portFile)) {
        const [port, wsPath] = readFileSync(portFile, "utf8").trim().split("\n");
        if (port && wsPath) url = `ws://127.0.0.1:${port}${wsPath}`;
      }
      if (!url) await Promise.race([sleep(50), startFailure]);
    }
    if (!url) throw new Error("Chrome did not publish its DevTools port.");
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let nextId = 1;
    const pending = new Map();
    const listeners = [];
    // A connection that drops mid-run fails every waiting call and event wait instead of hanging.
    const fail = (reason) => {
      for (const { reject } of pending.values()) reject(new Error(reason));
      pending.clear();
      for (const { reject } of listeners.splice(0)) reject(new Error(reason));
    };
    ws.onerror = () => fail("The DevTools connection failed.");
    ws.onclose = () => fail("The DevTools connection closed before the cards were rendered.");
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].method === message.method && listeners[i].sessionId === message.sessionId) {
          listeners.splice(i, 1)[0].resolve(message.params);
        }
      }
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const waitFor = (method, sessionId) => new Promise((resolve, reject) => listeners.push({ method, sessionId, resolve, reject }));
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };
    await work({
      async shoot(fileUrl, { width, height, format, quality }) {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        const loaded = waitFor("Page.loadEventFired", sessionId);
        await send("Page.navigate", { url: fileUrl }, sessionId);
        await loaded;
        await evaluate("document.fonts.ready.then(() => window.__fit())");
        await sleep(150);
        const shot = await send("Page.captureScreenshot", { format, ...(format === "webp" ? { quality } : {}), captureBeyondViewport: false }, sessionId);
        return Buffer.from(shot.data, "base64");
      },
    });
    ws.onclose = null;
    ws.close();
  } finally {
    // Chrome keeps writing to its profile until it has exited; a process that never started has
    // no exit to wait for.
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await exited;
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

/* ---- Main ----------------------------------------------------------------------------------- */

const posts = POSTS.filter((post) => only.length === 0 || only.includes(post.slug));
if (posts.length === 0) {
  console.error(`No post matches ${only.join(", ")}.`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), "blog-cards-html-"));
try {
  await withChrome(async ({ shoot }) => {
    for (const post of posts) {
      const og = path.join(work, `${post.slug}-og.html`);
      const card = path.join(work, `${post.slug}-card.html`);
      await writeFile(og, ogHtml(post));
      await writeFile(card, cardHtml(post));
      const png = await shoot(pathToFileURL(og).href, { width: 1200, height: 630, format: "png" });
      const webp = await shoot(pathToFileURL(card).href, { width: 1200, height: 600, format: "webp", quality: 82 });
      await writeFile(path.join(outDir, `${post.slug}.png`), png);
      await writeFile(path.join(outDir, `${post.slug}.webp`), webp);
      console.log(`${post.slug}: ${(png.length / 1024).toFixed(0)} KB png, ${(webp.length / 1024).toFixed(0)} KB webp`);
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
