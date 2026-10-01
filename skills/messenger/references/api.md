# ml-messenger API reference

Signatures as of ml-messenger with typed scene and global-component keys. In
these types `runtime` is `Messenger.Internal.runtime`, `event` is
`Ml_regl_core.Regl_proto.regl_event`, and `renderable` is
`Ml_regl_core.Regl_common.renderable`. If something here does not compile,
read the installed source (`$(ocamlfind query ml-messenger.core)/*.ml`).

## Contents

1. Application (`Ui`)
2. Environment and runtime (`Base`)
3. Scenes (`Scene`)
4. Scene output messages
5. Components (`Component`)
6. Global components (`Global_component`) and the extras
7. Events
8. Drawing
9. Resources
10. Audio
11. Camera
12. Storage

## 1. Application (`Ui`)

```ocaml
type size = { width : float; height : float }

type 'userdata user_config = {
  init_scene : Scene.target;                  (* By_name "Home" *)
  virtual_size : size;                        (* the coordinate space *)
  fbo_num : int;                              (* offscreen buffers; 5 is typical *)
  max_assets_per_frame : int;                 (* 0 = unlimited *)
  enabled_program : enabled_builtin_program;  (* AllBuiltinProgram *)
  time_interval : Regl_proto.time_interval;   (* AnimationFrame | Millisecond of float *)
  default_global_data : 'userdata Base.global_data_init;
      (* { user_data; camera; volume } *)
  app_name : string option;                   (* save_value/read_value namespace *)
  init_window : Regl_proto.window_config;
      (* default_window_config; set title = Some "Game" to name the window *)
}

type enabled_builtin_program =
  | NoBuiltinProgram | CustomBuiltinProgramList of string list
  | TextOnlyBuiltinProgram | BasicShapesBuiltinProgram | AllBuiltinProgram

type 'userdata input = {
  config : 'userdata user_config;
  resources : Resources.resource_defs;
  scenes : 'userdata Scene.all_scenes;                        (* Scene.table [...] *)
  global_components : 'userdata Scene.global_component_storage list;
}

val gen_main : 'userdata input -> unit   (* the program's entry point *)

(* For headless tests (no window): *)
val init : 'userdata input -> unit -> 'userdata Model.t * Regl_proto.regl_output list
val update : 'userdata input -> 'userdata Model.t -> Regl_proto.regl_input ->
  'userdata Model.t * Regl_audio.audio * Regl_proto.regl_output list
val view : 'userdata input -> 'userdata Model.t -> renderable
(* Regl_proto.regl_input = Event of regl_event | REGLRecvMsg _ | AudioMsg _ *)
```

## 2. Environment and runtime (`Base`)

```ocaml
type 'userdata global_data = { user_data : 'userdata; camera : Camera.t }
type ('common, 'userdata) env = {
  global_data : 'userdata global_data;
  common_data : 'common;  (* () in scenes; a parent's shared data in children *)
}

val add_common_data : 'c -> (_, 'u) env -> ('c, 'u) env
val remove_common_data : (_, 'u) env -> (unit, 'u) env
```

A scene that shares data with its children wraps the env before updating them
and unwraps it before returning: `let cenv = Base.add_common_data common env
in ... (data, soms, Base.remove_common_data cenv)`. Children read
`env.common_data`.

Runtime queries (`Base.get_* runtime`):

| Function | Returns |
|---|---|
| `get_current_timestamp r` | last tick, absolute ms |
| `get_mouse_pos r` | `(x, y)` in virtual coordinates |
| `get_pressed_keys r` | `Internal.StringSet.t` of key names |
| `get_pressed_mouse_buttons r` | `Internal.IntSet.t` (1-based) |
| `get_virtual_size r` | `(width, height)` |
| `get_current_scene r` | name of the active scene |
| `get_loading_progress r` | `(loaded, total)` resources |
| `get_sprite name r` | `Regl_proto.texture option` (`{ name; width; height }`) |
| `get_config_data key r` | contents of a loaded `Data_res`, `string option` |
| `get_local_value key r` | last saved or read storage value, `string option` |
| `get_volume r` | master volume |

## 3. Scenes (`Scene`)

