import { useCallback, useEffect } from "react";
import { profileConfigurationSchema } from "../../src/operator/contracts.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { useOperatorResource } from "./resource.js";
import { profileChanges, type Values } from "./settings-changes.js";
import {
  Aside,
  ChangeList,
  DraftCheck,
  DraftField,
  DraftOutcome,
  Panel,
  SavedNotice,
  key,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  useHeaderRefresh,
  useLoadedDraft,
  type SettingsProps,
} from "./settings.js";

const emptyProfile = () => ({
  name: "",
  summary: "",
  instructions: "",
  capabilities: "",
  profileId: key(),
  key: key(),
});

export function ProfileCreate(p: SettingsProps) {
  const d = useDraft(p.drafts, "profile.create");
  useEffect(() => d.initialize(emptyProfile()), [d]);
  return (
    <div className="settings-page">
      <p className="introduction muted">
        Profiles are reusable descriptions that leads and routing can select. A
        profile grants no repository access.
      </p>
      <div className="settings-split">
        <Panel
          title="New profile"
          description="New assignments use the current revision."
        >
          <form
            onSubmit={(e) =>
              void submitDraft(
                e,
                d,
                p.client,
                p.session,
                {
                  type: "profile.create",
                  key: d.values.key,
                  profileId: d.values.profileId,
                  name: d.values.name,
                  summary: d.values.summary,
                  instructions: d.values.instructions,
                  capabilities: d.values.capabilities,
                },
                p.refresh,
              )
            }
          >
            <DraftField draft={d} field="name" label="Profile name" />
            <DraftField draft={d} field="summary" label="Summary" />
            <DraftField
              draft={d}
              field="instructions"
              label="Instructions"
              multiline
            />
            <DraftField
              draft={d}
              field="capabilities"
              label="Capabilities"
              multiline
            />
            <p className="metadata muted">
              The summary appears in Settings and routing. Capabilities describe
              suitability for routing and leads; neither is a permission grant.
            </p>
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Create profile"
            />
            <div className="settings-actions">
              {d.phase === "recorded" ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => d.startOperation(emptyProfile())}
                >
                  Create another profile
                </Button>
              ) : (
                <ActionLink variant="secondary" href="/app/settings">
                  Cancel
                </ActionLink>
              )}
            </div>
          </form>
        </Panel>
        <Aside
          title="Profile boundary"
          items={[
            "Saving creates revision 1. Existing assignments are unaffected.",
            "Capabilities guide suitability; project guidance still applies.",
            "Repository access stays project-owned.",
          ]}
        />
      </div>
    </div>
  );
}

