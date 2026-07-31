## Builds the map in Godot from the shared pipeline output.
##
## Terrain is split into chunks so the engine can frustum-cull it, and placed
## objects go through MultiMesh: 25,222 doodads as individual nodes would cost
## more in scene-tree overhead than in rendering. This is the native-build
## counterpart to the WebGPU frontend and reads identical data.
extends Node3D

## Tiles per terrain chunk. 32 gives 15x15 = 225 chunks at 480x480.
const CHUNK_TILES := 32

## Placeholder box size for a placed object until real .glb meshes are bound.
const PLACEHOLDER_SIZE := 90.0

@onready var _camera: Camera3D = $Camera

var _data := MapData.new()
var _orbit_distance := 30000.0
var _orbit_yaw := -PI / 2.0
var _orbit_pitch := 0.9
var _orbit_target := Vector3.ZERO
var _dragging := false


func _ready() -> void:
	var started := Time.get_ticks_msec()
	if not _data.load_all():
		push_error("World: failed to load map data — run tools/export_data.py first")
		return

	_build_terrain()
	_build_placements()
	_frame_camera()

	print("World ready in %d ms — %d doodads, %d units, %d terrain chunks"
		% [Time.get_ticks_msec() - started, _data.doodads.size(), _data.units.size(),
		   get_node("Terrain").get_child_count()])


func _build_terrain() -> void:
	var root := Node3D.new()
	root.name = "Terrain"
	add_child(root)

	var material := StandardMaterial3D.new()
	material.vertex_color_use_as_albedo = true
	material.roughness = 0.95
	material.specular = 0.1

	var cols := int(ceil(float(_data.width - 1) / CHUNK_TILES))
	var rows := int(ceil(float(_data.height - 1) / CHUNK_TILES))
	for chunk_row in rows:
		for chunk_col in cols:
			var mesh := _build_chunk(chunk_col, chunk_row, material)
			if mesh == null:
				continue
			var instance := MeshInstance3D.new()
			instance.mesh = mesh
			instance.name = "Chunk_%d_%d" % [chunk_col, chunk_row]
			root.add_child(instance)


func _build_chunk(chunk_col: int, chunk_row: int, material: Material) -> ArrayMesh:
	var x0 := chunk_col * CHUNK_TILES
	var y0 := chunk_row * CHUNK_TILES
	var x1 := mini(x0 + CHUNK_TILES, _data.width - 1)
	var y1 := mini(y0 + CHUNK_TILES, _data.height - 1)
	if x1 <= x0 or y1 <= y0:
		return null

	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var colors := PackedColorArray()
	var indices := PackedInt32Array()

	var span_x := x1 - x0 + 1
	for row in range(y0, y1 + 1):
		for col in range(x0, x1 + 1):
			var index := _data.index_at(col, row)
			var z := _data.elevation(index)
			var level := _data.water_level(index)
			var wet := level > z + 0.5
			if wet:
				z = level

			vertices.append(MapData.to_godot(
				_data.offset.x + col * MapData.TILE_SIZE,
				_data.offset.y + row * MapData.TILE_SIZE,
				z))
			normals.append(_normal_at(col, row))
			colors.append(_tint(index, wet))

	for row in range(y1 - y0):
		for col in range(x1 - x0):
			var a := row * span_x + col
			var b := a + 1
			var c := a + span_x
			var d := c + 1
			indices.append_array([a, c, b, b, c, d])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_COLOR] = colors
	arrays[Mesh.ARRAY_INDEX] = indices

	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, material)
	return mesh


func _normal_at(col: int, row: int) -> Vector3:
	var left := _data.elevation(_data.index_at(maxi(col - 1, 0), row))
	var right := _data.elevation(_data.index_at(mini(col + 1, _data.width - 1), row))
	var down := _data.elevation(_data.index_at(col, maxi(row - 1, 0)))
	var up := _data.elevation(_data.index_at(col, mini(row + 1, _data.height - 1)))
	# Godot is Y-up, so the terrain normal's "up" component is Y.
	return Vector3(
		(left - right) / (2.0 * MapData.TILE_SIZE),
		1.0,
		-(down - up) / (2.0 * MapData.TILE_SIZE)).normalized()


func _tint(index: int, wet: bool) -> Color:
	if wet:
		return Color(0.13, 0.28, 0.45)
	var tileset := _data.ground_texture[index]
	# Deterministic pseudo-palette until the real terrain atlas is bound.
	return Color.from_hsv(fmod(0.08 + tileset * 0.055, 1.0), 0.35, 0.55)


func _build_placements() -> void:
	var root := Node3D.new()
	root.name = "Placements"
	add_child(root)

	_add_multimesh(root, "Doodads", _data.doodads, Color(0.45, 0.52, 0.32))
	_add_multimesh(root, "Units", _data.units, Color(0.72, 0.34, 0.30))


func _add_multimesh(parent: Node3D, name: String, items: Array, tint: Color) -> void:
	if items.is_empty():
		return

	var box := BoxMesh.new()
	box.size = Vector3(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE * 1.6, PLACEHOLDER_SIZE)
	var material := StandardMaterial3D.new()
	material.albedo_color = tint
	box.material = material

	var multimesh := MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.mesh = box
	multimesh.instance_count = items.size()

	for i in items.size():
		var item: Dictionary = items[i]
		var pos: Array = item["pos"]
		var scale: Array = item.get("scale", [1.0, 1.0, 1.0])
		var origin := MapData.to_godot(float(pos[0]), float(pos[1]), float(pos[2]))

		var basis := Basis(Vector3.UP, float(item.get("rot", 0.0)))
		basis = basis.scaled(Vector3(float(scale[0]), float(scale[2]), float(scale[1])))
		# Box origin is its centre; lift it so the model sits on the ground.
		origin.y += PLACEHOLDER_SIZE * 0.8 * float(scale[2])
		multimesh.set_instance_transform(i, Transform3D(basis, origin))

	var instance := MultiMeshInstance3D.new()
	instance.multimesh = multimesh
	instance.name = name
	parent.add_child(instance)


func _frame_camera() -> void:
	var extent := (_data.width - 1) * MapData.TILE_SIZE
	_orbit_target = Vector3(_data.offset.x + extent * 0.5, 0.0, -(_data.offset.y + extent * 0.5))
	_orbit_distance = extent * 0.8
	_update_camera()


func _update_camera() -> void:
	var horizontal := cos(_orbit_pitch) * _orbit_distance
	_camera.position = _orbit_target + Vector3(
		cos(_orbit_yaw) * horizontal,
		sin(_orbit_pitch) * _orbit_distance,
		sin(_orbit_yaw) * horizontal)
	_camera.look_at(_orbit_target, Vector3.UP)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var button := event as InputEventMouseButton
		if button.button_index == MOUSE_BUTTON_LEFT:
			_dragging = button.pressed
		elif button.button_index == MOUSE_BUTTON_WHEEL_UP and button.pressed:
			_orbit_distance = maxf(_orbit_distance * 0.9, 400.0)
			_update_camera()
		elif button.button_index == MOUSE_BUTTON_WHEEL_DOWN and button.pressed:
			_orbit_distance = minf(_orbit_distance * 1.1, 200000.0)
			_update_camera()
	elif event is InputEventMouseMotion and _dragging:
		var motion := event as InputEventMouseMotion
		_orbit_yaw -= motion.relative.x * 0.005
		_orbit_pitch = clampf(_orbit_pitch + motion.relative.y * 0.005, 0.08, PI / 2.0 - 0.05)
		_update_camera()
