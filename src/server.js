#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { GameRegistry } from "./game_host.js";
import { normalize, query, summarize } from "./render_tree.js";

const { version } = createRequire(import.meta.url)("../package.json");
const registry = new GameRegistry();
const host = process.env.ML_REGL_MCP_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.ML_REGL_MCP_PORT || "8765", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("ML_REGL_MCP_PORT must be an integer between 0 and 65535");
}

// Render trees of busy scenes run to megabytes; the listener is local.
const websocketServer = new WebSocketServer({ host, port, maxPayload: 64 * 1024 * 1024 });
const listening = new Promise((resolve) => {
  websocketServer.once("listening", () => resolve(null));
  websocketServer.once("error", (error) => resolve(error));
});
websocketServer.on("connection", (socket) => {
  const game = registry.add(socket);
  process.stderr.write(`ml-regl-mcp: game host ${game.id} connected\n`);
  socket.on("close", () => process.stderr.write(`ml-regl-mcp: game host ${game.id} disconnected\n`));
});
websocketServer.on("listening", () => {
  process.stderr.write(`ml-regl-mcp: WebSocket listener ws://${host}:${boundPort()}\n`);
});
websocketServer.on("error", (error) => {
  process.stderr.write(`ml-regl-mcp: WebSocket error: ${error.message}\n`);
  process.exitCode = 1;
});

// The instructions name the bound URL, so wait for the listener: the port
// comes from ML_REGL_MCP_PORT and may be 0 (ephemeral).
const listenError = await listening;

function boundPort() {
  const address = websocketServer.address();
  return typeof address === "object" && address ? address.port : port;
}

function controlUrl() {
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `ws://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${boundPort()}`;
}

function instructions(url) {
  const lines = [
    "ml-regl-mcp controls running ml-regl games (desktop SDL or browser WebGL). Games connect out to this server's WebSocket listener; the server does not launch, build, or restart games.",
    "",
    `Game listener: ${url} (set by ML_REGL_MCP_HOST and ML_REGL_MCP_PORT in this server's MCP configuration). Always use this exact URL.`,
  ];
  if (listenError) {
    lines.push(`WARNING: the listener failed to start (${listenError.message}). No game can connect until this server is restarted with a free ML_REGL_MCP_PORT.`);
  }
  lines.push(
    "",
    "Connecting a game (start it yourself, in the background, so it keeps running):",
    `- Desktop: DECLGL_DEBUG=1 DECLGL_CONTROL_URL=${url} <game executable>. Run it from the directory its asset paths are relative to, usually the project root. DECLGL_REMOTE_CONTROL=1 in place of DECLGL_DEBUG=1 allows control but disables published state and logs.`,
    `- Browser: open the game page with #mcp=${url} appended to its URL.`,
    "- Then poll ml_regl_list_games until the game is listed with protocol 1. Pass its id as gameId when more than one game is connected.",
    "",
    "Working with a game:",
    "- ml_regl_get_state returns what the game publishes (state, logs), the frame, and the clock.",
    "- ml_regl_get_render_tree returns a summary of what is drawn: node and program counts, every textbox string with its path and position, and an outline of the top levels. ml_regl_query_render_tree returns nodes by path, program, or text, with their fields. The full tree is never returned.",
    "- ml_regl_step pauses the game, runs the frames, and returns once they have run (frame, time_ms). The first step or set_time puts the game on a controlled clock that continues from its current time and stays on after resume.",
    "- ml_regl_send_keys presses keys one after another (key_down, key_up, then framesAfter frames) on the paused game: one call for a whole move sequence. timeoutMs (default 60 s) bounds the whole call; when it is up, the result has done: false and the number of keys pressed. ml_regl_send_input sends single events, including key_press (down then up).",
    "- Input coordinates are in the game's virtual resolution, not window pixels. Input sent while paused shows up in the view after the next stepped frame.",
    "- ml_regl_screenshot returns the game's view (without the desktop letterbox) as a compressed image, JPEG by default, one pixel per virtual unit up to maxWidth; region captures part of it in virtual units. A fully transparent browser screenshot means the page loads an old ml-regl-js bundle, which needs rebuilding.",
    "- ml_regl_quit exits a desktop game. A browser game stops its loop but stays listed, and stops answering, until its tab closes.",
  );
  return lines.join("\n");
}

const server = new McpServer({
  name: "ml-regl-mcp",
  version,
}, { instructions: instructions(controlUrl()) });

const gameIdSchema = z.string().optional().describe(
  "Game host id from ml_regl_list_games; omit when exactly one host is connected",
);

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function hostFor(gameId) {
  return registry.resolve(gameId);
}

