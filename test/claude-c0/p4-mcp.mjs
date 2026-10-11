import {
  attempt,
  authGate,
  baseOptions,
  createRecorder,
  facet,
  loadSdk,
  runQuery,
  toolCalls,
  transcript,
  writeResult,
} from "./harness.mjs";

export const facetIds = ["F4.1", "F4.2", "F4.3", "F4.4"];
export const MCP_TOOLS = [
  "mcp__ensemble__ensemble_echo",
  "mcp__ensemble__ensemble_nested",
  "mcp__ensemble__ensemble_error",
  "mcp__ensemble__ensemble_throw",
];

export const newCalls = () => ({ echo: [], nested: [], error: 0, throw: 0 });

/** A fresh fixture `ensemble` server; `calls` counts handler invocations by tool. */
export function fixtureServer({ sdk, z }, calls = newCalls()) {
  const text = (value) => ({ content: [{ type: "text", text: value }] });
  const server = sdk.createSdkMcpServer({
    name: "ensemble",
    version: "0.0.1",
    tools: [
      sdk.tool(
        "ensemble_echo",
        "Echo a text and an integer count.",
        { text: z.string(), count: z.number().int() },
        async (args) => {
          calls.echo.push(args);
          return text(`echo:${args.text}:${args.count}`);
        },
      ),
      sdk.tool(
        "ensemble_nested",
        "Record structured questions.",
        {
          questions: z.array(
            z.object({
              id: z.string(),
              question: z.string(),
              kind: z.enum(["single", "multi"]).optional(),
            }),
          ),
        },
        async (args) => {
          calls.nested.push(args);
          return text(`recorded:${args.questions.length}`);
        },
      ),
      sdk.tool("ensemble_error", "Always reports an error.", {}, async () => {
        calls.error++;
        return { ...text("fixture error result"), isError: true };
      }),
      sdk.tool("ensemble_throw", "Always throws.", {}, async () => {
        calls.throw++;
        throw new Error("fixture handler threw");
      }),
    ],
  });
  return { server, calls };
}

const validEcho = (args) =>
  typeof args?.text === "string" && Number.isInteger(args?.count);

