require('dotenv').config();
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const smsService = require('./services/smsService');
const excelService = require('./services/excelService');
const dbService = require('./services/dbService');
const databaseService = require('./services/databaseService');
const keepAliveService = require('./services/keepAliveService');
const { verifyToken, generateToken, verifyCredentials } = require('./middleware/auth');
const {
  loginLimiter,
  registrationValidation,
  checkValidation,
  sanitizeInput
} = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Render, Railway, Heroku) for accurate client IP detection with rate limiting
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:', 'api.qrserver.com', 'img.icons8.com'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
  })
);
app.use(cors());
app.use(bodyParser.json({ limit: '256kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '256kb' }));
app.use(express.static('public', {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));

app.disable('x-powered-by');

app.get('/api/config', (req, res) => {
  const requestApiUrl = `${req.protocol}://${req.get('host')}/api`;
  const envApiUrl = process.env.API_BASE_URL;
  const isEnvLocal = !envApiUrl || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(envApiUrl);
  res.json({
    apiUrl: isEnvLocal ? requestApiUrl : envApiUrl,
    isClosed: false,
    activeDay: databaseService.getActiveConferenceDay(),
    conferenceDays: databaseService.CONFERENCE_DAYS
  });
});

dbService.initDatabase().catch(console.error);
excelService.initStorage().catch(console.error);

if (process.env.DATABASE_URL) {
  databaseService.initializeDatabase().catch(console.error);
  console.log('🐘 Using PostgreSQL for primary storage');
} else {
  console.log('📊 Using Google Sheets for primary storage (PostgreSQL not configured)');
}

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!verifyCredentials(username, password)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }
    const token = generateToken(username);
    res.json({
      success: true,
      message: 'Login successful',
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
});

function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = String(phone).replace(/[\s\-+()]/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return '233' + cleaned.substring(1);
  }
  return cleaned;
}

function sheetsHasDuplicate(allRegs, normalizedContact, name) {
  const normName = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return allRegs.some((reg) => {
    const existingRaw =
      reg.contact || reg.Contact || reg.contact_normalized || '';
    const existingNorm = normalizePhone(existingRaw);
    const existingName = String(reg.name || reg.Name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return (existingNorm === normalizedContact || existingRaw === normalizedContact) && existingName === normName;
  });
}

function sheetsHasTicketId(allRegs, candidateId) {
  return allRegs.some(
    (reg) =>
      reg.ticket_id === candidateId ||
      reg.ticketId === candidateId ||
      reg['Ticket ID'] === candidateId
  );
}

app.post(
  '/api/register',
  registrationValidation,
  checkValidation,
  async (req, res) => {
    try {
      const raw = req.body || {};
      const name = sanitizeInput(String(raw.name || '').trim());
      const contact = sanitizeInput(String(raw.contact || '').trim());
      const memberStatus = sanitizeInput(String(raw.memberStatus || '').trim());
      const location = sanitizeInput(String(raw.location || '').trim()) || 'N/A';
      let email = sanitizeInput(String(raw.email || '').trim());
      if (!email || email.toLowerCase() === 'n/a') email = '';

      if (!name || name.length < 2) {
        return res
          .status(400)
          .json({ success: false, message: 'Name is required (min 2 characters).' });
      }
      if (!/^[A-Za-z\u00C0-\u024F\s'.-]+$/.test(name)) {
        return res
          .status(400)
          .json({ success: false, message: 'Name can only contain letters, spaces, hyphens, apostrophes.' });
      }
      if (!contact) {
        return res
          .status(400)
          .json({ success: false, message: 'Phone number is required.' });
      }
      const rawDigits = contact.replace(/\D/g, '');
      if (rawDigits.length < 7 || rawDigits.length > 17) {
        return res
          .status(400)
          .json({ success: false, message: 'Phone number must be between 7 and 17 digits.' });
      }

      // Arrange country code and number properly
      let formattedContact = contact.trim();
      if (!formattedContact.startsWith('+')) {
        if (rawDigits.length === 10 && rawDigits.startsWith('0')) {
          // Standard Ghana local: omit leading zero and prefix +233
          formattedContact = '+233' + rawDigits.substring(1);
        } else if (rawDigits.length === 9) {
          formattedContact = '+233' + rawDigits;
        } else if (rawDigits.startsWith('233')) {
          formattedContact = '+' + rawDigits;
        } else {
          formattedContact = '+' + rawDigits;
        }
      }

      // Store Ghana numbers with leading 0 in the backend (e.g. 0244123456)
      // while preserving international format (+...) for other countries
      let storedContact = formattedContact;
      const formattedDigits = formattedContact.replace(/\D/g, '');
      if (formattedDigits.startsWith('233') && formattedDigits.length === 12) {
        storedContact = '0' + formattedDigits.substring(3);
      } else if (formattedDigits.length === 10 && formattedDigits.startsWith('0')) {
        storedContact = formattedDigits;
      } else if (formattedDigits.length === 9 && !formattedDigits.startsWith('0')) {
        storedContact = '0' + formattedDigits;
      }

      const normalizedContact = normalizePhone(storedContact);
      let ticketId;
      let registration;
      let useSheetsPrimary = !process.env.DATABASE_URL;

      if (process.env.DATABASE_URL) {
        registration = {
          name,
          contact: storedContact,
          memberStatus: memberStatus || null,
          location,
          email: email || null
        };
        const saveResult = await databaseService.saveRegistrationWithDedup(registration);
        if (!saveResult.success) {
          if (saveResult.duplicate) {
            return res.status(409).json({
              success: false,
              code: 'DUPLICATE_CONTACT',
              existing: saveResult.existing || null,
              message: saveResult.message || 'This phone number is already registered! Please use "Returning Attendee" to check in.'
            });
          }
          return res.status(500).json({
            success: false,
            message: 'Registration failed. Please try again.'
          });
        }
        ticketId = saveResult.ticketId;
        registration.ticketId = ticketId;
        registration.registeredAt =
          saveResult.row && saveResult.row.registration_date
            ? new Date(saveResult.row.registration_date).toISOString()
            : new Date().toISOString();
        registration.emailSent = false;
        registration.smsSent = false;
      } else {
        const allRegs = await excelService.getAllRegistrations();
        if (sheetsHasDuplicate(allRegs, normalizedContact, name)) {
          console.log('⚠️ Duplicate registration rejected in Sheets for:', name);
          return res.status(409).json({
            success: false,
            code: 'DUPLICATE_REGISTRATION',
            message: 'You are already registered! Please check your SMS for your ticket ID.'
          });
        }
        const maxAttempts = 50;
        let attempts = 0;
        while (attempts < maxAttempts) {
          const randomNumber = Math.floor(100000 + Math.random() * 900000);
          const candidateId = `CMBC26-${randomNumber}`;
          if (!sheetsHasTicketId(allRegs, candidateId)) {
            ticketId = candidateId;
            break;
          }
          attempts++;
        }
        if (!ticketId) {
          throw new Error('Failed to generate unique ticket ID after multiple attempts');
        }
        registration = {
          ticketId,
          name,
          contact: storedContact,
          location,
          email: email || 'N/A',
          registeredAt: new Date().toISOString(),
          emailSent: false,
          smsSent: false
        };
        await excelService.saveToExcel(registration);
      }

      const ticketDownloadUrl = `${process.env.TICKET_DOWNLOAD_BASE_URL}/${ticketId}`;

      // Dispatch SMS immediately before any secondary background backup work
      (async () => {
        try {
          console.log('📱 Sending SMS to:', storedContact);
          const smsResult = await smsService.sendRegistrationSMS(
            storedContact,
            name,
            ticketId,
            ticketDownloadUrl
          );
          if (smsResult && smsResult.success) {
            console.log('✅ SMS sent successfully to:', storedContact);
            if (process.env.DATABASE_URL) {
              await databaseService
                .updateRegistrationStatus(ticketId, null, true)
                .catch((err) =>
                  console.error('Failed to update SMS status in PostgreSQL:', err)
                );
              if (process.env.USE_GOOGLE_SHEETS === 'true') {
                await excelService
                  .updateRegistrationStatus(ticketId, { smsSent: true })
                  .catch((err) =>
                    console.error(
                      'Failed to update SMS status in Sheets (non-critical):',
                      err
                    )
                  );
              }
            } else {
              await excelService
                .updateRegistrationStatus(ticketId, { smsSent: true })
                .catch((err) => console.error('Failed to update SMS status:', err));
            }
          } else {
            console.error(
              '❌ SMS sending failed:',
              smsResult?.message || 'Unknown error',
              smsResult?.response || ''
            );
          }
        } catch (smsError) {
          console.error('❌ SMS sending error:', smsError.message);
        }
      })();

      if (process.env.DATABASE_URL && process.env.USE_GOOGLE_SHEETS === 'true') {
        (async () => {
          try {
            await excelService.saveToExcel(registration);
            console.log('✅ Backup saved to Google Sheets:', ticketId);
          } catch (sheetError) {
            console.error('⚠️ Google Sheets backup failed (non-critical):', sheetError.message);
          }
        })();
      }

      res.json({
        success: true,
        message: 'Registration successful!',
        ticketId,
        ticketDownloadUrl,
        name
      });
    } catch (error) {
      console.error('Registration error:', error);
      if (
        error.code === '23505' &&
        /contact/.test(error.constraint || '')
      ) {
        return res.status(409).json({
          success: false,
          code: 'DUPLICATE_CONTACT',
          message: 'You are already registered! Please check your SMS for your ticket ID.'
        });
      }
      res.status(500).json({
        success: false,
        message: 'Registration failed. Please try again.'
      });
    }
  }
);

app.get('/api/registrations', verifyToken, async (req, res) => {
  try {
    let registrations;
    if (process.env.DATABASE_URL) {
      registrations = await databaseService.getAllRegistrations();
    } else {
      registrations = await excelService.getAllRegistrations();
    }
    res.json({ success: true, data: registrations });
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch registrations' });
  }
});

// Helper: normalize phone number to stored format (Ghana local 0XXXXXXXXX or international +...)
function toStoredContact(rawInput) {
  const contact = sanitizeInput(String(rawInput || '').trim());
  const rawDigits = contact.replace(/\D/g, '');
  let formattedContact = contact;
  if (!formattedContact.startsWith('+')) {
    if (rawDigits.length === 10 && rawDigits.startsWith('0')) {
      formattedContact = '+233' + rawDigits.substring(1);
    } else if (rawDigits.length === 9) {
      formattedContact = '+233' + rawDigits;
    } else {
      formattedContact = '+' + rawDigits;
    }
  }
  const formattedDigits = formattedContact.replace(/\D/g, '');
  if (formattedDigits.startsWith('233') && formattedDigits.length === 12) {
    return '0' + formattedDigits.substring(3);
  }
  if (formattedDigits.length === 10 && formattedDigits.startsWith('0')) {
    return formattedDigits;
  }
  if (formattedDigits.length === 9 && !formattedDigits.startsWith('0')) {
    return '0' + formattedDigits;
  }
  return formattedContact;
}

// Step 1 of Returning Attendee Check-In: Verify phone number (read-only lookup)
app.post('/api/verify-attendee', async (req, res) => {
  try {
    const rawContact = (req.body && req.body.contact) || '';
    const rawDigits = String(rawContact).replace(/\D/g, '');
    if (rawDigits.length < 7 || rawDigits.length > 17) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid phone number.'
      });
    }

    const storedContact = toStoredContact(rawContact);
    const activeDay = databaseService.getActiveConferenceDay();
    const record = await databaseService.getRegistrationByContact(storedContact);

    if (!record) {
      return res.status(404).json({
        success: false,
        notFound: true,
        message: 'No previous registration found for this phone number. Please register under "New Registration".'
      });
    }

    const dayCol = `day${activeDay}_attended`;
    return res.json({
      success: true,
      activeDay,
      attendee: {
        id: record.id,
        ticketId: record.ticket_id,
        title: record.member_status || '',
        name: record.name || '',
        contact: record.contact || storedContact,
        church: record.location || 'N/A',
        day1: Boolean(record.day1_attended),
        day2: Boolean(record.day2_attended),
        day3: Boolean(record.day3_attended),
        day4: Boolean(record.day4_attended),
        alreadyCheckedInToday: Boolean(record[dayCol])
      }
    });
  } catch (error) {
    console.error('Verify attendee error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify phone number. Please try again.'
    });
  }
});

