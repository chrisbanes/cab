import type { SelectedLineRange } from "@pierre/diffs";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  filePatch,
  selectableLines,
  type Anchor,
  type DiffHunkData,
  type Selectable,
  type Side,
} from "./diff-model.js";
import { Button } from "./components.js";
import type { TaskChangeSelection } from "./task-workspace-state.js";
import { useTheme } from "./theme.js";

export type { Anchor, DiffHunkData, Hunk } from "./diff-model.js";

// Loaded on first use so the highlighter stays out of the initial bundle.
const PatchDiff = lazy(() =>
  import("@pierre/diffs/react").then((module) => ({
    default: module.PatchDiff,
  })),
);

type Layout = "split" | "unified";

/** A review range belongs to one side; split view otherwise highlights the paired rows of both. */
const selectionSideCSS = `
:host(.selects-right) code[data-deletions] [data-selected-line],
:host(.selects-left) code[data-additions] [data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
  --diffs-selection-number-fg: var(--diffs-fg-number);
}`;

const toPierre = (side: Side) => (side === "left" ? "deletions" : "additions");
const fromPierre = (side: SelectedLineRange["side"]): Side =>
  side === "deletions" ? "left" : "right";

const narrowQuery = "(max-width: 700px)";

/** Phones show the unified diff only; mirrors the stylesheet breakpoint. */
export function useNarrowViewport() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(narrowQuery).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(narrowQuery);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function DiffLayoutControls({
  layout,
  onChange,
}: {
  layout: Layout;
  onChange: (layout: Layout) => void;
}) {
  return (
    <div
      className="changes-layout-controls"
      role="toolbar"
      aria-label="Diff layout"
    >
      {(["split", "unified"] as const).map((value) => (
        <Button
          key={value}
          variant={layout === value ? "primary" : "secondary"}
          aria-pressed={layout === value}
          onClick={() => onChange(value)}
        >
          {value === "split" ? "Split" : "Unified"}
        </Button>
      ))}
    </div>
  );
}

export type DiffSelect = {
  comparisonId: string;
  selection: TaskChangeSelection | null;
  /** `data-review-return` target for the composer's focus return. */
  originKey: string;
  onSelect: (
    anchor: Anchor,
    line: number,
    minLine: number,
    maxLine: number,
    extend: boolean,
  ) => void;
  onClear: () => void;
};

