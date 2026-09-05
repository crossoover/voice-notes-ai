# spec.md — Voice Notes AI

A push-to-talk desktop assistant. Hold a key, speak, release → your words are transcribed
locally, sent to a coding-agent CLI that can read and write files in a `notes/` folder,
and the reply is shown in the window and spoken back.

This is a take-home assignment. **Everything must run free and offline-capable except the
agent CLI itself.** Target platform is **macOS only** (Apple Silicon assumed, Intel should
work). Do not add Windows/Linux code paths.

---

## 0. Guiding constraints — read before writing code

1. **Small is the goal.** The grading criterion is literally "the final code is as small as
   the problem — did you cut what the agent over-built?" Do not add abstraction layers,
   plugin systems, state-management libraries, DI containers, or config frameworks. No
   Redux/Zustand. No repository pattern. Plain functions and React `useState`.
2. **No feature not listed here.** If something is tempting but not in this spec, it belongs
   in the README's "what I'd do next" section, not in the code.
3. **Fail loudly and visibly in the UI**, never in the console only. Every failure mode
   listed in §7 must produce something the user can see and act on.
4. **Commit as you go.** Real, incremental commits — do not squash at the end. Suggested
   commit boundaries are marked `[commit]` in §9.
5. **Type everything.** TypeScript strict mode on. No `any` in IPC payloads.

---

## 1. Tech stack (decided — do not re-litigate)

| Concern | Choice | Notes |
|---|---|---|
| Shell | **Electron** | macOS only |
| Scaffold | **electron-vite + React + TypeScript** | `npm create @quick-start/electron@latest` → React + TS variant |
| Language | TypeScript, strict | |
| STT | **whisper.cpp, local** | `ggml-base.en` (~142MB), invoked as a subprocess |
| Audio capture | **Web Audio API → raw PCM → WAV written in main** | No ffmpeg, no extra binaries |
| Agent | **`claude -p` (Claude Code CLI)**, pinned | `--output-format stream-json` |
| TTS | **macOS `say`** subprocess | Free, offline, killable |
| Styling | Plain CSS (or CSS modules). No Tailwind, no UI kit. | |
| Packaging | Leave `electron-builder` as scaffolded; **do not** ship a signed `.dmg`. Running via `npm run dev` is the documented path. | |