// Step 2 of Returning Attendee Check-In: Confirm check-in for active conference day & send day welcome SMS
app.post('/api/checkin', async (req, res) => {
  try {
    const rawContact = (req.body && req.body.contact) || '';
    const rawDigits = String(rawContact).replace(/\D/g, '');
    if (rawDigits.length < 7 || rawDigits.length > 17) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid phone number.'
      });
    }

    const storedContact = toStoredContact(rawContact);
    const result = await databaseService.checkInAttendee(storedContact);
    if (!result.success) {
      if (result.notFound) {
        return res.status(404).json({
          success: false,
          notFound: true,
          message: result.message
        });
      }
      return res.status(500).json({
        success: false,
        message: 'Check-in failed. Please try again.'
      });
    }

    const row = result.row;
    const activeDay = result.activeDay;

    // Send day welcome SMS only if this is the first check-in today (prevents duplicate SMS)
    if (!result.alreadyCheckedIn) {
      (async () => {
        try {
          console.log(`📱 Sending Day ${activeDay} check-in SMS to:`, row.contact);
          const smsRes = await smsService.sendReturningCheckInSMS(
            row.contact,
            row.name,
            activeDay
          );
          if (smsRes && smsRes.success) {
            console.log(`✅ Day ${activeDay} check-in SMS sent to:`, row.contact);
            await databaseService
              .updateRegistrationStatus(row.ticket_id, null, true)
              .catch(() => {});
          } else {
            console.error(`❌ Day ${activeDay} check-in SMS failed:`, smsRes?.message || 'Unknown error');
          }
        } catch (smsErr) {
          console.error(`❌ Day ${activeDay} check-in SMS error:`, smsErr.message);
        }
      })();
    }

    return res.json({
      success: true,
      alreadyCheckedIn: result.alreadyCheckedIn,
      activeDay,
      message: result.alreadyCheckedIn
        ? `You are already checked in for Day ${activeDay}!`
        : `Welcome! Checked in for Day ${activeDay} of CMBC 2026.`,
      attendee: {
        id: row.id,
        ticketId: row.ticket_id,
        title: row.member_status || '',
        name: row.name || '',
        contact: row.contact || storedContact,
        church: row.location || 'N/A',
        day1: Boolean(row.day1_attended),
        day2: Boolean(row.day2_attended),
        day3: Boolean(row.day3_attended),
        day4: Boolean(row.day4_attended)
      }
    });
  } catch (error) {
    console.error('Check-in endpoint error:', error);
    return res.status(500).json({
      success: false,
      message: 'Check-in failed. Please try again.'
    });
  }
});

