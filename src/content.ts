import { AnnotationMode, OPS, Util, type PDFPageProxy, type PageViewport } from "pdfjs-dist";
import { collectGlyphUse, editableFamily, familyBytes, missingGlyphs, rememberCoverage, type GlyphUse } from "./fontFix.ts";
import { bareName, traitsOfName, weightOfName, type FaceKind, type FaceTraits } from "./fontNames.ts";
import { fontOffer, standInFamilies, standInOf, supplementFamilies, supplementOf, type FontOffer, type Relation } from "./supplementFonts.ts";
import { measureWidth } from "./textLayout.ts";
import { loadPdf, type LoadedPdf } from "./pdf.ts";
import {
  collectType3Glyphs,
  linkType3Documents,
  registerType3Fonts,
  type3FaceBytes,
  type3Families,
  type Type3Glyph,
  type Type3Member,
} from "./type3Font.ts";
import type { PatchAnnotation, Point, TextAlign, TextSpan } from "./types.ts";

export type ContentKind = "text" | "heading" | "paragraph" | "table" | "line" | "image" | "shape";

// A styled run of a content element, with the page box its glyphs occupy so its colour can be
// read from the rendered page.
export type ContentSpan = TextSpan & { box: { x: number; y: number; w: number; h: number } };

export type ContentElement = {
  id: string;
  page: number;
  kind: ContentKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  // CSS font-family list that reproduces the PDF face, usually the font pdf.js registered for the page.
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  fontSize: number;
  ascent: number;
  color: string;
  baseline: number;
  // Baseline-to-baseline distance for a paragraph; the box height for a single run.
  lineHeight: number;
  align: TextAlign;
  // First-line indent of a paragraph, in page units; negative for a hanging indent, where every
  // line but the first starts that far in.
  indent: number;
  // Extra advance after every character, in page units, that the PDF gave the text beyond the
  // face's own glyph widths.
  letterSpacing: number;
  // Extra advance after every space, in page units.
  wordSpacing: number;
  // Offsets of the newlines in `text` that only break because the column ran out of room.
  softBreaks: number[];
  // Extra word spacing of each original line of a paragraph, in page units.
  lineGaps: number[];
  // How far below an even line pitch each original line of a paragraph sits, in page units.
  lineOffsets: number[];
  // How far in from the block's left edge each original line of a paragraph starts, in page units.
  lineIndents: number[];
  // pdf.js name of the font the text was set in; identifies the face across runs.
  pdfFont: string;
  // Styled runs when the text mixes faces (a bold word inside regular text), concatenating to
  // `text`; empty when the whole element is set in one face.
  spans: ContentSpan[];
};

export function isTextContent(kind: ContentKind): boolean {
  return kind === "text" || kind === "heading" || kind === "paragraph";
}

const LABEL: Record<ContentKind, string> = {
  text: "Text",
  heading: "Heading",
  paragraph: "Paragraph",
  table: "Table",
  line: "Line",
  image: "Image",
  shape: "Shape",
};

const DETAIL: Record<ContentKind, string> = {
  text: "Click the line and type. It keeps its font, size and colour",
  heading: "Click the heading and type. It keeps its font, size and colour",
  paragraph: "Click the paragraph and type. Text wraps inside the paragraph and keeps its font, size and colour",
  table: "Drag to move it, or use the handles to resize",
  line: "Drag to move it, or use the handles to resize",
  image: "Drag to move it, or use the handles to resize",
  shape: "Drag to move it, or use the handles to resize",
};

export function contentLabel(kind: ContentKind): string {
  return LABEL[kind];
}

export function contentDetail(kind: ContentKind): string {
  return DETAIL[kind];
}

type PdfFontStyle = { ascent?: number; vertical?: boolean; fontFamily?: string };

type TextRun = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
};

type Box = { x: number; y: number; w: number; h: number };

// How pdf.js draws a font: the CSS face, and the scale that turns its glyph advances into text
// space (the font matrix's first entry, 1/1000 for nearly every font).
type Face = { family: string; weight: number; style: "normal" | "italic"; unitScale: number };

type Run = Box & {
  baseline: number;
  size: number;
  text: string;
  angle: number;
  pdfFont: string;
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  ascent: number;
  color: string;
  letterSpacing: number;
  wordSpacing: number;
};

// A line of text. Its face fields describe the dominant run; `spans` lists every run in order.
type Line = Box & {
  baseline: number;
  size: number;
  text: string;
  heading: boolean;
  pdfFont: string;
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  ascent: number;
  color: string;
  letterSpacing: number;
  wordSpacing: number;
  spans: ContentSpan[];
};

// The spacing state of the content stream at one drawn glyph, with the glyph's own advance in
// the font's units.
type GlyphState = {
  text: string;
  charSpacing: number;
  wordSpacing: number;
  fontSize: number;
  font: string;
  width: number;
  // Index of the operator that drew the glyph: its place in the page's paint order.
  op: number;
  // How many two-byte space codes were drawn before this glyph since the text position was last
  // set. pdf.js adds the word spacing to those when it reads text positions but not when it draws
  // them, so the positions it reports drift right by that many word spacings.
  phantom: number;
  // The fill colour the glyph was drawn in, as a hex string.
  color: string;
  // Whether the glyph was filled and stroked (text render mode 2): how a generator emboldens a face
  // it has no bold for, so the text reads as bold although its font is the regular one.
  bold: boolean;
};

// Something opaque the page painted (an image, a filled shape) and when.
type Cover = Box & { order: number };

// What the content stream says about one text item: the state its first glyph was drawn in, how
// many of its letters were matched to glyphs, those glyphs' summed advance in text space at the
// selected font size, and the item's text as the stream spells it (letters, with a space only
// where the stream drew one).
type ItemSpacing = {
  state: GlyphState;
  letters: number;
  advance: number;
  text: string;
  // Two-byte space codes inside the item, whose word spacing pdf.js wrongly added to its width.
  phantomInside: number;
  // Space glyphs the stream drew between the item's letters, and their summed advance in text
  // space at the selected size.
  spaces: number;
  spaceAdvance: number;
};

type TextFace = Pick<
  ContentElement,
  | "fontFamily"
  | "fontWeight"
  | "fontStyle"
  | "fontSize"
  | "ascent"
  | "color"
  | "baseline"
  | "lineHeight"
  | "align"
  | "indent"
  | "letterSpacing"
  | "wordSpacing"
  | "pdfFont"
>;

// The subset of pdf.js's font object that decides how the text is drawn on the canvas. The name
// and the serif and monospace flags are extra properties, present because the document is opened
// with fontExtraProperties.
type PdfFontObject = {
  loadedName?: string;
  fallbackName?: string;
  name?: string;
  isSerifFont?: boolean;
  isMonospace?: boolean;
  bold?: boolean;
  italic?: boolean;
  black?: boolean;
  isType3Font?: boolean;
  systemFontInfo?: { css?: string } | null;
  data?: Uint8Array | null;
  fontMatrix?: number[] | null;
};

type ObjectStore = {
  has(id: string): boolean;
  get(id: string, callback?: (value: unknown) => void): unknown;
};

const IDENTITY = [1, 0, 0, 1, 0, 0];

const contentCache = new WeakMap<PDFPageProxy, Promise<ContentElement[]>>();

// The bytes of a font a page draws with, as pdf.js converted them: the copy with the corrected
// cmap when the editor registered one, and the converted font itself. Both null for a font pdf.js
// drew without bytes (a system font).
export type PageFont = {
  data: Uint8Array | null;
  fixed: Uint8Array | null;
  type3: boolean;
  // The family of the face rebuilt from a Type3 font, whose latest bytes `type3FaceBytes` gives.
  family?: string;
  // The name the PDF gives the font (its BaseFont, subset prefix included); empty for a Type3 font.
  name: string;
};

export { traitsOfName };
export type { FaceTraits };

// The traits of a font of a page that has been read, by pdf.js font name; null for a Type3 font
// (its name says nothing about its look) or a font the page was not read with.
export function faceTraits(page: PDFPageProxy | undefined, pdfFont: string): FaceTraits | null {
  const info = page ? fontCache.get(page)?.get(pdfFont) : undefined;
  if (!info?.name) return null;
  return traitsOfName(info.name);
}

// The scan of a document's Type3 fonts in progress, which the reader waits a moment for before
// it builds a page's faces, so the first page's faces already hold the letters the other pages
// drew with the same typeface.
let type3Scan: Promise<void> | null = null;

// Reads the Type3 fonts of every page of a document into their pool, in the background, from a
// second copy of the file that is never painted: pdf.js caches a glyph procedure's path as a
// Path2D, in place, when it paints the glyph, so the shown document's procedures lose their
// numbers page by page, while the copy's keep them. `docId` is the shown document's pdf.js id,
// which the copy's pool is shared with.
export function scanType3Fonts(bytes: Uint8Array, docId: string): Promise<void> {
  const scan = (async () => {
    let shadow: LoadedPdf | null = null;
    try {
      shadow = await loadPdf(bytes, "shadow");
      linkType3Documents(docId, shadow.doc.loadingTask.docId);
      for (const page of shadow.pages) {
        try {
          const list = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
          const glyphs = collectType3Glyphs(list.fnArray, list.argsArray);
          const members: Type3Member[] = [];
          for (const [name, drawn] of glyphs) {
            const font = await fontObject(page, name);
            if (font?.isType3Font) members.push({ name, font, glyphs: drawn });
          }
          if (members.length > 0) registerType3Fonts(members);
        } catch {
          // A page that cannot be read adds nothing; the faces keep what they have.
        }
      }
    } catch {
      // Without the copy the faces are built from the shown document's procedures alone.
    }
  })();
  type3Scan = scan;
  return scan;
}

const fontCache = new WeakMap<PDFPageProxy, Map<string, PageFont>>();

// The fonts of a page that readPageContent has read, by pdf.js font name.
export function pageFonts(page: PDFPageProxy): Map<string, PageFont> | undefined {
  return fontCache.get(page);
}

export function readPageContent(page: PDFPageProxy, pageIndex: number): Promise<ContentElement[]> {
  const cached = contentCache.get(page);
  if (cached) return cached;
  const pending = extractPageContent(page, pageIndex).catch((error: unknown) => {
    contentCache.delete(page);
    throw error;
  });
  contentCache.set(page, pending);
  return pending;
}

