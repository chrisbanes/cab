// PROTOTYPE — throwaway. Not part of the build (vite builds index.html only).
// Question: what should the conversation-first task Overview look like?
// Three variants of the task Overview, switchable via `?variant=A|B|C`, on a
// standalone page with fake data: the real /app/tasks/:id needs a seeded service
// and the server timeline read does not exist yet.
import { createRoot } from "react-dom/client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";
import "./prototype-task-thread.css";

// ---------- fake timeline ----------
type Cmd = { cmd: string; exit: number; output: string; truncated?: boolean };
type Entry =
  | { id: string; kind: "operator"; at: string; text: string; label: string }
  | {
      id: string;
      kind: "agent";
      at: string;
      who: string;
      text: string;
      streaming?: boolean;
    }
  | { id: string; kind: "tools"; at: string; cmds: Cmd[] }
  | { id: string; kind: "files"; at: string; count: number }
  | { id: string; kind: "gap"; at: string; text: string; detail: string }
  | { id: string; kind: "question"; at: string; reqId: string }
  | { id: string; kind: "approval"; at: string; reqId: string }
  | {
      id: string;
      kind: "result";
      at: string;
      who: string;
      summary: string;
      criteria: [string, boolean][];
    }
  | {
      id: string;
      kind: "delegate";
      at: string;
      assignment: string;
      profile: string;
      harness: string;
      status: string;
      brief: string;
      entries: Entry[];
    };

const delegateEntries: Entry[] = [
  {
    id: "d1",
    kind: "agent",
    at: "10:21",
    who: "reviewer",
    text: "Reviewing `.github/workflows/release.yml` against the npm provenance docs. Checking that `id-token: write` is scoped to the publish job only.",
  },
  {
    id: "d2",
    kind: "gap",
    at: "10:22",
    text: "Tool activity not captured for the Claude harness",
    detail:
      "Claude Bash/Edit/Read tool use is not yet recorded (slice 3). Assistant text is complete for this turn.",
  },
  {
    id: "d3",
    kind: "result",
    at: "10:26",
    who: "reviewer",
    summary:
      "Workflow permissions are correctly scoped. One finding: `npm publish` runs before the tag check, so a manual dispatch could publish an untagged build.",
    criteria: [
      ["id-token scoped to publish job", true],
      ["Publish gated on a release tag", false],
    ],
  },
];

