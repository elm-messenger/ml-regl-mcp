# ml-regl MCP

This server bridges an MCP client to a running ml-regl game. It exposes MCP
over stdio and owns a localhost WebSocket listener for game hosts.

## Run

```bash
npm install
npm start
```

The game host should connect outbound to `ws://127.0.0.1:8765`:

```bash
DECLGL_DEBUG=1 \
DECLGL_CONTROL_URL=ws://127.0.0.1:8765 \
./your_ml_regl_game
```

Configure the listener with `ML_REGL_MCP_HOST` and `ML_REGL_MCP_PORT`.

The server provides tools for listing games, querying state/render trees,
pausing/resuming, deterministic stepping, input injection, screenshots, and
quitting. The WebSocket protocol is documented in the main ml-regl repository
at `docs/ControlProtocol.md`.

## MCP configuration

For an MCP client that launches stdio servers:

```json
{
  "mcpServers": {
    "ml-regl": {
      "command": "node",
      "args": ["/home/yxiang/Downloads/gamdev/ml-regl-mcp/src/server.js"]
    }
  }
}
```