async function extractPageContent(page: PDFPageProxy, pageIndex: number): Promise<ContentElement[]> {
  const viewport = page.getViewport({ scale: 1 });
  const [textResult, graphics] = await Promise.all([
    page.getTextContent(),
    page
      .getOperatorList({ annotationMode: AnnotationMode.DISABLE })
      .then((list) => ({
        ...readGraphics(list.fnArray, list.argsArray, viewport),
        colors: textColors(list.fnArray, list.argsArray),
        glyphUse: collectGlyphUse(list.fnArray, list.argsArray),
        type3: collectType3Glyphs(list.fnArray, list.argsArray),
        glyphs: glyphStream(list.fnArray, list.argsArray),
      }))
      .catch(() => ({
        rules: [] as Box[],
        shapes: [] as Box[],
        images: [] as Box[],
        covers: [] as Cover[],
        colors: [] as string[],
        glyphUse: new Map<string, GlyphUse>(),
        type3: new Map<string, Map<string, Type3Glyph>>(),
        glyphs: [] as GlyphState[],
      })),
  ]);
  const styles = textResult.styles as Record<string, PdfFontStyle>;
  const faces = await resolveFaces(page, textResult.items, styles, graphics.glyphUse, graphics.type3);
  await loadFaces(faces);
  const runs = textRuns(
    textResult.items,
    styles,
    viewport,
    graphics.colors,
    faces,
    itemSpacing(textResult.items, graphics.glyphs, faces),
    graphics.covers,
  );
  const lines = groupLines(runs);
  const tables = findTables(graphics.rules, viewport.width, viewport.height);
  const shapes = graphics.shapes.filter((shape) => !tables.some((table) => containsCenter(table, shape)));
  markHeadings(lines);
  const blocks = groupBlocks(lines, graphics.rules);
  const elements: ContentElement[] = [];
  const push = (
    kind: ContentKind,
    box: Box,
    text: string,
    face?: TextFace,
    spans: ContentSpan[] = [],
    softBreaks: number[] = [],
    lineGaps: number[] = [],
    lineOffsets: number[] = [],
    lineIndents: number[] = [],
  ) => {
    if (box.w < 0.5 || box.h < 0.5) return;
    elements.push({
      id: "",
      page: pageIndex,
      kind,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      text: text.trim(),
      fontFamily: face?.fontFamily ?? "sans-serif",
      fontWeight: face?.fontWeight ?? 400,
      fontStyle: face?.fontStyle ?? "normal",
      fontSize: face?.fontSize ?? 0,
      ascent: face?.ascent ?? 0.8,
      color: face?.color ?? "#111111",
      baseline: face?.baseline ?? box.y + box.h * 0.8,
      lineHeight: face?.lineHeight ?? box.h,
      align: face?.align ?? "left",
      indent: face?.indent ?? 0,
      letterSpacing: face?.letterSpacing ?? 0,
      wordSpacing: face?.wordSpacing ?? 0,
      softBreaks,
      lineGaps,
      lineOffsets,
      lineIndents,
      pdfFont: face?.pdfFont ?? "",
      spans: faceCount(spans) > 1 ? spans : [],
    });
  };
  for (const block of blocks) {
    const first = block.lines[0];
    if (!first) continue;
    if (block.lines.length === 1) {
      const fit = fitLine(first, first.letterSpacing);
      push(first.heading ? "heading" : "text", first, first.text, faceOf(first), fit.spans);
      continue;
    }
    const face = blockFace(block.lines);
    const box = union(block.lines);
    const flowed = blockContent(block.lines, face, box);
    push(
      "paragraph",
      box,
      flowed.text,
      face,
      flowed.spans,
      flowed.softBreaks,
      flowed.lineGaps,
      flowed.lineOffsets,
      flowed.lineIndents,
    );
  }
  for (const rule of graphics.rules) push("line", rule, "");
  for (const shape of shapes) push("shape", shape, textInside(lines, shape));
  for (const image of graphics.images) push("image", image, "");
  for (const table of tables) push("table", table, textInside(lines, table));
  // Ids come from where an element sits so an edit keeps pointing at the same text when the page
  // is read again later, even if other elements are grouped differently.
  const seen = new Map<string, number>();
  for (const element of elements) {
    const base = `${pageIndex}:${element.kind}:${Math.round(element.x)}:${Math.round(element.y)}:${Math.round(element.w)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    element.id = count > 0 ? `${base}#${count}` : base;
  }
  return elements;
}

// Resolves each text item's font to the CSS pdf.js itself draws it with: the embedded face it
// registered on the document, a matched system font, or the generic fallback with bold/italic flags.
async function resolveFaces(
  page: PDFPageProxy,
  items: unknown[],
  styles: Record<string, PdfFontStyle>,
  glyphUse: Map<string, GlyphUse>,
  type3Glyphs: Map<string, Map<string, Type3Glyph>>,
): Promise<Map<string, Face>> {
  const names = new Set<string>();
  for (const item of items) if (isTextRun(item) && item.fontName) names.add(item.fontName);
  const faces = new Map<string, Face>();
  const fonts = new Map<string, PageFont>();
  const type3: Type3Member[] = [];
  await Promise.all(
    [...names].map(async (name) => {
      const font = await fontObject(page, name);
      if (font?.isType3Font) {
        type3.push({ name, font, glyphs: type3Glyphs.get(name) ?? new Map() });
        return;
      }
      const family = await editableFamily(name, font?.data, glyphUse.get(name));
      faces.set(name, await faceFor(name, font, styles[name], family));
      fonts.set(name, { data: font?.data ?? null, fixed: family ? familyBytes(family) : null, type3: false, name: font?.name ?? "" });
    }),
  );
  // A Type3 font is a set of drawings: a real face is rebuilt from them, so the text is set in
  // the page's own letters, with the page's advances and a space of its own. The document's
  // fonts that are one typeface share a face built from all the glyphs seen so far.
  if (type3.length > 0) {
    registerType3Fonts(type3);
    // The rest of the document is still being read into the pool; a short wait lets the first
    // pages' faces start with most of the typeface, and a long document is not waited for.
    if (type3Scan) {
      await Promise.race([type3Scan, new Promise<void>((resolve) => window.setTimeout(resolve, 2500))]);
    }
    const families = await type3Families(type3[0]?.name ?? "");
    for (const member of type3) {
      const family = families.get(member.name) ?? null;
      const bytes = family ? type3FaceBytes(family) : null;
      if (family && bytes) rememberCoverage(member.name, bytes, glyphUse.get(member.name));
      faces.set(member.name, await faceFor(member.name, member.font, styles[member.name], family));
      fonts.set(member.name, { data: null, fixed: bytes, type3: true, family: family ?? undefined, name: "" });
    }
  }
  fontCache.set(page, fonts);
  return faces;
}

// Makes sure the faces are usable before any text is measured against them.
async function loadFaces(faces: Map<string, Face>): Promise<void> {
  if (typeof document === "undefined") return;
  const css = new Set([...faces.values()].map((face) => `${face.style} ${face.weight} 12px ${face.family}`));
  await Promise.all([...css].map((font) => document.fonts.load(font).catch(() => [])));
}

// Every glyph the page draws, in order, with the character and word spacing in force when it was
// drawn and the size the font was selected at.
function glyphStream(fnArray: number[], argsArray: unknown[]): GlyphState[] {
  const out: GlyphState[] = [];
  let charSpacing = 0;
  let wordSpacing = 0;
  let fontSize = 1;
  let font = "";
  let phantom = 0;
  let fill = "#111111";
  let fillAlpha = 1;
  let renderMode = 0;
  const show = (glyphs: unknown, op: number) => {
    if (!Array.isArray(glyphs)) return;
    for (const glyph of glyphs) {
      if (!glyph || typeof glyph !== "object") continue;
      const { unicode, isSpace, width, originalCharCode } = glyph as {
        unicode?: unknown;
        isSpace?: unknown;
        width?: unknown;
        originalCharCode?: unknown;
      };
      const text = isSpace ? " " : typeof unicode === "string" ? unicode : "";
      if (text) {
        out.push({
          text,
          charSpacing,
          wordSpacing,
          fontSize,
          font,
          width: number(width, 0),
          op,
          phantom,
          // Text painted with a constant alpha reads as a lighter colour: a web page's grey
          // byline is often black at half opacity.
          color: inkOver(fill, fillAlpha),
          bold: renderMode === 2 || renderMode === 6,
        });
      }
      // A space drawn as a two-byte code: the renderer gives it no word spacing, the text reader does.
      if (!isSpace && originalCharCode === 0x20) phantom += 1;
    }
  };
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  // The text state is part of the graphics state: q saves it and Q brings it back, so a Tc set
  // inside one text object does not leak into the next.
  const saved: {
    charSpacing: number;
    wordSpacing: number;
    fontSize: number;
    font: string;
    fill: string;
    fillAlpha: number;
    renderMode: number;
  }[] = [];
  const fillOps = new Set([OPS.setFillRGBColor, OPS.setFillGray, OPS.setFillCMYKColor, OPS.setFillColor, OPS.setFillColorN]);
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = argsArray[index];
    if (fn === OPS.save) {
      saved.push({ charSpacing, wordSpacing, fontSize, font, fill, fillAlpha, renderMode });
      continue;
    }
    if (fn === OPS.restore) {
      const state = saved.pop();
      if (state) ({ charSpacing, wordSpacing, fontSize, font, fill, fillAlpha, renderMode } = state);
      continue;
    }
    if (fn != null && fillOps.has(fn)) {
      fill = paintColor(args) ?? fill;
      continue;
    }
    if (fn === OPS.setGState && Array.isArray(args) && Array.isArray(args[0])) {
      for (const entry of args[0] as unknown[]) {
        if (Array.isArray(entry) && entry[0] === "ca" && typeof entry[1] === "number") fillAlpha = entry[1];
      }
      continue;
    }
    if (fn === OPS.setTextRenderingMode) {
      renderMode = Array.isArray(args) ? number(args[0], renderMode) : renderMode;
      continue;
    }
    // Setting the text position anew discards the drift accumulated along the line.
    if (
      fn === OPS.beginText ||
      fn === OPS.endText ||
      fn === OPS.setTextMatrix ||
      fn === OPS.moveText ||
      fn === OPS.setLeadingMoveText ||
      fn === OPS.nextLine ||
      fn === OPS.nextLineShowText ||
      fn === OPS.nextLineSetSpacingShowText
    ) {
      phantom = 0;
    }
    if (!Array.isArray(args)) continue;
    if (fn === OPS.setCharSpacing) charSpacing = number(args[0], 0);
    else if (fn === OPS.setWordSpacing) wordSpacing = number(args[0], 0);
    else if (fn === OPS.setFont) {
      font = typeof args[0] === "string" ? args[0] : font;
      fontSize = Math.abs(number(args[1], 1)) || 1;
    } else if (fn === OPS.showText || fn === OPS.nextLineShowText) show(args[0], index);
    else if (fn === OPS.nextLineSetSpacingShowText) {
      wordSpacing = number(args[0], wordSpacing);
      charSpacing = number(args[1], charSpacing);
      show(args[2], index);
    }
  }
  return out;
}