// Admin: Edit a registration record
app.put('/api/registrations/:id', verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid registration ID.' });
    }
    const body = req.body || {};
    const updates = {};
    if (body.name !== undefined) {
      const cleanedName = sanitizeInput(String(body.name).trim());
      if (cleanedName.length < 2) {
        return res.status(400).json({ success: false, message: 'Full name must be at least 2 characters.' });
      }
      updates.name = cleanedName;
    }
    if (body.memberStatus !== undefined || body.title !== undefined) {
      updates.memberStatus = sanitizeInput(String(body.memberStatus ?? body.title ?? '').trim());
    }
    if (body.contact !== undefined) {
      const rawDigits = String(body.contact).replace(/\D/g, '');
      if (rawDigits.length < 7 || rawDigits.length > 17) {
        return res.status(400).json({ success: false, message: 'Please enter a valid phone number.' });
      }
      updates.contact = toStoredContact(body.contact);
    }
    if (body.location !== undefined || body.church !== undefined) {
      updates.location = sanitizeInput(String(body.location ?? body.church ?? '').trim()) || 'N/A';
    }
    if (body.day1_attended !== undefined) updates.day1_attended = Boolean(body.day1_attended);
    if (body.day2_attended !== undefined) updates.day2_attended = Boolean(body.day2_attended);
    if (body.day3_attended !== undefined) updates.day3_attended = Boolean(body.day3_attended);
    if (body.day4_attended !== undefined) updates.day4_attended = Boolean(body.day4_attended);

    const result = await databaseService.updateRegistration(id, updates);
    if (!result.success) {
      if (result.notFound) return res.status(404).json({ success: false, message: result.message });
      if (result.duplicate) return res.status(409).json({ success: false, message: result.message });
      return res.status(400).json({ success: false, message: result.message || 'Update failed.' });
    }
    return res.json({ success: true, message: 'Registration updated successfully.', data: result.row });
  } catch (error) {
    console.error('Update registration error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update registration.' });
  }
});

