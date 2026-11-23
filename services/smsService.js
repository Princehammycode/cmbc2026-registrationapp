const axios = require('axios');
const https = require('https');

const mnotifyHttpsAgent = new https.Agent({
  keepAlive: true,
  family: 4
});

async function postToMnotify(smsData) {
  return axios.post('https://api.mnotify.com/api/sms/quick', smsData, {
    httpsAgent: mnotifyHttpsAgent,
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    maxRedirects: 5,
    validateStatus: function (status) {
      return status >= 200 && status < 500;
    }
  });
}

/**
 * Send registration SMS via mNotify API
 * @param {string} phoneNumber - Recipient phone number (e.g., "0244123456" or "233244123456")
 * @param {string} name - Recipient's name
 * @param {string} ticketId - Generated ticket ID
 * @param {string} downloadUrl - URL to download ticket
 * @returns {Promise<Object>} Response object with success status
 */
async function sendMessageViaMnotify(phoneNumber, message) {
  const apiKey = (process.env.MNOTIFY_API_KEY || '').trim();
  if (!apiKey) {
    console.error('❌ MNOTIFY_API_KEY is not configured');
    return { success: false, message: 'MNOTIFY_API_KEY is not configured' };
  }

  const formattedPhone = formatPhoneNumber(phoneNumber);
  const primarySender = (process.env.MNOTIFY_SENDER_ID || '').trim();
  const fallbackSender = (process.env.MNOTIFY_FALLBACK_SENDER_ID || 'HHC-SBM2026').trim();

  const smsData = {
    key: apiKey,
    recipient: [formattedPhone],
    sender: primarySender,
    message: message,
    is_schedule: false,
    schedule_date: ''
  };

  try {
    let response = await postToMnotify(smsData);
    console.log(`SMS API response (sender="${primarySender}"):`, response.data);

    if (
      (!response.data || response.data.code !== '2000') &&
      fallbackSender &&
      primarySender !== fallbackSender
    ) {
      console.warn(
        `⚠️ Primary Sender ID "${primarySender}" rejected by mNotify (${response.data?.message || 'non-2000'}). Retrying immediately with "${fallbackSender}"...`
      );
      response = await postToMnotify({ ...smsData, sender: fallbackSender });
      console.log(`SMS API fallback response (sender="${fallbackSender}"):`, response.data);
    }

    if (response.data && response.data.code === '2000') {
      return {
        success: true,
        message: 'SMS sent successfully',
        response: response.data
      };
    } else {
      return {
        success: false,
        message: response.data?.message || 'Failed to send SMS',
        response: response.data
      };
    }
  } catch (error) {
    console.error('SMS sending error:', error.response?.data || error.message);
    return {
      success: false,
      message: error.response?.data?.message || error.message,
      error: error.response?.data || error.message
    };
  }
}

async function sendRegistrationSMS(phoneNumber, name, ticketId, downloadUrl) {
  const formattedTicketId = String(ticketId || '').startsWith('CMBC26-')
    ? String(ticketId)
    : `CMBC26-${String(ticketId || '').replace(/^CMBC26-?/, '')}`;

  const message = `Dear ${name}, Thank you for registering for CMBC 2026 (Church Growth & Missions Breakthrough Conference).\n\nYour Ticket ID is ${formattedTicketId}.\n\nGod bless you, and enjoy the conference!`;
  return sendMessageViaMnotify(phoneNumber, message);
}

async function sendReturningCheckInSMS(phoneNumber, name, dayNumber) {
  const day = parseInt(dayNumber, 10) || 2;
  let message;
  if (day === 2) {
    message = `Dear ${name}, welcome to Day 2 of CMBC 2026 (Church Growth & Missions Breakthrough Conference)!\n\nWe are delighted to have you with us again. God bless you, and enjoy today's sessions!`;
  } else if (day === 3) {
    message = `Dear ${name}, welcome back to Day 3 of CMBC 2026 (Church Growth & Missions Breakthrough Conference)!\n\nThank you for your continued participation. God bless you, and have an impactful experience today!`;
  } else if (day >= 4) {
    message = `Dear ${name}, congratulations on making it to the final day of CMBC 2026 (Church Growth & Missions Breakthrough Conference)!\n\nThank you for being part of this impactful journey with us. God bless you, and enjoy the grand finale!`;
  } else {
    message = `Dear ${name}, welcome to Day 1 of CMBC 2026 (Church Growth & Missions Breakthrough Conference)!\n\nGod bless you, and enjoy today's sessions!`;
  }
  return sendMessageViaMnotify(phoneNumber, message);
}

/**
 * Format phone number to international format
 * @param {string} phoneNumber - Phone number in various formats
 * @returns {string} Formatted phone number
 */
function formatPhoneNumber(phoneNumber) {
  if (!phoneNumber) return '';
  const raw = String(phoneNumber).trim();
  const startsWithPlus = raw.startsWith('+');
  let cleaned = raw.replace(/[\s\-+()]/g, '');

  // Standard Ghana local number with leading zero (e.g. 0244123456 -> 233244123456)
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return '233' + cleaned.substring(1);
  }

  // Explicitly provided with international '+' prefix, preserve international country code
  if (startsWithPlus) {
    return cleaned;
  }

  // If 9 digits without country code, assume Ghana local without leading zero
  if (cleaned.length === 9) {
    return '233' + cleaned;
  }

  return cleaned;
}

/**
 * Send bulk SMS to multiple recipients (optional utility function)
 * @param {Array} recipients - Array of objects with {phoneNumber, name, ticketId, downloadUrl}
 * @returns {Promise<Array>} Array of results for each SMS
 */
async function sendBulkRegistrationSMS(recipients) {
  const results = [];

  for (const recipient of recipients) {
    try {
      const result = await sendRegistrationSMS(
        recipient.phoneNumber,
        recipient.name,
        recipient.ticketId,
        recipient.downloadUrl
      );
      results.push({
        phoneNumber: recipient.phoneNumber,
        ...result
      });

      // Add small delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      results.push({
        phoneNumber: recipient.phoneNumber,
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

module.exports = {
  sendRegistrationSMS,
  sendReturningCheckInSMS,
  sendBulkRegistrationSMS,
  formatPhoneNumber
};