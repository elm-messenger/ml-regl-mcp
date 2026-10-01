# ml-messenger examples

A small but complete game, compiled and tested against the installed
ml-messenger: a menu scene owns a composite button bar, the bar owns buttons,
a click starts the game scene with typed parameters through a scene key, the
game calls a HUD global component and goes back with a transition, and a
headless test drives it all through `Ui`.

```
dune-project            (lang dune 3.19)
src/dune
src/user_data.ml
src/app.ml
src/hud.ml                           global component
src/scenes/game_params.ml            the Game scene's key and parameters
src/scenes/menu/model.ml             scene owning the bar
src/scenes/menu/bar/model.ml         composite component owning buttons
src/scenes/menu/bar/button/model.ml  leaf component
src/scenes/game/model.ml             scene started by key
check/dune, check/check.ml           headless test
```

The executable is a separate `bin/` (see the setup section of SKILL.md).

## `src/dune`

```dune
(include_subdirs qualified)

(library
 (name game)
 (libraries ml-messenger))
```

## `src/user_data.ml`

```ocaml
(* Shared by every scene and component; a plain module so scenes can name it. *)
type t = { best_level : int }

let default = { best_level = 0 }
```

## A leaf component: `src/scenes/menu/bar/button/model.ml`

It defines its own types and never names its parent's. A click is reported
with its own message and blocks the event from reaching children below it.

```ocaml
open Ml_regl_core
open Messenger

type msg = Clicked of int

type init = {
  id : int;
  pos : float * float;
  size : float * float;
  label : string;
}

type data = init

let init _runtime _env (init : init) : data = init

let update _runtime env evnt (data : data) =
  match evnt with
  | Regl_proto.MouseDown { button = 1; x; y }
    when Camera.judge_mouse_rect ~mouse:(x, y) ~pos:data.pos ~size:data.size ->
      (* block: the click stops here, siblings below don't see it *)
      (data, [ Component.Parent (Clicked data.id) ], (env, true))
  | _ -> (data, [], (env, false))

(* Buttons receive no messages. *)
let updaterec _runtime env _msg data = (data, [], env)

let view _runtime _env (data : data) =
  let x, y = data.pos and w, h = data.size in
  ( Regl_common.group []
      [
        Regl_builtin_programs.rect data.pos data.size (Color.rgb 0.8 0.85 0.95);
        Regl_builtin_programs.textbox_centered
          (x +. (w /. 2.), y +. (h /. 2.))
          28. data.label "font" Color.black;
      ],
    0 )

let component =
  {
    Component.init;
    update;
    updaterec;
    view;
    targets = (fun (data : data) -> [ data.id ]);
  }
```

## A composite component: `src/scenes/menu/bar/model.ml`

`msg` is what it tells its parent; `child_msg` is the union of its own
children, with one port. It translates the children's messages into its own
and passes their scene output messages on with `Som`.

```ocaml
open Messenger

(* What the bar tells its parent... *)
type msg = Chose of int

(* ...and the union of its own children. *)
type child_msg = Button of Button.Model.msg

let button = Component.port (fun msg -> Button msg) (fun (Button msg) -> Some msg)

type init = { labels : string list; pos : float * float }

type data = {
  children : (unit, User_data.t, int, child_msg, unit) Component.t list;
}

let init runtime env (init : init) =
  let x, y = init.pos in
  let make i label =
    Component.make button Button.Model.component
      {
        Button.Model.id = i;
        pos = (x, y +. (float i *. 90.));
        size = (300., 70.);
        label;
      }
      runtime env
  in
  { children = List.mapi make init.labels }

let update runtime env evnt data =
  let children, msgs, soms, (env, block) =
    Component.update_children runtime env evnt data.children
  in
  (* translate the children's messages into the bar's own *)
  let reports =
    List.map (fun (Button (Clicked i)) -> Component.Parent (Chose i)) msgs
  in
  ( { children },
    reports @ List.map (fun som -> Component.Som som) soms,
    (env, block) )

let updaterec _runtime env _msg data = (data, [], env)
let view runtime env data = (Component.view_components runtime env data.children, 0)

let component =
  { Component.init; update; updaterec; view; targets = (fun _ -> [ "bar" ]) }
```

## Scene keys and parameters: `src/scenes/game_params.ml`

A plain module next to the scene directories, so any scene can start Game
without depending on Game's module.

```ocaml
(* The Game scene's parameters and key, in a plain module so any scene can
   start Game without depending on Game's own module. *)
type t = { level : int }

let key : t Messenger.Scene.key = Messenger.Scene.key "Game"
```

## A scene owning a component: `src/scenes/menu/model.ml`

The scene owns the union of its children and starts Game by key.

```ocaml
open Ml_regl_core
open Messenger
module Bar = Bar.Model

type msg = Bar of Bar.msg

let bar = Component.port (fun msg -> Bar msg) (fun (Bar msg) -> Some msg)

type data = {
  children : (unit, User_data.t, string, msg, unit) Component.t list;
}

let init runtime env _params =
  let bar_init =
    { Bar.labels = [ "Level 1"; "Level 2"; "Level 3" ]; pos = (490., 250.) }
  in
  { children = [ Component.make bar Bar.component bar_init runtime env ] }

let update runtime env evnt data =
  let children, msgs, soms, (env, _block) =
    Component.update_children runtime env evnt data.children
  in
  let start (Bar (Chose i)) =
    Scene.SOMChangeScene
      (By_key (Game_params.key, { Game_params.level = i + 1 }))
  in
  ({ children }, soms @ List.map start msgs, env)

let view runtime env data =
  Regl_common.group []
    [
      Regl_builtin_programs.clear Color.white;
      Component.view_components runtime env data.children;
    ]

let scene params runtime env =
  Scene.abstract { init; update; view } params runtime env
```

