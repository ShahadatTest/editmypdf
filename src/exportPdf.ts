import fontkit from "@pdf-lib/fontkit";
import { soundFontkit } from "./soundFontkit.ts";
import {
  beginText,
  degrees,
  endText,
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFillingRgbColor,
  setFontAndSize,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  StandardFonts,
  TextRenderingMode,
  type PDFFont,
  type PDFHexString,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { pageFonts, readPageContent, type ContentElement } from "./content.ts";
import { editCover, graphicCovers, refreshPatchFace } from "./contentEdit.ts";
import { stripPageText, type StripResult } from "./contentStream.ts";
import { fontUnicodeMap } from "./fontFix.ts";
import { standInOf, supplementOf } from "./supplementFonts.ts";
import { blockWidth, decorationLine, measureWidth, paintRun, placeRuns, runDecoration, type PlacedRun } from "./textLayout.ts";
import { type3FaceBytes } from "./type3Font.ts";
import { emojiSrc } from "./emojis.ts";
import { rotatePoint } from "./geometry.ts";
import { arrowBarbs, isBoxShape, isOpenShape, outlinePoints, pointsToPath } from "./shapes.ts";
import type {
  Annotation,
  FontId,
  LineAnnotation,
  PatchAnnotation,
  PdfPointMapper,
  TextAnnotation,
} from "./types.ts";
import type { PDFPageProxy } from "pdfjs-dist";

function embedPngDataUrl(document: PDFDocument, src: string): Promise<PDFImage> | null {
  const comma = src.indexOf(",");
  if (!src.startsWith("data:image/png") || comma < 0) return null;
  const binary = atob(src.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return document.embedPng(bytes);
}

const FONT_NAMES: Record<
  FontId,
  Record<"regular" | "bold" | "italic" | "boldItalic", StandardFonts>
> = {
  helvetica: {
    regular: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  times: {
    regular: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  courier: {
    regular: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
};

const LINE_HEIGHT = 1.2;
const BASELINE = 0.9;

function pdfCap(cap: string | undefined) {
  if (cap === "square") return LineCapStyle.Projecting;
  if (cap === "butt") return LineCapStyle.Butt;
  return LineCapStyle.Round;
}

function pdfDash(dash: string | null | undefined): number[] | undefined {
  if (!dash) return undefined;
  const parts = dash
    .split(/[\s,]+/)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return parts.length > 0 ? parts : undefined;
}

function parseColor(hex: string) {
  const value = hex.replace("#", "");
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((channel) => channel + channel)
          .join("")
      : value;
  const parsed = Number.parseInt(expanded, 16);
  return rgb(
    ((parsed >> 16) & 255) / 255,
    ((parsed >> 8) & 255) / 255,
    (parsed & 255) / 255,
  );
}

function fontKey(annotation: TextAnnotation): string {
  return `${annotation.fontId}:${annotation.bold ? "b" : ""}:${annotation.italic ? "i" : ""}`;
}

function wrapParagraph(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  if (text.length === 0) return [""];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  const pushLongWord = (word: string) => {
    let chunk = "";
    for (const character of word) {
      const trial = chunk + character;
      if (chunk && font.widthOfTextAtSize(trial, size) > maxWidth) {
        lines.push(chunk);
        chunk = character;
      } else {
        chunk = trial;
      }
    }
    current = chunk;
  };

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, size) > maxWidth) pushLongWord(word);
    else current = word;
  }
  lines.push(current);
  return lines;
}

function drawTextBlock(
  page: PDFPage,
  annotation: TextAnnotation,
  font: PDFFont,
  map: PdfPointMapper,
) {
  const color = parseColor(annotation.color);
  const paragraphs = annotation.text.split("\n");
  const wrapped = paragraphs.flatMap((paragraph) =>
    wrapParagraph(font, paragraph, annotation.fontSize, annotation.width),
  );
  const boxHeight = annotation.height ?? Math.max(annotation.fontSize * LINE_HEIGHT, wrapped.length * annotation.fontSize * LINE_HEIGHT);
  const centerX = annotation.x + annotation.width / 2;
  const centerY = annotation.y + boxHeight / 2;
  const rotation = annotation.rotation ?? 0;
  wrapped.forEach((line, index) => {
    const textWidth = font.widthOfTextAtSize(line, annotation.fontSize);
    const spare = Math.max(0, annotation.width - textWidth);
    const offset = annotation.align === "center" ? spare / 2 : annotation.align === "right" ? spare : 0;
    const baselineY = annotation.y + annotation.fontSize * BASELINE + index * annotation.fontSize * LINE_HEIGHT;
    const anchorView = rotatePoint(annotation.x + offset, baselineY, centerX, centerY, rotation);
    const aheadView = rotatePoint(annotation.x + offset + 100, baselineY, centerX, centerY, rotation);
    const anchor = map(annotation.page, anchorView.x, anchorView.y);
    const ahead = map(annotation.page, aheadView.x, aheadView.y);
    const angle = (Math.atan2(ahead.y - anchor.y, ahead.x - anchor.x) * 180) / Math.PI;
    page.drawText(line, {
      x: anchor.x,
      y: anchor.y,
      size: annotation.fontSize,
      font,
      color,
      rotate: degrees(angle),
    });
    const rules: number[] = [];
    if (annotation.underline && line.length > 0) rules.push(baselineY + annotation.fontSize * 0.16);
    if (annotation.strike && line.length > 0) rules.push(baselineY - annotation.fontSize * 0.3);
    for (const ruleY of rules) {
      const ruleStart = rotatePoint(annotation.x + offset, ruleY, centerX, centerY, rotation);
      const ruleEnd = rotatePoint(annotation.x + offset + textWidth, ruleY, centerX, centerY, rotation);
      const start = map(annotation.page, ruleStart.x, ruleStart.y);
      const end = map(annotation.page, ruleEnd.x, ruleEnd.y);
      page.drawLine({
        start,
        end,
        thickness: Math.max(0.6, annotation.fontSize / 16),
        color,
        lineCap: LineCapStyle.Round,
      });
    }
  });
}

function drawArrowHeads(
  page: PDFPage,
  annotation: LineAnnotation,
  map: PdfPointMapper,
  color: ReturnType<typeof parseColor>,
) {
  const size = Math.max(10, annotation.strokeWidth * 3);
  const tips: Array<[number, number, number, number]> = [];
  if (annotation.head === "end" || annotation.head === "both") {
    tips.push([annotation.x1, annotation.y1, annotation.x2, annotation.y2]);
  }
  if (annotation.head === "both") {
    tips.push([annotation.x2, annotation.y2, annotation.x1, annotation.y1]);
  }
  for (const [x1, y1, x2, y2] of tips) {
    const [left, right] = arrowBarbs(x1, y1, x2, y2, size);
    const tip = map(annotation.page, x2, y2);
    page.drawLine({
      start: tip,
      end: map(annotation.page, left.x, left.y),
      thickness: annotation.strokeWidth,
      color,
      lineCap: LineCapStyle.Round,
    });
    page.drawLine({
      start: tip,
      end: map(annotation.page, right.x, right.y),
      thickness: annotation.strokeWidth,
      color,
      lineCap: LineCapStyle.Round,
    });
  }
}

function drawMappedRect(
  page: PDFPage,
  map: PdfPointMapper,
  pageIndex: number,
  box: { x: number; y: number; w: number; h: number },
  image?: PDFImage,
  fill = rgb(1, 1, 1),
) {
  const topLeft = map(pageIndex, box.x, box.y);
  const bottomRight = map(pageIndex, box.x + box.w, box.y + box.h);
  const x = Math.min(topLeft.x, bottomRight.x);
  const y = Math.min(topLeft.y, bottomRight.y);
  const width = Math.abs(bottomRight.x - topLeft.x);
  const height = Math.abs(bottomRight.y - topLeft.y);
  if (width < 0.2 || height < 0.2) return;
  if (image) {
    page.drawImage(image, { x, y, width, height });
    return;
  }
  page.drawRectangle({ x, y, width, height, color: fill });
}

function hexColor(value: string, fallback: ReturnType<typeof rgb>) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match?.[1]) return fallback;
  const hex = match[1];
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  );
}

