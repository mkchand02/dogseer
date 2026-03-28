// ── DOGSeer Offscreen Document — mic capture ──────────────────────────────────
let mediaRecorder = null;
let micStream = null;

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
        // Send audio chunk back to background as base64
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        chrome.runtime.sendMessage({ type: "AUDIO_CHUNK", data: b64 });
      };

      mediaRecorder.start(250);
      sendResponse({ status: "started" });
    }).catch((err) => {
      sendResponse({ error: err.message });
    });

    return true; // async response
  }

  if (msg.type === "STOP_MIC") {
    mediaRecorder?.stop();
    micStream?.getTracks().forEach(t => t.stop());
    mediaRecorder = null;
    micStream = null;
    sendResponse({ status: "stopped" });
  }
});
