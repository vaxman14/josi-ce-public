// Resample continuously to mono 16 kHz PCM16, regardless of hardware rate.
// Keeping fractional position across callbacks avoids drift or dropped samples.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(8000);
    this.offset = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) {
      this.sum += value;
      this.count += 1;
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.frame[this.offset++] = Math.round(Math.max(-1, Math.min(1, this.sum / this.count)) * 32767);
        this.sum = 0;
        this.count = 0;
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(8000);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('josi-voice-capture', VoiceCapture);
