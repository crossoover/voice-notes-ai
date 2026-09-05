import { execFile, spawn } from 'child_process'
import { basename } from 'path'
import { endProcess } from './kill'
import { NOTES_DIR } from './paths'

const TIMEOUT_MS = 60_000

const SYSTEM_PROMPT = [
  'You are a voice notes assistant. You work only inside this notes folder, which holds',
  'plain-Markdown notes. Create or edit files as needed, choosing obvious filenames like',
  '`shopping.md` or `todo.md`. Your reply is read aloud by a text-to-speech voice: answer',
  'in 1-3 short spoken sentences, plain prose, no Markdown, no code blocks, no bullet',
  'lists, no file paths unless asked.'
].join(' ')

// Not a sandbox — confinement here is three things stacked. Bash, WebFetch, WebSearch
// and Task are absent from the allowlist, so those calls are denied outright. Read and
// friends do accept absolute paths, but reaching outside cwd needs permission, and
// under -p nothing can grant it, so the attempt fails and the agent says so in its
// reply. cwd is what makes the notes folder the natural place to work.
const ALLOWED_TOOLS = 'Read,Write,Edit,Glob,Grep'

const TOOL_VERB: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  Glob: 'Searching',
  Grep: 'Searching'
}

// Lives only in memory: the notes files are the real persistence (spec §4.5).
let sessionId: string | null = null

export function newConversation(): void {
  sessionId = null
}

/** Is the CLI installed and runnable at all? Checked once at startup (spec §7.3). */
export function checkAgent(): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) resolve({ ok: false, error: err.message })
      else resolve({ ok: true, version: stdout.trim() })
    })
  })
}

function toolLabel(name: unknown, input: unknown): string {
  const verb = typeof name === 'string' ? (TOOL_VERB[name] ?? `Using ${name}`) : 'Working'
  const path =
    input && typeof input === 'object' && 'file_path' in input
      ? (input as { file_path?: unknown }).file_path
      : undefined
  return typeof path === 'string' ? `${verb} ${basename(path)}` : `${verb} notes`
}

function lastLines(text: string, count: number): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines.slice(-count).join('\n')
}

export type AgentRun = { kill: () => void; reply: Promise<string> }

export function ask(
  prompt: string,
  on: { tool: (label: string) => void; delta: (text: string) => void }
): AgentRun {
  const child = spawn(
    'claude',
    [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      ALLOWED_TOOLS,
      '--append-system-prompt',
      SYSTEM_PROMPT,
      ...(sessionId ? ['--resume', sessionId] : [])
    ],
    // stdin must be closed, not piped: with an open stdin pipe `claude -p` waits
    // on it forever and never emits a single line.
    { cwd: NOTES_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const resumed = sessionId !== null
  // Whether we ended this run, tracked rather than inferred: the CLI handles SIGTERM
  // and exits 143, so a killed run looks like an ordinary non-zero exit from here.
  let killed = false
  const kill = (): void => {
    killed = true
    endProcess(child)
  }

  const reply = new Promise<string>((resolve, reject) => {
    let buffered = ''
    let stderr = ''
    let result: string | null = null
    // Held locally until the run finishes. A killed run never persists its session,
    // so adopting its id would make every later turn fail to resume.
    let runSessionId: string | null = null
    const fail = (message: string, detail?: string): void => {
      reject(new Error(message, { cause: detail }))
    }

    const timer = setTimeout(() => {
      kill()
      fail(`The agent didn't respond within ${TIMEOUT_MS / 1000}s.`, lastLines(stderr, 3))
    }, TIMEOUT_MS)

    const handle = (event: Record<string, unknown>): void => {
      // The CLI's exact shapes vary by version, so read defensively and ignore
      // anything that doesn't look like what we expect.
      if (typeof event.session_id === 'string') runSessionId = event.session_id

      if (event.type === 'assistant') {
        const message = event.message as { content?: unknown } | undefined
        const content = Array.isArray(message?.content) ? message.content : []
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const { type, text, name, input } = block as Record<string, unknown>
          if (type === 'text' && typeof text === 'string' && text !== '') on.delta(text)
          else if (type === 'tool_use') on.tool(toolLabel(name, input))
        }
      } else if (event.type === 'result') {
        if (event.is_error === true) {
          fail(
            typeof event.result === 'string' && event.result.trim() !== ''
              ? event.result
              : 'The agent reported an error.',
            lastLines(stderr, 3)
          )
        } else if (typeof event.result === 'string') {
          result = event.result
        }
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk
      const lines = buffered.split('\n')
      // The last piece may be half a line; hold it until the rest arrives.
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        try {
          handle(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // A line we can't parse is not worth failing the turn over.
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))

    child.on('error', (err) => {
      clearTimeout(timer)
      fail('Could not run the Claude CLI.', err.message)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (result !== null) {
        if (runSessionId !== null) sessionId = runSessionId
        resolve(result)
        return
      }

      // A resume that never even reached `init` means the session is gone, and
      // keeping its id would fail every later turn the same way. A run we killed
      // proves nothing about the session, and one that got as far as `init` failed
      // for some other reason — neither should lose the conversation.
      if (resumed && runSessionId === null && !killed) sessionId = null

      // Auth and rate-limit failures say the useful thing on stderr, and §7.3 wants
      // that verbatim rather than one disclosure click away behind a generic line.
      const tail = lastLines(stderr, 3)
      const lines = tail.split('\n')
      const headline = lines[lines.length - 1]
      if (code === 0) fail('The agent finished without replying.', tail)
      else if (headline) fail(headline, lines.length > 1 ? tail : undefined)
      else fail('The agent failed.', `claude exited with ${signal ?? code}`)
    })
  })

  return { kill, reply }
}
