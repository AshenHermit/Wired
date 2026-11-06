extends RefCounted
class_name PackageReadiness

## Pure readiness rule for the initial package-spawn gate.
##
## `announced` is `{package_id: revision}` and `reports` is
## `{package_id: {"revision": int, "state": "ready" | "failed"}}`. A peer is
## ready only when every announced package has a report for exactly the
## announced revision and that report succeeded. An empty announcement is
## ready: a room without packages needs no download before spawning.
##
## Readiness is checked only for the initial spawn. Later revisions are applied
## while players already exist and never reset or re-emit this gate.


static func is_ready(announced: Dictionary, reports: Dictionary) -> bool:
	for package_id: Variant in announced:
		if not reports.has(package_id):
			return false
		var report: Variant = reports[package_id]
		if typeof(report) != TYPE_DICTIONARY:
			return false
		var expected := int(announced[package_id])
		if int((report as Dictionary).get("revision", -1)) != expected:
			return false
		if str((report as Dictionary).get("state", "")) != "ready":
			return false
	return true