// Pairs each text item with the content stream's glyphs, by walking the glyph stream alongside
// the items' text. Spaces are skipped on both sides, since pdf.js adds and drops them freely, and
// a short look-ahead resyncs the two when a character has no glyph. Each item gets the state its
// first glyph was drawn in and the summed advance of the glyphs matched to its letters.
function itemSpacing(items: unknown[], stream: GlyphState[], faces: Map<string, Face>): Map<number, ItemSpacing> {
  const states = new Map<number, ItemSpacing>();
  if (stream.length === 0) return states;
  let cursor = 0;
  items.forEach((item, index) => {
    if (!isTextRun(item)) return;
    const text = item.str;
    let position = 0;
    let first: GlyphState | null = null;
    let last: GlyphState | null = null;
    let letters = 0;
    let advance = 0;
    let spaces = 0;
    let spaceAdvance = 0;
    let spelled = "";
    while (position < text.length && cursor < stream.length) {
      const char = text[position] ?? "";
      if (!char.trim()) {
        position += 1;
        continue;
      }
      let skipped = false;
      while (cursor < stream.length && !(stream[cursor]?.text ?? "").trim()) {
        const space = stream[cursor];
        if (first && space) {
          spaces += 1;
          spaceAdvance += space.width * (faces.get(space.font)?.unitScale ?? 0.001) * space.fontSize;
        }
        cursor += 1;
        skipped = true;
      }
      const glyph = stream[cursor];
      if (!glyph) break;
      if (text.startsWith(glyph.text, position)) {
        if (first && skipped) spelled += " ";
        first ??= glyph;
        last = glyph;
        letters += glyph.text.length;
        advance += glyph.width * (faces.get(glyph.font)?.unitScale ?? 0.001) * glyph.fontSize;
        spelled += glyph.text;
        position += glyph.text.length;
        cursor += 1;
        continue;
      }
      let found = -1;
      for (let ahead = 1; ahead <= 8 && cursor + ahead < stream.length; ahead += 1) {
        const candidate = stream[cursor + ahead];
        if (candidate && candidate.text.trim() && text.startsWith(candidate.text, position)) {
          found = cursor + ahead;
          break;
        }
      }
      if (found >= 0) {
        cursor = found;
        continue;
      }
      position += 1;
    }
    if (first) {
      const phantomInside = last && last.op === first.op ? Math.max(0, last.phantom - first.phantom) : 0;
      states.set(index, { state: first, letters, advance, text: spelled, phantomInside, spaces, spaceAdvance });
    }
  });
  return states;
}

function fontObject(page: PDFPageProxy, name: string): Promise<PdfFontObject | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (font: PdfFontObject | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(font);
    };
    const timer = window.setTimeout(() => finish(null), 4000);
    try {
      const store = (page as unknown as { commonObjs?: ObjectStore }).commonObjs;
      if (!store) {
        finish(null);
        return;
      }
      if (store.has(name)) {
        finish((store.get(name) as PdfFontObject | null) ?? null);
        return;
      }
      store.get(name, (font) => finish((font as PdfFontObject | null) ?? null));
    } catch {
      finish(null);
    }
  });
}

async function faceFor(name: string, font: PdfFontObject | null, style: PdfFontStyle | undefined, fixed: string | null): Promise<Face> {
  const { family: fallback, standIn } = await fallbackFamily(name, font, style);
  const weight = font?.black ? 900 : font?.bold ? 700 : 400;
  const slant: Face["style"] = font?.italic ? "italic" : "normal";
  const matrix = font?.fontMatrix?.[0];
  const unitScale = typeof matrix === "number" && Number.isFinite(matrix) && matrix !== 0 ? Math.abs(matrix) : 0.001;
  // A font the PDF names without embedding it is set in the face that stands in for it, the one
  // the export embeds; the stand-in is a cut of its own, registered regular like the page's faces.
  if (standIn) return { family: fallback, weight: 400, style: "normal", unitScale };
  if (font?.systemFontInfo?.css) return { family: font.systemFontInfo.css, weight, style: slant, unitScale };
  const loaded = font?.loadedName || name;
  if (fixed) return { family: `"${fixed}", "${loaded}", ${fallback}`, weight, style: slant, unitScale };
  if (!font?.isType3Font && fontRegistered(loaded)) {
    return { family: `"${loaded}", ${fallback}`, weight, style: slant, unitScale };
  }
  return { family: fallback, weight, style: slant, unitScale };
}

// Faces most systems have, by the name a PDF font goes by, so a character the embedded face lacks
// comes from the real font when it is installed.
const KNOWN_FAMILIES: [RegExp, string, FaceKind][] = [
  [/courier/i, "Courier New", "mono"],
  [/consolas/i, "Consolas", "mono"],
  [/menlo/i, "Menlo", "mono"],
  [/monaco/i, "Monaco", "mono"],
  [/lucida\s*console/i, "Lucida Console", "mono"],
  [/times/i, "Times New Roman", "serif"],
  [/georgia/i, "Georgia", "serif"],
  [/garamond/i, "Garamond", "serif"],
  [/palatino|book\s*antiqua/i, "Palatino", "serif"],
  [/cambria/i, "Cambria", "serif"],
  [/baskerville/i, "Baskerville", "serif"],
  [/century\s*schoolbook/i, "Century Schoolbook", "serif"],
  [/arial/i, "Arial", "sans"],
  [/helvetica/i, "Helvetica", "sans"],
  [/verdana/i, "Verdana", "sans"],
  [/tahoma/i, "Tahoma", "sans"],
  [/trebuchet/i, "Trebuchet MS", "sans"],
  [/calibri/i, "Calibri", "sans"],
  [/segoe/i, "Segoe UI", "sans"],
  [/gill\s*sans/i, "Gill Sans", "sans"],
  [/futura/i, "Futura", "sans"],
  [/avenir/i, "Avenir", "sans"],
  [/optima/i, "Optima", "sans"],
  [/century\s*gothic/i, "Century Gothic", "sans"],
];

// Words in a font's name that say what kind of face it is, tried in an order that keeps "Sans
// Serif" sans, "Roboto Slab" serif, and "Helvetica Neue Roman" sans: Roman names the regular
// style of many sans faces, so it only counts when nothing else in the name does.
const MONO_HINT =
  /mono|typewriter|\bcode\b|courier|consol|cmtt\d|inconsolata|letter\s*gothic|andale|menlo|monaco|cousine|nimbusmon|gyrecursor/i;
const SANS_WORD = /sans|grotesk|grotesque/i;
const SERIF_HINT =
  /serif|slab|times|georgia|garamond|baskerville|cambria|palatino|palladio|minion|caslon|century|bodoni|didot|charter|constantia|plantin|sabon|bembo|caecilia|rockwell|utopia|nimbusrom|libertin|merriweather|lora\b|playfair|spectral|crimson|literata|tinos|caladea|gelasio|termes|pagella|bonum|schola|cm(?:r|bx|ti|sl|mi|bxti|bxsl)\d|sf(?:rm|bx|ti)\d|lmroman|computer\s*modern|bookman|antiqua|schoolbook|goudy|perpetua|trajan|warnock|chaparral|hoefler|cochin|clarendon|janson|jenson|walbaum|cormorant|vollkorn|gentium|cardo|alegreya|domine|arvo|bitter|zilla/i;
const SANS_HINT =
  /gothic|arial|arimo|helvetica|verdana|tahoma|calibri|carlito|segoe|roboto|lato\b|\binter\b|myriad|frutiger|univers|futura|avenir|gill|optima|trebuchet|cmss\d|sfss\d|lmsans|heros|adventor|nimbussan|geist|montserrat|poppins|raleway|ubuntu|cantarell|nunito|oswald|franklin|akzidenz|\bdin\b|avant|gotham|proxima|aptos/i;
const ROMAN_HINT = /roman/i;

const GENERIC: Record<FaceKind, { faces: string[]; generic: string }> = {
  serif: { faces: ["Georgia", "Times New Roman"], generic: "serif" },
  sans: { faces: ["Helvetica", "Arial"], generic: "sans-serif" },
  mono: { faces: ["Menlo", "Courier New"], generic: "monospace" },
};

// The families a character the face lacks is drawn in, in the order the browser tries them: the
// font's supplement (a font the user added for the face, then the bundled open font of the same
// design, in the font's own cut; see supplementFonts.ts), the bold or italic of the faces below
// when the font is one, the font the PDF names when most systems have it, faces of the same kind
// that most systems have, then the generic family. pdf.js picks its generic from the PDF's font
// flags, which many generators set wrongly (a text serif flagged plain, so a missing letter came
// out sans-serif); the font's own name is trusted first, and the flags only when the name says
// nothing. `loadedName` is the pdf.js font name the supplement is recorded under. For a font the
// PDF does not embed, the supplement stands in for the whole font (`standInFamilies`), and
// `standIn` says whether one does.
async function fallbackFamily(
  loadedName: string,
  font: PdfFontObject | null,
  style: PdfFontStyle | undefined,
): Promise<{ family: string; standIn: boolean }> {
  const raw = font?.name ?? "";
  const name = bareName(raw);
  const known = KNOWN_FAMILIES.find(([pattern]) => pattern.test(name));
  const kind = known?.[2] ?? kindOf(name, font, style);
  const faces = [...new Set([...(known ? [known[1]] : []), ...GENERIC[kind].faces])];
  // pdf.js sets its bold and italic flags only for fonts it substituted, and since pdf.js 6 the
  // flags reach the page as false, not as nothing, for every other font: an embedded face is bold
  // or italic when its name says so (in a word, or in the weight axis a generator appended).
  const traits = traitsOfName(raw);
  const bold = !!(font?.bold || font?.black || traits.bold);
  const italic = !!(font?.italic || traits.italic);
  const weight = font?.black ? 900 : weightOfName(raw, bold);
  const ask = { name, bold, italic, weight, kind };
  const [supplement, styled] = await Promise.all([
    font?.systemFontInfo?.css ? standInFamilies(loadedName, ask) : supplementFamilies(loadedName, ask),
    styledAlias(faces, bold, italic),
  ]);
  const family = [...(supplement ?? []), ...(styled ? [styled] : []), ...faces]
    .map((face) => `"${face}"`)
    .concat(GENERIC[kind].generic)
    .join(", ");
  return { family, standIn: !!font?.systemFontInfo?.css && supplement !== null };
}

