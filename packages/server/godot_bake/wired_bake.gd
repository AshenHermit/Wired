extends SceneTree

## Preloaded instead of relying on `class_name`: a headless `--script` run does
## not populate the global script class cache.
const WiredBakeToolScript := preload("res://bake_tool.gd")

## Entry point for the headless bake process.
##
##   godot --headless --path <temp project> --script res://wired_bake.gd -- res://jobs.json
##
## Prints one machine-readable line and exits with 0 on success, 1 on failure.

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var jobs_path := str(args[0]) if args.size() > 0 else "jobs.json"
	var result := WiredBakeToolScript.run("res://", jobs_path)
	if result.get("ok", false):
		print("WIRED_BAKE_OK " + JSON.stringify({"results": result.get("results", [])}))
		quit(0)
		return
	print(
		"WIRED_BAKE_ERROR "
		+ JSON.stringify({"results": result.get("results", []), "errors": result.get("errors", [])})
	)
	quit(1)