// Admin: Delete a registration record
app.delete('/api/registrations/:id', verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid registration ID.' });
    }
    const result = await databaseService.deleteRegistration(id);
    if (!result.success) {
      return res.status(404).json({ success: false, message: result.message || 'Registration not found.' });
    }
    return res.json({ success: true, message: 'Registration deleted successfully.', deleted: result.deleted });
  } catch (error) {
    console.error('Delete registration error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete registration.' });
  }
});

function formatPhoneForCsv(rawPhone) {
  if (!rawPhone || !String(rawPhone).trim() || String(rawPhone).trim().toLowerCase() === 'n/a') {
    return '""';
  }
  const digits = String(rawPhone).replace(/\D/g, '');
  if (!digits) return '""';
  let localPhone = digits;
  if (digits.startsWith('233') && digits.length === 12) {
    localPhone = '0' + digits.substring(3);
  } else if (digits.length === 9 && !digits.startsWith('0')) {
    localPhone = '0' + digits;
  } else if (!localPhone.startsWith('0') && localPhone.length === 10) {
    localPhone = '0' + localPhone.substring(1);
  } else if (!localPhone.startsWith('0')) {
    localPhone = '0' + localPhone;
  }
  // Formula format ="0XXXXXXXXX" forces Excel & Sheets to display the leading zero!
  return `="${localPhone}"`;
}

