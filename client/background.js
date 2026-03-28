// ── DOGSeer background service worker ────────────────────────────────────────
// Handles: push-to-talk, screen capture, audio streaming, WebSocket to agent,
//          action dispatch to content scripts, TTS playback

const AGENT_WS_URL = "wss://dogseer-agent-587117712878.us-central1.run.app/live";

let ws            = null;   // WebSocket to Cloud Run agent
let mediaRecorder = null;   // mic recorder
let frameInterval = null;   // screen capture interval
let tabStream     = null;   // tab capture stream
let micStream     = null;   // mic stream
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
    // Binary = audio bytes from Gemini → play via TTS
    if (event.data instanceof ArrayBuffer) {
      await playAudioBuffer(event.data);
      return;
    }

    // JSON messages
    try {
      const msg = JSON.parse(event.data);
      console.log("[DOGSeer] msg from agent:", msg.type);

      switch (msg.type) {
        case "status":
          broadcastStatus(msg.value);
          break;

        case "action":
          // Dispatch DOM action to the right content script
          await dispatchAction(msg);
          break;

        case "transcript":
          // Fallback TTS if audio not available
          chrome.tts.speak(msg.value, {
            rate: 0.95,
            pitch: 1.0,
            volume: 1.0
          });
          broadcastStatus("speaking");
          break;

        case "error":
          console.error("[DOGSeer] Agent error:", msg.value);
          broadcastStatus("error");
          break;
      }
    } catch (e) {
      console.error("[DOGSeer] Failed to parse message:", e);
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
    // Ensure WS is open
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
      await waitForWS();
    }

    // Get active tab
    const [tab] = await chrome.tabs.query({
      active: true, currentWindow: true
    });

    if (!tab) throw new Error("No active tab");

    // 1. Capture mic audio
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    // Stream mic as PCM via MediaRecorder
    mediaRecorder = new MediaRecorder(micStream, {
      mimeType: "audio/webm;codecs=opus"
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws?.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then(buf => ws.send(buf));
      }
    };

    mediaRecorder.start(250); // send chunks every 250ms

    // 2. Capture screen frames at 1fps
    try {
      tabStream = await chrome.tabCapture.capture({
        video: true,
        audio: false,
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

        const canvas  = new OffscreenCanvas(1280, 720);
        const ctx     = canvas.getContext("2d");

        frameInterval = setInterval(async () => {
          if (ws?.readyState !== WebSocket.OPEN) return;
          ctx.drawImage(video, 0, 0, 1280, 720);
          const blob   = await canvas.convertToBlob({
            type: "image/jpeg", quality: 0.7
          });
          const reader = new FileReader();
          reader.onload  = () => {
            const b64 = reader.result.split(",")[1];
            ws.send(JSON.stringify({ type: "frame", data: b64 }));
          };
          reader.readAsDataURL(blob);
        }, 1000); // 1 fps
      }
    } catch (captureErr) {
      // Screen capture failed — continue with audio only
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

  // Stop mic
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  micStream?.getTracks().forEach(t => t.stop());

  // Stop screen capture
  clearInterval(frameInterval);
  tabStream?.getTracks().forEach(t => t.stop());

  // Signal end of turn to agent
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_turn" }));
  }

  broadcastStatus("thinking");
  mediaRecorder = null;
  micStream     = null;
  tabStream     = null;
  frameInterval = null;
}

// ── Action dispatcher → content scripts ──────────────────────────────────────
async function dispatchAction(msg) {
  const [tab] = await chrome.tabs.query({
    active: true, currentWindow: true
  });

  if (!tab) return;

  const isGmail     = tab.url?.includes("mail.google.com");
  const isWhatsApp  = tab.url?.includes("web.whatsapp.com");

  if (!isGmail && !isWhatsApp) {
    ws?.send(JSON.stringify({
      type: "action_result",
      data: { error: "Not on Gmail or WhatsApp Web" }
    }));
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "EXECUTE_ACTION",
      tool: msg.tool,
      data: msg.data
    });

    // Send result back to agent so Gemini can narrate it
    ws?.send(JSON.stringify({
      type: "action_result",
      data: result
    }));

  } catch (err) {
    console.error("[DOGSeer] Action dispatch error:", err);
    ws?.send(JSON.stringify({
      type: "action_result",
      data: { error: err.message }
    }));
  }
}

// ── Audio playback ────────────────────────────────────────────────────────────
async function playAudioBuffer(arrayBuffer) {
  try {
    broadcastStatus("speaking");
    // Use chrome.tts as fallback — Gemini audio needs AudioContext
    // For MVP: convert to base64 and play via offscreen document
    // Simple fallback: just update status, Gemini transcript handles TTS
    console.log("[DOGSeer] Audio received, length:", arrayBuffer.byteLength);
  } catch (e) {
    console.error("[DOGSeer] Audio playback error:", e);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastStatus(value) {
  // Send to popup if open
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
        reject(new Error("WebSocket connection timeout"));
      }
    }, 100);
  });
}

// ── Message listener (from popup + content scripts) ───────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "START_LISTENING":
      startListening();
      break;
    case "STOP_LISTENING":
      stopListening();
      break;
  }
  return true;
});

// ── Keyboard shortcut (SPACE global) ─────────────────────────────────────────
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-listen") {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }
});

// ── Init: connect WS on service worker start ──────────────────────────────────
connectWebSocket();
