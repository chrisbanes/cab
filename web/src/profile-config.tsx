import { useCallback, useEffect } from "react";
import { CircleCheck } from "lucide-react";
import {
  profileConfigurationSchema,
  profilePrivateValuesSchema,
} from "../../src/operator/contracts.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { useOperatorResource } from "./resource.js";
import {
  privateField,
  profileChanges,
  runtimeChanged,
  type Values,
} from "./settings-changes.js";
import {
  harnessNote,
  runtimeCommand,
  runtimeErrors,
  runtimeValues,
  supportedEfforts,
  supportedModels,
} from "./execution-runtime.js";
import { Alert } from "./ui/alert.js";
import { PolicyDisclosure } from "./execution-notice.js";
import { executionHarnessLabels } from "../../src/operator/contracts.js";
import {
  Aside,
  ChangeList,
  DraftCheck,
  DraftField,
  DraftOutcome,
  Panel,
  PrivateTextField,
  key,
  locked,
  reloadDraft,
  revealedText,
  submitDraft,
  useDraft,
  useHeaderRefresh,
  useLoadedDraft,
  editable,
  textHold,
  usePrivateValues,
  type SettingsProps,
} from "./settings.js";
import type { ConfigurationDraft } from "./settings-state.js";

/** New profiles start on the first enabled runtime (Codex, then Claude), else Codex. */
export const defaultHarness = (workspace: SettingsProps["workspace"]) =>
  (["codex", "claude"] as const).find((harness) =>
    workspace?.data.harnesses.some((h) => h.harness === harness && h.enabled),
  ) ?? "codex";

export const emptyProfile = (workspace?: SettingsProps["workspace"]) => ({
  name: "",
  summary: "",
  instructions: "",
  capabilities: "",
  ...runtimeValues({ harness: "codex" }),
  runtimeHarness: defaultHarness(workspace ?? null),
  profileId: key(),
  key: key(),
});

export const claudeSettings = (workspace: SettingsProps["workspace"]) =>
  workspace?.data.harnesses.find((h) => h.harness === "claude")?.settings;

/** The one `profile.create` command, shared by the Settings form and guided setup. */
export const profileCreateCommand = (v: Values) => ({
  type: "profile.create",
  key: v.key,
  profileId: v.profileId,
  name: v.name,
  summary: v.summary,
  instructions: v.instructions,
  capabilities: v.capabilities,
  runtime: runtimeCommand(v),
});

const runtimeChangeNote =
  "A runtime change saves a new profile revision and affects new conversations only; existing conversations keep their runtime.";

/** The selected harness's effective execution policy, as an Aside. */
function PolicyAside({
  draft,
  workspace,
}: {
  draft: ConfigurationDraft;
  workspace: SettingsProps["workspace"];
}) {
  const harness = draft.values.runtimeHarness === "claude" ? "claude" : "codex";
  return (
    <aside className="settings-aside" aria-label="Execution policy">
      <h2 className="small-heading">
        Execution policy · {executionHarnessLabels[harness]}
      </h2>
      <PolicyDisclosure harness={harness} workspace={workspace} />
    </aside>
  );
}

/** Supported values plus a stored value that is no longer supported, so it stays visible. */
function SettingOptions({
  values,
  current,
}: {
  values: string[];
  current: unknown;
}) {
  const stored = String(current ?? "");
  return (
    <>
      <option value="">Default</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
      {stored && !values.includes(stored) && (
        <option value={stored}>{stored} (not supported)</option>
      )}
    </>
  );
}

/** Runtime selector, plus model and effort for Claude (blank uses the harness default). */
export function RuntimeFields({
  draft,
  workspace,
}: {
  draft: ConfigurationDraft;
  workspace: SettingsProps["workspace"];
}) {
  const harness = draft.values.runtimeHarness,
    status = workspace?.data.harnesses.find((h) => h.harness === harness),
    note = harnessNote(status),
    supported = status?.settings;
  return (
    <>
      <DraftField draft={draft} field="runtimeHarness" label="Runtime">
        <option value="codex">{executionHarnessLabels.codex}</option>
        <option value="claude">{executionHarnessLabels.claude}</option>
      </DraftField>
      {harness === "claude" && (
        <>
          <DraftField
            draft={draft}
            field="runtimeModel"
            errorField="runtime.model"
            label="Model"
          >
            {supported && (
              <SettingOptions
                values={supportedModels(supported)}
                current={draft.values.runtimeModel}
              />
            )}
          </DraftField>
          <DraftField
            draft={draft}
            field="runtimeEffort"
            errorField="runtime.reasoningEffort"
            label="Reasoning effort"
          >
            {supported && (
              <SettingOptions
                values={supportedEfforts(supported, draft.values)}
                current={draft.values.runtimeEffort}
              />
            )}
          </DraftField>
          <p className="metadata muted">
            Leave model or effort blank to use the Claude default.
          </p>
        </>
      )}
      {note && <Alert>{note}</Alert>}
    </>
  );
}

