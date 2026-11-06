import { useEffect, useRef, useState } from "react";
import {
  statusAnnouncementGapMs,
  throttleDelay,
} from "./task-conversation-model.js";

/** What a running assignment is doing, changing (and so announced) at most once per gap. */
export function WorkingStatus({ text }: { text: string | null }) {
  const [shown, setShown] = useState(text);
  const lastShownAt = useRef<number | null>(text === null ? null : Date.now());
  const shownRef = useRef(shown);
  useEffect(() => {
    if (text === shownRef.current) return;
    if (text === null) {
      lastShownAt.current = null;
      shownRef.current = null;
      setShown(null);
      return;
    }
    const timer = setTimeout(
      () => {
        lastShownAt.current = Date.now();
        shownRef.current = text;
        setShown(text);
      },
      throttleDelay(lastShownAt.current, Date.now(), statusAnnouncementGapMs),
    );
    return () => clearTimeout(timer);
  }, [text]);
  return shown === null || text === null ? null : (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="conv-working"
    >
      {shown}
    </p>
  );
}
