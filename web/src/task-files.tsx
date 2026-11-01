import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  workspaceDirectoryReadSchema,
  workspacePreviewReadSchema,
  type Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { OutcomeDetails, type OutcomeField } from "./action-feedback.js";
import { comparisonReadKey } from "./comparison-read-match.js";
import { Button } from "./components.js";
import {
  changeLetter,
  changeMarkers,
  changeWord,
} from "./file-change-markers.js";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import {
  TaskFileTabState,
  type ReviewAnchorCandidate,
  type TaskChangesState,
  type TaskFilesState,
} from "./task-workspace-state.js";
import { CommentAction, ReviewComposer } from "./local-review.js";
import { clockLabel } from "./presentation.js";
import { RangeControls } from "./range-controls.js";
import { useOperatorResource } from "./resource.js";
import { workspaceFileAnchor } from "./review-anchor.js";

function requestUrl(
  taskId: string,
  scope: TaskFilesState["scope"],
  path: readonly string[],
  showIgnored: boolean,
  kind: "files" | "preview",
) {
  const query = new URLSearchParams({
    scope: scope.kind,
    showIgnored: String(showIgnored),
  });
  if (scope.kind === "repository")
    query.set("repositoryId", scope.repositoryId);
  // The service rejects an encoded slash, so only the segments are encoded.
  const pathQuery = path.length
    ? `&path=${path.map(encodeURIComponent).join("/")}`
    : "";
  return `/api/operator/tasks/${taskId}/${kind}?${query}${pathQuery}`;
}

function pathLabel(scope: TaskFilesState["scope"], path: readonly string[]) {
  return [
    scope.kind === "workspace"
      ? "Workspace"
      : `Repository ${scope.repositoryId}`,
    ...path,
  ].join("/");
}

/** Workspace › repository › folders: the trail to a location, one crumb per level. */
function crumbsFor(scope: TaskFilesState["scope"], path: readonly string[]) {
  return [
    { label: "Workspace", scope: { kind: "workspace" } as const, path: [] },
    ...(scope.kind === "repository"
      ? [
          {
            label: `Repository ${scope.repositoryId}`,
            scope,
            path: [] as string[],
          },
        ]
      : []),
    ...path.map((part, index) => ({
      label: part,
      scope,
      path: path.slice(0, index + 1),
    })),
  ];
}

type PreviewData = NonNullable<TaskFileTabState["preview"]>;

/** The plain notice for a refreshed preview, with the hashes and raw states behind it. */
function previewChange(
  previous: PreviewData | null,
  next: PreviewData,
): { notice: string; details: OutcomeField[] } {
  const hash = (value: PreviewData | null) =>
    value?.state === "ready" ? value.preview?.sha256 : undefined;
  const before = hash(previous);
  const after = hash(next);
  if (before && after)
    return before === after
      ? { notice: "", details: [] }
      : {
          notice:
            "Changed since you last looked. Earlier comments stay on the version they selected.",
          details: [
            ["Previous SHA-256", before],
            ["Current SHA-256", after],
          ],
        };
  if (before)
    return {
      notice: "No longer readable since you last looked.",
      details: [
        ["Previous SHA-256", before],
        ["State", next.state],
        ...(next.metadata?.reason
          ? [["Reason", String(next.metadata.reason)] as OutcomeField]
          : []),
      ],
    };
  if (after && previous)
    return {
      notice: "Readable now. It could not be read when you last looked.",
      details: [
        ["Previous state", previous.state],
        ["SHA-256", after],
      ],
    };
  return { notice: "", details: [] };
}

function fileEntryKey(
  entry: NonNullable<TaskFilesState["directory"]>["entries"][number],
) {
  return `${entry.kind}:${entry.kind === "repository" ? entry.repositoryId : entry.name}`;
}

