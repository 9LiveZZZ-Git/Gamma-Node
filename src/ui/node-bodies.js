/* =========================================================================
 * Node body renderers — streaming token output
 *
 * Phase A.2 of the LLM + knowledge-management roadmap branch
 * (docs/LLM-KNOWLEDGE-PHASE.md §3.A.2).
 *
 * A generic component that gives a node body a live, token-streamed
 * text area. Phase B Ollama LLMChat / LLMGenerate consume it; Phase D
 * Generate / Chat / StreamingGenerate consume it; Tektite MD's
 * AI-assist-over-selection consumes it.
 *
 * Design:
 *
 *   createTokenStreamBody(container, opts) returns
 *     { append(token), clear(), finalize(), el, isStreaming }
 *
 *   Each append() coalesces into a single rAF flush per frame. This
 *   matters because some providers (Ollama at low latency, in-house
 *   Generate at fast sampling) emit 100+ tokens/sec; flushing the DOM
 *   per token thrashes layout and drops frames. One rAF tick =
 *   ≤16.7 ms at 60 Hz, so the user-perceived stream rate caps at the
 *   monitor refresh rate, which is what we want — anything faster is
 *   wasted work the user can't see anyway.
 *
 *   Backpressure: append() never awaits. Callers can fire tokens as
 *   fast as the stream delivers them; the rAF coalesce + the queue
 *   inside ai/streaming.js's streamTokens() iterator handle the rest.
 *
 *   finalize() flushes any pending tokens immediately (no rAF wait)
 *   and tags the element with the .tk-stream-done class so a final
 *   styling tweak can mark "stream complete" (cursor blink off, etc.).
 *
 * The mock helper at the bottom of this file (mockTokenStream) is
 * the Phase A.2 verification path: it's a pure async-generator that
 * a console caller can wire to createTokenStreamBody to prove the
 * pipeline works end-to-end without needing a real LLM backend.
 * Once Phase B ships, the same node bodies are driven by Ollama
 * NDJSON streams via ai/streaming.js streamTokens().
 * ======================================================================== */

function createTokenStreamBody(container, opts) {
  const className = (opts && opts.className) || "tk-stream";
  let pending = "";
  let scheduled = false;
  let active = true;

  const el = document.createElement("span");
  el.className = className;
  container.appendChild(el);

  function flush() {
    scheduled = false;
    if (!pending) return;
    // textContent assignment is cheaper than innerHTML because there
    // is no HTML parser pass — and we never want streamed text
    // interpreted as markup anyway (XSS-safe by construction).
    el.textContent += pending;
    pending = "";
  }

  return {
    el,
    get isStreaming() { return active; },
    append(token) {
      if (!active) return;
      if (typeof token !== "string") return;
      pending += token;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    },
    clear() {
      pending = "";
      el.textContent = "";
    },
    finalize() {
      if (!active) return;
      active = false;
      // Flush immediately rather than waiting on the next rAF; the
      // stream is done so we want the final tokens visible now.
      flush();
      el.classList.add(className + "-done");
    }
  };
}

/* Mock token stream for Phase A.2 verification.
 *
 * Usage from the browser console:
 *   const c = document.createElement("div");
 *   document.body.appendChild(c);
 *   const body = createTokenStreamBody(c);
 *   for await (const t of mockTokenStream("Hello world streaming test"))
 *     body.append(t);
 *   body.finalize();
 *
 * Splits the input on word + whitespace boundaries (the regex captures
 * groups preserve the whitespace too), so the output reads naturally
 * rather than collapsing to one chunk-per-word. Default 30 ms/token =
 * ~33 tokens/sec, similar to a fast local Ollama model on a warm
 * cache. */
async function* mockTokenStream(text, perTokenMs) {
  perTokenMs = (typeof perTokenMs === "number" && perTokenMs >= 0) ? perTokenMs : 30;
  const tokens = String(text).split(/(\s+)/);
  for (const tok of tokens) {
    if (perTokenMs > 0) await new Promise(r => setTimeout(r, perTokenMs));
    yield tok;
  }
}
