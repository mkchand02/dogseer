// ── Injection marker ──────────────────────────────────────────────────────────
window.__dogseer_loaded = true;
console.log("[DOGSeer] Gmail content script loaded ✅");

// ── SPACE push-to-talk ────────────────────────────────────────────────────────
;(function() {
  let spaceHeld = false;

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = document.activeElement?.tagName;
    const isEditable = document.activeElement?.isContentEditable;
    if (tag === "INPUT" || tag === "TEXTAREA" || isEditable) return;

    if (!spaceHeld) {
      spaceHeld = true;
      e.preventDefault();
      e.stopPropagation();
      console.log("[DOGSeer] SPACE DOWN — sending to background");
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
    console.log("[DOGSeer] SPACE UP — sending to background");
    chrome.runtime.sendMessage({ type: "SPACE_UP" });
  }, true);
})();

// ── Helper: wait for an element to appear ─────────────────────────────────────
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
  });
}

// ── Helper: type into contenteditable ────────────────────────────────────────
function typeIntoElement(el, text) {
  el.focus();
  el.innerHTML = "";
  document.execCommand("insertText", false, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

// ── ACTION: Read inbox ────────────────────────────────────────────────────────
function readInbox(count = 5) {
  const rows = document.querySelectorAll("tr.zA");
  if (!rows.length) return { error: "No emails found" };
  const emails = [];
  const limit = Math.min(rows.length, count);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    emails.push({
      sender:  row.querySelector(".yX")?.innerText?.trim() || "Unknown",
      subject: row.querySelector(".y6")?.innerText?.trim() || "No subject",
      snippet: row.querySelector(".y2")?.innerText?.trim() || "",
      time:    row.querySelector(".xW")?.innerText?.trim() || "",
      unread:  row.classList.contains("zE")
    });
  }
  return { action: "read_inbox", emails };
}

// ── ACTION: Read open email ───────────────────────────────────────────────────
function readEmailBody() {
  const subject = document.querySelector("h2.hP")?.innerText?.trim();
  const sender  = document.querySelector(".gD")?.getAttribute("email") || "Unknown";
  const body    = document.querySelector(".a3s.aiL")?.innerText?.trim()
               || document.querySelector(".a3s")?.innerText?.trim() || "";
  if (!body) return { error: "No email open" };
  return { action: "read_email", sender, subject, body: body.slice(0, 2000) };
}

// ── ACTION: Compose ───────────────────────────────────────────────────────────
async function composeEmail({ to, subject, body }) {
  try {
    const btn = document.querySelector('[gh="cm"]') || document.querySelector('[aria-label="Compose"]');
    if (!btn) return { error: "Compose button not found" };
    btn.click();
    const toField = await waitForElement('[name="to"]', 5000);
    typeIntoElement(toField, to || "");
    toField.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 9, bubbles: true }));
    const subjectField = await waitForElement('[name="subjectbox"]', 3000);
    typeIntoElement(subjectField, subject || "");
    const bodyField = await waitForElement('[aria-label="Message Body"]', 3000);
    typeIntoElement(bodyField, body || "");
    return { action: "compose_email", status: "ready", message: `Email to ${to} composed. Say send it to confirm.` };
  } catch (err) {
    return { error: `Compose failed: ${err.message}` };
  }
}

// ── ACTION: Send ──────────────────────────────────────────────────────────────
async function sendComposedEmail() {
  try {
    const btn = document.querySelector('[data-tooltip="Send ‪(Ctrl-Enter)‬"]')
             || document.querySelector('[aria-label*="Send"]');
    if (!btn) return { error: "Send button not found" };
    btn.click();
    return { action: "send_email", status: "sent" };
  } catch (err) {
    return { error: `Send failed: ${err.message}` };
  }
}

// ── ACTION: Reply ─────────────────────────────────────────────────────────────
async function replyEmail({ body }) {
  try {
    const btn = document.querySelector('[data-tooltip="Reply"]')
             || document.querySelector('[aria-label="Reply"]');
    if (!btn) return { error: "Reply button not found" };
    btn.click();
    const box = await waitForElement('[aria-label="Message Body"]', 4000);
    typeIntoElement(box, body || "");
    return { action: "reply_email", status: "ready", message: "Reply ready. Say send it to confirm." };
  } catch (err) {
    return { error: `Reply failed: ${err.message}` };
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "EXECUTE_ACTION") return;
  console.log("[DOGSeer Gmail] Executing:", msg.tool, msg.data);

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
          default:              return { error: `Unknown action: ${action}` };
        }
      }
      default: return { error: `Unknown tool: ${msg.tool}` };
    }
  };

  handle().then(sendResponse);
  return true;
});
