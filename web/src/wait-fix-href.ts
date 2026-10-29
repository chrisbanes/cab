import type { WaitFix } from "../../src/operator/wait-reasons.js";
import { addClaudeHref, settingsSectionHref } from "./settings-sections.js";

/** Where a wait's Fix opens: always the section that holds the fix, never bare Settings. */
export const waitFixHref = (
  fix: Exclude<WaitFix, { kind: "resume-project" }>,
) =>
  fix.kind === "choose-lead"
    ? `/app/projects/${fix.projectId}/settings`
    : fix.kind === "readiness"
      ? settingsSectionHref("readiness")
      : fix.kind === "add-claude"
        ? addClaudeHref
        : fix.kind === "open-repositories"
          ? `/app/projects/${fix.projectId}/settings?tab=repositories`
          : `/app/profiles/${fix.profileId}/settings`;
