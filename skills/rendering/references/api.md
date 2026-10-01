# ml-regl rendering API reference

Everything is in `Ml_regl_core`. Positions and sizes are `float * float` in
virtual units; colors are `Color.t`; texture and font arguments are resource
names. If a signature here does not compile, read the installed interfaces:
`$(ocamlfind query ml_regl_core)/*.mli`.

## Contents

1. `Regl_common`: the tree
2. `Regl_builtin_programs`: shapes, text, textures
3. `Regl_effects` and `Regl_compositors`
4. `Regl_program`: custom programs
5. `Regl_proto`: commands, replies, events
6. `Color`
7. `Regl_audio` (standalone apps)

## 1. `Regl_common`

```ocaml
type camera = { x : float; y : float; zoom : float; rotation : float }
type renderable
type regl_effect

val group : regl_effect list -> renderable list -> renderable
val group_with_camera : camera -> regl_effect list -> renderable list -> renderable
val atomic : string -> program_call -> renderable           (* draw with a program *)
val composite : string -> program_call -> renderable -> renderable -> renderable
val mk_effect : string -> program_call -> regl_effect

(* draw-call fields, by name; a program_call is a list of them
   (type program_call = Render_pb.ProgramCallField.t list) *)
val num : string -> float -> Render_pb.ProgramCallField.t
val nums : string -> float list -> Render_pb.ProgramCallField.t
val str : string -> string -> Render_pb.ProgramCallField.t
val strs : string -> string list -> Render_pb.ProgramCallField.t
val bool : string -> bool -> Render_pb.ProgramCallField.t
val to_rgba_list : Color.t -> float list   (* straight, not premultiplied *)

val encode_frame_pb : renderable -> bytes   (* textbox strings appear verbatim; handy in tests *)
```

## 2. `Regl_builtin_programs`

| Function | Meaning |
|---|---|
| `empty` | draws nothing |
| `clear color` | fills the whole view |
| `rect pos size color` | `pos` is the top-left corner |
| `rect_centered center size angle color` | |
| `rounded_rect center size radius color` | `center`, unlike `rect` |
| `circle center radius color` | |
| `triangle p1 p2 p3 color` | |
| `quad p1 p2 p3 p4 color` | |
| `poly points color` | filled polygon |
| `lines [ (p, q); ... ] color` | separate segments |
| `linestrip points color`, `lineloop points color` | |
| `function_curve f (x, y) (left, right) density color` | line strip through `(x + u, y + f u)` for `u` in `left..right`, `density` samples per unit |
| `poly_prim points indices color primitive` | `Points`, `Lines`, `LineLoop`, `LineStrip`, `Triangles`, `TriangleStrip`, `TriangleFan` |
| `textbox pos size text font color` | top-left; `size` is the font size |
| `textbox_centered center size text font color` | |
| `textbox_mf pos size text fonts color` | `fonts` is a fallback list |
| `textbox_mf_centered center size text fonts color` | |
| `textbox_pro pos option` | see below |
| `rect_texture pos size name` | `pos` is the top-left corner |
| `rect_texture_with_alpha pos size alpha name` | |
| `centered_texture center size angle name` | |
| `centered_texture_with_alpha center size angle alpha name` | |
| `rect_texture_cropped pos size crop_pos crop_size name` | crop in 0..1 texture coordinates |
| `centered_texture_cropped center size angle crop_pos crop_size name` | |
| `rect_texture_cropped_with_alpha`, `centered_texture_cropped_with_alpha` | as above, alpha before the name |
| `texture p1 p2 p3 p4 name` | four corners, clockwise from top-left |
| `texture_cropped p1 p2 p3 p4 uv1 uv2 uv3 uv4 name` | with a texture coordinate per corner |
| `texture_with_alpha`, `texture_cropped_with_alpha` | alpha before the name |

```ocaml
type textbox_option = {
  fonts : string list;  text : string;  size : float;  color : Color.t;
  word_break : bool;
  thickness : float option;  italic : float option;  width : float option;
  line_height : float option;  word_spacing : float option;
  align : string option;  tab_size : float option;  valign : string option;
  letter_spacing : float option;
}
val default_textbox_option : textbox_option
(* textbox_pro (x, y) { default_textbox_option with fonts = [ "font" ];
     text = "..."; size = 24.; width = Some 400.; word_break = true } *)
```

## 3. `Regl_effects` and `Regl_compositors`

```ocaml
(* Regl_effects: one effect each, except the blurs, which return lists *)
val alpha_mult : float -> regl_effect
val color_mult : float -> float -> float -> float -> regl_effect
val pixilation : float -> regl_effect
val outline : float -> Color.t -> regl_effect
val crt : float -> regl_effect
val fxaa : regl_effect
val blur : float -> regl_effect list            (* blur_h, blur_v *)
val gblur : float -> regl_effect list           (* gblur_h, gblur_v *)

(* Regl_compositors *)
val linear_fade : float -> renderable -> renderable -> renderable   (* t in 0..1 *)
val img_fade : string -> float -> bool -> renderable -> renderable -> renderable
    (* mask texture, t, invert *)
val dst_over_src : renderable -> renderable -> renderable
val mask_by_src : renderable -> renderable -> renderable
```

