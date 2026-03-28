const btn         = document.getElementById('talk-btn');
const statusRing  = document.getElementById('status-ring');
const statusText  = document.getElementById('status-text');
const srAnnounce  = document.getElementById('sr-announce');

function setStatus(state, text, icon) {
  statusRing.className = state;
  statusRing.textContent = icon;
  statusText.textContent = text;
  srAnnounce.textContent = text;  // screen reader announcement
}

// Button push-to-talk
btn.addEventListener('mousedown', () => {
  chrome.runtime.sendMessage({ type: 'START_LISTENING' });
  btn.classList.add('active');
  setStatus('listening', 'Listening...', '🔴');
});

btn.addEventListener('mouseup', () => {
  chrome.runtime.sendMessage({ type: 'STOP_LISTENING' });
  btn.classList.remove('active');
  setStatus('thinking', 'Thinking...', '💭');
});

// Listen for status updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') {
    switch(msg.value) {
      case 'connected':
        setStatus('', 'Connected ✓', '🐕'); break;
      case 'listening':
        setStatus('listening', 'Listening...', '🔴'); break;
      case 'thinking':
        setStatus('thinking', 'Thinking...', '💭'); break;
      case 'speaking':
        setStatus('speaking', 'Speaking...', '🔊'); break;
      case 'ready':
        setStatus('', 'Ready', '🎙️'); break;
      case 'error':
        setStatus('', 'Error — try again', '⚠️'); break;
    }
  }
});
