import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { WebSocket } from "ws";

// A scripted host behind the real server: no game, no window.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

// A 200x200 window letterboxing a 100x50 virtual area into rows 50..149: the
// view's left half is red, its right half blue, the bars black. Written as a
// bottom-up 32-bit BI_BITFIELDS bitmap with a V4 header, like SDL_SaveBMP.
function letterboxBmp() {
  const w = 200;
  const h = 200;
  const header = 14 + 108;
  const buf = Buffer.alloc(header + w * h * 4);
  buf.write("BM", 0, "latin1");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(header, 10);
  buf.writeUInt32LE(108, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(32, 28);
  buf.writeUInt32LE(3, 30);
  buf.writeUInt32LE(0x000000ff, 54);
  buf.writeUInt32LE(0x0000ff00, 58);
  buf.writeUInt32LE(0x00ff0000, 62);
  buf.writeUInt32LE(0xff000000, 66);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inView = y >= 50 && y < 150;
      const [r, g, b] = !inView ? [0, 0, 0] : x < 100 ? RED : BLUE;
      const o = header + ((h - 1 - y) * w + x) * 4;
      buf.writeUInt32LE(((255 << 24) | (b << 16) | (g << 8) | r) >>> 0, o);
    }
  }
  return buf;
}

// The same 100x50 view as a browser canvas PNG.
function viewPng() {
  const png = new PNG({ width: 100, height: 50 });
  for (let y = 0; y < 50; y += 1) {
    for (let x = 0; x < 100; x += 1) {
      const [r, g, b] = x < 50 ? RED : BLUE;
      png.data.set([r, g, b, 255], (y * 100 + x) * 4);
    }
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

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
      // As the protocol says: a first step without set_time starts at 0.
      if (!this.controlled) { this.controlled = true; this.timeMs = 0; }
      if (params.dt_ms !== undefined) this.dt = params.dt_ms;
      this.paused = true;
      this.respond(id, { queued: params.frames });
      for (let i = 0; i < params.frames; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        this.frame += 1;
        this.timeMs += this.dt;
        this.send({ type: "frame", frame: this.frame, time_ms: this.timeMs });
      }
      return undefined;
    }
    if (method === "get_render_tree") return this.respond(id, { available: true, tree: tree(this.shape) });
    if (method === "screenshot") {
      if (this.shape === "browser") return this.respond(id, { data_url: viewPng() });
      await fs.writeFile(params.path, letterboxBmp());
      return this.respond(id, { path: params.path });
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

function pixel(img, x, y) {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 40);

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
    const setTime = host.log.find((entry) => entry.method === "set_time");
    assert.deepEqual(setTime.params, { ms: 70000 });

    // send_keys: clean presses with a frame after each.
    host.log = [];
    const keys = (await callTool(client, "ml_regl_send_keys", { keys: ["Right", "Up"] })).value;
    assert.equal(keys.pressed, 2);
    assert.equal(keys.frame, 7);
    const inputs = host.log.filter((e) => e.method === "input").map((e) => `${e.params.kind}:${e.params.code}`);
    assert.deepEqual(inputs, ["key_down:Right", "key_up:Right", "key_down:Up", "key_up:Up"]);
    assert.equal(host.log.filter((e) => e.method === "set_time").length, 0, "the clock is set only once");

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

    // Desktop screenshot: the letterbox is cropped, one pixel per unit.
    host.shape = "desktop";
    const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("ml-regl-mcp-")).length;
    const shot = await callTool(client, "ml_regl_screenshot", { virtualSize: { width: 100, height: 50 }, format: "png" });
    assert.deepEqual(shot.value.capture.view, { x: 0, y: 50, width: 200, height: 100 });
    assert.equal(shot.value.pixelsPerUnit, 1);
    const png = PNG.sync.read(Buffer.from(shot.content.find((c) => c.type === "image").data, "base64"));
    assert.deepEqual([png.width, png.height], [100, 50]);
    assert.ok(near(pixel(png, 10, 10), RED));
    assert.ok(near(pixel(png, 90, 40), BLUE));
    const after = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("ml-regl-mcp-")).length;
    assert.equal(after, before, "the temporary BMP is deleted");

    // A region, remembered virtual size, JPEG by default.
    const part = await callTool(client, "ml_regl_screenshot", { region: { x: 50, y: 0, width: 50, height: 50 } });
    assert.equal(part.value.format, "image/jpeg");
    const jpg = jpeg.decode(Buffer.from(part.content.find((c) => c.type === "image").data, "base64"));
    assert.deepEqual([jpg.width, jpg.height], [50, 50]);
    assert.ok(near(pixel(jpg, 25, 25), BLUE));

    // Browser screenshot: the canvas is the view.
    host.shape = "browser";
    const web = await callTool(client, "ml_regl_screenshot", { format: "png" });
    const webPng = PNG.sync.read(Buffer.from(web.content.find((c) => c.type === "image").data, "base64"));
    assert.deepEqual([webPng.width, webPng.height], [100, 50]);
    assert.ok(near(pixel(webPng, 10, 10), RED));
  } finally {
    host.socket.close();
    await client.close();
  }
});
