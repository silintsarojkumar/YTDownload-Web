const express = require('express');
const fs = require('fs');
const path = require('path');
const ytDlpExec = require('yt-dlp-exec');

const app = express();
const PORT = process.env.PORT || 3000;
const INFO_TTL_MS = 15 * 60 * 1000;
const TARGET_HEIGHT = Number.parseInt(process.env.TARGET_HEIGHT || '1080', 10);
const YTDLP_CONCURRENT_FRAGMENTS = Number.parseInt(process.env.YTDLP_CONCURRENT_FRAGMENTS || '8', 10);
const YT_DLP_PATH = (process.env.YT_DLP_PATH || '').trim();
const YT_DLP_COOKIES = (process.env.YT_DLP_COOKIES || '').trim();
const YT_DLP_COOKIES_FROM_BROWSER = (process.env.YT_DLP_COOKIES_FROM_BROWSER || '').trim();

const infoCache = new Map();

function resolveYtDlpBinaryPath() {
  const bundled = path.join(
    __dirname,
    'node_modules',
    'yt-dlp-exec',
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  );

  if (YT_DLP_PATH) {
    return YT_DLP_PATH;
  }

  if (fs.existsSync(bundled)) {
    return bundled;
  }

  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

const ytDlpBinaryPath = resolveYtDlpBinaryPath();
const ytDlp = ytDlpExec.create(ytDlpBinaryPath);

function withAuthFlags(baseFlags) {
  const flags = { ...baseFlags };

  if (YT_DLP_COOKIES) {
    flags.cookies = YT_DLP_COOKIES;
  } else if (YT_DLP_COOKIES_FROM_BROWSER) {
    flags.cookiesFromBrowser = YT_DLP_COOKIES_FROM_BROWSER;
  }

  return flags;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isValidYouTubeUrl(input) {
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be');
  } catch {
    return false;
  }
}

function sanitizeFileName(name) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'video';
}

function formatDuration(seconds) {
  const total = Number.isFinite(seconds) ? seconds : 0;
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function getCachedInfo(url) {
  const cached = infoCache.get(url);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    infoCache.delete(url);
    return null;
  }
  return cached.data;
}

function setCachedInfo(url, data) {
  infoCache.set(url, {
    data,
    expiresAt: Date.now() + INFO_TTL_MS
  });
}

function extractFormats(formats = []) {
  const seen = new Set();
  const result = [];

  for (const f of formats) {
    const height = Number(f?.height);
    const vcodec = String(f?.vcodec || 'none');

    if (!Number.isFinite(height) || height <= 0 || vcodec === 'none') {
      continue;
    }

    const label = `${height}p`;
    if (seen.has(label)) continue;

    seen.add(label);
    result.push({ label, height, ext: 'mp4' });
  }

  result.sort((a, b) => b.height - a.height);
  result.push({ label: 'Audio Only', height: 0, ext: 'audio' });

  return result;
}

async function getVideoInfo(url) {
  const cached = getCachedInfo(url);
  if (cached) return cached;

  const info = await ytDlp(url, withAuthFlags({
    dumpSingleJson: true,
    skipDownload: true,
    noWarnings: true,
    noPlaylist: true,
    noCheckFormats: true
  }));

  const payload = {
    title: info?.title || 'Unknown',
    thumbnail: info?.thumbnail || '',
    duration: formatDuration(Number(info?.duration || 0)),
    channel: info?.channel || info?.uploader || 'Unknown',
    formats: extractFormats(info?.formats || [])
  };

  setCachedInfo(url, payload);
  return payload;
}

app.post('/api/info', async (req, res) => {
  const data = req.body || {};
  const url = String(data.url || '').trim();

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const info = await getVideoInfo(url);
    return res.json(info);
  } catch (error) {
    const message = String(error?.stderr || error?.shortMessage || error?.message || 'Failed to fetch video info');
    const botCheck = message.toLowerCase().includes('sign in to confirm');
    const missingBinary = message.includes('ENOENT') || message.includes('spawn');
    if (botCheck) {
      return res.status(403).json({
        error: 'YouTube blocked anonymous access. Set YT_DLP_COOKIES or YT_DLP_COOKIES_FROM_BROWSER.'
      });
    }

    if (missingBinary) {
      return res.status(500).json({
        error: 'yt-dlp binary not found on server. Set YT_DLP_PATH or ensure yt-dlp-exec postinstall runs.'
      });
    }

    return res.status(400).json({ error: message });
  }
});

app.get('/api/download-stream', async (req, res) => {
  const url = String(req.query.url || '').trim();
  const fmt = String(req.query.format || TARGET_HEIGHT);

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  const info = getCachedInfo(url) || await getVideoInfo(url).catch(() => ({ title: 'video' }));
  const safeTitle = sanitizeFileName(info.title);

  let flags;
  let contentType;
  let fileName;

  if (fmt === 'audio') {
    flags = withAuthFlags({
      format: 'bestaudio[ext=m4a]/bestaudio/best',
      output: '-',
      noWarnings: true,
      noPlaylist: true,
      retries: 3,
      fragmentRetries: 3,
      extractorRetries: 1,
      concurrentFragments: YTDLP_CONCURRENT_FRAGMENTS
    });
    contentType = 'audio/mp4';
    fileName = `${safeTitle}.m4a`;
  } else {
    const parsedHeight = Number.parseInt(fmt, 10);
    const selectedHeight = Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : TARGET_HEIGHT;

    flags = withAuthFlags({
      format: `best[height<=${selectedHeight}][ext=mp4][acodec!=none][vcodec!=none]/best[height<=${selectedHeight}][acodec!=none][vcodec!=none]/best`,
      output: '-',
      noWarnings: true,
      noPlaylist: true,
      retries: 3,
      fragmentRetries: 3,
      extractorRetries: 1,
      concurrentFragments: YTDLP_CONCURRENT_FRAGMENTS
    });
    contentType = 'video/mp4';
    fileName = `${safeTitle}-${selectedHeight}p.mp4`;
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

  const child = ytDlp.exec(url, flags, { reject: false });

  child.stdout.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream output.' });
    }
  });

  child.stderr.on('data', () => {
    // Keep stderr consumed to avoid process blockage.
  });

  req.on('close', () => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  });

  child.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) {
      res.end();
    }
  });

  child.stdout.pipe(res);
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    cacheSize: infoCache.size,
    storage: 'stream-only',
    ytDlpBinaryPath
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