function backdropColor(value: string) {
  return hexColor(value, rgb(1, 1, 1));
}

function inkColor(value: string) {
  return hexColor(value, rgb(0, 0, 0));
}

// A face of the document embedded in the output, with the code points its cmap covers.
type EmbeddedFace = { font: PDFFont; cmap: Map<number, number> };

type Embedder = {
  // The page's own face, by pdf.js font name; null when it has no bytes to embed (a system or
  // Type3 font) or pdf-lib cannot read them.
  face(pageIndex: number, pdfFont: string): Promise<EmbeddedFace | null>;
  // The face of the font's supplement (supplementFonts.ts) that has the code point; null when
  // the font has no supplement or none of its files has the character.
  supplement(pdfFont: string, code: number): Promise<EmbeddedFace | null>;
};

// Embeds the fonts pdf.js converted for the document, once each by pdf.js font name: the copy
// with the corrected cmap the editor types with when there is one, else the converted font. The
// supplements are embedded once each by file, subset to the glyphs the edits use. Each is named
// in the output as the PDF or the font file names it (pdf-lib would add a random number, which
// the name's reader would then take for part of the name): the page's face keeps the name the
// page gave it, and a supplement goes by its PostScript name behind a subset tag.
function faceEmbedder(document: PDFDocument, pages: PDFPageProxy[]): Embedder {
  const faces = new Map<string, Promise<EmbeddedFace | null>>();
  const supplements = new Map<string, Promise<EmbeddedFace | null>>();
  // The whole font is the fallback when pdf-lib cannot subset this one.
  const embedBytes = async (bytes: Uint8Array, subset: boolean, customName?: string): Promise<PDFFont | null> => {
    try {
      return await document.embedFont(bytes, { subset, customName });
    } catch {
      try {
        return await document.embedFont(bytes, { customName });
      } catch {
        return null;
      }
    }
  };
  return {
    face(pageIndex, pdfFont) {
      const cached = faces.get(pdfFont);
      if (cached) return cached;
      const pending = (async () => {
        const page = pages[pageIndex];
        const info = page ? pageFonts(page)?.get(pdfFont) : undefined;
        // A Type3 font has bytes only when a face was rebuilt from its outlines; the face may have
        // been built again with more letters since the page was read.
        const bytes = (info?.family ? type3FaceBytes(info.family) : null) ?? info?.fixed ?? info?.data;
        if (!info || !bytes || bytes.length < 12) return null;
        const cmap = fontUnicodeMap(bytes);
        if (cmap.size === 0) return null;
        // The converted font carries the original's whole glyph table, so only the glyphs the
        // edits use are written. A face rebuilt from a Type3 font holds only the glyphs the page
        // drew, and is written whole: its CFF outlines trip fontkit's subsetter, which runs when
        // the file is saved, too late for anything to catch.
        const subset = !info.type3;
        const font = await embedBytes(bytes, subset, info.name ? (subset ? subsetName(info.name, pdfFont) : info.name) : undefined);
        return font ? { font, cmap } : null;
      })();
      faces.set(pdfFont, pending);
      return pending;
    },
    async supplement(pdfFont, code) {
      const source = await supplementOf(pdfFont)?.source(code);
      if (!source) return null;
      let pending = supplements.get(source.key);
      if (!pending) {
        pending = (async () => {
          const cmap = fontUnicodeMap(source.bytes);
          if (cmap.size === 0) return null;
          const name = postScriptName(source.bytes);
          const font = await embedBytes(source.bytes, true, name ? subsetName(name, source.key) : undefined);
          return font ? { font, cmap } : null;
        })();
        supplements.set(source.key, pending);
      }
      const face = await pending;
      return face?.cmap.has(code) ? face : null;
    },
  };
}

