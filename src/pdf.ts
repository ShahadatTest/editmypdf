import { PDFDocument } from "pdf-lib";
import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFJS_RESOURCES } from "virtual:pdfjs-resources";

GlobalWorkerOptions.workerSrc = workerUrl;

// Where pdf.js fetches what it needs while a document is open, all from this site's own origin
// (vite.config.ts copies the files out of pdfjs-dist): the WebAssembly decoders for JPEG 2000 and
// JBIG2 images and for ICC colour, the predefined CMaps of CJK fonts, the CMYK profile and the
// standard 14 fonts. All four addresses have to be given together: pdf.js lets its worker fetch
// them, and supports ICC colour at all, only when the CMap, font and wasm addresses are all set.
const resources = `${import.meta.env.BASE_URL}${PDFJS_RESOURCES}`;
const RESOURCE_OPTIONS = {
  wasmUrl: `${resources}wasm/`,
  iccUrl: `${resources}iccs/`,
  cMapUrl: `${resources}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${resources}standard_fonts/`,
};

type DocumentOptions = Omit<NonNullable<Parameters<typeof getDocument>[0]>, "data">;

// Every document the app opens with pdf.js goes through here, so pdf.js always knows where its
// resources are, whether the document is being edited or drawn as a thumbnail.
export function openDocument(data: Uint8Array, options: DocumentOptions = {}): PDFDocumentLoadingTask {
  return getDocument({ data, ...RESOURCE_OPTIONS, ...options });
}

export type LoadedPdf = {
  name: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  pages: PDFPageProxy[];
  viewports: PageViewport[];
};

export async function createBlankPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  return document.save();
}

export async function loadPdf(bytes: Uint8Array, name: string): Promise<LoadedPdf> {
  const stored = new Uint8Array(bytes);
  // Keeping the converted font bytes lets content editing register corrected copies of the faces.
  const doc = await openDocument(stored.slice(0), { fontExtraProperties: true }).promise;
  const pages: PDFPageProxy[] = [];
  const viewports: PageViewport[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    pages.push(page);
    viewports.push(page.getViewport({ scale: 1 }));
  }
  return { name, bytes: stored, doc, pages, viewports };
}

const detailCache = new WeakMap<PDFPageProxy, HTMLCanvasElement>();

export async function detailCanvas(page: PDFPageProxy): Promise<HTMLCanvasElement> {
  const cached = detailCache.get(page);
  if (cached) return cached;
  const viewport = page.getViewport({ scale: 4 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({
    canvas,
    viewport,
    annotationMode: AnnotationMode.ENABLE,
  }).promise;
  detailCache.set(page, canvas);
  return canvas;
}

export function startRender(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number) {
  const pixelRatio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * pixelRatio });
  const buffer = document.createElement("canvas");
  buffer.width = Math.max(1, Math.floor(viewport.width));
  buffer.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({
    canvas: buffer,
    viewport,
    annotationMode: AnnotationMode.ENABLE,
  });
  let cancelled = false;
  const promise = task.promise.then(() => {
    if (cancelled) return;
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    canvas.getContext("2d")?.drawImage(buffer, 0, 0);
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      task.cancel();
    },
  };
}
