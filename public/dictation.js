/* Notas — live dictation into the annotation popover.

   The mic's PCM goes over a same-origin WebSocket to /api/dictate, where the
   server runs one `stt stream` per session (~/development/stt) and hands its
   JSON lines back unchanged. stt picks the provider and holds the key, the
   language hints and the key terms; this file knows none of them.

   The one thing to know about stt's events: a partial *revises* its turn, it
   does not continue it. Keeping a map keyed by turn and re-joining on every
   event is the difference between a transcript and the same words three
   times. */

(function () {
  'use strict';

  // Covers the socket, stt starting and the provider answering: stt's `ready`.
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

    const turns = new Map();
    const pending = []; // audio captured before the socket opened
    let stream = null;
    let ctx = null;
    let node = null;
    let source = null;
    let gain = null;
    let ws = null;
    let ready = null; // {ok, fail} until stt says `ready`
    let stopped = false;
    let failed = false;
    let ended = false;
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

    // stt takes any length and buffers from the moment it starts, so a buffer
    // goes out as soon as there is a socket to carry it.
    function send(buf) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (!torn && (!ws || ws.readyState === WebSocket.CONNECTING)) pending.push(buf);
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

    // Closing the socket is what cancels: the server kills stt with it.
    function teardown() {
      if (torn) return;
      torn = true;
      pending.length = 0;
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
        w.onopen = null;
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

    // Before `ready` a failure rejects start(); after it, it goes to onError —
    // unless the user already stopped, when it only ends the wait for finals.
    function onEvent(msg) {
      if (msg.type === 'ready') {
        if (ready) ready.ok();
      } else if (msg.type === 'partial' || msg.type === 'final') {
        turns.set(msg.turn || 0, msg.text || '');
        if (h.onText) h.onText(combined());
      } else if (msg.type === 'note') {
        // e.g. how many key terms the provider took
        console.info(`[notas] ditado: ${msg.message}`);
      } else if (msg.type === 'error') {
        failed = true;
        const text = `ditado: ${msg.message || 'erro do stt'}`;
        if (ready) ready.fail(text);
        else if (!stopped && h.onError) h.onError(text);
        settle('final');
      } else if (msg.type === 'end') {
        ended = true;
        settle('final');
      }
    }

    function onClose() {
      settle('final');
      if (ready) ready.fail('ditado: conexão falhou');
      else if (!stopped && !failed && h.onError) h.onError('ditado: conexão perdida');
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
          send(e.data);
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

      const w = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/dictate`
      );
      ws = w;
      w.binaryType = 'arraybuffer';
      // Anything captured while the socket was still connecting.
      w.onopen = () => {
        for (const buf of pending.splice(0)) w.send(buf);
      };
      w.onmessage = (m) => {
        if (typeof m.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(m.data);
        } catch {
          return;
        }
        if (msg && typeof msg.type === 'string') onEvent(msg);
      };
      w.onerror = () => { /* onclose always follows */ };
      w.onclose = onClose;

      await new Promise((ok, fail) => {
        const timer = setTimeout(() => {
          ready = null;
          fail(new Error('ditado: conexão expirou'));
        }, CONNECT_TIMEOUT);
        ready = {
          ok: () => {
            clearTimeout(timer);
            ready = null;
            ok();
          },
          fail: (text) => {
            clearTimeout(timer);
            ready = null;
            fail(new Error(text));
          },
        };
      });
    } catch (err) {
      teardown();
      throw err instanceof Error ? err : new Error(String(err));
    }

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
      // Ends the audio and gives stt a bounded moment to send the last turn
      // and `end`. Returns the best transcript either way.
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
        if (ws && ws.readyState === WebSocket.OPEN && !ended && !failed) {
          try {
            ws.send(JSON.stringify({ type: 'stop' }));
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