// The PostScript name a font file gives itself, as a PDF name can carry it; "" when fontkit
// cannot read the file.
function postScriptName(bytes: Uint8Array): string {
  try {
    const font = fontkit.create(bytes) as { postscriptName?: string | null };
    return (font.postscriptName ?? "").replace(/\s+/g, "");
  } catch {
    return "";
  }
}

// A subset font's name, which by convention carries a six-letter tag in front of the font's
// ("ABCDEF+TimesNewRomanPS-BoldMT"); a name that has one keeps it, else one is made from `key`,
// the same for the same source.
function subsetName(name: string, key: string): string {
  if (/^[A-Z]{6}\+/.test(name)) return name;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619) >>> 0;
  let tag = "";
  for (let index = 0; index < 6; index += 1) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26);
  }
  return `${tag}+${name}`;
}

const fontKeys = new WeakMap<PDFPage, Map<PDFFont, PDFName>>();

// The name a font goes by in a page's resources, added on first use.
function pageFontKey(page: PDFPage, font: PDFFont): PDFName {
  let keys = fontKeys.get(page);
  if (!keys) {
    keys = new Map();
    fontKeys.set(page, keys);
  }
  let key = keys.get(font);
  if (!key) {
    key = page.node.newFontDictionary(font.name, font.ref);
    keys.set(font, key);
  }
  return key;
}

