import { projectPrivateValuesSchema } from "../../src/operator/contracts.js";
import type { projectChoices } from "./readiness-discovery.js";
import { useReadinessDiscovery } from "./readiness-picker.js";
import type { SourcePrivate } from "./settings-changes.js";
import type { TabProps } from "./project-config.js";
import { usePrivateValues } from "./settings.js";
import {
  type SourceNaming,
  sourceHeading,
  sourceName,
} from "./settings-view.js";
import type { z } from "zod";
import type { sourceObservationSchema } from "../../src/operator/contracts.js";
import { selectionCountsText } from "../../src/operator/readiness-text.js";
import type { OutcomeField } from "./action-feedback.js";
import { clockLabel } from "./presentation.js";

type Project = z.infer<
  typeof sourceObservationSchema
>["data"]["projects"][number];

type Selection = TabProps["data"]["source"]["selections"][number];

/** Whether the saved source list names a GitHub Project, whose title discovery supplies. */
export const hasProjectSource = (source: TabProps["data"]["source"]) =>
  source.selections.some((s) => s.kind === "project");

/**
 * What a saved source is called. A search's name is its saved query, so it is only ever
 * `known` (the session-only private read at the loaded version); a Project's title is the one
 * discovery lists for it, if any.
 */
export function savedSourceName(
  s: Selection,
  known: SourcePrivate | undefined,
  choices: ReturnType<typeof projectChoices>,
): SourceNaming {
  return sourceName(s, {
    query: known?.searches.find((x) => x.id === s.id)?.query,
    projectTitle:
      choices.state === "ready"
        ? choices.projects.find((x) => x.projectNodeId === s.descriptor)?.label
        : undefined,
  });
}

/** A source name; text that came from the private read is marked so evidence masks it. */
export function SourceNameText({ naming }: { naming: SourceNaming }) {
  return <span data-private={naming.private || undefined}>{naming.name}</span>;
}

/** The names of this project's saved sources, for a tab that has no form of its own. */
export function useSavedSourceNames(p: TabProps) {
  const { data, projectId } = p;
  const priv = usePrivateValues(
    p.client,
    p.session,
    `/api/operator/projects/${projectId}/private-values`,
    projectPrivateValuesSchema,
    {
      autoLoad: true,
      loaded: data.source.version,
      version: (r) => r.data.source.version,
      refreshLoaded: p.refreshConfiguration,
    },
  );
  const privateData = priv.state.data?.data.source;
  const known =
    privateData?.version === data.source.version ? privateData : undefined;
  const discovery = useReadinessDiscovery({
    client: p.client,
    csrfToken: p.session.csrfToken,
    enabled: hasProjectSource(data.source),
    saved: data.source.repositories.map((r) => ({
      repositoryId: r.repositoryId ?? "",
    })),
    projectIds: [],
  });
  return (s: Selection) => savedSourceName(s, known, discovery.choices);
}

/** A row heading: the name (marked private when it is a saved query), then the kind. */
export function SourceHeading({ naming }: { naming: SourceNaming }) {
  return (
    <>
      <SourceNameText naming={naming} />
      {sourceHeading(naming).slice(naming.name.length)}
    </>
  );
}

/** The Details of a source row: its id and kind, then what its last read observed. */
export function sourceDetails(
  source: { id: string | null; kind: string; descriptor: string | null },
  naming: SourceNaming,
  read: Project["selections"][number] | undefined,
  rule: Project["readiness"] | undefined,
): OutcomeField[] {
  const attempt = read?.lastAttemptAt ? Date.parse(read.lastAttemptAt) : NaN;
  return [
    ...(source.id ? [["Source ID", source.id] as const] : []),
    ...(naming.kind ? [["Kind", naming.kind] as const] : []),
    ...(source.kind === "project" && source.descriptor
      ? [["Project", source.descriptor] as const]
      : []),
    ...(Number.isFinite(attempt)
      ? [["Newest attempt", clockLabel(attempt)] as const]
      : []),
    ...(read?.counts && rule
      ? [["Counts", selectionCountsText(read.counts, rule)] as const]
      : []),
  ];
}