export async function run({ root, token }) {
  const loaded = await loadSdk(root);
  const { sdk, Client, InMemoryTransport } = loaded;
  const recorder = createRecorder(root, "p4", token);
  const gate = authGate(root, token);
  const identities = [];
  const calls = newCalls();
  const status = {};
  const query = async (label, prompt, allowedTools, modelBacked = true) => {
    const result = await runQuery({
      sdk,
      root,
      recorder,
      label,
      prompt,
      options: baseOptions(root, modelBacked ? token : null, {
        mcpServers: { ensemble: fixtureServer(loaded, calls).server },
        allowedTools,
      }),
      modelBacked,
      onMessage: async (message, { q }) => {
        if (
          message.type !== "system" ||
          message.subtype !== "init" ||
          status[label]
        )
          return;
        try {
          status[label] = (await q.mcpServerStatus()).map((item) => ({
            name: item.name,
            status: item.status,
            source: item.source,
            tools: item.tools?.map((entry) => entry.name),
          }));
        } catch (error) {
          status[label] = {
            error: String(error?.message ?? error).slice(0, 200),
          };
        }
      },
    });
    identities.push(
      ...result.procs.map((proc) => proc.identity).filter(Boolean),
    );
    return result;
  };

  // Advertised schema, read from a second instance of the same definitions.
  const listing = fixtureServer(loaded);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await listing.server.instance.connect(serverSide);
  const client = new Client({ name: "c0-probe", version: "0.0.1" });
  await client.connect(clientSide);
  const advertised = (await client.listTools()).tools;
  await client.close();

  const modelFree = await query(
    "p4-model-free",
    "Reply with exactly: OK",
    MCP_TOOLS,
    false,
  );
  const init = modelFree.init;

  let wildcard = null;
  const f41 = await attempt(
    "F4.1",
    true,
    init ? null : "no init message observed",
    async () => {
      if (!gate)
        wildcard = await query(
          "p4-wildcard",
          'Call the ensemble_echo tool with text "wild" and count 7, then reply with its output.',
          ["mcp__ensemble__*"],
        );
      const listed = init.tools.filter((name) => name.startsWith("mcp__"));
      const observation = {
        initTools: listed,
        initServers: init.mcp_servers,
        mcpServerStatus: status["p4-model-free"],
        wildcardAllowedToolsWorked: wildcard
          ? calls.echo.some((args) => args.text === "wild")
          : "untested: needs the token",
        wildcardDenials: wildcard?.result?.permission_denials?.map(
          (item) => item.tool_name,
        ),
      };
      const ok =
        MCP_TOOLS.every((name) => listed.includes(name)) &&
        init.mcp_servers.some(
          (server) =>
            server.name === "ensemble" && server.status === "connected",
        );
      return facet("F4.1", true, ok ? "passed" : "failed", observation);
    },
  );

  const f42 = await attempt("F4.2", true, gate, async () => {
    const before = calls.echo.length;
    const invalid = await query(
      "p4-invalid",
      "This is a validation test. Make exactly these two calls even though they are invalid, without fixing them: " +
        'first call ensemble_echo with arguments {"text": "a", "count": "not-a-number"}; ' +
        'then call ensemble_echo with arguments {"count": 3} (omit text). ' +
        "Then reply with the exact error messages you received.",
      MCP_TOOLS,
    );
    const echoCalls = toolCalls(invalid.messages).filter(
      (call) => call.name === MCP_TOOLS[0],
    );
    const sentInvalid = echoCalls.filter((call) => !validEcho(call.input));
    const handled = calls.echo.slice(before);
    const observation = {
      sentInputs: echoCalls.map((call) => call.input),
      results: echoCalls.map((call) => call.result),
      handlerInvocations: handled.length,
      handlerSawInvalid: handled.filter((args) => !validEcho(args)).length,
    };
    if (sentInvalid.length === 0)
      return facet(
        "F4.2",
        true,
        "untested",
        observation,
        "the model never sent an invalid argument",
      );
    const ok =
      observation.handlerSawInvalid === 0 &&
      sentInvalid.every(
        (call) => call.result?.isError && call.result.text.length > 0,
      );
    return facet("F4.2", true, ok ? "passed" : "failed", observation);
  });

  let shapes = null;
  const f43 = await attempt("F4.3", false, gate, async () => {
    shapes = await query(
      "p4-shapes",
      'Call ensemble_echo with {"text": "ok", "count": 1}, then ensemble_error with {}, then ensemble_throw with {}, ' +
        'then ensemble_nested with {"questions": [{"id": "q1", "question": "Pick one", "kind": "single"}, ' +
        '{"id": "q2", "question": "Pick many", "kind": "multi"}]}. Then reply DONE.',
      MCP_TOOLS,
    );
    const shapeCalls = toolCalls(shapes.messages);
    const byName = (suffix) =>
      shapeCalls.find((call) => call.name.endsWith(suffix))?.result ?? null;
    const sessionId = shapes.init?.session_id;
    const observation = {
      success: byName("_echo"),
      isErrorResult: byName("_error"),
      thrownHandler: byName("_throw"),
      handlerCounts: { error: calls.error, throw: calls.throw },
      transcript: sessionId ? transcript(root, sessionId)?.records : null,
    };
    const seen =
      observation.success &&
      observation.isErrorResult &&
      observation.thrownHandler;
    return facet(
      "F4.3",
      false,
      seen ? "passed" : "untested",
      observation,
      seen ? undefined : "the model did not make all three calls",
    );
  });

  const nestedSchema = advertised.find(
    (item) => item.name === "ensemble_nested",
  )?.inputSchema;
  const f44 = await attempt("F4.4", false, gate, async () => {
    const received = calls.nested.at(-1);
    const sent = toolCalls(shapes?.messages ?? []).find((call) =>
      call.name.endsWith("_nested"),
    );
    const observation = {
      advertisedSchema: nestedSchema,
      sent: sent?.input,
      received,
    };
    if (!sent)
      return facet(
        "F4.4",
        false,
        "untested",
        observation,
        "the model did not call ensemble_nested",
      );
    const intact =
      received?.questions?.length === 2 &&
      JSON.stringify(received) === JSON.stringify(sent.input);
    return facet("F4.4", false, intact ? "passed" : "failed", observation);
  });

  const facets = [f41, f42, f43, f44];
  writeResult(root, "p4", facets, { identities });
  return facets;
}
