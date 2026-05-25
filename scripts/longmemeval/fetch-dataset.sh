#!/usr/bin/env bash
# Fetch the LongMemEval-S (small) dataset from HuggingFace into a local cache.
# Idempotent — skips download if the target file already exists with non-zero size.
#
# Source: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
# Variant: longmemeval_s_cleaned.json — 500 questions × ~40 haystack sessions.

set -euo pipefail

CACHE_DIR="${LONGMEMEVAL_CACHE_DIR:-$HOME/.cache/longmemeval}"
VARIANT="${LONGMEMEVAL_VARIANT:-longmemeval_s_cleaned.json}"
URL="https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/${VARIANT}"
TARGET="${CACHE_DIR}/${VARIANT}"

mkdir -p "$CACHE_DIR"

if [[ -s "$TARGET" ]]; then
  echo "longmemeval-fetch: ${TARGET} already present ($(wc -c <"$TARGET") bytes) — skipping."
  exit 0
fi

echo "longmemeval-fetch: downloading ${URL}"
curl -fsSL --retry 3 -o "${TARGET}.tmp" "$URL"
mv "${TARGET}.tmp" "$TARGET"
echo "longmemeval-fetch: wrote ${TARGET} ($(wc -c <"$TARGET") bytes)"
