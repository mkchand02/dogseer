// ── DOGSeer background service worker ────────────────────────────────────────
const AGENT_WS_URL = "wss://dogseer-agent-587117712878.us-central1.run.app/live";

let ws            = null;
let frameInterval = null;
let tabStream     = null;
let isListening   = false;
let isConnecting  = false;  // prevent multiple simultaneous connects

// ── WebSocket management ──────────────────────────────────────────────────────
function connectWebSocket() {
  // Hard guard — never open 2 connections
  if (isConnecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  isConnecting = true;
  ws = new WebSocket(AGENT_WS_URL);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    isConnecting = false;
    console.log("[DOGSeer] WS connected");
    broadcastStatus("connected");
  };

  ws.onmessage = async (event) => {
    if (event.data instanceof ArrayBuffer) {
      if (event.data.byteLength < 10) return; // skip empty keepalive frames
      const b64 = btoa(String.fromCharCode(...new Uint8Array(event.data)));
      chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_AUDIO", data: b64 }).catch(() => {});
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      console.log("[DOGSeer] msg from agent:", msg.type);
      switch (msg.type) {
        case "status":      broadcastStatus(msg.value); break;
        case "action":      dispatchAction(msg); break;
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
    isConnecting = false;
    console.error("[DOGSeer] WS error:", e);
    broadcastStatus("error");
  };

  ws.onclose = () => {
    isConnecting = false;
    ws = null;
    console.log("[DOGSeer] WS closed — reconnecting in 5s");
    broadcastStatus("ready");
    setTimeout(connectWebSocket, 5000); // longer delay to avoid storms
  };
}

// ── Offscreen document helper ─────────────────────────────────────────────────
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Mic capture and audio playback for push-to-talk"
    });
  }
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

    // 1. Start mic via offscreen
    await ensureOffscreen();
    chrome.runtime.sendMessage({ target: "offscreen", type: "START_MIC" });

    // 2. Start screen capture at 1fps and send frames to agent
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
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
          const ctx = canvas.getContext("2d");

          frameInterval = setInterval(async () => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            ctx.drawImage(video, 0, 0, 1280, 720);
            const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
            const reader = new FileReader();
            reader.onload = () => {
              const b64 = reader.result.split(",")[1];
              ws.send(JSON.stringify({ type: "frame", data: b64 }));
            };
            reader.readAsDataURL(blob);
          }, 1000);
        }
      } catch (captureErr) {
        console.warn("[DOGSeer] Screen capture skipped:", captureErr.message);
      }
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

  chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_MIC" }).catch(() => {});

  clearInterval(frameInterval);
  tabStream?.getTracks().forEach(t => t.stop());

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_turn" }));
  }

  broadcastStatus("thinking");
  tabStream     = null;
  frameInterval = null;
}

// ── Forward audio chunks from offscreen → WebSocket ───────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AUDIO_CHUNK") {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        const binary = atob(msg.data);
        const buf = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
        ws.send(buf.buffer);
      } catch (e) {
        console.error("[DOGSeer] Invalid base64 data received", e);
      }
    }
  }

  if (msg.type === "START_LISTENING") startListening();
  if (msg.type === "STOP_LISTENING")  stopListening();
  if (msg.type === "SPACE_DOWN")      startListening();
  if (msg.type === "SPACE_UP")        stopListening();
});

// ── Action dispatcher ─────────────────────────────────────────────────────────
async function dispatchAction(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const isGmail    = tab.url?.includes("mail.google.com");
  const isWhatsApp = tab.url?.includes("web.whatsapp.com");

  if (!isGmail && !isWhatsApp) {
    ws?.send(JSON.stringify({ type: "action_result", data: { error: "Not on Gmail or WhatsApp Web" } }));
    return;
  }
  // Notify content script of the action being performed
  broadcastAction(tab.id, msg.tool, msg.data);


  const actionPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ error: "Action timed out" }), 8000);
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
  broadcastAction(tab.id, "action_result", result); // Notify content script of result
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastStatus(value) {
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", value }).catch(() => {});
}

// Broadcast to a specific tab's content script
function broadcastAction(tabId, tool, data) {
  chrome.tabs.sendMessage(tabId, { type: "ACTION_STATUS", tool, data }).catch(() => {});
}


function waitForWS(timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState === WebSocket.OPEN) return resolve();
    const start = Date.now();
    const check = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check); resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(check); reject(new Error("WS timeout"));
      }
    }, 100);
  });
}

// ── Auto-open Gmail on install/startup ────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({ url: "https://mail.google.com" });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.create({ url: "https://mail.google.com" });
});

// ── Init ──────────────────────────────────────────────────────────────────────
connectWebSocket();
