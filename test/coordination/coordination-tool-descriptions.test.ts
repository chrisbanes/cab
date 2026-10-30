import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinationTools } from "../../src/standalone/coordination-tools.js";

test("every coordination tool description fits the runtime's 1024-character limit", () => {
  for (const tool of coordinationTools)
    assert.ok(tool.description.length <= 1024, tool.name);
});
