## Build a small desktop assistant

### What it does

1. **Electron app, TypeScript.** Mac or Windows, your choice.
2. **Push-to-talk.** Hold a key or button, speak, release → your words appear as text in the window.
3. **The words go to an AI agent that runs through your coding agent's CLI** (e.g. `claude -p …`, `codex exec …`, `cursor-agent -p …`), not the raw API. The agent must be able to **read and write files in a `notes/` folder** next to the app — "add milk to my shopping list" should create or edit `notes/shopping.md`, and "what's on my list?" should answer from it.
4. **The reply is shown in the window.**
5. _Stretch, only if you're inside the budget:_ the reply is spoken back.

### Rules of the game

- **Speech-to-text: use whatever you have.** OpenAI Whisper, Deepgram, whisper.cpp, your OS's dictation — anything. A text box instead of push-to-talk counts as incomplete; if you go that way anyway, say why in the README.
- **UI:** generate it with whatever you like (Claude Design, v0, an image model → code, plain CSS). We care that it looks intentional and is usable, not that it's pretty.
- **Time:** tell us honestly how long it took. Nobody is scored on the number; a truthful 4 hours beats a claimed 90 minutes.
- **Don't clean up the history.** Real commits as you go, not one squash at the end.

### What to send back

1. Git repo (GitHub link or zip) with a **README**: how to run it; what works; what you cut and why; what you'd do next; how long it actually took.
2. **Full, unedited screen recording** of the session (QuickTime, Loom, OBS — anything). We'll watch about 20 minutes of it. Don't narrate unless you want to.
3. **The agent session log.** Claude Code: the `.jsonl` for this project under `~/.claude/projects/`. Codex: the session file under `~/.codex/sessions/`. Other agents: whatever session export or log your tool keeps. This shows us how you brief and review an agent, which is most of what we're hiring for.

### What we look for

- It runs on a clean machine following your README.
- The final code is as small as the problem — did you cut what the agent over-built?
- How you brief the agent: a spec up front, or poking it prompt by prompt.
- Whether you read what it wrote before accepting.
- What you did when something didn't work (it will).
- A README that tells the truth.

Questions before you start: reply to the email. Otherwise — have fun with it.
