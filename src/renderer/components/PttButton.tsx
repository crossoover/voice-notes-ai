export default function PttButton(props: {
  recording: boolean
  disabled: boolean
  onStart: () => void
  onStop: () => void
}): React.JSX.Element {
  const { recording, disabled, onStart, onStop } = props
  return (
    <button
      type="button"
      className={`ptt${recording ? ' ptt-on' : ''}`}
      disabled={disabled}
      onPointerDown={onStart}
      onPointerUp={onStop}
      onPointerCancel={onStop}
      // Only a pointer that is still held counts as dragging off the button; an
      // unpressed pointer merely passing over it must not cancel a Space hold.
      onPointerLeave={(e) => {
        if (e.buttons !== 0) onStop()
      }}
    >
      <span className="ptt-dot" />
      {recording ? 'Release to send' : 'Hold to talk'}
    </button>
  )
}
