import { projectPrivateValuesSchema } from "../../src/operator/contracts.js";
import type { projectChoices } from "./readiness-discovery.js";
import { useReadinessDiscovery } from "./readiness-picker.js";
import type { SourcePrivate } from "./settings-changes.js";
import type { TabProps } from "./project-config.js";
import { usePrivateValues } from "./settings.js";
import { type SourceNaming, sourceName } from "./settings-view.js";

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