/** A file's diff. Review selection works by pointer on line numbers and by arrow keys. */
export function FileDiffView({
  path,
  previousPath,
  hunks,
  layout,
  onLayout,
  headerPrefix,
  headerMetadata,
  select,
}: {
  path: string;
  previousPath?: string | undefined;
  hunks: DiffHunkData[];
  layout: Layout;
  onLayout: (layout: Layout) => void;
  headerPrefix?: ReactNode;
  headerMetadata?: ReactNode;
  /** Omitted when the diff is read-only. */
  select?: DiffSelect;
}) {
  const theme = useTheme();
  const narrow = useNarrowViewport();
  const effective: Layout = narrow ? "unified" : layout;
  const patch = useMemo(
    () => filePatch(path, previousPath, hunks),
    [path, previousPath, hunks],
  );
  const lines = useMemo(() => selectableLines(hunks), [hunks]);

  const bounds = (hunk: DiffHunkData, side: Side) => {
    const minLine = side === "left" ? hunk.oldStart : hunk.newStart;
    const count = side === "left" ? hunk.oldLines : hunk.newLines;
    return { minLine, maxLine: minLine + count - 1 };
  };
  const anchorOf = (hunk: DiffHunkData, side: Side) =>
    side === "left" ? hunk.leftAnchor : hunk.rightAnchor;

  const active =
    select?.selection &&
    select.selection.comparisonId === select.comparisonId &&
    hunks.some((hunk) => {
      const anchor = anchorOf(hunk, select.selection!.side);
      return (
        anchor?.path === select.selection!.path &&
        anchor.contentSha256 === select.selection!.contentSha256
      );
    })
      ? select.selection
      : null;
  const selectedLines: SelectedLineRange | null = active
    ? {
        start: active.startLine,
        end: active.endLine,
        side: toPierre(active.side),
      }
    : null;

  /** Selects `to`; `from` keeps the range anchor when extending within its hunk. */
  const choose = (to: Selectable, extend: boolean) => {
    if (!select) return;
    const hunk = hunks[to.hunk];
    const anchor = hunk && anchorOf(hunk, to.side);
    if (!hunk || !anchor) return;
    const { minLine, maxLine } = bounds(hunk, to.side);
    select.onSelect(anchor, to.line, minLine, maxLine, extend);
  };

  const onLineSelected = (range: SelectedLineRange | null) => {
    if (!select) return;
    if (!range) return select.onClear();
    const side = fromPierre(range.side);
    const start = lines[side].find((item) => item.line === range.start);
    if (!start) return;
    // A review range stays on one side of one hunk; clamp a drag that leaves it.
    const sameSide = fromPierre(range.endSide ?? range.side) === side;
    const end =
      (sameSide &&
        lines[side].find(
          (item) => item.line === range.end && item.hunk === start.hunk,
        )) ||
      start;
    choose(start, false);
    if (end !== start) choose(end, true);
  };

  const keys = useRef<HTMLDivElement>(null);
  /** Keeps a keyboard-chosen line on screen once the diff has redrawn its selection. */
  const reveal = (target: Selectable) =>
    requestAnimationFrame(() => {
      const root =
        keys.current?.querySelector(".changes-file-diff")?.shadowRoot;
      const column =
        target.side === "left"
          ? "code[data-deletions]"
          : "code[data-additions]";
      const type =
        target.side === "left"
          ? '[data-line-type="change-deletion"]'
          : '[data-line-type="change-addition"], [data-line-type="context"]';
      const number = `[data-gutter] [data-column-number="${target.line}"]`;
      root
        ?.querySelector(
          `${column} ${number}, code[data-unified] ${number}:is(${type})`,
        )
        ?.scrollIntoView({ block: "nearest" });
    });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!select) return;
    if (event.key === "Escape" && active) {
      event.preventDefault();
      select.onClear();
      return;
    }
    const side: Side = active?.side ?? (lines.right.length ? "right" : "left");
    const peers = lines[side];
    const index = active
      ? peers.findIndex((item) => item.line === active.currentLine)
      : -1;
    let target: Selectable | undefined;
    if (event.key === "ArrowDown")
      target = index < 0 ? peers[0] : peers[index + 1];
    else if (event.key === "ArrowUp")
      target = index < 0 ? peers[0] : peers[index - 1];
    else if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      effective === "split"
    ) {
      const other: Side = event.key === "ArrowLeft" ? "left" : "right";
      const from = peers[index];
      if (other === side || !from) return;
      // Nearest line on the other side of the same hunk.
      target = lines[other]
        .filter((item) => item.hunk === from.hunk)
        .sort(
          (a, b) => Math.abs(a.row - from.row) - Math.abs(b.row - from.row),
        )[0];
    } else return;
    event.preventDefault();
    if (!target) return;
    choose(target, event.shiftKey && target.side === side);
    reveal(target);
  };

  const diff = (
    <Suspense fallback={<p role="status">Loading diff…</p>}>
      <PatchDiff
        patch={patch}
        className={`changes-file-diff${active ? ` selects-${active.side}` : ""}`}
        selectedLines={selectedLines}
        options={{
          diffStyle: effective,
          themeType: theme,
          overflow: "wrap",
          lineDiffType: "word",
          // `+`/`−` markers, so colour is never the only cue for an added or removed line.
          diffIndicators: "classic",
          unsafeCSS: selectionSideCSS,
          hunkSeparators: "line-info",
          stickyHeader: true,
          enableLineSelection: Boolean(select),
          controlledSelection: true,
          onLineSelected,
        }}
        {...(headerPrefix ? { renderHeaderPrefix: () => headerPrefix } : {})}
        renderHeaderMetadata={() => (
          <>
            {headerMetadata}
            {!narrow && (
              <DiffLayoutControls layout={layout} onChange={onLayout} />
            )}
          </>
        )}
      />
    </Suspense>
  );
  if (!select) return diff;
  return (
    <div
      ref={keys}
      className="changes-diff-keys"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: one keyboard stop whose arrow keys move the line selection.
      tabIndex={0}
      role="application"
      aria-roledescription="diff"
      aria-label={`Diff of ${path}. Up and Down select a line, Shift extends, Left and Right switch side, Escape clears.`}
      data-review-return={select.originKey}
      onKeyDown={onKeyDown}
    >
      {diff}
    </div>
  );
}
