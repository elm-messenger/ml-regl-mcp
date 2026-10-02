---
name: rendering
description: Write and debug rendering code with ml-regl (Ml_regl_core) for OCaml games on the desktop (SDL3/OpenGL) and browser (WebGL) hosts. Covers the declarative renderable tree, coordinates and cameras, built-in shapes, text and MSDF fonts, textures and sprite sheets, effects and compositors, custom GLSL programs, standalone ml-regl apps (Regl_backend.create_app), and checking the picture through the ml-regl MCP server. Use this whenever writing or changing a view or draw function in an ml-regl or ml-messenger game, adding a shader or visual effect, laying out text, loading textures or fonts, or when something draws blank, in the wrong place, or differently on desktop and in the browser.
---

# Rendering with ml-regl

A view in ml-regl is a pure function that returns a tree of renderables
(`Regl_common.renderable`) every frame. The tree is a description: the host
(desktop or browser) draws it, so there is no GPU state to manage in OCaml.
The modules live in `Ml_regl_core`:

- `Regl_common`: the tree (`group`, `group_with_camera`, `atomic`,
  `composite`) and draw-call fields (`num`, `nums`, `str`, ...).
- `Regl_builtin_programs`: shapes, text, textures.
- `Regl_effects`, `Regl_compositors`: post-processing and combining images.
- `Regl_program`: custom GLSL programs.
- `Regl_proto`: commands to the host (start, load textures/fonts, create
  programs) and the replies and events it sends back.
- `Color`: `rgb`, `rgba`, named colors.

In ml-messenger a scene's `view` returns a renderable and a component's view
returns `(renderable, z)`; see the `messenger` skill for that framework.
`references/api.md` lists every signature and `references/examples.md` is a
complete standalone app that was compiled and checked on screen.

## Coordinates and the camera