## 4. `Regl_program`

```ocaml
type prog_value =
  | DynamicValue of string         (* from the draw call's field of that name *)
  | StaticValue of value           (* see static_* below *)
  | DynamicTextureValue of string  (* texture named by that string field *)

type regl_program = {
  frag : string;
  vert : string;
  attributes : (string * prog_value) list option;
  uniforms : (string * prog_value) list option;
  elements : prog_value option;    (* vertex indices *)
  primitive : prog_value option;   (* default triangles *)
  count : prog_value option;
}

val static_number : float -> prog_value
val static_numbers : float list -> prog_value
val static_string : string -> prog_value
val static_strings : string list -> prog_value
val static_bool : bool -> prog_value

(* Effects and compositors; their input images are not bound on the
   desktop host yet, see SKILL.md. *)
val make_effect_program : string -> regl_program -> regl_program
val make_effect_simple : string -> (string * prog_value) list -> regl_program
val make_compositor_program : string -> string -> regl_program -> regl_program
val make_compositor_simple : string -> (string * prog_value) list -> regl_program
```

Host uniforms available to every program: `uniform vec2 view;` and
`uniform vec4 camera;` (x, y, zoom, rotation).

## 5. `Regl_proto`

Commands (`regl_output`), returned from `init` and `update`:

```ocaml
val start_regl : regl_start_config -> regl_output
type regl_start_config = {
  virt_width : float; virt_height : float;
  fbo_num : int;                         (* offscreen buffers for effects *)
  builtin_programs : string list option; (* None = all *)
  window : window_config;                (* default_window_config *)
  app_name : string option;
}
val config_regl : regl_config -> regl_output
type regl_config =
  | ConfigTimeInterval of time_interval  (* AnimationFrame | Millisecond of float *)
  | ConfigWindow of window_config        (* { fullscreen; resizable } options *)
  | ConfigMaxAssetsPerFrame of int

val load_texture : string -> string -> texture_options option -> regl_output
type texture_options = {
  mag : texture_mag_option option;   (* MagNearest | MagLinear *)
  min : texture_min_option option;   (* MinNearest | MinLinear | ...Mipmap... *)
  crop : ((int * int) * (int * int)) option;   (* pixels *)
}
val load_font : string -> string -> string -> regl_output     (* name, png, json *)
val load_audio : string -> regl_output                        (* url *)
val load_file : string -> regl_output                         (* text file *)
val create_regl_program :
  ?shader_language:shader_language -> string -> Regl_program.regl_program -> regl_output
    (* Glsl (native, the default) | GlslEs100 (portable) *)
val unload_texture : string -> regl_output
val unload_font : string -> regl_output
val unload_audio : string -> regl_output
val save_value : string -> string -> regl_output
val read_value : string -> regl_output
val quit_regl : unit -> regl_output
```

Inputs (`regl_input`), passed to `update`:

```ocaml
type regl_input = Event of regl_event | REGLRecvMsg of regl_recv_msg | AudioMsg of audio_recv_msg

type regl_event =
  | UpdateTick of float                     (* ms since the host loop started *)
  | MouseDown of { button : int; x : float; y : float }   (* virtual units *)
  | MouseUp of { button : int; x : float; y : float }
  | MouseMove of { x : float; y : float }
  | KeyDown of string | KeyUp of string                   (* SDL key names *)
  | ValueRead of { key : string; value : string option }

type regl_recv_msg =
  | REGLTextureLoaded of { name : string; width : int; height : int }
  | REGLTextureLoadFail of { name : string; reason : string }
  | REGLFontLoaded of string
  | REGLFontLoadFail of { name : string; reason : string }
  | REGLProgramCreated of string
  | REGLProgramCreateFail of string
  | REGLFileLoaded of { path : string; data : string }
  | REGLFileLoadFailed of { path : string; reason : string }

type audio_recv_msg =
  | AudioLoadSuccess of { audio_url : string; source : Regl_audio.source }
  | AudioLoadFailed of { audio_url : string; error : Regl_audio.load_error }
  | AudioContextReady of { sample_rate : int }
```

## 6. `Color`

`rgb r g b`, `rgba r g b a` (components 0..1), `black`, `white`, `red`,
`green`, `blue`.

## 7. `Regl_audio` (standalone apps)

The audio returned from `update` is a declarative tree; the runtime diffs it
against the previous one. `audio ?config source start_ms` plays a loaded
source from an absolute time; `group`, `silence`, `scale_volume v`,
`scale_volume_at [(ms, v); ...]`, `offset_by ms`. `config = { playback_rate;
start_at (ms into the sound); loop = Some { loop_start; loop_end } }`.
`length source` is in seconds; `ends_at audio` is when it finishes.