function kindOf(name: string, font: PdfFontObject | null, style: PdfFontStyle | undefined): FaceKind {
  if (MONO_HINT.test(name)) return "mono";
  if (SANS_WORD.test(name)) return "sans";
  if (SERIF_HINT.test(name)) return "serif";
  if (SANS_HINT.test(name)) return "sans";
  if (ROMAN_HINT.test(name)) return "serif";
  if (font?.isMonospace) return "mono";
  if (font?.isSerifFont) return "serif";
  const flagged = font?.fallbackName || style?.fontFamily || "";
  if (flagged === "monospace") return "mono";
  if (flagged === "serif") return "serif";
  return "sans";
}

// Aliases registered for the bold or italic of system faces, by alias name.
const aliases = new Map<string, Promise<string | null>>();

// The bold or italic (or both) of the given system faces under a family name of its own, declared
// regular, so a span can list it after the embedded font without also asking the browser to slant
// or thicken the embedded glyphs, which pdf.js registers as regular whatever their design. Null
// when neither is wanted or none of the faces is installed; the browser then goes on to the
// regular faces.
function styledAlias(faces: string[], bold: boolean, italic: boolean): Promise<string | null> {
  if ((!bold && !italic) || typeof document === "undefined" || typeof FontFace === "undefined") return Promise.resolve(null);
  const slug = faces.map((face) => face.toLowerCase().replace(/[^a-z0-9]+/g, "-")).join("-");
  const name = `stet-fallback-${slug}-${bold ? "bold" : ""}${italic ? "italic" : ""}`;
  const cached = aliases.get(name);
  if (cached) return cached;
  const styles = bold && italic ? ["Bold Italic", "Bold Oblique"] : bold ? ["Bold"] : ["Italic", "Oblique"];
  // Full names first, then the PostScript names Microsoft and Apple give these faces.
  const sources = faces.flatMap((face) =>
    styles.flatMap((style) => [`local("${face} ${style}")`, `local("${face}-${style.replace(/ /g, "")}")`]),
  );
  const pending = (async () => {
    try {
      const face = new FontFace(name, sources.join(", "));
      await face.load();
      document.fonts.add(face);
      return name;
    } catch {
      return null;
    }
  })();
  aliases.set(name, pending);
  return pending;
}

// The characters of a text patch that the faces it is set in have no glyph for, each once: the
// browser draws them in the face's fallback family, and the export paints the patch as an image.
export function patchMissingGlyphs(patch: Pick<PatchAnnotation, "text" | "pdfFont" | "spans">): string[] {
  const spans =
    patch.spans.length > 0 && patch.spans.map((span) => span.text).join("") === patch.text
      ? patch.spans
      : [{ text: patch.text, pdfFont: patch.pdfFont }];
  const missing: string[] = [];
  for (const span of spans) {
    for (const char of missingGlyphs(span.pdfFont, span.text)) if (!missing.includes(char)) missing.push(char);
  }
  return missing;
}

// Where the characters a text patch's faces lack come from: by supplement, the characters it
// supplies (so the inspector can say "3, 4 and 5 are set in Tinos Bold"), the fonts the PDF
// names without embedding them and the face each is set in instead, the characters no supplement
// or stand-in has (shown in a substitute face; the export paints the patch), and the font file
// the user could add for the first face that has no supplement of its own design.
export type GlyphReport = {
  supplied: { label: string; relation: Relation; chars: string[] }[];
  standIns: { name: string; label: string; relation: Relation }[];
  unsupplied: string[];
  offer: FontOffer | null;
};

export function patchGlyphReport(patch: Pick<PatchAnnotation, "text" | "pdfFont" | "spans">): GlyphReport {
  const spans =
    patch.spans.length > 0 && patch.spans.map((span) => span.text).join("") === patch.text
      ? patch.spans
      : [{ text: patch.text, pdfFont: patch.pdfFont }];
  const supplied = new Map<string, GlyphReport["supplied"][number]>();
  const standIns = new Map<string, GlyphReport["standIns"][number]>();
  const unsupplied: string[] = [];
  let offer: FontOffer | null = null;
  for (const span of spans) {
    const standIn = standInOf(span.pdfFont);
    if (standIn) {
      const name = standIn.pageFont;
      if (!standIns.has(name)) standIns.set(name, { name, label: standIn.label, relation: standIn.relation });
      offer ??= fontOffer(span.pdfFont);
      for (const char of span.text) {
        if (/\s/u.test(char) || standIn.covers(char.codePointAt(0) ?? -1) || unsupplied.includes(char)) continue;
        unsupplied.push(char);
      }
      continue;
    }
    const missing = missingGlyphs(span.pdfFont, span.text);
    if (missing.length === 0) continue;
    const supplement = supplementOf(span.pdfFont);
    offer ??= fontOffer(span.pdfFont);
    for (const char of missing) {
      const code = char.codePointAt(0) ?? -1;
      if (supplement?.covers(code)) {
        let group = supplied.get(supplement.label);
        if (!group) {
          group = { label: supplement.label, relation: supplement.relation, chars: [] };
          supplied.set(supplement.label, group);
        }
        if (!group.chars.includes(char)) group.chars.push(char);
      } else if (!unsupplied.includes(char)) {
        unsupplied.push(char);
      }
    }
  }
  return { supplied: [...supplied.values()], standIns: [...standIns.values()], unsupplied, offer };
}

