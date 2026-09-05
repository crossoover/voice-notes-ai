# Voice Notes AI

A push-to-talk desktop assistant for macOS. Hold a key, speak, release → your words are
transcribed locally by whisper.cpp, sent to the Claude Code CLI running inside a `notes/`
folder, and the reply is shown in the window and read back to you.

"Add milk to my shopping list" creates `notes/shopping.md`. "What's on my list?" answers from
it. "Actually make that two liters" edits the right file without being told which one.

---

## Running it on a clean machine

**Prerequisites**

- macOS (built and tested on Apple Silicon, macOS 26)
- Node ≥ 20
- **Xcode Command Line Tools** — `xcode-select --install`
- **cmake** — `brew install cmake` (not included with the Command Line Tools)
- **Claude Code CLI**, installed and signed in:
  ```sh
  npm i -g @anthropic-ai/claude-code
  claude          # run once to log in, then quit
  ```
  Tested against **Claude Code 2.0.69**.

**Then**

```sh
npm install
npm run setup     # clones + builds whisper.cpp, downloads ggml-base.en.bin (~142MB)
npm run dev
```

`npm run setup` takes a few minutes on first run: it builds whisper.cpp v1.9.3 with Metal and
downloads the model. It is safe to re-run — everything already in place is skipped, and a
build that exists but can't run is rebuilt.

**On first launch**, macOS asks for microphone access. The first hold triggers the prompt; the
app tells you to hold again once you've allowed it. Notes are written to `notes/` next to the
app, which starts empty.

Running via `npm run dev` is the documented path. `npm run build:mac` produces an unsigned
`.app`, but it is not the way this is meant to be run — see *What I cut* below.

---

## What works

The demo script, all of it working end to end:

| Do | Happens |
|---|---|
| Hold Space, "add milk to my shopping list" | `⚙ Writing shopping.md`, spoken reply, `notes/shopping.md` created |
| "What's on my shopping list?" | Answers; doesn't rewrite the file |
| "Actually make that two liters" | `⚙ Editing shopping.md` — session resume picks the right file unprompted |
| Tap Space, or a very short hold | "Too short — hold and speak." Nothing is transcribed |
| Hold in silence | "Didn't catch that." Nothing reaches the agent |
| Hold Space while it's thinking or speaking | Speech stops, the agent is killed, turn marked interrupted, recording starts |
| **Stop** during "Thinking 4s" | Same path; no orphan processes |
| **＋ New** | Clears the conversation; the next question has no memory of earlier turns |
| Delete the model, or take `claude` off `PATH` | A banner says which one and how to fix it; the rest of the app still works |

Push-to-talk is **hold Space** or **hold the button** — either works, and releasing sends.
Space is ignored while typing in a field, and auto-repeat doesn't retrigger it.

## How it's put together

Three processes with a thin boundary. The renderer captures audio and draws; everything that
spawns a process lives in main; the preload exposes a typed bridge and nothing else.
`contextIsolation` on, `nodeIntegration` off, renderer sandboxed.

```
src/main/     index.ts  window, IPC, quit cleanup
              turn.ts   one turn: wav → whisper → agent → speech; owns cancellation
              wav.ts    Float32 → 16-bit PCM WAV
              whisper.ts / agent.ts / tts.ts   the three subprocesses
              paths.ts  where the binary, model and notes live — defined once
              kill.ts   SIGTERM, then SIGKILL 2s later
src/shared/   types.ts  the IPC contract, imported by both sides
src/renderer/ App.tsx, useRecorder.ts, components/
```

**The agent is not sandboxed, and I'd rather say so precisely.** It's confined by three things
stacked: it runs with `cwd` set to `notes/`; `--allowedTools Read,Write,Edit,Glob,Grep` leaves
out `Bash`, `WebFetch`, `WebSearch` and `Task`, so those are denied outright; and `Read` does
accept absolute paths, but reading outside `cwd` needs a permission that nothing can grant
under `-p`, so the attempt fails and the agent explains that in its reply.
`--dangerously-skip-permissions` was deliberately **not** used — it would hand an unattended
agent full tool access on your machine, which is not a reasonable thing to ask a reviewer to
run.

## What I cut, and why

- **Global system-wide hold-to-talk.** Electron's `globalShortcut` has no key-*release* event,
  so it can only do press-to-start/press-to-stop, which isn't push-to-talk. Doing it properly
  needs `uiohook-napi` — a native module requiring a macOS Accessibility grant and real
  packaging pain on a clean machine. Not worth it here. The app uses in-window hold instead.
- **Transcript persistence across restarts.** The session id lives in memory and dies with the
  app. `notes/` is the real persistence, and that's the point of the exercise.
- **A signed, notarized `.dmg`.** `npm run dev` is the documented path. The mac build config is
  real — it carries `NSMicrophoneUsageDescription` and the audio-input entitlement — but it
  builds unsigned on purpose, since no certificate is assumed on your machine.
- **Windows and Linux.** macOS only by choice; `say` is macOS-only anyway.
- **Automated tests.** There are none. I verified each step by driving the real modules against
  the real binaries — whisper-cli, `claude`, `say` — and the checklist above is the test suite.
  I'd rather say that than ship a token unit test.

## Known limitations

- **Cancellation isn't atomic.** Barge-in kills the agent, but files it already wrote stay
  written. The UI says exactly that rather than pretending otherwise.
- **A stray Space tap cancels whatever is running.** That's what push-to-talk barge-in means,
  but it does mean an accidental keypress can cost you a turn in flight.
- **`base.en` mishears.** Real examples from testing: "what's on my shopping list right now"
  came out as "Perfect, thanks, so wasn't my shopping list right now", and "make that" as
  "made that". The agent answered both correctly anyway, which says something about how much
  slack an LLM absorbs.
- **Every turn loses ~140ms of audio at the front.** The spec requires releasing the microphone
  between turns so the orange recording indicator goes out, and `getUserMedia` takes ~140ms to
  reopen it (~320ms on the first call). In practice the gap between pressing and starting to
  speak covers it — I didn't see a clipped word in testing — but it's there.
- **Speed**: whisper is well under a second on Apple Silicon with Metal; the agent takes 5–12
  seconds, which dominates the turn.
- **The 400-character speech cap** means a long reply is read in full on screen but cut short
  out loud, at a sentence boundary where possible.

## What I'd do next

1. **Real global push-to-talk** via `uiohook-napi`, with the Accessibility permission flow.
2. **Streaming transcription while the key is held**, so text appears as you speak instead of
   after you release.
3. **Voice activity detection** instead of a fixed RMS threshold — the current 0.01 gate is
   tuned to one room and one microphone.
4. **A notes browser in the window**, so you can see what the agent has been writing without
   leaving the app.
5. **Better TTS.** `say` is free, offline and instantly killable, which is exactly why it's
   here, but it sounds like 2005.
6. **Keep the microphone stream warm** behind an explicit indicator, to recover that 140ms.

## How long it took

**3 Hours 24 minutes 20 seconds**, from starting of the recording till me writing this text.