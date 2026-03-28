// ── DOGSeer Gmail content script ─────────────────────────────────────────────
// Injected into mail.google.com — reads and acts on Gmail DOM

console.log("[DOGSeer] Gmail content script loaded");

// ── Helper: wait for an element to appear ────────────────────────────────────
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

// ── Helper: simulate real typing in contenteditable ──────────────────────────
function typeIntoElement(el, text) {
  el.focus();
  el.innerHTML = "";
  document.execCommand("insertText", false, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

// ── ACTION: Read inbox ────────────────────────────────────────────────────────
function readInbox(count = 5) {
  const rows = document.querySelectorAll("tr.zA");
  if (!rows.length) {
    return { error: "No emails found — make sure you are on the Gmail inbox" };
  }

  const emails = [];
  const limit  = Math.min(rows.length, count);

  for (let i = 0; i < limit; i++) {
    const row     = rows[i];
    const sender  = row.querySelector(".yX")?.innerText?.trim()  || "Unknown sender";
    const subject = row.querySelector(".y6")?.innerText?.trim()  || "No subject";
    const snippet = row.querySelector(".y2")?.innerText?.trim()  || "";
    const time    = row.querySelector(".xW")?.innerText?.trim()  || "";
    const unread  = row.classList.contains("zE");

    emails.push({ sender, subject, snippet, time, unread });
  }

  return { action: "read_inbox", emails };
}

// ── ACTION: Read open email body ──────────────────────────────────────────────
function readEmailBody() {
  // Try to get the open email
  const subject = document.querySelector("h2.hP")?.innerText?.trim();
  const sender  = document.querySelector(".gD")?.getAttribute("email")
               || document.querySelector(".go")?.innerText?.trim()
               || "Unknown";
  const body    = document.querySelector(".a3s.aiL")?.innerText?.trim()
               || document.querySelector(".a3s")?.innerText?.trim()
               || "";

  if (!body) {
    return { error: "No email open — please open an email first" };
  }

  // Truncate very long emails for the model
  const truncated = body.length > 2000 ? body.slice(0, 2000) + "... [truncated]" : body;

  return { action: "read_email", sender, subject, body: truncated };
}

// ── ACTION: Compose new email ─────────────────────────────────────────────────
async function composeEmail({ to, subject, body }) {
  try {
    // Click compose button
    const composeBtn = document.querySelector('[gh="cm"]')
                    || document.querySelector('[aria-label="Compose"]');
    if (!composeBtn) return { error: "Compose button not found" };
    composeBtn.click();

    // Wait for compose window
    const toField = await waitForElement('[name="to"]', 5000);
    typeIntoElement(toField, to || "");
    toField.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 9, bubbles: true })); // Tab

    // Subject
    const subjectField = await waitForElement('[name="subjectbox"]', 3000);
    typeIntoElement(subjectField, subject || "");

    // Body
    const bodyField = await waitForElement('[aria-label="Message Body"]', 3000);
    typeIntoElement(bodyField, body || "");

    return {
      action: "compose_email",
      status: "ready",
      message: `Email composed to ${to}. Say 'send it' to confirm or 'cancel' to discard.`
    };

  } catch (err) {
    return { error: `Compose failed: ${err.message}` };
  }
}

// ── ACTION: Send the currently composed email ─────────────────────────────────
async function sendComposedEmail() {
  try {
    const sendBtn = document.querySelector('[data-tooltip="Send ‪(Ctrl-Enter)‬"]')
                 || document.querySelector('[aria-label*="Send"]');
    if (!sendBtn) return { error: "Send button not found — is a compose window open?" };
    sendBtn.click();
    return { action: "send_email", status: "sent" };
  } catch (err) {
    return { error: `Send failed: ${err.message}` };
  }
}

// ── ACTION: Reply to open email ───────────────────────────────────────────────
async function replyEmail({ body }) {
  try {
    const replyBtn = document.querySelector('[data-tooltip="Reply"]')
                  || document.querySelector('[aria-label="Reply"]');
    if (!replyBtn) return { error: "Reply button not found — open an email first" };
    replyBtn.click();

    const replyBox = await waitForElement('[aria-label="Message Body"]', 4000);
    typeIntoElement(replyBox, body || "");

    return {
      action: "reply_email",
      status: "ready",
      message: "Reply composed. Say 'send it' to confirm."
    };
  } catch (err) {
    return { error: `Reply failed: ${err.message}` };
  }
}

// ── Main message listener ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "EXECUTE_ACTION") return;

  console.log("[DOGSeer Gmail] Action:", msg.tool, msg.data);

  const handle = async () => {
    switch (msg.tool) {
      case "gmail_action": {
        const { action, params = {} } = msg.data;
        switch (action) {
          case "read_inbox":    return readInbox(params.count || 5);
          case "read_email":    return readEmailBody();
          case "compose_email": return await composeEmail(params);
          case "send_email":    return await sendComposedEmail();
          case "reply_email":   return await replyEmail(params);
          default:              return { error: `Unknown Gmail action: ${action}` };
        }
      }
      default:
        return { error: `gmail.js received unknown tool: ${msg.tool}` };
    }
  };

  handle().then(sendResponse);
  return true; // keep message channel open for async
});
