import type { ChildProcess } from 'child_process'

const SIGKILL_AFTER_MS = 2000

/** Ask a child to stop, then insist. Safe to call on an already-dead child. */
export function endProcess(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_AFTER_MS)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}
