import { ArrowUp, Folder } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { FolderListing } from "../../src/operator/contracts.js";
import { ClientError, type OperatorClient } from "./api.js";
import { Button, StatusBadge } from "./components.js";
import { folderCaption, folderMatches, pickerStart } from "./setup-model.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";

type Listing =
  | { state: "loading" }
  | { state: "ready"; data: FolderListing["data"] }
  | { state: "failed"; message: string };

const failure = (error: unknown) =>
  error instanceof ClientError && error.status === 400
    ? "Enter a folder as ~/… without hidden (.name) or .. segments."
    : error instanceof ClientError && error.status === 403
      ? "Hidden folders and folders outside your home folder can't be browsed. Type a path instead."
      : error instanceof ClientError && error.status === 404
        ? "This folder doesn't exist. Type a path instead."
        : "Folders couldn't be listed. Type a path instead.";

/** The service lists subfolders of the operator's home folder; nothing is granted. */
export function FolderPicker({
  client,
  csrfToken,
  path,
  expected,
  disabled,
  onUse,
  trigger,
}: {
  client: OperatorClient;
  csrfToken: string;
  path: string;
  expected: { owner: string; name: string; ref: string } | null;
  disabled?: boolean;
  onUse: (path: string) => void;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState("~");
  const [value, setValue] = useState("");
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const pathId = useId();
  // Read on open and on each navigation; never cached.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setListing({ state: "loading" });
    client.folders(location, csrfToken).then(
      (r) => live && setListing({ state: "ready", data: r.data }),
      (e) => live && setListing({ state: "failed", message: failure(e) }),
    );
    return () => {
      live = false;
    };
  }, [open, location, client, csrfToken]);
  const child = (name: string) =>
    `${location === "~" ? "~" : location}/${name}`;
  const repository = expected ? `${expected.owner}/${expected.name}` : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setLocation(pickerStart(path));
          setValue(path);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild disabled={disabled}>
        {trigger}
      </DialogTrigger>
      <DialogContent className="folder-picker">
        <DialogTitle>Choose repository folder</DialogTitle>
        <DialogDescription>
          {expected
            ? `Pick the local checkout of ${repository}. The service verifies its origin and that ref ${expected.ref || "the chosen ref"} is available.`
            : "Pick the local checkout of the repository. The service verifies its origin and ref."}
        </DialogDescription>
        <div className="folder-picker-location">
          <Button
            type="button"
            variant="secondary"
            aria-label="Up one folder"
            disabled={listing.state !== "ready" || !listing.data.parent}
            onClick={() =>
              listing.state === "ready" &&
              listing.data.parent &&
              setLocation(listing.data.parent)
            }
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <span className="mono metadata">{location}</span>
        </div>
        <ul
          className="folder-picker-list"
          aria-label="Folders"
          aria-busy={listing.state === "loading"}
        >
          {listing.state === "loading" && (
            <li className="metadata muted">Loading folders…</li>
          )}
          {listing.state === "failed" && (
            <li className="error-text" role="alert">
              {listing.message}
            </li>
          )}
          {listing.state === "ready" && listing.data.entries.length === 0 && (
            <li className="metadata muted">No subfolders.</li>
          )}
          {listing.state === "ready" &&
            listing.data.entries.map((entry) => {
              const target = child(entry.name);
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="folder-picker-row"
                    aria-pressed={entry.kind === "git" && value === target}
                    onClick={() =>
                      // A plain folder opens; a checkout is selected.
                      entry.kind === "git"
                        ? setValue(target)
                        : setLocation(target)
                    }
                  >
                    <Folder aria-hidden="true" />
                    <span className="folder-picker-name">
                      <span className="body">{entry.name}</span>
                      <span className="metadata muted">
                        {folderCaption(entry)}
                      </span>
                    </span>
                    {folderMatches(entry, expected) && (
                      <StatusBadge>Matches {repository}</StatusBadge>
                    )}
                  </button>
                </li>
              );
            })}
          {listing.state === "ready" && listing.data.truncated && (
            <li className="metadata muted">
              Showing the first 200 folders. Type a path for others.
            </li>
          )}
        </ul>
        <label className="field body" htmlFor={pathId}>
          Or enter a path
          <Input
            id={pathId}
            className="control"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              const typed = value.trim().replace(/\/+$/, "");
              if (
                e.key === "Enter" &&
                (typed === "~" || typed.startsWith("~/"))
              ) {
                e.preventDefault();
                setLocation(typed);
              }
            }}
          />
        </label>
        <p className="metadata muted">
          Listed by the Ensemble service on this Mac: folder names and Git
          status only. Choosing a folder grants nothing until you create the
          project.
        </p>
        <div className="settings-actions">
          <Button
            type="button"
            disabled={!value.trim()}
            onClick={() => {
              onUse(value.trim());
              setOpen(false);
            }}
          >
            Use this folder
          </Button>
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
