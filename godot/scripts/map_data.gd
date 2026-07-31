## Loader for the shared pipeline output.
##
## Reads exactly the same files the web frontend does, so the two frontends
## can never drift apart on content: the converter is the single source.
class_name MapData
extends RefCounted

## Where the pipeline output is mounted inside the Godot project.
const DATA_ROOT := "res://data"

## One WC3 world unit per Godot unit; X east, Y north, Z up in the source data.
## Godot is Y-up, so world position is (x, z_height, -y).
const TILE_SIZE := 128.0

var meta: Dictionary = {}
var width: int = 0
var height: int = 0
var offset := Vector2.ZERO
var ground_tilesets: PackedStringArray = []

var ground_height := PackedInt32Array()
var water := PackedInt32Array()
var ground_texture := PackedByteArray()
var cliff_texture := PackedByteArray()
var layer_height := PackedByteArray()
var terrain_flags := PackedByteArray()

var info: Dictionary = {}
var doodads: Array = []
var units: Array = []


static func _read_json(path: String) -> Variant:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		push_error("MapData: cannot open %s" % path)
		return null
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	if parsed == null:
		push_error("MapData: malformed JSON in %s" % path)
	return parsed


func load_all() -> bool:
	if not _load_terrain():
		return false
	var parsed_info: Variant = _read_json("%s/map.json" % DATA_ROOT)
	if parsed_info is Dictionary:
		info = parsed_info
	var parsed_doodads: Variant = _read_json("%s/doodads.json" % DATA_ROOT)
	if parsed_doodads is Array:
		doodads = parsed_doodads
	var parsed_units: Variant = _read_json("%s/units.json" % DATA_ROOT)
	if parsed_units is Array:
		units = parsed_units
	return true


func _load_terrain() -> bool:
	var parsed: Variant = _read_json("%s/terrain.json" % DATA_ROOT)
	if not (parsed is Dictionary):
		return false
	meta = parsed
	width = int(meta["width"])
	height = int(meta["height"])
	var off: Array = meta["offset"]
	offset = Vector2(float(off[0]), float(off[1]))
	ground_tilesets = PackedStringArray(meta["groundTilesets"])

	var binary: Dictionary = meta["binary"]
	var path := "%s/%s" % [DATA_ROOT, binary["file"]]
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		push_error("MapData: cannot open %s" % path)
		return false
	var blob := file.get_buffer(file.get_length())

	# Layout is declared in terrain.json rather than hardcoded here, so a
	# pipeline change surfaces as a load error instead of silent corruption.
	var count := int(binary["count"])
	var cursor := 0
	for field: Dictionary in binary["layout"]:
		var name: String = field["name"]
		var type: String = field["type"]
		if type == "int16":
			var values := PackedInt32Array()
			values.resize(count)
			for i in count:
				values[i] = blob.decode_s16(cursor + i * 2)
			cursor += count * 2
			match name:
				"groundHeight": ground_height = values
				"water": water = values
		else:
			var slice := blob.slice(cursor, cursor + count)
			cursor += count
			match name:
				"groundTexture": ground_texture = slice
				"cliffTexture": cliff_texture = slice
				"layerHeight": layer_height = slice
				"flags": terrain_flags = slice
	return true


## World-space elevation of a tilepoint, per terrain.json's heightFormula.
func elevation(index: int) -> float:
	return (ground_height[index] - 8192.0) / 4.0 + (layer_height[index] - 2.0) * 128.0


func water_level(index: int) -> float:
	return water[index] / 4.0


func index_at(col: int, row: int) -> int:
	return row * width + col


## Convert a WC3 (x, y, z) triple into Godot's Y-up space.
static func to_godot(x: float, y: float, z: float) -> Vector3:
	return Vector3(x, z, -y)
