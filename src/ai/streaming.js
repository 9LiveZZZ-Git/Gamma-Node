/* =========================================================================
 * Streaming response readers — SSE + NDJSON
 *
 * Phase A.2 of the LLM + knowledge-management roadmap branch
 * (docs/LLM-KNOWLEDGE-PHASE.md §3.A.2).
 *
 * Generalizes the per-provider streaming readers that have been
 * accumulating in src/ai/settings.js (Anthropic SSE, Gemma chunked,
 * Whisper progress). Phase B (Ollama) needs NDJSON streaming; Phase D
 * (LLM-from-scratch) needs a uniform iterator for in-house Generate
 * nodes. Both end up here.
 *
 * Two formats supported:
 *
 *   SSE (Server-Sent Events) — Anthropic, OpenAI, Cohere, most cloud LLMs.
 *     Events separated by blank lines (\n\n). Each event has one or
 *     more lines prefixed with "data: ". A line with the literal
 *     "data: [DONE]" terminates the stream. Other line prefixes
 *     ("event:", "id:", "retry:") are ignored — we don't need them.
 *
 *   NDJSON (Newline-Delimited JSON) — Ollama, llama.cpp server, many
 *     local-native providers. Each line is one self-contained JSON
 *     object. No terminator sentinel — stream ends when the response
 *     body ends. Malformed lines are skipped.
 *
 * Each format ships in two flavors:
 *
 *   streamSSEEvents(response, onEvent)
 *   streamNDJSONEvents(response, onEvent)
 *     Callback form. Drop-in replacement for the legacy `readSSE` in
 *     settings.js. Returns a Promise that resolves when the stream
 *     ends. onEvent is called synchronously per parsed event.
 *
 *   streamTokens(response, { format, field })
 *     Async generator form. `for await (const tok of streamTokens(...))`.
 *     `field` is a dotted path into each parsed event whose value is
 *     yielded as a token string. Events where the path is absent are
 *     silently skipped (lets the same iterator handle metadata-only
 *     events like Anthropic's "message_start" interleaved with
 *     "content_block_delta").
 *
 * Both forms use a TextDecoder with `{ stream: true }` so multi-byte
 * UTF-8 sequences split across chunk boundaries decode correctly.
 *
 * No error swallowing for network errors — those propagate through
 * the underlying response.body reader. Only JSON-parse errors on
 * individual events are caught (and the bad event skipped), so one
 * malformed event doesn't kill the rest of the stream.
 * ======================================================================== */

async function streamSSEEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const lines = block.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try { onEvent(JSON.parse(data)); }
        catch (_) { /* skip malformed event */ }
      }
    }
  }
}

async function streamNDJSONEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      // Flush any trailing line without a newline (some servers omit
      // the final \n). Skip if empty / whitespace-only.
      const tail = buffer.trim();
      if (tail) {
        try { onEvent(JSON.parse(tail)); } catch (_) {}
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); }
      catch (_) { /* skip malformed line */ }
    }
  }
}

/* Resolve a dotted-path on an object. "delta.text" on
 * { delta: { text: "hi" } } -> "hi". Missing intermediates yield
 * undefined. */
function _streamFieldAt(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/* Async generator: yields tokens (string fragments) from a streaming
 * response. `opts.format` is "sse" or "ndjson"; `opts.field` is a
 * dotted path into each parsed event whose value (if a string) is
 * yielded. Events lacking the field are silently passed over. */
async function* streamTokens(response, opts) {
  const format = (opts && opts.format) || "sse";
  const field = (opts && opts.field) || "delta.text";

  // The Events callback funnels into a queue that the generator drains.
  // This is the simplest bridge between the imperative reader and the
  // async-iteration consumer. Backpressure is implicit: the reader
  // awaits the queue's drain via `nextResolved`.
  const queue = [];
  let done = false;
  let waiter = null;

  const wakeup = () => {
    if (waiter) { const w = waiter; waiter = null; w(); }
  };
  const onEvent = (ev) => {
    const v = _streamFieldAt(ev, field);
    if (typeof v === "string") {
      queue.push(v);
      wakeup();
    }
  };

  const fn = format === "ndjson" ? streamNDJSONEvents : streamSSEEvents;
  const reading = fn(response, onEvent).then(() => { done = true; wakeup(); });

  while (true) {
    if (queue.length) {
      yield queue.shift();
    } else if (done) {
      await reading;  // surface any reader errors
      return;
    } else {
      await new Promise(r => { waiter = r; });
    }
  }
}
