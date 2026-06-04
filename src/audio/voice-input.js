

/* =========================================================================
 * Voice input
 *
 * Tap 🎤 once to start recording, again to stop. Audio is decoded to a
 * 16kHz mono Float32Array and fed to the active provider's audio path.
 *
 * Routing:
 *   - Gemma 4 provider: audio goes to the model directly (E2B/E4B both
 *     have native audio encoders, USM-style conformer, max 30s).
 *   - Anthropic provider: no audio support — falls back to bundled
 *     Whisper-tiny via @huggingface/transformers (~75 MB, English-only,
 *     runs on WebAssembly so works without WebGPU).
 *
 * The transcript fills the AI prompt in the User DSP tab; the user
 * reviews and clicks Run.
 * ======================================================================== */

const voiceBtn    = document.getElementById("tool-voice");
const voiceStatus = document.getElementById("voice-status");
let recorder        = null;
let recordingChunks = [];
let recording       = false;
let whisperPipeline = null;

function setVoiceStatus(msg, kind) {
  if (!msg) { voiceStatus.style.display = "none"; voiceStatus.textContent = ""; return; }
  voiceStatus.style.display = "block";
  voiceStatus.textContent = msg;
  voiceStatus.className = "voice-status" + (kind ? " " + kind : "");
}

voiceBtn.addEventListener("click", async () => {
  if (recording) { stopRecording(); return; }
  // Decide whether voice is feasible. Gemma needs WebGPU; the Whisper
  // fallback runs on WebAssembly so works anywhere.
  const provider = PROVIDERS[aiSettings.provider];
  const canUseGemma = provider.supportsAudio && setupGemmaAvailable();
  if (!canUseGemma && !provider.supportsImage) {
    // Pure-text provider with no WebGPU — Whisper-tiny will still load,
    // so we don't actually need to bail. Continue.
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    recordingChunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) recordingChunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recordingChunks, { type: recorder.mimeType });
      await transcribeAndApply(blob);
    };
    recorder.start();
    recording = true;
    voiceBtn.classList.add("recording");
    setVoiceStatus("Recording… click 🎤 again to stop.", "recording");
  } catch (err) {
    setVoiceStatus("Microphone access denied: " + err.message, "err");
  }
});

function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  recording = false;
  voiceBtn.classList.remove("recording");
  setVoiceStatus("Transcribing…", "thinking");
}

async function transcribeAndApply(blob) {
  let transcript;
  try {
    const provider = PROVIDERS[aiSettings.provider];
    if (provider.supportsAudio && setupGemmaAvailable()) {
      transcript = await transcribeGemma(blob);
    } else {
      transcript = await transcribeLocalWhisper(blob);
    }
  } catch (err) {
    setVoiceStatus("Transcription error: " + err.message, "err");
    return;
  }
  transcript = (transcript || "").trim();
  if (!transcript) {
    setVoiceStatus("No speech detected.", "err");
    return;
  }
  // Switch to User DSP tab and put the transcript in the prompt
  document.querySelector('.tab[data-tab="udsp"]').click();
  openAiPanel();
  aiPromptEl.value = transcript;
  setVoiceStatus(`Heard: "${transcript}" — review and click Run.`, "");
  setTimeout(() => setVoiceStatus("", ""), 4000);
}

async function transcribeGemma(blob) {
  const audio = await blobToAudioFloat32(blob, 16000);
  setVoiceStatus("Transcribing via Gemma 4…", "thinking");
  setGemmaProgressHook((p) => {
    const pct = p.progress != null ? Math.round(p.progress * 100) : 0;
    const label = p.file || p.status || "loading model…";
    setVoiceStatus(`${label} (${pct}%)`, "thinking");
  });
  try {
    const provider = PROVIDERS.gemma;
    const result = await provider.call({
      system: "You are a speech-to-text engine. Transcribe the audio exactly as spoken. Reply with ONLY the transcript — no extra words, no quotation marks.",
      user: "Transcribe the audio.",
      model: aiSettings.model,
      audio
    });
    return result;
  } finally {
    setGemmaProgressHook(null);
  }
}

/* Whisper-tiny fallback — kept as a no-WebGPU-required option (runs on
 * WebAssembly). Useful when Gemma 4 isn't available (e.g., Anthropic
 * provider selected and no GPU). ~75 MB, English-only. */
async function transcribeLocalWhisper(blob) {
  setVoiceStatus("Loading Whisper-tiny (one-time, ~75MB)…", "thinking");
  if (!whisperPipeline) {
    const tx = await getTransformersJs();
    whisperPipeline = await tx.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
      progress_callback: (p) => {
        if (p.progress) setVoiceStatus(`Loading Whisper: ${Math.round(p.progress)}%`, "thinking");
      }
    });
  }
  setVoiceStatus("Transcribing…", "thinking");
  const audioData = await blobToAudioFloat32(blob, 16000);
  const out = await whisperPipeline(audioData);
  return out.text;
}

