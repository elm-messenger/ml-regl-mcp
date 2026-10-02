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
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: "ml-regl-mcp-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    // The listener is bound before initialize is answered, so its line is out.
    const port = stderr.match(/WebSocket listener ws:\/\/[^:]+:(\d+)/)?.[1];
    assert.ok(port, "listener port was not reported");
    const instructions = client.getInstructions();
    assert.ok(instructions.includes(`DECLGL_CONTROL_URL=ws://127.0.0.1:${port}`));
    assert.ok(instructions.includes(`#mcp=ws://127.0.0.1:${port}`));
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("ml_regl_list_games"));
    assert.ok(names.includes("ml_regl_step"));
    assert.ok(names.includes("ml_regl_screenshot"));
    assert.ok(names.includes("ml_regl_get_render_tree"));
    assert.ok(names.includes("ml_regl_query_render_tree"));
    assert.ok(names.includes("ml_regl_send_keys"));
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "ml-regl://games"));
  } finally {
    await client.close();
  }
});