server.registerTool("ml_regl_list_games", {
  title: "List ml-regl games",
  description: "List connected ml-regl desktop and browser game hosts.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => jsonResult(registry.list()));

server.registerTool("ml_regl_get_state", {
  title: "Get game state",
  description: "Return the latest published state, logs, frame, and clock from a game.",
  inputSchema: { gameId: gameIdSchema },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ gameId }) => jsonResult(await hostFor(gameId).sendCommand("get_state")));

async function renderTree(gameId) {
  const host = hostFor(gameId);
  const result = await host.sendCommand("get_render_tree");
  const tree = result?.available ? normalize(result.tree) : null;
  return { host, tree };
}

server.registerTool("ml_regl_get_render_tree", {
  title: "Summarize render tree",
  description: "Summarize the last rendered frame: node count, depth, counts per program and effect, every textbox string with its path and position, and an outline of the top levels. Use ml_regl_query_render_tree for nodes and their fields.",
  inputSchema: { gameId: gameIdSchema },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ gameId }) => {
  const { host, tree } = await renderTree(gameId);
  if (!tree) return jsonResult({ available: false });
  return jsonResult({ available: true, frame: host.latestFrame?.frame ?? null, ...summarize(tree) });
});

server.registerTool("ml_regl_query_render_tree", {
  title: "Query render tree",
  description: "Return nodes of the last rendered frame with their fields. Without filters, the node at path; with program and/or text, every matching node under path. A path is child indices joined by '.' ('' is the root; a composite's left side is 0, right 1), as in the summary.",
  inputSchema: {
    gameId: gameIdSchema,
    path: z.string().optional().describe("Node to return, or to search under; default the root"),
    program: z.string().optional().describe("Match draw calls and compositors by program name, e.g. textbox, rect"),
    text: z.string().optional().describe("Match textboxes whose text contains this string"),
    depth: z.number().int().min(0).max(8).optional().default(0).describe("Levels of children to include with each node, 0 to 8"),
    limit: z.number().int().min(1).max(200).optional().default(20).describe("Most nodes to return, 1 to 200"),
    fullArrays: z.boolean().optional().default(false).describe("Return number arrays longer than 32 in full"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ gameId, ...options }) => {
  const { tree } = await renderTree(gameId);
  if (!tree) return jsonResult({ available: false });
  return jsonResult({ available: true, ...query(tree, options) });
});

server.registerTool("ml_regl_pause", {
  title: "Pause game",
  description: "Pause update and rendering while keeping input and control live.",
  inputSchema: { gameId: gameIdSchema },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async ({ gameId }) => jsonResult(await hostFor(gameId).sendCommand("pause")));

server.registerTool("ml_regl_resume", {
  title: "Resume game",
  description: "Resume normal update and rendering.",
  inputSchema: { gameId: gameIdSchema },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async ({ gameId }) => jsonResult(await hostFor(gameId).sendCommand("resume")));

server.registerTool("ml_regl_step", {
  title: "Step game",
  description: "Pause the game and run frames on the controlled clock. With wait (the default), returns once they have run: {done, frame, time_ms}.",
  inputSchema: {
    gameId: gameIdSchema,
    frames: z.number().int().min(1).max(100000).optional().default(1),
    dtMs: z.number().finite().min(0).optional().describe("Game time per frame in milliseconds"),
    wait: z.boolean().optional().default(true),
    timeoutMs: z.number().int().min(100).max(600000).optional().default(60000)
      .describe("Longest wait in milliseconds (100-600000); then returns done: false"),
  },
}, async ({ gameId, frames, dtMs, wait, timeoutMs }, { signal }) => jsonResult(
  await hostFor(gameId).stepAndWait({ frames, dtMs, wait, timeoutMs, signal }),
));

server.registerTool("ml_regl_set_time", {
  title: "Set game time",
  description: "Set the deterministic game clock in milliseconds.",
  inputSchema: {
    gameId: gameIdSchema,
    milliseconds: z.number().finite().min(0),
  },
}, async ({ gameId, milliseconds }) => jsonResult(
  await hostFor(gameId).sendCommand("set_time", { ms: milliseconds }),
));

server.registerTool("ml_regl_send_input", {
  title: "Send game input",
  description: "Inject a keyboard or mouse event into the selected game. key_press sends key_down then key_up.",
  inputSchema: {
    gameId: gameIdSchema,
    kind: z.enum(["key_down", "key_up", "key_press", "mouse_down", "mouse_up", "mouse_move"]),
    code: z.string().optional(),
    button: z.number().int().min(1).max(5).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  },
}, async ({ gameId, kind, code, button, x, y }) => {
  const host = hostFor(gameId);
  if (kind === "key_press") {
    await host.sendCommand("input", { kind: "key_down", code });
    return jsonResult(await host.sendCommand("input", { kind: "key_up", code }));
  }
  const params = { kind };
  if (code !== undefined) params.code = code;
  if (button !== undefined) params.button = button;
  if (x !== undefined) params.x = x;
  if (y !== undefined) params.y = y;
  return jsonResult(await host.sendCommand("input", params));
});

server.registerTool("ml_regl_send_keys", {
  title: "Press keys",
  description: "Press keys one after another on the paused game: for each, key_down, holdFrames frames, key_up, framesAfter frames. Returns once all have run, or when timeoutMs is up with done: false and the number of keys pressed.",
  inputSchema: {
    gameId: gameIdSchema,
    keys: z.array(z.string().min(1)).min(1).max(500).describe("SDL key names, e.g. [\"Right\", \"Right\", \"Up\"]"),
    holdFrames: z.number().int().min(0).max(1000).optional().default(0).describe("Frames between key_down and key_up"),
    framesAfter: z.number().int().min(0).max(1000).optional().default(1).describe("Frames after each key_up"),
    dtMs: z.number().finite().min(0).optional(),
    timeoutMs: z.number().int().min(100).max(600000).optional().default(60000)
      .describe("Time for the whole call in milliseconds (100-600000)"),
  },
}, async ({ gameId, keys, holdFrames, framesAfter, dtMs, timeoutMs }, { signal }) => jsonResult(
  await hostFor(gameId).sendKeys(keys, { holdFrames, framesAfter, dtMs, timeoutMs, signal }),
));

server.registerTool("ml_regl_screenshot", {
  title: "Capture game screenshot",
  description: "Capture the game's view (the virtual area, without the desktop letterbox) as a compressed image, one pixel per virtual unit up to maxWidth. region captures part of the view, in virtual units.",
  inputSchema: {
    gameId: gameIdSchema,
    region: z.object({
      x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
    }).optional().describe("Part of the view to capture, in virtual units"),
    format: z.enum(["jpeg", "png"]).optional().default("jpeg"),
    quality: z.number().int().min(1).max(100).optional().default(70).describe("JPEG quality"),
    maxWidth: z.number().int().min(16).max(8192).optional().default(1280),
    path: z.string().optional().describe("Desktop only: also keep the image file at this path. A relative path is relative to the game's working directory; missing directories are created"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ gameId, region, format, quality, maxWidth, path: keepPath }) => {
  const host = hostFor(gameId);
  // The host resolves a relative path against its working directory.
  const capturePath = keepPath
    ?? path.join(os.tmpdir(), `ml-regl-mcp-${randomUUID()}.${format === "png" ? "png" : "jpg"}`);
  const params = { area: "view", scale: "virtual", max_width: maxWidth, format, quality, path: capturePath };
  if (region) params.region = region;
  const result = await host.sendCommand("screenshot", params);
  let data;
  if (typeof result?.data_url === "string") {
    data = result.data_url.slice(result.data_url.indexOf(",") + 1);
  } else if (typeof result?.path === "string") {
    try {
      data = (await fs.readFile(result.path)).toString("base64");
    } finally {
      if (!keepPath) await fs.rm(result.path, { force: true });
    }
  } else {
    return jsonResult(result);
  }
  const mimeType = result.format === "png" ? "image/png" : "image/jpeg";
  const info = {
    format: mimeType,
    width: result.width,
    height: result.height,
    bytes: Math.floor((data.length * 3) / 4),
    pixelsPerUnit: result.pixels_per_unit,
    view: result.view,
    virtual: result.virtual,
  };
  if (keepPath && typeof result.path === "string") info.savedPath = result.path;
  return {
    content: [
      { type: "text", text: JSON.stringify(info, null, 2) },
      { type: "image", mimeType, data },
    ],
  };
});

server.registerTool("ml_regl_quit", {
  title: "Quit game",
  description: "Request a connected game host to exit.",
  inputSchema: { gameId: gameIdSchema },
  annotations: { destructiveHint: true, openWorldHint: false },
}, async ({ gameId }) => jsonResult(await hostFor(gameId).sendCommand("quit")));

server.registerResource(
  "ml-regl-games",
  "ml-regl://games",
  {
    title: "Connected ml-regl games",
    description: "Live list of game hosts connected to the ml-regl control socket.",
    mimeType: "application/json",
  },
  async () => ({
    contents: [{ uri: "ml-regl://games", mimeType: "application/json", text: JSON.stringify(registry.list(), null, 2) }],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function shutdown() {
  for (const game of [...registry.hosts.values()]) game.close();
  await new Promise((resolve) => websocketServer.close(() => resolve()));
  await server.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
main().catch((error) => {
  process.stderr.write(`ml-regl-mcp: server error: ${error.stack || error}\n`);
  process.exit(1);
});
