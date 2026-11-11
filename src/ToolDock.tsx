import { useState } from "react";
import { Search } from "lucide-react";
import { BRUSHES, DASHES, type Brush } from "./brushes.ts";
import { EMOJI_GROUPS, emojiSrc } from "./emojis.ts";
import { PanelClose, PanelEmpty, PanelHead, PanelSection, PropRow } from "./PanelChrome.tsx";
import { SignaturePanel } from "./SignaturePanel.tsx";
import { ShapeGlyph } from "./ShapeGlyph.tsx";
import { SHAPE_GROUPS, SHAPE_LABEL, type ShapeId } from "./shapes.ts";
import type { LineCap, StrokeStyle, Tool } from "./types.ts";
import { SWATCHES } from "./types.ts";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

function StrokePreview({ brush, color }: { brush: Brush; color: string }) {
  return (
    <svg viewBox="0 0 148 36" className="brush-preview" aria-hidden="true">
      <path
        d="M6 24 C 28 6, 46 30, 74 16 S 118 8, 142 18"
        fill="none"
        stroke={color}
        strokeWidth={Math.min(brush.width, 16)}
        strokeOpacity={brush.opacity}
        strokeLinecap={brush.cap}
        strokeLinejoin={brush.cap === "square" ? "miter" : "round"}
        strokeDasharray={brush.dash ?? undefined}
      />
    </svg>
  );
}

function Swatches({
  label,
  color,
  onColor,
}: {
  label: string;
  color: string;
  onColor: (color: string) => void;
}) {
  return (
    <div className="swatch-grid" role="group" aria-label={label}>
      {SWATCHES.map((swatch) => {
        const selected = color.toLowerCase() === swatch;
        return (
          <button
            key={swatch}
            type="button"
            aria-label={`${label} ${swatch}`}
            aria-pressed={selected}
            className={selected ? "swatch selected" : "swatch"}
            style={{ background: swatch }}
            onClick={() => onColor(swatch)}
          />
        );
      })}
    </div>
  );
}

