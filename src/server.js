import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { GameRegistry } from "./game_host.js";

const registry = new GameRegistry();
const host = process.env.ML_REGL_MCP_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.ML_REGL_MCP_PORT || "8765", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("ML_REGL_MCP_PORT must be an integer between 0 and 65535");
}

const server = new McpServer({
  name: "ml-regl-mcp",
  version: "0.1.0",
});

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

server.registerTool("ml_regl_get_render_tree", {
  title: "Get render tree",
  description: "Return the latest protobuf render tree converted to JSON.",
  inputSchema: { gameId: gameIdSchema },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ gameId }) => jsonResult(await hostFor(gameId).sendCommand("get_render_tree")));

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
  description: "Advance a paused game by deterministic frames.",
  inputSchema: {
    gameId: gameIdSchema,
    frames: z.number().int().min(1).max(100000).optional().default(1),
    dtMs: z.number().finite().min(0).optional(),
  },
}, async ({ gameId, frames, dtMs }) => {
  const params = { frames };
  if (dtMs !== undefined) params.dt_ms = dtMs;
  return jsonResult(await hostFor(gameId).sendCommand("step", params));
});

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
  description: "Inject a keyboard or mouse event into the selected game.",
  inputSchema: {
    gameId: gameIdSchema,
    kind: z.enum(["key_down", "key_up", "mouse_down", "mouse_up", "mouse_move"]),
    code: z.string().optional(),
    button: z.number().int().min(1).max(5).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  },
}, async ({ gameId, kind, code, button, x, y }) => {
  const params = { kind };
  if (code !== undefined) params.code = code;
  if (button !== undefined) params.button = button;
  if (x !== undefined) params.x = x;
  if (y !== undefined) params.y = y;
  return jsonResult(await hostFor(gameId).sendCommand("input", params));
});

server.registerTool("ml_regl_screenshot", {
  title: "Capture game screenshot",
  description: "Capture the current frame. Desktop hosts return a BMP path; browser hosts return a PNG data URL.",
  inputSchema: {
    gameId: gameIdSchema,
    path: z.string().optional().describe("Desktop output path; omit for a generated path"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ gameId, path }) => {
  const result = await hostFor(gameId).sendCommand(
    "screenshot",
    path === undefined ? {} : { path },
  );
  const dataUrl = result?.data_url;
  if (typeof dataUrl === "string") {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ format: match[1] }) },
          { type: "image", mimeType: match[1], data: match[2] },
        ],
      };
    }
  }
  return jsonResult(result);
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

const websocketServer = new WebSocketServer({ host, port, maxPayload: 1024 * 1024 });
websocketServer.on("connection", (socket) => {
  const game = registry.add(socket);
  process.stderr.write(`ml-regl-mcp: game host ${game.id} connected\n`);
  socket.on("close", () => process.stderr.write(`ml-regl-mcp: game host ${game.id} disconnected\n`));
});
websocketServer.on("listening", () => {
  const address = websocketServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stderr.write(`ml-regl-mcp: WebSocket listener ws://${host}:${actualPort}\n`);
});
websocketServer.on("error", (error) => {
  process.stderr.write(`ml-regl-mcp: WebSocket error: ${error.message}\n`);
  process.exitCode = 1;
});

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