```ocaml
type ('data, 'envro, 'env, 'event, 'ren, 'param, 'userdata) concrete_scene = {
  init : 'envro -> 'env -> 'param option -> 'data;
  update : 'envro -> 'env -> 'event -> 'data ->
    'data * 'userdata scene_output_msg list * 'env;
  view : 'envro -> 'env -> 'data -> 'ren;
}
(* with 'envro = runtime, 'env = (unit, 'userdata) Base.env, 'event = event,
   'ren = renderable *)

val abstract : concrete_scene -> 'param option -> runtime -> env -> abstract_scene
(* A scene module exposes:
   let scene params runtime env = Scene.abstract { init; update; view } params runtime env *)

type 'param key                                (* name + type witness *)
val key : string -> 'param key
type target = By_name of string | By_key : 'param key * 'param -> target

val named : string -> ('u, unit) scene_storage -> 'u entry   (* init gets None *)
val entry : 'param key -> ('u, 'param) scene_storage -> 'u entry
val table : 'u entry list -> 'u all_scenes      (* reports duplicate names *)
```

Starting a scene by name passes `None`; by key passes `Some param`. An unknown
name, or a key that is not the one the scene was registered with, is reported
on stderr and the current scene stays.

## 4. Scene output messages

Returned from scene updates, from components as `Component.Som som`, and from
global components. Performed by the framework after the update.

| Message | Effect |
|---|---|
| `SOMChangeScene target` | start another scene (`By_name` / `By_key`) |
| `SOMPlayAudio (channel, name, option)` | play a loaded audio resource |
| `SOMStopAudio target` | `All_audio`, `Audio_channel c`, `Audio_name (c, name)` |
| `SOMTransformAudio (target, f)` | apply `f : Regl_audio.audio -> Regl_audio.audio` to playing sounds |
| `SOMSetVolume v` | master volume |
| `SOMLoadGC storage` | add a global component |
| `SOMUnloadGC key` | remove global components with that key's name |
| `SOMCallGC (key, msg)` | send a typed message to a global component |
| `SOMChangeFPS interval` | `AnimationFrame` or `Millisecond ms` |
| `SOMChangeMaxAssetsPerFrame n` | asset upload rate (0 = unlimited) |
| `SOMLoadResource (name, def)` | load a resource at run time |
| `SOMSaveValue (key, value)` | persist a string |
| `SOMReadValue key` | read it back; answered by a `ValueRead` event |

## 5. Components (`Component`)

```ocaml
type ('msg, 'pmsg, 'tar, 'userdata) cmd =
  | Parent of 'msg            (* own message, to the parent *)
  | Other of 'tar * 'msg      (* own message, to same-kind siblings *)
  | Sibling of 'tar * 'pmsg   (* parent-union value, to any sibling *)
  | Som of 'userdata Scene.scene_output_msg

type ('init, 'data, 'msg, 'pmsg, 'cdata, 'userdata, 'tar) spec = {
  init : runtime -> ('cdata, 'userdata) Base.env -> 'init -> 'data;
  update : runtime -> ('cdata, 'userdata) Base.env -> event -> 'data ->
    'data * ('msg, 'pmsg, 'tar, 'userdata) cmd list
    * (('cdata, 'userdata) Base.env * bool);       (* bool = block the event *)
  updaterec : runtime -> ('cdata, 'userdata) Base.env -> 'msg -> 'data ->
    'data * ('msg, 'pmsg, 'tar, 'userdata) cmd list * ('cdata, 'userdata) Base.env;
  view : runtime -> ('cdata, 'userdata) Base.env -> 'data -> renderable * int;  (* z *)
  targets : 'data -> 'tar list;
}

type ('data, 'msg, 'pmsg, 'view) port = {
  wrap : 'msg -> 'pmsg;            (* child message into the parent's union *)
  unwrap : 'pmsg -> 'msg option;   (* may translate a shared parent message *)
  inspect : 'data -> 'view;
}
val port : ('msg -> 'pmsg) -> ('pmsg -> 'msg option) -> ('data, 'msg, 'pmsg, unit) port
val port_with : inspect:('data -> 'view) -> ('msg -> 'pmsg) -> ('pmsg -> 'msg option) ->
  ('data, 'msg, 'pmsg, 'view) port

type ('cdata, 'userdata, 'tar, 'pmsg, 'view) t   (* a child, typed by its parent *)

val make : port -> spec -> 'init -> runtime -> ('cdata, 'userdata) Base.env -> t
val update_children : runtime -> env -> event -> t list ->
  t list * 'pmsg list * 'userdata Scene.scene_output_msg list * (env * bool)
val send : runtime -> env -> ('tar * 'pmsg) list -> t list ->
  t list * 'pmsg list * 'userdata Scene.scene_output_msg list * env
val view_components : runtime -> env -> t list -> renderable  (* sorted by z *)
val inspect : t -> 'view
```

