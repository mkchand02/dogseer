// ── DOGSeer background service worker ────────────────────────────────────────
const AGENT_WS_URL = "wss://dogseer-agent-587117712878.us-central1.run.app/live";

let ws           = null;
let isListening  = false;
let isConnecting = false;

// ── WebSocket management ──────────────────────────────────────────────────────
function connectWebSocket() {
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
      if (event.data.byteLength < 10) return;
      const b64 = btoa(String.fromCharCode(...new Uint8Array(event.data)));
      chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_AUDIO", data: b64 }).catch(() => {});
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      console.log("[DOGSeer] msg:", msg.type);
      switch (msg.type) {
        case "status":     broadcastStatus(msg.value); break;
        case "action":     dispatchAction(msg); break;
        case "transcript":
          chrome.tts.speak(msg.value, { rate: 0.95, pitch: 1.0, volume: 1.0 });
          broadcastStatus("speaking");
          break;
        case "interrupted":
          chrome.runtime.sendMessage({ target: "offscreen", type: "CLEAR_AUDIO" }).catch(() => {});
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

  ws.onerror = () => {
    isConnecting = false;
    broadcastStatus("error");
  };

  ws.onclose = () => {
    isConnecting = false;
    ws = null;
    console.log("[DOGSeer] WS closed — reconnecting in 5s");
    broadcastStatus("ready");
    setTimeout(connectWebSocket, 5000);
  };
}

// ── Offscreen helper ──────────────────────────────────────────────────────────
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Mic capture and audio playback"
    });
  }
}

// ── Push-to-talk: START ───────────────────────────────────────────────────────
async function startListening() {
  if (isListening) return;
  isListening = true;
  broadcastStatus("listening");
  console.log("[DOGSeer] startListening — ws state:", ws?.readyState);

  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
      await waitForWS();
    }

    await ensureOffscreen().catch(e => console.error("[DOGSeer] offscreen error:", e));
    chrome.runtime.sendMessage({ target: "offscreen", type: "START_MIC" }, r => console.log("[DOGSeer] START_MIC response:", r, chrome.runtime.lastError?.message));

  } catch (err) {
    console.error("[DOGSeer] startListening error:", err);
    broadcastStatus("error");
    isListening = false;
  }
}

// ── Push-to-talk: STOP ────────────────────────────────────────────────────────
function stopListening() {
  if (!isListening) return;
  isListening = false;
  console.log("[DOGSeer] stopListening");

  chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_MIC" }).catch(() => {});

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_turn" }));
  }

  broadcastStatus("thinking");
}

// ── Audio chunks offscreen → WS ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AUDIO_CHUNK") {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        const binary = atob(msg.data);
        const buf = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
        ws.send(buf.buffer);
      } catch (e) {
        console.error("[DOGSeer] Audio send error:", e);
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

  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ error: "Action timed out" }), 8000);
    chrome.tabs.sendMessage(tab.id, {
      type: "EXECUTE_ACTION",
      tool: msg.tool,
      data: msg.data
    }, (res) => {
      clearTimeout(timeout);
      resolve(chrome.runtime.lastError
        ? { error: chrome.runtime.lastError.message }
        : res || { error: "No result" });
    });
  });

  ws?.send(JSON.stringify({ type: "action_result", data: result }));
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
      if (ws?.readyState === WebSocket.OPEN) { clearInterval(check); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(check); reject(new Error("WS timeout")); }
    }, 100);
  });
}

// ── Auto-open Gmail ───────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({ url: "https://mail.google.com" });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.create({ url: "https://mail.google.com" });
});

// ── Init ──────────────────────────────────────────────────────────────────────
connectWebSocket();
// debug patch - remove later
