// ── DOGSeer Offscreen — mic capture + queued audio playback ───────────────────
let mediaRecorder = null;
let micStream     = null;

const audioContext  = new AudioContext({ sampleRate: 24000 });
let audioQueue      = [];
let isPlaying       = false;
let nextPlayTime    = 0;

// ── Queued audio playback — no overlapping chunks ─────────────────────────────
function enqueueAudio(float32Array) {
  const buffer = audioContext.createBuffer(1, float32Array.length, 24000);
  buffer.copyToChannel(float32Array, 0);
  audioQueue.push(buffer);
  if (!isPlaying) playNext();
}

function playNext() {
  if (audioQueue.length === 0) {
    isPlaying    = false;
    nextPlayTime = 0;
    return;
  }
  isPlaying = true;

  const buffer = audioQueue.shift();
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  const startTime = Math.max(audioContext.currentTime, nextPlayTime);
  source.start(startTime);
  nextPlayTime = startTime + buffer.duration;

  source.onended = playNext;
}

function clearAudioQueue() {
  audioQueue   = [];
  isPlaying    = false;
  nextPlayTime = 0;
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return;

  if (msg.type === "START_MIC") {
    navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    }).then((stream) => {
      micStream     = stream;
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

      mediaRecorder.ondataavailable = async (e) => {
        if (e.data.size === 0) return;
        const buf = await e.data.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        chrome.runtime.sendMessage({ type: "AUDIO_CHUNK", data: b64 });
      };

      mediaRecorder.start(250);
      sendResponse({ status: "started" });
    }).catch((err) => sendResponse({ error: err.message }));

    return true;
  }

  if (msg.type === "STOP_MIC") {
    mediaRecorder?.stop();
    micStream?.getTracks().forEach(t => t.stop());
    mediaRecorder = null;
    micStream     = null;
    sendResponse({ status: "stopped" });
  }

  if (msg.type === "PLAY_AUDIO") {
    try {
      const binary = atob(msg.data);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // PCM16 → Float32
      const pcm16   = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;

      enqueueAudio(float32);
      sendResponse({ status: "queued" });
    } catch (e) {
      console.error("[DOGSeer offscreen] Audio error:", e);
      sendResponse({ error: e.message });
    }
  }

  if (msg.type === "CLEAR_AUDIO") {
    clearAudioQueue();
    sendResponse({ status: "cleared" });
  }
});
