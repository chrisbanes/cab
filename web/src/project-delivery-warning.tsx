import { useCallback } from "react";
import { projectConfigurationSchema } from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { useOperatorResource } from "./resource.js";
import { useHeaderRefresh } from "./settings.js";
import { Alert } from "./ui/alert.js";
import { repositoryLabel } from "./presentation.js";
import {
  repositoryCredentialState,
  repositoryDeliveryNeeds,
} from "./delivery-presentation.js";
import { ResourceStatus } from "./components.js";

/** The project uses the same fresh configuration and guidance as its Delivery editor. */
export function ProjectDeliveryWarning({
  client,
  projectId,
  scope,
  refreshNonce,
}: {
  client: OperatorClient;
  projectId: string;
  scope: string;
  refreshNonce: number;
}) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/projects/${projectId}/configuration`,
        projectConfigurationSchema,
        signal,
      ),
    [client, projectId],
  );
  const resource = useOperatorResource(
    `${scope}:${projectId}:delivery-warning`,
    loader,
  );
  useHeaderRefresh(refreshNonce, () => {
    void resource.refresh();
  });
  const data = resource.state.data?.data;
  const delivery = data?.delivery;
  if (resource.state.status !== "fresh")
    return (
      <ResourceStatus
        state={resource.state}
        retry={resource.refresh}
        label="Delivery readiness"
      />
    );
  if (!data?.project.leadProfileId) return null;
  if (!delivery)
    return (
      <Alert role="alert">
        Delivery readiness is unavailable.{" "}
        <a href={`/projects/${projectId}/settings?tab=delivery`}>
          Check Delivery settings
        </a>
        .
      </Alert>
    );
  const links = data.repositories.links;
  const repositories = links.map((link) => {
    const read = delivery.repositories?.find(
      (r) => r.repositoryId === link.repositoryId,
    );
    return {
      key: link.repositoryId ?? JSON.stringify(link.savedRow),
      label: link.repositoryId
        ? repositoryLabel(link.repositoryId, links)
        : "Unavailable repository",
      needs: link.repositoryId
        ? repositoryDeliveryNeeds(
            delivery,
            link.repositoryId,
            link.codeHost,
            repositoryCredentialState(delivery, link.codeHost, read),
            read,
          ).filter((n) => !n.met)
        : [
            {
              text: "Repository details are unavailable. Check the repository link and Refresh.",
            },
          ],
    };
  });
  const unusable = repositories.filter((r) => r.needs.length);
  if (repositories.length && !unusable.length) return null;
  return (
    <Alert role="alert">
      <p>
        {unusable.length === repositories.length
          ? "The delivery agent has no confirmed usable repository."
          : "The delivery agent cannot deliver through some linked repositories."}
      </p>
      {!repositories.length && (
        <p>Link a repository and apply Open PRs in Delivery settings.</p>
      )}
      <ul>
        {unusable.map((r) => (
          <li key={r.key}>
            {r.label}: {r.needs.map((n) => n.text).join(" ")}
          </li>
        ))}
      </ul>
      <a href={`/projects/${projectId}/settings?tab=delivery`}>
        Fix delivery setup
      </a>
    </Alert>
  );
}
