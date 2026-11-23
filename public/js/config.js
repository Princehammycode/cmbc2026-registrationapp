// API Configuration - Loaded dynamically with robust fallback
window.API_BASE_URL = window.location.origin + '/api';
window._APP_CONFIG = { apiUrl: window.location.origin + '/api' };

(async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (response.ok) {
      const config = await response.json();
      if (config && config.apiUrl) {
        window.API_BASE_URL = config.apiUrl;
        window._APP_CONFIG = {
          apiUrl: config.apiUrl,
          activeDay: config.activeDay || 1,
          conferenceDays: config.conferenceDays || []
        };
        window.dispatchEvent(new CustomEvent('cmbc:configLoaded', { detail: window._APP_CONFIG }));
        console.log('✅ API URL loaded:', config.apiUrl, '| Active Day:', window._APP_CONFIG.activeDay);
      }
    }
  } catch (error) {
    console.warn('⚠️ Using fallback API URL:', window.API_BASE_URL);
  }
})();
