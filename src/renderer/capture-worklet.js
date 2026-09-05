// Runs on the audio thread. Copies each 128-frame block of mono mic input back to
// the main thread; everything else (RMS, buffering, gating) happens there.
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0][0]
    // The worklet reuses its input buffer, so post a copy, not the view.
    if (channel) this.port.postMessage(new Float32Array(channel))
    return true
  }
}

registerProcessor('capture', Capture)
