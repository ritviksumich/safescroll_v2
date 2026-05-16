#!/usr/bin/env bash
# Pre-fetches the Gemma 4 E2B ONNX files into models/ so the extension can
# load instantly from disk instead of pulling 3+ GB from Hugging Face on
# first launch. Run this once after cloning. Re-running is a no-op for files
# that are already present (curl --continue-at).
#
# Usage:
#   ./scripts/download-model.sh           # default q4 quantization (~3.6 GB)
#   ./scripts/download-model.sh q4f16     # smaller variant
#   ./scripts/download-model.sh fp16      # full fp16 (~5+ GB)
#   ./scripts/download-model.sh quantized # int8

set -euo pipefail

QUANT="${1:-q4}"
REPO="onnx-community/gemma-4-E2B-it-ONNX"
BASE_URL="https://huggingface.co/${REPO}/resolve/main"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${ROOT_DIR}/models/${REPO}"

# Validate quant choice up front so we fail fast on a typo.
case "$QUANT" in
  q4|q4f16|fp16|quantized|"")
    ;;
  *)
    echo "Unknown quantization: $QUANT" >&2
    echo "Allowed: q4 (default) | q4f16 | fp16 | quantized" >&2
    exit 1
    ;;
esac

# Common files (small) — required regardless of quant.
COMMON_FILES=(
  config.json
  generation_config.json
  chat_template.jinja
  preprocessor_config.json
  processor_config.json
  tokenizer.json
  tokenizer_config.json
)

# Quant-specific ONNX files. Each .onnx is paired with .onnx_data (and
# sometimes _data_1, _data_2 etc. for files >2 GB). The HF API tells us how
# many shards exist; we discover them dynamically with HEAD requests rather
# than hard-coding.
ONNX_BASES=(
  "onnx/decoder_model_merged_${QUANT}"
  "onnx/embed_tokens_${QUANT}"
  "onnx/vision_encoder_${QUANT}"
)

mkdir -p "${DEST_DIR}/onnx"

download_file() {
  local rel="$1"
  local dest="${DEST_DIR}/${rel}"
  local url="${BASE_URL}/${rel}"

  mkdir -p "$(dirname "$dest")"

  if [ -s "$dest" ]; then
    # Compare local size to remote Content-Length; resume if short, skip if equal.
    local remote_size
    remote_size=$(curl -sLI -o /dev/null -w '%{size_download}\n%{header_json}' "$url" \
      | python3 -c 'import json,sys; lines=sys.stdin.read().split("\n",1); h=json.loads(lines[1]); print((h.get("content-length") or [""])[0])' \
      2>/dev/null || echo "")
    local local_size
    local_size=$(stat -f%z "$dest" 2>/dev/null || stat -c%s "$dest" 2>/dev/null || echo 0)
    if [ -n "$remote_size" ] && [ "$local_size" = "$remote_size" ]; then
      printf "  ✓ %-60s (%s bytes, up-to-date)\n" "$rel" "$local_size"
      return 0
    fi
  fi

  printf "  → %s\n" "$rel"
  curl -L --fail --progress-bar --continue-at - -o "$dest" "$url"
}

remote_exists() {
  local rel="$1"
  local code
  code=$(curl -sLI -o /dev/null -w '%{http_code}' "${BASE_URL}/${rel}")
  [ "$code" = "200" ]
}

echo "═══════════════════════════════════════════════════════════════"
echo "  Safe Scroll - Gemma 4 E2B ONNX downloader"
echo "  Repo:  ${REPO}"
echo "  Quant: ${QUANT}"
echo "  Dest:  ${DEST_DIR}"
echo "═══════════════════════════════════════════════════════════════"

echo ""
echo "[1/2] Common files…"
for f in "${COMMON_FILES[@]}"; do
  download_file "$f"
done

echo ""
echo "[2/2] ONNX weights (${QUANT})…"
for base in "${ONNX_BASES[@]}"; do
  download_file "${base}.onnx"

  # External-data shards: <base>.onnx_data, .onnx_data_1, .onnx_data_2, …
  if remote_exists "${base}.onnx_data"; then
    download_file "${base}.onnx_data"
    i=1
    while remote_exists "${base}.onnx_data_${i}"; do
      download_file "${base}.onnx_data_${i}"
      i=$((i + 1))
    done
  fi
done

echo ""
echo "Done. The extension will pick up the bundled model on next reload."
echo "Total bundled size:"
du -sh "${DEST_DIR}" | awk '{print "  " $0}'
