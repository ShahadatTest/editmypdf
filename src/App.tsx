import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DragEvent as ReactDragEvent, ReactNode } from "react";
import { scanType3Fonts, type ContentElement } from "./content.ts";
import { annotatedDownloadName } from "./downloadName.ts";
import { exportAnnotatedPdf } from "./exportPdf.ts";
import { clamp } from "./geometry.ts";
import { useHistory } from "./history.ts";
import { Inspector } from "./Inspector.tsx";
import { PageStage } from "./PageStage.tsx";
import { describeObjects, removalFor, type ObjectHover } from "./objects.ts";
import { prefersReducedMotion, revealIn } from "./reveal.ts";
import { loadPdf, type LoadedPdf } from "./pdf.ts";
import { navigate } from "./router.ts";
import { createSession, listSessions, persistAnnotations, readSession, readySessions, type SessionInfo } from "./session.ts";
import type { Brush } from "./brushes.ts";
import { isBoxShape, isLinearShape, isOpenShape, SHAPE_LABEL, shapeFromLine, type ShapeId } from "./shapes.ts";
import type { FormatApi, FormatChange, FormatState } from "./textFormat.ts";
import { measureTextWidth } from "./textMeasure.ts";
import {
  ChevronDown,
  Download,
  Eraser,
  FileQuestion,
  FileText,
  FolderOpen,
  LayoutGrid,
  Monitor,
  Moon,
  MousePointer2,
  PanelRight,
  Pencil,
  Redo2,
  RotateCcw,
  RotateCw,
  Shapes,
  Signature,
  Smile,
  Sun,
  SunMoon,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppBar } from "./AppBar.tsx";
import type { MenuDef } from "./menus.tsx";
import { PagesPanel } from "./PagesPanel.tsx";
import { shortcut } from "./shortcuts.ts";
import { StatusBar, type FitMode } from "./StatusBar.tsx";
import { isThemeChoice, readTheme, storeTheme, subscribeTheme, type ThemeChoice } from "./theme.ts";
import { ThemeSelect } from "./ThemeSelect.tsx";
import { LogoMark } from "./site/Logo.tsx";
import { PRODUCT, ROUTES } from "./data/product.ts";
import { ToolDock } from "./ToolDock.tsx";
import { ToolRail } from "./ToolRail.tsx";
import {
  isStrokeAnnotation,
  type Align,
  type Annotation,
  type FontId,
  type LineCap,
  type StrokeStyle,
  type TextAnnotation,
  type EmojiAnnotation,
  type SignatureAnnotation,
  type TextStyle,
  type Tool,
  uid,
} from "./types.ts";
import "./chrome.css";
import "./App.css";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const DEFAULT_STROKE: StrokeStyle = {
  color: "#1d4ed8",
  strokeWidth: 2,
  fill: null,
  fillOpacity: 1,
  opacity: 1,
  cap: "round",
  dash: null,
  brush: "pen",
};

function paintAnnotation(item: Annotation, partial: Partial<StrokeStyle>): Annotation {
  if (item.kind === "ink") {
    return {
      ...item,
      color: partial.color ?? item.color,
      strokeWidth: partial.strokeWidth ?? item.strokeWidth,
      opacity: partial.opacity ?? item.opacity,
      cap: partial.cap ?? item.cap,
      dash: partial.dash === undefined ? item.dash : partial.dash,
      brush: partial.brush ?? item.brush,
    };
  }
  if (item.kind === "line") {
    return {
      ...item,
      color: partial.color ?? item.color,
      strokeWidth: partial.strokeWidth ?? item.strokeWidth,
    };
  }
  if (isBoxShape(item)) {
    return {
      ...item,
      color: partial.color ?? item.color,
      strokeWidth: partial.strokeWidth ?? item.strokeWidth,
      fill: partial.fill === undefined ? item.fill : partial.fill,
      fillOpacity: partial.fillOpacity ?? item.fillOpacity ?? 1,
    };
  }
  return item;
}
const DEFAULT_TEXT: TextStyle = {
  fontId: "helvetica",
  fontSize: 18,
  color: "#111111",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  align: "left",
  width: 220,
  autoWidth: true,
  height: null,
};

function mergeText(item: TextAnnotation, partial: Partial<TextStyle>): TextAnnotation {
  const next = { ...item, ...partial };
  if (partial.width !== undefined) next.autoWidth = false;
  if (
    next.autoWidth &&
    (partial.autoWidth ||
      partial.fontId !== undefined ||
      partial.fontSize !== undefined ||
      partial.bold !== undefined ||
      partial.italic !== undefined)
  ) {
    next.width = measureTextWidth(next);
  }
  return next;
}

type PageReadout = {
  index: number;
  tipTop: number;
  tipRight: number;
  canScroll: boolean;
};

function readPageScroll(node: HTMLElement): PageReadout {
  const wraps = node.querySelectorAll<HTMLElement>(".page-wrap");
  const view = node.getBoundingClientRect();
  const mid = view.top + view.height / 2;
  let index = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < wraps.length; i += 1) {
    const rect = wraps[i].getBoundingClientRect();
    if (rect.top <= mid && rect.bottom >= mid) {
      index = i;
      break;
    }
    const distance = Math.abs(rect.top + rect.height / 2 - mid);
    if (distance < best) {
      best = distance;
      index = i;
    }
  }
  const maxScroll = node.scrollHeight - node.clientHeight;
  const ratio = maxScroll <= 0 ? 0 : node.scrollTop / maxScroll;
  const thumbHeight = Math.max(
    28,
    (node.clientHeight / Math.max(node.scrollHeight, 1)) * node.clientHeight,
  );
  const travel = Math.max(0, node.clientHeight - thumbHeight);
  const measured = node.offsetWidth - node.clientWidth;
  const bar = measured > 0 ? measured : 14;
  return {
    index,
    tipTop: ratio * travel + thumbHeight / 2,
    tipRight: bar + 10,
    canScroll: maxScroll > 1,
  };
}