function fontRegistered(family: string): boolean {
  if (typeof document === "undefined") return false;
  let found = false;
  document.fonts.forEach((face) => {
    if (face.family.replace(/^["']|["']$/g, "") === family) found = true;
  });
  return found;
}

export function contentAt(elements: ContentElement[], point: Point): ContentElement | null {
  const hits = elements.filter((element) => contains(element, point, 0));
  const texts = hits.filter((element) => isTextContent(element.kind));
  const ranked = texts.length > 0 ? texts : hits;
  let best: ContentElement | null = null;
  let bestArea = Infinity;
  for (const element of ranked) {
    const area = element.w * element.h;
    if (area < bestArea) {
      best = element;
      bestArea = area;
    }
  }
  if (best) return best;
  for (const element of elements) {
    if (element.kind !== "line" || !contains(element, point, 3)) continue;
    const area = element.w * element.h;
    if (area < bestArea) {
      best = element;
      bestArea = area;
    }
  }
  return best;
}

function textRuns(
  items: unknown[],
  styles: Record<string, PdfFontStyle>,
  viewport: PageViewport,
  colors: string[],
  faces: Map<string, Face>,
  spacing: Map<number, ItemSpacing>,
  covers: Cover[] = [],
): Run[] {
  const runs: Run[] = [];
  let colorIndex = 0;
  items.forEach((item, index) => {
    if (!isTextRun(item) || !item.str.trim()) return;
    // The colour of the item's first glyph, read alongside it in the content stream. The colours
    // listed per show-text operator are the fallback: an item can span several operators and an
    // operator several items, so they drift out of step.
    const matched = spacing.get(index);
    const color = matched?.state.color ?? colors[colorIndex] ?? "#111111";
    colorIndex += 1;
    const tx = Util.transform(viewport.transform, item.transform);
    const fontSize = Math.hypot(tx[2], tx[3]) || item.height || 12;
    if (fontSize < 2 || item.width < 0.5) return;
    const style = styles[item.fontName];
    const ascent = ascentRatio(style);
    const angle = Math.atan2(tx[1], tx[0]) + (style?.vertical ? Math.PI / 2 : 0);
    const top = tx[5] - fontSize * ascent;
    // Word spacing pdf.js added to two-byte space codes when it read the positions, which the
    // page never drew: the item sits that much further left, and is that much narrower.
    const phantomSpacing = matched ? matched.state.wordSpacing * (fontSize / matched.state.fontSize) : 0;
    const drift = Math.abs(angle) < 0.08 && Number.isFinite(phantomSpacing) ? phantomSpacing : 0;
    const x = tx[4] - drift * (matched?.state.phantom ?? 0);
    const width = Math.max(0.5, item.width - drift * (matched?.phantomInside ?? 0));
    const box =
      Math.abs(angle) < 0.08
        ? { x, y: top, w: width, h: fontSize }
        : rotatedBox(tx[4], tx[5], item.width, fontSize, ascent, angle);
    const face: Face = faces.get(item.fontName) ?? {
      family: style?.fontFamily || "sans-serif",
      weight: 400,
      style: "normal",
      unitScale: 0.001,
    };
    // Text the page later painted over (an edit flattened to an image by an earlier export, a
    // filled box) is not on the page as the reader sees it, so it is not offered for editing.
    if (matched && hidden(box, matched.state.op, covers)) return;
    const { text, letterSpacing, wordSpacing } = runSpacing(item, width, fontSize, face, matched);
    runs.push({
      ...box,
      baseline: tx[5],
      size: fontSize,
      text,
      angle,
      pdfFont: item.fontName,
      fontFamily: face.family,
      // Text filled and stroked reads as bold whatever its font is; the browser emboldens the
      // face the same way.
      fontWeight: matched?.state.bold ? Math.max(face.weight, 700) : face.weight,
      fontStyle: face.style,
      ascent,
      color,
      letterSpacing,
      wordSpacing,
    });
  });
  return runs;
}

// An item's text and the letter and word spacing that make the face set it as wide as the page
// drew it. Letter spacing is the stream's Tc plus any difference between the page's glyph advances
// and the face's own (a substituted font, or a converted one whose advances pdf.js adjusted),
// spread over the letters. Word spacing then takes whatever is left: the page's own space advance,
// with its Tw, against the face's, which for a converted font is the fallback family's space
// because the converted font has no space glyph at all. Words the page positioned one by one carry
// no spaces and get none; the gaps between them are measured when they are joined into a line.
function runSpacing(
  item: TextRun,
  width: number,
  fontSize: number,
  face: Face,
  matched: ItemSpacing | undefined,
): { text: string; letterSpacing: number; wordSpacing: number } {
  // Spacing operators are in text space; the item's size against the selected size scales them.
  const state = matched?.state;
  const textScale = state ? fontSize / state.fontSize : 0;
  let letterSpacing = clampSpacing(state ? state.charSpacing * textScale : 0, fontSize, 0.5);
  const measure = { fontFamily: face.family, fontWeight: face.weight, fontStyle: face.style, fontSize };
  let text = item.str;
  let letterCount = [...text.replace(/\s+/g, "")].length;
  let spaceCount = [...text].length - letterCount;
  // Tracked text (a wide Tc) reaches pdf.js as a space after nearly every letter. The stream knows
  // which spaces the page really drew, and the tracking is letter spacing.
  if (matched && letterCount >= 3 && spaceCount >= letterCount - 2 && letterSpacing > fontSize * 0.04) {
    text = matched.text;
    letterCount = [...text.replace(/\s+/g, "")].length;
    spaceCount = [...text].length - letterCount;
  }
  const letters = text.replace(/\s+/g, "");
  if (spaceCount === 0) {
    // Without spaces the page's own width says everything: its Tc, glyph advances that differ
    // from the face's, and any kerning shifts, spread over the gaps between the letters.
    const natural = measureWidth(letters, measure);
    if (letterCount > 1 && natural > 0) {
      const spread = (width - natural) / (letterCount - 1);
      letterSpacing = Math.max(-fontSize * 0.08, Math.min(fontSize * 0.5, spread));
    }
    return { text, letterSpacing: Math.round(letterSpacing * 1000) / 1000, wordSpacing: 0 };
  }
  const chars = [...text].length;
  if (matched && letterCount > 1 && matched.letters === letterCount && textScale > 0) {
    const natural = measureWidth(letters, measure);
    // What the stream's glyph advances say the item should measure. When that disagrees with
    // the width the page drew (a font whose declared widths are not its own advances: an
    // instance of a variable face, say, that the page set 5% tighter than the face's metrics),
    // the glyph advances say nothing about the letters, and the page's text is simply narrower
    // all over. The face is then tightened in proportion, letters and spaces alike, instead of
    // the whole difference landing on the spaces and gluing the words together.
    const declared = (matched.advance + matched.spaceAdvance) * textScale + letterSpacing * (chars - 1);
    const proportional = matched.spaces === spaceCount && Math.abs(declared - width) > width * 0.02;
    if (natural > 0 && proportional) {
      const whole = measureWidth(text, { ...measure, letterSpacing, wordSpacing: 0 }) - letterSpacing;
      if (whole > 0 && chars > 1) letterSpacing += ((width - whole) * (natural / whole)) / (chars - 1);
    } else if (natural > 0) {
      const mismatch = (matched.advance * textScale - natural) / letterCount;
      letterSpacing += Math.max(-fontSize * 0.04, Math.min(fontSize * 0.05, mismatch));
    }
  }
  letterSpacing = Math.round(letterSpacing * 1000) / 1000;
  // CSS letter spacing also follows the last glyph; the page's width stops at its ink.
  const natural = measureWidth(text, { ...measure, letterSpacing, wordSpacing: 0 }) - letterSpacing;
  if (!(natural > 0)) return { text, letterSpacing, wordSpacing: 0 };
  const fit = spaceFit(width - natural, spaceCount, [...text].length - 1, measure);
  return { text, letterSpacing: Math.round((letterSpacing + fit.spread) * 1000) / 1000, wordSpacing: fit.gap };
}

// How `extra` width is spread over a run's `spaces` spaces and the `gaps` between its characters:
// the spaces take it, within what a space can reasonably absorb. A face much wider than the page's
// (a substitute for a font the page only has as outlines) would swallow the spaces whole and glue
// the words together, so a space gives up half its width at most and the letters tighten for the
// rest.
function spaceFit(
  extra: number,
  spaces: number,
  gaps: number,
  face: Parameters<typeof measureWidth>[1],
): { gap: number; spread: number } {
  if (spaces <= 0) return { gap: 0, spread: 0 };
  const space = measureWidth(" ", face);
  let gap = extra / spaces;
  let spread = 0;
  const floor = -space * 0.5;
  if (gap < floor && gaps > 0) {
    spread = Math.max(-face.fontSize * 0.12, (extra - floor * spaces) / gaps);
    gap = (extra - spread * gaps) / spaces;
  }
  gap = Math.max(-space * 0.9, Math.min(face.fontSize * 3, gap));
  return {
    gap: Math.abs(gap) < 0.005 ? 0 : Math.round(gap * 1000) / 1000,
    spread: Math.abs(spread) < 0.0005 ? 0 : Math.round(spread * 1000) / 1000,
  };
}

// The colour `hex` ink shows when painted over white paper at `alpha`.
function inkOver(hex: string, alpha: number): string {
  if (!(alpha < 0.995)) return hex;
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) return hex;
  const mix = Math.max(0, Math.min(1, alpha));
  return `#${[0, 2, 4]
    .map((offset) => {
      const channel = Number.parseInt(match[1]!.slice(offset, offset + 2), 16);
      return Math.round(channel * mix + 255 * (1 - mix))
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

// Whether two ink colours read as the same colour: the same to the eye, if not to the byte.
function sameInk(a: string, b: string): boolean {
  if (a === b) return true;
  const parse = (value: string) => {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    return match?.[1] ? [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16)) : null;
  };
  const first = parse(a);
  const second = parse(b);
  if (!first || !second) return true;
  return first.reduce((sum, channel, index) => sum + Math.abs(channel - (second[index] ?? 0)), 0) <= 96;
}

// Whether a run drawn by operator `op` lies wholly under opaque paint that came after it.
function hidden(box: Box, op: number, covers: Cover[]): boolean {
  const pad = 0.6;
  return covers.some(
    (cover) =>
      cover.order > op &&
      cover.x <= box.x + pad &&
      cover.y <= box.y + pad &&
      cover.x + cover.w >= box.x + box.w - pad &&
      cover.y + cover.h >= box.y + box.h - pad,
  );
}

function clampSpacing(value: number, fontSize: number, maxEm: number): number {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return 0;
  if (value > fontSize * maxEm || value < -fontSize * 0.5) return 0;
  return Math.round(value * 1000) / 1000;
}

function isTextRun(item: unknown): item is TextRun {
  if (!item || typeof item !== "object") return false;
  const run = item as TextRun;
  return typeof run.str === "string" && Array.isArray(run.transform) && typeof run.width === "number";
}

function rotatedBox(x: number, y: number, width: number, fontSize: number, ascent: number, angle: number): Box {
  const rise = fontSize * ascent;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = [
    [x + sin * rise, y - cos * rise],
    [x - sin * (fontSize - rise), y + cos * (fontSize - rise)],
    [x + cos * width + sin * rise, y + sin * width - cos * rise],
    [x + cos * width - sin * (fontSize - rise), y + sin * width + cos * (fontSize - rise)],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of corners) {
    if (cx == null || cy == null) continue;
    minX = Math.min(minX, cx);
    minY = Math.min(minY, cy);
    maxX = Math.max(maxX, cx);
    maxY = Math.max(maxY, cy);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function groupLines(runs: Run[]): Line[] {
  const sorted = [...runs].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rows: Run[][] = [];
  for (const run of sorted) {
    const row = rows.find((group) => {
      const sample = group[0];
      if (!sample || Math.abs(sample.angle) > 0.08 || Math.abs(run.angle) > 0.08) return false;
      return Math.abs(sample.baseline - run.baseline) < Math.max(sample.size, run.size) * 0.45;
    });
    if (row) row.push(run);
    else rows.push([run]);
  }
  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let current: Run[] = [];
    const flush = () => {
      const first = current[0];
      if (!first) return;
      const box = union(current);
      const spans = spanRuns(current);
      const face = dominantFace(current, spans);
      lines.push({
        ...box,
        baseline: first.baseline,
        size: Math.max(...current.map((run) => run.size)),
        text: spans.map((span) => span.text).join(""),
        heading: false,
        pdfFont: face.pdfFont,
        fontFamily: face.fontFamily,
        fontWeight: face.fontWeight,
        fontStyle: face.fontStyle,
        ascent: face.ascent,
        color: face.color,
        letterSpacing: face.letterSpacing,
        wordSpacing: face.wordSpacing,
        spans,
      });
      current = [];
    };
    for (const run of row) {
      const previous = current[current.length - 1];
      const gap = previous ? run.x - (previous.x + previous.w) : 0;
      // A bold or italic word stays in its line as a span of its own; only a change of size, a wide
      // gap, or a list marker set apart from its item starts a new line.
      const differentSize = !!previous && Math.abs(previous.size - run.size) > 0.4;
      const afterMarker =
        !!previous &&
        current.length === 1 &&
        isListMarker(previous.text) &&
        (previous.pdfFont !== run.pdfFont || gap > run.size * 0.45);
      if (previous && (differentSize || afterMarker || gap > Math.max(previous.size, run.size) * 1.5)) flush();
      current.push(run);
    }
    flush();
  }
  return lines;
}

function isListMarker(text: string): boolean {
  // An em dash is left out: it opens wrapped lines as a run of its own far more often than a list.
  return /^(?:[\u2022\u25E6\u2023\u2043\u25AA\u25CF\u25A0\u25A1\u00B7\u2013*-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])$/.test(
    text.trim(),
  );
}

// Joins a line's runs, left to right, into spans: adjacent runs in one face become one span, a gap
// wider than a sliver becomes a space, and whitespace collapses the way the text would read.
function spanRuns(runs: Run[]): ContentSpan[] {
  const spans: ContentSpan[] = [];
  let end = 0;
  for (const run of runs) {
    let text = run.text.replace(/[ \t]+/g, " ");
    const last = spans[spans.length - 1];
    if (last) {
      const gap = run.x - end;
      if (gap > run.size * 0.18 && !last.text.endsWith(" ") && !text.startsWith(" ")) last.text += " ";
      else if (last.text.endsWith(" ") && text.startsWith(" ")) text = text.slice(1);
    } else text = text.trimStart();
    end = run.x + run.w;
    if (!text) continue;
    if (last && sameSpanFace(last, run)) {
      last.text += text;
      last.box = union([last.box, run]);
    } else {
      spans.push({
        text,
        fontFamily: run.fontFamily,
        fontWeight: run.fontWeight,
        fontStyle: run.fontStyle,
        fontSize: run.size,
        color: run.color,
        pdfFont: run.pdfFont,
        letterSpacing: run.letterSpacing,
        box: { x: run.x, y: run.y, w: run.w, h: run.h },
      });
    }
  }
  const last = spans[spans.length - 1];
  if (last) last.text = last.text.trimEnd();
  return mergeSpans(spans);
}

function sameSpanFace(
  a: Pick<TextSpan, "fontFamily" | "fontWeight" | "fontStyle" | "fontSize" | "color" | "letterSpacing">,
  b: Pick<TextSpan, "fontFamily" | "fontWeight" | "fontStyle" | "color" | "letterSpacing"> & { fontSize?: number; size?: number },
): boolean {
  const size = b.fontSize ?? b.size ?? a.fontSize;
  return (
    a.fontFamily === b.fontFamily &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color &&
    Math.abs(a.fontSize - size) < 0.05 &&
    sameTracking(a.letterSpacing, b.letterSpacing)
  );
}

// Whether two runs are tracked alike. Letter spacing is what makes a run exactly as wide as the
// page drew it, so runs only join when theirs agree to the rounding they are stored at.
function sameTracking(a: number | undefined, b: number | undefined): boolean {
  return Math.abs((a ?? 0) - (b ?? 0)) < 0.0015;
}

// Drops empty spans, folds whitespace-only spans into a neighbour and merges neighbours in one face.
function mergeSpans(spans: ContentSpan[]): ContentSpan[] {
  const merged: ContentSpan[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = merged[merged.length - 1];
    if (last && (sameSpanFace(last, span) || !span.text.trim())) {
      last.text += span.text;
      last.box = union([last.box, span.box]);
      continue;
    }
    if (last && !last.text.trim()) {
      merged[merged.length - 1] = { ...span, text: last.text + span.text, box: union([last.box, span.box]) };
      continue;
    }
    merged.push({ ...span, box: { ...span.box } });
  }
  return merged;
}

// How many faces the spans use. A run tracked or coloured differently from its neighbours counts
// as a face of its own, so a grey line next to a black one keeps its colour when they are edited
// together.
function faceCount(spans: ContentSpan[]): number {
  const faces = new Set(
    spans.map(
      (span) =>
        `${span.fontFamily}|${span.fontWeight}|${span.fontStyle}|${Math.round(span.fontSize * 4)}|${Math.round((span.letterSpacing ?? 0) * 100)}|${span.color}`,
    ),
  );
  return faces.size;
}

function markHeadings(lines: Line[]) {
  const sizes = lines.map((line) => line.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 12;
  for (const line of lines) {
    line.heading = line.size >= median * 1.3 && line.size >= 11 && line.text.length <= 140;
  }
}

function groupBlocks(lines: Line[], rules: Box[]): { lines: Line[] }[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const markers = sorted.filter((line) => isListMarker(line.text));
  // A line with a list marker to its left starts an item, so a new block, whatever sits above it.
  const marked = new Set(
    sorted.filter((line) => !isListMarker(line.text) && markers.some((marker) => markerBeside(marker, line))),
  );
  const blocks: { lines: Line[] }[] = [];
  let current: Line[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push({ lines: current });
    current = [];
  };
  for (const line of sorted) {
    // A marker is a block of its own and never interrupts the item it belongs to.
    if (isListMarker(line.text)) {
      blocks.push({ lines: [line] });
      continue;
    }
    const previous = current[current.length - 1];
    if (!previous || marked.has(line) || !sameBlock(previous, line, rules)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function markerBeside(marker: Line, line: Line): boolean {
  const size = Math.max(marker.size, line.size);
  if (Math.abs(marker.baseline - line.baseline) > size * 0.45) return false;
  const gap = line.x - (marker.x + marker.w);
  return gap > -1 && gap < size * 4;
}

function sameBlock(previous: Line, next: Line, rules: Box[]): boolean {
  if (previous.heading !== next.heading) return false;
  if (!facesFlow(previous, next)) return false;
  // A change of weight, slant, size or colour from one line to the next is a new block: a date, a
  // bold title and a grey summary stacked in a card are three things, not one paragraph, even
  // when one font sets them all.
  if (previous.fontWeight !== next.fontWeight || previous.fontStyle !== next.fontStyle) return false;
  if (!sameInk(previous.color, next.color)) return false;
  const previousSize = dominantSpan(previous.spans)?.fontSize ?? previous.size;
  const nextSize = dominantSpan(next.spans)?.fontSize ?? next.size;
  if (Math.abs(previousSize - nextSize) / Math.max(previousSize, nextSize, 1) > 0.06) return false;
  const size = Math.max(previous.size, next.size, 1);
  if (Math.abs(previous.size - next.size) / size > 0.18) return false;
  const gap = next.y - (previous.y + previous.h);
  if (gap < -size * 0.35 || gap > size * 1.15) return false;
  const overlap =
    Math.min(previous.x + previous.w, next.x + next.w) - Math.max(previous.x, next.x);
  if (overlap < Math.min(previous.w, next.w) * 0.35) return false;
  const left = Math.abs(next.x - previous.x) < size * 3;
  const right = Math.abs(next.x + next.w - (previous.x + previous.w)) < size * 3;
  if (!left && !right) return false;
  return !rules.some((rule) => {
    if (rule.h > 2.5 || rule.w < 12) return false;
    const between = rule.y > previous.y + previous.h - 1 && rule.y < next.y + 1;
    const spans = rule.x <= previous.x + 6 && rule.x + rule.w >= previous.x + previous.w - 6;
    return between && spans;
  });
}

// Whether the text of one line can continue into the next: they share a dominant face, or the
// next line's face already appears in the previous one (a paragraph whose first words are bold).
// The reverse pairing, a single-face line above a mixed line that merely contains its face, is
// left apart: that is what a heading followed by a paragraph with a bold lead-in looks like, and
// pdf.js cannot tell a heading face from a bold one when the weight is baked into the font.
// A face is the font together with its weight, so a line the page emboldened by stroking does
// not flow into one it did not.
function facesFlow(previous: Line, next: Line): boolean {
  if (previous.pdfFont === next.pdfFont && previous.fontWeight === next.fontWeight) return true;
  return previous.spans.some((span) => span.pdfFont === next.pdfFont && span.fontWeight === next.fontWeight);
}

function readGraphics(
  fnArray: number[],
  argsArray: unknown[],
  viewport: PageViewport,
): { rules: Box[]; shapes: Box[]; images: Box[]; covers: Cover[] } {
  // The clip in force, in page units; paint only lands inside it. A page printed from a browser
  // paints its fixed header as a white box over the top of every page and clips it to a band,
  // so without the clip the box would seem to hide the text under the band.
  const stack: { ctm: number[]; fillAlpha: number; clip: Box | null }[] = [];
  let ctm = IDENTITY.slice();
  let fillAlpha = 1;
  let clip: Box | null = null;
  let clipping = false;
  const rules: Box[] = [];
  const shapes: Box[] = [];
  const images: Box[] = [];
  // Opaque paint in paint order, so text drawn earlier and lying under it can be told hidden.
  const covers: Cover[] = [];
  const visible = (box: Box): Box | null => (clip ? intersectBoxes(box, clip) : box);
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = argsArray[index];
    if (fn === OPS.save) {
      stack.push({ ctm: ctm.slice(), fillAlpha, clip });
      continue;
    }
    if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      const state = stack.pop();
      ctm = state?.ctm ?? IDENTITY.slice();
      fillAlpha = state?.fillAlpha ?? 1;
      clip = state?.clip ?? null;
      continue;
    }
    // W / W* mark the path that follows as a clip.
    if (fn === OPS.clip || fn === OPS.eoClip) {
      clipping = true;
      continue;
    }
    if (fn === OPS.setGState && Array.isArray(args) && Array.isArray(args[0])) {
      for (const entry of args[0] as unknown[]) {
        if (Array.isArray(entry) && entry[0] === "ca" && typeof entry[1] === "number") fillAlpha = entry[1];
      }
      continue;
    }
    if (fn === OPS.transform) {
      const matrix = asMatrix(args);
      if (matrix) ctm = Util.transform(ctm, matrix);
      continue;
    }
    if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ctm: ctm.slice(), fillAlpha, clip });
      const matrix = Array.isArray(args) ? asMatrix(args[0]) : null;
      if (matrix) ctm = Util.transform(ctm, matrix);
      continue;
    }
    if (fn === OPS.constructPath && Array.isArray(args)) {
      const paint = args[0];
      const minMax = args[2] as ArrayLike<number> | null;
      const pathBounds = pathBox(minMax, ctm, viewport);
      if (clipping || paint === OPS.clip || paint === OPS.eoClip) {
        clipping = false;
        // The clip narrows to the path's box (a curved clip hides at most what its box does).
        if (pathBounds) clip = clip ? (intersectBoxes(clip, pathBounds) ?? { x: 0, y: 0, w: 0, h: 0 }) : pathBounds;
        if (paint === OPS.clip || paint === OPS.eoClip || paint === OPS.endPath) continue;
      }
      if (paint === OPS.endPath) continue;
      const path = Array.isArray(args[1]) ? (args[1][0] as ArrayLike<number> | null) : null;
      const box = pathBounds ? visible(pathBounds) : null;
      if (!box) continue;
      // Only a filled polygon counts as a cover: a curved shape's box says little about what it hides.
      const filled = paint !== OPS.stroke && paint !== OPS.closeStroke;
      if (filled && fillAlpha >= 0.99 && isPolygon(path)) covers.push({ ...box, order: index });
      if (coversPage(box, viewport)) continue;
      if (isRule(box) || isSegment(path)) rules.push(padRule(box));
      else if (box.w >= 8 && box.h >= 8) shapes.push(box);
      continue;
    }
    if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageXObjectRepeat ||
      fn === OPS.paintInlineImageXObjectGroup
    ) {
      const placed = pathBox([0, 0, 1, 1], ctm, viewport);
      const box = placed ? visible(placed) : null;
      if (!box) continue;
      if (fillAlpha >= 0.99) covers.push({ ...box, order: index });
      if (box.w >= 8 && box.h >= 8 && !coversPage(box, viewport)) images.push(box);
    }
  }
  return {
    rules: mergeRules(uniqueBoxes(rules)),
    shapes: uniqueBoxes(shapes).slice(0, 300),
    images: uniqueBoxes(images),
    covers,
  };
}

function findTables(rules: Box[], pageWidth: number, pageHeight: number): Box[] {
  const horizontal = rules
    .map((rule, index) => ({ rule, index }))
    .filter((item) => item.rule.h <= 2.5 && item.rule.w >= 24)
    .sort((a, b) => a.rule.y - b.rule.y);
  const vertical = rules.filter((rule) => rule.w <= 2.5 && rule.h >= 16);
  const used = new Set<number>();
  const tables: Box[] = [];
  for (let start = 0; start < horizontal.length; start += 1) {
    const first = horizontal[start];
    if (!first || used.has(first.index)) continue;
    const group = [first];
    for (let next = start + 1; next < horizontal.length; next += 1) {
      const item = horizontal[next];
      if (!item || used.has(item.index)) continue;
      const last = group[group.length - 1]?.rule;
      if (!last) break;
      if (item.rule.y - (last.y + last.h) > 48) break;
      const overlap = Math.min(last.x + last.w, item.rule.x + item.rule.w) - Math.max(last.x, item.rule.x);
      if (overlap < Math.min(last.w, item.rule.w) * 0.55) continue;
      group.push(item);
    }
    if (group.length < 2) continue;
    const span = union(group.map((item) => item.rule));
    const crossed = vertical.filter((rule) => {
      const overlapY = Math.min(rule.y + rule.h, span.y + span.h) - Math.max(rule.y, span.y);
      return rule.x >= span.x - 4 && rule.x <= span.x + span.w + 4 && overlapY > Math.min(rule.h, span.h) * 0.45;
    });
    const columns = distinct(crossed.map((rule) => rule.x), 3);
    const rowCount = group.length;
    const gaps = group.slice(1).map((item, index) => item.rule.y - (group[index]?.rule.y ?? item.rule.y));
    const regular = gaps.length > 0 && Math.max(...gaps) <= Math.min(...gaps) * 1.85;
    if (!((rowCount >= 3 && columns >= 2) || (rowCount >= 3 && regular))) continue;
    const box = union([span, ...crossed]);
    if (box.w > pageWidth * 0.94 && box.h > pageHeight * 0.94 && rowCount < 4 && columns < 4) continue;
    for (const item of group) used.add(item.index);
    tables.push(box);
  }
  return tables;
}

function textInside(lines: Line[], box: Box): string {
  return lines
    .filter((line) => containsCenter(box, line))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((line) => line.text)
    .join("\n");
}

function pathBox(minMax: ArrayLike<number> | null, ctm: number[], viewport: PageViewport): Box | null {
  if (!minMax || minMax.length < 4) return null;
  const [x0, y0, x1, y1] = [minMax[0], minMax[1], minMax[2], minMax[3]];
  if (x0 == null || y0 == null || x1 == null || y1 == null) return null;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x0 > x1 || y0 > y1) return null;
  const view = viewport.transform as number[];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ]) {
    const next = [point[0] ?? 0, point[1] ?? 0];
    Util.applyTransform(next, ctm);
    Util.applyTransform(next, view);
    minX = Math.min(minX, next[0] ?? 0);
    minY = Math.min(minY, next[1] ?? 0);
    maxX = Math.max(maxX, next[0] ?? 0);
    maxY = Math.max(maxY, next[1] ?? 0);
  }
  const box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  if ((box.w < 0.4 && box.h < 0.4) || box.w > viewport.width * 4 || box.h > viewport.height * 4) return null;
  return box;
}

function asMatrix(value: unknown): number[] | null {
  const list =
    value instanceof Float32Array
      ? Array.from(value)
      : Array.isArray(value)
        ? value
        : null;
  if (!list || list.length < 6) return null;
  if (!list.slice(0, 6).every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return list.slice(0, 6) as number[];
}

function isSegment(path: ArrayLike<number> | null): boolean {
  return !!path && path.length === 6 && path[0] === 0 && path[3] === 1;
}

// A path made only of straight edges (moveTo, lineTo, closePath), with at least three points.
function isPolygon(path: ArrayLike<number> | null): boolean {
  if (!path || path.length < 9) return false;
  let points = 0;
  for (let index = 0; index < path.length; ) {
    const op = path[index];
    if (op === 0 || op === 1) {
      points += 1;
      index += 3;
    } else if (op === 4) index += 1;
    else return false;
  }
  return points >= 3;
}

function padRule(box: Box): Box {
  if (box.h < 1.5 && box.w >= 8) return { x: box.x, y: box.y + box.h / 2 - 1, w: box.w, h: 2 };
  if (box.w < 1.5 && box.h >= 8) return { x: box.x + box.w / 2 - 1, y: box.y, w: 2, h: box.h };
  return box;
}

function mergeRules(rules: Box[]): Box[] {
  const horizontal = rules.filter((rule) => rule.h <= rule.w).sort((a, b) => a.y - b.y || a.x - b.x);
  const vertical = rules.filter((rule) => rule.w < rule.h).sort((a, b) => a.x - b.x || a.y - b.y);
  return [...joinRules(horizontal, "h"), ...joinRules(vertical, "v")];
}

function joinRules(rules: Box[], axis: "h" | "v"): Box[] {
  const merged: Box[] = [];
  for (const rule of rules) {
    const last = merged[merged.length - 1];
    if (last && axis === "h" && Math.abs(last.y - rule.y) < 1.5 && rule.x <= last.x + last.w + 4) {
      const x = Math.min(last.x, rule.x);
      const right = Math.max(last.x + last.w, rule.x + rule.w);
      last.x = x;
      last.w = right - x;
      continue;
    }
    if (last && axis === "v" && Math.abs(last.x - rule.x) < 1.5 && rule.y <= last.y + last.h + 4) {
      const y = Math.min(last.y, rule.y);
      const bottom = Math.max(last.y + last.h, rule.y + rule.h);
      last.y = y;
      last.h = bottom - y;
      continue;
    }
    merged.push({ ...rule });
  }
  return merged;
}

function isRule(box: Box): boolean {
  const thin = Math.min(box.w, box.h);
  const long = Math.max(box.w, box.h);
  return thin <= 2.5 && long >= 8;
}

function coversPage(box: Box, viewport: PageViewport): boolean {
  return box.w > viewport.width * 0.98 && box.h > viewport.height * 0.98;
}

function contains(box: Box, point: Point, pad: number): boolean {
  return (
    point.x >= box.x - pad &&
    point.y >= box.y - pad &&
    point.x <= box.x + box.w + pad &&
    point.y <= box.y + box.h + pad
  );
}

function containsCenter(outer: Box, inner: Box): boolean {
  return contains(outer, { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 }, 0);
}

// The part of `a` inside `b`, or null when they do not meet.
function intersectBoxes(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right - x <= 0 || bottom - y <= 0) return null;
  return { x, y, w: right - x, h: bottom - y };
}

function union(boxes: Box[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

function uniqueBoxes(boxes: Box[]): Box[] {
  const kept: Box[] = [];
  for (const box of boxes) {
    const duplicate = kept.some(
      (other) =>
        Math.abs(other.x - box.x) < 1 &&
        Math.abs(other.y - box.y) < 1 &&
        Math.abs(other.w - box.w) < 1.5 &&
        Math.abs(other.h - box.h) < 1.5,
    );
    if (!duplicate) kept.push(box);
  }
  return kept;
}

function distinct(values: number[], tolerance: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  let count = 0;
  let previous = -Infinity;
  for (const value of sorted) {
    if (value - previous > tolerance) {
      count += 1;
      previous = value;
    }
  }
  return count;
}

function faceOf(line: Line): TextFace {
  const fit = fitLine(line, line.letterSpacing);
  return {
    fontFamily: line.fontFamily,
    fontWeight: line.fontWeight,
    fontStyle: line.fontStyle,
    fontSize: line.size,
    ascent: line.ascent,
    color: line.color,
    baseline: line.baseline,
    lineHeight: line.h,
    align: "left",
    indent: 0,
    letterSpacing: Math.round((line.letterSpacing + fit.spread) * 1000) / 1000,
    wordSpacing: fit.gap ?? line.wordSpacing,
    pdfFont: line.pdfFont,
  };
}

// Sets a line exactly as wide as the page drew it, once its runs are set in their faces with
// their letter spacing (the given one where a run has none of its own). Spaces take the
// difference as word spacing; a line without spaces spreads it over the gaps between its letters,
// which is where runs that abut without a space (a dot leader and its page number) leave it.
function fitLine(line: Line, letterSpacing: number): { gap: number | null; spread: number; spans: ContentSpan[] } {
  const fit = lineGap(line, letterSpacing);
  if (fit != null) {
    if (fit.spread === 0) return { gap: fit.gap, spread: 0, spans: line.spans };
    return {
      gap: fit.gap,
      spread: fit.spread,
      spans: line.spans.map((span) => ({ ...span, letterSpacing: (span.letterSpacing ?? letterSpacing) + fit.spread })),
    };
  }
  const chars = [...line.text].length;
  if (chars < 2 || typeof document === "undefined") return { gap: null, spread: 0, spans: line.spans };
  const natural = lineNatural(line, letterSpacing);
  if (!(natural > 0)) return { gap: null, spread: 0, spans: line.spans };
  const raw = (line.w - natural) / (chars - 1);
  const spread = Math.round(Math.max(-line.size * 0.04, Math.min(line.size * 0.1, raw)) * 1000) / 1000;
  if (Math.abs(spread) < 0.005) return { gap: null, spread: 0, spans: line.spans };
  return {
    gap: null,
    spread,
    spans: line.spans.map((span) => ({ ...span, letterSpacing: (span.letterSpacing ?? letterSpacing) + spread })),
  };
}

// The width of a line's runs set in their faces, up to the last glyph's ink.
function lineNatural(line: Line, letterSpacing: number): number {
  let natural = 0;
  let trailing = letterSpacing;
  for (const span of line.spans) {
    trailing = span.letterSpacing ?? letterSpacing;
    natural += measureWidth(span.text, {
      fontFamily: span.fontFamily,
      fontWeight: span.fontWeight,
      fontStyle: span.fontStyle,
      fontSize: span.fontSize,
      letterSpacing: trailing,
      wordSpacing: 0,
    });
  }
  return natural - trailing;
}

// The word spacing that sets a line exactly as wide as the page drew it, once its runs are set in
// their faces with the given letter spacing: the page's own space advances, the gaps between
// words it positioned one by one, and a justified line's stretch all land on its spaces, except
// what a space cannot absorb, which tightens the letters (`spread`). Null for a line without spaces.
function lineGap(line: Line, letterSpacing: number): { gap: number; spread: number } | null {
  const spaces = [...line.text].filter((char) => char === " ").length;
  if (spaces === 0 || typeof document === "undefined") return null;
  const natural = lineNatural(line, letterSpacing);
  if (!(natural > 0)) return null;
  const lead = line.spans[0];
  return spaceFit(line.w - natural, spaces, [...line.text].length - 1, {
    fontFamily: lead?.fontFamily ?? line.fontFamily,
    fontWeight: lead?.fontWeight ?? line.fontWeight,
    fontStyle: lead?.fontStyle ?? line.fontStyle,
    fontSize: lead?.fontSize ?? line.size,
  });
}

// The face of a multi-line block: the longest line's font, the first line's baseline, the typical
// baseline pitch, and the alignment the lines reveal.
function blockFace(lines: Line[]): TextFace {
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline);
  const first = sorted[0] ?? lines[0];
  const lead = [...sorted].sort((a, b) => b.text.length - a.text.length)[0] ?? first;
  if (!first || !lead) return faceOf(lines[0] as Line);
  const pitches = sorted
    .slice(1)
    .map((line, index) => line.baseline - (sorted[index]?.baseline ?? line.baseline))
    .filter((pitch) => pitch > 0);
  const face = dominantSpan(sorted.flatMap((line) => line.spans));
  const letterSpacing = median(sorted.map((line) => line.letterSpacing));
  const gaps = sorted.map((line) => lineGap(line, letterSpacing)?.gap ?? null);
  const layout = blockLayout(sorted, lead.size);
  // The word spacing text typed into the block flows with: the page's own, read off its lines.
  // The typical line says what the page's gap looks like; one line that fits badly (a face the
  // page only has as outlines) must not set the gap for the whole block. A justified block
  // stretches every line but the last by a different amount, so the last line, which is never
  // stretched, has the natural gap.
  const known = gaps.filter((gap): gap is number => gap != null);
  const body = gaps.slice(0, -1).filter((gap): gap is number => gap != null);
  const last = gaps[gaps.length - 1];
  const wordSpacing =
    known.length === 0
      ? median(sorted.map((line) => line.wordSpacing))
      : layout.align === "justify"
        ? (last ?? (body.length > 0 ? Math.min(...body) : median(known)))
        : median(known);
  return {
    ...faceOf(lead),
    ...(face
      ? {
          fontFamily: face.fontFamily,
          fontWeight: face.fontWeight,
          fontStyle: face.fontStyle,
          color: face.color,
          pdfFont: face.pdfFont,
        }
      : {}),
    baseline: first.baseline,
    lineHeight: median(pitches) || lead.size * 1.2,
    letterSpacing,
    wordSpacing,
    align: layout.align,
    indent: layout.indent,
  };
}

// Joins a block's lines into editable text, keeping every line break of the page so the block
// opens looking exactly as printed. A break the author chose (a centered or right-aligned block,
// a line that ends although the next word would still have fit, or a hyphenated word) is a hard
// newline; one that only exists because the column ran out of room is listed in `softBreaks`,
// and becomes a space once the text is edited so it flows again.
function blockContent(
  lines: Line[],
  face: TextFace,
  box: Box,
): {
  text: string;
  spans: ContentSpan[];
  softBreaks: number[];
  lineGaps: number[];
  lineOffsets: number[];
  lineIndents: number[];
} {
  const width = box.w;
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline);
  const slack = Math.max(1, face.fontSize * 0.3);
  const spans: ContentSpan[] = [];
  const softBreaks: number[] = [];
  const lineGaps: number[] = [];
  const lineOffsets: number[] = [];
  const lineIndents: number[] = [];
  let previous: Line | null = null;
  let offset = 0;
  for (const line of sorted) {
    if (!line.text.trim()) continue;
    // Where the line sits: its baseline against an even pitch from the first line, and, in a
    // block set from the left, its start against the block's left edge (a centred or right-aligned
    // line is placed by its alignment).
    lineOffsets.push(Math.round((line.baseline - (face.baseline + lineOffsets.length * face.lineHeight)) * 1000) / 1000);
    if (face.align === "left" || face.align === "justify") {
      lineIndents.push(Math.round(Math.max(0, line.x - box.x) * 1000) / 1000);
    }
    const last = spans[spans.length - 1];
    if (last && previous) {
      const lead = { ...(line.spans[0] ?? face), letterSpacing: face.letterSpacing, wordSpacing: face.wordSpacing };
      const firstWord = line.text.split(" ")[0] ?? "";
      const wouldFit = previous.w + measureWidth(` ${firstWord}`, lead, previous.size) <= width + slack;
      const hard = face.align === "center" || face.align === "right" || wouldFit || last.text.endsWith("-");
      last.text += "\n";
      if (!hard) softBreaks.push(offset);
      offset += 1;
    }
    // Spans stay one per line and face so each keeps the box its colour is read from.
    const fit = fitLine(line, face.letterSpacing);
    spans.push(...fit.spans.map((span) => ({ ...span, box: { ...span.box } })));
    lineGaps.push(fit.gap ?? face.wordSpacing);
    offset += line.text.length;
    previous = line;
  }
  return { text: spans.map((span) => span.text).join(""), spans, softBreaks, lineGaps, lineOffsets, lineIndents };
}

function blockLayout(lines: Line[], size: number): { align: TextAlign; indent: number } {
  const box = union(lines);
  const tolerance = Math.max(1.5, size * 0.12);
  const left = (line: Line) => Math.abs(line.x - box.x) < tolerance;
  const right = (line: Line) => Math.abs(line.x + line.w - (box.x + box.w)) < tolerance;
  const centered = (line: Line) => Math.abs(line.x + line.w / 2 - (box.x + box.w / 2)) < tolerance;
  const first = lines[0];
  const body = lines.slice(1);
  const butLast = lines.slice(0, -1);
  const leftish = body.every(left);
  const indent = first && leftish && !left(first) ? Math.max(0, first.x - box.x) : 0;
  // A justified column ends nearly every line but the last at its right edge; some generators
  // leave one a hair short. Ragged text also happens to end a few lines near the edge, since the
  // next word is often short, so a block only counts as justified when three lines in four are
  // flush to within a third of an em: calling a ragged paragraph justified would stretch its
  // lines to the column the moment it is edited.
  const flush = (line: Line) => Math.abs(line.x + line.w - (box.x + box.w)) < size * 0.3;
  const flushCount = butLast.filter(flush).length;
  if (lines.length >= 3 && leftish && flushCount >= Math.max(2, Math.ceil(butLast.length * 0.75))) {
    return { align: "justify", indent };
  }
  if (leftish) return { align: "left", indent };
  // A hanging indent: every line but the first starts at the same point further in.
  const hang = body[0]?.x ?? box.x;
  if (body.length > 0 && first && body.every((line) => Math.abs(line.x - hang) < tolerance) && first.x < hang - tolerance) {
    return { align: "left", indent: -(hang - box.x) };
  }
  if (lines.every(right)) return { align: "right", indent: 0 };
  if (lines.every(centered)) return { align: "center", indent: 0 };
  return { align: "left", indent: 0 };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// The face that sets most of the text, counted across every span in that face.
function dominantSpan(spans: TextSpan[]): TextSpan | null {
  const totals = new Map<string, { span: TextSpan; length: number }>();
  for (const span of spans) {
    // Colour is left out: the colours pdf.js reports per run are unreliable and would split a face.
    const key = `${span.pdfFont}|${span.fontFamily}|${span.fontWeight}|${span.fontStyle}|${Math.round((span.letterSpacing ?? 0) * 100)}`;
    const entry = totals.get(key);
    if (entry) entry.length += span.text.length;
    else totals.set(key, { span, length: span.text.length });
  }
  let best: { span: TextSpan; length: number } | null = null;
  for (const entry of totals.values()) if (!best || entry.length > best.length) best = entry;
  return best?.span ?? null;
}

function dominantFace(
  runs: Run[],
  spans: TextSpan[],
): Pick<Run, "pdfFont" | "fontFamily" | "fontWeight" | "fontStyle" | "ascent" | "color" | "letterSpacing" | "wordSpacing"> {
  const best = dominantSpan(spans);
  const run = runs.find((item) => item.pdfFont === best?.pdfFont) ?? runs[0];
  const same = runs.filter((item) => item.pdfFont === run?.pdfFont);
  // Only runs that draw spaces know the page's space advance; words set one by one say nothing.
  const spaced = same.filter((item) => /\s/.test(item.text.trim()));
  return {
    letterSpacing: best?.letterSpacing ?? median(same.map((item) => item.letterSpacing)),
    wordSpacing: spaced.length > 0 ? median(spaced.map((item) => item.wordSpacing)) : 0,
    pdfFont: best?.pdfFont ?? run?.pdfFont ?? "",
    fontFamily: best?.fontFamily ?? run?.fontFamily ?? "sans-serif",
    fontWeight: best?.fontWeight ?? run?.fontWeight ?? 400,
    fontStyle: best?.fontStyle ?? run?.fontStyle ?? "normal",
    ascent: run?.ascent ?? 0.8,
    color: best?.color ?? run?.color ?? "#111111",
  };
}

function textColors(fnArray: number[], argsArray: unknown[]): string[] {
  const colors: string[] = [];
  let fill = "#111111";
  const showing = new Set([
    OPS.showText,
    OPS.showSpacedText,
    OPS.nextLineShowText,
    OPS.nextLineSetSpacingShowText,
  ]);
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    if (
      fn === OPS.setFillRGBColor ||
      fn === OPS.setFillGray ||
      fn === OPS.setFillCMYKColor ||
      fn === OPS.setFillColor
    ) {
      fill = paintColor(argsArray[index]) ?? fill;
      continue;
    }
    if (fn != null && showing.has(fn)) colors.push(fill);
  }
  return colors;
}

function paintColor(value: unknown): string | null {
  const list = Array.isArray(value) ? value : [value];
  const first = list[0];
  if (typeof first === "string" && /^#[0-9a-fA-F]{6}$/.test(first)) return first.toLowerCase();
  const numbers = list.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  const channel = (item: number) =>
    Math.max(0, Math.min(255, Math.round((item > 1 ? item / 255 : item) * 255)))
      .toString(16)
      .padStart(2, "0");
  if (numbers.length === 4) {
    const cyan = numbers[0] ?? 0;
    const magenta = numbers[1] ?? 0;
    const yellow = numbers[2] ?? 0;
    const black = numbers[3] ?? 0;
    const red = (1 - cyan) * (1 - black);
    const green = (1 - magenta) * (1 - black);
    const blue = (1 - yellow) * (1 - black);
    return `#${channel(red)}${channel(green)}${channel(blue)}`;
  }
  if (numbers.length === 1) {
    const gray = channel(numbers[0] ?? 0);
    return `#${gray}${gray}${gray}`;
  }
  if (numbers.length >= 3) {
    return `#${channel(numbers[0] ?? 0)}${channel(numbers[1] ?? 0)}${channel(numbers[2] ?? 0)}`;
  }
  return null;
}

function ascentRatio(style: PdfFontStyle | undefined): number {
  const ascent = style?.ascent;
  if (typeof ascent === "number" && ascent > 0.45 && ascent < 1.15) return ascent;
  return 0.8;
}
