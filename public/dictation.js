/* Notas — live dictation into the annotation popover.

   AssemblyAI Universal-Streaming v3, the same protocol the neovim-dictation
   sidecar speaks. The API key stays on the server; this asks /api/aai-token for
   a token that lives 60 seconds and is never reused.

   The one thing to know about v3: a Turn message *revises* a turn, it does not
   continue it. Keeping a map keyed by turn_order and re-joining on every message
   is the difference between a transcript and the same words three times. */

(function () {
  'use strict';

  const WS_URL = 'wss://streaming.assemblyai.com/v3/ws';
  const MIN_CHUNK = 1600; // bytes — 50 ms of 16 kHz s16le, AAI's floor
  const MAX_CHUNK = 25600; // bytes — 800 ms, AAI's ceiling
  const CONNECT_TIMEOUT = 8000;

  // isSecureContext is what plain http://notas/ fails without Brave's
  // --unsafely-treat-insecure-origin-as-secure flag; the rest cover old browsers
  // and the iPhone.
  function available() {
    return Boolean(
      window.isSecureContext &&
        window.AudioWorkletNode &&
        window.AudioContext &&
        navigator.mediaDevices &&
        navigator.mediaDevices.getUserMedia
    );
  }

  async function start(handlers) {
    const h = handlers || {};

    const res = await fetch('/api/aai-token', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) throw new Error(data.error || 'sem token de ditado');

    const turns = new Map();
    const sendBuf = [];
    let sendBytes = 0;
    let stream = null;
    let ctx = null;
    let node = null;
    let source = null;
    let gain = null;
    let ws = null;
    let stopped = false;
    let torn = false;
    let finalResolve = null;
    let flushResolve = null;

    const combined = () =>
      [...turns.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((e) => e[1])
        .filter(Boolean)
        .join(' ')
        .trim();

    function pump() {
      if (!ws || ws.readyState !== WebSocket.OPEN || !sendBytes) return;
      const all = new Uint8Array(sendBytes);
      let off = 0;
      for (const c of sendBuf) {
        all.set(c, off);
        off += c.length;
      }
      let i = 0;
      while (all.length - i >= MIN_CHUNK) {
        const n = Math.min(MAX_CHUNK, all.length - i);
        ws.send(all.subarray(i, i + n));
        i += n;
      }
      sendBuf.length = 0;
      sendBytes = all.length - i;
      if (sendBytes) sendBuf.push(new Uint8Array(all.subarray(i)));
    }

    function padAndSend() {
      pump();
      if (!sendBytes || !ws || ws.readyState !== WebSocket.OPEN) return;
      const padded = new Uint8Array(MIN_CHUNK);
      let off = 0;
      for (const c of sendBuf) {
        padded.set(c.subarray(0, MIN_CHUNK - off), off);
        off += c.length;
      }
      ws.send(padded);
      sendBuf.length = 0;
      sendBytes = 0;
    }

    function stopCapture() {
      try {
        if (source) source.disconnect();
      } catch { /* already gone */ }
      // The OS mic indicator follows the tracks, so kill them the moment the
      // user is done — not when the socket finally closes.
      if (stream) {
        for (const t of stream.getTracks()) {
          try {
            t.stop();
          } catch { /* already gone */ }
        }
      }
    }

    function teardown() {
      if (torn) return;
      torn = true;
      stopCapture();
      try {
        if (node) {
          node.port.onmessage = null;
          node.disconnect();
        }
        if (gain) gain.disconnect();
      } catch { /* already gone */ }
      try {
        if (ctx && ctx.state !== 'closed') ctx.close();
      } catch { /* already gone */ }
      if (ws) {
        const w = ws;
        ws = null;
        w.onmessage = null;
        w.onerror = null;
        w.onclose = null;
        try {
          w.close();
        } catch { /* already closing */ }
      }
    }

    function settle(ref) {
      if (ref === 'final' && finalResolve) {
        const f = finalResolve;
        finalResolve = null;
        f();
      }
      if (ref === 'flush' && flushResolve) {
        const f = flushResolve;
        flushResolve = null;
        f();
      }
    }

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (e) {
        // The browser's own wording is English and says nothing about what to do.
        throw new Error(
          e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
            ? 'microfone negado — digite'
            : e && e.name === 'NotFoundError'
              ? 'nenhum microfone encontrado — digite'
              : 'microfone indisponível — digite'
        );
      }

      try {
        ctx = new AudioContext({ sampleRate: 16000 });
      } catch {
        ctx = new AudioContext();
      }
      if (ctx.state === 'suspended') await ctx.resume();
      // Resampling is a normal path, not a fallback — plenty of devices refuse
      // to open a 16 kHz context at all.
      console.info(
        `[notas] ditado: AudioContext ${ctx.sampleRate} Hz` +
          (ctx.sampleRate === 16000 ? '' : ' → reamostrando para 16000')
      );

      await ctx.audioWorklet.addModule('/pcm-worklet.js');
      node = new AudioWorkletNode(ctx, 'notas-pcm16', {
        processorOptions: { targetRate: 16000, batchSamples: 1600 },
      });
      node.port.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          sendBuf.push(new Uint8Array(e.data));
          sendBytes += e.data.byteLength;
          pump();
        } else if (e.data && e.data.flushed) {
          settle('flush');
        }
      };

      source = ctx.createMediaStreamSource(stream);
      // A worklet is only pulled when its output reaches the destination; the
      // gain node makes that path silent.
      gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(node);
      node.connect(gain);
      gain.connect(ctx.destination);

      // Two separate ceilings, both found the hard way:
      //  - Streaming v3 accepts at most 100 keyterms. Go over and the socket
      //    opens, then closes on `{"error_code":3006,"Max 100 items"}`.
      //  - Everything rides in the query string, and the request line dies just
      //    past 8192 bytes: 8207 chars of URL connects, 8231 is refused with a
      //    bare 1006. The token alone is ~2.4 kB and varies in length, so the
      //    list is also trimmed to fit the URL, per connection.
      // (The `assemblyai_keyterms` config comment quotes the batch API's limit
      // of 1000 — that number does not apply here.)
      const MAX_KEYTERMS = 100;
      const URL_BUDGET = 7800;
      const params = new URLSearchParams({
        sample_rate: '16000',
        format_turns: 'true',
        token: data.token,
      });
      const build = (terms) => {
        const p = new URLSearchParams(params);
        if (terms.length) p.set('keyterms_prompt', JSON.stringify(terms));
        return `${WS_URL}?${p.toString()}`;
      };
      const wanted = Array.isArray(data.keyterms) ? data.keyterms : [];
      let kept = wanted.slice(0, MAX_KEYTERMS);
      let url = build(kept);
      while (kept.length && url.length > URL_BUDGET) {
        const perTerm = Math.max(1, Math.round((url.length - build([]).length) / kept.length));
        const drop = Math.max(1, Math.ceil((url.length - URL_BUDGET) / perTerm));
        kept = kept.slice(0, Math.max(0, kept.length - drop));
        url = build(kept);
      }
      if (kept.length < wanted.length) {
        // Never drop silently: a shorter prompt is a quieter kind of wrong.
        const why = kept.length === MAX_KEYTERMS ? `limite de ${MAX_KEYTERMS} da AAI` : 'tamanho da URL';
        console.info(
          `[notas] ditado: ${kept.length} de ${wanted.length} keyterms enviados (${why})`
        );
      }
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      await new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('ditado: conexão expirou')), CONNECT_TIMEOUT);
        ws.onopen = () => {
          clearTimeout(timer);
          ok();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          fail(new Error('ditado: conexão falhou'));
        };
      });
    } catch (err) {
      teardown();
      throw err instanceof Error ? err : new Error(String(err));
    }

    ws.onerror = () => { /* onclose always follows */ };
    ws.onclose = () => {
      settle('final');
      if (!stopped && h.onError) h.onError('ditado: conexão perdida');
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.type === 'Turn') {
        turns.set(msg.turn_order || 0, msg.transcript || '');
        if (h.onText) h.onText(combined());
        // Both flags, not either. Observed against universal-3-5-pro: every Turn
        // is already `turn_is_formatted: true`, including the partials that
        // revise a sentence word by word — so either flag alone ends the wait on
        // the first fragment ("Let's see now.") instead of the finished sentence.
        if (stopped && msg.end_of_turn && msg.turn_is_formatted) settle('final');
      } else if (msg.type === 'Termination') {
        settle('final');
      }
    };

    pump(); // anything captured while the socket was still connecting

    function wait(ms, ref) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (ref === 'final') finalResolve = null;
          else flushResolve = null;
          resolve();
        }, ms);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        if (ref === 'final') finalResolve = done;
        else flushResolve = done;
      });
    }

    return {
      // Ends the session and gives AAI a bounded moment to send its final,
      // formatted revision. Returns the best transcript either way.
      async stop(waitMs) {
        if (stopped) return combined() || null;
        stopped = true;
        stopCapture();
        if (node) {
          try {
            node.port.postMessage({ cmd: 'flush' });
            await wait(200, 'flush');
          } catch { /* nothing left to flush */ }
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          padAndSend();
          try {
            ws.send(JSON.stringify({ type: 'Terminate' }));
            await wait(Math.max(0, waitMs || 0), 'final');
          } catch { /* socket died — keep what arrived */ }
        }
        teardown();
        return combined() || null;
      },
      cancel() {
        stopped = true;
        teardown();
      },
      transcript: combined,
    };
  }

  window.NotasDictation = { available, start };
})();
