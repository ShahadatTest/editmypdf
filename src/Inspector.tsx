import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ColorControl } from "./ColorControl.tsx";
import { keepFocus } from "./keepFocus.ts";
import { contentDetail, contentLabel, patchGlyphReport, type ContentElement, type ContentKind } from "./content.ts";
import { localFontsSupported, adoptLocalFont } from "./localFonts.ts";
import type { FontOffer, Relation } from "./supplementFonts.ts";
import { addUserFont, subscribeUserFonts, userFontsVersion } from "./userFonts.ts";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Info,
  Italic,
  Layers,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  SlidersHorizontal,
  Strikethrough,
  Trash2,
  Underline,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  clampInspectorWidth,
  clampPaneSplit,
  DEFAULT_LAYOUT,
  HANDLE_KEY_STEP,
  INSPECTOR_MIN_WIDTH,
  maxInspectorWidth,
  PANE_MIN_HEIGHT_FRACTION,
  readInspectorLayout,
  writeInspectorLayout,
  type InspectorLayout,
} from "./inspectorLayout.ts";
import { ObjectList } from "./ObjectList.tsx";
import { removalFor, type ObjectHover, type ObjectRow } from "./objects.ts";
import { PanelEmpty, PanelHead, PanelSection, PropRow } from "./PanelChrome.tsx";
import { shortcut } from "./shortcuts.ts";
import type { FormatChange, FormatState } from "./textFormat.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { brushById, DASHES } from "./brushes.ts";
import { SHAPE_LABEL, type ShapeId } from "./shapes.ts";
import type { Align, Annotation, FontId, LineCap, PatchAnnotation, StrokeStyle, TextAlign, TextStyle, Tool } from "./types.ts";
import { FONT_OPTIONS, SWATCHES } from "./types.ts";

type StyleKey = "bold" | "italic" | "underline" | "strike";