Routing: `Other`, `Sibling`, and `send` deliver a message to every child
whose `targets` contain the target; the receiving child's port `unwrap`
decides whether it is for that child. Messages that children send while
handling messages are delivered in further rounds until none remain, so a
message cycle never terminates. A port's `unwrap` can map one shared parent
message to each kind's own message, e.g.
`function Enemy m -> Some m | Collide ty -> Some (Enemy.Hit ty) | _ -> None`,
so the parent can address children without knowing their kinds.

`Messenger_extra.Init_update_component` is a spec with an extra `init_update`
field run on the first event instead of `update`; create it with
`Init_update_component.make port spec init runtime env`.

## 6. Global components (`Global_component`) and the extras

```ocaml
type gc_base_data = { dead : bool; post_processor : renderable -> renderable }

type ('data, 'msg, 'userdata) concrete_global_component = {   (* in Scene *)
  init : runtime -> env -> 'data * gc_base_data;
  update : runtime -> env -> event -> 'data -> gc_base_data ->
    ('data * gc_base_data) * 'userdata Scene.scene_output_msg list * (env * bool);
  updaterec : runtime -> env -> 'msg -> 'data -> gc_base_data ->
    ('data * gc_base_data) * 'userdata Scene.scene_output_msg list * env;
  view : runtime -> env -> 'data -> gc_base_data -> renderable;
  key : 'msg Global_component.key;
}
(* env = ('userdata Scene.m_abstract_scene, 'userdata) Base.env: its
   common_data is the active scene. *)

type 'msg key
val key : string -> 'msg key
val make : ?key:'msg key -> ('data, 'msg, 'u) Scene.concrete_global_component ->
  'u Scene.global_component_storage
```

Global components run before the scene and can block it (`(env, true)`).
`post_processor` wraps the scene's view (before the camera is applied); `view`
is drawn on top, without the camera. Setting `dead = true` removes the
component. A component that takes no messages uses `type msg = |` and
`updaterec _ _ (msg : msg) _ _ = match msg with _ -> .`.

Extras (`Messenger_extra`):

| Module | Use |
|---|---|
| `Fps.gen_gc ?key { font_size; font }` | FPS counter overlay (needs a font) |
| `Asset_loading.gen_gc ?key ()` | covers the screen until resources load |
| `Transition_model.gen_mixed_transition_som (trans, ms) target` | cross-fade to a scene (`Transition_transitions.fade_mix`, `fade_img_mix mask invert`) |
| `Transition_model.gen_sequential_transition_som (out, ms) (in_, ms) target` | fade out, switch, fade in (`fade_out`, `fade_in`, `fade_out_with_color c`, `Transition_base.null_transition`, ...) |
| `Key_code` | `space`, `enter` (`"Return"`), arrows, `mouse_left_button`, ... |
| `Rng.gen_random_int seed (lo, hi)` | deterministic random numbers |

## 7. Events

```ocaml
type regl_event =                         (* Ml_regl_core.Regl_proto *)
  | UpdateTick of float                   (* absolute ms *)
  | MouseDown of { button : int; x : float; y : float }   (* 1 left, 2 middle, 3 right *)
  | MouseUp of { button : int; x : float; y : float }
  | MouseMove of { x : float; y : float }
  | KeyDown of string                     (* SDL names: "Space", "Return", "A", "Left" *)
  | KeyUp of string
  | ValueRead of { key : string; value : string option }  (* reply to SOMReadValue *)
```

Mouse coordinates are in virtual units, top-left origin.

## 8. Drawing

`Regl_common.group effects renderables` combines renderables (`[]` for no
effects). From `Regl_builtin_programs` (positions and sizes are
`float * float`; colors are `Color.t`; textures and fonts are resource names):