function PdfPageCanvas({
  document,
  pageNumber,
  zoom,
  maxCanvasPixels,
  libraryVersion,
  scrollLeft,
  scrollTop,
  onScroll,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  maxCanvasPixels: number;
  libraryVersion: string;
  scrollLeft: number;
  scrollTop: number;
  onScroll: (left: number, top: number) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [renderState, setRenderState] = useState<"pending" | "ready" | "error">(
    "pending",
  );
  const [pixelCapped, setPixelCapped] = useState(false);
  const [canvasPixels, setCanvasPixels] = useState(0);

  useEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const measure = () => setAvailableWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvasElement = canvas.current;
    if (!canvasElement || availableWidth < 1) return;
    let cancelled = false;
    let renderTask: { cancel: () => void } | undefined;
    setRenderState("pending");
    setPixelCapped(false);
    canvasElement.width = 0;
    canvasElement.height = 0;

    void (async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(base.width) ||
          !Number.isFinite(base.height) ||
          base.width <= 0 ||
          base.height <= 0
        )
          throw new Error("Invalid PDF page dimensions");

        const fitScale = Math.min(
          1,
          Math.max(0.01, (availableWidth - 16) / base.width),
        );
        let scale = fitScale * zoom;
        const maxScale = Math.sqrt(
          maxCanvasPixels / (base.width * base.height),
        );
        const wasCapped = scale > maxScale;
        scale = Math.min(scale, maxScale);
        let viewport = page.getViewport({ scale });
        let width = Math.max(1, Math.floor(viewport.width));
        let height = Math.max(1, Math.floor(viewport.height));
        while (width * height > maxCanvasPixels && scale > 0.000001) {
          scale *= 0.999;
          viewport = page.getViewport({ scale });
          width = Math.max(1, Math.floor(viewport.width));
          height = Math.max(1, Math.floor(viewport.height));
        }
        if (width * height > maxCanvasPixels)
          throw new Error("PDF page exceeds the preview canvas limit");

        const context = canvasElement.getContext("2d");
        if (!context) throw new Error("PDF canvas is unavailable");
        canvasElement.width = width;
        canvasElement.height = height;
        canvasElement.style.width = `${viewport.width}px`;
        canvasElement.style.height = `${viewport.height}px`;
        canvasElement.dataset.pageNumber = String(pageNumber);
        canvasElement.dataset.canvasPixels = String(width * height);
        canvasElement.dataset.maxCanvasPixels = String(maxCanvasPixels);
        const task = page.render({
          canvas: canvasElement,
          canvasContext: context,
          viewport,
          background: "#ffffff",
        });
        renderTask = task;
        await task.promise;
        if (cancelled) return;
        setPixelCapped(wasCapped || scale < fitScale * zoom);
        setCanvasPixels(width * height);
        setRenderState("ready");
      } catch {
        if (!cancelled) setRenderState("error");
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber, zoom, maxCanvasPixels, availableWidth]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the saved scroll after each newly rendered page.
  useLayoutEffect(() => {
    wrapper.current?.scrollTo(scrollLeft, scrollTop);
  }, [pageNumber, scrollLeft, scrollTop]);

  return (
    <div
      className="pdf-canvas-scroll"
      ref={wrapper}
      onScroll={(event) =>
        onScroll(event.currentTarget.scrollLeft, event.currentTarget.scrollTop)
      }
    >
      <canvas
        ref={canvas}
        aria-label={`PDF page ${pageNumber}`}
        data-render-state={renderState}
      />
      <p className="muted" role="status">
        {renderState === "pending"
          ? `Rendering page ${pageNumber} with PDF.js ${libraryVersion}…`
          : renderState === "error"
            ? `Page ${pageNumber} could not be rendered.`
            : `Page ${pageNumber} · ${canvasPixels.toLocaleString()} canvas pixels${pixelCapped ? ` · scaled down to stay within the ${maxCanvasPixels.toLocaleString()}-pixel preview cap` : ""}.`}
      </p>
    </div>
  );
}

function PdfDocumentView({
  data,
  maxDisplayedPages,
  maxCanvasPixels,
  page,
  zoom,
  setPage,
  setZoom,
  scrollLeft,
  scrollTop,
  onScroll,
}: {
  data: string;
  maxDisplayedPages: number;
  maxCanvasPixels: number;
  page: number;
  zoom: number;
  setPage: (page: number) => void;
  setZoom: (zoom: number) => void;
  scrollLeft: number;
  scrollTop: number;
  onScroll: (left: number, top: number) => void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [libraryVersion, setLibraryVersion] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setLibraryVersion("");
    setError(false);
    let loadingTask: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([
          import("pdfjs-dist"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const binary = atob(data);
        const bytes = Uint8Array.from(binary, (character) =>
          character.charCodeAt(0),
        );
        loadingTask = pdfjs.getDocument({
          data: bytes,
          disableAutoFetch: true,
          disableRange: true,
          disableStream: true,
          enableXfa: false,
          useWorkerFetch: false,
        });
        setLibraryVersion(pdfjs.version);
        const pdf = await loadingTask.promise;
        if (!cancelled) setDocument(pdf);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy().catch(() => {});
    };
  }, [data]);

  const shownPages = document
    ? Math.min(document.numPages, Math.max(1, maxDisplayedPages))
    : 0;
  useEffect(() => {
    if (shownPages && page > shownPages) setPage(shownPages);
  }, [shownPages, page, setPage]);

  return (
    <div className="pdf-preview">
      <div
        className="task-actions pdf-controls"
        role="toolbar"
        aria-label="PDF controls"
      >
        <Button
          variant="secondary"
          disabled={!document || page <= 1}
          onClick={() => setPage(Math.max(1, page - 1))}
        >
          Previous page
        </Button>
        <span aria-live="polite">
          {document
            ? `Page ${Math.min(page, shownPages)} of ${shownPages}`
            : "Loading PDF pages…"}
        </span>
        <Button
          variant="secondary"
          disabled={!document || page >= shownPages}
          onClick={() => setPage(Math.min(shownPages, page + 1))}
        >
          Next page
        </Button>
        <Button
          variant="secondary"
          disabled={zoom <= 0.75}
          onClick={() => setZoom(Math.max(0.75, zoom - 0.25))}
        >
          Zoom out
        </Button>
        <span>{Math.round(zoom * 100)}%</span>
        <Button
          variant="secondary"
          disabled={zoom >= 2}
          onClick={() => setZoom(Math.min(2, zoom + 0.25))}
        >
          Zoom in
        </Button>
      </div>
      {document && document.numPages > shownPages && (
        <p role="status">
          This preview displays the first {shownPages} of {document.numPages}{" "}
          PDF pages. Later pages are outside the configured preview limit.
        </p>
      )}
      <p className="muted">
        One page is rendered at a time. Its canvas stays within the service
        limit of {maxCanvasPixels.toLocaleString()} pixels and may be scaled
        down before allocation. Page dimensions are read in the browser; the
        service bounds file bytes and displayed page count.
      </p>
      {document && (
        <PdfPageCanvas
          key={page}
          document={document}
          pageNumber={Math.min(page, shownPages)}
          zoom={zoom}
          maxCanvasPixels={maxCanvasPixels}
          libraryVersion={libraryVersion}
          scrollLeft={scrollLeft}
          scrollTop={scrollTop}
          onScroll={onScroll}
        />
      )}
      {error && (
        <p role="alert">
          This PDF could not be opened safely in the bounded preview.
        </p>
      )}
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ children }) => (
    <span
      className="file-markdown-link"
      title="Links are shown as text and are not opened from this preview."
    >
      {children}
    </span>
  ),
  img: ({ alt }) => (
    <span className="file-markdown-image">
      {alt ? `[Image omitted: ${alt}]` : "[Image omitted]"}
    </span>
  ),
  input: ({ checked }) => (
    <span role="img" aria-label={checked ? "checked task" : "unchecked task"}>
      {checked ? "[x]" : "[ ]"}
    </span>
  ),
  table: ({ children }) => (
    <div className="file-markdown-table-scroll">
      <table>{children}</table>
    </div>
  ),
};