export function ProfileConfiguration(p: SettingsProps & { profileId: string }) {
  const { profileId } = p,
    draftKey = `profile.configure:${profileId}`,
    d = useDraft(p.drafts, draftKey);
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(
        `/api/operator/profiles/${profileId}/configuration`,
        profileConfigurationSchema,
        signal,
      ),
    [p.client, profileId],
  );
  const resource = useOperatorResource(
      `${p.session.csrfToken}:${profileId}`,
      loader,
    ),
    data = resource.state.data?.data;
  useHeaderRefresh(p.refreshNonce, resource.refresh);
  const initial: Values | null = data
    ? {
        name: data.profile.name ?? "",
        summary: data.profile.summary ?? "",
        capabilities: data.capabilities ?? "",
        replaceCapabilities: false,
        replaceInstructions: false,
        instructions: "",
        revoked: data.profile.revoked,
        expectedVersion: String(data.profile.version),
      }
    : null;
  useLoadedDraft(d, initial, resource.state.fetchedAt);
  const lines = data ? profileChanges(data, d.values) : [];
  const name = data?.profile.name ?? "this profile";
  const command = () => {
    if (!data) return {};
    const v = d.values;
    return {
      type: "profile.configure",
      key: v.key,
      profileId,
      expectedVersion: Number(v.expectedVersion),
      ...(v.name !== (data.profile.name ?? "") ? { name: v.name } : {}),
      ...(v.summary !== (data.profile.summary ?? "")
        ? { summary: v.summary }
        : {}),
      ...((
        data.capabilities === null
          ? v.replaceCapabilities
          : v.capabilities !== data.capabilities
      )
        ? { capabilities: v.capabilities }
        : {}),
      ...(v.replaceInstructions ? { instructions: v.instructions } : {}),
      ...(Boolean(v.revoked) !== data.profile.revoked
        ? { revoked: Boolean(v.revoked) }
        : {}),
    };
  };
  const revoked = Boolean(d.values.revoked);
  const toggleLabel = data
    ? data.profile.revoked
      ? revoked
        ? "Restore profile"
        : "Undo restore"
      : revoked
        ? "Undo revoke"
        : "Revoke profile"
    : "";
  return (
    <div className="settings-page">
      <ResourceStatus
        label="Profile configuration"
        state={resource.state}
        retry={resource.refresh}
      />
      {data && (
        <>
          <p className="settings-status body muted">
            <StatusBadge tone={data.profile.revoked ? "warning" : "neutral"}>
              {data.profile.revoked ? "Revoked" : "Available"}
            </StatusBadge>{" "}
            Current revision {data.profile.version}.{" "}
            {data.profile.revoked
              ? "Revoked: subsequent actions are denied."
              : "Available for permitted selection."}{" "}
            Existing assignments keep their captured profile revision until
            explicit Apply.
          </p>
          <div className="settings-split">
            <div className="settings-column">
              <Panel
                title="Profile"
                description="Instructions are private; replace them to change them. Name, summary and capabilities are edited in place."
              >
                <form
                  onSubmit={(e) =>
                    void submitDraft(
                      e,
                      d,
                      p.client,
                      p.session,
                      command(),
                      () => {
                        p.refresh();
                        resource.refresh();
                      },
                    )
                  }
                >
                  <DraftField draft={d} field="name" label="Profile name" />
                  <DraftField draft={d} field="summary" label="Summary" />
                  <div>
                    <Button
                      type="button"
                      variant={
                        toggleLabel === "Revoke profile"
                          ? "destructive"
                          : "secondary"
                      }
                      disabled={locked(d)}
                      onClick={() => d.set("revoked", !revoked)}
                    >
                      {toggleLabel}
                    </Button>
                    <p className="metadata muted">
                      {data.profile.revoked
                        ? `Restoring makes ${name} selectable again for new assignments. It does not replay actions that were denied while revoked.`
                        : `Revoking stops routing and leads from selecting ${name}. It does not stop, cancel or recover running work.`}
                    </p>
                  </div>
                  <DraftCheck
                    draft={d}
                    field="replaceInstructions"
                    label="Replace instructions"
                  />
                  <p className="metadata muted">
                    Current instructions are private and never loaded into this
                    form.
                  </p>
                  {d.values.replaceInstructions && (
                    <DraftField
                      draft={d}
                      field="instructions"
                      label="New instructions"
                      multiline
                    />
                  )}
                  {data.capabilities === null && (
                    <DraftCheck
                      draft={d}
                      field="replaceCapabilities"
                      label="Replace capabilities"
                    />
                  )}
                  {(data.capabilities !== null ||
                    d.values.replaceCapabilities) && (
                    <DraftField
                      draft={d}
                      field="capabilities"
                      label="Capabilities"
                      multiline
                    />
                  )}
                  <ChangeList lines={lines} />
                  <DraftOutcome
                    draft={d}
                    client={p.client}
                    session={p.session}
                    label="Save profile"
                    saveDisabled={lines.length === 0}
                    discard={() => initial && reloadDraft(d, initial)}
                    onRecorded={() => {
                      p.refresh();
                      resource.refresh();
                    }}
                  />
                  {d.phase === "conflict" && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => d.adoptVersion(data.profile.version)}
                    >
                      Review latest profile revision
                    </Button>
                  )}
                </form>
              </Panel>
              <SavedNotice
                saved={p.drafts.saved(draftKey)}
                label={`Saved ${data.profile.name ?? "profile"}`}
              />
            </div>
            <div className="settings-column">
              <Aside
                title="Effect of revocation"
                items={[
                  `Routing and leads cannot select ${name} for new assignments.`,
                  "Permission revocation applies to subsequent actions regardless of captured snapshots.",
                  "Revoking does not stop, cancel or recover running work.",
                ]}
              />
              <Aside
                title="Related"
                items={[
                  <a key="advanced" href={`/profile/${profileId}`}>
                    Open advanced profile editor
                  </a>,
                ]}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
