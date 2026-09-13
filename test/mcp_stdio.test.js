import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("stdio MCP server advertises ml-regl tools and resources", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src/server.js")],
    cwd: root,
    env: { ...process.env, ML_REGL_MCP_PORT: "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "ml-regl-mcp-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("ml_regl_list_games"));
    assert.ok(names.includes("ml_regl_step"));
    assert.ok(names.includes("ml_regl_screenshot"));
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "ml-regl://games"));
  } finally {
    await client.close();
  }
});
