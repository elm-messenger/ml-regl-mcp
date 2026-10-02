import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

// A scripted host behind the real server: no game, no window.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The host encodes screenshots; the server passes the bytes through.
const IMAGE = Buffer.from("not really a JPEG, but the server must not care");

const field = (shape, key, v) => {
  if (shape === "desktop") {
    if (typeof v === "string") return { key, value: { string: v } };
    if (Array.isArray(v)) return { key, value: { numbers: v } };
    return { key, value: { number: v } };
  }
  if (typeof v === "string") return { key, val: { stringValue: v } };
  if (Array.isArray(v)) return { key, val: { numberArrayValue: { values: v } } };
  return { key, val: { numberValue: v } };
};

function tree(shape) {
  const f = (k, v) => field(shape, k, v);
  const group = (children, extra = {}) => ({
    group: shape === "desktop" ? { children, ...extra } : { effects: [], camera: null, children, ...extra },
  });
  return group([
    { atomic: { program: "clear", fields: [f("color", [0, 0, 0, 1])] } },
    group([
      { atomic: { program: "rect", fields: [f("posize", [10, 10, 20, 20]), f("color", [1, 0, 0, 1])] } },
      { atomic: { program: "textbox", fields: [f("text", "Score: 3"), f("size", 24), f("offset", [5, 6]), f("font", "font")] } },
    ], { camera: { x: 50, y: 25, zoom: 2, rotation: 0 } }),
    {
      composite: {
        compositor: { program: "compFade", fields: [f("t", 0.5)] },
        left: { atomic: { program: "textbox", fields: [f("text", "Paused"), f("size", 12), f("offset", [1, 2]), f("font", "font")] } },
        right: group([]),
      },
    },
  ]);
}

class FakeHost {
  constructor(port) {
    this.frame = 0;
    this.timeMs = 70000; // the game has run for 70 s on the wall clock
    this.controlled = false;
    this.paused = false;
    this.dt = 10;
    this.frameDelayMs = 5;
    this.log = [];
    this.shape = "desktop";
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ready = new Promise((resolve) => this.socket.once("open", resolve));
    this.socket.on("open", () => this.send({
      type: "hello", protocol: 1, runtime: "ml-regl-desktop",
      capabilities: ["pause", "resume", "step", "set_time", "get_state", "get_render_tree", "screenshot", "input"],
    }));
    this.socket.on("message", (data) => this.handle(JSON.parse(data.toString())));
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  respond(id, result) { this.send({ type: "response", id, ok: true, result }); }

  async handle({ id, method, params = {} }) {
    this.log.push({ method, params });
    if (method === "pause") { this.paused = true; return this.respond(id, { paused: true }); }
    if (method === "get_state") {
      return this.respond(id, { paused: this.paused, frame: this.frame, time_ms: this.timeMs, logs: [] });
    }
    if (method === "set_time") { this.timeMs = params.ms; this.controlled = true; return this.respond(id, { time_ms: this.timeMs }); }
    if (method === "input") return this.respond(id, { delivered: true });
    if (method === "step") {
      // As the protocol says: the controlled clock continues from the
      // current time.
      this.controlled = true;
      if (params.dt_ms !== undefined) this.dt = params.dt_ms;
      this.paused = true;
      this.respond(id, { queued: params.frames });
      for (let i = 0; i < params.frames; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, this.frameDelayMs));
        this.frame += 1;
        this.timeMs += this.dt;
        this.send({ type: "frame", frame: this.frame, time_ms: this.timeMs });
      }
      return undefined;
    }
    if (method === "get_render_tree") return this.respond(id, { available: true, tree: tree(this.shape) });
    if (method === "screenshot") {
      const info = {
        format: params.format ?? "bmp", width: 100, height: 50,
        view: { x: 0, y: 50, width: 200, height: 100 }, virtual: { width: 100, height: 50 }, pixels_per_unit: 1,
      };
      if (this.shape === "browser") {
        return this.respond(id, { data_url: `data:image/jpeg;base64,${IMAGE.toString("base64")}`, ...info });
      }
      await fs.writeFile(params.path, IMAGE);
      return this.respond(id, { path: params.path, ...info });
    }
    return this.send({ type: "response", id, ok: false, error: { message: "unknown method" } });
  }
}

async function callTool(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.find((item) => item.type === "text")?.text;
  assert.equal(response.isError, undefined, text);
  return { value: JSON.parse(text), content: response.content };
}

