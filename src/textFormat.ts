import type { TextRange } from "./changes.ts";
import type { ContentElement, FaceTraits } from "./content.ts";
import { layoutTextPatch, mergeSpans } from "./contentEdit.ts";
import { spansText } from "./textLayout.ts";
import type { PatchAnnotation, TextAlign, TextSpan } from "./types.ts";

// Formatting of the page's own text: what the caret or selection in an edited run looks like,
// and the patch with a change applied to a run of its text or to all of it. Bold and italic
// prefer a cut of the same typeface that the page already uses (a heading's bold for a word of
// the paragraph); when the page has none, the browser synthesizes the look and the download
// emboldens by stroking and slants by skewing, as PDF generators do themselves.

export type FormatState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontSize: number;
  color: string;
  align: TextAlign;
  // Alignment only means something for a block that wraps.
  wrap: boolean;
  // Whether a run of the text is selected, which the controls act on, rather than the whole patch.
  selection: boolean;
};

export type FormatChange = Partial<Pick<FormatState, "bold" | "italic" | "underline" | "strike" | "fontSize" | "color" | "align">>;

// A face in use on the page, which a run can be set in.
export type FaceCandidate = Pick<TextSpan, "fontFamily" | "fontWeight" | "fontStyle" | "pdfFont">;

export type FaceLookup = (pdfFont: string) => FaceTraits | null;

type Run = Pick<TextSpan, "fontFamily" | "fontWeight" | "fontStyle" | "fontSize" | "color" | "pdfFont" | "underline" | "strike" | "styled">;

const BOLD = 700;
const REGULAR = 400;
const BOLD_FROM = 600;

// The faces the page's elements and their runs are set in, each once.
export function faceCandidates(elements: ContentElement[]): FaceCandidate[] {
  const seen = new Map<string, FaceCandidate>();
  const add = (face: FaceCandidate) => {
    if (face.pdfFont && face.fontFamily && !seen.has(face.pdfFont)) {
      seen.set(face.pdfFont, { fontFamily: face.fontFamily, fontWeight: face.fontWeight, fontStyle: face.fontStyle, pdfFont: face.pdfFont });
    }
  };
  for (const element of elements) {
    if (!element.fontFamily) continue;
    add(element);
    for (const span of element.spans) add(span);
  }
  return [...seen.values()];
}

// A run reads as bold when its weight is heavy (the page stroked it, or the user chose it) or
// its face is a bold cut; pdf.js registers every embedded face as regular whatever its design.
export function runBold(run: Pick<Run, "fontWeight" | "pdfFont">, traits: FaceLookup): boolean {
  return run.fontWeight >= BOLD_FROM || !!traits(run.pdfFont)?.bold;
}

export function runItalic(run: Pick<Run, "fontStyle" | "pdfFont">, traits: FaceLookup): boolean {
  return run.fontStyle === "italic" || !!traits(run.pdfFont)?.italic;
}

