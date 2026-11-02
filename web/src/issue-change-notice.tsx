import { Alert, AlertDescription } from "./ui/alert.js";

/**
 * Shown on the task and its handback review when the imported issue's text changed after the
 * work was handed back. Informational: the handback stands and nothing reopens.
 */
export function IssueChangedSinceHandback({ changed }: { changed: boolean }) {
  if (!changed) return null;
  return (
    <Alert variant="warning" data-issue-changed-since-handback>
      <AlertDescription>
        The issue changed after this work was handed back. The handback stands
        and nothing reopens; read the current issue before relying on it.
      </AlertDescription>
    </Alert>
  );
}