test("the server's step, keys, render tree and screenshots on a scripted host", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src/server.js")],
    cwd: root,
    env: { ...process.env, ML_REGL_MCP_PORT: "0" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: "fake-host-test", version: "0.1.0" });
  await client.connect(transport);
  const port = Number(stderr.match(/WebSocket listener ws:\/\/[^:]+:(\d+)/)[1]);
  const host = new FakeHost(port);
  await host.ready;
  try {
    for (let i = 0; i < 50; i += 1) {
      const games = (await callTool(client, "ml_regl_list_games")).value;
      if (games.length === 1 && games[0].protocol === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // step waits for its frames, and the clock carries on from 70 s.
    const step = (await callTool(client, "ml_regl_step", { frames: 5, dtMs: 10 })).value;
    assert.equal(step.done, true);
    assert.equal(step.frame, 5);
    assert.equal(step.time_ms, 70050);
    assert.equal(host.log.filter((e) => e.method === "set_time").length, 0);

    // send_keys: clean presses with a frame after each.
    host.log = [];
    const keys = (await callTool(client, "ml_regl_send_keys", { keys: ["Right", "Up"] })).value;
    assert.equal(keys.pressed, 2);
    assert.equal(keys.frame, 7);
    const inputs = host.log.filter((e) => e.method === "input").map((e) => `${e.params.kind}:${e.params.code}`);
    assert.deepEqual(inputs, ["key_down:Right", "key_up:Right", "key_down:Up", "key_up:Up"]);

    host.log = [];
    await callTool(client, "ml_regl_send_input", { kind: "key_press", code: "Space" });
    assert.deepEqual(host.log.map((e) => `${e.params.kind}:${e.params.code}`), ["key_down:Space", "key_up:Space"]);

    // The render tree: a summary and queries, the same for both host shapes,
    // and never the whole tree.
    const summaries = {};
    for (const shape of ["desktop", "browser"]) {
      host.shape = shape;
      const summary = (await callTool(client, "ml_regl_get_render_tree")).value;
      assert.equal(summary.tree, undefined);
      delete summary.frame;
      summaries[shape] = summary;
    }
    assert.deepEqual(summaries.desktop, summaries.browser);
    const summary = summaries.desktop;
    assert.equal(summary.nodes, 8);
    assert.deepEqual(summary.programs, { clear: 1, rect: 1, textbox: 2, "compFade (compositor)": 1 });
    assert.deepEqual(summary.texts.map((t) => [t.path, t.text, t.x, t.y]), [["1.1", "Score: 3", 5, 6], ["2.0", "Paused", 1, 2]]);
    const camera = summary.outline.find((n) => n.path === "1");
    assert.deepEqual(camera.camera, { x: 50, y: 25, zoom: 2, rotation: 0 });
    const found = (await callTool(client, "ml_regl_query_render_tree", { text: "Score" })).value;
    assert.equal(found.total, 1);
    assert.deepEqual(found.matches[0].fields.offset, [5, 6]);
    const node = (await callTool(client, "ml_regl_query_render_tree", { path: "1", depth: 1 })).value;
    assert.equal(node.matches[0].children[0].program, "rect");
    const rects = (await callTool(client, "ml_regl_query_render_tree", { program: "rect" })).value;
    assert.deepEqual(rects.matches.map((m) => m.path), ["1.0"]);

    // Screenshots: the host crops, scales and encodes; the server forwards
    // the request and returns the image as it came.
    host.shape = "desktop";
    const tmpCount = async () => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("ml-regl-mcp-")).length;
    const before = await tmpCount();
    host.log = [];
    const shot = await callTool(client, "ml_regl_screenshot", { region: { x: 50, y: 0, width: 50, height: 50 } });
    const { path: tmpPath, ...sent } = host.log.find((e) => e.method === "screenshot").params;
    assert.deepEqual(sent, {
      area: "view", scale: "virtual", max_width: 1280, format: "jpeg", quality: 70,
      region: { x: 50, y: 0, width: 50, height: 50 },
    });
    assert.ok(tmpPath.endsWith(".jpg"));
    assert.equal(shot.content.find((c) => c.type === "image").data, IMAGE.toString("base64"));
    assert.equal(shot.value.format, "image/jpeg");
    assert.deepEqual(shot.value.view, { x: 0, y: 50, width: 200, height: 100 });
    assert.equal(shot.value.pixelsPerUnit, 1);
    assert.equal(await tmpCount(), before, "the temporary file is deleted");

    const kept = path.join(os.tmpdir(), `kept-${process.pid}.png`);
    const saved = await callTool(client, "ml_regl_screenshot", { format: "png", path: kept });
    assert.equal(saved.value.savedPath, kept);
    assert.equal(saved.value.format, "image/png");
    assert.deepEqual(await fs.readFile(kept), IMAGE);
    await fs.rm(kept);

    host.shape = "browser";
    const web = await callTool(client, "ml_regl_screenshot", {});
    assert.equal(web.content.find((c) => c.type === "image").data, IMAGE.toString("base64"));

    // timeoutMs bounds the whole send_keys call, on a host that is slow to
    // run frames (a background browser tab, say).
    host.frameDelayMs = 300;
    const started = Date.now();
    const slow = (await callTool(client, "ml_regl_send_keys", { keys: ["A", "B", "C", "D"], timeoutMs: 700 })).value;
    assert.equal(slow.done, false);
    assert.ok(slow.pressed >= 1 && slow.pressed < 4, JSON.stringify(slow));
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    await new Promise((resolve) => setTimeout(resolve, 400)); // the queued frame

    // A cancelled call stops pressing keys.
    host.log = [];
    const controller = new AbortController();
    const cancelled = client.callTool({ name: "ml_regl_send_keys", arguments: { keys: ["A", "B", "C", "D", "E"] } },
      undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 450);
    await assert.rejects(cancelled);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const downs = host.log.filter((e) => e.method === "input" && e.params.kind === "key_down").length;
    assert.ok(downs <= 2, `${downs} keys pressed after cancelling`);
    host.frameDelayMs = 5;
  } finally {
    host.socket.close();
    await client.close();
  }
});