// The family list of a face without the page's own font and the faces registered beside it in
// its cut (its supplement, which stands in for the whole font when the PDF does not embed it, and
// the styled aliases): the system faces that stand in for it, which do have a regular, a bold and
// an italic.
function fallbackFamily(fontFamily: string): string {
  const kept = fontFamily
    .split(",")
    .map((part) => part.trim())
    .filter((part) => {
      const bare = part.replace(/^["']|["']$/g, "");
      return bare && !/^g_d\d+_f\d+/.test(bare) && !/-edit\d*$/.test(bare) && !/^stet-(?:fallback|supp|user)-/.test(bare);
    });
  return kept.length > 0 ? kept.join(", ") : "sans-serif";
}

// A face on the page of the same typeface as the run's, cut as asked.
function sibling(run: Run, faces: FaceCandidate[], traits: FaceLookup, bold: boolean, italic: boolean): FaceCandidate | null {
  const own = traits(run.pdfFont);
  if (!own?.stem) return null;
  for (const face of faces) {
    if (face.pdfFont === run.pdfFont) continue;
    const other = traits(face.pdfFont);
    if (!other || other.stem !== own.stem) continue;
    if (other.bold === bold && other.italic === italic) return face;
  }
  return null;
}

function takeFace<T extends Run>(run: T, face: FaceCandidate): T {
  return { ...run, fontFamily: face.fontFamily, fontWeight: face.fontWeight, fontStyle: face.fontStyle, pdfFont: face.pdfFont };
}

// The run with the change applied, or null when the change leaves it as it is.
function restyle<T extends Run>(run: T, change: FormatChange, faces: FaceCandidate[], traits: FaceLookup): T | null {
  let next: T = { ...run };
  let touched = false;
  if (change.bold != null && change.bold !== runBold(next, traits)) {
    const mate = sibling(next, faces, traits, change.bold, runItalic(next, traits));
    if (mate) next = takeFace(next, mate);
    else if (change.bold) next.fontWeight = Math.max(next.fontWeight, BOLD);
    else {
      next.fontWeight = REGULAR;
      // A face that is bold by design has no regular of its own: the system faces stand in.
      if (traits(next.pdfFont)?.bold) next = { ...next, fontFamily: fallbackFamily(next.fontFamily), pdfFont: "" };
    }
    touched = true;
  }
  if (change.italic != null && change.italic !== runItalic(next, traits)) {
    const mate = sibling(next, faces, traits, runBold(next, traits), change.italic);
    if (mate) next = takeFace(next, mate);
    else if (change.italic) next.fontStyle = "italic";
    else {
      next.fontStyle = "normal";
      if (traits(next.pdfFont)?.italic) next = { ...next, fontFamily: fallbackFamily(next.fontFamily), pdfFont: "" };
    }
    touched = true;
  }
  if (change.fontSize != null && Number.isFinite(change.fontSize) && Math.abs(change.fontSize - next.fontSize) > 0.01) {
    next.fontSize = Math.round(change.fontSize * 100) / 100;
    touched = true;
  }
  if (change.color && change.color.toLowerCase() !== (next.color || "").toLowerCase()) {
    next.color = change.color;
    touched = true;
  }
  if (touched) next.styled = true;
  let decorated = false;
  if (change.underline != null && change.underline !== !!next.underline) {
    if (change.underline) next.underline = true;
    else delete next.underline;
    decorated = true;
  }
  if (change.strike != null && change.strike !== !!next.strike) {
    if (change.strike) next.strike = true;
    else delete next.strike;
    decorated = true;
  }
  return touched || decorated ? next : null;
}

function patchRun(patch: PatchAnnotation): Run {
  return {
    fontFamily: patch.fontFamily,
    fontWeight: patch.fontWeight,
    fontStyle: patch.fontStyle,
    fontSize: patch.fontSize,
    color: patch.color,
    pdfFont: patch.pdfFont,
    ...(patch.underline ? { underline: true } : {}),
    ...(patch.strike ? { strike: true } : {}),
    ...(patch.styled ? { styled: true } : {}),
  };
}

// The patch's spans when they describe its text, else its whole text as one run in its face.
function runsOf(patch: PatchAnnotation): TextSpan[] {
  if (patch.spans.length > 0 && spansText(patch.spans) === patch.text) return patch.spans;
  return [{ ...patchRun(patch), text: patch.text }];
}

// Applies a change to text[from, to) of a list of spans: the spans are cut at the edges and the
// pieces inside restyled, then runs that came out alike are joined again.
export function formatSpans(
  spans: TextSpan[],
  from: number,
  to: number,
  change: FormatChange,
  faces: FaceCandidate[],
  traits: FaceLookup,
): TextSpan[] {
  const total = spansText(spans).length;
  const start = Math.max(0, Math.min(from, total));
  const end = Math.max(start, Math.min(to, total));
  if (end <= start) return spans;
  const out: TextSpan[] = [];
  let cursor = 0;
  let touched = false;
  for (const span of spans) {
    const spanStart = cursor;
    const spanEnd = cursor + span.text.length;
    cursor = spanEnd;
    if (spanEnd <= start || spanStart >= end || span.text.length === 0) {
      out.push(span);
      continue;
    }
    const headLength = Math.max(0, start - spanStart);
    const tailFrom = Math.min(span.text.length, end - spanStart);
    const head = span.text.slice(0, headLength);
    const middle = span.text.slice(headLength, tailFrom);
    const tail = span.text.slice(tailFrom);
    const restyled = restyle({ ...span, text: middle }, change, faces, traits);
    if (!restyled) {
      out.push(span);
      continue;
    }
    touched = true;
    if (head) out.push({ ...span, text: head });
    out.push(restyled);
    if (tail) out.push({ ...span, text: tail });
  }
  return touched ? mergeSpans(out) : spans;
}

// The patch with a change applied to the selected run of its text, or to all of it when nothing
// is selected (alignment always applies to the whole block). The same object when nothing changes.
export function formatPatch(
  patch: PatchAnnotation,
  range: TextRange | null,
  change: FormatChange,
  faces: FaceCandidate[],
  traits: FaceLookup,
): PatchAnnotation {
  if (patch.role !== "text") return patch;
  let next = patch;
  if (change.align != null && change.align !== patch.align) next = { ...next, align: change.align, styled: true };
  const { align: _align, ...rest } = change;
  void _align;
  if (Object.keys(rest).length > 0) {
    const selection = range && range.end > range.start ? range : null;
    if (selection) {
      const spans = runsOf(patch);
      const styled = formatSpans(spans, selection.start, selection.end, rest, faces, traits);
      if (styled !== spans) next = { ...next, spans: styled };
    } else {
      const own = restyle(patchRun(patch), rest, faces, traits);
      const spans = patch.spans.map((span) => restyle(span, rest, faces, traits) ?? span);
      const spansTouched = spans.some((span, index) => span !== patch.spans[index]);
      if (own) {
        const { underline, strike, ...face } = own;
        next = { ...next, ...face };
        if (underline) next.underline = true;
        else delete next.underline;
        if (strike) next.strike = true;
        else delete next.strike;
      }
      if (spansTouched) next = { ...next, spans };
    }
  }
  if (next === patch) return patch;
  // A heavier or larger run takes more room: the box follows the text.
  return { ...next, ...layoutTextPatch(next, next.text, 0) };
}

// The span the caret sits in: the one its character follows, so a caret right after a bold word
// reports bold, like typing there continues the bold.
function spanAtCaret(spans: TextSpan[], caret: number): TextSpan | null {
  let cursor = 0;
  for (const span of spans) {
    const start = cursor;
    const end = cursor + span.text.length;
    cursor = end;
    if (caret > start && caret <= end) return span;
    if (caret === 0 && start === 0) return span;
  }
  return spans[spans.length - 1] ?? null;
}

function spansIn(spans: TextSpan[], from: number, to: number): TextSpan[] {
  const inside: TextSpan[] = [];
  let cursor = 0;
  for (const span of spans) {
    const start = cursor;
    const end = cursor + span.text.length;
    cursor = end;
    if (end > from && start < to && span.text.length > 0) inside.push(span);
  }
  return inside;
}

// What the text at the caret, or every run of the selection, is set like.
export function formatAt(patch: PatchAnnotation, range: TextRange | null, traits: FaceLookup): FormatState {
  const spans = patch.spans.length > 0 && spansText(patch.spans) === patch.text ? patch.spans : [];
  const selection = !!range && range.end > range.start;
  let runs: Run[];
  if (spans.length === 0) runs = [patchRun(patch)];
  else if (!range) runs = spans;
  else if (!selection) {
    const at = spanAtCaret(spans, range.end);
    runs = at ? [at] : [patchRun(patch)];
  } else runs = spansIn(spans, range.start, range.end);
  if (runs.length === 0) runs = [patchRun(patch)];
  const first = runs[0] as Run;
  return {
    bold: runs.every((run) => runBold(run, traits)),
    italic: runs.every((run) => runItalic(run, traits)),
    underline: runs.every((run) => !!run.underline),
    strike: runs.every((run) => !!run.strike),
    fontSize: first.fontSize,
    color: first.color || patch.color,
    align: patch.align,
    wrap: patch.wrap,
    selection,
  };
}

export function sameFormat(a: FormatState | null, b: FormatState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    Math.abs(a.fontSize - b.fontSize) < 0.005 &&
    a.color === b.color &&
    a.align === b.align &&
    a.wrap === b.wrap &&
    a.selection === b.selection
  );
}

// What the page offers the rest of the editor for formatting the selected text patch: `begin`
// and `end` bracket one adjustment (a slider drag, an open colour picker) into a single undo
// step; `apply` on its own is one step.
export type FormatApi = {
  begin: () => void;
  apply: (change: FormatChange) => void;
  end: () => void;
};
