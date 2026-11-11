import { fontUnicodeMap } from "./fontFix.ts";
import { cutLabel, stemOf, traitKey, userFamilyName, type FaceKind, type FaceStyle, type FaceTraits } from "./fontNames.ts";
import type { Catalog, CatalogFile } from "./supplementCatalog.ts";
import { loadUserFonts, userFontFor, type UserFont } from "./userFonts.ts";

// Fonts that supply the characters a page's embedded font lacks. An embedded font is nearly always
// a subset, so a character the document never used has no glyph in it: the browser would draw a
// typed one in a system face, and the export would have to paint the edit. A supplement is a full
// font of the same design where one exists: one of the bundled open fonts below (Google's
// metric-compatible replacements for the common proprietary faces, and the open faces web-printed
// PDFs embed), or, for a face nothing bundled matches, the font installed on the user's machine
// (`localFonts.ts`) or a font file the user added (`userFonts.ts`). Each is registered under a
// family name of its own, declared regular whatever its cut, so a run can list it after the
// embedded face without the browser also emboldening or slanting either.

// How a supplement relates to the page's font: the same typeface, a design that matches its
// metrics, a face of the same kind only, the font installed on the user's machine, or the user's
// own file.
export type Relation = "same" | "close" | "kind" | "local" | "user";

export type Supplement = {
  // The cut, as the user knows it: "Tinos Bold", "Noto Sans Medium Italic".
  label: string;
  relation: Relation;
  // The CSS family the cut is registered under.
  family: string;
  covers(code: number): boolean;
  // The font bytes (TrueType or CFF, never WOFF) that hold the code point, with a key an embedding
  // of them can be cached by; null when no file of the supplement has the character.
  source(code: number): Promise<{ key: string; bytes: Uint8Array } | null>;
};

// What `fallbackFamily` knows about a page font when it asks for the font's supplement: the name
// without its subset prefix, what the name and pdf.js say about its cut (`weight` as
// `weightOfName` reads it), and its kind.
export type FontAsk = { name: string; bold: boolean; italic: boolean; weight: number; kind: FaceKind };

// A font the user can supply for a page font: the font's PostScript name as the PDF gives it,
// without the subset prefix, and the key the font is kept under.
export type FontOffer = { pdfFont: string; name: string; key: string };

type Bundled = { id: string; label: string; kind: FaceKind; names: RegExp; same: RegExp };

// The bundled families, by the names of the fonts they stand in for. Tinos, Arimo and Cousine are
// the designs the Liberation fonts are built from, with the metrics of Times New Roman, Arial and
// Courier New; Carlito, Caladea and Gelasio match Calibri, Cambria and Georgia; Inter is the
// nearest open design to San Francisco, the macOS system font (".SFNS-Regular", ".SFUIText",
// "SFPro"), which every document printed from a Mac app is set in. The Noto faces take whatever
// matches nothing by name, by kind.
const BUNDLED: Bundled[] = [
  { id: "tinos", label: "Tinos", kind: "serif", names: /times|nimbus\s*rom|thorndale|liberation\s*serif|tinos/i, same: /liberation\s*serif|tinos/i },
  {
    id: "arimo",
    label: "Arimo",
    kind: "sans",
    names: /arial(?!\s*(?:narrow|black|rounded|unicode))|helvetica|nimbus\s*san|albany|liberation\s*sans|arimo/i,
    same: /liberation\s*sans|arimo/i,
  },
  {
    id: "inter",
    label: "Inter",
    kind: "sans",
    names: /(?:^|[^a-z])sf(?:ns|pro|ui)(?!\s*(?:mono|rounded|compact))|san\s*francisco|applesystemuifont|(?:^|[^a-z])inter(?![a-z])/i,
    same: /(?:^|[^a-z])inter(?![a-z])/i,
  },
  { id: "cousine", label: "Cousine", kind: "mono", names: /courier|nimbus\s*mon|cumberland|liberation\s*mono|cousine/i, same: /liberation\s*mono|cousine/i },
  { id: "carlito", label: "Carlito", kind: "sans", names: /calibri|carlito/i, same: /carlito/i },
  { id: "caladea", label: "Caladea", kind: "serif", names: /cambria|caladea/i, same: /caladea/i },
  { id: "gelasio", label: "Gelasio", kind: "serif", names: /georgia|gelasio/i, same: /gelasio/i },
  { id: "roboto", label: "Roboto", kind: "sans", names: /roboto(?!\s*(?:slab|mono|serif|condensed|flex))/i, same: /roboto/i },
  { id: "open-sans", label: "Open Sans", kind: "sans", names: /open\s*sans/i, same: /open\s*sans/i },
  { id: "lato", label: "Lato", kind: "sans", names: /(?:^|[^a-z])lato(?![a-z])/i, same: /lato/i },
  { id: "noto-sans-mono", label: "Noto Sans Mono", kind: "mono", names: /noto\s*(?:sans\s*)?mono/i, same: /noto/i },
  { id: "noto-serif", label: "Noto Serif", kind: "serif", names: /noto\s*serif(?!\s*(?:display|jp|kr|sc|tc|cjk))/i, same: /noto/i },
  {
    id: "noto-sans",
    label: "Noto Sans",
    kind: "sans",
    names: /noto\s*sans(?!\s*(?:jp|kr|sc|tc|cjk|display|symbols|math|arabic|devanagari|hebrew))/i,
    same: /noto/i,
  },
];

