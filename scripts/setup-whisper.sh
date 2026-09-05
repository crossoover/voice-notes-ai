#!/usr/bin/env bash
# Builds whisper.cpp and downloads the speech model the app transcribes with.
# Safe to re-run: anything already working is left alone, anything broken is rebuilt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$ROOT/vendor/whisper.cpp"
WHISPER_TAG="v1.9.3"
BIN="$REPO/build/bin/whisper-cli"
MODEL="$ROOT/models/ggml-base.en.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

step() { printf '\n==> %s\n' "$1"; }
die() { printf '\nsetup failed: %s\n' "$1" >&2; exit 1; }
# The binary hardcodes an absolute rpath to its build directory, so a moved or
# half-built checkout leaves a file that exists but cannot run. Ask it to run.
works() { "$BIN" --help >/dev/null 2>&1; }

xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools are missing. Run \`xcode-select --install\`."
for tool in git cmake curl; do
  command -v "$tool" >/dev/null || die "\`$tool\` not found. cmake comes from \`brew install cmake\`."
done

if [ -d "$REPO/.git" ]; then
  step "whisper.cpp already cloned at vendor/whisper.cpp ($(git -C "$REPO" describe --tags --always))"
else
  step "Cloning whisper.cpp $WHISPER_TAG into vendor/whisper.cpp"
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp "$REPO"
fi

if works; then
  step "whisper-cli already built"
else
  step "Building whisper.cpp (Release, Metal on Apple Silicon) — this takes a few minutes"
  cmake -S "$REPO" -B "$REPO/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$REPO/build" -j"$(sysctl -n hw.ncpu)" --config Release
fi

if [ -f "$MODEL" ]; then
  step "Model already downloaded"
else
  step "Downloading ggml-base.en.bin (~142MB) into models/"
  mkdir -p "$ROOT/models"
  # Download under a .part name so the real filename never holds a truncated file.
  # An interrupted run leaves the .part behind; the next run starts it over.
  curl -fL --progress-bar -o "$MODEL.part" "$MODEL_URL"
  mv "$MODEL.part" "$MODEL"
fi

works || die "the whisper binary at $BIN won't run. Delete vendor/ and re-run."
[ -s "$MODEL" ] || die "expected the model at $MODEL but it isn't there. Delete models/ and re-run."

step "Ready"
printf '  binary: %s\n  model:  %s (%s)\n' "$BIN" "$MODEL" "$(du -h "$MODEL" | cut -f1)"