// A stretch of one word set in one face.
type Piece = { face: EmbeddedFace; text: string };

type PlacedWord = { x: number; text: string; pieces: Piece[] };

// Writes a text patch as text set in the page's own faces, each word where the editor shows it. A
// character the page's face lacks is set in the font's supplement (supplementFonts.ts) at the
// same size, colour and spacing, so nothing around it moves; a font the PDF names without
// embedding it has no face of its own, and every character is set in the face that stands in for
// it. False when a face cannot be embedded or a character has no glyph in the face or its
// supplement; the caller then paints the patch.
async function drawPatchText(
  document: PDFDocument,
  page: PDFPage,
  patch: PatchAnnotation,
  map: PdfPointMapper,
  embed: Embedder,
): Promise<boolean> {
  const runs = placeRuns(patch);
  // The page's face by pdf.js font name; null for a font with a stand-in instead.
  const faces = new Map<string, EmbeddedFace | null>();
  const nameOf = (run: PlacedRun) => run.span?.pdfFont || patch.pdfFont;
  const placed: { run: PlacedRun; words: PlacedWord[] }[] = [];
  for (const run of runs) {
    const name = nameOf(run);
    if (!name) return false;
    if (!faces.has(name)) {
      const embedded = await embed.face(patch.page, name);
      if (!embedded && !standInOf(name)) return false;
      faces.set(name, embedded);
    }
    const face = faces.get(name) ?? null;
    const words: PlacedWord[] = [];
    for (const word of run.words) {
      const pieces: Piece[] = [];
      for (const char of word.text) {
        const code = char.codePointAt(0);
        if (code == null) return false;
        const target = face?.cmap.has(code) ? face : await embed.supplement(name, code);
        if (!target) return false;
        const last = pieces[pieces.length - 1];
        if (last && last.face === target) last.text += char;
        else pieces.push({ face: target, text: char });
      }
      words.push({ x: word.x, text: word.text, pieces });
    }
    placed.push({ run, words });
  }
  const operators: PDFOperator[] = [
    pushGraphicsState(),
    setLineJoin(LineJoinStyle.Round),
    beginText(),
    setCharacterSqueeze(100),
    setWordSpacing(0),
    setTextRise(0),
    setTextRenderingMode(TextRenderingMode.Fill),
  ];
  // Lines under or through runs, drawn once the text is written.
  const rules: { box: { x: number; y: number; w: number; h: number }; color: ReturnType<typeof inkColor> }[] = [];
  for (const { run, words } of placed) {
    const first = words[0];
    if (!first) continue;
    const color = inkColor(run.color || patch.color);
    const size = run.face.fontSize;
    // The page's faces are registered regular whatever their design, so a heavier weight on a run
    // is emboldening on top of the face (the page stroked it, or the user asked for bold the page
    // has no cut for): the glyphs are stroked as well as filled, as generators embolden. A slant
    // the face lacks skews the text matrix.
    const embolden = run.face.fontWeight >= 600;
    const slant = run.face.fontStyle === "italic" ? Math.tan((12 * Math.PI) / 180) : 0;
    // The text matrix maps the editor's page coordinates onto the page: the baseline direction
    // and the up direction at the run's start, which also carry any page rotation.
    const origin = map(patch.page, first.x, run.baseline);
    const along = map(patch.page, first.x + 1, run.baseline);
    const up = map(patch.page, first.x, run.baseline - 1);
    const alongX = along.x - origin.x;
    const alongY = along.y - origin.y;
    operators.push(
      setCharacterSpacing(run.face.letterSpacing ?? 0),
      setFillingRgbColor(color.red, color.green, color.blue),
      setStrokingRgbColor(color.red, color.green, color.blue),
      setLineWidth(size * 0.03),
      setTextRenderingMode(embolden ? TextRenderingMode.FillAndOutline : TextRenderingMode.Fill),
      setTextMatrix(alongX, alongY, up.x - origin.x + slant * alongX, up.y - origin.y + slant * alongY, origin.x, origin.y),
    );
    // One TJ per stretch of text in one face: each word's glyphs, and before every word but the
    // first a kern that lands it where the editor put it (in thousandths of the font size,
    // rightward negative). A word whose characters come from two faces changes font between its
    // pieces, and a kern that falls at a change opens the next face's TJ. The spaces themselves are
    // not written: a converted font has no space glyph.
    let items: (PDFHexString | PDFNumber)[] = [];
    let current: EmbeddedFace | null = null;
    const flush = () => {
      if (items.length > 0) operators.push(PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [document.context.obj(items)]));
      items = [];
    };
    let cursor = first.x;
    words.forEach((word, index) => {
      let kern: PDFNumber | null = index > 0 ? PDFNumber.of(Math.round((((cursor - word.x) * 1000) / size) * 100) / 100) : null;
      for (const piece of word.pieces) {
        if (piece.face !== current) {
          flush();
          current = piece.face;
          operators.push(setFontAndSize(pageFontKey(page, piece.face.font), size));
        }
        if (kern) {
          items.push(kern);
          kern = null;
        }
        items.push(piece.face.font.encodeText(piece.text));
      }
      cursor = word.x + measureWidth(word.text, run.face);
    });
    flush();
    const decoration = runDecoration(run.span, patch);
    for (const kind of ["underline", "strike"] as const) {
      if (!decoration[kind]) continue;
      const rule = decorationLine(size, kind);
      rules.push({ box: { x: first.x, y: run.baseline + rule.offset, w: cursor - first.x, h: rule.thickness }, color });
    }
  }
  operators.push(endText(), popGraphicsState());
  if (runs.length > 0) page.pushOperators(...operators);
  for (const rule of rules) drawMappedRect(page, map, patch.page, rule.box, undefined, rule.color);
  if (patch.underlineOffset >= 0) {
    drawMappedRect(
      page,
      map,
      patch.page,
      { x: patch.x, y: patch.y + patch.underlineOffset, w: Math.max(1, blockWidth(patch)), h: 0.7 },
      undefined,
      inkColor(patch.underlineColor || patch.color),
    );
  }
  return true;
}

