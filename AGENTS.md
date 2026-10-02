# AGENTS.md

## Purpose and scope

`ml-regl-mcp` is a small Node.js MCP server that lets an MCP client (an AI
agent) inspect and drive a running ml-regl game. It speaks MCP over **stdio**
to the client and owns a **localhost WebSocket listener** that game hosts
connect *out* to. It does not launch, build, or own games; it only relays
JSON control commands defined by the ml-regl control protocol.

```
MCP client ──stdio──> src/server.js ──ws://127.0.0.1:8765 (listener)──< game host(s)
                                                       desktop: declgl-desktop (SDL3/OpenGL)
                                                       browser: ml-regl-js (WebGL)
```

Sibling repositories (read them before changing protocol-facing behavior):

- `../ml-regl/docs/ControlProtocol.md`: the wire protocol and the source of truth.
- `../ml-regl/declgl-desktop/src/runtime/control_client.cc` and
  `runtime.cc` (`process_control_commands`): the native host.
- `../ml-regl/ml-regl-js/src/app.js` (`processControlCommands`): the browser host.
- `../ml-messenger`: the game framework whose test apps are the main
  real-world clients (see "Verified against ml-messenger" below).

The protocol lives in `ml-regl`. If a command or event changes, change it there
and in both hosts first, then mirror it here. Do not invent server-only
protocol extensions.

## Repository map

- `src/server.js`: the WebSocket listener, the MCP `instructions`, MCP tool and
  resource registration, and SIGINT/SIGTERM shutdown. The listener is bound
  before the `McpServer` is created so the instructions can name the real
  bound URL (`ML_REGL_MCP_HOST`/`ML_REGL_MCP_PORT`, including port `0`).
- `src/game_host.js`: `GameHost` (one connected game: hello handshake, request
  and response correlation by id, 5 s timeouts, cached events, waiting for
  frames, carrying the clock over on the first step, key sequences) and
  `GameRegistry` (`game-N` ids, resolving a host when `gameId` is omitted).
- `src/render_tree.js`: normalizes both hosts' render-tree JSON into one shape
  and builds the bounded views agents get: the summary and node queries.
- `test/fake_host.test.js`: a scripted host behind the real server: waiting
  steps, the clock carried over, key sequences, render-tree summary and
  queries for both host shapes, and what screenshots ask of the host and
  return. It needs no game.
- `test/mcp_stdio.test.js`: checks that the stdio server lists its tools and
  resource. It needs no game.
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  `bin/plugin-server`, `skills/`: the Claude Code plugin (see below).
- `test/native_mcp_e2e.test.js`: launches
  `../ml-regl/_build/default/test/test_fps_smoke_desktop.exe` and runs pause,
  step, render tree, input, screenshot, and quit through MCP. It needs a
  prebuilt native ml-regl, opens a real SDL window, and is not skipped when
  the binary is missing.

Dependencies: `@modelcontextprotocol/sdk` ^1.30, `ws` ^8, `zod` ^3. The package
is ESM (`"type": "module"`), and `engines` follows the SDK (`node >=18`). Only
Node 24 has been tested.

## Packaging

The package is published to npm as `ml-regl-mcp` (BSD-3-Clause, same as
ml-regl and ml-messenger). The `bin` entry `ml-regl-mcp` is `src/server.js`,
which must keep its `#!/usr/bin/env node` line and executable bit. The README
tells users to run `npx -y github:elm-messenger/ml-regl-mcp` (latest `main`).
The npm release is `npx -y ml-regl-mcp`, and it falls behind `main` until the
next publish.

- `files` is `["src"]`. npm always adds `package.json`, `README.md`, and
  `LICENSE`, so tests, `AGENTS.md`, and the lockfile are not shipped. A
  `github:` install is packed the same way, so it gets the same files. Check
  with `npm pack --dry-run` after adding files.
- `serverInfo.version` is read from `package.json`. Bump the version with
  `npm version <patch|minor|major>`, never by editing source.
- `prepublishOnly` runs `test/mcp_stdio.test.js` and `test/fake_host.test.js`,
  which need no game; the native e2e test needs sibling build outputs. Run the
  full `npm test` yourself before a release.
- Publishing is the maintainer's action (`npm login`, then `npm publish`). Do
  not publish from an agent session unless explicitly asked.

## Claude Code plugin

The repository is also the Claude Code plugin `ml-regl` and a marketplace
holding only that plugin (`marketplace.json` has `"source": "./"`). Users
install it from GitHub (`claude plugin marketplace add
elm-messenger/ml-regl-mcp`, then `claude plugin install ml-regl@ml-regl --scope
local` in each game project), not from npm. An installed plugin is whatever is
on GitHub `main`, so push before telling anyone to update.

