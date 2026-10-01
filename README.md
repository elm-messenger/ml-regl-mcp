# ml-regl MCP

This server bridges an MCP client to a running ml-regl game. It exposes MCP
over stdio and owns a localhost WebSocket listener for game hosts.

## Install

Claude Code:

```bash
claude mcp add ml-regl -e ML_REGL_MCP_PORT=8765 -- npx -y ml-regl-mcp
```

Any MCP client that launches stdio servers:

```json
{
  "mcpServers": {
    "ml-regl": {
      "command": "npx",
      "args": ["-y", "ml-regl-mcp"],
      "env": { "ML_REGL_MCP_PORT": "8765" }
    }
  }
}
```

Configure the listener with `ML_REGL_MCP_HOST` (default `127.0.0.1`) and
`ML_REGL_MCP_PORT` (default `8765`). The server's MCP instructions tell the
agent the URL it is actually listening on, so a changed port needs no other
setup.

## Connect a game

The game host connects outbound to the listener:

```bash
DECLGL_DEBUG=1 \
DECLGL_CONTROL_URL=ws://127.0.0.1:8765 \
./your_ml_regl_game
```

Browser builds connect when the page URL ends in
`#mcp=ws://127.0.0.1:8765`.

The server provides tools for listing games, querying state/render trees,
pausing/resuming, deterministic stepping, input injection, screenshots, and
quitting. The WebSocket protocol is documented in the main ml-regl repository
at `docs/ControlProtocol.md`.

## Development

```bash
npm install
npm start
npm test
```

`npm test` includes a native end-to-end test that needs a built
`../ml-regl` checkout. `npm publish` runs only the stdio test.
