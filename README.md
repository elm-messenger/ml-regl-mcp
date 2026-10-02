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
load one explicitly. The GitHub repository is its own one-plugin marketplace.
Add it once, then install the plugin with **local scope** from each game
project:

```bash
claude plugin marketplace add elm-messenger/ml-regl-mcp
cd /path/to/your-game
claude plugin install ml-regl@ml-regl --scope local
```

Run the last two commands again in every other game project. Inside Claude
Code, `/plugin marketplace add elm-messenger/ml-regl-mcp` and `/plugin install
ml-regl@ml-regl` do the same; choose local scope. Restart Claude Code
afterwards.

Local scope enables the plugin only in that project and only for you; it is
recorded in the project's `.claude/settings.local.json`, which is not meant to
be committed. Avoid the default `user` scope: it enables the plugin in every
Claude Code session, so every session, related or not, starts its own server
on port 8765. Whichever session starts first keeps the port, and your game
can end up connected to an unrelated session. To share the plugin with
everyone working on a project, use `--scope project`, which goes into the
committed `.claude/settings.json`.

If you already installed it with user scope, turn it off globally and enable
it per project:

```bash
claude plugin disable ml-regl@ml-regl --scope user
cd /path/to/your-game
claude plugin enable ml-regl@ml-regl --scope local
```

To pick up new commits from GitHub (from any directory):

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

The server provides tools for listing games, reading state, summarizing and
querying what is drawn (render-tree summaries and node queries; the full tree
never goes to the agent), pausing/resuming, deterministic stepping that waits
for its frames, input injection and key sequences, compressed and cropped
screenshots, and quitting. The first step continues the game's clock from its
current time. The WebSocket protocol is documented in the main ml-regl repository
at `docs/ControlProtocol.md`.

## Development

```bash
npm install
npm start
npm test
```

`npm test` includes a native end-to-end test that needs a built
`../ml-regl` checkout. `npm publish` runs only the stdio test.