// Takes the original text out from under every text patch, page by page; results by patch id.
function stripPatchedText(document: PDFDocument, annotations: Annotation[], pages: PDFPageProxy[]): Map<string, StripResult> {
  const byPage = new Map<number, PatchAnnotation[]>();
  for (const annotation of annotations) {
    if (annotation.kind !== "patch" || annotation.role !== "text") continue;
    const list = byPage.get(annotation.page) ?? [];
    list.push(annotation);
    byPage.set(annotation.page, list);
  }
  const results = new Map<string, StripResult>();
  for (const [pageIndex, patches] of byPage) {
    let outcome: StripResult[];
    try {
      outcome = stripPageText(
        document,
        pageIndex,
        patches.map((patch) => ({ x: patch.originX, y: patch.originY, w: patch.originW, h: patch.originH })),
        pages[pageIndex]?.getViewport({ scale: 1 }),
      );
    } catch {
      outcome = [];
    }
    patches.forEach((patch, index) => results.set(patch.id, outcome[index] ?? { removed: 0, uncertain: true }));
  }
  return results;
}

async function drawPatch(
  document: PDFDocument,
  page: PDFPage,
  annotation: PatchAnnotation,
  map: PdfPointMapper,
  strip: StripResult | undefined,
  embed: Embedder,
) {
  const delta = annotation.w - annotation.originW;
  const tailsMove = annotation.role === "text" && !annotation.wrap && Math.abs(delta) >= 0.4 && annotation.tails.length > 0;
  const backdrop = backdropColor(annotation.backdrop || "#ffffff");
  if (annotation.role === "graphic") {
    // The backdrop hides only the page's own pixels where the block was; its picture stands at
    // the block's new place, and the page between the two is left as it is. An untouched block
    // is a selection the page already shows, so nothing is drawn for it.
    const covers = graphicCovers(annotation);
    if (covers.length === 0) return;
    for (const box of covers) drawMappedRect(page, map, annotation.page, box, undefined, backdrop);
  } else {
    // Once the text an edit replaces is out of the content stream, the backdrop only has to hide
    // what the new text does not stand in for: a tail that moved, the old underline.
    const replaced = strip != null && strip.removed > 0 && !strip.uncertain;
    if (!replaced || tailsMove || annotation.underlineOffset >= 0) {
      drawMappedRect(page, map, annotation.page, editCover(annotation), undefined, backdrop);
    }
  }
  const asText = annotation.role === "text" && (await drawPatchText(document, page, annotation, map, embed));
  if (!asText) {
    const src = annotation.role === "graphic" ? annotation.image : await paintRun(annotation);
    const embedded = src ? embedPngDataUrl(document, src) : null;
    if (embedded) {
      const image = await embedded;
      // The painted run is as wide as the editor's box, slack included, so it lands at the same scale.
      const box = annotation.role === "text" ? { ...annotation, w: blockWidth(annotation) } : annotation;
      drawMappedRect(page, map, annotation.page, box, image);
    }
  }
  if (!tailsMove) return;
  for (const tail of annotation.tails) {
    const tailImage = embedPngDataUrl(document, tail.image);
    if (!tailImage) continue;
    const image = await tailImage;
    drawMappedRect(page, map, annotation.page, {
      x: tail.x + delta,
      y: tail.y,
      w: tail.w,
      h: tail.h + tail.padBottom,
    }, image);
  }
}

