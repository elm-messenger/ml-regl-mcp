---
name: messenger
description: Build and change OCaml games on the ml-messenger framework (modules Messenger and Messenger_extra, rendered by ml-regl on a desktop SDL3/OpenGL or browser js_of_ocaml backend). Covers app layout, scenes, components with their own message types, parent-owned message unions and ports, composite components (layers), global components, scene keys with typed parameters, input, rendering, text and resources, audio, camera, storage, transitions, and how to build and test headlessly. Use this whenever working in a dune project that depends on ml-messenger or opens Messenger, when starting a new messenger game, scene, or component, or when the user mentions ml-messenger, messenger scenes/components/layers/global components, or SOMs, even if they do not name the skill. For how to draw inside a view, the rendering skill is the better fit.
---

# Building games with ml-messenger

ml-messenger is an Elm-style game framework for OCaml. Scenes and components
are pure state machines (`init`, `update`, `updaterec`, `view`) that exchange
typed messages; side effects (changing scene, playing audio, loading
resources, saving values) are returned as scene output messages (SOMs) that
the framework performs. ml-regl turns the declarative renderables a `view`
returns into frames on the desktop (`regl_desktop`) or in the browser
(`regl_js`). The same application source runs on both.

For how to draw (shapes, text, textures, effects, cameras, custom shaders),
use the `rendering` skill from the same plugin. Read `references/api.md` for signatures (configuration, scenes, components,
global components, events, drawing, resources, audio, camera, storage, the
extras) and `references/examples.md` for complete, compiling code (a menu with
a composite button bar, a game scene started with typed parameters, a HUD
global component, a transition, `app.ml`, and a headless test).

When a signature here and the installed library disagree, the library wins:
dune installs the sources, so read them, e.g.
`$(ocamlfind query ml-messenger.core)/scene.ml` or `component.ml`, and
`$(ocamlfind query ml_regl_core)/regl_builtin_programs.mli`.

## Setup

The ml-regl and ml-messenger packages are opam-pinned to local checkouts and
installed with each repository's `install.sh` (ml-regl first). An application
depends on `ml-messenger`, which brings `Messenger`, `Messenger_extra`, and
`Ml_regl_core` into scope, plus exactly one backend:

```dune
(libraries ml-messenger regl_desktop)   ; or regl_js with (modes js)
```

A starting project (`messenger-template`, next to ml-messenger) has this
layout; follow it for new apps:

```
dune-project
bin/dune         (executable (name main) (libraries regl_desktop game))
bin/main.ml      let () = Messenger.Ui.gen_main Game.App.input
src/dune         (include_subdirs qualified)
                 (library (name game) (libraries ml-messenger))
src/app.ml       Ui.input: config, resources, scene table, global components
src/user_data.ml shared user data type and default
src/scenes/<name>/model.ml           a scene, exposing [scene]
src/scenes/<name>/<child>/model.ml   a component owned by that scene
```

Keeping the game a library separate from the executable lets a test link it
without opening a window, and lets a browser executable reuse it.

## The model in one page

Every callback takes `runtime env` first. `runtime` is read-only input state
and loaded assets (query it with `Base.get_*`). `env` is the functional
environment: `env.global_data.user_data`, `env.global_data.camera`, and
`env.common_data` (data a parent shares with its children). **Return the env
you were given, or an updated copy, from every update**; dropping a child's
returned env loses its changes.

- **Scene**: `{ init; update; view }` passed to `Scene.abstract`. `init`
  gets `'param option`. `update` returns `(data, soms, env)`. `view` returns
  a `Regl_common.renderable`. Expose `let scene params runtime env =
  Scene.abstract { init; update; view } params runtime env` and register it
  in `app.ml`.
- **Component**: its module defines its own `msg`, `init`, and `data` types
  and a record literal `{ Component.init; update; updaterec; view; targets }`.
  `update` handles events and returns `(data, cmds, (env, block))`;
  `updaterec` handles messages and returns `(data, cmds, env)`; `view`
  returns `(renderable, z)`; `targets` lists the addresses it answers to.
  A component emits `Component.cmd`s:
  - `Parent m`: its own message, to its parent;
  - `Other (target, m)`: its own message, to siblings of the same kind;
  - `Sibling (target, p)`: a parent-union value it was handed in its init;
  - `Som som`: a scene output message.