export function ToolDock({
  tool,
  shape,
  stroke,
  onShape,
  onBrush,
  onStrokeColor,
  onStrokeWidth,
  onOpacity,
  onCap,
  onDash,
  onEmoji,
  onSignature,
  onAdjustStart,
  onAdjustEnd,
  onClose,
}: {
  tool: Tool;
  shape: ShapeId;
  stroke: StrokeStyle;
  onShape: (shape: ShapeId) => void;
  onEmoji: (emoji: string) => void;
  onSignature: (src: string, width: number, height: number) => void;
  onBrush: (brush: Brush) => void;
  onStrokeColor: (color: string) => void;
  onStrokeWidth: (width: number) => void;
  onOpacity: (opacity: number) => void;
  onCap: (cap: LineCap) => void;
  onDash: (dash: string | null) => void;
  onAdjustStart: () => void;
  onAdjustEnd: () => void;
  onClose: () => void;
}) {
  const drawing = tool === "pencil";
  const emojis = tool === "emoji";
  const [shapeQuery, setShapeQuery] = useState("");
  const [emojiQuery, setEmojiQuery] = useState("");
  if (tool === "signature") return <SignaturePanel onPlace={onSignature} onClose={onClose} />;
  const opacity = Math.round(stroke.opacity * 100);
  const dashValue = DASHES.find((item) => item.dash === stroke.dash)?.id ?? "solid";
  const shapeNeedle = shapeQuery.trim().toLowerCase();
  const emojiNeedle = emojiQuery.trim().toLowerCase();
  const shapeGroups = SHAPE_GROUPS.map((group) => ({
    ...group,
    ids: group.ids.filter((id) => SHAPE_LABEL[id].toLowerCase().includes(shapeNeedle)),
  })).filter((group) => group.ids.length > 0);
  const matchesEmojiSearch = (text: string) =>
    !emojiNeedle || ` ${text.toLowerCase()}`.includes(` ${emojiNeedle}`);
  const emojiGroups = EMOJI_GROUPS.map((group) => {
    const title = group.title.toLowerCase();
    const groupMatches = emojiNeedle !== "" && (title === emojiNeedle || title === `${emojiNeedle}s`);
    return {
      ...group,
      items: groupMatches
        ? group.items
        : group.items.filter((item) => matchesEmojiSearch(item.name) || item.keywords?.some(matchesEmojiSearch)),
    };
  }).filter((group) => group.items.length > 0);
  const heading = drawing ? "Pencil" : emojis ? "Emoji" : "Shapes";
  const detail = drawing
    ? "Pen, colour and stroke for the next line"
    : emojis
      ? "Choose one to place it on the page"
      : "Choose one, then drag on the page";

  return (
    <aside className="tool-dock" aria-label={drawing ? "Pencil options" : emojis ? "Emoji options" : "Shape options"}>
      <PanelHead title={heading} detail={detail}>
        <PanelClose label="Close options" onClick={onClose} />
      </PanelHead>
      {!drawing && (
        <div className="dock-search">
          <Search aria-hidden="true" />
          <Input
            value={emojis ? emojiQuery : shapeQuery}
            onChange={(event) => (emojis ? setEmojiQuery(event.target.value) : setShapeQuery(event.target.value))}
            placeholder={emojis ? "Search emoji" : "Search shapes"}
            aria-label={emojis ? "Search emoji" : "Search shapes"}
            className="dock-search-input"
          />
        </div>
      )}
      <ScrollArea className="panel-scroll">
        <div className="panel-body">
          {drawing ? (
            <>
              <PanelSection title="Pen">
                <div className="brush-list" role="listbox" aria-label="Pen styles">
                  {BRUSHES.map((brush) => {
                    const selected = stroke.brush === brush.id;
                    return (
                      <button
                        key={brush.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={selected ? "brush-row selected" : "brush-row"}
                        onClick={() => onBrush(brush)}
                      >
                        <span className="brush-text">
                          <span className="brush-name">{brush.label}</span>
                          <span className="brush-detail">{brush.detail}</span>
                        </span>
                        <StrokePreview brush={brush} color={stroke.color} />
                      </button>
                    );
                  })}
                </div>
              </PanelSection>
              <PanelSection title="Colour">
                <Swatches label="Stroke colour" color={stroke.color} onColor={onStrokeColor} />
                <div className="color-row">
                  <Input
                    type="color"
                    aria-label="Stroke colour"
                    value={stroke.color}
                    className="color-well"
                    onPointerDown={onAdjustStart}
                    onChange={(event) => onStrokeColor(event.target.value)}
                    onBlur={onAdjustEnd}
                  />
                  <span className="color-hex">{stroke.color}</span>
                </div>
              </PanelSection>
              <PanelSection title="Stroke">
                <PropRow label="Width">
                  <div className="number-slider">
                    <Input
                      type="number"
                      min={1}
                      max={48}
                      aria-label="Stroke width value"
                      value={Math.round(stroke.strokeWidth)}
                      className="number-field"
                      onFocus={onAdjustStart}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) onStrokeWidth(Math.min(48, Math.max(1, next)));
                      }}
                      onBlur={onAdjustEnd}
                    />
                    <Slider
                      aria-label="Stroke width"
                      min={1}
                      max={48}
                      step={1}
                      value={[stroke.strokeWidth]}
                      onPointerDown={onAdjustStart}
                      onValueChange={(next) => onStrokeWidth(next[0] ?? stroke.strokeWidth)}
                      onValueCommit={onAdjustEnd}
                    />
                  </div>
                </PropRow>
                <PropRow label="Opacity">
                  <div className="number-slider">
                    <Input
                      type="number"
                      min={5}
                      max={100}
                      aria-label="Opacity value"
                      value={opacity}
                      className="number-field"
                      onFocus={onAdjustStart}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) onOpacity(Math.min(100, Math.max(5, next)) / 100);
                      }}
                      onBlur={onAdjustEnd}
                    />
                    <Slider
                      aria-label="Opacity"
                      min={5}
                      max={100}
                      step={1}
                      value={[opacity]}
                      onPointerDown={onAdjustStart}
                      onValueChange={(next) => onOpacity((next[0] ?? opacity) / 100)}
                      onValueCommit={onAdjustEnd}
                    />
                  </div>
                </PropRow>
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
                    <ToggleGroupItem value="round">Round</ToggleGroupItem>
                    <ToggleGroupItem value="square">Square</ToggleGroupItem>
                    <ToggleGroupItem value="butt">Flat</ToggleGroupItem>
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
                      <ToggleGroupItem key={item.id} value={item.id}>
                        {item.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </PropRow>
              </PanelSection>
            </>
          ) : emojis ? (
            emojiGroups.length === 0 ? (
              <PanelEmpty title="No emoji match">Try another word.</PanelEmpty>
            ) : (
              emojiGroups.map((group) => (
                <PanelSection key={group.title} title={group.title}>
                  <div className="emoji-grid">
                    {group.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="emoji-tile"
                        aria-label={item.name}
                        title={item.name}
                        onClick={() => onEmoji(item.id)}
                      >
                        <img src={emojiSrc(item.id)} alt="" />
                      </button>
                    ))}
                  </div>
                </PanelSection>
              ))
            )
          ) : shapeGroups.length === 0 ? (
            <PanelEmpty title="No shapes match">Try another word.</PanelEmpty>
          ) : (
            shapeGroups.map((group) => (
              <PanelSection key={group.title} title={group.title}>
                <div className="shape-grid">
                  {group.ids.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={shape === id ? "shape-tile selected" : "shape-tile"}
                      aria-pressed={shape === id}
                      onClick={() => onShape(id)}
                    >
                      <ShapeGlyph id={id} className="shape-tile-glyph" />
                      <span className="shape-tile-label">{SHAPE_LABEL[id]}</span>
                    </button>
                  ))}
                </div>
              </PanelSection>
            ))
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