// Text patches name the font pdf.js registered when the page was read, which changes between
// documents loaded in one browser session. Re-reading the page before export makes sure the
// patch paints with the face that is actually registered now.
async function refreshPatchFaces(annotations: Annotation[], pages: PDFPageProxy[]): Promise<Annotation[]> {
  const indices = new Set(
    annotations.filter((annotation) => annotation.kind === "patch" && annotation.role === "text").map((annotation) => annotation.page),
  );
  const faces = new Map<string, ContentElement>();
  const byPage = new Map<number, ContentElement[]>();
  for (const index of indices) {
    const page = pages[index];
    if (!page) continue;
    try {
      const elements = await readPageContent(page, index);
      byPage.set(index, elements);
      for (const element of elements) faces.set(element.id, element);
    } catch {
      // The patch keeps the face it was created with.
    }
  }
  return annotations.map((annotation) => {
    if (annotation.kind !== "patch" || annotation.role !== "text") return annotation;
    const live = faces.get(annotation.sourceId);
    if (!live?.fontFamily) return annotation;
    const refreshed = refreshPatchFace(annotation, live, byPage.get(annotation.page) ?? []);
    // A patch saved before patches named their font takes the name from the element it edits.
    return refreshed.pdfFont || !live.pdfFont ? refreshed : { ...refreshed, pdfFont: live.pdfFont };
  });
}

