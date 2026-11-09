import { PanelLeft } from "lucide-react";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
  type LayoutStorage,
} from "react-resizable-panels";
import { Button } from "./components.js";
import { useNarrowViewport } from "./diff-view.js";
import "./changes-pane.css";

/** The conversation never gets narrower than this, whatever width was saved. */
const conversationMinimum = 480;
/** The pane's own floor. */
const paneMinimum = 320;
const panelIds = ["split-conversation", "split-changes"];
/** Blocked or unavailable storage reads as no saved width. */
export const storage: LayoutStorage = {
  getItem(key) {
    try {
      const saved = localStorage.getItem(key);
      // The library parses this unguarded, so only a saved object reaches it.
      const layout: unknown = saved === null ? null : JSON.parse(saved);
      return typeof layout === "object" && layout !== null ? saved : null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

/** The Overview while the Changes pane is open: the conversation column and the pane, resizable. */
export function ChangesSplit({
  conversation,
  pane,
}: {
  conversation: ReactNode;
  pane: ReactNode;
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "cab.changes-pane.v1",
    panelIds,
    onlySaveAfterUserInteractions: true,
    storage,
  });
  return (
    <Group
      id="task-changes-split"
      className="changes-split"
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      style={{ overflow: "visible" }}
    >
      <Panel
        id="split-conversation"
        minSize={conversationMinimum}
        defaultSize="50%"
        style={{ overflow: "visible", maxHeight: "none" }}
      >
        {conversation}
      </Panel>
      <Separator
        className="changes-split-handle"
        aria-label="Resize conversation and changes"
      />
      <Panel
        id="split-changes"
        minSize={paneMinimum}
        defaultSize="50%"
        style={{ overflow: "visible", maxHeight: "none" }}
      >
        {pane}
      </Panel>
    </Group>
  );
}

/** The Changes content beside the conversation; Escape closes it only when nothing inside dismissed it. */
export function ChangesPane({
  onClose,
  onFullWidth,
  children,
}: {
  onClose: () => void;
  onFullWidth: () => void;
  children: ReactNode;
}) {
  const dismiss = (event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing
    )
      onClose();
  };
  return (
    <aside
      className="changes-pane"
      aria-label="Changes"
      tabIndex={-1}
      onKeyDown={dismiss}
    >
      <div className="changes-pane-actions">
        <Button variant="secondary" onClick={onFullWidth}>
          Open full width
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      {children}
    </aside>
  );
}

const workbenchPanelIds = ["changes-files", "changes-diff"];
const FilesPanel = createContext<{
  collapsed: boolean;
  toggle: () => void;
} | null>(null);

/** Shows or hides the changed-files panel; renders nothing outside a resizable workbench. */
export function FilesPanelToggle() {
  const panel = useContext(FilesPanel);
  if (!panel) return null;
  return (
    <button
      type="button"
      className="changes-files-toggle"
      aria-label={panel.collapsed ? "Show changed files" : "Hide changed files"}
      aria-expanded={!panel.collapsed}
      aria-controls="changes-files"
      title={panel.collapsed ? "Show changed files" : "Hide changed files"}
      onClick={panel.toggle}
    >
      <PanelLeft aria-hidden="true" size={16} />
    </button>
  );
}

/** Below this width the files stack above the diff: side by side, the diff would be too narrow to read. */
const splitMinimum = 720;

/** The card's width, measured before paint so the first layout is already the right one. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * The changed files beside the diff, resizable and collapsible. A narrow card stacks them;
 * phones show one at a time.
 */
export function ChangesWorkbench({
  files,
  diff,
  mobileView,
}: {
  files: ReactNode;
  diff: ReactNode;
  mobileView: "list" | "preview";
}) {
  const phone = useNarrowViewport();
  const { ref, width } = useWidth();
  const panelRef = usePanelRef();
  const [collapsed, setCollapsed] = useState(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "cab.changes-workbench.v1",
    panelIds: workbenchPanelIds,
    onlySaveAfterUserInteractions: true,
    storage,
  });
  const toggle = () => {
    const panel = panelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };
  // One element carries the measured ref, so the observer keeps watching across layout changes.
  return (
    <div ref={ref} className="changes-workbench-host">
      {width === null ? null : phone || width < splitMinimum ? (
        <div className="changes-workbench" data-mobile-view={mobileView}>
          {files}
          {diff}
        </div>
      ) : (
        <FilesPanel.Provider value={{ collapsed, toggle }}>
          <Group
            id="changes-workbench"
            className="changes-workbench-split"
            orientation="horizontal"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
          >
            <Panel
              id="changes-files"
              panelRef={panelRef}
              collapsible
              collapsedSize={0}
              minSize={160}
              maxSize="50%"
              defaultSize={260}
              onResize={() =>
                setCollapsed(panelRef.current?.isCollapsed() ?? false)
              }
            >
              {files}
            </Panel>
            <Separator
              className="changes-workbench-handle"
              aria-label="Resize changed files and diff"
            />
            <Panel id="changes-diff" minSize={240}>
              {diff}
            </Panel>
          </Group>
        </FilesPanel.Provider>
      )}
    </div>
  );
}
