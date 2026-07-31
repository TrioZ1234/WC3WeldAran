# Full pipeline: .w3x -> engine-ready data, staged into both frontends.
#
#   make MAP=path/to/WFWA.w3x        run everything
#   make extract / data / assets     run one stage
#   make clean                       drop build output
#
# Every target is reproducible from the map; nothing here is hand-edited.

MAP     ?= WFWA_v0.9.9q.w3x
BUILD   ?= build
EXTRACT := $(BUILD)/extracted
DATA    := $(BUILD)/data
ASSETS  := $(BUILD)/assets
PY      ?= python3

.PHONY: all extract data assets report stage clean

all: stage report

extract:
	@test -f "$(MAP)" || { echo "map not found: $(MAP) (pass MAP=...)"; exit 1; }
	$(PY) tools/extract_map.py "$(MAP)" $(EXTRACT)

data: extract
	$(PY) tools/export_data.py $(EXTRACT) $(DATA)

assets: extract
	$(PY) tools/convert_textures.py $(EXTRACT) $(ASSETS)/textures --manifest $(ASSETS)/textures.json
	$(PY) tools/convert_models.py  $(EXTRACT) $(ASSETS)/models  --textures $(ASSETS)/textures --manifest $(ASSETS)/models.json

report: extract
	$(PY) tools/analyze_map.py  $(EXTRACT) --json docs/data/map-report.json
	$(PY) tools/analyze_jass.py $(EXTRACT)/war3map.j --json docs/data/jass-api.json

# Both frontends read identical files. Symlinks keep one copy on disk so the
# web build and the Godot project can never drift out of sync.
stage: data assets
	@mkdir -p web/public godot
	@rm -rf web/public/data web/public/assets godot/data godot/assets
	@ln -s ../../$(DATA)   web/public/data
	@ln -s ../../$(ASSETS) web/public/assets
	@ln -s ../$(DATA)      godot/data
	@ln -s ../$(ASSETS)    godot/assets
	@echo "staged $(DATA) and $(ASSETS) into web/public and godot/"

preview: data
	$(PY) tools/preview_terrain.py $(DATA) $(BUILD)/terrain-preview.png --size 1024 --overlay

clean:
	rm -rf $(BUILD) web/public/data web/public/assets godot/data godot/assets
