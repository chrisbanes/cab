import type { KeyboardEvent, ReactNode } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type LayoutStorage,
} from "react-resizable-panels";
import { Button } from "./components.js";
import "./changes-pane.css";

/** The conversation never gets narrower than this, whatever width was saved. */
const conversationMinimum = 480;
/** The pane's own floor. */
const paneMinimum = 320;
const panelIds = ["split-conversation", "split-changes"];
/** Blocked or unavailable storage reads as no saved width. */
const storage: LayoutStorage = {
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