export function ProfileCreate(p: SettingsProps) {
  const d = useDraft(p.drafts, "profile.create");
  const harness = defaultHarness(p.workspace);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-initialise only when the default runtime changes; dirty input is never replaced.
  useEffect(() => d.initialize(emptyProfile(p.workspace)), [d, harness]);
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
                profileCreateCommand(d.values),
                p.refresh,
                runtimeErrors(d.values, claudeSettings(p.workspace)),
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
            <RuntimeFields draft={d} workspace={p.workspace} />
            <p className="metadata muted">
              The summary appears in Settings and routing. Capabilities describe
              suitability for routing and leads; neither is a permission grant.
            </p>
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Create profile"
              refresh={p.refresh}
            />
            <div className="settings-actions">
              {d.phase === "recorded" ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => d.startOperation(emptyProfile(p.workspace))}
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
        <div className="settings-column">
          <Aside
            title="Profile boundary"
            items={[
              "Saving creates revision 1. Existing assignments are unaffected.",
              "Capabilities guide suitability; project guidance still applies.",
              "Repository access stays project-owned.",
              runtimeChangeNote,
            ]}
          />
          <PolicyAside draft={d} workspace={p.workspace} />
        </div>
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
        revoked: data.profile.revoked,
        ...runtimeValues(data.runtime),
        expectedVersion: String(data.profile.version),
      }
    : null;
  useLoadedDraft(d, initial, resource.state.fetchedAt);
  const priv = usePrivateValues(
    p.client,
    p.session,
    `/api/operator/profiles/${profileId}/private-values`,
    profilePrivateValuesSchema,
    {
      loaded: data?.profile.version,
      version: (r) => r.data.profile.version,
      edit: typeof d.values.instructions === "string" && editable(d.phase),
      refreshLoaded: resource.refresh,
    },
  );
  const revealed = data
    ? revealedText(
        priv.state,
        (r) => ({
          version: r.data.profile.version,
          text: r.data.profile.instructions,
        }),
        data.profile.version,
      )
    : undefined;
  const lines = data ? profileChanges(data, d.values, revealed) : [];
  const holdSave =
    typeof d.values.instructions === "string" && revealed === undefined;
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
      ...privateField("instructions", v.instructions, revealed),
      ...(Boolean(v.revoked) !== data.profile.revoked
        ? { revoked: Boolean(v.revoked) }
        : {}),
      ...(runtimeChanged(data.runtime, v)
        ? { runtime: runtimeCommand(v) }
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
            <StatusBadge
              tone={data.profile.revoked ? "warning" : "idle"}
              icon={data.profile.revoked ? undefined : CircleCheck}
            >
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
                description="Name, summary, capabilities and instructions are edited in place. Instructions stay kept until you reveal them."
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
                      // An unchanged stored runtime is never re-validated.
                      runtimeChanged(data.runtime, d.values)
                        ? runtimeErrors(d.values, claudeSettings(p.workspace))
                        : {},
                      holdSave,
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
                  <PrivateTextField
                    draft={d}
                    field="instructions"
                    label="Instructions"
                    noun="instructions"
                    revealed={revealed}
                    state={priv.state}
                    onReveal={priv.reveal}
                  >
                    <p className="metadata muted">
                      Private to this signed-in session; revealing is not
                      recorded. Emptying the field clears the instructions.
                    </p>
                  </PrivateTextField>
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
                  <RuntimeFields draft={d} workspace={p.workspace} />
                  <ChangeList lines={lines} />
                  <DraftOutcome
                    draft={d}
                    client={p.client}
                    session={p.session}
                    label="Save profile"
                    saveDisabled={lines.length === 0}
                    hold={holdSave ? textHold : undefined}
                    discard={() => initial && reloadDraft(d, initial)}
                    refresh={() => {
                      p.refresh();
                      resource.refresh();
                    }}
                    review={() =>
                      initial && d.adoptLatest(data.profile.version, initial)
                    }
                  />
                </form>
              </Panel>
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
              <Aside title="Runtime change" items={[runtimeChangeNote]} />
              <PolicyAside draft={d} workspace={p.workspace} />
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
