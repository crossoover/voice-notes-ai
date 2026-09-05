import { useEffect, useRef } from 'react'

export type Entry = {
  // Per entry, not per turn: one turn can produce both a transcript and an error.
  id: string
  // Set on streamed reply bubbles so `done` can replace a turn's whole reply.
  turnId?: string
  kind: 'you' | 'ai' | 'tool' | 'note' | 'error'
  text: string
  detail?: string
}

const WHO: Record<Entry['kind'], string> = {
  you: 'You',
  ai: 'AI',
  tool: '',
  note: '',
  error: 'Error'
}

export default function Transcript({ entries }: { entries: Entry[] }): React.JSX.Element {
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [entries])

  return (
    <main className="transcript">
      {entries.length === 0 && <p className="empty">Hold Space or the button to talk.</p>}
      {entries.map((entry) => (
        <div key={entry.id} className={`entry entry-${entry.kind}`}>
          <span className="who">{WHO[entry.kind]}</span>
          <div className="said">
            {entry.text}
            {entry.detail && (
              <details className="detail">
                <summary>Details</summary>
                <pre>{entry.detail}</pre>
              </details>
            )}
          </div>
        </div>
      ))}
      <div ref={bottom} />
    </main>
  )
}