const timeline: Entry[] = [
  {
    id: "e0",
    kind: "gap",
    at: "09:02",
    text: "Tool activity no longer retained",
    detail:
      "Tool rows for turns older than 30 days expire. Assistant text below is kept.",
  },
  {
    id: "e1",
    kind: "operator",
    at: "09:58",
    label: "Task created",
    text: "Publish the npm package with provenance from the release workflow. Releases must stay tag-driven; no manual publishing.",
  },
  {
    id: "e2",
    kind: "agent",
    at: "10:01",
    who: "lead",
    text: "I'll take this in three steps:\n\n1. Add `--provenance` to the publish step and grant `id-token: write` to that job only.\n2. Ask **reviewer** to check the permission scoping.\n3. Run the release dry-run locally before asking to push.\n\nThe current workflow is in `.github/workflows/release.yml`; publish happens in the `npm` job.",
  },
  {
    id: "e3",
    kind: "tools",
    at: "10:03",
    cmds: [
      {
        cmd: 'rg -n "npm publish" .github',
        exit: 0,
        output:
          ".github/workflows/release.yml:48:      - run: npm publish --access public",
      },
      {
        cmd: "cat .github/workflows/release.yml",
        exit: 0,
        output:
          "name: Release\non:\n  push:\n    tags: ['v*']\n  workflow_dispatch:\njobs:\n  npm:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci\n      - run: npm publish --access public",
        truncated: false,
      },
      {
        cmd: "npm test",
        exit: 1,
        output:
          "✖ release workflow › publish step uses provenance\n  AssertionError: expected '--provenance' flag\n\n1 failing, 412 passing",
        truncated: false,
      },
      { cmd: "npm test", exit: 0, output: "413 passing (38s)" },
      { cmd: "npm run build", exit: 0, output: "built in 4.1s" },
    ],
  },
  { id: "e4", kind: "files", at: "10:12", count: 3 },
  {
    id: "e5",
    kind: "delegate",
    at: "10:20",
    assignment: "A-212",
    profile: "reviewer",
    harness: "Claude",
    status: "Completed",
    brief:
      "Check that id-token permissions are scoped to the publish job and that publishing stays tag-driven.",
    entries: delegateEntries,
  },
  {
    id: "e6",
    kind: "agent",
    at: "10:28",
    who: "lead",
    text: "Reviewer found that `workflow_dispatch` can publish an untagged build. I've added a guard:\n\n```yaml\n- if: startsWith(github.ref, 'refs/tags/v')\n  run: npm publish --provenance --access public\n```\n\nOne thing I can't decide from the brief:",
  },
  { id: "e7", kind: "question", at: "10:29", reqId: "Q-31" },
  {
    id: "e8",
    kind: "operator",
    at: "10:34",
    label: "Message to lead",
    text: "Prereleases go to the `next` dist-tag, not `latest`. Keep that.",
  },
  {
    id: "e9",
    kind: "gap",
    at: "10:36",
    text: "2 items not captured · size limit",
    detail:
      "Items 8a41c2, 8a41c3 in turn T-7f2 exceeded the 64 KiB capture limit. Work W-55 · thread th-91c0.",
  },
  {
    id: "e10",
    kind: "tools",
    at: "10:37",
    cmds: [
      {
        cmd: "npm run release:dry-run -- --tag next",
        exit: 0,
        output:
          "npm notice Publishing to https://registry.npmjs.org/ with tag next and provenance (dry-run)\n+ cab@1.4.0-rc.1",
        truncated: true,
      },
    ],
  },
  { id: "e11", kind: "approval", at: "10:39", reqId: "P-8" },
  {
    id: "e12",
    kind: "agent",
    at: "10:40",
    who: "lead",
    text: "While you review the push, I'm drafting the PR description from the changes and the reviewer's result…",
    streaming: true,
  },
];

const requests = {
  "Q-31": {
    title: "Should prereleases publish with provenance too?",
    body: "Provenance needs the OIDC token on every publish. Requiring it for prereleases means `next` builds can only come from tagged CI runs.",
    options: ["Yes, require it for all publishes", "Only for stable releases"],
    recommended: 0,
  },
  "P-8": {
    title: "Push branch cb/npm-provenance and open a PR",
    body: "git push origin cb/npm-provenance · then gh pr create against main",
    options: ["Approve", "Decline"],
    recommended: 0,
  },
} as const;
type ReqId = keyof typeof requests;

// ---------- shared request state (pinned card and inline cards stay in sync) ----------
type Answers = Partial<Record<ReqId, string>>;
let setAnswersGlobal: (fn: (a: Answers) => Answers) => void = () => {};
function useAnswers() {
  const [answers, setAnswers] = useState<Answers>({});
  setAnswersGlobal = setAnswers;
  return answers;
}
const answer = (id: ReqId, value: string) =>
  setAnswersGlobal((a) => ({ ...a, [id]: value }));

