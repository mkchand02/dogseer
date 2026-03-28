// ── SPACE push-to-talk (prepended to whatsapp.js) ─────────────────────────────
;(function() {
  let spaceHeld = false;

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = document.activeElement?.tagName;
    const isEditable = document.activeElement?.isContentEditable;
    // Allow space in WhatsApp message compose box
    if (tag === "INPUT" || tag === "TEXTAREA" || isEditable) return;

    if (!spaceHeld) {
      spaceHeld = true;
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "SPACE_DOWN" });
    }
  }, true);

  document.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || !spaceHeld) return;
    const tag = document.activeElement?.tagName;
    const isEditable = document.activeElement?.isContentEditable;
    if (tag === "INPUT" || tag === "TEXTAREA" || isEditable) return;

    spaceHeld = false;
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "SPACE_UP" });
  }, true);
})();
// ── DOGSeer WhatsApp content script ──────────────────────────────────────────
// Injected into web.whatsapp.com — reads and acts on WhatsApp Web DOM

console.log("[DOGSeer] WhatsApp content script loaded");

// ── Helper: wait for element ──────────────────────────────────────────────────
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for: ${selector}`));
    }, timeout);
  });
}

// ── Helper: type into WhatsApp compose box ────────────────────────────────────
function typeMessage(el, text) {
  el.focus();
  // WhatsApp needs this specific approach to register input
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype, "innerHTML"
  )?.set;
  nativeInputSetter?.call(el, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

// ── ACTION: Read chat list ────────────────────────────────────────────────────
function readChats(count = 5) {
  // Try multiple selector patterns — WhatsApp changes these
  const chatItems = document.querySelectorAll('[data-testid="cell-frame-container"]')
                 || document.querySelectorAll("._8nE2");

  if (!chatItems.length) {
    return { error: "No chats found — make sure WhatsApp Web is fully loaded" };
  }

  const chats = [];
  const limit = Math.min(chatItems.length, count);

  for (let i = 0; i < limit; i++) {
    const item    = chatItems[i];
    const name    = item.querySelector('[data-testid="cell-frame-title"]')?.innerText?.trim()
                 || item.querySelector("._8nE2 span")?.innerText?.trim()
                 || "Unknown";
    const preview = item.querySelector('[data-testid="last-msg-status"] + span')?.innerText?.trim()
                 || item.querySelector(".Nneid")?.innerText?.trim()
                 || "";
    const time    = item.querySelector('[data-testid="cell-frame-secondary-detail"]')?.innerText?.trim()
                 || "";

    chats.push({ name, preview, time });
  }

  return { action: "read_chats", chats };
}

// ── ACTION: Read messages in open chat ────────────────────────────────────────
function readMessages(count = 10) {
  // Get chat name
  const chatName = document.querySelector('[data-testid="conversation-header"] span')?.innerText?.trim()
                || document.querySelector("._2au8E span")?.innerText?.trim()
                || "this chat";

  // Get messages
  const msgEls = document.querySelectorAll('[data-testid="msg-container"]');
  if (!msgEls.length) {
    return { error: "No messages found — open a chat first" };
  }

  const messages = [];
  const items    = Array.from(msgEls).slice(-count); // last N messages

  for (const el of items) {
    const text      = el.querySelector('[data-testid="msg-text"]')?.innerText?.trim()
                   || el.querySelector(".selectable-text")?.innerText?.trim()
                   || "";
    const time      = el.querySelector('[data-testid="msg-meta"] span')?.innerText?.trim() || "";
    const isOutgoing = el.closest('[data-testid="msg-container"]')
                        ?.classList?.contains("message-out") ?? false;
    const sender    = isOutgoing ? "You" : chatName;

    if (text) messages.push({ sender, text, time });
  }

  return { action: "read_messages", chatName, messages };
}

// ── ACTION: Open a chat by contact name ───────────────────────────────────────
async function openChat(contact) {
  try {
    // Search for contact
    const searchBtn = document.querySelector('[data-testid="search"]')
                   || document.querySelector('[aria-label="Search input textbox"]');
    if (!searchBtn) return { error: "Search box not found" };

    searchBtn.click();
    await new Promise(r => setTimeout(r, 500));

    const searchInput = await waitForElement(
      '[data-testid="search-input"] div[contenteditable]', 3000
    );
    typeMessage(searchInput, contact);

    await new Promise(r => setTimeout(r, 1000));

    // Click first result
    const firstResult = document.querySelector('[data-testid="cell-frame-container"]');
    if (!firstResult) return { error: `No chat found for: ${contact}` };

    firstResult.click();
    await new Promise(r => setTimeout(r, 500));

    return { action: "open_chat", status: "opened", contact };

  } catch (err) {
    return { error: `Open chat failed: ${err.message}` };
  }
}

// ── ACTION: Send a message ────────────────────────────────────────────────────
async function sendMessage({ contact, message }) {
  try {
    // Open the chat first if contact specified
    if (contact) {
      const openResult = await openChat(contact);
      if (openResult.error) return openResult;
      await new Promise(r => setTimeout(r, 800));
    }

    // Find compose box
    const composeBox = document.querySelector(
      '[data-testid="conversation-compose-box-input"]'
    ) || document.querySelector('[aria-label="Type a message"]')
      || document.querySelector("div[contenteditable='true'].copyable-text");

    if (!composeBox) return { error: "Message box not found — open a chat first" };

    typeMessage(composeBox, message);
    await new Promise(r => setTimeout(r, 300));

    return {
      action: "send_message",
      status: "ready",
      message: `Message to ${contact || "this chat"} ready. Say 'send it' to confirm.`
    };

  } catch (err) {
    return { error: `Send message failed: ${err.message}` };
  }
}

// ── ACTION: Actually press send ───────────────────────────────────────────────
async function confirmSend() {
  try {
    const sendBtn = document.querySelector('[data-testid="send"]')
                 || document.querySelector('[aria-label="Send"]');

    if (sendBtn) {
      sendBtn.click();
    } else {
      // Fallback: press Enter
      const composeBox = document.querySelector(
        '[data-testid="conversation-compose-box-input"]'
      );
      composeBox?.dispatchEvent(
        new KeyboardEvent("keydown", { keyCode: 13, bubbles: true })
      );
    }

    return { action: "confirm_send", status: "sent" };
  } catch (err) {
    return { error: `Confirm send failed: ${err.message}` };
  }
}

// ── Main message listener ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "EXECUTE_ACTION") return;

  console.log("[DOGSeer WhatsApp] Action:", msg.tool, msg.data);

  const handle = async () => {
    switch (msg.tool) {
      case "whatsapp_action": {
        const { action, params = {} } = msg.data;
        switch (action) {
          case "read_chats":    return readChats(params.count || 5);
          case "read_messages": return readMessages(params.count || 10);
          case "open_chat":     return await openChat(params.contact);
          case "send_message":  return await sendMessage(params);
          case "confirm_send":  return await confirmSend();
          default:              return { error: `Unknown WhatsApp action: ${action}` };
        }
      }
      default:
        return { error: `whatsapp.js received unknown tool: ${msg.tool}` };
    }
  };

  handle().then(sendResponse);
  return true;
});
