# ml-regl MCP

This server bridges an MCP client to a running ml-regl game. It exposes MCP
over stdio and owns a localhost WebSocket listener for game hosts.

## Install

To get the server together with the skills in Claude Code, install the
[plugin](#claude-code-plugin) instead. To add only the server:

```bash
claude mcp add ml-regl -e ML_REGL_MCP_PORT=8765 -- npx -y github:elm-messenger/ml-regl-mcp
```

Any MCP client that launches stdio servers:

```json
{
  "mcpServers": {
    "ml-regl": {
      "command": "npx",
      "args": ["-y", "github:elm-messenger/ml-regl-mcp"],
      "env": { "ML_REGL_MCP_PORT": "8765" }
    }
  }
}
```

`github:elm-messenger/ml-regl-mcp` runs the latest commit on `main`. Released
versions are also on npm as `ml-regl-mcp`.

Configure the listener with `ML_REGL_MCP_HOST` (default `127.0.0.1`) and
`ML_REGL_MCP_PORT` (default `8765`). The server's MCP instructions tell the
agent the URL it is actually listening on, so a changed port needs no other
setup.

## Claude Code plugin

This repository is also a Claude Code plugin, `ml-regl`, that bundles this
server with two skills:

- `/ml-regl:messenger`: writing games with ml-messenger (scenes, components,
  message unions, global components, headless tests).
- `/ml-regl:rendering`: writing ml-regl rendering code (the renderable tree,
  cameras, text, textures, effects, custom GLSL programs).

Claude loads a skill on its own when the task matches; the slash commands
load one explicitly. The GitHub repository is its own one-plugin marketplace:

```bash
claude plugin marketplace add elm-messenger/ml-regl-mcp
claude plugin install ml-regl@ml-regl
```

(or `/plugin marketplace add elm-messenger/ml-regl-mcp` and
`/plugin install ml-regl@ml-regl` inside Claude Code). Restart Claude Code
afterwards. To pick up new commits from GitHub:

```bash
claude plugin marketplace update ml-regl
claude plugin update ml-regl@ml-regl
```

To try a local working copy without installing it, start
`claude --plugin-dir /path/to/ml-regl-mcp`.

The plugin starts the server with `bin/plugin-server`. Claude Code installs
the plugin's npm dependencies when it installs the plugin; if `node_modules`
is missing, the launcher runs `npm ci` on first start. `node` and `npm` must
be on `PATH`. The plugin's server listens on port 8765, so remove a
separately registered server (`claude mcp remove ml-regl`) or the two will
compete for the port. Its tools appear as `mcp__plugin_ml-regl_ml-regl__*`.

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