- The README recommends local scope on purpose. The default `user` scope
  enables the plugin, and so starts a server on port 8765, in every Claude
  Code session in every project, and the first session to start keeps the port.
  Local scope writes `enabledPlugins` to the project's
  `.claude/settings.local.json` and leaves user settings alone (checked with
  Claude Code 2.1.287).

- `plugin.json` declares the MCP server inline. It runs
  `${CLAUDE_PLUGIN_ROOT}/bin/plugin-server`, which installs the production
  dependencies with `npm ci` when `node_modules` is missing, then execs
  `src/server.js`. Claude Code 2.1.287 already installs dependencies into the
  plugin cache, so this is a fallback for clients that don't. Like the server,
  the launcher must write nothing but MCP to stdout. Keep the lockfile
  committed, since `npm ci` needs it.
- `skills/messenger/` and `skills/rendering/` are skills for
  `../ml-messenger` and `../ml-regl` (invoked as `/ml-regl:messenger` and
  `/ml-regl:rendering`). Each has a `SKILL.md` and `references/api.md` and
  `references/examples.md`. They describe the sibling repositories' APIs, so
  update them when those APIs change. Copy code into `examples.md` only from
  a project that compiled against the installed libraries (and, for
  rendering, was looked at through this server), not from memory.
- The skills run in users' own projects. They assume the OCaml packages are
  already installed, so they carry no install steps. They never refer to local
  checkouts or sibling paths (`../ml-messenger`, `messenger-template`): they
  read installed sources through `ocamlfind query` and link to GitHub for
  anything else. Projects make their own assets. A font atlas is generated
  from a downloaded TTF with `msdf-bmfont-xml`, and images are drawn, for
  example with ImageMagick. Do not point at ml-messenger's test assets.
- Codex installs the same plugin. It reads `.claude-plugin/marketplace.json`,
  the portable manifest `plugin.json` at the root (Agent Plugins schema
  1.0.0), the skills in `skills/`, and the server in the root `mcp.json`: a
  stdio server running `sh ./bin/plugin-server` with `cwd` `${PLUGIN_ROOT}`.
  Codex does not expand `${CLAUDE_PLUGIN_ROOT}` in a command, so the Claude
  manifest's server fails to start there ("No such file or directory"); Claude
  Code does not read `mcp.json` (only `.mcp.json`). Checked with Codex CLI
  0.157.1.
- Test the Codex side without a model call or your own config: with
  `CODEX_HOME` pointing at a scratch directory, `codex plugin marketplace add
  .` and `codex plugin add ml-regl@ml-regl`, then run `codex app-server` and
  send `initialize` and `mcpServerStatus/list`: the result lists the server's
  tools, or its startup error. `codex debug prompt-input` shows the skills.
- The plugin version is in `.claude-plugin/plugin.json`, the root
  `plugin.json` and `package.json`; bump all three together so `claude plugin
  update` and Codex pick up changes.
- npm's `files` stays `["src"]`: the plugin files are not part of the npm
  package.
- Check with `claude plugin validate . --strict` (marketplace),
  `claude plugin validate .claude-plugin/plugin.json --strict`, and
  `claude plugin validate skills --strict`. To try changes without
  installing, run `claude --plugin-dir .`.

## Run and configure

```sh
npm install
npm start                    # MCP on stdio, WebSocket on ws://127.0.0.1:8765
npm test                     # node --test (both tests above)
```

- `ML_REGL_MCP_HOST` (default `127.0.0.1`) and `ML_REGL_MCP_PORT` (default
  `8765`; `0` picks an ephemeral port, which tests read from the stderr line
  `ml-regl-mcp: WebSocket listener ws://HOST:PORT`).
- All diagnostics go to **stderr**. stdout is the MCP stream, so never write to it.
- Desktop game: `DECLGL_CONTROL_URL=ws://127.0.0.1:8765` plus either
  `DECLGL_DEBUG=1` (also enables logs) or `DECLGL_REMOTE_CONTROL=1`. Accepted
  truthy values are `1`, `true`, `yes`, and `on`.
- Browser game: open the page with `#mcp=ws://127.0.0.1:8765` (preferred),
  `#control=…`, `?mcp=ws://…`, or `?control=ws://…`.

## MCP surface

