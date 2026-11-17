const axios = require('axios');

let keepAliveTimer = null;
let initialTimeout = null;

/**
 * Determine the URL to ping to keep the Render service awake.
 */
function getPingUrl() {
  if (process.env.SELF_PING_URL) {
    return process.env.SELF_PING_URL.trim();
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/api/health`;
  }
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    return 'https://cmbc2026-registrationapp.onrender.com/api/health';
  }
  const port = process.env.PORT || 3001;
  return `http://localhost:${port}/api/health`;
}

/**
 * Perform a single keep-alive ping.
 */
async function pingSelf() {
  const pingUrl = getPingUrl();
  const timestamp = new Date().toISOString();
  try {
    const response = await axios.get(pingUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'CMBC-KeepAlive-Ping/1.0',
        'Cache-Control': 'no-cache'
      }
    });
    console.log(`[KeepAlive] 💓 Heartbeat ping to ${pingUrl} - Status: ${response.status} (${timestamp})`);
    return { success: true, status: response.status, url: pingUrl };
  } catch (error) {
    console.warn(`[KeepAlive] ⚠️ Ping to ${pingUrl} returned: ${error.message} (${timestamp})`);
    const port = process.env.PORT || 3001;
    const localUrl = `http://localhost:${port}/api/health`;
    if (pingUrl !== localUrl) {
      try {
        await axios.get(localUrl, { timeout: 5000 });
        console.log(`[KeepAlive] 💓 Internal fallback ping succeeded (${localUrl})`);
      } catch (_) {}
    }
    return { success: false, error: error.message, url: pingUrl };
  }
}

/**
 * Start the background keep-alive scheduler (every 10 minutes).
 */
function startKeepAlive() {
  if (process.env.DISABLE_KEEP_ALIVE === 'true') {
    console.log('[KeepAlive] Disabled via DISABLE_KEEP_ALIVE env variable.');
    return;
  }
  if (keepAliveTimer) return;

  const intervalMs = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS, 10) || 10 * 60 * 1000;
  const pingUrl = getPingUrl();

  console.log('[KeepAlive] 🚀 Keep-alive background service started.');
  console.log(`[KeepAlive] Target: ${pingUrl} | Interval: ${intervalMs / 60000} minutes`);

  initialTimeout = setTimeout(() => {
    pingSelf();
  }, 45 * 1000);
  if (initialTimeout.unref) initialTimeout.unref();

  keepAliveTimer = setInterval(() => {
    pingSelf();
  }, intervalMs);
  if (keepAliveTimer.unref) keepAliveTimer.unref();
}

function stopKeepAlive() {
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    console.log('[KeepAlive] Stopped.');
  }
}

module.exports = {
  startKeepAlive,
  stopKeepAlive,
  pingSelf,
  getPingUrl
};