app.get('/api/export-csv', verifyToken, async (req, res) => {
  try {
    let registrations;
    if (process.env.DATABASE_URL) {
      registrations = await databaseService.getAllRegistrations();
    } else {
      registrations = await excelService.getAllRegistrations();
    }

    const isUniqueOnly = String(req.query.unique || req.query.mode || '').toLowerCase() === 'true' || String(req.query.mode || '').toLowerCase() === 'unique';
    let dataToExport = registrations || [];

    if (isUniqueOnly) {
      // Sort ascending by registration date so first person that registered with each number is exported
      const ascList = [...dataToExport].sort((a, b) => {
        const dateA = new Date(a.registration_date || a.registered_at || a.registeredAt || a.created_at || 0).getTime();
        const dateB = new Date(b.registration_date || b.registered_at || b.registeredAt || b.created_at || 0).getTime();
        return dateA - dateB;
      });
      const seen = new Set();
      const uniqueAsc = [];
      ascList.forEach((reg) => {
        const raw = reg.contact || reg.Contact || reg.contact_normalized || '';
        const norm = normalizePhone(raw);
        if (!norm) {
          uniqueAsc.push(reg); // keep empty phone records
        } else if (!seen.has(norm)) {
          seen.add(norm);
          uniqueAsc.push(reg);
        }
      });
      dataToExport = uniqueAsc;
    }

    const csvEscape = (v) => {
      const s = String(v ?? '');
      if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const headers = [
      '#',
      'Ticket ID',
      'Title',
      'Full Name',
      'Phone Number',
      'Church / Organization',
      'Day 1 (Tue 24)',
      'Day 2 (Wed 25)',
      'Day 3 (Thu 26)',
      'Day 4 (Fri 27)',
      'Days Attended',
      'SMS Sent',
      'Registered At'
    ];

    const rows = dataToExport.map((reg, idx) => {
      const ticketId = reg.ticket_id || reg.ticketId || reg['Ticket ID'] || '';
      const title = reg.member_status || reg.memberStatus || '';
      const name = reg.name || reg.Name || '';
      const rawContact = reg.contact || reg.Contact || '';
      const formattedContact = formatPhoneForCsv(rawContact);
      const church = reg.location || reg.Location || 'N/A';
      const d1 = reg.day1_attended === true ? 'Yes' : 'No';
      const d2 = reg.day2_attended === true ? 'Yes' : 'No';
      const d3 = reg.day3_attended === true ? 'Yes' : 'No';
      const d4 = reg.day4_attended === true ? 'Yes' : 'No';
      const totalDays = [reg.day1_attended, reg.day2_attended, reg.day3_attended, reg.day4_attended].filter(Boolean).length;
      const sSent = (reg.sms_sent === true || reg['SMS Sent'] === 'Yes' || reg.smsSent === true) ? 'Yes' : 'No';
      const regAt = reg.registration_date || reg.registered_at || reg.registeredAt || reg['Registered At'] || '';
      const dateStr = regAt ? new Date(regAt).toLocaleString('en-US') : '';
      return [
        idx + 1,
        csvEscape(ticketId),
        csvEscape(title),
        csvEscape(name),
        formattedContact,
        csvEscape(church),
        d1,
        d2,
        d3,
        d4,
        totalDays,
        sSent,
        csvEscape(dateStr)
      ].join(',');
    });

    const csv = '\uFEFF' + [headers.map(csvEscape).join(','), ...rows].join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10);
    const filenamePrefix = isUniqueOnly ? 'cmbc2026-unique-contacts' : 'cmbc2026-registrations';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filenamePrefix}-${stamp}.csv"`
    );
    res.send(csv);
  } catch (error) {
    console.error('Error generating CSV export:', error);
    res.status(500).json({ success: false, message: 'Failed to export CSV' });
  }
});