const BY_KIND: Record<FaceKind, string> = { serif: "noto-serif", sans: "noto-sans", mono: "noto-sans-mono" };

type BundledCut = { font: Bundled; relation: "same" | "close" | "kind"; weight: number; style: FaceStyle; family: string };

// What was chosen for a page font, by pdf.js font name. `standIn` marks a font the PDF names
// without embedding it, whose every character the supplement sets (`standInFamilies`).
type Choice = { ask: FontAsk; traits: FaceTraits; bundled: BundledCut | null; standIn: boolean };

const choices = new Map<string, Choice>();
let catalogPromise: Promise<Catalog | null> | null = null;
let catalogValue: Catalog | null = null;
const registeredFamilies = new Set<string>();
const sfntCache = new Map<string, Promise<Uint8Array | null>>();

function loadCatalog(): Promise<Catalog | null> {
  if (!catalogPromise) {
    catalogPromise = import("./supplementCatalog.ts")
      .then((module) => {
        catalogValue = module.catalog();
        return catalogValue;
      })
      .catch(() => null);
  }
  return catalogPromise;
}

// Registers the supplement of a page font and resolves to the CSS families to list right after
// the embedded face: the family a font the user adds for this face goes by (listed whether or not
// one has been added yet, so adding one takes effect at once), then the bundled cut.
export async function supplementFamilies(loadedName: string, ask: FontAsk): Promise<string[]> {
  if (typeof document === "undefined") return [];
  const traits: FaceTraits = { stem: stemOf(ask.name), bold: ask.bold, italic: ask.italic };
  const [catalog] = await Promise.all([loadCatalog(), loadUserFonts()]);
  const bundled = catalog ? chooseBundled(catalog, ask) : null;
  if (catalog && bundled) registerBundled(catalog, bundled);
  choices.set(loadedName, { ask, traits, bundled, standIn: false });
  return [userFamilyName(traitKey(traits)), ...(bundled ? [bundled.family] : [])];
}

// A PDF may name a font without embedding it (most often one of the standard fonts every reader
// has, Times, Helvetica and Courier); pdf.js then draws it in an installed face, and there are no
// bytes to write an edit with. Such a font is stood in for as a whole by its supplement: the font
// the user supplied for the face (the installed copy, or a file), else the bundled design with the
// same metrics, in the font's own cut, so the editor shows and the export embeds the same face.
// Resolves to the families to set the font's text in, as `supplementFamilies` does, or null when
// nothing of the font's design stands in for it: a Noto face of the same kind only would change
// every letter, so such text keeps the installed face and is painted on download.
export async function standInFamilies(loadedName: string, ask: FontAsk): Promise<string[] | null> {
  if (typeof document === "undefined") return null;
  const traits: FaceTraits = { stem: stemOf(ask.name), bold: ask.bold, italic: ask.italic };
  const key = traitKey(traits);
  const [catalog] = await Promise.all([loadCatalog(), loadUserFonts()]);
  const chosen = catalog ? chooseBundled(catalog, ask) : null;
  const bundled = chosen && chosen.relation !== "kind" ? chosen : null;
  if (!bundled && !userFontFor(key)) return null;
  if (catalog && bundled) registerBundled(catalog, bundled);
  choices.set(loadedName, { ask, traits, bundled, standIn: true });
  return [userFamilyName(key), ...(bundled ? [bundled.family] : [])];
}

