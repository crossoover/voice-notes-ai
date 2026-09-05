import { app } from 'electron'
import { dirname, join } from 'path'

// Dev: main runs from <repo>/out/main. Packaged: next to the app bundle (spec §6).
// One definition, so the startup check and the process that gets spawned can
// never disagree about where these live.
const ROOT = app.isPackaged ? join(dirname(app.getPath('exe')), '..') : join(__dirname, '../..')

export const WHISPER_BIN = join(ROOT, 'vendor/whisper.cpp/build/bin/whisper-cli')
export const WHISPER_MODEL = join(ROOT, 'models/ggml-base.en.bin')