export async function exportAnnotatedPdf(
  originalBytes: Uint8Array,
  marks: Annotation[],
  map: PdfPointMapper,
  rotation = 0,
  pages: PDFPageProxy[] = [],
): Promise<Uint8Array> {
  const document = await PDFDocument.load(originalBytes.slice(0));
  document.registerFontkit(soundFontkit);
  const annotations = await refreshPatchFaces(marks, pages);
  // The text each edit replaces comes out of its page before anything is drawn on it.
  const strips = stripPatchedText(document, annotations, pages);
  const embed = faceEmbedder(document, pages);
  const fonts = new Map<string, PDFFont>();

  const fontFor = async (annotation: TextAnnotation) => {
    const key = fontKey(annotation);
    const cached = fonts.get(key);
    if (cached) return cached;
    const style =
      annotation.bold && annotation.italic
        ? "boldItalic"
        : annotation.bold
          ? "bold"
          : annotation.italic
            ? "italic"
            : "regular";
    const embedded = await document.embedFont(FONT_NAMES[annotation.fontId][style]);
    fonts.set(key, embedded);
    return embedded;
  };

  const emojiImages = new Map<string, PDFImage>();
  const signatureImages = new Map<string, PDFImage>();
  for (const annotation of annotations) {
    const page = document.getPage(annotation.page);
    if (annotation.kind === "patch") {
      await drawPatch(document, page, annotation, map, strips.get(annotation.id), embed);
      continue;
    }
    if (annotation.kind === "emoji" || annotation.kind === "signature") {
      let image: PDFImage | undefined;
      if (annotation.kind === "emoji") {
        image = emojiImages.get(annotation.emoji);
        if (!image) {
          const response = await fetch(emojiSrc(annotation.emoji));
          if (!response.ok) continue;
          image = await document.embedPng(new Uint8Array(await response.arrayBuffer()));
          emojiImages.set(annotation.emoji, image);
        }
      } else {
        image = signatureImages.get(annotation.id);
        if (!image) {
          const embedded = embedPngDataUrl(document, annotation.src);
          if (!embedded) continue;
          image = await embedded;
          signatureImages.set(annotation.id, image);
        }
      }
      const leftTop = map(annotation.page, annotation.x, annotation.y);
      const rightBottom = map(annotation.page, annotation.x + annotation.w, annotation.y + annotation.h);
      const width = Math.abs(rightBottom.x - leftTop.x);
      const height = Math.abs(rightBottom.y - leftTop.y);
      if (width < 0.5 || height < 0.5) continue;
      const center = map(
        annotation.page,
        annotation.x + annotation.w / 2,
        annotation.y + annotation.h / 2,
      );
      const theta = (-annotation.rotation * Math.PI) / 180;
      const offsetX = Math.cos(theta) * (width / 2) - Math.sin(theta) * (height / 2);
      const offsetY = Math.sin(theta) * (width / 2) + Math.cos(theta) * (height / 2);
      page.drawImage(image, {
        x: center.x - offsetX,
        y: center.y - offsetY,
        width,
        height,
        rotate: degrees(-annotation.rotation),
      });
      continue;
    }
    const color = parseColor(
      annotation.kind === "text" ? annotation.color : annotation.color,
    );

    if (annotation.kind === "ink") {
      const opacity = annotation.opacity ?? 1;
      const dash = pdfDash(annotation.dash);
      const cap = pdfCap(annotation.cap);
      if (annotation.points.length === 1) {
        const only = annotation.points[0];
        if (!only) continue;
        const center = map(annotation.page, only.x, only.y);
        page.drawCircle({
          x: center.x,
          y: center.y,
          size: annotation.strokeWidth / 2,
          color,
          opacity,
        });
        continue;
      }
      const path = annotation.points
        .map((point, index) => {
          const mapped = map(annotation.page, point.x, point.y);
          return `${index === 0 ? "M" : "L"} ${mapped.x} ${mapped.y}`;
        })
        .join(" ");
      page.drawSvgPath(path, {
        borderColor: color,
        borderWidth: annotation.strokeWidth,
        borderOpacity: opacity,
        borderLineCap: cap,
        borderDashArray: dash,
      });
      continue;
    }

    if (annotation.kind === "line") {
      page.drawLine({
        start: map(annotation.page, annotation.x1, annotation.y1),
        end: map(annotation.page, annotation.x2, annotation.y2),
        thickness: annotation.strokeWidth,
        color,
        lineCap: LineCapStyle.Round,
      });
      drawArrowHeads(page, annotation, map, color);
      continue;
    }

    if (isBoxShape(annotation)) {
      const fill = annotation.fill ? parseColor(annotation.fill) : undefined;
      const fillOpacity = annotation.fillOpacity ?? 1;
      if (annotation.rotation) {
        const cx = annotation.x + annotation.w / 2;
        const cy = annotation.y + annotation.h / 2;
        const points = outlinePoints(annotation.kind, annotation.x, annotation.y, annotation.w, annotation.h)
          .map((point) => rotatePoint(point.x, point.y, cx, cy, annotation.rotation))
          .map((point) => map(annotation.page, point.x, point.y));
        const open = isOpenShape(annotation.kind);
        const path = pointsToPath(points, !open);
        if (path) {
          page.drawSvgPath(path, {
            color: open ? undefined : fill,
            opacity: fillOpacity,
            borderOpacity: 1,
            borderColor: color,
            borderWidth: annotation.strokeWidth,
          });
        }
        continue;
      }
      if (annotation.kind === "rect") {
        const leftTop = map(annotation.page, annotation.x, annotation.y);
        const rightBottom = map(annotation.page, annotation.x + annotation.w, annotation.y + annotation.h);
        page.drawRectangle({
          x: Math.min(leftTop.x, rightBottom.x),
          y: Math.min(leftTop.y, rightBottom.y),
          width: Math.abs(rightBottom.x - leftTop.x),
          height: Math.abs(rightBottom.y - leftTop.y),
          color: fill,
          opacity: fillOpacity,
          borderOpacity: 1,
          borderColor: color,
          borderWidth: annotation.strokeWidth,
        });
        continue;
      }
      if (annotation.kind === "ellipse") {
        const leftTop = map(annotation.page, annotation.x, annotation.y);
        const rightBottom = map(annotation.page, annotation.x + annotation.w, annotation.y + annotation.h);
        const width = Math.abs(rightBottom.x - leftTop.x);
        const height = Math.abs(rightBottom.y - leftTop.y);
        if (width < 0.5 || height < 0.5) continue;
        page.drawEllipse({
          x: Math.min(leftTop.x, rightBottom.x) + width / 2,
          y: Math.min(leftTop.y, rightBottom.y) + height / 2,
          xScale: width / 2,
          yScale: height / 2,
          color: fill,
          opacity: fillOpacity,
          borderOpacity: 1,
          borderColor: color,
          borderWidth: annotation.strokeWidth,
        });
        continue;
      }
      const points = outlinePoints(
        annotation.kind,
        annotation.x,
        annotation.y,
        annotation.w,
        annotation.h,
      ).map((point) => map(annotation.page, point.x, point.y));
      const open = isOpenShape(annotation.kind);
      const path = pointsToPath(points, !open);
      if (path) {
        page.drawSvgPath(path, {
          color: open ? undefined : fill,
          opacity: fillOpacity,
          borderOpacity: 1,
          borderColor: color,
          borderWidth: annotation.strokeWidth,
        });
      }
      continue;
    }

    if (annotation.kind !== "text" || annotation.text.length === 0) continue;
    drawTextBlock(page, annotation, await fontFor(annotation), map);
  }

  const turn = ((rotation % 360) + 360) % 360;
  if (turn !== 0) {
    for (const page of document.getPages()) {
      page.setRotation(degrees((page.getRotation().angle + turn) % 360));
    }
  }

  return document.save();
}