## A scene with parameters: `src/scenes/game/model.ml`

`init` gets `Some params` when started by key. It keeps the last tick to
compute elapsed time, calls the HUD, and goes back with a transition.

```ocaml
open Ml_regl_core
open Messenger

type data = { level : int; elapsed : float; last_tick : float option }

(* Started by key with typed params; [None] if started by name. *)
let init _runtime _env (params : Game_params.t option) =
  let level = match params with Some p -> p.level | None -> 1 in
  { level; elapsed = 0.; last_tick = None }

let update _runtime env evnt data =
  match evnt with
  | Regl_proto.UpdateTick now ->
      (* ticks carry absolute milliseconds; keep the last one for dt *)
      let dt = match data.last_tick with Some t -> now -. t | None -> 0. in
      ({ data with elapsed = data.elapsed +. dt; last_tick = Some now }, [], env)
  | KeyDown "Space" -> (data, [ Scene.SOMCallGC (Hud.key, Hud.Add data.level) ], env)
  | KeyDown "Backspace" ->
      ( data,
        [
          Messenger_extra.Transition_model.gen_mixed_transition_som
            (Messenger_extra.Transition_transitions.fade_mix, 500.)
            (By_name "Menu");
        ],
        env )
  | _ -> (data, [], env)

let view _runtime _env data =
  Regl_common.group []
    [
      Regl_builtin_programs.clear (Color.rgb 0.1 0.1 0.15);
      Regl_builtin_programs.textbox (40., 40.) 36.
        (Printf.sprintf "Level %d  %.1fs" data.level (data.elapsed /. 1000.))
        "font" Color.white;
    ]

let scene params runtime env =
  Scene.abstract { init; update; view } params runtime env
```

## A global component: `src/hud.ml`

```ocaml
(* A global component: runs before the active scene in every scene and draws
   over it. Called with [SOMCallGC (Hud.key, Add n)]. *)
open Ml_regl_core
open Messenger

type msg = Add of int

let key : msg Global_component.key = Global_component.key "hud"

type data = { score : int }

let component : (data, msg, User_data.t) Scene.concrete_global_component =
  {
    init =
      (fun _runtime _env ->
        ({ score = 0 }, { Scene.dead = false; post_processor = Fun.id }));
    update = (fun _runtime env _evnt data bdata -> ((data, bdata), [], (env, false)));
    updaterec =
      (fun _runtime env (Add n) data bdata ->
        (({ score = data.score + n }, bdata), [], env));
    view =
      (fun _runtime _env data _bdata ->
        Regl_builtin_programs.textbox (40., 660.) 28.
          ("score " ^ string_of_int data.score)
          "font" Color.white);
    key;
  }

let gc = Global_component.make component
```

## The application: `src/app.ml`

```ocaml
open Messenger

let virtual_size : Ui.size = { width = 1280.; height = 720. }

let config : User_data.t Ui.user_config =
  {
    init_scene = By_name "Menu";
    virtual_size;
    fbo_num = 5;
    max_assets_per_frame = 4;
    enabled_program = Ui.AllBuiltinProgram;
    time_interval = Ml_regl_core.Regl_proto.AnimationFrame;
    default_global_data =
      {
        user_data = User_data.default;
        camera =
          Camera.default ~width:virtual_size.width ~height:virtual_size.height;
        volume = 1.;
      };
    app_name = Some "Example";
  }

(* Paths are relative to the working directory (desktop) or the page (JS). *)
let resources : Resources.resource_defs =
  [ ("font", Resources.Font_res ("assets/font.png", "assets/font.json")) ]

let scenes =
  Scene.table
    [
      Scene.named "Menu" Scenes.Menu.Model.scene;
      Scene.entry Scenes.Game_params.key Scenes.Game.Model.scene;
    ]

let input : User_data.t Ui.input =
  {
    config;
    resources;
    scenes;
    global_components = [ Hud.gc; Messenger_extra.Asset_loading.gen_gc () ];
  }
```

## A headless test: `check/dune` and `check/check.ml`

Links the desktop backend but never calls `Ui.gen_main`, so no window opens.
Text in textboxes appears verbatim in the encoded frame.

```dune
; Drives the app headlessly: links the desktop backend but never calls
; Ui.gen_main, so no window opens.

(test
 (name check)
 (libraries regl_desktop game))
```

```ocaml
open Ml_regl_core
open Messenger

let input = Game.App.input

let draws model text =
  let frame = Bytes.to_string (Regl_common.encode_frame_pb (Ui.view input model)) in
  let n = String.length frame and m = String.length text in
  let rec go i = i + m <= n && (String.sub frame i m = text || go (i + 1)) in
  go 0

let step model evnt =
  let model, _audio, _commands = Ui.update input model (Regl_proto.Event evnt) in
  model

let scene model = Base.get_current_scene model.Model.runtime

let () =
  let m, _commands = Ui.init input () in
  assert (scene m = "Menu");
  let m = step m (MouseDown { button = 1; x = 600.; y = 370. }) in
  assert (scene m = "Game" && draws m "Level 2");
  let m = step m (KeyDown "Space") in
  assert (draws m "score 2");
  let m = step m (KeyDown "Backspace") in
  let m = List.fold_left (fun m t -> step m (UpdateTick t)) m [ 0.; 16.; 600. ] in
  assert (scene m = "Menu")
```