- **Parent** (a scene or a component with children): defines the union of
  its direct children's messages, `type msg = Button of Button.Model.msg |
  ...`, and one `Component.port` per child kind. It creates children with
  `Component.make port spec init runtime env`, updates them with
  `Component.update_children`, sends them messages in its own union with
  `Component.send`, and draws them with `Component.view_components` (sorted
  by z). A component with children (what Elm messenger calls a layer)
  defines `msg` for its parent and `child_msg` for its children and
  translates between them.
- **Global component**: lives above scenes (FPS meter, HUD, transitions,
  loading screen). It defines its own `msg` type and a
  `msg Global_component.key`, is built with `Global_component.make`, and is
  called with `SOMCallGC (key, msg)`.
- **Scenes change** with `SOMChangeScene (By_name "Menu")`, or with typed
  parameters `SOMChangeScene (By_key (Game_params.key, { level = 2 }))` for
  a scene registered with `Scene.entry Game_params.key`.

## Rules that prevent the common mistakes

- **Children never name their parent's types.** The parent's union refers to
  the child's module; if the child referred back, the modules would form a
  cycle. Children report with their own `msg` (`Parent m`); the parent's port
  wraps it. When a child must message a sibling of another kind, the parent
  passes a capability in the child's init, e.g. `{ to_badge = badge.wrap }`,
  and the child emits `Sibling ("badge", d.to_badge msg)`.
- **Mind `(include_subdirs qualified)` dependencies.** A reference to a
  subdirectory depends on everything in it. A child may read plain modules in
  ancestor directories (`user_data.ml`, a scene's `common.ml`), but those must
  not reference the children. Sibling directories may reference each other in
  one direction only. Inside a group, use relative paths (`Bar.Model`, not
  `Scenes.Menu.Bar.Model`). Put keys and parameter types that several scenes
  use in plain modules next to the scene directories
  (`scenes/game_params.ml`); a scene referencing another scene's directory
  cycles as soon as navigation goes both ways.
- **The user data type lives in its own module** (`user_data.ml`), not in
  `app.ml`: `app.ml` references every scene, so scenes cannot reference it.
- **Write specs and global components as record literals at top level.** A
  record of functions stays polymorphic; building it through a function call
  can leave weak type variables, which the compiler rejects at the end of a
  module without an interface.
- **Targets are compared structurally and hashed**: use strings, ints, or
  simple variants (`Id of int | Kind of string`), never values containing
  functions. Messages addressed to a target nobody answers to are dropped.
- **Child lists need a type annotation** naming the parent's types:
  `(cdata, User_data.t, target, msg, view) Component.t list`. `cdata` is the
  common data the parent passes (often `unit`), `view` is what
  `Component.inspect` returns (`unit` unless the parent created the ports with
  `Component.port_with ~inspect`, used to read child state such as positions
  for collisions; all children in one list share it).
- **Input order and draw order are independent.** Events go to children from
  the end of the list to the front, and a child returning `block = true` stops
  the rest; drawing sorts by the z returned from `view`. Put the topmost
  interactive child last.
- **Ticks carry absolute milliseconds** (`UpdateTick now`); keep the last
  value to compute a delta. Key names follow SDL (`"Space"`, `"Return"`,
  `"Backspace"`, `"Left"`, `"A"`); mouse buttons are 1-based;
  `Messenger_extra.Key_code` names the common ones.
- **Coordinates**: the origin is the top-left, y grows downward, and the
  unit is the configured `virtual_size`. Mouse positions are in that space
  too; with a moved or zoomed camera, convert with
  `Camera.mouse_to_camera_space`. `Base.get_virtual_size runtime` gives the
  size instead of hard-coding it.
- **Text needs a loaded font.** `textbox` takes a font resource name; without
  a `Font_res` (an MSDF atlas PNG plus its BMFont-style JSON) nothing is
  drawn. Resource paths are relative to the working directory on desktop (run
  the app from the project root) and to the page in the browser. The
  ml-messenger repository ships a font to copy:
  `test/messenger_test/assets/fonts/FiraCode-Regular.json` and `font_0.png`
  (Fira Code, SIL Open Font License); other fonts can be made with an MSDF
  generator that writes BMFont JSON, such as `msdf-bmfont-xml` (`-f json`).
- **Assets load asynchronously.** Until a texture or font has loaded, drawing
  it shows nothing. `Messenger_extra.Asset_loading.gen_gc ()` covers the
  screen until everything has loaded; a failed load keeps it up (on purpose:
  a missing asset is a packaging error).
- **Storage replies are events.** `SOMReadValue key` is answered later by a
  `ValueRead { key; value }` event (`value = None` when nothing is stored)
  that reaches global components, the active scene, and its children.

## Building and verifying

- `dune build`, then `dune build @fmt` if the project has an `.ocamlformat`.
- Compiling is not visual verification. To check behaviour that tests
  cannot see, or how it looks, run the game under the ml-regl MCP server (see
  the next section); otherwise don't launch it, since it opens a real window.
- Test behaviour headlessly instead: a `(test ...)` stanza that links the game
  library and `regl_desktop` but never calls `Ui.gen_main`. Drive it with
  `Ui.init input ()` and `Ui.update input model (Regl_proto.Event evnt)`,
  check `Base.get_current_scene model.Model.runtime`, and check drawn text by
  searching the bytes of `Regl_common.encode_frame_pb (Ui.view input model)`
  (textbox strings are stored verbatim). Components read input from the
  event (`x`/`y`, the key) or from `Base.get_mouse_pos runtime` and
  `Base.get_pressed_keys runtime`, which `Ui.update` records from mouse and
  key events, so a held key is a `KeyDown` followed by ticks. `references/examples.md` ends with such a test.
- For a scene alone, call `(Scene.unroll scene).update` / `.view` on
  `scene None runtime env` with `runtime = Internal.empty_runtime ()` (set
  `runtime.virtual_size` if the code reads it). A backend must still be
  linked to satisfy the virtual `regl_backend` library; without `Ui` nothing
  records input state, so set `runtime.mouse_pos` and `runtime.pressed_keys`
  yourself.

## Seeing the game run (ml-regl MCP)

The plugin's `ml-regl` MCP server lets you drive a running game. Its
instructions name the WebSocket URL it listens on (default
`ws://127.0.0.1:8765`; use the one it reports).

