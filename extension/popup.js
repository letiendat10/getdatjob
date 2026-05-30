async function refresh() {
  const { lines = [], lastPoll, queueEmpty } = await chrome.storage.local.get(["lines", "lastPoll", "queueEmpty"]);
  document.getElementById("status").textContent =
    lastPoll
      ? `Last poll: ${lastPoll.slice(11, 19)} UTC${queueEmpty ? " (queue empty)" : " (job found!)"}`
      : "Not polled yet — click Run now";
  document.getElementById("log").textContent = lines.slice(-40).join("\n") || "(no logs yet)";
  // Scroll to bottom
  const logEl = document.getElementById("log");
  logEl.scrollTop = logEl.scrollHeight;
}

document.getElementById("runNow").addEventListener("click", async () => {
  document.getElementById("status").textContent = "Running…";
  try {
    await chrome.runtime.sendMessage({ type: "pollNow" });
  } catch (e) {
    document.getElementById("status").textContent = "Error: " + e.message;
  }
  setTimeout(refresh, 1000);
});

refresh();
setInterval(refresh, 2000);
