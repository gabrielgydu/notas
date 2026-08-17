/* Notas — microphone → 16 kHz mono s16le, on the audio thread.

   AssemblyAI's streaming endpoint wants signed 16-bit PCM at one fixed rate.
   The browser hands us Float32 in 128-frame quanta at whatever rate the device
   runs at, so this does both conversions and batches the result into 100 ms
   messages — small enough to stay real-time, large enough that the main thread
   is not woken 375 times a second. */

class PCM16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const target = o.targetRate || 16000;
    this.batch = o.batchSamples || 1600; // 100 ms at 16 kHz
    // `sampleRate` is the AudioContext's real rate. Asking for 16 kHz in the
    // constructor usually works; when it does not, this is the whole difference.
    this.ratio = sampleRate / target;
    this.out = new Int16Array(this.batch);
    this.n = 0;
    this.pos = 0; // read head, in source samples relative to the current quantum
    this.prev = 0; // last sample of the previous quantum, for interpolation
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'flush') this.flush();
    };
  }

  emit(v) {
    const s = v < -1 ? -1 : v > 1 ? 1 : v;
    this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === this.batch) {
      const copy = this.out.slice();
      this.n = 0;
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
  }

  // The tail is shorter than a batch; zero-padding it keeps the last chunk above
  // AssemblyAI's 50 ms minimum instead of clipping the final syllable.
  flush() {
    if (this.n > 0) {
      const copy = new Int16Array(this.batch);
      copy.set(this.out.subarray(0, this.n));
      this.n = 0;
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    this.port.postMessage({ flushed: true });
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;

    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.emit(ch[i]);
      return true;
    }

    // Linear interpolation, carried across quantum boundaries: a read head that
    // runs past the end comes back as an offset into the next buffer, and index
    // -1 reaches back to the sample we kept.
    const n = ch.length;
    let p = this.pos;
    while (p + 1 < n) {
      const i = Math.floor(p);
      const a = i < 0 ? this.prev : ch[i];
      this.emit(a + (ch[i + 1] - a) * (p - i));
      p += this.ratio;
    }
    this.pos = p - n;
    this.prev = ch[n - 1];
    return true;
  }
}

registerProcessor('notas-pcm16', PCM16Processor);
