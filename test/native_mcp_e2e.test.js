import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

function waitForPort(stream) {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk) => {
      text += chunk.toString();
      const match = text.match(/WebSocket listener ws:\/\/[^:]+:(\d+)/);
      if (match) {
        stream.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

async function callTool(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined);
  const text = response.content.find((item) => item.type === "text")?.text;
  assert.ok(text, `${name} did not return text content`);
  return JSON.parse(text);
}

test("MCP tools drive the native ml-regl smoke game", { timeout: 30000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const serverPath = path.join(root, "src/server.js");
  const gamePath = path.join(root, "../ml-regl/_build/default/test/test_fps_smoke_desktop.exe");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: { ...process.env, ML_REGL_MCP_PORT: "0" },
    stderr: "pipe",
  });
  const portPromise = waitForPort(transport.stderr);
  const client = new Client({ name: "ml-regl-mcp-e2e-test", version: "0.1.0" });
  let game;
  const screenshot = path.join(os.tmpdir(), "ml-regl-mcp-e2e.bmp");
  await client.connect(transport);
  const port = await portPromise;
  try {
    game = spawn(gamePath, [], {
      cwd: path.join(root, "../ml-regl/test"),
      env: { ...process.env, DECLGL_DEBUG: "1", DECLGL_CONTROL_URL: `ws://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const deadline = Date.now() + 7000;
    let games = [];
    while (Date.now() < deadline) {
      games = await callTool(client, "ml_regl_list_games");
      if (games.length === 1 && games[0].protocol === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(games.length, 1, "native game did not connect to MCP");
    const gameId = games[0].id;
    assert.equal((await callTool(client, "ml_regl_pause", { gameId })).paused, true);
    assert.equal((await callTool(client, "ml_regl_step", { gameId, frames: 1, dtMs: 10 })).queued, 1);
    const tree = await callTool(client, "ml_regl_get_render_tree", { gameId });
    assert.equal(tree.available, true);
    await callTool(client, "ml_regl_send_input", { gameId, kind: "mouse_move", x: 20, y: 30 });
    const capture = await callTool(client, "ml_regl_screenshot", { gameId, path: screenshot });
    assert.equal(capture.path, screenshot);
    assert.ok((await fs.stat(screenshot)).size > 0);
    assert.equal((await callTool(client, "ml_regl_quit", { gameId })).quit, true);
    await new Promise((resolve, reject) => {
      game.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`game exited ${code}`)));
    });
  } finally {
    await fs.rm(screenshot, { force: true });
    if (game && game.exitCode === null) game.kill("SIGTERM");
    await client.close();
  }
});
