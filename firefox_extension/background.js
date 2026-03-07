// background.js

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[background.js] Received message:', message);
    // Allow content scripts to forward feedback via the background (avoids CORS)
    if (message && message.type === 'submit_feedback') {
        (async () => {
            try {
                console.log('[background.js] Forwarding feedback to server:', message.feedback);
                const resp = await fetch('http://127.0.0.1:8000/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(message.feedback)
                });
                if (resp.ok) {
                    sendResponse({ ok: true });
                } else {
                    const text = await resp.text();
                    console.warn('[background.js] Feedback endpoint returned', resp.status, text);
                    sendResponse({ ok: false, status: resp.status, body: text });
                }
            } catch (e) {
                console.error('[background.js] Error forwarding feedback:', e);
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }
});