import { readinessSchema } from "../operator/readiness.js";
import { type BrowseCommand, browseOutput } from "./browse.js";
import { oneLine, table } from "./render.js";

const STATUS = {
  pass: "Pass",
  fail: "Fail",
  "not-configured": "Not configured",
} as const;

/** The service's own readiness checks; exits 0 whenever the read succeeds. */
export const doctorCommand: BrowseCommand = {
  usage: "doctor",
  positionals: 0,
  capabilities: ["cli.identity", "diagnostics.read"],
  async run(ctx) {
    const client = await ctx.connect();
    const read = await client.get("/api/operator/readiness", readinessSchema);
    const { checks } = read.data;
    // A daemon host reads gh before anyone logs in; warn (stderr only) when its login
    // is in the keychain. Service modules load on demand, and a probe failure is ignored.
    try {
      const { daemonGhWarning } = await import("./service.js");
      const warning = await daemonGhWarning(
        ctx.deps.env,
        ctx.deps.uid ?? process.getuid?.(),
      );
      if (warning) ctx.deps.stderr.write(`${warning}\n`);
    } catch {
      // A warning only.
    }
    return browseOutput(ctx, {
      data: read.data,
      observedAt: read.observedAt,
      human: [
        table(
          ["Check", "Status", "Reason"],
          checks.map((c) => [
            c.label,
            STATUS[c.status],
            c.reason === null ? "" : oneLine(c.reason, 500),
          ]),
        ),
        ...checks
          .filter((c) => c.fix !== null)
          .map((c) => `Fix ${c.label}: ${c.fix}`),
      ].join("\n"),
    });
  },
};