app.get('/api/stats', verifyToken, async (req, res) => {
  try {
    let stats;
    if (process.env.DATABASE_URL) {
      stats = await databaseService.getStatistics();
    } else {
      const registrations = await excelService.getAllRegistrations();
      const uniqueContactsSet = new Set(
        registrations
          .map((r) => normalizePhone(r.contact || r.Contact || ''))
          .filter(Boolean)
      );
      const total = registrations.length;
      stats = {
        total,
        uniqueContacts: uniqueContactsSet.size,
        sharedContacts: Math.max(0, total - uniqueContactsSet.size),
        emailSent: registrations.filter(
          (r) =>
            r.email_sent === true ||
            r['Email Sent'] === 'Yes' ||
            r.emailSent === true
        ).length,
        smsSent: registrations.filter(
          (r) =>
            r.sms_sent === true ||
            r['SMS Sent'] === 'Yes' ||
            r.smsSent === true
        ).length,
        today: 0
      };
    }
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch statistics' });
  }
});

app.get('/register', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/admin-dashboard', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

app.get('/', (req, res) => {
  res.redirect('/register');
});

app.get(['/api/health', '/health'], (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(
      `📧 Email service: ${process.env.BREVO_API_KEY ? 'Configured (Brevo)' : 'Not configured'
      }`
    );
    console.log(
      `📱 SMS service: ${process.env.MNOTIFY_API_KEY
        ? `Configured (mNotify, Sender ID: ${process.env.MNOTIFY_SENDER_ID || 'not set'})`
        : 'Not configured'
      }`
    );
    // Start background keep-alive to prevent Render free-tier inactive shutdown
    keepAliveService.startKeepAlive();
  });
}

module.exports = app;
