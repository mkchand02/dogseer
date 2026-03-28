// ── DOGSeer background service worker ────────────────────────────────────────
const AGENT_WS_URL = "wss://dogseer-agent-587117712878.us-central1.run.app/live";

let ws            = null;
let mediaRecorder = null;
let frameInterval = null;
let tabStream     = null;
let micStream     = null;
let isListening   = false;

// ── WebSocket management ──────────────────────────────────────────────────────
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(AGENT_WS_URL);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("[DOGSeer] WS connected");
    broadcastStatus("connected");
  };

  ws.onmessage = async (event) => {
    if (event.data instanceof ArrayBuffer) {
      await playAudioBuffer(event.data);
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      console.log("[DOGSeer] msg from agent:", msg.type);
      switch (msg.type) {
        case "status":
          broadcastStatus(msg.value);
          break;
        case "action":
          dispatchAction(msg);  // fire and forget — no await
          break;
        case "transcript":
          chrome.tts.speak(msg.value, { rate: 0.95, pitch: 1.0, volume: 1.0 });
          broadcastStatus("speaking");
          break;
        case "error":
          console.error("[DOGSeer] Agent error:", msg.value);
          broadcastStatus("error");
          break;
      }
    } catch (e) {
      console.error("[DOGSeer] Parse error:", e);
    }
  };

  ws.onerror = (e) => {
    console.error("[DOGSeer] WS error:", e);
    broadcastStatus("error");
  };

  ws.onclose = () => {
    console.log("[DOGSeer] WS closed — reconnecting in 3s");
    broadcastStatus("ready");
    setTimeout(connectWebSocket, 3000);
  };
}

// ── Push-to-talk: START ───────────────────────────────────────────────────────
async function startListening() {
  if (isListening) return;
  isListening = true;
  broadcastStatus("listening");

  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
      await waitForWS();
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab");

    // Mic audio
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    mediaRecorder = new MediaRecorder(micStream, {
      mimeType: "audio/webm;codecs=opus"
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws?.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then(buf => ws.send(buf));
      }
    };

    mediaRecorder.start(250);

    // Screen frames at 1fps
    try {
      tabStream = await chrome.tabCapture.capture({
        video: true, audio: false,
        videoConstraints: {
          mandatory: {
            minWidth: 1280, maxWidth: 1280,
            minHeight: 720, maxHeight: 720,
            maxFrameRate: 1
          }
        }
      });

      if (tabStream) {
        const video = document.createElement("video");
        video.srcObject = tabStream;
        await video.play();

        const canvas = new OffscreenCanvas(1280, 720);
        const ctx    = canvas.getContext("2d");

        frameInterval = setInterval(async () => {
          if (ws?.readyState !== WebSocket.OPEN) return;
          ctx.drawImage(video, 0, 0, 1280, 720);
          const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
          const reader = new FileReader();
          reader.onload = () => {
            const b64 = reader.result.split(",")[1];
            ws.send(JSON.stringify({ type: "frame", data: b64 }));
          };
          reader.readAsDataURL(blob);
        }, 1000);
      }
    } catch (captureErr) {
      console.warn("[DOGSeer] Screen capture unavailable:", captureErr);
    }

  } catch (err) {
    console.error("[DOGSeer] startListening error:", err);
    broadcastStatus("error");
    stopListening();
  }
}

// ── Push-to-talk: STOP ────────────────────────────────────────────────────────
function stopListening() {
  isListening = false;

  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  micStream?.getTracks().forEach(t => t.stop());
  clearInterval(frameInterval);
  tabStream?.getTracks().forEach(t => t.stop());

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_turn" }));
  }

  broadcastStatus("thinking");
  mediaRecorder = null;
  micStream     = null;
  tabStream     = null;
  frameInterval = null;
}

// ── Action dispatcher ─────────────────────────────────────────────────────────
async function dispatchAction(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const isGmail    = tab.url?.includes("mail.google.com");
  const isWhatsApp = tab.url?.includes("web.whatsapp.com");

  if (!isGmail && !isWhatsApp) {
    ws?.send(JSON.stringify({
      type: "action_result",
      data: { error: "Not on Gmail or WhatsApp Web" }
    }));
    return;
  }

  // Use a Promise with timeout to avoid channel-closed errors
  const actionPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ error: "Action timed out" });
    }, 8000);

    chrome.tabs.sendMessage(tab.id, {
      type: "EXECUTE_ACTION",
      tool: msg.tool,
      data: msg.data
    }, (result) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(result || { error: "No result returned" });
      }
    });
  });

  const result = await actionPromise;
  ws?.send(JSON.stringify({ type: "action_result", data: result }));
}

// ── Audio playback ────────────────────────────────────────────────────────────
async function playAudioBuffer(arrayBuffer) {
  try {
    broadcastStatus("speaking");
    console.log("[DOGSeer] Audio received, length:", arrayBuffer.byteLength);
    // TODO: pipe to AudioContext for real playback
  } catch (e) {
    console.error("[DOGSeer] Audio playback error:", e);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastStatus(value) {
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", value }).catch(() => {});
}

function waitForWS(timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState === WebSocket.OPEN) return resolve();
    const start = Date.now();
    const check = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(check);
        reject(new Error("WS timeout"));
      }
    }, 100);
  });
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  // Intentionally NOT returning true — we don't send async responses here
  if (msg.type === "START_LISTENING") startListening();
  if (msg.type === "STOP_LISTENING")  stopListening();
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener((command) => {
  console.log("[DOGSeer] Command:", command);
  if (command === "start-listening") startListening();
  if (command === "stop-listening")  stopListening();
});

// ── Init ──────────────────────────────────────────────────────────────────────
connectWebSocket();

// ── SPACE push-to-talk from content scripts ───────────────────────────────────
// Content scripts send SPACE_DOWN / SPACE_UP since service workers
// can't intercept keyboard events directly.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SPACE_DOWN") startListening();
  if (msg.type === "SPACE_UP")   stopListening();
});