const maxSourceLines = 5_000;

function SourceLines({
  text,
  tab,
  wrapLines,
  originKey,
  changed,
}: {
  text: string;
  tab: TaskFileTabState;
  wrapLines: boolean;
  /** Names the selected line as the composer's focus-return target. */
  originKey?: string | undefined;
  changed: () => void;
}) {
  const lineButtons = useRef<Array<HTMLButtonElement | null>>([]);
  // Count lines as the service does: a final newline ends the last line.
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, maxSourceLines);
  const select = (number: number, extend: boolean) => {
    tab.selectLine(number, extend);
    changed();
  };
  const focusLine = (index: number, extend: boolean) => {
    const bounded = Math.max(0, Math.min(shown.length - 1, index));
    select(bounded + 1, extend);
    lineButtons.current[bounded]?.focus();
  };
  const range = tab.selectedRange;
  return (
    <>
      <RangeControls
        line={tab.selectedLine}
        anchor={tab.rangeAnchorLine}
        pin={tab.rangePin}
        onSet={(edge) => {
          tab.setRangeEdge(edge);
          changed();
        }}
      />
      <div className={`file-source-scroll${wrapLines ? " is-wrapped" : ""}`}>
        {lines.length === 0 && <p className="muted">Empty file.</p>}
        <ol className="file-source-lines" aria-label="Source lines">
          {shown.map((line, index) => {
            const number = index + 1;
            return (
              <li key={number} value={number}>
                <button
                  ref={(element) => {
                    lineButtons.current[index] = element;
                  }}
                  type="button"
                  className="file-source-line"
                  aria-label={`Line ${number}${line.length ? `: ${line}` : " (blank)"}`}
                  aria-pressed={
                    range !== null &&
                    number >= range.startLine &&
                    number <= range.endLine
                  }
                  data-review-return={
                    tab.selectedLine === number ? originKey : undefined
                  }
                  tabIndex={
                    tab.selectedLine === number ||
                    (tab.selectedLine === null && number === 1)
                      ? 0
                      : -1
                  }
                  onClick={(event) => select(number, event.shiftKey)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      focusLine(
                        index + (event.key === "ArrowUp" ? -1 : 1),
                        event.shiftKey,
                      );
                    }
                  }}
                >
                  <span className="file-line-number" aria-hidden="true">
                    {number}
                  </span>
                  <code className="file-line-text">{line}</code>
                </button>
              </li>
            );
          })}
        </ol>
        {lines.length > maxSourceLines && (
          <p className="file-preview-limit" role="status">
            Source preview shows the first {maxSourceLines.toLocaleString()} of{" "}
            {lines.length.toLocaleString()} lines. The full file remains bounded
            by the service byte limit.
          </p>
        )}
      </div>
    </>
  );
}

export function MarkdownPreview({ text }: { text: string }) {
  return (
    <article className="file-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {text}
      </Markdown>
    </article>
  );
}

