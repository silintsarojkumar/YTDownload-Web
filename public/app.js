let currentUrl = "";

function showError(msg) {
  const el = document.getElementById("error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hideError() {
  document.getElementById("error").classList.add("hidden");
}

function formatDuration(seconds) {
  if (typeof seconds === "string") return seconds;
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function fetchInfo() {
  const url = document.getElementById("urlInput").value.trim();
  if (!url) {
    showError("Please enter a YouTube URL");
    return;
  }

  hideError();
  document.getElementById("videoInfo").classList.add("hidden");
  document.getElementById("downloadReady").classList.add("hidden");
  document.getElementById("progressSection").classList.add("hidden");

  const btn = document.getElementById("fetchBtn");
  btn.disabled = true;
  btn.textContent = "Loading...";

  try {
    const resp = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      showError(data.error || "Failed to fetch video info");
      return;
    }

    currentUrl = url;
    document.getElementById("thumbnail").src = data.thumbnail;
    document.getElementById("videoTitle").textContent = data.title;
    document.getElementById("videoChannel").textContent = data.channel;
    document.getElementById("videoDuration").textContent = formatDuration(data.duration);

    const select = document.getElementById("formatSelect");
    select.innerHTML = "";
    data.formats.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.height === 0 ? (f.ext || "audio") : String(f.height);
      opt.textContent = f.label;
      select.appendChild(opt);
    });

    document.getElementById("videoInfo").classList.remove("hidden");
  } catch (_e) {
    showError("Network error. Please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Fetch";
  }
}

function startDownload() {
  if (!currentUrl) return;

  hideError();
  const fmt = document.getElementById("formatSelect").value;
  const btn = document.getElementById("downloadBtn");
  btn.disabled = true;

  document.getElementById("progressSection").classList.remove("hidden");
  document.getElementById("progressFill").style.width = "100%";
  document.getElementById("progressText").textContent = "Preparing stream...";

  const params = new URLSearchParams({
    url: currentUrl,
    format: fmt,
  });

  const streamUrl = `/api/download-stream?${params.toString()}`;
  document.getElementById("downloadLink").href = streamUrl;

  const link = document.createElement("a");
  link.href = streamUrl;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  document.getElementById("downloadReady").classList.remove("hidden");
  document.getElementById("progressText").textContent = "Download started";
  btn.disabled = false;
}

document.getElementById("urlInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchInfo();
});

window.fetchInfo = fetchInfo;
window.startDownload = startDownload;