- Positions are in virtual units: the virtual size from the start config
  (`virt_width`, `virt_height`; ml-messenger's `virtual_size`). The origin
  is the top-left corner and y grows downward. The host scales and
  letterboxes the virtual area into the window.
- A camera `{ x; y; zoom; rotation }` puts the world point `(x, y)` at the
  center of the view and `zoom > 1` magnifies. A camera
  at `(width /. 2., height /. 2.)` with zoom 1 shows exactly the virtual
  area. `Regl_common.group_with_camera camera effects children` draws
  children through a camera; ml-messenger applies the environment's camera to
  every scene view for you (but not to global components' views).
- Corners or centers: `rect`, `rect_texture*`, `textbox` and `textbox_pro`
  take the top-left corner; `rect_centered`, `centered_texture*`, `circle`,
  `rounded_rect` and `textbox_centered` take the center.
- Angles (`rect_centered`, `centered_texture*`) and camera rotations are
  radians; positive values turn the picture counterclockwise on screen.
- A camera group replaces the enclosing camera for its subtree; cameras do
  not combine. In ml-messenger, a component that draws inside its own
  `group_with_camera` is therefore not moved by the scene camera.
- Only `rect_centered` and `centered_texture*` take an angle. To turn other
  shapes, rotate their points and draw `triangle`/`quad`/`poly`, or draw them
  in a camera group: a camera puts its point at the view center and turns the
  picture around it, so to turn `children` by `a` around `(px, py)` and keep
  that point in place, use the camera
  `{ x = px -. (cos a *. dx -. sin a *. dy); y = py -. (sin a *. dx +. cos a *. dy); zoom = 1.; rotation = a }`
  with `(dx, dy)` = `(px, py)` minus the view center (`rotate_around` in
  `references/examples.md`).

## The tree

- `Regl_common.group effects children` draws `children` in list order, later
  ones on top. Put `Regl_builtin_programs.clear color` first: it fills the
  whole view and would cover anything drawn before it.
- `Regl_builtin_programs.empty` draws nothing; use it for "not ready yet".
- A group with effects is drawn into an offscreen buffer and the effects are
  applied to that image in order; `Regl_compositors` combine two renderables'
  images (fades, masks). Both use offscreen buffers from a pool that starts
  at the start config's `fbo_num` (5 is typical) and grows when needed, with
  a warning, up to 1000 buffers; past that the subtree is dropped. Groups
  without effects, with or without a camera, draw straight into their
  parent's buffer and cost nothing from the pool.
- A compositor side that draws nothing (`empty`, or a group with no draw
  call in it) counts as a fully transparent image, so `linear_fade 0.5 a
  empty` shows `a` at half opacity. Only a compositor with both sides empty
  draws nothing.
- The whole tree is encoded and sent every frame, so keep it proportional to
  what is on screen.

## Text

Text needs a font loaded under a name: an MSDF atlas image plus its
BMFont-style JSON (`Regl_proto.load_font name png json`, or ml-messenger's
`Font_res`). Until the host reports it loaded, text draws nothing.
Make the atlas from a TTF or OTF file: download a font whose license allows
embedding it (Google Fonts' OFL fonts do), then generate it with
`msdf-bmfont-xml`:

```sh
mkdir -p assets
curl -L -o FiraSans-Regular.ttf https://github.com/google/fonts/raw/main/ofl/firasans/FiraSans-Regular.ttf
npx -y msdf-bmfont-xml -f json --smart-size --pot -d 2 -o assets/font FiraSans-Regular.ttf
mv assets/FiraSans-Regular.json assets/font.json
```

`--smart-size` shrinks the atlas to fit the glyphs, `--pot` keeps its sides
powers of two, and `-d 2` keeps two decimals in the glyph metrics (the
default rounds them to whole pixels). `-o` names the atlas
(`assets/font.png`), but the JSON is always named after the font's face, so
rename it. Keep the default field type, `msdf`. When the result needs
something else, run `npx -y msdf-bmfont-xml --help` and explore the other
options, for example `-i chars.txt` for characters beyond printable ASCII,
`-s` for the glyph size, `-r` for the distance range, and `-m` for the
largest atlas size.

- `textbox pos size text font color`: `pos` is the top-left of the text and
  `size` the height of one line in virtual units: glyphs are scaled by `size`
  over the font's `common.lineHeight`, so their em size is `size *
  info.size / lineHeight` (from the font's JSON), which differs per font.
  `\n` breaks lines.
- `textbox_centered center size text font color`.
- `textbox_mf` / `textbox_mf_centered` take a list of fonts, used as
  fallbacks for missing glyphs.
- `textbox_pro pos { default_textbox_option with fonts = [ "font" ]; ... }`
  sets everything else. Set `fonts`: the default is `[ "consolas" ]`.
  `width` wraps lines at word boundaries, and `word_break = true` also breaks
  inside words; `align` is `"left"`, `"center"` or `"right"`, `valign`
  `"top"`, `"center"` or `"bottom"`; `line_height` and `word_spacing` are
  multipliers (default 1), `tab_size` counts spaces (default 4).
- Measure text before drawing it with `Regl_text`: read the font's JSON (the
  file given to `load_font`) with `Regl_proto.load_file`, parse it with
  `Regl_text.parse_bmfont`, then `Regl_text.measure fonts size text` (or
  `measure_textbox lookup option`) returns each line's width and the height,
  laid out exactly as the textbox does; `align` uses that width. In
  ml-messenger, `Base.measure_text` does this for loaded fonts.
- A character missing from the atlas makes the browser draw nothing for that
  textbox (the desktop skips the character), so generate the atlas with every
  character you draw (`-i chars.txt`). msdf-bmfont-xml takes kerning only
  from a font's legacy `kern` table; many fonts have none and stay unkerned.

## Textures and sprite sheets

- Load with `load_texture name path options` (ml-messenger: `Texture_res`),
  where `options` is `None` or `Some { default_texture_options with ... }`.
  The host replies `REGLTextureLoaded { name; width; height }`; drawing a
  texture that has not loaded draws nothing. A texture shows the image as it
  is in the file, on both hosts.
- `crop = Some ((x, y), (w, h))` (pixels from the image's top-left) loads
  part of an image as its own texture. Load the same sheet several times
  under different names to cut a sprite sheet. `mag = Some MagNearest` keeps
  pixel art crisp. `flip_y = true` mirrors the texture vertically (after the
  crop). Font atlases are separate and never flipped.
- Draw with `rect_texture pos size name`, `centered_texture center size angle
  name`, the `_with_alpha` variants, or `texture` with four corner points.
  `rect_texture_cropped` and `centered_texture_cropped` draw part of a
  texture, given as a position and size in fractions (0 to 1) of the texture
  from its top-left corner. `texture_cropped` instead takes a texture
  coordinate per corner, with (0, 0) at the texture's bottom-left and (1, 1)
  at its top-right.
- A custom program samples textures in the same coordinates: v = 1 is the
  top of the image.
- ml-messenger: `Render_texture.render_sprite runtime pos (w, h) name` keeps
  the aspect ratio when `w` or `h` is `0.`.

## Effects and compositors

Built-in effects go in a group's effect list: `alpha_mult a`, `color_mult r
g b a`, `pixilation s`, `outline width color`, `crt count`, `fxaa`, and the
blurs `blur r` / `gblur r`, which return lists
(`group (Regl_effects.blur 2. @ [ Regl_effects.fxaa ]) children`).
Compositors take two renderables: `linear_fade t a b`, `img_fade mask t
invert a b`, `dst_over_src a b`, `mask_by_src a b`.

Custom effects and compositors are programs (next section) whose inputs
are images the host binds:

- `Regl_program.make_effect_simple frag uniforms` supplies a full-view
  vertex shader and binds the group's image to `uniform sampler2D texture`;
  `varying vec2 vuv` runs from 0 to 1 across the view, with y up (0 at the
  bottom). Apply it with `Regl_common.mk_effect name fields` in a group's
  effect list.
- `Regl_program.make_compositor_simple frag uniforms` binds the first
  renderable's image to `t1` and the second's to `t2`; draw it with
  `Regl_common.composite name fields a b`.
- `make_effect_program sampler program` and `make_compositor_program
  sampler1 sampler2 program` add the same bindings to a program with its own
  vertex shader and sampler names.
- The images are premultiplied, so keep the output premultiplied: to fade,
  scale all four components together. Each effect or compositor takes a
  buffer from the `fbo_num` pool.

## Custom programs

A custom draw program is a `Regl_program.regl_program` record: GLSL vertex
and fragment source plus how each attribute and uniform gets its value.

- Write GLSL ES 1.00 (`precision mediump float;`, `attribute`, `varying`,
  `texture2D`, `gl_FragColor`) and register it with
  `Regl_proto.create_regl_program ~shader_language:GlslEs100 name program`.
  The default, `Glsl`, means each host's native language (desktop GLSL 3.30
  core versus WebGL GLSL ES), so one source cannot satisfy both. The desktop
  translates ES 1.00 to 3.30 and renames identifiers that would clash with
  GLSL 3.30 functions (`texture`, `textureProj`), so a sampler may be named
  `texture`.
- `DynamicValue "k"` takes the value of the draw call's field `k`;
  `StaticValue` (`Regl_program.static_number`, `static_numbers`, ...) is a
  constant; `DynamicTextureValue "k"` binds the texture named by the string
  field `k`. `elements` lists vertex indices (triangles by default);
  `primitive` and `count` override the primitive and vertex count.
- A numeric uniform gets as many numbers as its GLSL type has components:
  `num` for a `float`, `nums` with 2, 3 or 4 values for a `vec2`/`vec3`/`vec4`
  (the desktop host picks the uniform call from the count). Attributes are
  flat lists; keep them `vec2`, which both hosts read two numbers per vertex
  (the desktop host guesses other sizes from `count`), and pass per-draw
  data as uniforms.
- Every program also receives the host uniforms `view` (vec2: half the
  virtual size with y negated, `(w/2, -h/2)`) and `camera` (vec4: x, y,
  zoom, rotation). Map a virtual position `world` the way the built-ins do:
  `diff = world - camera.xy`, rotate `diff` by `-camera.w`
  (`vec2(c * diff.x + s * diff.y, -s * diff.x + c * diff.y)`), then
  `gl_Position = vec4(rotated * camera.z / view, 0., 1.)`
  (`references/examples.md` has a complete program).
- Both hosts blend premultiplied colors (`ONE, ONE_MINUS_SRC_ALPHA`), so a
  fragment shader writes `vec4(rgb * a, a)`. Writing straight alpha makes
  translucent colors too bright.
- Draw it with `Regl_common.atomic name [ Regl_common.nums "posize" [...];
  ... ]` once the host has replied `REGLProgramCreated name`; before that it
  draws nothing.
- In ml-messenger, register a program as a resource with its language:
  `("gradient", Resources.Program_res (program, GlslEs100))`.

## A standalone ml-regl app

Without ml-messenger, an app is three functions passed to
`Regl_backend.create_app init update view`, with the backend chosen by
linking `regl_desktop` or `regl_js`:

- `init () = (model, commands)`: start with `start_regl { virt_width;
  virt_height; fbo_num; builtin_programs = None; window =
  default_window_config; app_name }`, then load textures, fonts, audio, and
  create programs.
- `update model input = (model, audio, commands)`: `input` is `Event e`
  (`UpdateTick t` with `t` in milliseconds since the host's loop started,
  mouse in virtual units, SDL key names), `REGLRecvMsg r` (loads finished or
  failed), or `AudioMsg a`. `audio` is the declarative audio tree
  (`Regl_audio.silence` for none).
- `view model = renderable`.

The project needs a `dune-project` of its own, and dune builds the
executable for each backend (`references/examples.md`). On desktop, run it
from the directory the asset paths are relative to. In the browser, the page
loads the ml-regl-js host bundle and the app's `.bc.js`, both served over
HTTP, and starts the app (paths are from the served root). The bundle,
`build/regl.js`, comes from
[ml-regl-js](https://github.com/elm-messenger/ml-regl-js) (`pnpm i`, then
`make build`), at the commit ml-regl's `ml-regl-js` submodule pins, so that it
matches the installed `regl_js`:

```html
<script src="/ml-regl-js/build/regl.js"></script>
<script src="/_build/default/main_js.bc.js"></script>
<canvas id="myCanvas"></canvas>
<script>
  const canvas = document.getElementById("myCanvas");
  canvas.width = 1280; canvas.height = 720;
  MlREGL.init(canvas, MlApp, []);
  MlApp.init();
</script>
```

ml-regl's [`html/`](https://github.com/elm-messenger/ml-regl/tree/main/html)
directory has more pages like this.

## When nothing shows up

Check, in order: the resource name matches what was loaded and the load
reply has arrived; a `clear` is not drawn after the content; the color's
alpha is not 0; the camera points at the content (and ml-messenger's camera
is not moved); the effect pool is not exhausted by nesting; for custom
programs, the shader language and the `view`/`camera` mapping; in
ml-messenger, the component's z and its parent actually draws it.

## Checking the picture

Compiling proves nothing about pixels. With the plugin's `ml-regl` MCP
server, run the game from its project directory in the background with
`DECLGL_DEBUG=1 DECLGL_CONTROL_URL=<url the server reports>` (browser:
`#mcp=<url>` on the page URL), then `ml_regl_set_time 0` and `ml_regl_step`
(it pauses and returns once the frames have run) for a deterministic frame,
and look with `ml_regl_screenshot` (a JPEG of the view, letterbox cropped,
one pixel per virtual unit; `region` for part of it, `format: "png"` for
exact colours) or `ml_regl_get_render_tree` (a
summary) and `ml_regl_query_render_tree` (nodes and their fields). A program that fails to build is answered with
`REGLProgramCreateFail`; the desktop host prints the shader error to the
game's output, not to the MCP logs. `ml_regl_get_state` returns only what
the game reports itself: `Regl_debug.log` messages as `logs` and the last
`Regl_debug.publish_state` value as `published`. In the browser, a fully
transparent `ml_regl_screenshot` means the page loads an old ml-regl-js
bundle that read the canvas before drawing; rebuild the bundle (or, as a
stopgap, pass `{ attributes: { antialias: false, depth: false,
premultipliedAlpha: true, preserveDrawingBuffer: true } }` as `MlREGL.init`'s
third argument, which replaces all the default attributes).
`ml_regl_quit` when done. The window is real: launch only when you need to
look. To compare both hosts on the same app without MCP, ml-regl's
[`test/check_texture_parity.py`](https://github.com/elm-messenger/ml-regl/blob/main/test/check_texture_parity.py)
shows how to capture the desktop window and the browser page.