// The face that stands in for a page font the PDF does not embed, with the name the PDF gives the
// font (without a subset prefix), by pdf.js font name; null for an embedded font, or one nothing
// stands in for.
export function standInOf(loadedName: string): (Supplement & { pageFont: string }) | null {
  const choice = choices.get(loadedName);
  const supplement = choice?.standIn ? supplementOf(loadedName) : null;
  return choice && supplement ? { ...supplement, pageFont: choice.ask.name } : null;
}

function chooseBundled(catalog: Catalog, ask: FontAsk): BundledCut | null {
  const named = ask.name ? BUNDLED.find((font) => font.names.test(ask.name)) : undefined;
  const font = named ?? BUNDLED.find((item) => item.id === BY_KIND[ask.kind]);
  if (!font) return null;
  const relation = named ? (named.same.test(ask.name) ? "same" : "close") : "kind";
  const cut = nearestCut(catalog, font.id, ask.weight, ask.italic ? "italic" : "normal");
  if (!cut) return null;
  return { font, relation, weight: cut.weight, style: cut.style, family: `stet-supp-${font.id}-${cut.weight}-${cut.style}` };
}

// The cut of a bundled family nearest the wanted weight, in the wanted style when the family has
// it (Noto Sans Mono has no italic) and the upright otherwise. A tie goes to the lighter cut.
function nearestCut(catalog: Catalog, id: string, weight: number, style: FaceStyle): { weight: number; style: FaceStyle } | null {
  const cuts = catalog.files.filter((file) => file.id === id);
  const styled = cuts.filter((file) => file.style === style);
  const pool = (styled.length > 0 ? styled : cuts).sort((a, b) => a.weight - b.weight);
  let best: CatalogFile | undefined;
  for (const file of pool) {
    if (!best || Math.abs(file.weight - weight) < Math.abs(best.weight - weight)) best = file;
  }
  return best ? { weight: best.weight, style: best.style } : null;
}

