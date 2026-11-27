extends WiredPlayerComponent

## Локальная панель реестра библиотеки `cura_registry`.
##
## Панель — компонент игрока с `authority = "local"`: список строится из
## зарегистрированных пакетами записей, а выбор уходит в `tool_manager` через
## сигналы. Никаких `class_name` и прямых RPC: все действия ядра идут через
## `register_action`/`request_action` в других компонентах пакета.
##
## Идентификаторы в списке уже квалифицированы реестром ядра как
## `<package_id>/<id>`, поэтому подписчики получают готовые строки.

signal prop_selected(qualified_type: String)
signal tool_selected(qualified_tool: String)

const ACTION_PANEL := "cura_panel"
const PANEL_GROUP := "cura_registry_panel"
const CHARACTER_GROUP := "cura_player_character"
const KIND_CATEGORY := "cura.category"
const KIND_PROP := "cura.prop"
const KIND_TOOL := "cura.tool"
const FALLBACK_CATEGORY := "other"
const FALLBACK_LABEL := "Разное"

## Инжектированный реестр. В проде проставляется из `Global` в `_wired_ready`,
## в smoke-тесте — через `set_registry` до `rebuild()`.
var registry: WiredPackageRegistry = null

## Локальный флаг захвата: на web браузер может сбросить pointer lock, не
## сообщив об этом через `Input.mouse_mode`, как и в `cura_player`.
var pointer_captured: bool = false
var capture_before_open: bool = false
var capture_restored: bool = false

var _open: bool = false
var _action_name: String = ""
var _items: Array[Dictionary] = []
var _panel_root: Control = null
var _list: VBoxContainer = null


func _wired_ready() -> void:
	add_to_group(PANEL_GROUP)
	var key := InputEventKey.new()
	key.physical_keycode = KEY_Q
	_action_name = register_input_action(ACTION_PANEL, [key])
	# Узлы интерфейса есть в сцене; при создании скриптом тест проверяет только
	# логику списка, поэтому отсутствие узлов не должно ломать `rebuild()`.
	_panel_root = get_node_or_null("Panel") as Control
	_list = get_node_or_null("Panel/Margin/List") as VBoxContainer
	# Отсоединённая копия из smoke-теста не может резолвить абсолютный путь.
	var tree: SceneTree = get_tree() if is_inside_tree() else null
	var global_node := tree.root.get_node_or_null("Global") if tree != null else null
	if global_node != null:
		var packages: Variant = global_node.get("packages")
		if (
			packages is Node
			and (packages as Node).has_signal("package_applied")
			and not (packages as Node).is_connected(
				"package_applied", Callable(self, "_on_package_applied")
			)
		):
			(packages as Node).connect(
				"package_applied", Callable(self, "_on_package_applied")
			)
		var initial := global_node.get("package_registry") as WiredPackageRegistry
		if initial != null and registry == null:
			set_registry(initial)
			rebuild()


func set_registry(next: WiredPackageRegistry) -> void:
	registry = next


func is_open() -> bool:
	return _open


func item_count() -> int:
	return _items.size()


func toggle() -> void:
	if _open:
		close_panel()
	else:
		open_panel()


func open_panel() -> void:
	capture_before_open = _resolve_capture()
	capture_restored = false
	pointer_captured = false
	_open = true
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	if _panel_root != null:
		_panel_root.visible = true


func close_panel() -> void:
	_open = false
	if _panel_root != null:
		_panel_root.visible = false
	if capture_before_open:
		pointer_captured = true
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		capture_restored = true
	else:
		capture_restored = false


## Q открывает/закрывает панель, Escape только закрывает. Имя действия берётся
## из `register_input_action`, чтобы не собирать qualified-строку вручную.
func _wired_process(_delta: float) -> void:
	if not is_local_player():
		return
	if not _action_name.is_empty() and Input.is_action_just_pressed(_action_name):
		toggle()
	elif _open and Input.is_action_just_pressed("ui_cancel"):
		close_panel()


## Выбор записи испускает qualified_id и закрывает панель, возвращая указатель.
func select_item(index: int) -> void:
	if index < 0 or index >= _items.size():
		return
	var item: Dictionary = _items[index]
	var qualified_id := str(item.get("id", ""))
	if qualified_id.is_empty():
		return
	if str(item.get("kind", "")) == KIND_PROP:
		prop_selected.emit(qualified_id)
	elif str(item.get("kind", "")) == KIND_TOOL:
		tool_selected.emit(qualified_id)
	close_panel()


## Пересборка после применения ревизии пакета. `package_applied` приходит
## синхронно из `PackagesManager`, а реестр к этому моменту ещё обновляется,
## поэтому ответ откладывается в конец кадра.
func _on_package_applied(
	_package_id: int, _revision: int, _changed_files: PackedStringArray
) -> void:
	call_deferred("rebuild")


