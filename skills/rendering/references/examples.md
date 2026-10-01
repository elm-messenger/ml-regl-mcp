# ml-regl rendering example

A standalone ml-regl app (no ml-messenger) that compiles for both backends
and was checked on the desktop host through the ml-regl MCP server (paused,
clock set to 0, screenshot): built-in shapes, a texture cut from a sprite
sheet at load time, MSDF text, a custom draw program in virtual coordinates
(opaque and translucent), a group drawn through a camera with a built-in
effect, a shape without an angle parameter turned through a camera, a
built-in compositor, and a custom effect and compositor.

The assets are a font atlas (`assets/font.png`, `assets/font.json`) and a
32×32-cell sprite sheet (`assets/sheet.png`), copied from ml-messenger's
`test/messenger_test/assets/fonts/` (`font_0.png`, `FiraCode-Regular.json`)
and `img/sheet.png`; run it from the directory that contains `assets/`.

## `dune-project`

```dune
(lang dune 3.19)
```

## `dune`

The drawing code is a library so both executables share it; each
executable picks a backend.

```dune
(library
 (name draw)
 (modules programs scene)
 (libraries ml_regl_core))

(executable
 (name main_desktop)
 (modules main_desktop)
 (libraries regl_desktop draw))

(executable
 (name main_js)
 (modules main_js)
 (modes js)
 (libraries regl_js draw))
```

`main_desktop.ml` and `main_js.ml` are the same line:

```ocaml
let () =
  Regl_backend.create_app Draw.Scene.init Draw.Scene.update Draw.Scene.view
```

## Custom programs: `programs.ml`

GLSL ES 1.00, registered with `~shader_language:GlslEs100`. The draw
program's vertex shader places a unit quad at `posize` (top-left corner and
size in virtual units) and maps it through the host's `view` and `camera`
uniforms exactly as the built-in programs do, so the program follows cameras
like everything else. The effect and the compositor sample the images the
host binds to `texture`, `t1` and `t2`.

```ocaml
(* A custom program, written in GLSL ES 1.00 and registered with
   ~shader_language:GlslEs100 so both hosts accept it (the desktop host
   translates it to GLSL 3.30). *)
open Ml_regl_core

(* A draw program in virtual coordinates: a horizontal gradient rectangle. The
   hosts provide [view] and [camera] to every program; the vertex shader maps
   virtual positions the way the built-in programs do. *)
let gradient : Regl_program.regl_program =
  {
    frag =
      {|
precision mediump float;
uniform vec4 color_a;
uniform vec4 color_b;
varying vec2 vuv;
void main() {
  vec4 c = mix(color_a, color_b, vuv.x);
  // the hosts blend premultiplied colors
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}
|};
    vert =
      {|
precision mediump float;
attribute vec2 uv;
uniform vec4 posize;  // x, y, w, h: top-left corner and size, virtual units
uniform vec2 view;    // from the host
uniform vec4 camera;  // from the host: x, y, zoom, rotation
varying vec2 vuv;
void main() {
  vuv = uv;
  vec2 diff = posize.xy + uv * posize.zw - camera.xy;
  float c = cos(camera.w);
  float s = sin(camera.w);
  vec2 rotated = vec2(c * diff.x + s * diff.y, -s * diff.x + c * diff.y);
  gl_Position = vec4(rotated * camera.z / view, 0.0, 1.0);
}
|};
    attributes =
      Some
        [
          ("uv", Regl_program.static_numbers [ 0.; 0.; 1.; 0.; 1.; 1.; 0.; 1. ]);
        ];
    uniforms =
      Some
        [
          ("posize", DynamicValue "posize");
          ("color_a", DynamicValue "color_a");
          ("color_b", DynamicValue "color_b");
        ];
    elements = Some (Regl_program.static_numbers [ 0.; 1.; 2.; 0.; 2.; 3. ]);
    primitive = None;
    count = None;
  }

let draw_gradient (x, y) (w, h) a b =
  Regl_common.atomic "gradient"
    [
      Regl_common.nums "posize" [ x; y; w; h ];
      Regl_common.nums "color_a" (Regl_common.to_rgba_list a);
      Regl_common.nums "color_b" (Regl_common.to_rgba_list b);
    ]

(* A custom effect. The host binds the group's image to the sampler that
   [make_effect_simple] declares as [texture]; the image is premultiplied. *)
let tint : Regl_program.regl_program =
  Regl_program.make_effect_simple
    {|
precision mediump float;
uniform sampler2D texture;
uniform vec4 tint;
varying vec2 vuv;
void main() {
  vec4 c = texture2D(texture, vuv);
  gl_FragColor = vec4(c.rgb * tint.rgb, c.a) * tint.a;
}
|}
    [ ("tint", DynamicValue "tint") ]

let tint_effect color =
  Regl_common.mk_effect "tint"
    [ Regl_common.nums "tint" (Regl_common.to_rgba_list color) ]

(* A custom compositor: [t1] is the first renderable's image, [t2] the
   second's. Left of [split] (0..1 across the view) shows the first. *)
let split : Regl_program.regl_program =
  Regl_program.make_compositor_simple
    {|
precision mediump float;
uniform sampler2D t1;
uniform sampler2D t2;
uniform float split;
varying vec2 vuv;
void main() {
  gl_FragColor = vuv.x < split ? texture2D(t1, vuv) : texture2D(t2, vuv);
}
|}
    [ ("split", DynamicValue "split") ]

let draw_split at a b = Regl_common.composite "split" [ Regl_common.num "split" at ] a b

(* Commands that register them; send them from init. *)
let create_all =
  List.map
    (fun (name, program) ->
      Regl_proto.create_regl_program ~shader_language:GlslEs100 name program)
    [ ("gradient", gradient); ("tint", tint); ("split", split) ]
```

