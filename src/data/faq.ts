// Questions answered on the FAQ page and, for the first few, on the landing page. Answers are
// Markdown. Keep them true to the code: every claim here is checked against src/.
import { ANALYTICS } from "./product.ts";

const TRACKING = ANALYTICS.enabled
  ? "There is no account. Google Analytics counts visits to the site's pages only if you agree in the notice, and it never runs on the editor pages, so no script runs beside your document and no server ever sees it."
  : ANALYTICS.counter
    ? "There is no account. A cookieless counter from Cloudflare records which pages were opened and roughly where from, with no cookies and no identifier; it is not loaded on the editing page, and no server ever sees your document."
    : "There is no account, no analytics script and no server that ever sees your document.";

export type FaqEntry = { question: string; answer: string };

export const FAQ: FaqEntry[] = [
  {
    question: "Does Edit My PDF upload my PDF anywhere?",
    answer:
      `No. The file is read by pdf.js inside a web worker in your browser, edited there, and written back with pdf-lib in the same tab. The only network requests the app makes are for its own files: code, fonts, the helper files pdf.js loads for some documents, the sample PDF and the emoji images. ${TRACKING} See the [privacy page](/privacy) for exactly what is stored and where.`,
  },
  {
    question: "Can I change the words that are already printed in the PDF?",
    answer:
      "Yes. In the select tool, click a heading, a line or a whole paragraph and type. The text opens in the font the page embeds, at its size, colour, letter spacing and word spacing, and a paragraph wraps inside its own column. The original words are hidden under the edit while you work and taken out of the page when you download.",
  },
  {
    question: "Is it free?",
    answer:
      "Yes. There is no account, no daily task counter, no watermark and no file size limit other than what your browser can hold in memory.",
  },
  {
    question: "Does the downloaded PDF contain real text or a picture of my edit?",
    answer:
      "Real text, in the page's own font. On export, Edit My PDF removes the original strings under your edit from the page's content stream, embeds a subset of the font pdf.js decoded, and writes your words as text positioned exactly where the editor showed them. If a face cannot be embedded (a Type 3 font, or a font the page did not embed) or you typed a character the font has no glyph for, that one edit is painted as an image instead so the page still looks right.",
  },
  {
    question: "What happens if I type a character the PDF's font does not have?",
    answer:
      "The PDF usually embeds only the glyphs the document used, so an unusual letter may be missing. In the editor that character is drawn with a fallback font so you can see it; when you download, that edit is painted as an image rather than written as text.",
  },
  {
    question: "Can I edit a scanned PDF?",
    answer:
      "Not its text. A scan is a picture with no text to edit, and Edit My PDF does not do optical character recognition. You can still draw, type new text boxes and sign on top of it. Tools that offer OCR are listed in the [comparisons](/compare).",
  },
  {
    question: "Can it open password-protected PDFs?",
    answer: "No. A password-protected file is refused with a message. Remove the password first with the tool that set it.",
  },
  {
    question: "Where are my documents kept?",
    answer:
      "In this browser, in an IndexedDB database named `pdf-editor`. Each document gets its own link, so a refresh brings it back with every edit. The documents page lists what is stored and lets you remove any of them; clearing the site's data in your browser removes everything.",
  },
  {
    question: "Does it work on a phone?",
    answer:
      "The editor runs in current versions of Chrome, Edge, Firefox and Safari, and understands touch for drawing, dragging and pinch zoom. The panels are laid out for a laptop or tablet screen, so a phone works but is cramped.",
  },
  {
    question: "Can I merge, split, compress, convert or OCR a PDF?",
    answer:
      "No. Edit My PDF is an editor, not a converter. It opens one PDF, lets you change what is on its pages, and writes a new PDF. For those other jobs the [comparison pages](/compare) say which tools do them well.",
  },
  {
    question: "What else can I put on a page?",
    answer:
      "Text boxes in Helvetica, Times or Courier with size, colour, bold, italic, underline and alignment; pencil strokes with seven brush styles; lines and arrows; more than seventy shapes with fill and stroke; emoji; and a signature drawn by hand or typed in a script face. Everything can be moved, resized, rotated and undone.",
  },
];
