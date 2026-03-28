// ── DOGSeer Offscreen Document — mic capture + audio playback ─────────────────
let mediaRecorder = null;
let micStream = null;
const audioContext = new AudioContext({ sampleRate: 24000 });

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
      micStream = stream;
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus"
      });

      mediaRecorder.ondataavailable = async (e) => {
        if (e.data.size === 0) return;
        const buf = await e.data.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        chrome.runtime.sendMessage({ type: "AUDIO_CHUNK", data: b64 });
      };

      mediaRecorder.start(250);
      sendResponse({ status: "started" });
    }).catch((err) => {
      sendResponse({ error: err.message });
    });

    return true;
  }

  if (msg.type === "STOP_MIC") {
    mediaRecorder?.stop();
    micStream?.getTracks().forEach(t => t.stop());
    mediaRecorder = null;
    micStream = null;
    sendResponse({ status: "stopped" });
  }

  if (msg.type === "PLAY_AUDIO") {
    try {
      // msg.data is base64 PCM16 audio from Gemini at 24kHz
      const binary = atob(msg.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // Convert PCM16 to Float32
      const pcm16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768.0;
      }

      const audioBuffer = audioContext.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.start();

      sendResponse({ status: "playing" });
    } catch (e) {
      console.error("[DOGSeer] Error playing audio:", e);
      sendResponse({ error: "Failed to play audio" });
    }
  }
});