// ---------- atoms ----------
function Md({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="pt-md-wrap">
      {raw ? (
        <pre className="pt-raw">{text}</pre>
      ) : (
        <div className="pt-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      )}
      <button
        type="button"
        className="pt-link pt-small"
        onClick={() => setRaw(!raw)}
      >
        {raw ? "Formatted" : "Raw text"}
      </button>
    </div>
  );
}
const failed = (cmds: Cmd[]) => cmds.filter((c) => c.exit !== 0).length;
function ToolGroup({
  cmds,
  open: initial = false,
}: {
  cmds: Cmd[];
  open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  const f = failed(cmds);
  return (
    <div className="pt-tools">
      <button
        type="button"
        className="pt-tools-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="pt-chev">{open ? "▾" : "▸"}</span>
        Ran {cmds.length} command{cmds.length === 1 ? "" : "s"}
        {f > 0 && <span className="pt-fail"> · {f} failed</span>}
      </button>
      {open && cmds.map((c, i) => <CmdRow key={i} c={c} />)}
    </div>
  );
}
function CmdRow({ c }: { c: Cmd }) {
  const [open, setOpen] = useState(c.exit !== 0);
  return (
    <div className="pt-cmd">
      <button
        type="button"
        className="pt-cmd-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <code>$ {c.cmd}</code>
        <span className={c.exit === 0 ? "pt-exit" : "pt-exit pt-fail"}>
          exit {c.exit}
        </span>
      </button>
      {open && (
        <pre className="pt-out">
          {c.output}
          {c.truncated && (
            <span className="pt-muted">{"\n"}… output truncated at 48 KiB</span>
          )}
        </pre>
      )}
    </div>
  );
}
function Gap({ text, detail }: { text: string; detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-gap">
      <span className="pt-gap-line" />
      <button
        type="button"
        className="pt-gap-label"
        onClick={() => setOpen(!open)}
        title={detail}
      >
        ⋯ {text}
      </button>
      <span className="pt-gap-line" />
      {open && <div className="pt-gap-detail">{detail}</div>}
    </div>
  );
}
function RequestCard({
  id,
  answers,
  compact,
}: {
  id: ReqId;
  answers: Answers;
  compact?: boolean;
}) {
  const r = requests[id];
  const done = answers[id];
  const isApproval = id.startsWith("P");
  const [pick, setPick] = useState<string>(r.options[r.recommended]);
  const name = useId();
  return (
    <div className={done ? "pt-req pt-req-done" : "pt-req"}>
      <div className="pt-req-top">
        <span
          className={done ? "pt-badge pt-badge-ok" : "pt-badge pt-badge-attn"}
        >
          {done ? "✓ Recorded" : isApproval ? "● Approval" : "? Question"}
        </span>
        <span className="pt-mono pt-muted">{id}</span>
      </div>
      <div className="pt-req-title">{r.title}</div>
      {!compact && <div className="pt-req-body">{r.body}</div>}
      {done ? (
        <div className="pt-req-answer">
          You answered: <strong>{done}</strong>
        </div>
      ) : isApproval ? (
        <div className="pt-row">
          <button
            type="button"
            className="pt-btn pt-btn-primary"
            onClick={() => answer(id, "Approved")}
          >
            Approve exact action
          </button>
          <button
            type="button"
            className="pt-btn"
            onClick={() => answer(id, "Declined")}
          >
            Decline
          </button>
        </div>
      ) : (
        <div className="pt-col">
          {!compact &&
            r.options.map((o, i) => (
              <label key={o} className="pt-radio">
                <input
                  type="radio"
                  name={name}
                  checked={pick === o}
                  onChange={() => setPick(o)}
                />
                {o}{" "}
                {i === r.recommended && (
                  <span className="pt-muted">· recommended</span>
                )}
              </label>
            ))}
          <div className="pt-row">
            <button
              type="button"
              className="pt-btn pt-btn-primary"
              onClick={() => answer(id, pick)}
            >
              Answer question
            </button>
            {compact && (
              <span className="pt-muted pt-small">
                Recommended: {r.options[r.recommended]}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function Result({ e }: { e: Extract<Entry, { kind: "result" }> }) {
  return (
    <div className="pt-result">
      <div className="pt-req-top">
        <span className="pt-badge pt-badge-ok">✓ Result</span>
        <span className="pt-muted">from {e.who}</span>
      </div>
      <p>{e.summary}</p>
      <ul className="pt-criteria">
        {e.criteria.map(([c, ok]) => (
          <li key={c} className={ok ? "" : "pt-fail"}>
            {ok ? "✓" : "✗"} {c}
          </li>
        ))}
      </ul>
    </div>
  );
}
function FilesRow({ count }: { count: number }) {
  return (
    <a className="pt-files" href="#changes">
      ± Changed {count} files · <span className="pt-link">Open in Changes</span>
    </a>
  );
}
const openRequests = (a: Answers) =>
  (Object.keys(requests) as ReqId[]).filter((id) => !a[id]);

// ---------- shell (static, for context) ----------
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="pt-shell">
      <aside className="pt-sidebar">
        <div className="pt-brand">
          <span className="pt-roof" /> cab
        </div>
        <div className="pt-search">
          Search work <kbd>⌘K</kbd>
        </div>
        <nav>
          <div className="pt-nav">Overview</div>
          <div className="pt-nav">
            Inbox <span className="pt-count">2</span>
          </div>
          <div className="pt-nav pt-nav-on">Tasks</div>
          <div className="pt-section-label">Projects</div>
          <div className="pt-nav">
            <span className="pt-dot" style={{ background: "#818CF8" }} /> Atlas
          </div>
          <div className="pt-nav">
            <span className="pt-dot" style={{ background: "#2DD4BF" }} /> Relay
          </div>
        </nav>
      </aside>
      <div className="pt-page">{children}</div>
    </div>
  );
}
function TaskHeader({ tabs = true }: { tabs?: boolean }) {
  return (
    <header className="pt-taskhead">
      <div className="pt-row pt-between">
        <div>
          <div className="pt-muted pt-small">← Atlas</div>
          <h1 className="pt-title">Publish npm package with provenance</h1>
          <div className="pt-muted">
            Releases publish from tagged CI runs with npm provenance.
          </div>
        </div>
        <div className="pt-row">
          <button type="button" className="pt-btn">
            Execution
          </button>
          <button type="button" className="pt-btn pt-btn-risk">
            Stop…
          </button>
        </div>
      </div>
      <div className="pt-strip">
        <span className="pt-mono pt-muted">T-1342</span>
        <span className="pt-badge pt-badge-run">◐ Running</span>
        <span className="pt-badge pt-badge-attn">Next: you</span>
        <span className="pt-muted">Lead · atlas-lead (Codex)</span>
      </div>
      {tabs && (
        <div className="pt-tabs">
          {["Overview", "Files", "Changes", "Review"].map((t, i) => (
            <span key={t} className={i === 0 ? "pt-tab pt-tab-on" : "pt-tab"}>
              {t}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}
function Composer() {
  return (
    <div className="pt-composer">
      <div className="pt-muted pt-small">
        To <strong>atlas-lead</strong> · resumes the lead's turn
      </div>
      <div className="pt-row">
        <textarea className="pt-input" rows={2} placeholder="Message lead…" />
        <button type="button" className="pt-btn pt-btn-primary">
          Send
        </button>
      </div>
    </div>
  );
}
function Inspector() {
  return (
    <aside className="pt-inspector">
      <section>
        <h3 className="pt-label">Brief</h3>
        <p>
          Publish with provenance from the release workflow. Releases stay
          tag-driven; no manual publishing.
        </p>
      </section>
      <section>
        <h3 className="pt-label">Evidence</h3>
        <p className="pt-muted">3 files changed · 1 result · dry-run passed</p>
      </section>
      <section>
        <h3 className="pt-label">Assignments</h3>
        <div className="pt-arow">
          <span>atlas-lead</span>
          <span className="pt-badge pt-badge-run">◐ Running</span>
        </div>
        <div className="pt-arow">
          <span>reviewer · A-212</span>
          <span className="pt-badge pt-badge-ok">✓ Done</span>
        </div>
      </section>
    </aside>
  );
}

// ---------- Variant A: single thread column, sticky card, inline delegates ----------
function ThreadEntry({ e, answers }: { e: Entry; answers: Answers }) {
  switch (e.kind) {
    case "operator":
      return (
        <div className="pt-op">
          <div className="pt-meta">
            You · {e.label} · {e.at}
          </div>
          <div>{e.text}</div>
        </div>
      );
    case "agent":
      return (
        <div className="pt-agent">
          <div className="pt-meta">
            {e.who} · {e.at}
            {e.streaming && <span className="pt-run"> · writing…</span>}
          </div>
          <Md text={e.text} />
        </div>
      );
    case "tools":
      return <ToolGroup cmds={e.cmds} />;
    case "files":
      return <FilesRow count={e.count} />;
    case "gap":
      return <Gap text={e.text} detail={e.detail} />;
    case "question":
    case "approval":
      return <RequestCard id={e.reqId as ReqId} answers={answers} />;
    case "result":
      return <Result e={e} />;
    case "delegate":
      return <Delegate e={e} answers={answers} />;
  }
}
function Delegate({
  e,
  answers,
}: {
  e: Extract<Entry, { kind: "delegate" }>;
  answers: Answers;
}) {
  const [open, setOpen] = useState(false);
  const res = e.entries.find((x) => x.kind === "result") as
    | Extract<Entry, { kind: "result" }>
    | undefined;
  return (
    <div className="pt-delegate">
      <button
        type="button"
        className="pt-delegate-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="pt-chev">{open ? "▾" : "▸"}</span>
        <span>
          lead delegated to <strong>{e.profile}</strong>
        </span>
        <span className="pt-mono pt-muted">
          {e.assignment} · {e.harness}
        </span>
        <span className="pt-badge pt-badge-ok">✓ {e.status}</span>
      </button>
      {!open && (
        <div className="pt-delegate-sum">
          {e.brief}
          {res && (
            <>
              <br />
              <span className="pt-muted">Result: </span>
              {res.summary}
            </>
          )}
        </div>
      )}
      {open && (
        <div className="pt-delegate-body">
          {e.entries.map((x) => (
            <ThreadEntry key={x.id} e={x} answers={answers} />
          ))}
        </div>
      )}
    </div>
  );
}
function PinnedCard({ answers }: { answers: Answers }) {
  const open = openRequests(answers);
  const [expanded, setExpanded] = useState(false);
  if (!open.length)
    return (
      <div className="pt-pinned pt-pinned-clear">
        ✓ Nothing waiting on you · lead is drafting the PR
      </div>
    );
  return (
    <div className="pt-pinned">
      <button
        type="button"
        className="pt-pinned-banner"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="pt-badge pt-badge-attn">Next: you</span> {open.length}{" "}
        waiting on you <span className="pt-chev">{expanded ? "▴" : "▾"}</span>
      </button>
      <div
        className={
          expanded ? "pt-pinned-body pt-pinned-open" : "pt-pinned-body"
        }
      >
        {open.map((id) => (
          <RequestCard key={id} id={id} answers={answers} compact />
        ))}
      </div>
    </div>
  );
}
function useJump(ref: React.RefObject<HTMLDivElement | null>) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const on = () =>
      setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 40);
    el.addEventListener("scroll", on);
    return () => el.removeEventListener("scroll", on);
  }, [ref]);
  return [
    away,
    () =>
      ref.current?.scrollTo({
        top: ref.current.scrollHeight,
        behavior: "smooth",
      }),
  ] as const;
}
function VariantA({ answers }: { answers: Answers }) {
  const ref = useRef<HTMLDivElement>(null);
  const [away, jump] = useJump(ref);
  return (
    <Shell>
      <div className="pt-a">
        <div className="pt-a-main">
          <TaskHeader />
          <div className="pt-a-scroll" ref={ref}>
            <PinnedCard answers={answers} />
            <div className="pt-thread">
              {timeline.map((e) => (
                <ThreadEntry key={e.id} e={e} answers={answers} />
              ))}
            </div>
          </div>
          {away && (
            <button type="button" className="pt-jump" onClick={jump}>
              ↓ Jump to latest
            </button>
          )}
          <Composer />
        </div>
        <Inspector />
      </div>
    </Shell>
  );
}

// ---------- Variant B: attention rail + turn-grouped log ----------
type Turn = { who: string; at: string; entries: Entry[] };
function toTurns(entries: Entry[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    const who =
      e.kind === "operator"
        ? "You"
        : e.kind === "delegate"
          ? `${e.profile} · ${e.assignment}`
          : e.kind === "agent"
            ? e.who
            : null;
    const last = turns.at(-1);
    if (who && (!last || last.who !== who || e.kind === "delegate"))
      turns.push({ who, at: e.at, entries: [e] });
    else if (last) last.entries.push(e);
    else turns.push({ who: "lead", at: e.at, entries: [e] });
  }
  return turns;
}
function TurnBlock({ t, answers }: { t: Turn; answers: Answers }) {
  const cmds = t.entries.flatMap((e) => (e.kind === "tools" ? e.cmds : []));
  const files = t.entries.find((e) => e.kind === "files");
  const del =
    t.entries[0]?.kind === "delegate"
      ? (t.entries[0] as Extract<Entry, { kind: "delegate" }>)
      : null;
  const body = del ? del.entries : t.entries;
  return (
    <section
      className={
        del
          ? "pt-turn pt-turn-del"
          : t.who === "You"
            ? "pt-turn pt-turn-you"
            : "pt-turn"
      }
    >
      <div className="pt-turn-gutter">
        <div className="pt-turn-who">{t.who}</div>
        <div className="pt-mono pt-muted">{t.at}</div>
      </div>
      <div className="pt-turn-body">
        <div className="pt-turn-chips">
          {cmds.length > 0 && (
            <span className="pt-chip">
              {cmds.length} commands
              {failed(cmds) ? ` · ${failed(cmds)} failed` : ""}
            </span>
          )}
          {files && (
            <a className="pt-chip" href="#changes">
              ± {(files as { count: number }).count} files
            </a>
          )}
          {del && <span className="pt-chip">{del.harness} · delegated</span>}
        </div>
        {body.map((e) =>
          e.kind === "tools" ? (
            <ToolGroup key={e.id} cmds={e.cmds} />
          ) : e.kind === "files" ? null : e.kind === "operator" ? (
            <div key={e.id}>
              <div className="pt-meta">{e.label}</div>
              {e.text}
            </div>
          ) : e.kind === "agent" ? (
            <Md key={e.id} text={e.text} />
          ) : (
            <ThreadEntry key={e.id} e={e} answers={answers} />
          ),
        )}
      </div>
    </section>
  );
}
function VariantB({ answers }: { answers: Answers }) {
  const open = openRequests(answers);
  const [details, setDetails] = useState(false);
  return (
    <Shell>
      <div className="pt-b">
        <TaskHeader tabs={false} />
        <div className="pt-b-cols">
          <aside className="pt-b-rail">
            <h3 className="pt-label">Waiting on you · {open.length}</h3>
            {open.map((id) => (
              <RequestCard key={id} id={id} answers={answers} />
            ))}
            {!open.length && <p className="pt-muted">Nothing waiting.</p>}
            <button
              type="button"
              className="pt-btn"
              onClick={() => setDetails(!details)}
            >
              {details ? "Hide" : "Show"} brief, evidence and assignments
            </button>
            {details && <Inspector />}
          </aside>
          <div className="pt-b-log">
            {toTurns(timeline).map((t, i) => (
              <TurnBlock key={i} t={t} answers={answers} />
            ))}
            <Composer />
          </div>
        </div>
      </div>
    </Shell>
  );
}

// ---------- Variant C: compact timeline + reading pane ----------
function flat(entries: Entry[], depth = 0): { e: Entry; depth: number }[] {
  return entries.flatMap((e) =>
    e.kind === "delegate"
      ? [{ e, depth }, ...flat(e.entries, depth + 1)]
      : [{ e, depth }],
  );
}
function line(e: Entry): [string, string] {
  switch (e.kind) {
    case "operator":
      return ["You", e.text];
    case "agent":
      return [e.who, e.text.replace(/[`*#\n]/g, " ")];
    case "tools":
      return [
        "tools",
        `Ran ${e.cmds.length} commands${failed(e.cmds) ? ` · ${failed(e.cmds)} failed` : ""}`,
      ];
    case "files":
      return ["files", `Changed ${e.count} files`];
    case "gap":
      return ["gap", e.text];
    case "question":
    case "approval":
      return [e.reqId, requests[e.reqId as ReqId].title];
    case "result":
      return ["result", e.summary];
    case "delegate":
      return [e.profile, `Delegated ${e.assignment}: ${e.brief}`];
  }
}
function VariantC({ answers }: { answers: Answers }) {
  const rows = flat(timeline);
  const [sel, setSel] = useState(rows.length - 1);
  const cur = rows[sel]!.e;
  const open = openRequests(answers);
  return (
    <Shell>
      <div className="pt-c">
        <TaskHeader />
        {open.length > 0 && (
          <div className="pt-c-banner">
            <span className="pt-badge pt-badge-attn">Next: you</span>
            {open.map((id) => (
              <button
                type="button"
                key={id}
                className="pt-link"
                onClick={() =>
                  setSel(
                    rows.findIndex((r) => "reqId" in r.e && r.e.reqId === id),
                  )
                }
              >
                {requests[id].title}
              </button>
            ))}
          </div>
        )}
        <div className="pt-c-cols">
          <ol className="pt-c-list">
            {rows.map(({ e, depth }, i) => {
              const [who, text] = line(e);
              const attn =
                (e.kind === "question" || e.kind === "approval") &&
                !answers[e.reqId as ReqId];
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    className={i === sel ? "pt-c-row pt-c-on" : "pt-c-row"}
                    style={{ paddingLeft: 12 + depth * 18 }}
                    onClick={() => setSel(i)}
                  >
                    <span className="pt-mono pt-muted">{e.at}</span>
                    <span
                      className={
                        attn
                          ? "pt-c-who pt-attn"
                          : e.kind === "gap"
                            ? "pt-c-who pt-muted"
                            : "pt-c-who"
                      }
                    >
                      {who}
                    </span>
                    <span className="pt-c-text">{text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="pt-c-read">
            <div className="pt-c-pane">
              {cur.kind === "delegate" ? (
                <>
                  <h3>
                    {cur.profile} · {cur.assignment}
                  </h3>
                  <p>{cur.brief}</p>
                </>
              ) : cur.kind === "tools" ? (
                <ToolGroup cmds={cur.cmds} open />
              ) : (
                <ThreadEntry e={cur} answers={answers} />
              )}
            </div>
            <Composer />
          </div>
        </div>
      </div>
    </Shell>
  );
}

// ---------- switcher ----------
const variants = {
  A: ["Thread column", VariantA],
  B: ["Attention rail + turns", VariantB],
  C: ["Timeline + reading pane", VariantC],
} as const;
type Key = keyof typeof variants;
const keys = Object.keys(variants) as Key[];
function App() {
  const answers = useAnswers();
  const [v, setV] = useState<Key>(
    () => (new URLSearchParams(location.search).get("variant") as Key) || "A",
  );
  const go = (d: number) => {
    const next = keys[(keys.indexOf(v) + d + keys.length) % keys.length]!;
    const u = new URL(location.href);
    u.searchParams.set("variant", next);
    history.replaceState(null, "", u);
    setV(next);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest("input, textarea, [contenteditable]")
      )
        return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  });
  const [name, View] = variants[v] ?? variants.A;
  return (
    <>
      <View answers={answers} />
      <div className="pt-switcher">
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Previous variant"
        >
          ←
        </button>
        <span>
          {v} ({name})
        </span>
        <button type="button" onClick={() => go(1)} aria-label="Next variant">
          →
        </button>
        <span className="pt-switch-state">
          open: {openRequests(answers).join(", ") || "none"}
        </span>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