**Prerequisites the README must state** (reviewer's clean machine):
- macOS, Node ≥ 20
- Claude Code CLI installed and authenticated (`npm i -g @anthropic-ai/claude-code`, then `claude` once to log in)
- Xcode Command Line Tools (needed to build whisper.cpp)

---

## 2. Architecture

Three processes, thin boundary between them.

```
┌─────────────────────────────────────────────────────────────┐
│ RENDERER (React)                                            │
│  • PTT input: Space keydown/keyup + hold-the-button          │
│  • Web Audio capture @16kHz mono → Float32 chunks            │
│  • RMS + duration silence gate (pre-check)                   │
│  • Transcript UI, streaming reply, error banners             │
└───────────────┬─────────────────────────────────────────────┘
                │ contextBridge IPC (typed, preload)
┌───────────────┴─────────────────────────────────────────────┐
│ MAIN                                                        │
│  • wav.ts       Float32[] → 16-bit PCM WAV → temp file       │
│  • whisper.ts   spawn whisper-cli → text                     │
│  • agent.ts     spawn claude -p, parse stream-json → events  │
│  • tts.ts       spawn `say`, killable                        │
│  • turn.ts      orchestrates one turn; owns cancellation     │
└─────────────────────────────────────────────────────────────┘
```

Everything that spawns a process lives in **main**. The renderer never touches
`child_process` or `fs`. `contextIsolation: true`, `nodeIntegration: false`.

### Repo layout

```
voice-notes-ai/
├─ spec.md
├─ build-task.md
├─ README.md
├─ package.json
├─ scripts/setup-whisper.sh      # builds whisper.cpp + downloads model
├─ notes/                        # the agent's sandbox; committed with .gitkeep
├─ models/                       # gitignored; ggml-base.en.bin lands here
├─ vendor/whisper.cpp/           # gitignored; cloned by setup script
└─ src/
   ├─ main/
   │  ├─ index.ts                # window, app lifecycle, IPC registration
   │  ├─ turn.ts                 # one turn: wav → whisper → agent → tts
   │  ├─ wav.ts
   │  ├─ whisper.ts
   │  ├─ agent.ts
   │  └─ tts.ts
   ├─ preload/index.ts           # typed contextBridge surface
   ├─ shared/types.ts            # IPC payload + event types, shared both ways
   └─ renderer/
      ├─ App.tsx
      ├─ useRecorder.ts          # Web Audio capture + silence gate
      ├─ components/             # Transcript.tsx, PttButton.tsx, Banner.tsx
      └─ styles.css
```

---

## 3. IPC contract

Define once in `src/shared/types.ts` and import on both sides.

**Renderer → main (invoke):**
```ts
// Float32Array samples are transferred as a Transferable ArrayBuffer.
submitUtterance(pcm: ArrayBuffer, sampleRate: number): Promise<{ turnId: string }>
cancelTurn(): Promise<void>          // hard barge-in; also kills `say`
newConversation(): Promise<void>     // clears the resumed session id
checkAgent(): Promise<{ ok: boolean; version?: string; error?: string }>
setMuted(muted: boolean): Promise<void>
```

**Main → renderer (send, channel `turn:event`):**
```ts
type TurnEvent =
  | { turnId: string; type: 'transcribing' }
  | { turnId: string; type: 'transcript';  text: string }
  | { turnId: string; type: 'rejected';    reason: 'silence' | 'too-short' | 'blank-transcript' }
  | { turnId: string; type: 'thinking' }
  | { turnId: string; type: 'tool';        label: string }   // e.g. "Reading shopping.md"
  | { turnId: string; type: 'delta';       text: string }    // append to reply
  | { turnId: string; type: 'done';        text: string }    // final full reply
  | { turnId: string; type: 'error';       message: string; detail?: string }
  | { turnId: string; type: 'cancelled' }
```

One turn at a time. Main holds a single `activeTurn` handle (child processes + turnId);
starting a new turn cancels the old one first (§7.2).

---

## 4. The pipeline, step by step

### 4.1 Push-to-talk (renderer)

**Decided: in-window hold.** Two equivalent triggers:
- **Space** `keydown` → start, `keyup` → stop. Ignore auto-repeat (`e.repeat === true`).
  Ignore when the event target is an `input`/`textarea`/`contenteditable`. `preventDefault`
  so Space doesn't scroll or activate a focused button.
- **Hold the record button** with the mouse: `pointerdown` → start, `pointerup` /
  `pointercancel` / `pointerleave` → stop.

Also stop recording on `window.blur` (user cmd-tabbed away mid-hold) so we never leave the
mic open.

> The README must explicitly state: global system-wide hold-to-talk was **intentionally
> skipped**. Electron's `globalShortcut` has no key-*release* event, so it can only do
> press-to-start/press-to-stop, which isn't real push-to-talk; doing it properly needs
> `uiohook-napi`, a native module that requires a macOS Accessibility permission grant and
> adds real packaging pain on a clean machine. That trade — window-focused hold now,
> `uiohook-napi` as the documented next step — goes in both "what I cut and why" and
> "what I'd do next".

### 4.2 Capture (renderer, `useRecorder.ts`)

- `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`.
- `new AudioContext({ sampleRate: 16000 })`. If the OS refuses 16kHz, fall back to the
  context's native rate and resample by simple linear interpolation before sending — record
  the actual rate and pass it over IPC either way.
- Use an `AudioWorkletNode` to collect `Float32Array` chunks (fall back to
  `ScriptProcessorNode` only if the worklet fails to load — do not write both paths
  speculatively).
- Track running **peak RMS** across chunks while recording, and drive a live level meter
  from it.
- On stop: concatenate chunks into one `Float32Array`, apply the pre-gate (§4.3), and if it
  passes, `submitUtterance(buf.buffer, sampleRate)`.
- Release the `MediaStream` tracks and close the `AudioContext` between turns. Do not hold
  the mic open (macOS shows an orange indicator; leaving it on looks bad).

### 4.3 Silence gate — pre-check (renderer)

Reject **before** spending CPU, and show a non-blocking toast:

- duration < **350 ms** → `too-short`, toast "Too short — hold and speak."
- peak RMS < **0.01** (tune on real hardware; expose as a top-of-file constant) →
  `silence`, toast "Didn't catch that — try again."

Rejected utterances never reach whisper or the agent, and never enter the transcript.

### 4.4 Transcription (main, `whisper.ts`)

- Write the PCM to a 16-bit mono WAV in `app.getPath('temp')` (`wav.ts`: 44-byte canonical
  header, clamp+scale Float32 → Int16). Delete the file in a `finally`.
- Spawn:
  ```
  vendor/whisper.cpp/build/bin/whisper-cli \
    -m models/ggml-base.en.bin \
    -f <tmp.wav> \
    --output-txt --no-timestamps --language en --threads <os.cpus().length>
  ```
  Read the resulting `.txt` (or stdout — pick one and stick with it).
- **Post-gate.** Trim, collapse whitespace. Reject if:
  - empty after trimming, or
  - it matches the hallucination blacklist (case-insensitive, whole-string, punctuation
    stripped): `[BLANK_AUDIO]`, `(silence)`, `[silence]`, `[ Silence ]`, `thank you`,
    `thanks for watching`, `you`, `bye`, `.`, `[MUSIC]`, `[BLANK]`
  → emit `rejected: 'blank-transcript'` with the same "Didn't catch that" toast.
- Otherwise emit `transcript` and continue. The user's line appears in the transcript
  immediately, before the agent starts.

### 4.5 The agent (main, `agent.ts`)

Spawn per turn:

```ts
spawn('claude', [
  '-p', text,
  '--output-format', 'stream-json',
  '--verbose',
  '--allowedTools', 'Read,Write,Edit,Glob,Grep',
  '--append-system-prompt', SYSTEM_PROMPT,
  ...(sessionId ? ['--resume', sessionId] : []),
], { cwd: NOTES_DIR })
```

- **`cwd` is the `notes/` directory.** Combined with the `--allowedTools` allowlist (no
  `Bash`, no `WebFetch`, no `WebSearch`, no `Task`), the agent can only read and write inside
  the notes folder. Non-interactive `-p` cannot prompt for permission, so anything outside
  that set is simply refused and the agent says so in its reply — which is the correct,
  visible behavior.
- **Do not use `--dangerously-skip-permissions`.** Say why in the README: it would hand an
  unattended agent full tool access on the reviewer's machine.
- `SYSTEM_PROMPT` (keep it short, one place in the file):
  > You are a voice notes assistant. You work only inside this notes folder, which holds
  > plain-Markdown notes. Create or edit files as needed, choosing obvious filenames like
  > `shopping.md` or `todo.md`. Your reply is read aloud by a text-to-speech voice: answer
  > in 1–3 short spoken sentences, plain prose, no Markdown, no code blocks, no bullet
  > lists, no file paths unless asked.

**Parsing `stream-json`:** stdout is NDJSON. Buffer partial lines and split on `\n`; wrap
each `JSON.parse` in try/catch and ignore unparseable lines rather than failing the turn
(the CLI's exact event shapes vary by version — code defensively).

- `type: 'system', subtype: 'init'` → capture `session_id`, store it for `--resume`.
- `type: 'assistant'` → for each `content` block: `text` → emit `delta` with the text;
  `tool_use` → emit `tool` with a friendly label built from the tool name + `file_path`
  basename, e.g. `Reading shopping.md`, `Writing shopping.md`.
- `type: 'result'` → emit `done` with `result` as the final text; also refresh `session_id`.

Since deltas may arrive as whole blocks rather than tokens, the renderer must treat `delta`
as *append* and `done` as *authoritative replacement* of the reply text.

**Session continuity.** Keep `sessionId` in a main-process variable. A **New conversation**
button clears it. It is not persisted to disk — state dies with the app, and the README says
so plainly (the `notes/` files are the real persistence).

### 4.6 Speaking the reply (main, `tts.ts`)

On `done`, if not muted:
- Clean the text: strip fenced/inline code, Markdown emphasis and headings, list bullets,
  link syntax (keep link text), and bare URLs; collapse whitespace; **truncate to 400 chars**
  at a sentence boundary if possible.
- If nothing survives cleaning, skip TTS silently.
- `spawn('say', ['-v', 'Samantha', cleaned])`. Keep the handle; kill it on barge-in, on a
  new turn, on mute, and on app quit.
- A mute toggle in the UI header, default **unmuted**.

---

## 5. UI

One window, ~480×720, resizable. Looks intentional, not fancy. Dark or light — pick one and
be consistent; system font stack; no icon library (inline SVG or a text glyph is fine).

```
┌──────────────────────────────────────┐
│ Voice Notes            [🔇] [＋ New]  │  header: mute, new conversation
├──────────────────────────────────────┤
│ ⚠ Claude CLI not found — install …   │  banner (only when broken)
├──────────────────────────────────────┤
│                                      │
│   You    add milk to my shopping     │  transcript, newest at bottom,
│          list                        │  auto-scrolled
│                                      │
│   ⚙ Reading shopping.md              │  tool activity, muted style
│   ⚙ Writing shopping.md              │
│                                      │
│   AI     Added milk to your shopping │  streams in
│          list.                       │
│                                      │
├──────────────────────────────────────┤
│  ▁▃▅▇▅▃▁   0:03                      │  level meter + timer while recording
│                                      │
│      ( ● Hold to talk )              │  hold target; Space works too
│      Transcribing… / Thinking 4s ⟨Stop⟩│ status line
└──────────────────────────────────────┘
```

Required states, each visually distinct: **idle** ("Hold Space or the button to talk"),
**recording** (level meter + `m:ss` timer, red button), **transcribing**, **thinking**
(elapsed-seconds counter + a **Stop** button that calls `cancelTurn`), **speaking**
(a subtle indicator; Stop also stops speech), **error**.

Toasts (auto-dismiss ~2.5s) for the rejection reasons in §4.3/§4.4.

---

## 6. `notes/` folder

- Lives at the repo root, next to the app. Resolve it once in main:
  `app.isPackaged ? path.join(path.dirname(app.getPath('exe')), '..', 'notes') : path.join(__dirname, '../../notes')`
  — verify the dev path against the actual electron-vite output layout.
- `mkdirSync(NOTES_DIR, { recursive: true })` on startup.
- Committed to git with a `.gitkeep`, plus a `notes/README.md` one-liner explaining what the
  folder is. Do **not** commit demo notes — a clean run should start empty.

---

## 7. Edge cases — all of these must be implemented

### 7.1 Silent / too-short / garbage audio
Both gates as specified in §4.3 and §4.4. Never send noise to an agent that writes files.

### 7.2 Barge-in — user pushes to talk while the agent is working or speaking
**Hard barge-in.** On PTT start, before recording:
1. Kill the `say` process, if any.
2. `SIGTERM` the `claude` child; `SIGKILL` 2s later if it hasn't exited.
3. Emit `cancelled` for that turnId; the renderer marks the turn
   **"Interrupted — the assistant may have already changed files."**
4. Discard the partial reply text (keep the label, not the half-sentence).
5. Start recording.

The warning wording matters and must be in the UI: files the agent already wrote **stay
written**, and the spec acknowledges that rather than pretending cancellation is atomic. The
same path backs the **Stop** button. Cancellation must be idempotent — a second cancel on an
already-dead turn is a no-op, not a crash.

### 7.3 Agent CLI missing, unauthenticated, hung, or erroring
- **Preflight at launch:** run `claude --version` once. On failure, show a persistent banner:
  "Claude CLI not found. Install with `npm i -g @anthropic-ai/claude-code` and run `claude`
  once to sign in." Recording stays enabled (transcription still demos), but a turn that
  reaches the agent errors clearly.
- **Timeout: 60s** per turn from spawn to `result`. On expiry → `SIGTERM`, `SIGKILL` at +2s,
  emit `error` "The agent didn't respond within 60s."
- **Non-zero exit, or a `result` with `is_error: true`, or no `result` at all** → red error
  bubble in the transcript with the message plus the last ~3 lines of stderr in a collapsed
  `<details>`. The app stays usable; the next turn proceeds normally.
- **Auth/rate-limit errors** surface verbatim from stderr — do not swallow or reword them.

### 7.4 Microphone permission denied or no input device
`getUserMedia` rejects with `NotAllowedError` / `NotFoundError`. Show a persistent banner:
"Microphone access denied — enable it in System Settings → Privacy & Security → Microphone,
then restart the app." Disable the record button. Add `NSMicrophoneUsageDescription` to the
electron-builder mac config for packaging.

### 7.5 Runaway recording
Auto-stop at **60s**. Show the timer in a warning color from 50s. Treat it as a normal
release (the audio is transcribed, not discarded).

### 7.6 Whisper model or binary missing
If `models/ggml-base.en.bin` or the `whisper-cli` binary isn't present at startup, show a
persistent banner: "Speech model not installed — run `npm run setup`." Do not attempt a
silent download at runtime.

### 7.7 Whisper crashes or times out
Non-zero exit, or **30s** with no result → `error` "Couldn't transcribe that." Delete the
temp WAV regardless. Never leave temp WAVs behind (`finally`).

### 7.8 Overlapping turns
One turn at a time, enforced in main. A `submitUtterance` while a turn is active cancels the
old turn first (§7.2). The renderer additionally ignores PTT start while already recording.

### 7.9 App quit mid-flight
`before-quit`: kill `claude`, kill `say`, remove temp WAVs. No orphan processes.

### 7.10 Agent replies with a refusal or an empty reply
If the `result` text is empty or whitespace, render "(no reply)" and skip TTS. If the agent
refuses because a tool wasn't allowed, its own explanation is the reply — show it as-is.

### 7.11 Very long agent replies
Render in full in the window; TTS speaks the cleaned 400-char truncation (§4.6). The system
prompt should keep this rare.

---

## 8. Setup script — `scripts/setup-whisper.sh` (wired to `npm run setup`)

Idempotent, prints what it's doing, exits non-zero on failure:
1. If `vendor/whisper.cpp` is absent, `git clone --depth 1 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp`.
2. Build: `cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j --config Release`
   (Metal is enabled by default on Apple Silicon).
3. If `models/ggml-base.en.bin` is absent, download it into `models/` (use whisper.cpp's
   `models/download-ggml-model.sh base.en` and move the result, or `curl` from the
   HuggingFace `ggerganov/whisper.cpp` repo).
4. Verify both artifacts exist and print their paths; fail with a clear message if not.

`.gitignore` must include `vendor/`, `models/`, `node_modules/`, `out/`, `dist/`.

---

## 9. Build order (suggested commit boundaries)

1. `[commit]` electron-vite React+TS scaffold, stripped to a blank window. Delete every
   piece of demo/boilerplate content the template ships.
2. `[commit]` `scripts/setup-whisper.sh` + `npm run setup`; verify it works from clean.
3. `[commit]` Web Audio capture + PTT (Space and button) + level meter + silence gate; dump
   the WAV to disk and confirm it plays.
4. `[commit]` `whisper.ts` + `wav.ts`: transcript appears in the window. End of this step is
   the first genuinely demoable milestone.
5. `[commit]` `agent.ts`: `claude -p` with `stream-json`, session resume, tool labels,
   streaming reply. Verify "add milk to my shopping list" creates `notes/shopping.md` and
   "what's on my list?" reads it back.
6. `[commit]` Cancellation and barge-in (§7.2), timeouts, error bubbles, preflight banner.
7. `[commit]` `tts.ts` — `say` with cleaned text, mute toggle, killed on barge-in.
8. `[commit]` UI pass: states, toasts, empty state, styling.
9. `[commit]` README.

---

## 10. Manual test checklist (run all of these on camera)

| # | Action | Expected |
|---|---|---|
| 1 | Hold Space, say "add milk to my shopping list", release | Transcript shows it; tool labels appear; `notes/shopping.md` exists with milk; reply is spoken |
| 2 | "what's on my shopping list?" | Answers from the file; does not re-write it |
| 3 | "actually make that two liters" | Session resume works — edits the existing entry without being told which file |
| 4 | Tap Space and release instantly | "Too short" toast; no whisper call, no transcript entry |
| 5 | Hold Space 3s in silence, release | "Didn't catch that"; nothing sent to the agent |
| 6 | Hold Space while the agent is mid-reply | Speech stops instantly, turn marked "Interrupted — may have already changed files", new recording starts |
| 7 | Click **Stop** during "Thinking" | Same cancellation path; no orphan `claude` process (`ps aux \| grep claude`) |
| 8 | Rename `claude` off PATH, relaunch | Preflight banner with install instructions; app still records and transcribes |
| 9 | Hold Space for 65s | Auto-stops at 60s, warning color at 50s, still transcribes |
| 10 | Deny mic permission | Banner with the System Settings path; record button disabled |
| 11 | Delete `models/ggml-base.en.bin`, relaunch | "run `npm run setup`" banner; no cryptic crash |
| 12 | **New conversation**, then "what did I just say?" | No memory of the prior turn |
| 13 | Quit mid-turn | No orphan `claude`/`say` processes; no leftover temp WAVs |

---

## 11. README requirements (graded — write it last, write it honestly)

Must contain:
1. **How to run on a clean machine**: prerequisites (§1), `npm install`, `npm run setup`,
   `npm run dev`. Note the first-run mic permission prompt and that `npm run setup` builds
   whisper.cpp and downloads ~142MB.
2. **What works** — the demo script from §10 rows 1–3.
3. **What I cut and why**, explicitly including:
   - **Global system-wide hold-to-talk.** Electron's `globalShortcut` has no key-release
     event, so it can only do press-to-start/press-to-stop, not true hold. Doing it right
     needs `uiohook-napi`, a native module requiring a macOS Accessibility grant and
     meaningful packaging pain on a clean machine — not worth it for a take-home. The app
     uses in-window hold (Space or the button) instead.
   - Transcript persistence across restarts — `notes/` is the real persistence.
   - A signed/notarized `.dmg` — `npm run dev` is the documented path.
   - Windows support — macOS-only by choice, and `say` is macOS-only.
   - `--dangerously-skip-permissions` was deliberately *not* used; the agent is confined by
     `cwd` + an explicit `--allowedTools` allowlist.
4. **Known limitations**: cancellation isn't atomic (files already written stay written);
   `base.en` mis-hears unusual proper nouns; whisper adds ~1–2s and the agent ~3–10s per turn.
5. **What I'd do next**: `uiohook-napi` global PTT, streaming/partial transcription while
   holding, a notes file browser in the window, voice-activity detection instead of a
   fixed RMS threshold, better TTS.
6. **How long it actually took** — honest wall-clock. A truthful 4 hours beats a claimed 90
   minutes.

---

## 12. Explicitly out of scope

No settings screen. No note browser/editor UI. No multi-language support. No wake word. No
streaming/partial transcription while the key is held. No cloud STT fallback. No analytics.
No tests beyond the manual checklist in §10 (say so in the README rather than pretending).
No Windows or Linux code paths. No auto-update. No database.