// The column's width and the panes' split, kept across reloads and clamped to the window.
function useInspectorLayout() {
  const [layout, setLayout] = useState<InspectorLayout>(() =>
    readInspectorLayout(typeof window === "undefined" ? DEFAULT_LAYOUT.width * 4 : window.innerWidth),
  );
  useEffect(() => writeInspectorLayout(layout), [layout]);
  useEffect(() => {
    const onResize = () =>
      setLayout((current) => {
        const width = clampInspectorWidth(current.width, window.innerWidth);
        return width === current.width ? current : { ...current, width };
      });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const setWidth = (width: number) =>
    setLayout((current) => {
      const next = clampInspectorWidth(width, window.innerWidth);
      return next === current.width ? current : { ...current, width: next };
    });
  const setSplit = (split: number) =>
    setLayout((current) => {
      const next = clampPaneSplit(split);
      return Math.abs(next - current.split) < 0.0005 ? current : { ...current, split: next };
    });
  return { layout, setWidth, setSplit };
}

// A drag handle between two areas: pointer drag, arrow keys and a double-click back to the default.
// `onMove` gets the size in px the drag asks for, measured from `size()` at the start.
function SplitHandle({
  className,
  orientation,
  label,
  valueNow,
  valueMin,
  valueMax,
  size,
  onMove,
  onReset,
  onDragging,
}: {
  className: string;
  orientation: "vertical" | "horizontal";
  label: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  size: () => number;
  onMove: (px: number) => void;
  onReset: () => void;
  onDragging: (dragging: boolean) => void;
}) {
  const start = useRef<{ x: number; y: number; size: number } | null>(null);
  const [active, setActive] = useState(false);
  const vertical = orientation === "vertical";
  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A very fast press can release the pointer before capture; the drag still runs.
    }
    start.current = { x: event.clientX, y: event.clientY, size: size() };
    setActive(true);
    onDragging(true);
    document.body.classList.add(vertical ? "resizing-columns" : "resizing-rows");
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) return;
    // The column's handle is on its left edge, so dragging left makes it wider.
    const delta = vertical ? from.x - event.clientX : event.clientY - from.y;
    onMove(from.size + delta);
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    setActive(false);
    onDragging(false);
    document.body.classList.remove("resizing-columns", "resizing-rows");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = HANDLE_KEY_STEP * (event.shiftKey ? 4 : 1);
    let direction = 0;
    if (vertical && event.key === "ArrowLeft") direction = 1;
    else if (vertical && event.key === "ArrowRight") direction = -1;
    else if (!vertical && event.key === "ArrowUp") direction = -1;
    else if (!vertical && event.key === "ArrowDown") direction = 1;
    else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onMove(event.key === "Home" ? 0 : Number.POSITIVE_INFINITY);
      return;
    } else if (event.key === "Enter") {
      event.preventDefault();
      onReset();
      return;
    } else return;
    event.preventDefault();
    onMove(size() + direction * step);
  };
  return (
    <div
      className={`${className}${active ? " active" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={valueNow}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      title={`${label}: drag, or use the arrow keys. Double-click to reset.`}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={onReset}
      onKeyDown={onKey}
    />
  );
}

function StyleToggles({ state, onToggle }: { state: Record<StyleKey, boolean>; onToggle: (key: StyleKey) => void }) {
  const items: [StyleKey, string, React.ReactNode][] = [
    ["bold", "Bold", <Bold key="b" />],
    ["italic", "Italic", <Italic key="i" />],
    ["underline", "Underline", <Underline key="u" />],
    ["strike", "Strikethrough", <Strikethrough key="s" />],
  ];
  return (
    <div className="segmented toggle-set" role="group" aria-label="Text style">
      {items.map(([key, label, icon]) => (
        <Toggle
          key={key}
          variant="outline"
          size="sm"
          aria-label={label}
          title={label}
          pressed={state[key]}
          onMouseDown={keepFocus}
          onPressedChange={() => onToggle(key)}
        >
          {icon}
        </Toggle>
      ))}
    </div>
  );
}

function AlignToggles({ value, justify, onAlign }: { value: TextAlign; justify: boolean; onAlign: (align: TextAlign) => void }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      className="segmented"
      value={value}
      onValueChange={(next) => {
        if (next === "left" || next === "center" || next === "right" || (justify && next === "justify")) onAlign(next);
      }}
      aria-label="Alignment"
    >
      <ToggleGroupItem value="left" aria-label="Align left" title="Align left" onMouseDown={keepFocus}>
        <AlignLeft />
      </ToggleGroupItem>
      <ToggleGroupItem value="center" aria-label="Align center" title="Align center" onMouseDown={keepFocus}>
        <AlignCenter />
      </ToggleGroupItem>
      <ToggleGroupItem value="right" aria-label="Align right" title="Align right" onMouseDown={keepFocus}>
        <AlignRight />
      </ToggleGroupItem>
      {justify && (
        <ToggleGroupItem value="justify" aria-label="Justify" title="Justify" onMouseDown={keepFocus}>
          <AlignJustify />
        </ToggleGroupItem>
      )}
    </ToggleGroup>
  );
}

// "“3”, “4” and “5”", or "“3”, “4”, “5”, “6”, “7”, “8” and 2 more".
function charList(chars: string[], joiner: "and" | "or"): string {
  const shown = chars.slice(0, 6).map((char) => `“${char}”`);
  const rest = chars.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length === 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} ${joiner} ${shown[shown.length - 1]}`;
}

const RELATION_TEXT: Record<Relation, string> = {
  same: "the page's own font",
  close: "a close match to the page's font",
  kind: "a stand-in for the page's font",
  local: "the font installed on this computer",
  user: "the font you added",
};

// Tells the user where the characters the page's font lacks come from: the supplement they are
// set in (a bundled open font of the page font's design, the font installed on this computer, or
// a font file they added), the face set in place of a font the PDF names without including it,
// and, for characters no supplement has, that they are shown in a
// substitute face and make the edit an image on download. When nothing bundled is the page's own
// font, names the page font and offers the installed font (in a browser that can read the
// installed fonts) and a font file.
function GlyphNote({ patch, kind }: { patch: PatchAnnotation; kind: ContentKind | undefined }) {
  // A font the user adds changes what the note says without the patch changing.
  useSyncExternalStore(subscribeUserFonts, userFontsVersion, () => 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"file" | "local" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const local = localFontsSupported();
  const report = patchGlyphReport(patch);
  if (report.supplied.length === 0 && report.standIns.length === 0 && report.unsupplied.length === 0) return null;
  const offer = report.offer;
  const noun = kind === "paragraph" || kind === "heading" ? kind : "line";
  const standIns = report.standIns.map(
    (standIn) =>
      `This PDF names ${standIn.name || "its font"} without including it, so this ${noun} is set in ${standIn.label}, ${RELATION_TEXT[standIn.relation]}, and is written with it on download.`,
  );
  const supplied = report.supplied.map((group) => {
    const pageFont = offer?.name && (group.relation === "kind" || group.relation === "close") ? `, ${offer.name}` : "";
    return `${charList(group.chars, "and")} ${group.chars.length === 1 ? "is" : "are"} set in ${group.label}, ${RELATION_TEXT[group.relation]}${pageFont}.`;
  });
  const sentences = [...standIns, ...supplied];
  if (report.unsupplied.length > 0) {
    sentences.push(
      `The page's font has no ${charList(report.unsupplied, "or")}. ${report.unsupplied.length === 1 ? "It is" : "They are"} shown in a substitute face, and on download this ${noun} is written as an image instead of text.`,
    );
  }
  const supply = async (source: "file" | "local", add: () => Promise<unknown>) => {
    setBusy(source);
    setError(null);
    try {
      await add();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That font could not be added.");
    } finally {
      setBusy(null);
    }
  };
  const pick = (file: File, key: string) => supply("file", () => addUserFont(file, key));
  // The browser asks for the permission inside the click, so nothing may be awaited before it.
  const lookUp = (offer: FontOffer) => supply("local", () => adoptLocalFont(offer));
  return (
    <p role="status" className={`panel-note${report.unsupplied.length === 0 ? " calm" : ""}`}>
      <Info aria-hidden="true" />
      <span>
        {sentences.join(" ")}
        {offer && (
          <>
            {" "}
            {local && (
              <>
                <button
                  type="button"
                  className="panel-note-action"
                  disabled={busy !== null}
                  title={`Look for ${offer.name || "the page's font"} among the fonts installed on this computer; the browser asks once for permission, and the font is kept in this browser for every document.`}
                  onClick={() => void lookUp(offer)}
                >
                  {busy === "local" ? "Looking for the font…" : "Use the installed font…"}
                </button>
                {" · "}
              </>
            )}
            <button
              type="button"
              className="panel-note-action"
              disabled={busy !== null}
              title={`Pick a TrueType or OpenType file of ${offer.name || "the page's font"}; it is kept in this browser for every document.`}
              onClick={() => input.current?.click()}
            >
              {busy === "file" ? "Adding the font…" : "Add this font…"}
            </button>
            <input
              ref={input}
              type="file"
              accept=".ttf,.otf,font/ttf,font/otf,font/sfnt"
              hidden
              aria-label={`Font file for ${offer.name || "the page's font"}`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void pick(file, offer.key);
              }}
            />
            {error && <span className="panel-note-error">{error}</span>}
          </>
        )}
      </span>
    </p>
  );
}

function strokePanel(id: ShapeId, selected: boolean) {
  const label = SHAPE_LABEL[id];
  return {
    panel: "stroke" as const,
    title: label,
    detail: selected ? `Selected ${label.toLowerCase()}` : `Next ${label.toLowerCase()}`,
  };
}

function panelFor(
  tool: Tool,
  selectedKind: Annotation["kind"] | null,
  shape: ShapeId,
  selectedShape: ShapeId | null,
  content: ContentElement | null,
) {
  if (selectedKind === "text") {
    return { panel: "text" as const, title: "Text", detail: "Selected text" };
  }
  if (selectedKind === "emoji") {
    return { panel: "empty" as const, title: "Emoji", detail: "Drag to move it, or use the handles to resize" };
  }
  if (selectedKind === "signature") {
    return { panel: "empty" as const, title: "Signature", detail: "Drag to move it, or use the handles to resize" };
  }
  if (selectedShape) return strokePanel(selectedShape, true);
  if (selectedKind === "ink") {
    return { panel: "stroke" as const, title: "Pencil", detail: "Selected stroke" };
  }
  if (tool === "select" && content) {
    return {
      panel: "content" as const,
      title: contentLabel(content.kind),
      detail: contentDetail(content.kind),
    };
  }
  if (tool === "text") {
    return { panel: "text" as const, title: "Text", detail: "Next text box" };
  }
  if (tool === "shape") return strokePanel(shape, false);
  if (tool === "emoji") {
    return { panel: "empty" as const, title: "Emoji", detail: "Pick an emoji to place it on the page" };
  }
  if (tool === "signature") {
    return { panel: "empty" as const, title: "Signature", detail: "Type a name or upload a signature" };
  }
  if (tool === "pencil") {
    return { panel: "stroke" as const, title: "Pencil", detail: "Next stroke" };
  }
  if (tool === "eraser") {
    return { panel: "empty" as const, title: "Eraser", detail: "Click a mark to remove it" };
  }
  return { panel: "empty" as const, title: "Nothing selected", detail: "Select a mark on the page to edit it" };
}

// A number field beside a slider, as one property row.
function NumberSlider({
  label,
  value,
  min,
  max,
  unit,
  onChange,
  onAdjustStart,
  onAdjustEnd,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
  onAdjustStart: () => void;
  onAdjustEnd: () => void;
}) {
  const clampValue = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <PropRow label={label}>
      <div className="number-slider">
        <span className={unit ? "number-wrap with-unit" : "number-wrap"} data-unit={unit}>
          <Input
            type="number"
            min={min}
            max={max}
            aria-label={`${label} value`}
            value={Math.round(value)}
            className="number-field"
            onFocus={onAdjustStart}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onChange(clampValue(next));
            }}
            onBlur={onAdjustEnd}
          />
        </span>
        <Slider
          aria-label={label}
          min={min}
          max={max}
          step={1}
          value={[value]}
          onPointerDown={onAdjustStart}
          onValueChange={(next) => onChange(clampValue(next[0] ?? value))}
          onValueCommit={onAdjustEnd}
          onBlur={onAdjustEnd}
        />
      </div>
    </PropRow>
  );
}

function StripButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function Inspector({
  open,
  onOpenChange,
  tool,
  shape,
  selectedShape,
  selectedKind,
  stroke,
  text,
  showFill,
  showInk,
  onStrokeColor,
  onStrokeWidth,
  onFill,
  onFillOpacity,
  onOpacity,
  onCap,
  onDash,
  onFont,
  onFontSize,
  onTextColor,
  onToggle,
  onAlign,
  onWidth,
  onAutoWidth,
  onAdjustStart,
  onAdjustEnd,
  canDelete,
  onDelete,
  content,
  patch,
  objects,
  selectedId,
  hover,
  onHoverObject,
  onSelectObject,
  onRemoveObject,
  format,
  onFormat,
  onFormatBegin,
  onFormatEnd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: Tool;
  shape: ShapeId;
  selectedShape: ShapeId | null;
  selectedKind: Annotation["kind"] | null;
  stroke: StrokeStyle;
  text: TextStyle;
  showFill: boolean;
  showInk: boolean;
  onStrokeColor: (color: string) => void;
  onStrokeWidth: (width: number) => void;
  onFill: (fill: string | null) => void;
  onFillOpacity: (opacity: number) => void;
  onOpacity: (opacity: number) => void;
  onCap: (cap: LineCap) => void;
  onDash: (dash: string | null) => void;
  onFont: (fontId: FontId) => void;
  onFontSize: (size: number) => void;
  onTextColor: (color: string) => void;
  onToggle: (key: StyleKey) => void;
  onAlign: (align: Align) => void;
  onWidth: (width: number) => void;
  onAutoWidth: (autoWidth: boolean) => void;
  onAdjustStart: () => void;
  onAdjustEnd: () => void;
  canDelete: boolean;
  onDelete: () => void;
  content: ContentElement | null;
  // The selected text patch, whose text may already differ from the page's.
  patch: PatchAnnotation | null;
  // Every inserted mark in insertion order, for the numbered list above the attributes.
  objects: ObjectRow[];
  selectedId: string | null;
  hover: ObjectHover | null;
  onHoverObject: (id: string | null) => void;
  onSelectObject: (id: string) => void;
  onRemoveObject: (id: string) => void;
  // How the selected text patch's caret or selection is formatted, and the actions on it; the
  // same ones the floating bar over the page offers.
  format: FormatState | null;
  onFormat: (change: FormatChange) => void;
  onFormatBegin: () => void;
  onFormatEnd: () => void;
}) {
  const view = panelFor(tool, selectedKind, shape, selectedShape, content);
  // Taking an edit of the page's own content off the page restores the original; the footer's
  // button says which of the two it will do.
  const removal = removalFor(patch ?? (selectedKind ? { kind: selectedKind } : null));
  const { layout, setWidth, setSplit } = useInspectorLayout();
  const [dragging, setDragging] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyHeight = () => bodyRef.current?.clientHeight ?? 0;
  const windowWidth = typeof window === "undefined" ? DEFAULT_LAYOUT.width * 4 : window.innerWidth;
  const glyphPatch = view.panel === "content" && patch?.role === "text" ? patch : null;
  const title = showInk && view.panel === "stroke" ? brushById(stroke.brush).label : view.title;
  const dashValue = DASHES.find((item) => item.dash === stroke.dash)?.id ?? "solid";
  const opacity = Math.round(stroke.opacity * 100);
  const pageCount = new Set(objects.map((row) => row.page)).size;
  const objectsDetail =
    objects.length === 0
      ? "Nothing added yet"
      : `On ${pageCount} ${pageCount === 1 ? "page" : "pages"}, in the order added`;
  const fillSolid = stroke.fill !== null;

  const className = ["inspector", open ? "" : "collapsed", dragging ? "resizing" : ""].filter(Boolean).join(" ");

  return (
    <aside
      className={className}
      style={{ "--inspector-width": `${layout.width}px` } as React.CSSProperties}
      aria-label="Edits and properties"
    >
      {open && (
        <SplitHandle
          className="inspector-handle"
          orientation="vertical"
          label="Width of the sidebar"
          valueNow={Math.round(layout.width)}
          valueMin={INSPECTOR_MIN_WIDTH}
          valueMax={maxInspectorWidth(windowWidth)}
          size={() => layout.width}
          onMove={setWidth}
          onReset={() => setWidth(DEFAULT_LAYOUT.width)}
          onDragging={setDragging}
        />
      )}

      {!open && (
        <div className="inspector-strip">
          <StripButton label="Show sidebar" onClick={() => onOpenChange(true)}>
            <PanelRightOpen />
          </StripButton>
          <span className="strip-sep" />
          <StripButton label="Your edits" onClick={() => onOpenChange(true)}>
            <Layers />
          </StripButton>
          <StripButton label="Properties" onClick={() => onOpenChange(true)}>
            <SlidersHorizontal />
          </StripButton>
        </div>
      )}

      <div className="inspector-body" ref={bodyRef} inert={!open} aria-hidden={!open}>
        <section className="inspector-pane objects" style={{ flexBasis: `${layout.split * 100}%` }} aria-label="Your edits">
          <PanelHead title="Your edits" count={objects.length} detail={objectsDetail}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="panel-close"
                  aria-expanded={open}
                  aria-label="Hide sidebar"
                  onClick={() => onOpenChange(false)}
                >
                  <PanelRightClose />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Hide sidebar
              </TooltipContent>
            </Tooltip>
          </PanelHead>
          <ScrollArea className="panel-scroll">
            <ObjectList
              objects={objects}
              selectedId={selectedId}
              hover={hover}
              onHover={onHoverObject}
              onSelect={onSelectObject}
              onRemove={onRemoveObject}
            />
          </ScrollArea>
        </section>

        <SplitHandle
          className="inspector-splitter"
          orientation="horizontal"
          label="Height of the object list"
          valueNow={Math.round(layout.split * 100)}
          valueMin={Math.round(PANE_MIN_HEIGHT_FRACTION * 100)}
          valueMax={Math.round((1 - PANE_MIN_HEIGHT_FRACTION) * 100)}
          size={() => layout.split * bodyHeight()}
          onMove={(px) => {
            const height = bodyHeight();
            if (height > 0) setSplit(px / height);
          }}
          onReset={() => setSplit(DEFAULT_LAYOUT.split)}
          onDragging={setDragging}
        />

        <section className="inspector-pane attributes" aria-label="Properties">
          <PanelHead title="Properties" detail={view.panel === "empty" ? null : view.detail}>
            {view.panel !== "empty" && (
              <span className="panel-chip" title={title}>
                {title}
              </span>
            )}
          </PanelHead>
          <ScrollArea className="panel-scroll">
            <div className="panel-body">
              {view.panel === "text" && (
                <>
                  <PanelSection title="Text">
                    <PropRow label="Font">
                      <Select value={text.fontId} onValueChange={(value) => onFont(value as FontId)}>
                        <SelectTrigger size="sm" className="w-full" aria-label="Font">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FONT_OPTIONS.map((font) => (
                            <SelectItem key={font.id} value={font.id}>
                              {font.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </PropRow>
                    <NumberSlider
                      label="Size"
                      value={text.fontSize}
                      min={8}
                      max={96}
                      unit="pt"
                      onChange={onFontSize}
                      onAdjustStart={onAdjustStart}
                      onAdjustEnd={onAdjustEnd}
                    />
                    <PropRow label="Style">
                      <StyleToggles
                        state={{ bold: text.bold, italic: text.italic, underline: text.underline, strike: !!text.strike }}
                        onToggle={onToggle}
                      />
                    </PropRow>
                    <PropRow label="Align">
                      <AlignToggles
                        value={text.align}
                        justify={false}
                        onAlign={(align) => {
                          if (align !== "justify") onAlign(align);
                        }}
                      />
                    </PropRow>
                    <PropRow label="Colour">
                      <div className="color-row">
                        <ColorControl
                          label="Text colour"
                          appearance="text"
                          size="icon-sm"
                          color={text.color}
                          onColor={onTextColor}
                          onAdjustStart={onAdjustStart}
                          onAdjustEnd={onAdjustEnd}
                        />
                        <span className="color-hex">{text.color}</span>
                      </div>
                    </PropRow>
                  </PanelSection>
                  <PanelSection title="Box">
                    <PropRow label="Auto width" htmlFor="auto-width">
                      <Switch
                        id="auto-width"
                        size="sm"
                        checked={text.autoWidth}
                        onCheckedChange={(checked) => onAutoWidth(checked)}
                      />
                    </PropRow>
                    {!text.autoWidth && (
                      <NumberSlider
                        label="Width"
                        value={text.width}
                        min={16}
                        max={1600}
                        unit="pt"
                        onChange={onWidth}
                        onAdjustStart={onAdjustStart}
                        onAdjustEnd={onAdjustEnd}
                      />
                    )}
                  </PanelSection>
                </>
              )}

              {view.panel === "stroke" && (
                <>
                  {showFill && (
                    <PanelSection title="Fill">
                      <PropRow label="Fill">
                        <ToggleGroup
                          type="single"
                          variant="outline"
                          size="sm"
                          spacing={0}
                          className="segmented"
                          value={fillSolid ? "solid" : "none"}
                          onValueChange={(value) => {
                            if (value === "none") onFill(null);
                            if (value === "solid") onFill(stroke.fill ?? "#dbeafe");
                          }}
                          aria-label="Fill"
                        >
                          <ToggleGroupItem value="none" onMouseDown={keepFocus}>
                            None
                          </ToggleGroupItem>
                          <ToggleGroupItem value="solid" onMouseDown={keepFocus}>
                            Solid
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </PropRow>
                      {fillSolid && (
                        <>
                          <PropRow label="Colour" top>
                            <div className="swatch-grid" role="group" aria-label="Fill swatches">
                              {SWATCHES.map((swatch) => {
                                const selected = stroke.fill?.toLowerCase() === swatch;
                                return (
                                  <button
                                    key={swatch}
                                    type="button"
                                    aria-label={`Fill ${swatch}`}
                                    aria-pressed={selected}
                                    className={selected ? "swatch selected" : "swatch"}
                                    style={{ background: swatch }}
                                    onMouseDown={keepFocus}
                                    onClick={() => onFill(swatch)}
                                  />
                                );
                              })}
                            </div>
                            <div className="color-row">
                              <Input
                                type="color"
                                aria-label="Fill colour"
                                value={stroke.fill ?? "#dbeafe"}
                                className="color-well"
                                onPointerDown={onAdjustStart}
                                onChange={(event) => onFill(event.target.value)}
                                onBlur={onAdjustEnd}
                              />
                              <span className="color-hex">{stroke.fill}</span>
                            </div>
                          </PropRow>
                          <NumberSlider
                            label="Opacity"
                            value={Math.round((stroke.fillOpacity ?? 1) * 100)}
                            min={0}
                            max={100}
                            unit="%"
                            onChange={(value) => onFillOpacity(value / 100)}
                            onAdjustStart={onAdjustStart}
                            onAdjustEnd={onAdjustEnd}
                          />
                        </>
                      )}
                    </PanelSection>
                  )}
                  <PanelSection title="Stroke">
                    <PropRow label="Colour">
                      <div className="color-row">
                        <ColorControl
                          label="Stroke colour"
                          appearance="stroke"
                          size="icon-sm"
                          color={stroke.color}
                          onColor={onStrokeColor}
                          onAdjustStart={onAdjustStart}
                          onAdjustEnd={onAdjustEnd}
                        />
                        <span className="color-hex">{stroke.color}</span>
                      </div>
                    </PropRow>
                    <NumberSlider
                      label="Width"
                      value={stroke.strokeWidth}
                      min={1}
                      max={48}
                      unit="pt"
                      onChange={onStrokeWidth}
                      onAdjustStart={onAdjustStart}
                      onAdjustEnd={onAdjustEnd}
                    />
                    {showInk && (
                      <>
                        <NumberSlider
                          label="Opacity"
                          value={opacity}
                          min={5}
                          max={100}
                          unit="%"
                          onChange={(value) => onOpacity(value / 100)}
                          onAdjustStart={onAdjustStart}
                          onAdjustEnd={onAdjustEnd}
                        />
                        <PropRow label="Tip">
                          <ToggleGroup
                            type="single"
                            variant="outline"
                            size="sm"
                            spacing={0}
                            className="segmented"
                            value={stroke.cap}
                            onValueChange={(value) => {
                              if (value === "round" || value === "square" || value === "butt") onCap(value);
                            }}
                            aria-label="Stroke tip"
                          >
                            <ToggleGroupItem value="round" onMouseDown={keepFocus}>
                              Round
                            </ToggleGroupItem>
                            <ToggleGroupItem value="square" onMouseDown={keepFocus}>
                              Square
                            </ToggleGroupItem>
                            <ToggleGroupItem value="butt" onMouseDown={keepFocus}>
                              Flat
                            </ToggleGroupItem>
                          </ToggleGroup>
                        </PropRow>
                        <PropRow label="Pattern">
                          <ToggleGroup
                            type="single"
                            variant="outline"
                            size="sm"
                            spacing={0}
                            className="segmented"
                            value={dashValue}
                            onValueChange={(value) => {
                              const preset = DASHES.find((item) => item.id === value);
                              if (preset) onDash(preset.dash);
                            }}
                            aria-label="Stroke pattern"
                          >
                            {DASHES.map((item) => (
                              <ToggleGroupItem key={item.id} value={item.id} onMouseDown={keepFocus}>
                                {item.label}
                              </ToggleGroupItem>
                            ))}
                          </ToggleGroup>
                        </PropRow>
                      </>
                    )}
                  </PanelSection>
                </>
              )}

              {view.panel === "content" && patch?.role === "text" && format && (
                <PanelSection title={format.selection ? "Selection" : "Text"}>
                  <NumberSlider
                    label="Size"
                    value={format.fontSize}
                    min={4}
                    max={120}
                    unit="pt"
                    onChange={(fontSize) => onFormat({ fontSize })}
                    onAdjustStart={onFormatBegin}
                    onAdjustEnd={onFormatEnd}
                  />
                  <PropRow label="Style">
                    <StyleToggles
                      state={{ bold: format.bold, italic: format.italic, underline: format.underline, strike: format.strike }}
                      onToggle={(key) => onFormat({ [key]: !format[key] })}
                    />
                  </PropRow>
                  {format.wrap && (
                    <PropRow label="Align">
                      <AlignToggles value={format.align} justify onAlign={(align) => onFormat({ align })} />
                    </PropRow>
                  )}
                  <PropRow label="Colour">
                    <div className="color-row">
                      <ColorControl
                        label="Text colour"
                        appearance="text"
                        size="icon-sm"
                        color={format.color}
                        onColor={(color) => onFormat({ color })}
                        onAdjustStart={onFormatBegin}
                        onAdjustEnd={onFormatEnd}
                      />
                      <span className="color-hex">{format.color}</span>
                    </div>
                  </PropRow>
                </PanelSection>
              )}

              {view.panel === "content" && content?.text && (
                <PanelSection title="On the page">
                  <p className="content-quote">{content.text}</p>
                </PanelSection>
              )}

              {glyphPatch && <GlyphNote patch={glyphPatch} kind={content?.kind} />}

              {view.panel === "empty" && (
                <PanelEmpty icon={<MousePointer2 />} title={view.title}>
                  {view.detail}
                </PanelEmpty>
              )}
            </div>
          </ScrollArea>
          {canDelete && (
            <div className="panel-footer">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className={removal.restores ? "restore-button" : "delete-button"}
                    onClick={onDelete}
                  >
                    {removal.restores ? <RotateCcw /> : <Trash2 />}
                    {removal.label}
                    <kbd className="button-kbd">{shortcut("backspace")}</kbd>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="start" sideOffset={6}>
                  {removal.hint}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