| Tool | Wire method | Notes |
| --- | --- | --- |
| `ml_regl_list_games` | (local) | id, runtime, protocol, capabilities, connectedAt/lastSeenAt, latestFrame, hasState, logCount |
| `ml_regl_get_state` | `get_state` | `{paused, frame, time_ms, logs[], published?}` |
| `ml_regl_get_render_tree` | `get_render_tree` | summary of the last rendered frame: `{available, frame, nodes, depth, programs, effects, texts[], outline[]}`; never the full tree |
| `ml_regl_query_render_tree` | `get_render_tree` | `path`, `program`, `text`, `depth`, `limit`, `fullArrays`; returns `{matches[], total, truncated}` with fields |
| `ml_regl_pause` / `ml_regl_resume` | `pause` / `resume` | `{paused}` |
| `ml_regl_step` | `pause`, `get_state`, `step` | `frames` 1..100000 (default 1), optional `dtMs` ≥ 0 sent as `dt_ms`, `wait` (default true), `timeoutMs` (longest wait); returns `{done, frame, time_ms, paused}` once the frames ran; stops waiting when the call is cancelled |
| `ml_regl_set_time` | `set_time` | `milliseconds` ≥ 0 sent as `ms` |
| `ml_regl_send_input` | `input` | `kind` ∈ key_down, key_up, key_press (down then up), mouse_down, mouse_up, mouse_move; `code`, `button` 1..5, `x`, `y` |
| `ml_regl_send_keys` | `pause` and `get_state` once, then `input`, `step` per key | `keys[]`, `holdFrames` (default 0), `framesAfter` (default 1), `dtMs`, `timeoutMs` (the whole call, default 60 s); returns `{pressed, done, frame, time_ms, paused}`, with `done: false` and `waitingFor` when time ran out; a cancelled call presses no more keys |
| `ml_regl_screenshot` | `screenshot` with `area: "view"`, `scale: "virtual"` | `region` (virtual units), `format` jpeg/png (default jpeg), `quality` (70), `maxWidth` (1280), `path` (desktop: keep the file; sent as given, so a relative path is relative to the game); the host draws the latest frame again, crops, scales to the virtual size and encodes; returns info (size, `view`, `virtual`, `pixelsPerUnit`, `savedPath`) plus MCP `image` content |
| `ml_regl_quit` | `quit` | `{quit: true}` |
| resource `ml-regl://games` | (local) | same JSON as `ml_regl_list_games` |

Every game tool takes an optional `gameId`. Omit it only when exactly one host
is connected. Tool results are pretty-printed JSON text (2-space indent).
Host `ok:false` responses, timeouts, and disconnects become MCP tool errors
(`isError`) whose text is the host's message. Schema violations come back as
`-32602 Input validation error`.

## What is supported (verified 2026-10-01)

Tested with Node 24.19, SDK 1.30.0, ml-regl `0707af0` (installed opam libraries
at `2b56720`), declgl-desktop `fe433bd`, ml-regl-js `146d1c1`, ml-messenger
`f2b98c1`, and headless Chrome 154 with SwiftShader. Results: `npm test` 2/2.
ml-messenger's `dune runtest` passes. MCP-driven desktop scenarios 38/38,
fake-host protocol edge cases 15/15, browser scenarios 17/17 (after the
test was adjusted for the browser render-tree shape described below).

| Capability | Desktop | Browser |
| --- | --- | --- |
| Connect, hello, capabilities | ✅ | ✅ |
| Several games at once, picked by `gameId` | ✅ (2 concurrent) | not tested concurrently |
| Pause freezes frames; resume restarts them | ✅ | ✅ |
| `step N` advances exactly N frames | ✅ | ✅ |
| Deterministic clock (`set_time 1000` + 3 steps × 10 ms gives `time_ms` 1030) | ✅ | ✅ |
| Input injection (keys, mouse move/down/up) reaches ml-messenger scenes | ✅ | ✅ |
| Render tree JSON (textbox strings readable) | ✅ | ✅ (different shape) |
| Screenshot | ✅ BMP file | ✅ PNG image (verified 2026-10-02; old ml-regl-js bundles are blank, see below) |
| Quit | ✅ process exits 0 | ⚠️ loop stops; host becomes a zombie |
| Game started before the server connects when the server comes up | ✅ (ixwebsocket retries) | n/a |
| Game reconnects after the MCP server restarts | ✅ (gets a new `game-N` id) | ❌ (by code reading; see below) |
| Disconnect removes the host and fails pending calls right away | ✅ | ✅ (tab close) |

Server behaviors confirmed with a scripted fake host: responses are matched
by id even when they arrive out of order; non-JSON frames and unknown ids are
ignored; `state`/`log` events update `hasState`/`logCount`; a `data:` URL
screenshot becomes MCP image content; a host that never replies fails after
about 5 s.

