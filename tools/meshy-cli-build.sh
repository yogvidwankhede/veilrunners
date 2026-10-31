#!/usr/bin/env bash
# VEILRUNNERS — Meshy asset build via the OFFICIAL Meshy CLI (browser sign-in, no API key).
# Run on a machine with internet. Produces assets/*.glb + assets/manifest.json; the game auto-upgrades.
#
#   cd VEILRUNNERS && bash tools/meshy-cli-build.sh
#
# Requires Node 22.12+. Uses the pinned CLI via npx (nothing installed globally).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; ASSETS="$ROOT/assets"; PROJ="$ROOT/.meshy"; mkdir -p "$ASSETS" "$PROJ"
RUN=(npm exec --yes --package=meshy-cli@0.4.0 -- meshy)
F=(--output-schema v1 --format json --no-update-check)
jf(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let o;try{o=JSON.parse(s)}catch{process.exit(0)};for(const k of process.argv[1].split('.'))o=o&&o[k];process.stdout.write(o==null?'':String(o))})" "$1"; }

echo "▶ Checking Meshy session…"
if ! "${RUN[@]}" auth status "${F[@]}" | jf authenticated | grep -q true; then
  echo "▶ Logging in — approve in the browser window that opens (or visit the URL it prints):"
  "${RUN[@]}" auth login --device "${F[@]}"       # browser device flow; no API key needed
fi
PROJECT_DIR=""
init_proj(){ local id="$1" type="$2"; if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR=$("${RUN[@]}" project init --root "$PROJ" --name veilrunners --task-id "$id" --task-type "$type" --workspace "$ROOT" "${F[@]}" | jf result.project_dir); fi; }

# textured static prop: preview -> refine(PBR) -> download glb
prop(){ local name="$1" prompt="$2"
  [ -f "$ASSETS/$name.glb" ] && { echo "• $name exists, skip"; return; }
  echo "• $name: preview…"; local pid; pid=$("${RUN[@]}" text-to-3d create --mode preview --prompt "$prompt" --target-formats glb --async "${F[@]}" | jf result.submission.task_id)
  init_proj "$pid" text-to-3d
  "${RUN[@]}" text-to-3d wait "$pid" --timeout 900 --project "$PROJECT_DIR" --stage preview --workspace "$ROOT" "${F[@]}" >/dev/null
  echo "  $name: refine (4k PBR)…"; local rid; rid=$("${RUN[@]}" text-to-3d create --mode refine --preview-task-id "$pid" --enable-pbr true --texture-resolution 4k --target-formats glb --async --project "$PROJECT_DIR" --stage refine --workspace "$ROOT" "${F[@]}" | jf result.submission.task_id)
  "${RUN[@]}" text-to-3d wait "$rid" --timeout 900 --project "$PROJECT_DIR" --stage refine --workspace "$ROOT" "${F[@]}" >/dev/null
  "${RUN[@]}" download --task-json "$PROJECT_DIR/task_$rid.json" --asset result.model_urls.glb --output "$ASSETS/$name.glb" --project "$PROJECT_DIR" --stage refine --workspace "$ROOT" "${F[@]}" >/dev/null
  echo "  ✓ $ASSETS/$name.glb"; }

# character: textured T-pose -> rigging -> take bundled RUNNING clip
character(){ [ -f "$ASSETS/runner.glb" ] && { echo "• runner exists, skip"; return; }
  echo "• runner: preview (t-pose)…"; local pid; pid=$("${RUN[@]}" text-to-3d create --mode preview --prompt "A hooded stealth runner, athletic, weathered teal-grey cloak and leather wraps, faint glowing cyan eyes, photorealistic PBR, game-ready" --pose-mode t-pose --target-formats glb --async "${F[@]}" | jf result.submission.task_id)
  init_proj "$pid" text-to-3d
  "${RUN[@]}" text-to-3d wait "$pid" --timeout 900 --project "$PROJECT_DIR" --stage preview --workspace "$ROOT" "${F[@]}" >/dev/null
  echo "  runner: refine…"; local rid; rid=$("${RUN[@]}" text-to-3d create --mode refine --preview-task-id "$pid" --enable-pbr true --texture-resolution 4k --target-formats glb --async --project "$PROJECT_DIR" --stage refine --workspace "$ROOT" "${F[@]}" | jf result.submission.task_id)
  "${RUN[@]}" text-to-3d wait "$rid" --timeout 900 --project "$PROJECT_DIR" --stage refine --workspace "$ROOT" "${F[@]}" >/dev/null
  echo "  runner: rigging…"; local gid; gid=$("${RUN[@]}" rigging create --input-task-id "$rid" --height-meters 1.8 --async --project "$PROJECT_DIR" --stage rigging --workspace "$ROOT" "${F[@]}" | jf result.submission.task_id)
  "${RUN[@]}" rigging wait "$gid" --timeout 900 --project "$PROJECT_DIR" --stage rigging --workspace "$ROOT" "${F[@]}" >/dev/null
  # bundled running animation (free with rig). Falls back to the rigged T-pose if the asset name differs.
  "${RUN[@]}" download --task-json "$PROJECT_DIR/task_$gid.json" --asset result.basic_animations.running_glb_url --output "$ASSETS/runner.glb" --project "$PROJECT_DIR" --stage rigging --workspace "$ROOT" "${F[@]}" >/dev/null \
    || "${RUN[@]}" download --task-json "$PROJECT_DIR/task_$gid.json" --asset result.rigged_character_glb_url --output "$ASSETS/runner.glb" --project "$PROJECT_DIR" --stage rigging --workspace "$ROOT" "${F[@]}" >/dev/null
  echo "  ✓ $ASSETS/runner.glb (rigged + running)"; }

character
prop relic "An ancient golden ritual relic, faceted gemstone idol with carved temple filigree, softly glowing, photorealistic PBR"
prop tree  "A tall tropical jungle canopy tree with buttress roots and hanging moss, photorealistic PBR, game-ready"
prop torch "A carved stone temple brazier torch with an iron bowl, photorealistic PBR"
prop ruin  "A broken ancient stone temple pillar covered in vines and carved glyphs, photorealistic PBR"
prop fern  "A cluster of large tropical jungle ferns and broad leaves, photorealistic PBR"

# write the manifest the game reads (placements pulled from the VEILRUNNERS map)
node tools/write-manifest.mjs
echo "✔ Done. Run:  npm start   → open http://localhost:8080 (the game detects assets/ and swaps to realistic models)."
