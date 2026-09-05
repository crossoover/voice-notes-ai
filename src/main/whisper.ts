import { spawn, type ChildProcess } from 'child_process'
import { cpus } from 'os'
import { WHISPER_BIN, WHISPER_MODEL } from './paths'

const TIMEOUT_MS = 30_000

// What whisper.cpp tends to invent when handed silence or noise. Compared after
// normalising, so bracket and punctuation variants all collapse onto one entry.
const HALLUCINATIONS = new Set([
  'blank audio',
  'silence',
  'thank you',
  'thanks for watching',
  'you',
  'bye',
  'music',
  'blank'
])

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** True when the transcript carries no words the agent should act on (spec §4.4). */
export function isBlank(text: string): boolean {
  const normalized = normalize(text)
  return normalized === '' || HALLUCINATIONS.has(normalized)
}

function lastLines(text: string, count: number): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines.slice(-count).join('\n')
}

export type Transcription = { child: ChildProcess; text: Promise<string> }

/**
 * Runs whisper-cli over a WAV file. The transcript comes back on stdout; all of
 * whisper's own logging goes to stderr, so no output file is needed. The child is
 * handed back so the caller can kill it, which nothing does yet.
 */
export function transcribe(wavPath: string): Transcription {
  const child = spawn(WHISPER_BIN, [
    '-m',
    WHISPER_MODEL,
    '-f',
    wavPath,
    '--no-timestamps',
    '--language',
    'en',
    '--threads',
    String(cpus().length)
  ])

  const text = new Promise<string>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const fail = (detail: string): void => {
      reject(new Error("Couldn't transcribe that.", { cause: detail }))
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(`whisper-cli did not finish within ${TIMEOUT_MS / 1000}s`)
    }, TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    child.on('error', (err) => {
      clearTimeout(timer)
      fail(err.message)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim().replace(/\s+/g, ' '))
      else fail(lastLines(stderr, 3) || `whisper-cli exited with ${signal ?? code}`)
    })
  })

  return { child, text }
}