1. Start the game from the project root in the background so resource paths
   resolve, pointing it at the server:
   `DECLGL_DEBUG=1 DECLGL_CONTROL_URL=<url> dune exec ./bin/main.exe`.
   A browser build connects when its page URL ends in `#mcp=<url>`.
2. `ml_regl_list_games` should show it. `ml_regl_pause`, then drive it with
   `ml_regl_send_input` (SDL key names; mouse positions in virtual units,
   not window pixels) and `ml_regl_step` (`frames`, `dtMs`).
3. `step` returns once frames are queued: poll `ml_regl_get_state` until
   `frame` has advanced before looking. Input sent while paused is applied
   at once, but the picture changes only after a step.
4. Look with `ml_regl_get_render_tree` (search its string leaves for
   textbox text; trees of busy scenes are very large) or
   `ml_regl_screenshot` (desktop writes a BMP into the game's working
   directory and returns its path; view it, then delete it).
5. `ml_regl_quit` when done.

`step` and `ml_regl_set_time` switch the game to a controlled clock until it
restarts. ml-messenger publishes no state or logs, so observe through the
render tree and screenshots. Only one server can listen on a port; if every
call says no game is connected, another server (for example a manually added
`ml-regl` MCP entry) may hold it.

## Where to look next

- The `rendering` skill: drawing with ml-regl in a `view`.

- `references/api.md`: signatures and the list of scene output messages.
- `references/examples.md`: complete compiling examples.
- In the ml-messenger repository: `test/messenger_test` (interaction,
  nested components, portable components, camera, audio, transitions,
  sprite sheets) and `AGENTS.md`.
