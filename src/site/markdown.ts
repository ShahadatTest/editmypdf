import { Marked, type RendererThis, type Token, type TokenizerThis, type Tokens } from "marked";
import { publicUrl, routeHref } from "../data/product.ts";
import { ICONS, iconHtml } from "./blogIcons.ts";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:[a-z]+|#\d+);/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/* ---- Inline shortcodes -------------------------------------------------------

   :bulb:         a Twemoji image from public/emojis (the set the editor's emoji picker ships),
                  so an emoji looks the same on every platform. The names are below.
   {{scissors}}   a Lucide icon, inline, as an SVG that takes the text colour. The icons are the
                  ones listed in blogIcons.ts; run scripts/blog-icons.mjs after adding one.
   ---------------------------------------------------------------------------- */

const EMOJI: Record<string, string> = {
  bulb: "1f4a1",
  sparkles: "2728",
  check: "2705",
  cross: "274c",
  question: "2753",
  exclamation: "2757",
  lock: "1f512",
  unlock: "1f513",
  pin: "1f4cc",
  memo: "1f4dd",
  chart: "1f4ca",
  target: "1f3af",
  boom: "1f4a5",
  fire: "1f525",
  thinking: "1f914",
  robot: "1f916",
  rocket: "1f680",
  globe: "1f30d",
  laptop: "1f4bb",
  art: "1f3a8",
  envelope: "2709",
  wave: "1f44b",
  thumbsup: "1f44d",
  clap: "1f44f",
  muscle: "1f4aa",
  handshake: "1f91d",
  party: "1f389",
  trophy: "1f3c6",
  zap: "26a1",
  star: "2b50",
  hundred: "1f4af",
  dizzy: "1f4ab",
  grimace: "1f62c",
  sweat: "1f605",
  eyeroll: "1f644",
  confused: "1f615",
  pensive: "1f614",
  "raised-hand": "1f590",
  "point-right": "1f449",
  "point-down": "1f447",
  heart: "2764",
  bell: "1f514",
  money: "1f4b0",
  megaphone: "1f4e2",
  gift: "1f381",
  snowflake: "2744",
  coffee: "2615",
  ghost: "1f47b",
  skull: "1f480",
  bee: "1f41d",
  turtle: "1f422",
  house: "1f3e0",
  ok: "1f44c",
  pray: "1f64f",
  innocent: "1f607",
  smile: "1f642",
  "star-struck": "1f929",
  "raised-hands": "1f64c",
  airplane: "2708",
};

function emojiChar(id: string): string {
  return String.fromCodePoint(...id.split("-").map((part) => parseInt(part, 16)));
}

function emojiHtml(name: string): string {
  const id = EMOJI[name];
  return `<img class="bp-emoji" src="${publicUrl(`emojis/${id}.png`)}" alt="${emojiChar(id)}" width="72" height="72" draggable="false">`;
}

type EmojiToken = { type: "emoji"; raw: string; name: string };
type IconToken = { type: "icon"; raw: string; name: string };

const emojiExtension = {
  name: "emoji",
  level: "inline" as const,
  start(src: string) {
    return src.match(/:[a-z][a-z0-9-]*:/)?.index;
  },
  tokenizer(src: string): EmojiToken | undefined {
    const match = /^:([a-z][a-z0-9-]*):/.exec(src);
    if (!match || !(match[1] in EMOJI)) return undefined;
    return { type: "emoji", raw: match[0], name: match[1] };
  },
  renderer(token: Token) {
    return emojiHtml((token as EmojiToken).name);
  },
};

const iconExtension = {
  name: "icon",
  level: "inline" as const,
  start(src: string) {
    return src.indexOf("{{");
  },
  tokenizer(src: string): IconToken | undefined {
    const match = /^\{\{([a-z][a-z0-9-]*)\}\}/.exec(src);
    if (!match || !(match[1] in ICONS)) return undefined;
    return { type: "icon", raw: match[0], name: match[1] };
  },
  renderer(token: Token) {
    return iconHtml((token as IconToken).name);
  },
};

/* ---- Block directives --------------------------------------------------------

   ::: kind Optional title with inline Markdown
   body, in Markdown
   :::

   kind is one of the callouts below (a tinted aside with an icon and a title), or
     cards   a bullet list drawn as a grid of cards; an item is "{{icon}} **Title** text" or
             ":emoji: **Title** text", and the icon, title and text each take their place;
     steps   a numbered list drawn as big-numbered steps, "**Title** text" per item;
     pair    two columns, split at a "---" line; the title "Left | Right" labels them.
   ---------------------------------------------------------------------------- */

const CALLOUTS: Record<string, { title: string; icon: string }> = {
  plain: { title: "In plain words", icon: "lightbulb" },
  note: { title: "Note", icon: "info" },
  tip: { title: "Tip", icon: "sparkles" },
  warn: { title: "Watch out", icon: "triangle-alert" },
  story: { title: "Field note", icon: "message-circle" },
  good: { title: "Result", icon: "circle-check" },
  bad: { title: "The catch", icon: "circle-x" },
};

type DirectiveToken = {
  type: "directive";
  raw: string;
  kind: string;
  titleTokens: Token[];
  tokens: Token[];
};

const DIRECTIVE = /^::: *([a-z][a-z-]*)(?:[ \t]+([^\n]*))?\n([\s\S]*?)\n:::[ \t]*(?:\n+|$)/;

// The pieces of a card or step: a leading icon or emoji, the first bold run as the title, the rest.
function splitItem(html: string): { icon: string; title: string; body: string } {
  let rest = html.trim();
  let icon = "";
  const lead = /^(<p>)?\s*(<svg class="bp-icon"[\s\S]*?<\/svg>|<img class="bp-emoji"[^>]*>)\s*/.exec(rest);
  if (lead) {
    icon = lead[2];
    rest = (lead[1] ?? "") + rest.slice(lead[0].length);
  }
  // A bold lead-in becomes the title only when what follows starts a sentence of its own;
  // "**Tracked small caps** reach pdf.js…" keeps its bold words inline.
  let title = "";
  const strong = /^(<p>)?\s*<strong>([\s\S]*?)<\/strong>[\s:.—–-]*/.exec(rest);
  const after = strong ? rest.slice(strong[0].length).replace(/^<\/?p>\s*/, "") : "";
  if (strong && (after === "" || /^[A-Z0-9"“‘'<]/.test(after))) {
    title = strong[2];
    rest = (strong[1] ?? "") + rest.slice(strong[0].length);
  }
  rest = rest.replace(/^<p>\s*<\/p>/, "").trim();
  if (rest && !rest.startsWith("<")) rest = `<p>${rest}</p>`;
  return { icon, title, body: rest };
}

const directiveExtension = {
  name: "directive",
  level: "block" as const,
  start(src: string) {
    return src.match(/(^|\n):::/)?.index;
  },
  tokenizer(this: TokenizerThis, src: string): DirectiveToken | undefined {
    const match = DIRECTIVE.exec(src);
    if (!match) return undefined;
    const [raw, kind, title = "", body] = match;
    return {
      type: "directive",
      raw,
      kind,
      titleTokens: title ? this.lexer.inlineTokens(title.trim()) : [],
      tokens: this.lexer.blockTokens(body, []),
    };
  },
  renderer(this: RendererThis, token: Token) {
    const { kind, titleTokens, tokens } = token as DirectiveToken;
    const parse = (list: Token[]) => this.parser.parse(list);
    const items = (list: Token[]) => {
      const found = list.find((child): child is Tokens.List => child.type === "list");
      return found ? found.items.map((item) => splitItem(parse(item.tokens))) : [];
    };

    if (kind === "cards") {
      const cards = items(tokens)
        .map(
          ({ icon, title, body }) =>
            `<div class="bp-mcard">${icon ? `<span class="bp-mcard-tile">${icon}</span>` : ""}<div class="bp-mcard-text">${title ? `<p class="bp-mcard-title">${title}</p>` : ""}${body}</div></div>`,
        )
        .join("");
      return `<div class="bp-cards">${cards}</div>\n`;
    }

    if (kind === "steps") {
      const steps = items(tokens)
        .map(
          ({ icon, title, body }, index) =>
            `<li><span class="bp-step-n">${icon || index + 1}</span><div class="bp-step-text">${title ? `<p class="bp-step-title">${title}</p>` : ""}${body}</div></li>`,
        )
        .join("");
      return `<ol class="bp-steps">${steps}</ol>\n`;
    }

    if (kind === "pair") {
      const split = tokens.findIndex((child) => child.type === "hr");
      const halves = split === -1 ? [tokens, []] : [tokens.slice(0, split), tokens.slice(split + 1)];
      const labels = (this.parser.parseInline(titleTokens) as string).split("|").map((label: string) => label.trim());
      const columns = halves
        .map((half, index) => `<div class="bp-pair-col">${labels[index] ? `<p class="bp-pair-label">${labels[index]}</p>` : ""}${parse(half)}</div>`)
        .join("");
      return `<div class="bp-pair">${columns}</div>\n`;
    }

    const callout = CALLOUTS[kind];
    if (!callout) throw new Error(`Unknown directive "${kind}"`);
    // A title that starts with an emoji or icon shows that instead of the kind's own icon.
    const leadsWithGlyph = titleTokens[0]?.type === "emoji" || titleTokens[0]?.type === "icon";
    const glyph = leadsWithGlyph ? this.parser.parseInline(titleTokens.slice(0, 1)) : iconHtml(callout.icon, "bp-icon bp-callout-icon");
    const rest = leadsWithGlyph ? titleTokens.slice(1) : titleTokens;
    const title = rest.length ? (this.parser.parseInline(rest) as string).trim() : callout.title;
    return `<aside class="bp-callout bp-callout-${kind}"><p class="bp-callout-title">${glyph}<span>${title}</span></p><div class="bp-callout-body">${parse(tokens)}</div></aside>\n`;
  },
};

// Renders trusted Markdown written in this repository's data files. Raw HTML inside the Markdown
// (figures, small diagrams) passes through unchanged.
export const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }: Tokens.Heading) {
      const text = this.parser.parseInline(tokens);
      return `<h${depth} id="${slugify(text)}">${text}</h${depth}>\n`;
    },
    // ![alt](/blog/file.webp#1600x1200 "Caption"): an image from public/ as a figure. The hash
    // carries the file's pixel size, so the browser reserves its box before it loads.
    image({ href, title, text }: Tokens.Image) {
      const [path, size = ""] = href.split("#");
      const [width, height] = size.split("x").map(Number);
      const src = path.startsWith("/") ? publicUrl(path) : path;
      const dims = width && height ? ` width="${width}" height="${height}"` : "";
      const img = `<img class="bp-image" src="${src}" alt="${text}"${dims} loading="lazy" decoding="async">`;
      return title ? `<figure class="bp-figure">${img}<figcaption>${title}</figcaption></figure>` : img;
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const external = /^https?:\/\//.test(href);
      // A link to a page of the site is written as its route ("/compare"); the base path is added here,
      // and Markdown.tsx hands clicks on it to the router.
      const internal = href.startsWith("/") && !href.startsWith("//");
      const attrs = [
        `href="${internal ? routeHref(href) : href}"`,
        title ? `title="${title}"` : "",
        external ? 'rel="noopener noreferrer" target="_blank"' : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<a ${attrs}>${text}</a>`;
    },
  },
  extensions: [directiveExtension, emojiExtension, iconExtension],
});

// The entities marked writes for quotes and the like, back to characters, for text React escapes itself.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name]);
}

export type Heading = { id: string; text: string; depth: 2 | 3 };

// The second- and third-level headings of a post, with the ids the renderer above gives them, for
// a table of contents built before the Markdown reaches the DOM (so it prerenders too).
export function headingsOf(markdown: string): Heading[] {
  return marked
    .lexer(markdown)
    .filter((token): token is Tokens.Heading => token.type === "heading" && (token.depth === 2 || token.depth === 3))
    .map((token) => {
      const html = marked.parseInline(token.text, { async: false }) as string;
      return { id: slugify(html), text: decodeEntities(html.replace(/<[^>]+>/g, "")).trim(), depth: token.depth as 2 | 3 };
    });
}

export function wordCount(markdown: string): number {
  return markdown
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^:::.*$/gm, " ")
    .replace(/:[a-z][a-z0-9-]*:|\{\{[a-z0-9-]+\}\}/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

export function readingTime(markdown: string): number {
  return Math.max(1, Math.round(wordCount(markdown) / 220));
}