| Function | Arguments |
|---|---|
| `clear color` | fill the screen |
| `empty` | nothing |
| `rect pos size color` | top-left corner |
| `rect_centered center size angle color` | angle in radians |
| `rounded_rect pos size radius color` | |
| `circle center radius color` | |
| `triangle p1 p2 p3 color`, `quad p1 p2 p3 p4 color`, `poly points color` | |
| `lines [(p, q); ...] color`, `linestrip points color`, `lineloop points color` | |
| `textbox pos size text font color` | top-left; `size` is the font size |
| `textbox_centered center size text font color` | |
| `textbox_pro pos { default_textbox_option with ... }` | wrapping, alignment, spacing |
| `rect_texture pos size name` | |
| `centered_texture center size angle name` | |
| `rect_texture_with_alpha pos size alpha name` | |

`Messenger.Render_texture.render_sprite runtime pos (w, h) name` draws a
loaded texture, keeping its aspect ratio when `w` or `h` is `0.`.
`Color`: `rgb r g b`, `rgba r g b a` (0..1), `black`, `white`, `red`,
`green`, `blue`. Effects (`Regl_effects`) go in `group`'s first argument:
`alpha_mult a`, `color_mult r g b a`, `pixilation s`, `outline w color`,
`crt t`, and `fxaa` are single effects (`group [ alpha_mult 0.5 ] [...]`);
`blur r` and `gblur r` return lists (`group (blur 2.) [...]`). Compositors (`Regl_compositors`): `linear_fade t a b`,
`img_fade mask t invert a b`, `dst_over_src a b`, `mask_by_src a b`.

## 9. Resources

```ocaml
type resource_def =                                      (* Messenger.Resources *)
  | Texture_res of string * Regl_proto.texture_options option   (* path *)
  | Audio_res of string                                  (* path *)
  | Font_res of string * string    (* atlas png, BMFont-style json (MSDF) *)
  | Program_res of Regl_program.regl_program * Regl_proto.shader_language
      (* custom shader; GlslEs100 works on both hosts, Glsl is native *)
  | Data_res of string             (* text file; read with Base.get_config_data *)
type resource_defs = (string * resource_def) list        (* (name, def) *)

type texture_options = {                                 (* Regl_proto *)
  mag : texture_mag_option option;        (* MagNearest for pixel art *)
  min : texture_min_option option;
  crop : ((int * int) * (int * int)) option;   (* ((x, y), (w, h)) in pixels *)
}
```

Several names may share one path; cropping one sheet into many named textures
is the usual sprite-sheet setup.

## 10. Audio

```ocaml
type audio_option =                                    (* Messenger.Audio_base *)
  | A_once of audio_common_option option
  | A_loop of audio_common_option option * Regl_audio.loop option
type audio_common_option = { rate : float; start : float }   (* start: ms into the sound *)
(* Regl_audio.loop = { loop_start : float; loop_end : float } in ms *)
```

`SOMPlayAudio (channel, "name", A_once None)`; stop with `SOMStopAudio
(Audio_channel channel)`. Transforms for `SOMTransformAudio`:
`Regl_audio.scale_volume v`, `scale_volume_at [(time_ms, v); ...]`,
`offset_by ms`. An `A_loop` without a loop config plays once.

## 11. Camera

```ocaml
type t = Regl_common.camera = { x : float; y : float; zoom : float; rotation : float }
val default : width:float -> height:float -> t   (* centered: shows 0..width, 0..height *)
val judge_mouse_rect : mouse:float * float -> pos:float * float -> size:float * float -> bool
val judge_mouse_circle : mouse:float * float -> center:float * float -> radius:float -> bool
val mouse_to_camera_space : view_size:float * float -> t -> float * float -> float * float
val judge_mouse_rect_with_camera : view_size:_ -> camera:t -> mouse:_ -> pos:_ -> size:_ -> bool
val world_to_view : t -> float * float -> float * float
val view_to_world : t -> float * float -> float * float
```

The camera is `env.global_data.camera`; change it by returning an env with a
new camera. It applies to the scene's view, not to global components' views.

## 12. Storage

`SOMSaveValue (key, value)` persists a string in the backend's key-value
storage (`localStorage` in the browser). `SOMReadValue key` asks for it back; the reply arrives later
as `ValueRead { key; value }` (`None` when nothing is stored) and is also
cached for `Base.get_local_value key runtime`.