function rangeCss(ranges: [number, number][]): string {
  const hex = (code: number) => code.toString(16).toUpperCase().padStart(4, "0");
  return ranges.map(([start, end]) => (start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`)).join(", ");
}

// One FontFace per file of the cut, each limited to its file's Unicode range, so the browser
// fetches a file only when a character in it is shown.
function registerBundled(catalog: Catalog, cut: BundledCut): void {
  if (registeredFamilies.has(cut.family) || typeof FontFace === "undefined") return;
  registeredFamilies.add(cut.family);
  for (const file of cutFiles(catalog, cut)) {
    const ranges = catalog.ranges.get(`${file.id}/${file.subset}`);
    if (!ranges || ranges.length === 0) continue;
    try {
      const face = new FontFace(cut.family, `url("${file.url}") format("woff")`, { unicodeRange: rangeCss(ranges) });
      document.fonts.add(face);
    } catch {
      // A file the browser cannot declare adds nothing; the system faces follow in the list.
    }
  }
}

function cutFiles(catalog: Catalog, cut: BundledCut): CatalogFile[] {
  return catalog.files.filter((file) => file.id === cut.font.id && file.weight === cut.weight && file.style === cut.style);
}

function inRanges(ranges: [number, number][] | undefined, code: number): boolean {
  return !!ranges && ranges.some(([start, end]) => code >= start && code <= end);
}

// The supplement of a page font, by pdf.js font name: a font the user added for the face, else
// the bundled cut. Null for a font the page was not read with, or a font without bytes of its own.
export function supplementOf(loadedName: string): Supplement | null {
  const choice = choices.get(loadedName);
  if (!choice) return null;
  const key = traitKey(choice.traits);
  const user = userFontFor(key);
  if (user) return userSupplement(user, key);
  const catalog = catalogValue;
  const cut = choice.bundled;
  if (!cut || !catalog) return null;
  const files = cutFiles(catalog, cut);
  const fileFor = (code: number) => files.find((file) => inRanges(catalog.ranges.get(`${file.id}/${file.subset}`), code));
  return {
    label: cutLabel(cut.font.label, cut.weight, cut.style),
    relation: cut.relation,
    family: cut.family,
    covers: (code) => fileFor(code) !== undefined,
    source: async (code) => {
      const file = fileFor(code);
      if (!file) return null;
      const bytes = await sfntOf(file.url);
      return bytes ? { key: file.url, bytes } : null;
    },
  };
}

function userSupplement(user: UserFont, key: string): Supplement {
  return {
    label: user.label,
    relation: user.source === "local" ? "local" : "user",
    family: userFamilyName(key),
    covers: (code) => user.cmap.has(code),
    source: async (code) => (user.cmap.has(code) ? { key: `user:${user.id}`, bytes: user.bytes } : null),
  };
}

// Whether a font the user supplies (an installed one, or a file) would stand in for a page font:
// when nothing bundled is the page's own typeface (its characters come from a design with the
// same metrics, from a Noto face of its kind, or from nothing) and the user has not supplied one
// already. The font itself beats the nearest open design: a reader with Times New Roman installed
// gets its digits, not Tinos's.
export function fontOffer(loadedName: string): FontOffer | null {
  const choice = choices.get(loadedName);
  if (!choice) return null;
  const key = traitKey(choice.traits);
  if (userFontFor(key)) return null;
  if (choice.bundled?.relation === "same") return null;
  return { pdfFont: loadedName, name: choice.ask.name, key };
}

// The sfnt (TrueType or CFF) bytes behind a bundled font file, fetched once. Fontsource serves
// WOFF, which wraps each table deflated; the tables come out so the same bytes can be read for
// their cmap and embedded in a PDF.
function sfntOf(url: string): Promise<Uint8Array | null> {
  let pending = sfntCache.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const sfnt = await unwrapWoff(bytes);
      return sfnt && fontUnicodeMap(sfnt).size > 0 ? sfnt : null;
    })().catch(() => null);
    sfntCache.set(url, pending);
  }
  return pending;
}

async function unwrapWoff(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length < 12) return null;
  if (tagAt(bytes, 0) !== "wOFF") return bytes;
  if (bytes.length < 44) return null;
  const count = read16(bytes, 12);
  const tables: { tag: string; data: Uint8Array; checksum: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 44 + index * 20;
    if (at + 20 > bytes.length) return null;
    const offset = read32(bytes, at + 4);
    const compLength = read32(bytes, at + 8);
    const origLength = read32(bytes, at + 12);
    if (offset + compLength > bytes.length) return null;
    const raw = bytes.subarray(offset, offset + compLength);
    const data = compLength < origLength ? await inflate(raw, origLength) : raw;
    if (!data || data.length !== origLength) return null;
    tables.push({ tag: tagAt(bytes, at), data, checksum: read32(bytes, at + 16) });
  }
  let cursor = 12 + count * 16;
  const placed = tables.map((table) => {
    const start = cursor;
    cursor = (cursor + table.data.length + 3) & ~3;
    return { ...table, start };
  });
  const out = new Uint8Array(cursor);
  out.set(bytes.subarray(4, 8), 0);
  write16(out, 4, count);
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= count) {
    searchRange *= 2;
    entrySelector += 1;
  }
  searchRange *= 16;
  write16(out, 6, searchRange);
  write16(out, 8, entrySelector);
  write16(out, 10, count * 16 - searchRange);
  placed.forEach((table, index) => {
    const at = 12 + index * 16;
    for (let char = 0; char < 4; char += 1) out[at + char] = table.tag.charCodeAt(char);
    write32(out, at + 4, table.checksum);
    write32(out, at + 8, table.start);
    write32(out, at + 12, table.data.length);
    out.set(table.data, table.start);
  });
  return out;
}

async function inflate(data: Uint8Array, size: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return out.length === size ? out : null;
}

function tagAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

function read16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function read32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0
  );
}

function write16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >> 8) & 255;
  bytes[offset + 1] = value & 255;
}

function write32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 255;
  bytes[offset + 1] = (value >>> 16) & 255;
  bytes[offset + 2] = (value >>> 8) & 255;
  bytes[offset + 3] = value & 255;
}