## The app: `scene.ml`

`init` starts the host and loads everything; `update` records what has
loaded (drawing a texture or program before its reply arrives draws
nothing); `view` builds the tree.

```ocaml
(* A standalone ml-regl app (no ml-messenger): init sends commands, update folds
   inputs into the model, view draws it. *)
open Ml_regl_core
open Regl_proto

type model = { now : float; ready : string list }

let width = 1280.
let height = 720.

let init () =
  let start : regl_start_config =
    {
      virt_width = width;
      virt_height = height;
      fbo_num = 5;
      builtin_programs = None;
      window = default_window_config;
      app_name = Some "Rendering example";
    }
  in
  ( { now = 0.; ready = [] },
    start_regl start
    :: config_regl (ConfigTimeInterval AnimationFrame)
    :: load_font "font" "assets/font.png" "assets/font.json"
    :: load_texture "sheet" "assets/sheet.png"
         (Some { default_texture_options with mag = Some MagNearest })
       (* one 32x32 cell of the sheet as its own texture *)
    :: load_texture "hero" "assets/sheet.png"
         (Some
            {
              default_texture_options with
              mag = Some MagNearest;
              crop = Some ((0, 0), (32, 32));
            })
    :: Programs.create_all )

let ready m name = List.mem name m.ready

(* Turn [children] by [a] radians around the virtual point [(px, py)], which
   stays in place. A camera puts its point at the view center and turns the
   picture around it, so the camera is offset accordingly. It replaces any
   enclosing camera. *)
let rotate_around (px, py) a children =
  let dx = px -. (width /. 2.) and dy = py -. (height /. 2.) in
  Regl_common.group_with_camera
    {
      Regl_common.x = px -. ((cos a *. dx) -. (sin a *. dy));
      y = py -. ((sin a *. dx) +. (cos a *. dy));
      zoom = 1.;
      rotation = a;
    }
    [] children

let update m = function
  | Event (UpdateTick now) -> ({ m with now }, Regl_audio.silence, [])
  | REGLRecvMsg (REGLTextureLoaded t) ->
      ({ m with ready = t.name :: m.ready }, Regl_audio.silence, [])
  | REGLRecvMsg (REGLFontLoaded name | REGLProgramCreated name) ->
      ({ m with ready = name :: m.ready }, Regl_audio.silence, [])
  | _ -> (m, Regl_audio.silence, [])

let view m =
  let open Regl_builtin_programs in
  let t = m.now /. 1000. in
  let world =
    [
      rect (100., 100.) (200., 120.) (Color.rgb 0.9 0.3 0.3);
      rect_centered (500., 160.) (160., 90.) t (Color.rgba 0.2 0.6 0.9 0.8);
      circle (750., 160.) 60. Color.green;
      (if ready m "hero" then centered_texture (950., 160.) (96., 96.) 0. "hero"
       else empty);
      (if ready m "gradient" then
         Programs.draw_gradient (100., 300.) (500., 80.) Color.red Color.blue
       else empty);
      rect (100., 400.) (500., 80.) Color.black;
      (if ready m "gradient" then
         Programs.draw_gradient (100., 400.) (500., 80.)
           (Color.rgba 1. 0. 0. 0.5) (Color.rgba 0. 0. 1. 0.5)
       else empty);
    ]
  in
  let camera =
    {
      Regl_common.x = 640.;
      y = 360.;
      zoom = 1. +. (0.1 *. sin t);
      rotation = 0.;
    }
  in
  Regl_common.group []
    [
      clear (Color.rgb 0.95 0.95 0.92);
      (* drawn with a camera; the effect list applies to the group's image *)
      Regl_common.group_with_camera camera [ Regl_effects.alpha_mult 0.9 ] world;
      Regl_compositors.linear_fade
        ((sin t +. 1.) /. 2.)
        (rect (900., 400.) (200., 200.) Color.red)
        (circle (1000., 500.) 100. Color.blue);
      (* a shape without an angle parameter, turned through a camera *)
      rotate_around (640., 600.) (0.5 +. t)
        [ rounded_rect (640., 600.) (160., 80.) 16. (Color.rgb 0.5 0.2 0.7) ];
      rect_centered (400., 600.) (160., 80.) (0.5 +. t) (Color.rgb 0.2 0.5 0.3);
      (* a custom effect on the texture *)
      (if ready m "hero" && ready m "tint" then
         Regl_common.group
           [ Programs.tint_effect (Color.rgba 1. 0.8 0.2 1.) ]
           [ centered_texture (1150., 160.) (96., 96.) 0. "hero" ]
       else empty);
      (* a custom compositor: red left of x = 1024, blue right of it *)
      (if ready m "split" then
         Programs.draw_split 0.8
           (rect (800., 640.) (450., 60.) Color.red)
           (rect (800., 640.) (450., 60.) Color.blue)
       else empty);
      (* text is drawn without the camera, on top *)
      textbox (20., 20.) 28. "Rendering example" "font" Color.black;
    ]
```