func rebuild() -> void:
	_items.clear()
	_clear_list()
	if registry == null:
		return
	var category_entries := registry.get_entries(KIND_CATEGORY)
	var prop_entries := registry.get_entries(KIND_PROP)
	var tool_entries := registry.get_entries(KIND_TOOL)
	var categories: Dictionary = {}
	var known: Array[Dictionary] = []
	for entry: Dictionary in category_entries:
		var options: Dictionary = entry.get("options", {})
		var local_id := str(entry.get("id", ""))
		var qualified_id := str(entry.get("qualified_id", ""))
		if qualified_id.is_empty():
			qualified_id = _qualify_category(
				str(entry.get("package_id", "")), local_id
			)
		var category := {
			"key": local_id,
			"qualified_id": qualified_id,
			"label": str(options.get("label", local_id)),
			"order": int(options.get("order", entry.get("order", 0))),
		}
		categories[local_id] = category
		categories[qualified_id] = category
		known.append(category)
	var groups: Dictionary = {}
	for kind: String in [KIND_PROP, KIND_TOOL]:
		var entries := prop_entries if kind == KIND_PROP else tool_entries
		for entry: Dictionary in entries:
			var qualified_id := str(entry.get("qualified_id", ""))
			if qualified_id.is_empty():
				continue
			var options: Dictionary = entry.get("options", {})
			var key := _category_key(
				str(options.get("category", "")),
				str(entry.get("package_id", "")),
				categories,
			)
			var bucket: Array = groups.get(key, [])
			bucket.append({
				"id": qualified_id,
				"kind": kind,
				"label": str(options.get("label", qualified_id)),
				"order": int(options.get("order", entry.get("order", 0))),
			})
			groups[key] = bucket
	known.sort_custom(_category_less)
	var seen: Dictionary = {}
	var ordered_keys: Array[String] = []
	for category: Dictionary in known:
		var key := str(category.get("qualified_id", ""))
		if seen.has(key):
			continue
		seen[key] = true
		if groups.has(key):
			ordered_keys.append(key)
	var unknown_keys: Array[String] = []
	for key: Variant in groups.keys():
		var text := str(key)
		if not ordered_keys.has(text):
			unknown_keys.append(text)
	unknown_keys.sort()
	ordered_keys.append_array(unknown_keys)
	for key: String in ordered_keys:
		var bucket: Array = groups[key]
		bucket.sort_custom(_item_less)
		_add_header(_category_label(key, categories))
		for item: Dictionary in bucket:
			var index := _items.size()
			_items.append(item)
			_add_button(str(item.get("label", "")), index)


## Категория в `options.category` может быть локальным id (`props`) или уже
## квалифицированным (`pkg.crate/props`); оба вида приводятся к одному ключу.
func _category_key(
	raw: String, package_id: String, categories: Dictionary
) -> String:
	if raw.is_empty():
		return FALLBACK_CATEGORY
	if categories.has(raw):
		return str((categories[raw] as Dictionary).get("qualified_id", raw))
	var qualified := _qualify_category(package_id, raw)
	if categories.has(qualified):
		return str((categories[qualified] as Dictionary).get("qualified_id", qualified))
	return FALLBACK_CATEGORY


func _qualify_category(package_id: String, local_id: String) -> String:
	if package_id.is_empty():
		return local_id
	return "%s/%s" % [package_id, local_id]


func _category_label(key: String, categories: Dictionary) -> String:
	if categories.has(key):
		return str((categories[key] as Dictionary).get("label", key))
	if key == FALLBACK_CATEGORY:
		return FALLBACK_LABEL
	return key


func _category_less(left: Dictionary, right: Dictionary) -> bool:
	var left_order := int(left.get("order", 0))
	var right_order := int(right.get("order", 0))
	if left_order != right_order:
		return left_order < right_order
	return str(left.get("label", "")) < str(right.get("label", ""))


func _item_less(left: Dictionary, right: Dictionary) -> bool:
	var left_order := int(left.get("order", 0))
	var right_order := int(right.get("order", 0))
	if left_order != right_order:
		return left_order < right_order
	return str(left.get("label", "")) < str(right.get("label", ""))


func _clear_list() -> void:
	if _list == null:
		return
	for child: Node in _list.get_children():
		child.free()


func _add_header(text: String) -> void:
	if _list == null:
		return
	var header := Label.new()
	header.text = text
	_list.add_child(header)


func _add_button(text: String, index: int) -> void:
	if _list == null:
		return
	var button := Button.new()
	button.text = text
	button.pressed.connect(_on_item_pressed.bind(index))
	_list.add_child(button)


func _on_item_pressed(index: int) -> void:
	select_item(index)


## Захват приложения сначала спрашивается у персонажа (`is_look_captured()`
## из `cura_player` уже учитывает web), затем берётся локальный флаг и только
## потом — реальный режим указателя для не-web.
func _resolve_capture() -> bool:
	var captured := pointer_captured
	var character := _find_character()
	if character != null and character.has_method("is_look_captured"):
		captured = bool(character.call("is_look_captured"))
	elif not captured and not OS.has_feature("web"):
		captured = Input.mouse_mode == Input.MOUSE_MODE_CAPTURED
	pointer_captured = captured
	return captured


func _find_character() -> Node:
	if not is_inside_tree():
		return null
	if player != null:
		for component: WiredPlayerComponent in player.components:
			if (
				component != null
				and is_instance_valid(component)
				and component.is_in_group(CHARACTER_GROUP)
			):
				return component
	var tree := get_tree()
	if tree == null:
		return null
	return tree.get_first_node_in_group(CHARACTER_GROUP)