function IconTip({
  label,
  keys,
  disabled = false,
  pressed,
  onClick,
  children,
}: {
  label: string;
  keys?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-disabled={disabled}
          aria-pressed={pressed}
          className={disabled ? "bar-icon disabled" : "bar-icon"}
          onClick={() => {
            if (!disabled) onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        {label}
        {keys && <kbd className="tip-kbd">{keys}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

type PageRotation = 0 | 90 | 180 | 270;

function isPageRotation(value: unknown): value is PageRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

const TOOLS = ["select", "pencil", "shape", "emoji", "signature", "text", "eraser"] as const;

function isTool(value: unknown): value is Tool {
  return typeof value === "string" && (TOOLS as readonly string[]).includes(value);
}

function isShapeId(value: unknown): value is ShapeId {
  return typeof value === "string" && value in SHAPE_LABEL;
}

function chromeKey(sessionId: string): string {
  return `pdf-editor:chrome:${sessionId}`;
}

const ZOOM_KEY = "pdf-editor:zoom";
// The fit the zoom follows ("width", "page" or "height"), kept while the user has not zoomed by hand.
const FIT_KEY = "pdf-editor:fit";
const SIDEBAR_KEY = "pdf-editor:inspector";
const PAGES_PANEL_KEY = "pdf-editor:pages-panel";

// Windows narrower than this open with the side panels closed; they would cover the page.
const WIDE_WINDOW = 1100;
const THUMBNAIL_WINDOW = 1280;

function readFit(): FitMode | null {
  try {
    const raw = localStorage.getItem(FIT_KEY);
    return raw === "width" || raw === "page" || raw === "height" ? raw : null;
  } catch {
    return null;
  }
}

function readZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    const value = raw == null ? 1 : Number(raw);
    if (!Number.isFinite(value)) return 1;
    return clamp(value, MIN_ZOOM, MAX_ZOOM);
  } catch {
    return 1;
  }
}

function readPanel(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored === "open") return true;
    if (stored === "closed") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writePanel(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "open" : "closed");
  } catch {
    // Storage can be blocked in private browsing.
  }
}

function readChrome(sessionId: string): { tool: Tool; shape: ShapeId; rotation: PageRotation } {
  const fallback = { tool: "select" as const, shape: "rect" as const, rotation: 0 as const };
  try {
    const raw = sessionStorage.getItem(chromeKey(sessionId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { tool?: unknown; shape?: unknown; rotation?: unknown };
    return {
      tool: isTool(parsed.tool) ? parsed.tool : "select",
      shape: isShapeId(parsed.shape) ? parsed.shape : "rect",
      rotation: isPageRotation(parsed.rotation) ? parsed.rotation : 0,
    };
  } catch {
    return fallback;
  }
}

const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  { value: "system", label: "System", icon: <Monitor /> },
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
];

const serverTheme = (): ThemeChoice => "system";

export function Editor({ sessionId }: { sessionId: string }) {
  const history = useHistory<Annotation[]>([]);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>(() => listSessions());
  const [tool, setTool] = useState<Tool>(() => readChrome(sessionId).tool);
  const [shape, setShape] = useState<ShapeId>(() => readChrome(sessionId).shape);
  const [dockKind, setDockKind] = useState<"pencil" | "shape" | "emoji" | "signature">(() => {
    const restored = readChrome(sessionId).tool;
    if (restored === "pencil" || restored === "shape" || restored === "emoji" || restored === "signature") return restored;
    return "shape";
  });
  const [dockOpen, setDockOpen] = useState(() => {
    const initial = readChrome(sessionId).tool;
    return initial === "pencil" || initial === "shape" || initial === "emoji" || initial === "signature";
  });
  // The two side panels: objects and properties on the right, page thumbnails on the left.
  const [sidebarOpen, setSidebarOpen] = useState(() => readPanel(SIDEBAR_KEY, true) && window.innerWidth >= WIDE_WINDOW);
  const [pagesPanelOpen, setPagesPanelOpen] = useState(() =>
    readPanel(PAGES_PANEL_KEY, window.innerWidth >= THUMBNAIL_WINDOW) && window.innerWidth >= WIDE_WINDOW,
  );
  const [pageRotation, setPageRotation] = useState<PageRotation>(() => readChrome(sessionId).rotation);
  const [spin, setSpin] = useState<number>(() => readChrome(sessionId).rotation);
  const [viewReady, setViewReady] = useState(false);
  const [scale, setScale] = useState(readZoom);
  // The fit the zoom follows until the user sets a zoom of their own: while it is set, the pages
  // refit whenever the room for them changes (a panel opens or closes, the window resizes, the
  // pages rotate), and it is kept across reloads like the zoom itself.
  const [fitMode, setFitMode] = useState<FitMode | null>(readFit);
  const [strokeStyle, setStrokeStyle] = useState<StrokeStyle>(DEFAULT_STROKE);
  const [textStyle, setTextStyle] = useState<TextStyle>(DEFAULT_TEXT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contentSelection, setContentSelection] = useState<ContentElement | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  // The mark under the pointer, on a page or in the object list; the other side mirrors it.
  const [hover, setHover] = useState<ObjectHover | null>(null);
  // How the selected text patch's caret or selection is formatted, as the page reports it, and
  // the page's actions on it, for the attributes pane.
  const [formatState, setFormatState] = useState<FormatState | null>(null);
  const formatApi = useRef<FormatApi | null>(null);
  const registerFormat = useCallback((api: FormatApi | null) => {
    formatApi.current = api;
  }, []);
  const applyFormat = useCallback((change: FormatChange) => formatApi.current?.apply(change), []);
  const beginFormat = useCallback(() => formatApi.current?.begin(), []);
  const endFormat = useCallback(() => formatApi.current?.end(), []);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [missing, setMissing] = useState(false);
  const [readout, setReadout] = useState<PageReadout>({
    index: 0,
    tipTop: 24,
    tipRight: 24,
    canScroll: false,
  });
  const [scrollTip, setScrollTip] = useState(false);
  const [barHover, setBarHover] = useState(false);
  const theme = useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
  const fileRef = useRef<HTMLInputElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const scrollTipTimer = useRef(0);
  const loadedRef = useRef<LoadedPdf | null>(null);
  const loadId = useRef(0);
  const styleBaseline = useRef<Annotation[] | null>(null);
  const epochRef = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const downloadRef = useRef<() => void>(() => undefined);
  const hydrated = useRef(false);
  const scaleRef = useRef(scale);
  const pinchOrigin = useRef(1);
  const toolRef = useRef(tool);
  scaleRef.current = scale;
  // A zoom the user chose; it ends any fit the zoom was following.
  const zoomTo = useCallback((next: number | ((value: number) => number)) => {
    setFitMode(null);
    setScale((value) => clamp(typeof next === "function" ? next(value) : next, MIN_ZOOM, MAX_ZOOM));
  }, []);
  toolRef.current = tool;

  selectedRef.current = selectedId;

  const syncPageReadout = useCallback(() => {
    const node = pagesRef.current;
    if (!node) return;
    const next = readPageScroll(node);
    setReadout((current) =>
      current.index === next.index &&
      current.canScroll === next.canScroll &&
      current.tipRight === next.tipRight &&
      Math.abs(current.tipTop - next.tipTop) < 0.5
        ? current
        : next,
    );
  }, []);

  const revealScrollTip = useCallback(() => {
    syncPageReadout();
    setScrollTip(true);
    window.clearTimeout(scrollTipTimer.current);
    scrollTipTimer.current = window.setTimeout(() => setScrollTip(false), 800);
  }, [syncPageReadout]);

  useEffect(() => {
    syncPageReadout();
    const node = pagesRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => syncPageReadout());
    observer.observe(node);
    return () => observer.disconnect();
  }, [loaded, scale, pageRotation, syncPageReadout]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const node = pagesRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const measured = node.offsetWidth - node.clientWidth;
      const bar = measured > 0 ? measured : 14;
      const over =
        event.clientX >= rect.right - bar &&
        event.clientX <= rect.right + 1 &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      setBarHover((current) => (current === over ? current : over));
      if (over) syncPageReadout();
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [syncPageReadout]);

  useEffect(() => () => window.clearTimeout(scrollTipTimer.current), []);

  useEffect(() => {
    if (!loaded) return;
    const frame = requestAnimationFrame(() => setViewReady(true));
    return () => cancelAnimationFrame(frame);
  }, [loaded]);

  useEffect(() => {
    const refresh = () => setSessions(listSessions());
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [sessionId, loaded?.name]);

  useEffect(() => writePanel(SIDEBAR_KEY, sidebarOpen), [sidebarOpen]);
  useEffect(() => writePanel(PAGES_PANEL_KEY, pagesPanelOpen), [pagesPanelOpen]);

  const bump = useCallback(() => {
    epochRef.current += 1;
  }, []);

  const getAnnotations = useCallback(() => history.valueRef.current, [history.valueRef]);
  const getEpoch = useCallback(() => epochRef.current, []);
  const consumeFocus = useCallback(() => setFocusId(null), []);
  const requestFocus = useCallback((id: string) => setFocusId(id), []);

  // Each side only clears a hover it set itself, so a row's mouseleave never wipes out the
  // page hover that follows it (and the other way round).
  const hoverFromPage = useCallback((id: string | null) => {
    setHover((current) => {
      if (id) return current?.id === id && current.from === "page" ? current : { id, from: "page" };
      return current?.from === "page" ? null : current;
    });
  }, []);
  const hoverFromList = useCallback((id: string | null) => {
    setHover((current) => {
      if (id) return current?.id === id && current.from === "list" ? current : { id, from: "list" };
      return current?.from === "list" ? null : current;
    });
  }, []);

  const chooseTool = useCallback((next: Tool) => {
    if (next === "pencil" || next === "shape" || next === "emoji" || next === "signature") {
      if (toolRef.current === next) {
        setDockOpen((open) => !open);
        return;
      }
      setDockKind(next);
      setTool(next);
      setDockOpen(true);
      return;
    }
    setTool(next);
    setDockOpen(false);
  }, []);

  // Picks a shape for the shape tool and opens the shape options.
  const pickShape = useCallback((id: ShapeId) => {
    setShape(id);
    setDockKind("shape");
    setTool("shape");
    setDockOpen(true);
  }, []);

  const remember = useCallback(
    (baseline: Annotation[]) => {
      if (history.pushBaseline(baseline)) bump();
    },
    [history.pushBaseline, bump],
  );

  const save = useCallback(
    (next: Annotation[]) => {
      if (history.commit(next)) bump();
    },
    [history.commit, bump],
  );

  // Removing a mark, whether with Delete, from the attributes pane or from the object list, is one
  // undo step.
  const removeObject = useCallback(
    (id: string) => {
      const current = getAnnotations();
      const removed = current.find((item) => item.id === id);
      if (!removed) return;
      save(current.filter((item) => item.id !== id));
      if (selectedRef.current === id) setSelectedId(null);
      if (removed.kind === "patch") setContentSelection(null);
    },
    [getAnnotations, save],
  );

  useEffect(() => {
    document.title = loaded ? `${loaded.name} — ${PRODUCT.name}` : PRODUCT.name;
  }, [loaded]);

  useEffect(() => {
    try {
      sessionStorage.setItem(chromeKey(sessionId), JSON.stringify({ tool, shape, rotation: pageRotation }));
      localStorage.setItem(ZOOM_KEY, String(scale));
      if (fitMode) localStorage.setItem(FIT_KEY, fitMode);
      else localStorage.removeItem(FIT_KEY);
    } catch {
      // Storage can be blocked in private browsing.
    }
  }, [sessionId, tool, shape, pageRotation, scale, fitMode]);

  useEffect(() => {
    let cancelled = false;
    const id = ++loadId.current;
    void (async () => {
      try {
        await readySessions();
        const session = await readSession(sessionId);
        if (cancelled || loadId.current !== id) return;
        if (!session) {
          setMissing(true);
          hydrated.current = true;
          return;
        }
        const next = await loadPdf(session.bytes, session.name);
        if (cancelled || loadId.current !== id) {
          await next.doc.cleanup();
          return;
        }
        history.reset(session.annotations);
        setContentSelection(null);
        loadedRef.current = next;
        hydrated.current = true;
        // Pages printed from a browser draw their text with Type3 fonts, one per run; pooling
        // the whole document's glyphs lets the faces rebuilt for the open pages cover the
        // letters the other pages drew. The scan starts before the first page is read, which
        // waits a moment for it.
        void scanType3Fonts(next.bytes, next.doc.loadingTask.docId);
        setLoaded(next);
      } catch (cause) {
        if (!cancelled && loadId.current === id) {
          console.error(cause);
          setError("Could not open this document.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [history.reset, sessionId]);

  useEffect(() => {
    if (!hydrated.current || !loaded || missing) return;
    const timer = window.setTimeout(() => persistAnnotations(sessionId, history.value), 80);
    const flush = () => persistAnnotations(sessionId, history.valueRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [loaded, missing, history.value, history.valueRef, sessionId]);

  useEffect(() => {
    let gestureAt = 0;
    const insideApp = (event: Event) => {
      const root = document.querySelector(".app");
      return event.target instanceof Node && !!root?.contains(event.target);
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!insideApp(event)) return;
      event.preventDefault();
      if (performance.now() - gestureAt < 80) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const delta = event.deltaY * unit;
      zoomTo((value) => value * Math.exp(-delta * 0.0025));
    };
    const onGestureStart = (event: Event) => {
      if (!insideApp(event)) return;
      event.preventDefault();
      gestureAt = performance.now();
      pinchOrigin.current = scaleRef.current;
    };
    const onGestureChange = (event: Event) => {
      if (!insideApp(event)) return;
      event.preventDefault();
      gestureAt = performance.now();
      const factor = (event as Event & { scale?: number }).scale ?? 1;
      zoomTo(pinchOrigin.current * factor);
    };
    const onGestureEnd = () => {
      gestureAt = performance.now();
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("gesturestart", onGestureStart, { passive: false });
    window.addEventListener("gesturechange", onGestureChange, { passive: false });
    window.addEventListener("gestureend", onGestureEnd);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("gesturestart", onGestureStart);
      window.removeEventListener("gesturechange", onGestureChange);
      window.removeEventListener("gestureend", onGestureEnd);
    };
  }, [zoomTo]);

  useEffect(() => {
    if (selectedId && !history.value.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }, [history.value, selectedId]);

  // Hovering a row scrolls the document to its mark when that is off screen (the highlight is
  // drawn by the page, so it is already in the DOM here); hovering the page never moves the view.
  useEffect(() => {
    if (!hover || hover.from !== "list") return;
    const pages = pagesRef.current;
    if (!pages) return;
    const target = pages.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(hover.id)}"]`);
    if (target) revealIn(pages, target, "center", !prefersReducedMotion());
  }, [hover]);

  const openFiles = useCallback(async (files: File[]) => {
    const pdfs = files.filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    );
    if (pdfs.length === 0) {
      setError("Choose a PDF file.");
      return;
    }
    setError(null);
    let firstId = "";
    try {
      for (const file of pdfs) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = await loadPdf(bytes, file.name);
        await parsed.doc.cleanup();
        const id = await createSession(file.name, bytes, []);
        if (!firstId) firstId = id;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not open this PDF";
      setError(
        message.toLowerCase().includes("password")
          ? "This PDF is password protected."
          : "Could not open this PDF.",
      );
    }
    if (firstId) navigate(`/edit/${firstId}`);
  }, []);

  const download = useCallback(async () => {
    const current = loadedRef.current;
    if (!current || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const bytes = await exportAnnotatedPdf(
        current.bytes,
        history.valueRef.current,
        (page, x, y) => {
          const viewport = current.viewports[page];
          if (!viewport) return { x, y };
          const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y) as number[];
          return { x: pdfX ?? x, y: pdfY ?? y };
        },
        pageRotation,
        current.pages,
      );
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = annotatedDownloadName(current.name);
      link.click();
      // Revoke after a tick so Safari/Firefox can start the download first.
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) {
      console.error(cause);
      setError("The PDF could not be written.");
    } finally {
      setExporting(false);
    }
  }, [exporting, history.valueRef, pageRotation]);

  downloadRef.current = () => {
    void download();
  };

  // Scrolls the viewer so the page with this index (from 0) starts at the top.
  const goToPage = useCallback((index: number) => {
    const node = pagesRef.current;
    if (!node) return;
    const wraps = node.querySelectorAll<HTMLElement>(".page-wrap");
    const wrap = wraps[clamp(index, 0, wraps.length - 1)];
    if (!wrap) return;
    const top = wrap.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - 24;
    node.scrollTo({ top: Math.max(0, top), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) history.redo();
        else history.undo();
        bump();
        return;
      }
      if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        downloadRef.current();
        return;
      }
      if (meta && event.key.toLowerCase() === "o" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        fileRef.current?.click();
        return;
      }
      if (meta && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        zoomTo((value) => value + 0.25);
        return;
      }
      if (meta && event.key === "-") {
        event.preventDefault();
        zoomTo((value) => value - 0.25);
        return;
      }
      if (meta && event.key === "0") {
        event.preventDefault();
        zoomTo(1);
        return;
      }
      if (typing || meta || event.altKey) return;
      const key = event.key.toLowerCase();
      const shapeShortcuts: Record<string, ShapeId> = {
        l: "line",
        r: "rect",
        o: "ellipse",
      };
      const pickedShape = shapeShortcuts[key];
      if (key === "s") {
        chooseTool("shape");
        return;
      }
      if (pickedShape) {
        pickShape(pickedShape);
        return;
      }
      const shortcuts: Record<string, Tool> = {
        v: "select",
        p: "pencil",
        m: "emoji",
        g: "signature",
        t: "text",
        e: "eraser",
      };
      const nextTool = shortcuts[key];
      if (nextTool) {
        chooseTool(nextTool);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedRef.current) {
        event.preventDefault();
        removeObject(selectedRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history.redo, history.undo, bump, removeObject, chooseTool, pickShape, zoomTo]);

  const placeEmoji = (emojiId: string) => {
    const document = loadedRef.current;
    if (!document || document.pages.length === 0) return;
    const page = Math.min(readout.index, document.pages.length - 1);
    const viewport = document.viewports[page];
    if (!viewport) return;
    const size = 72;
    const placed = history.valueRef.current.filter((item) => item.kind === "emoji" && item.page === page).length;
    const nudge = (placed % 8) * 16;
    const annotation: EmojiAnnotation = {
      id: uid(),
      page,
      kind: "emoji",
      emoji: emojiId,
      x: Math.max(8, viewport.width / 2 - size / 2 + nudge),
      y: Math.max(8, viewport.height / 2 - size / 2 + nudge),
      w: size,
      h: size,
      rotation: 0,
    };
    save([...history.valueRef.current, annotation]);
    setSelectedId(annotation.id);
  };

  const placeSignature = (src: string, pixelWidth: number, pixelHeight: number) => {
    const document = loadedRef.current;
    if (!document || document.pages.length === 0) return;
    const page = Math.min(readout.index, document.pages.length - 1);
    const viewport = document.viewports[page];
    if (!viewport) return;
    const aspect = pixelWidth / Math.max(1, pixelHeight);
    let height = 56;
    let width = Math.max(48, height * aspect);
    const maxWidth = Math.max(48, viewport.width - 24);
    if (width > maxWidth) {
      width = maxWidth;
      height = width / aspect;
    }
    const placed = history.valueRef.current.filter((item) => item.kind === "signature" && item.page === page).length;
    const nudge = (placed % 8) * 16;
    const annotation: SignatureAnnotation = {
      id: uid(),
      page,
      kind: "signature",
      src,
      x: Math.max(8, viewport.width / 2 - width / 2 + nudge),
      y: Math.max(8, viewport.height / 2 - height / 2 + nudge),
      w: width,
      h: height,
      rotation: 0,
    };
    save([...history.valueRef.current, annotation]);
    setSelectedId(annotation.id);
  };

  // The zoom at which the pages fit the room they have: by width, by height, or both.
  const fitScale = useCallback(
    (mode: FitMode): number | null => {
      const node = pagesRef.current;
      const viewport = loadedRef.current?.viewports[0];
      if (!node || !viewport || viewport.width === 0 || viewport.height === 0) return null;
      const sideways = pageRotation === 90 || pageRotation === 270;
      const pageWidth = sideways ? viewport.height : viewport.width;
      const pageHeight = sideways ? viewport.width : viewport.height;
      const widthScale = (node.clientWidth - 64) / pageWidth;
      const heightScale = (node.clientHeight - 80) / pageHeight;
      const next =
        mode === "width" ? widthScale : mode === "height" ? heightScale : Math.min(widthScale, heightScale);
      return clamp(next, MIN_ZOOM, MAX_ZOOM);
    },
    [pageRotation],
  );

  const fitZoom = (mode: FitMode) => {
    setFitMode(mode);
    const next = fitScale(mode);
    if (next != null) setScale(next);
  };

  // While a fit is on, the pages refit whenever their room changes: the thumbnail strip, a tool
  // panel or the sidebar opening or closing (the fit follows the slide), the window resizing, a
  // rotation. The observer also reports once when it starts watching, which applies a fit
  // restored from storage as soon as the document is loaded.
  useEffect(() => {
    if (!fitMode) return;
    const node = pagesRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const next = fitScale(fitMode);
      if (next != null && Math.abs(next - scaleRef.current) > 0.0005) setScale(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fitMode, fitScale, loaded]);

  const rotate = () => {
    setPageRotation((current) => ((current + 90) % 360) as PageRotation);
    setSpin((current) => current + 90);
  };

  const undo = () => {
    history.undo();
    bump();
  };
  const redo = () => {
    history.redo();
    bump();
  };

  const objects = useMemo(() => describeObjects(history.value), [history.value]);
  const objectNumbers = useMemo(() => new Map(objects.map((row) => [row.id, row.number])), [objects]);
  // A hover outlives the mark it points at (removed under the pointer); it just stops showing.
  const liveHover = hover && objectNumbers.has(hover.id) ? hover : null;

  const selected = history.value.find((item) => item.id === selectedId) ?? null;
  const removal = removalFor(selected);
  const selectedShape =
    selected?.kind === "line"
      ? shapeFromLine(selected.head)
      : selected && isBoxShape(selected)
        ? selected.kind
        : null;
  const stroke: StrokeStyle =
    selected && isStrokeAnnotation(selected)
      ? {
          color: selected.color,
          strokeWidth: selected.strokeWidth,
          fill: isBoxShape(selected) ? (selected.fill ?? null) : strokeStyle.fill,
          fillOpacity: isBoxShape(selected) ? (selected.fillOpacity ?? 1) : strokeStyle.fillOpacity,
          opacity: selected.kind === "ink" ? (selected.opacity ?? 1) : strokeStyle.opacity,
          cap: selected.kind === "ink" ? (selected.cap ?? "round") : strokeStyle.cap,
          dash: selected.kind === "ink" ? (selected.dash ?? null) : strokeStyle.dash,
          brush: selected.kind === "ink" ? (selected.brush ?? "pen") : strokeStyle.brush,
        }
      : strokeStyle;
  const showFill = selected
    ? isBoxShape(selected) && !isOpenShape(selected.kind)
    : tool === "shape" && !isLinearShape(shape) && !isOpenShape(shape);
  const showInk = selected ? selected.kind === "ink" : tool === "pencil";
  const text: TextStyle =
    selected?.kind === "text"
      ? {
          fontId: selected.fontId,
          fontSize: selected.fontSize,
          color: selected.color,
          bold: selected.bold,
          italic: selected.italic,
          underline: selected.underline,
          strike: selected.strike ?? false,
          align: selected.align,
          width: selected.width,
          autoWidth: selected.autoWidth,
          height: selected.height,
        }
      : textStyle;

  const beginAdjust = () => {
    if (!styleBaseline.current) styleBaseline.current = history.valueRef.current;
  };

  const endAdjust = () => {
    const baseline = styleBaseline.current;
    if (!baseline) return;
    styleBaseline.current = null;
    remember(baseline);
  };

  const applyStroke = (partial: Partial<StrokeStyle>, live: boolean) => {
    setStrokeStyle((current) => ({ ...current, ...partial }));
    const chosen = history.valueRef.current.find((item) => item.id === selectedRef.current);
    if (!chosen || !isStrokeAnnotation(chosen)) return;
    const base = styleBaseline.current ?? history.valueRef.current;
    const next = base.map((item) => (item.id === chosen.id ? paintAnnotation(item, partial) : item));
    if (live && styleBaseline.current) history.replace(next);
    else save(next);
  };

  const applyText = (partial: Partial<TextStyle>, live: boolean) => {
    setTextStyle((current) => {
      const next = { ...current, ...partial };
      if (partial.width !== undefined) next.autoWidth = false;
      return next;
    });
    const chosen = history.valueRef.current.find((item) => item.id === selectedRef.current);
    if (!chosen || chosen.kind !== "text") return;
    const base = styleBaseline.current ?? history.valueRef.current;
    const next = base.map((item) =>
      item.id === chosen.id && item.kind === "text" ? mergeText(item, partial) : item,
    );
    if (chosen.text.length === 0) {
      history.replace(next);
      return;
    }
    if (live && styleBaseline.current) history.replace(next);
    else save(next);
  };

  const onDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    void openFiles([...event.dataTransfer.files]);
  };

  const pageTotal = loaded?.pages.length ?? 0;
  const pageNumber = pageTotal === 0 ? 1 : Math.min(readout.index, pageTotal - 1) + 1;
  const showScrollTip = readout.canScroll && (scrollTip || barHover);
  const documentName = loaded?.name ?? "Opening…";

  const menus: MenuDef[] = [
    {
      id: "file",
      label: "File",
      entries: [
        { kind: "item", label: "Open PDF…", icon: <FolderOpen />, shortcut: shortcut("mod", "o"), onSelect: () => fileRef.current?.click() },
        ...(sessions.length > 1
          ? [
              {
                kind: "sub" as const,
                label: "Switch document",
                icon: <FileText />,
                entries: [
                  {
                    kind: "radio" as const,
                    value: sessionId,
                    options: sessions.map((session) => ({ value: session.id, label: session.name })),
                    onChange: (id: string) => navigate(`/edit/${id}`),
                  },
                ],
              },
            ]
          : []),
        { kind: "separator" },
        {
          kind: "item",
          label: "Download PDF",
          icon: <Download />,
          shortcut: shortcut("mod", "s"),
          disabled: !loaded || exporting,
          onSelect: () => void download(),
        },
        { kind: "separator" },
        { kind: "item", label: "All documents", icon: <LayoutGrid />, onSelect: () => navigate(ROUTES.app) },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      entries: [
        { kind: "item", label: "Undo", icon: <Undo2 />, shortcut: shortcut("mod", "z"), disabled: !history.canUndo, onSelect: undo },
        {
          kind: "item",
          label: "Redo",
          icon: <Redo2 />,
          shortcut: shortcut("shift", "mod", "z"),
          disabled: !history.canRedo,
          onSelect: redo,
        },
        { kind: "separator" },
        {
          kind: "item",
          label: removal.label,
          icon: removal.restores ? <RotateCcw /> : <Trash2 />,
          shortcut: shortcut("backspace"),
          disabled: selected === null,
          destructive: !removal.restores,
          onSelect: () => {
            if (selectedId) removeObject(selectedId);
          },
        },
        { kind: "separator" },
        { kind: "item", label: "Select", icon: <MousePointer2 />, shortcut: "V", onSelect: () => chooseTool("select") },
        { kind: "item", label: "Eraser", icon: <Eraser />, shortcut: "E", onSelect: () => chooseTool("eraser") },
      ],
    },
    {
      id: "view",
      label: "View",
      entries: [
        {
          kind: "item",
          label: "Zoom in",
          icon: <ZoomIn />,
          shortcut: shortcut("mod", "plus"),
          onSelect: () => zoomTo((value) => value + 0.25),
        },
        {
          kind: "item",
          label: "Zoom out",
          icon: <ZoomOut />,
          shortcut: shortcut("mod", "minus"),
          onSelect: () => zoomTo((value) => value - 0.25),
        },
        { kind: "item", label: "Actual size", shortcut: shortcut("mod", "0"), onSelect: () => zoomTo(1) },
        { kind: "item", label: "Fit page", onSelect: () => fitZoom("page") },
        { kind: "item", label: "Fit width", onSelect: () => fitZoom("width") },
        { kind: "item", label: "Fit height", onSelect: () => fitZoom("height") },
        { kind: "separator" },
        { kind: "item", label: "Rotate pages", icon: <RotateCw />, onSelect: rotate },
        { kind: "separator" },
        { kind: "check", label: "Page thumbnails", checked: pagesPanelOpen, onSelect: () => setPagesPanelOpen((open) => !open) },
        {
          kind: "check",
          label: "Tool options",
          checked: dockOpen,
          onSelect: () => {
            if (dockOpen) setDockOpen(false);
            else chooseTool(dockKind);
          },
        },
        { kind: "check", label: "Edits and properties", checked: sidebarOpen, onSelect: () => setSidebarOpen((open) => !open) },
        { kind: "separator" },
        {
          kind: "sub",
          label: "Theme",
          icon: <SunMoon />,
          entries: [
            {
              kind: "radio",
              value: theme,
              options: THEME_OPTIONS,
              onChange: (value) => {
                if (isThemeChoice(value)) storeTheme(value);
              },
            },
          ],
        },
      ],
    },
    {
      id: "insert",
      label: "Insert",
      entries: [
        { kind: "item", label: "Text", icon: <Type />, shortcut: "T", onSelect: () => chooseTool("text") },
        { kind: "item", label: "Pencil", icon: <Pencil />, shortcut: "P", onSelect: () => chooseTool("pencil") },
        {
          kind: "sub",
          label: "Shape",
          icon: <Shapes />,
          entries: [
            { kind: "item", label: "Rectangle", shortcut: "R", onSelect: () => pickShape("rect") },
            { kind: "item", label: "Ellipse", shortcut: "O", onSelect: () => pickShape("ellipse") },
            { kind: "item", label: "Line", shortcut: "L", onSelect: () => pickShape("line") },
            { kind: "separator" },
            { kind: "item", label: "All shapes…", shortcut: "S", onSelect: () => chooseTool("shape") },
          ],
        },
        { kind: "item", label: "Emoji", icon: <Smile />, shortcut: "M", onSelect: () => chooseTool("emoji") },
        { kind: "item", label: "Signature", icon: <Signature />, shortcut: "G", onSelect: () => chooseTool("signature") },
      ],
    },
  ];

  const titleCenter = (
    <div className="doc-title">
      {sessions.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="doc-title-button" aria-label={`${documentName}. Switch document`}>
              <FileText aria-hidden="true" />
              <span className="doc-title-name">{documentName}</span>
              <ChevronDown className="doc-title-chevron" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-72!">
            <DropdownMenuLabel>Documents in this browser</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sessionId} onValueChange={(id) => navigate(`/edit/${id}`)}>
              {sessions.map((session) => (
                <DropdownMenuRadioItem key={session.id} value={session.id}>
                  <span className="truncate">{session.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate(ROUTES.app)}>
              <LayoutGrid />
              All documents
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="doc-title-static" title={documentName}>
          <FileText aria-hidden="true" />
          <span className="doc-title-name">{documentName}</span>
        </span>
      )}
      {pageTotal > 0 && (
        <span className="doc-title-meta">
          {pageTotal} {pageTotal === 1 ? "page" : "pages"}
        </span>
      )}
    </div>
  );

  if (missing) {
    return (
      <div className="app">
        <AppBar>
          <ThemeSelect />
        </AppBar>
        <div className="app-missing" role="status">
          <span className="app-missing-icon" aria-hidden="true">
            <FileQuestion />
          </span>
          <h1>This document is not saved in this browser</h1>
          <p>Documents stay on the device they were opened on. Open the file again to keep editing it.</p>
          <Button type="button" onClick={() => navigate(ROUTES.app)}>
            <LayoutGrid />
            Back to documents
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="app"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <AppBar menus={menus} center={titleCenter}>
        <div className="bar-group history">
          <IconTip label="Undo" keys={shortcut("mod", "z")} disabled={!history.canUndo} onClick={undo}>
            <Undo2 />
          </IconTip>
          <IconTip label="Redo" keys={shortcut("shift", "mod", "z")} disabled={!history.canRedo} onClick={redo}>
            <Redo2 />
          </IconTip>
        </div>
        <span className="bar-sep" />
        <div className="bar-group panels">
          <ThemeSelect />
          <IconTip
            label={sidebarOpen ? "Hide edits and properties" : "Show edits and properties"}
            pressed={sidebarOpen}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <PanelRight />
          </IconTip>
        </div>
        <span className="bar-sep" />
        <Button type="button" variant="outline" className="bar-open" onClick={() => fileRef.current?.click()}>
          <FolderOpen />
          <span className="bar-open-label">Open</span>
        </Button>
        <Button type="button" className="bar-download" disabled={!loaded || exporting} onClick={() => void download()}>
          <Download />
          <span className="bar-download-label">{exporting ? "Saving…" : "Download"}</span>
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) void openFiles(files);
          }}
        />
      </AppBar>
      {error && (
        <div className="app-notice" role="alert">
          <TriangleAlert aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="app-notice-close" aria-label="Dismiss" onClick={() => setError(null)}>
            <X />
          </button>
        </div>
      )}
      <div className="body">
        <ToolRail tool={tool} shape={shape} panelOpen={dockOpen} onTool={chooseTool} />
        <div className={dockOpen ? "tool-dock-slot open" : "tool-dock-slot"} inert={!dockOpen}>
          <ToolDock
            tool={dockKind}
            shape={shape}
            stroke={stroke}
            onShape={(id) => {
              setShape(id);
              setTool("shape");
              setSelectedId(null);
            }}
            onBrush={(brush: Brush) => {
              setTool("pencil");
              setSelectedId(null);
              setStrokeStyle((current) => ({
                ...current,
                brush: brush.id,
                strokeWidth: brush.width,
                opacity: brush.opacity,
                cap: brush.cap,
                dash: brush.dash,
              }));
            }}
            onStrokeColor={(color) => applyStroke({ color }, styleBaseline.current !== null)}
            onStrokeWidth={(strokeWidth) =>
              applyStroke({ strokeWidth }, styleBaseline.current !== null)
            }
            onOpacity={(opacity) => applyStroke({ opacity }, styleBaseline.current !== null)}
            onCap={(cap: LineCap) => applyStroke({ cap }, false)}
            onDash={(dash) => applyStroke({ dash }, false)}
            onEmoji={placeEmoji}
            onSignature={placeSignature}
            onAdjustStart={beginAdjust}
            onAdjustEnd={endAdjust}
            onClose={() => setDockOpen(false)}
          />
        </div>
        <div className={pagesPanelOpen && loaded ? "pages-panel-slot open" : "pages-panel-slot"} inert={!pagesPanelOpen || !loaded}>
          {loaded && (
            <PagesPanel
              pages={loaded.pages}
              viewports={loaded.viewports}
              rotation={pageRotation}
              current={pageNumber - 1}
              onGo={goToPage}
            />
          )}
        </div>
        <main className="workspace">
          <div className="viewer">
            {loaded ? (
              <div
                className={viewReady ? "pages view-ready" : "pages"}
                key={sessionId}
                ref={pagesRef}
                onScroll={revealScrollTip}
              >
                {loaded.name === "Untitled.pdf" && history.value.length === 0 && (
                  <p className="blank-hint">Open a PDF, or draw and type on this blank page.</p>
                )}
                {loaded.pages.map((page, index) => (
                  <PageStage
                    key={`${sessionId}-${index}`}
                    page={page}
                    pageIndex={index}
                    scale={scale}
                    baseWidth={loaded.viewports[index]?.width ?? 612}
                    baseHeight={loaded.viewports[index]?.height ?? 792}
                    rotation={pageRotation}
                    spin={spin}
                    annotations={history.value}
                    tool={tool}
                    shape={shape}
                    stroke={strokeStyle}
                    textStyle={textStyle}
                    selectedId={selectedId}
                    hoverId={liveHover?.id ?? null}
                    listHoverId={liveHover?.from === "list" ? liveHover.id : null}
                    objectNumbers={objectNumbers}
                    onHover={hoverFromPage}
                    focusId={focusId}
                    getAnnotations={getAnnotations}
                    getEpoch={getEpoch}
                    onReplace={history.replace}
                    onPushBaseline={remember}
                    onSelect={setSelectedId}
                    selectedContent={contentSelection}
                    onSelectContent={setContentSelection}
                    onRequestFocus={requestFocus}
                    onConsumeFocus={consumeFocus}
                    onFormatState={setFormatState}
                    registerFormat={registerFormat}
                  />
                ))}
              </div>
            ) : (
              <div className="viewer-loading" role="status" aria-live="polite">
                <LogoMark size={32} />
                <span>Opening…</span>
              </div>
            )}
            {loaded && readout.canScroll && (
              <div
                className={showScrollTip ? "page-scroll-tip visible" : "page-scroll-tip"}
                style={{ top: readout.tipTop, right: readout.tipRight }}
                aria-hidden="true"
              >
                Page {pageNumber}
              </div>
            )}
          </div>
          {pageTotal > 0 && (
            <StatusBar
              pageNumber={pageNumber}
              pageTotal={pageTotal}
              onGoToPage={(page) => goToPage(page - 1)}
              scale={scale}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              presets={ZOOM_PRESETS}
              onScale={zoomTo}
              fitMode={fitMode}
              onFit={fitZoom}
              onRotate={rotate}
              pagesPanelOpen={pagesPanelOpen}
              onTogglePagesPanel={() => setPagesPanelOpen((open) => !open)}
            />
          )}
        </main>
        <Inspector
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          tool={tool}
          shape={shape}
          selectedShape={selectedShape}
          selectedKind={selected?.kind ?? null}
          stroke={stroke}
          text={text}
          showFill={showFill}
          showInk={showInk}
          canDelete={selected !== null}
          onDelete={() => {
            if (selectedId) removeObject(selectedId);
          }}
          onAdjustStart={beginAdjust}
          onAdjustEnd={endAdjust}
          onStrokeColor={(color) => applyStroke({ color }, styleBaseline.current !== null)}
          onStrokeWidth={(strokeWidth) =>
            applyStroke({ strokeWidth }, styleBaseline.current !== null)
          }
          onFill={(fill) => applyStroke({ fill }, styleBaseline.current !== null)}
          onFillOpacity={(fillOpacity) =>
            applyStroke({ fillOpacity }, styleBaseline.current !== null)
          }
          onOpacity={(opacity) => applyStroke({ opacity }, styleBaseline.current !== null)}
          onCap={(cap) => applyStroke({ cap }, false)}
          onDash={(dash) => applyStroke({ dash }, false)}
          onFont={(fontId: FontId) => applyText({ fontId }, false)}
          onFontSize={(fontSize) => applyText({ fontSize }, styleBaseline.current !== null)}
          onTextColor={(color) => applyText({ color }, styleBaseline.current !== null)}
          onToggle={(key) => applyText({ [key]: !text[key] }, false)}
          onAlign={(align: Align) => applyText({ align }, false)}
          onWidth={(width) => applyText({ width }, styleBaseline.current !== null)}
          onAutoWidth={(autoWidth) =>
            applyText(autoWidth ? { autoWidth, height: null } : { autoWidth }, false)
          }
          content={selected && selected.kind !== "patch" ? null : contentSelection}
          patch={selected?.kind === "patch" ? selected : null}
          objects={objects}
          selectedId={selectedId}
          hover={liveHover}
          onHoverObject={hoverFromList}
          onSelectObject={setSelectedId}
          onRemoveObject={removeObject}
          format={selected?.kind === "patch" ? formatState : null}
          onFormat={applyFormat}
          onFormatBegin={beginFormat}
          onFormatEnd={endFormat}
        />
      </div>
    </div>
  );
}