## What is not supported / known limitations

Gaps in this server:

- **No event streaming.** The server caches `state` events, the last 64
  `log` events (with levels), and `frame` events per host, but no tool returns
  that cache. `get_state` always asks the game. There are no MCP notifications,
  resource subscriptions, or `listChanged` for `ml-regl://games`.
- **Waiting covers stepped frames only.** `ml_regl_step` and `ml_regl_send_keys`
  return once their frames have run (they watch the hosts' `frame` events and
  poll `get_state`); there is no wait for an arbitrary condition.
- **No game lifecycle management.** The server cannot launch, restart, or
  reload a game, change scenes directly, resize windows, or inspect audio.
- **Limited input vocabulary.** There is no wheel, touch, gamepad, or text
  input, and no modifier combinations. Keys have `key_press` and
  `ml_regl_send_keys`; a click is still three calls (move, down, up). A
  `key_down` without `code` is accepted and delivers an empty key code.
- **Fixed limits.** The command timeout is 5 s and cannot be configured. A
  host that never sends `hello` with `protocol` blocks commands for up to 5 s
  and then fails with "not ready". The protocol version is not checked (any
  non-null value counts as ready), and advertised `capabilities` are not
  enforced.
- **64 MiB WebSocket `maxPayload`.** A larger host message closes that host's
  socket with code 1009. Render trees only travel from the host to the server;
  agents get the summary or query results, which are bounded.
- **A port collision does not stop the server.** A second server on the same
  port (for example, two MCP clients) logs `EADDRINUSE` on stderr and keeps
  serving MCP with no listener, so every call says "no game host is
  connected". The only other signal is a `WARNING` line in its instructions.
- **No authentication or Origin check** on the listener. Any local process,
  or any web page open in a local browser, can register as a game host. Keep
  the bind at `127.0.0.1`. `ControlProtocol.md` suggests putting tokens in the
  browser URL fragment, but this server does not check any token.
- **Ids are not stable.** `game-N` comes from a per-process counter, and a
  reconnect gets a new id.
- `ml_regl_screenshot` is annotated `readOnlyHint` even though desktop hosts
  write a temporary file (the server deletes it unless `path` was given).

Host behaviors to know when driving games (these come from ml-regl, not this
repo):

- **Mouse coordinates are virtual**, in the app's `virtual_size` (800×600 for
  `test/test.ml`, 1920×1080 for `messenger_test`), not window pixels. Injected
  events bypass the host's window-to-virtual mapping.
- **Input while paused is applied immediately** to the OCaml model, but the
  render tree and screenshot only change after a frame runs (`step 1`).
- **`step` and `set_time` switch the clock to controlled mode for good.** It
  continues from the game's current time. After `resume`, time keeps advancing by `dt_ms` per frame, not by
  wall clock. Restarting the game is the only way back to wall-clock time.
- **The render tree JSON differs by runtime.** Desktop uses
  `fields[].value.numbers` / `value.number` and omits empty fields. Browser
  uses `fields[].val.numberArrayValue.values` / `val.numberValue` and includes
  `effects: []` and `camera: null`. `src/render_tree.js` normalizes both, so
  the summary and query results are the same on both hosts.
- **`get_state` details.** Desktop omits `published` when nothing was
  published and reports wall-clock `time_ms`. Browser returns
  `published: null`, and `time_ms` is the loop time until the clock is
  controlled (`null` from ml-regl-js before `d8860ce`).
  `logs` are plain strings with no levels.
- **Desktop screenshot.** The game process draws the latest render tree
  again (after a swap the back buffer holds the frame before, which older
  hosts returned), reads the window back
  buffer (1419×1670 with letterbox bars in testing; a fixed 1280×800 window
  came out 1279×800 under niri at scale 1.75), crops it to the view or a
  region, scales it with a box filter to the virtual size and writes BMP,
  PNG (SDL) or JPEG (stb_image_write). A relative path is relative to the
  game's working directory, missing directories are created, and errors name
  the path and the reason. The server uses a temporary file and deletes it;
  a 1280×720 JPEG was about 50 KB.
- **Browser screenshots redraw the latest frame.** The WebGL context has no
  `preserveDrawingBuffer`, so the browser clears the canvas once a frame is
  shown. ml-regl-js answers `screenshot` at once by drawing the last render
  tree again, without updating the model, and capturing it in the same task.
  Older ml-regl-js bundles read the canvas before drawing and return a fully
  transparent PNG: download the bundle again, or pass `MlREGL.init(canvas, MlApp, { attributes: { antialias:
  false, depth: false, premultipliedAlpha: true, preserveDrawingBuffer: true }
  })`. That object replaces the whole default `attributes`.
