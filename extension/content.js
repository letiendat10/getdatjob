// Backup trigger for the background service worker.
// Realtime handles the fast path (fires the instant the queue row is inserted).
// This fires after a short delay as a safety net in case the service worker
// was asleep and the Realtime subscription wasn't active yet.
setTimeout(() => {
  chrome.runtime.sendMessage({ type: "pollNow" }).catch(() => {});
}, 5_000);