function RasterDocumentView({
  preview,
  tab,
  changed,
}: {
  preview: Extract<
    NonNullable<TaskFileTabState["preview"]>["preview"],
    { kind: "base64" }
  >;
  tab: TaskFileTabState;
  changed: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () =>
      setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore saved pan only when the tab or observed bytes change, not on every pan update.
  useLayoutEffect(() => {
    viewport.current?.scrollTo(tab.imageScrollLeft, tab.imageScrollTop);
  }, [tab.key, preview.sha256]);
  const width = preview.width ?? 0;
  const height = preview.height ?? 0;
  const fitScale =
    width > 0 && height > 0 && bounds.width > 0 && bounds.height > 0
      ? Math.min(1, bounds.width / width, bounds.height / height)
      : 1;
  const scale = fitScale * (tab.imageFit ? 1 : tab.imageZoom);
  return (
    <div className="file-raster-viewer">
      <div
        className="task-actions file-preview-controls"
        role="toolbar"
        aria-label="Raster controls"
      >
        <Button
          variant="secondary"
          aria-pressed={tab.imageFit}
          onClick={() => {
            tab.imageFit = true;
            tab.imageZoom = 1;
            if (viewport.current) viewport.current.scrollTo(0, 0);
            changed();
          }}
        >
          Fit
        </Button>
        <Button
          variant="secondary"
          disabled={tab.imageFit ? false : tab.imageZoom <= 0.5}
          onClick={() => {
            tab.imageFit = false;
            tab.imageZoom = Math.max(0.5, tab.imageZoom - 0.25);
            changed();
          }}
        >
          Zoom out
        </Button>
        <span aria-live="polite">
          {tab.imageFit ? "Fit" : `${Math.round(tab.imageZoom * 100)}%`}
        </span>
        <Button
          variant="secondary"
          disabled={!tab.imageFit && tab.imageZoom >= 4}
          onClick={() => {
            tab.imageFit = false;
            tab.imageZoom = Math.min(
              4,
              (tab.imageFit ? 1 : tab.imageZoom) + 0.25,
            );
            changed();
          }}
        >
          Zoom in
        </Button>
      </div>
      <div
        className="file-image-scroll"
        ref={viewport}
        onScroll={(event) => {
          tab.imageScrollLeft = event.currentTarget.scrollLeft;
          tab.imageScrollTop = event.currentTarget.scrollTop;
        }}
      >
        <img
          className={
            tab.imageFit ? "file-image-preview is-fit" : "file-image-preview"
          }
          style={{
            width: `${Math.max(1, Math.round(width * scale))}px`,
            height: `${Math.max(1, Math.round(height * scale))}px`,
          }}
          src={`data:${preview.mime};base64,${preview.data}`}
          alt={`Raster preview of ${pathLabel(tab.scope, tab.path)}`}
        />
      </div>
      <p className="muted">
        Fit keeps the whole image visible. Zoomed images can be panned by
        scrolling. Dimensions are bounded by the service preview limit.
      </p>
    </div>
  );
}

/**
 * One line for the open file (path · type · size · time) and, collapsed below it, the hash and
 * read times. Shared by current Files and retained evidence; `rows` are the caller's own facts.
 */
export function FileHeader({
  path,
  data,
  observedAt,
  rows,
  resetKey,
}: {
  path: string;
  data: NonNullable<NonNullable<TaskFileTabState["preview"]>["preview"]> | null;
  observedAt: number | null;
  rows: ReadonlyArray<readonly [label: string, value: string]>;
  /** The disclosure starts collapsed again when this changes: another tab or other bytes. */
  resetKey: string;
}) {
  const facts = [path];
  if (data) {
    facts.push(
      data.mime.split(";")[0]?.trim() ?? data.mime,
      `${data.size.toLocaleString()} bytes`,
    );
    if (data.kind === "base64" && data.width && data.height)
      facts.push(`${data.width} × ${data.height} px`);
  }
  if (observedAt !== null) facts.push(clockLabel(observedAt));
  const all = [...rows, ...(data ? [["SHA-256", data.sha256] as const] : [])];
  return (
    <div className="file-header">
      <p className="file-header-line">{facts.join(" · ")}</p>
      {all.length > 0 && (
        <details key={resetKey} className="file-provenance">
          <summary>Provenance &amp; limits</summary>
          <dl>
            {all.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="identifier">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

/** Renders ready preview bytes; shared by current Files and retained evidence. */
export function FilePreviewBody({
  data,
  name,
  tab,
  changed,
  comment,
}: {
  data: NonNullable<NonNullable<TaskFileTabState["preview"]>["preview"]>;
  name: string;
  tab: TaskFileTabState;
  /** Exact anchor for a selected source range in this origin, when reviewable. */
  comment?: {
    originKey: string;
    label: string;
    anchorFor: (
      startLine: number,
      endLine: number,
      contentSha256: string,
    ) => ReviewAnchorCandidate;
  };
  changed: () => void;
}) {
  const isMarkdown =
    data.kind === "text" &&
    (data.mime.includes("markdown") ||
      /\.(?:md|markdown|mdown|mkdn)$/i.test(name));
  return (
    <>
      {data.kind === "text" && (
        <>
          {isMarkdown && (
            <div
              className="task-actions file-preview-controls"
              role="toolbar"
              aria-label="Markdown view"
            >
              <Button
                variant="secondary"
                aria-pressed={tab.sourceMode === "rendered"}
                onClick={() => {
                  tab.sourceMode = "rendered";
                  changed();
                }}
              >
                Rendered
              </Button>
              <Button
                variant="secondary"
                aria-pressed={tab.sourceMode === "source"}
                onClick={() => {
                  tab.sourceMode = "source";
                  changed();
                }}
              >
                Source
              </Button>
            </div>
          )}
          {(!isMarkdown || tab.sourceMode === "source") && (
            <div
              className="task-actions file-preview-controls"
              role="toolbar"
              aria-label="Source presentation"
            >
              <Button
                variant="secondary"
                aria-pressed={tab.wrapSource}
                onClick={() => {
                  tab.wrapSource = !tab.wrapSource;
                  changed();
                }}
              >
                Wrap
              </Button>
            </div>
          )}
          {isMarkdown && tab.sourceMode === "rendered" ? (
            <MarkdownPreview text={data.text} />
          ) : (
            <>
              <SourceLines
                text={data.text}
                tab={tab}
                wrapLines={tab.wrapSource}
                originKey={comment?.originKey}
                changed={changed}
              />
              {comment && (
                <>
                  <div className="task-actions file-comment-actions">
                    <p className="muted" aria-live="polite">
                      {tab.selectedRange
                        ? `Selected lines ${tab.selectedRange.startLine}–${tab.selectedRange.endLine}`
                        : "Select a line, or use Set start and Set end for a range, to comment."}
                    </p>
                    <CommentAction
                      originKey={comment.originKey}
                      label={comment.label}
                      anchor={
                        tab.selectedRange
                          ? comment.anchorFor(
                              tab.selectedRange.startLine,
                              tab.selectedRange.endLine,
                              data.sha256,
                            )
                          : null
                      }
                    />
                  </div>
                  <ReviewComposer originKey={comment.originKey} />
                </>
              )}
            </>
          )}
        </>
      )}
      {data.kind === "base64" && data.mime !== "application/pdf" && (
        <RasterDocumentView
          key={tab.key}
          preview={data}
          tab={tab}
          changed={changed}
        />
      )}
      {data.kind === "base64" &&
        data.mime === "application/pdf" &&
        (data.maxDisplayedPages !== undefined &&
        data.maxCanvasPixels !== undefined ? (
          <PdfDocumentView
            key={`${tab.key}:${data.sha256}`}
            data={data.data}
            maxDisplayedPages={data.maxDisplayedPages}
            maxCanvasPixels={data.maxCanvasPixels}
            page={tab.pdfPage}
            zoom={tab.pdfZoom}
            setPage={(page) => {
              tab.pdfPage = page;
              changed();
            }}
            setZoom={(zoom) => {
              tab.pdfZoom = zoom;
              changed();
            }}
            scrollLeft={tab.pdfScrollLeft}
            scrollTop={tab.pdfScrollTop}
            onScroll={(left, top) => {
              tab.pdfScrollLeft = left;
              tab.pdfScrollTop = top;
            }}
          />
        ) : (
          <p role="alert">
            This PDF could not be opened safely: the service did not state its
            preview limits.
          </p>
        ))}
    </>
  );
}

export function TaskFiles({
  client,
  session,
  taskId,
  state,
  changes,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  state: TaskFilesState;
  /** Read-only: the Branch comparisons the Changes tab has already read. Files never reads one. */
  changes: TaskChangesState;
}) {
  const [, render] = useState(0);
  const readingArea = useRef<HTMLDivElement>(null);
  const explorerEntries = useRef<Array<HTMLButtonElement | null>>([]);
  const changed = useCallback(() => render((value) => value + 1), []);
  const activeTab =
    state.tabs.find((tab) => tab.key === state.activeTabKey) ?? null;
  const directoryKey = JSON.stringify([
    state.scope,
    state.path,
    state.showIgnored,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: directoryKey captures scope, path and ignored visibility by value from mutable task state.
  const directoryLoader = useCallback(
    async (signal: AbortSignal) => {
      const current = client.captureAuthenticationScope();
      const response = await client.read(
        requestUrl(taskId, state.scope, state.path, state.showIgnored, "files"),
        workspaceDirectoryReadSchema,
        signal,
      );
      if (!current()) throw new Error("stale-authentication");
      return response;
    },
    [client, taskId, directoryKey],
  );
  const directoryResource = useOperatorResource(
    `${session.csrfToken}:${taskId}:files:${directoryKey}`,
    directoryLoader,
  );
  useEffect(() => {
    if (!directoryResource.state.data) return;
    state.directory = directoryResource.state.data.data;
    state.directoryKey = directoryKey;
  }, [directoryResource.state.data, directoryKey, state]);
  const directory =
    directoryResource.state.data?.data ??
    (state.directoryKey === directoryKey ? state.directory : null);
  useEffect(() => {
    if (!directory) return;
    const desiredKey =
      state.focusAfterDirectoryKey === directoryKey
        ? state.focusEntryAfterNavigation
        : state.explorerFocusKey;
    let index = directory.entries.findIndex(
      (entry) => fileEntryKey(entry) === desiredKey,
    );
    if (index < 0) index = directory.entries.length ? 0 : -1;
    const entry = index >= 0 ? directory.entries[index] : null;
    const key = entry ? fileEntryKey(entry) : null;
    const shouldFocus = state.focusAfterDirectoryKey === directoryKey;
    state.focusAfterDirectoryKey = null;
    state.focusEntryAfterNavigation = null;
    if (state.explorerFocusKey !== key) {
      state.explorerFocusKey = key;
      changed();
    }
    if (shouldFocus && index >= 0)
      window.requestAnimationFrame(() =>
        explorerEntries.current[index]?.focus(),
      );
  }, [directory, directoryKey, state, changed]);
  // Open at a repository root once, when nothing else has chosen a location: a link, an open
  // tab or any navigation wins, and the jump never moves focus.
  useEffect(() => {
    if (state.defaultLocationApplied) return;
    if (activeTab || state.scope.kind !== "workspace" || state.path.length) {
      state.defaultLocationApplied = true;
      return;
    }
    if (directory?.state !== "ready" || directory.scope.kind !== "workspace")
      return;
    state.defaultLocationApplied = true;
    const repositories = directory.entries.flatMap((entry) =>
      entry.kind === "repository" ? [entry.repositoryId] : [],
    );
    const repositoryId =
      changes.repositoryId && repositories.includes(changes.repositoryId)
        ? changes.repositoryId
        : repositories[0];
    if (!repositoryId) return;
    state.scope = { kind: "repository", repositoryId };
    state.path = [];
    state.explorerFocusKey = null;
    changed();
  }, [activeTab, directory, changes, state, changed]);
  const directoryObservedAt =
    directoryResource.state.data?.observedAt ?? state.directoryObservedAt;
  const previewKey = activeTab
    ? JSON.stringify([activeTab.scope, activeTab.path, state.showIgnored])
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewKey captures the tab scope, path and ignored visibility by value.
  const previewLoader = useCallback(
    async (signal: AbortSignal) => {
      if (!activeTab) throw new Error("No file selected");
      const current = client.captureAuthenticationScope();
      const response = await client.read(
        requestUrl(
          taskId,
          activeTab.scope,
          activeTab.path,
          state.showIgnored,
          "preview",
        ),
        workspacePreviewReadSchema,
        signal,
      );
      if (!current()) throw new Error("stale-authentication");
      return { tabKey: activeTab.key, previewKey, response };
    },
    [client, taskId, previewKey, activeTab],
  );
  const previewResource = useOperatorResource(
    activeTab
      ? `${session.csrfToken}:${taskId}:preview:${activeTab.key}:${previewKey}`
      : null,
    previewLoader,
    Boolean(activeTab && activeTab.previewKey !== previewKey),
  );
  useEffect(() => {
    const response = previewResource.state.data;
    if (
      !response ||
      !activeTab ||
      response.tabKey !== activeTab.key ||
      response.previewKey !== previewKey
    )
      return;
    // A re-read of the same file is a Refresh; compare it with what was shown.
    if (activeTab.preview !== response.response.data) {
      const change =
        activeTab.previewKey === previewKey
          ? previewChange(activeTab.preview, response.response.data)
          : { notice: "", details: [] };
      activeTab.changeNotice = change.notice;
      activeTab.changeDetails = change.details;
    }
    activeTab.preview = response.response.data;
    activeTab.previewKey = previewKey;
    activeTab.observedAt = response.response.observedAt;
    changed();
  }, [previewResource.state.data, previewKey, activeTab, changed]);
  const currentPreviewResponse =
    activeTab &&
    previewResource.state.data?.tabKey === activeTab.key &&
    previewResource.state.data.previewKey === previewKey
      ? previewResource.state.data.response
      : null;
  const preview =
    currentPreviewResponse?.data ??
    (activeTab?.previewKey === previewKey ? activeTab.preview : null);
  const previewObservedAt =
    currentPreviewResponse?.observedAt ?? activeTab?.observedAt ?? null;

  const navigate = (
    scope: TaskFilesState["scope"],
    path: string[],
    focusEntryKey: string | null = null,
  ) => {
    state.defaultLocationApplied = true;
    state.scope = scope;
    state.path = path;
    state.mobileView = "list";
    state.focusAfterDirectoryKey = JSON.stringify([
      scope,
      path,
      state.showIgnored,
    ]);
    state.focusEntryAfterNavigation = focusEntryKey;
    changed();
  };
  const selectFile = (path: string[], focusEntryKey: string) => {
    const key = JSON.stringify([state.scope, path]);
    state.defaultLocationApplied = true;
    if (!state.tabs.some((tab) => tab.key === key))
      state.tabs.push(new TaskFileTabState(key, state.scope, [...path]));
    state.activeTabKey = key;
    state.path = path.slice(0, -1);
    state.mobileView = "preview";
    state.explorerFocusKey = focusEntryKey;
    state.returnFocusEntryKey = focusEntryKey;
    changed();
  };
  const openTab = (key: string) => {
    const tab = state.tabs.find((item) => item.key === key);
    if (!tab) return;
    state.defaultLocationApplied = true;
    state.activeTabKey = key;
    state.scope = tab.scope;
    state.path = tab.path.slice(0, -1);
    state.mobileView = "preview";
    changed();
  };
  const closeTab = (key: string) => {
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    const wasActive = state.activeTabKey === key;
    state.tabs.splice(index, 1);
    if (wasActive) {
      const next = state.tabs[Math.min(index, state.tabs.length - 1)] ?? null;
      state.activeTabKey = next?.key ?? null;
      if (next) {
        state.scope = next.scope;
        state.path = next.path.slice(0, -1);
      } else state.mobileView = "list";
    }
    changed();
  };
  const backToFileList = () => {
    state.mobileView = "list";
    changed();
    const index =
      directory?.entries.findIndex(
        (entry) => fileEntryKey(entry) === state.returnFocusEntryKey,
      ) ?? -1;
    if (index >= 0)
      window.requestAnimationFrame(() =>
        explorerEntries.current[index]?.focus(),
      );
  };
  // Markers come only from the Branch read the Changes tab holds for this repository and the base
  // it is using; a missing read is silent and an unusable one is explained.
  const markerRepository =
    state.scope.kind === "repository" ? state.scope.repositoryId : null;
  const comparisonRead = markerRepository
    ? changes.comparisonReads[
        comparisonReadKey(session.csrfToken, taskId, {
          target: "branch",
          repositoryId: markerRepository,
          baseBranch: changes.baseBranchByRepository[markerRepository] ?? null,
          changeSet: null,
        })
      ]
    : undefined;
  const markers = markerRepository
    ? changeMarkers(comparisonRead, markerRepository, state.path)
    : null;
  const listed = directory?.state === "ready";
  const markersUnusable =
    listed && comparisonRead !== undefined && markers === null;
  const deletedRows =
    markers && directory?.state === "ready"
      ? markers.deleted.filter(
          (item) =>
            !directory.entries.some(
              (entry) =>
                entry.kind !== "repository" && entry.name === item.name,
            ),
        )
      : [];
  const refreshing =
    directoryResource.state.pending ||
    Boolean(activeTab && previewResource.state.pending);
  const currentPath = pathLabel(state.scope, state.path);
  const locationCrumbs = crumbsFor(state.scope, state.path);
  const selectedLabel = activeTab
    ? pathLabel(activeTab.scope, activeTab.path)
    : null;
  const crumbScope = activeTab?.scope ?? state.scope;
  const crumbPath = activeTab ? activeTab.path.slice(0, -1) : state.path;
  const crumbs = crumbsFor(crumbScope, crumbPath);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore reading position only when switching tabs.
  useLayoutEffect(() => {
    if (activeTab) readingArea.current?.scrollTo(0, activeTab.readingScrollTop);
  }, [activeTab?.key]);

  return (
    <section id="files" className="task-files" aria-labelledby="files-heading">
      <h3 id="files-heading" className="section-heading">
        Files
      </h3>
      <p>
        Read workspace and repository files from the selected task. Content is
        shown as text or a bounded, read-only preview.
      </p>
      {state.linkNotice && <p role="alert">{state.linkNotice}</p>}
      <div className="task-actions file-toolbar">
        <Button
          variant="secondary"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => {
            directoryResource.refresh();
            if (activeTab) previewResource.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {directoryResource.state.error && (
        <p role="alert">
          File listing refresh failed. The last successful listing is retained;
          retry to inspect this location again.
        </p>
      )}
      {directory && directory.state !== "ready" && (
        <p role="status">
          This location is {directory.state}; file bytes are not available.
        </p>
      )}
      {directory?.truncated && (
        <p role="status">
          This directory listing is truncated at the service entry bound.
        </p>
      )}
      <div className="file-workbench" data-mobile-view={state.mobileView}>
        <aside
          className="file-rail"
          data-mobile-hidden={state.mobileView === "preview"}
          aria-label="File explorer"
        >
          <h4>Explorer</h4>
          <nav className="file-location" aria-label="Explorer location">
            {locationCrumbs.map((crumb, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb depth is its identity; labels can repeat.
              <Fragment key={`${index}:${crumb.label}`}>
                {index > 0 && <span aria-hidden="true">›</span>}
                {index === locationCrumbs.length - 1 ? (
                  <span
                    className="file-location-current"
                    aria-current="location"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => navigate(crumb.scope, crumb.path)}
                  >
                    {crumb.label}
                  </Button>
                )}
              </Fragment>
            ))}
          </nav>
          {directory?.state === "ready" ? (
            <ul
              className="file-entry-list"
              aria-label={`Files in ${currentPath}`}
            >
              {directory.entries.map((entry, index) => {
                const name =
                  entry.kind === "repository" ? entry.repositoryId : entry.name;
                const entryKey = fileEntryKey(entry);
                const fullPath =
                  entry.kind === "repository"
                    ? `Repository ${entry.repositoryId}`
                    : pathLabel(state.scope, [...state.path, entry.name]);
                const size =
                  entry.kind === "repository"
                    ? "repository"
                    : entry.size === null
                      ? entry.kind
                      : `${entry.kind} · ${entry.size.toLocaleString()} bytes`;
                const change =
                  entry.kind === "repository"
                    ? undefined
                    : markers?.files.get(entry.name);
                const holdsChanges =
                  entry.kind === "directory" &&
                  markers?.directories.has(entry.name);
                const changeNote = change
                  ? `, ${changeWord[change]} in Branch comparison`
                  : holdsChanges
                    ? ", contains changed files"
                    : "";
                return (
                  <li key={`${entry.kind}:${name}`}>
                    <button
                      type="button"
                      className="file-entry"
                      title={fullPath}
                      aria-label={`${name}, ${size}, full path ${fullPath}${entry.ignored ? ", ignored" : ""}${changeNote}`}
                      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space"
                      tabIndex={
                        state.explorerFocusKey === entryKey ||
                        (state.explorerFocusKey === null && index === 0)
                          ? 0
                          : -1
                      }
                      ref={(element) => {
                        explorerEntries.current[index] = element;
                      }}
                      onFocus={() => {
                        if (state.explorerFocusKey !== entryKey) {
                          state.explorerFocusKey = entryKey;
                          changed();
                        }
                      }}
                      onClick={() => {
                        state.explorerFocusKey = entryKey;
                        if (entry.kind === "repository")
                          navigate(
                            {
                              kind: "repository",
                              repositoryId: entry.repositoryId,
                            },
                            [],
                          );
                        else if (entry.kind === "directory")
                          navigate(state.scope, [...state.path, entry.name]);
                        else selectFile([...state.path, entry.name], entryKey);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "ArrowDown" ||
                          event.key === "ArrowUp"
                        ) {
                          event.preventDefault();
                          const nextIndex = Math.max(
                            0,
                            Math.min(
                              directory.entries.length - 1,
                              index + (event.key === "ArrowDown" ? 1 : -1),
                            ),
                          );
                          const next = directory.entries[nextIndex];
                          if (next) {
                            state.explorerFocusKey = fileEntryKey(next);
                            changed();
                            window.requestAnimationFrame(() =>
                              explorerEntries.current[nextIndex]?.focus(),
                            );
                          }
                        } else if (event.key === "ArrowRight") {
                          if (entry.kind === "repository") {
                            event.preventDefault();
                            navigate(
                              {
                                kind: "repository",
                                repositoryId: entry.repositoryId,
                              },
                              [],
                            );
                          } else if (entry.kind === "directory") {
                            event.preventDefault();
                            navigate(state.scope, [...state.path, entry.name]);
                          }
                        } else if (event.key === "ArrowLeft") {
                          if (state.path.length > 0) {
                            event.preventDefault();
                            navigate(
                              state.scope,
                              state.path.slice(0, -1),
                              `directory:${state.path.at(-1)}`,
                            );
                          } else if (state.scope.kind === "repository") {
                            event.preventDefault();
                            navigate(
                              { kind: "workspace" },
                              [],
                              `repository:${state.scope.repositoryId}`,
                            );
                          }
                        }
                      }}
                    >
                      <span className="file-entry-name">
                        {entry.kind === "directory" ? "▸ " : ""}
                        {name}
                      </span>
                      <span className="file-entry-metadata">
                        {size}
                        {entry.ignored ? " · ignored" : ""}
                      </span>
                      <span
                        className="file-entry-marker"
                        data-change={
                          change ?? (holdsChanges ? "within" : undefined)
                        }
                        aria-hidden="true"
                      >
                        {change
                          ? changeLetter[change]
                          : holdsChanges
                            ? "•"
                            : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
              {deletedRows.map((item) => (
                <li
                  key={`deleted:${item.name}`}
                  className="file-entry-deleted"
                  data-change="deleted"
                >
                  <span className="file-entry-name">
                    {item.name}
                    {item.directory ? "/" : ""}
                  </span>
                  <span className="file-entry-metadata">
                    deleted in Branch comparison
                  </span>
                  <span className="file-entry-marker" aria-hidden="true">
                    {changeLetter.deleted}
                  </span>
                </li>
              ))}
              {directory.entries.length === 0 && deletedRows.length === 0 && (
                <li>No entries in this location.</li>
              )}
            </ul>
          ) : (
            <p role="status">
              {directory?.state
                ? `This location is ${directory.state}; file bytes are not available.`
                : "Loading this location…"}
            </p>
          )}
          {/* Late comparison reads must not move file rows during pointer activation. */}
          {listed && markers && (
            <p className="file-observation">
              Changes marked from the Branch comparison
              {markers.baseBranch ? ` against ${markers.baseBranch}` : ""} read
              at {clockLabel(markers.observedAt)}.
              {markers.truncated
                ? " It lists only part of the changes, so some changed files may not be marked."
                : ""}
            </p>
          )}
          {markersUnusable && (
            <p className="file-observation">
              Changed files aren't marked: the Changes tab has no complete
              Branch comparison for this repository.
            </p>
          )}
          <div className="file-rail-footer">
            <label className="check-field">
              <input
                type="checkbox"
                className="native-check"
                checked={state.showIgnored}
                onChange={(event) => {
                  state.showIgnored = event.target.checked;
                  changed();
                }}
              />
              Show ignored files
            </label>
            <p className="muted">Sensitive exclusions still apply.</p>
            {directory?.ignoreStatus === "incomplete" && (
              <p role="status">
                Ignore status is incomplete, so some ignored files may be
                omitted.
              </p>
            )}
          </div>
        </aside>
        <div
          className="file-reading-area"
          data-task-id={taskId}
          data-active-tab-key={activeTab?.key ?? ""}
          data-preview-key={previewKey}
          data-committed-preview-key={activeTab?.previewKey ?? ""}
          data-preview-status={previewResource.state.status}
          data-mobile-hidden={state.mobileView === "list"}
        >
          {activeTab && (
            <>
              <nav className="file-breadcrumbs" aria-label="File path">
                {crumbs.map((crumb, index) => (
                  <Button
                    // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb depth is its identity; labels can repeat.
                    key={`${index}:${crumb.label}`}
                    variant="secondary"
                    onClick={() => navigate(crumb.scope, crumb.path)}
                    aria-current={
                      index === crumbs.length - 1 ? "location" : undefined
                    }
                  >
                    {crumb.label}
                  </Button>
                ))}
                <span className="file-breadcrumb-current">
                  {activeTab.path.at(-1)}
                </span>
              </nav>
              <div
                className="file-tabs"
                role="toolbar"
                aria-label="Open file tabs"
              >
                {state.tabs.map((tab) => {
                  const name = tab.path.at(-1) ?? "File";
                  const fullPath = pathLabel(tab.scope, tab.path);
                  return (
                    <div className="file-tab" key={tab.key}>
                      <button
                        type="button"
                        className="file-tab-open"
                        aria-current={
                          tab.key === activeTab.key ? "page" : undefined
                        }
                        title={fullPath}
                        onClick={() => openTab(tab.key)}
                      >
                        {name}
                      </button>
                      <button
                        type="button"
                        className="file-tab-close"
                        aria-label={`Close ${name} tab`}
                        title={`Close ${fullPath}`}
                        onClick={() => closeTab(tab.key)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <Button
            className="file-back-to-list"
            variant="secondary"
            onClick={backToFileList}
          >
            Back to file list
          </Button>
          {!activeTab && (
            <p className="file-empty-preview">
              Select a file to open its preview.
            </p>
          )}
          {activeTab && (
            <div
              className="file-preview-scroll"
              ref={readingArea}
              onScroll={(event) => {
                activeTab.readingScrollTop = event.currentTarget.scrollTop;
              }}
            >
              <div className="file-preview" aria-live="polite">
                <FileHeader
                  path={activeTab.path.join("/")}
                  data={
                    preview?.state === "ready"
                      ? (preview.preview ?? null)
                      : null
                  }
                  observedAt={previewObservedAt}
                  resetKey={`${activeTab.key}:${preview?.state === "ready" ? preview.preview?.sha256 : ""}`}
                  rows={[
                    ["Location", selectedLabel ?? ""],
                    ...(directoryObservedAt !== null
                      ? [
                          [
                            "Listing observed",
                            clockLabel(directoryObservedAt),
                          ] as const,
                        ]
                      : []),
                    ...(previewObservedAt !== null
                      ? [["File read", clockLabel(previewObservedAt)] as const]
                      : []),
                  ]}
                />
                {activeTab.changeNotice && (
                  <>
                    <p role="status" className="file-change-notice">
                      {activeTab.changeNotice}
                    </p>
                    <OutcomeDetails
                      // A new notice starts with Details collapsed.
                      key={activeTab.changeDetails.map(([, v]) => v).join()}
                      fields={activeTab.changeDetails}
                    />
                  </>
                )}
                {previewResource.state.pending && !preview && (
                  <p role="status">Reading selected file…</p>
                )}
                {previewResource.state.error && (
                  <p role="alert">
                    File preview refresh failed. The last successful preview is
                    retained; retry to read the current file bytes.
                  </p>
                )}
                {preview && preview.state !== "ready" && (
                  <p role="status">
                    Preview is {preview.state}
                    {preview.metadata?.reason
                      ? ` (${preview.metadata.reason})`
                      : ""}
                    . File bytes are unavailable.
                  </p>
                )}
                {preview?.state === "ready" && preview.preview && (
                  <FilePreviewBody
                    data={preview.preview}
                    name={activeTab.path.at(-1) ?? ""}
                    tab={activeTab}
                    changed={changed}
                    comment={{
                      originKey: `files:${activeTab.key}`,
                      label: "current file",
                      anchorFor: (startLine, endLine, contentSha256) =>
                        workspaceFileAnchor(
                          taskId,
                          activeTab,
                          { startLine, endLine },
                          contentSha256,
                        ),
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
