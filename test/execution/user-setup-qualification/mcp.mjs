// A harmless native-config MCP fixture; records calls only inside its owned workspace.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [marker, label] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: label, version: "1" },
    };
  else if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "native_mark",
          description: "Record the harmless native configuration proof.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    };
  else if (
    request.method === "tools/call" &&
    request.params.name === "native_mark"
  ) {
    appendFileSync(marker, `${label}\n`);
    result = { content: [{ type: "text", text: label }] };
  } else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported fixture request" } })}\n`,
    );
    continue;
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
  );
}