- **Browser hosts in background tabs.** ml-regl-js applies commands as they
  arrive and runs stepped frames from a `MessageChannel`, so a hidden tab
  answers and steps at full speed (10 frames in about 10 ms in testing).
  Its own frames follow `requestAnimationFrame`, which a hidden tab does not
  get: after `resume` a hidden game stands still. Bundles before this change
  answered commands only in animation frames, so a hidden tab answered
  nothing, or one command a second when throttled.
- **`frame` events count frames run.** Their `frame` equals `get_state`'s
  afterwards, so a step of n from frame F ends with the event for F + n.
  Older desktop hosts sent the frame's index (one less), so every desktop
  wait ended only at the next quarter-second `get_state` poll.
- **Browser quit is not an exit.** It stops the loop and audio, but the socket
  stays open, so the host stays listed and every later command times out
  until the tab is closed or reloaded.
- **Browser hosts do not reconnect.** The socket only opens at `start()` or on
  the next debug emit. Restarting the MCP server orphans running tabs, so
  reload them.
- **ml-messenger never calls `Regl_debug.publish_state` or `Regl_debug.log`.**
  `published` and `logs` stay empty for its apps. Observe them through the
  render tree (textbox strings) and screenshots instead.
- Desktop games always open a real SDL window. No headless desktop mode was
  tested.

## Verified against ml-messenger

To repeat the MCP-level checks (the scratch scripts were not kept):

1. In `../ml-messenger`, run `dune build && dune runtest`. This builds
   `_build/default/test/test_desktop.exe`, `test/messenger_test/main_desktop.exe`,
   `test/test.bc.js`, and `test/messenger_test/main.bc.js` against the
   opam-installed `regl_desktop`/`regl_js`.
2. Desktop: start the server with `ML_REGL_MCP_PORT=<port>` through an SDK
   `Client` + `StdioClientTransport`. Spawn each exe **with cwd
   `../ml-messenger`** (asset paths are `./test/messenger_test/...`) and the
   `DECLGL_*` variables. Useful assertions:
   - `test_desktop.exe`: the rect color is `[0.25,0.45,0.9,1]`, and becomes
     `[0.2,0.8,0.35,1]` after `mouse_move` to (400,300) plus `step 1`.
   - `messenger_test`: the Home tree contains "ml-messenger migration test".
     `Digit6` gives "Button Status: IDLE". `mouse_down` at (200,200) gives
     "PRESSED". `Backspace` plus about 120 steps of 16 ms returns to Home.
     `Digit2` opens Stress, which has a large tree.
3. Browser: ml-messenger's `ml-regl-js` submodule is usually empty. Download
   the published bundle (`https://cdn.jsdelivr.net/npm/ml-regl-js@<version>/dist/regl.js`)
   or, to test unpublished host changes, build it from `../ml-regl/ml-regl-js`
   (`pnpm i`, `make build`). Serve a root that has
   `ml-regl-js/build/regl.js`, `_build/default/test/...bc.js`, and
   `test/messenger_test/assets`, then open `index.html#mcp=ws://127.0.0.1:<port>`
   in `google-chrome --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader`.

Clean up afterwards: quit or kill games, kill Chrome and the HTTP server, and
remove generated `mcp_frame_*.bmp` files.

## Change discipline

- Keep `server.js` a thin mapping from MCP tools to wire methods. Correlation,
  timeouts, waiting, and registry logic belong in `game_host.js`; render-tree
  processing in `render_tree.js`. Images are cropped and encoded by the
  hosts, not here. Tools may combine
  existing wire methods and process their results, but never extend the
  protocol on the server side.
- The MCP `instructions` are the only setup guidance a new agent session gets.
  Keep them in sync with tool and host behavior. Build URLs from `controlUrl()`
  and never hardcode a port, because users change `ML_REGL_MCP_PORT`.
- Tool names use the `ml_regl_` prefix, and inputs are validated with zod. Use
  camelCase on the MCP side and snake_case on the wire (`dtMs` → `dt_ms`,
  `milliseconds` → `ms`).
- When adding a tool, also add it to `test/mcp_stdio.test.js`. If it needs
  host behavior, add it to the protocol and both hosts in `../ml-regl` first.
- Desktop e2e tests open windows and depend on sibling build outputs. Keep
  fast tests runnable without them.
- Follow the existing Conventional Commit style (`feat:`, `fix:`, `chore:`).
