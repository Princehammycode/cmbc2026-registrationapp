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
const {
  ALL_PERMISSIONS,
  hashPassword,
  verifyPassword,
  verifyToken,
  requirePermission,
  generateToken,
  verifyCredentials
} = require('./middleware/auth');
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
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');

    // 1. Check .env Super Admin credentials first
    if (verifyCredentials(username, password)) {
      const superUser = {
        id: 0,
        username,
        fullName: 'Super Admin',
        role: 'super_admin',
        isSuperAdmin: true,
        permissions: [...ALL_PERMISSIONS]
      };
      const token = generateToken(superUser);
      return res.json({
        success: true,
        message: 'Login successful',
        token,
        user: superUser
      });
    }

    // 2. Check PostgreSQL admin_users table
    if (process.env.DATABASE_URL) {
      const dbUser = await databaseService.getAdminUserByUsername(username);
      if (dbUser && verifyPassword(password, dbUser.password_hash)) {
        if (!dbUser.is_active) {
          return res.status(403).json({
            success: false,
            message: 'Your account has been disabled. Please contact the Super Admin.'
          });
        }
        await databaseService.recordAdminLastLogin(dbUser.id).catch(() => {});
        const userObj = {
          id: dbUser.id,
          username: dbUser.username,
          fullName: dbUser.full_name,
          role: dbUser.role || 'admin',
          isSuperAdmin: false,
          permissions: Array.isArray(dbUser.permissions) ? dbUser.permissions : []
        };
        const token = generateToken(userObj);
        return res.json({
          success: true,
          message: 'Login successful',
          token,
          user: userObj
        });
      }
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid username or password'
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
});

// Live session profile & permissions check
app.get('/api/admin/me', verifyToken, async (req, res) => {
  try {
    if (req.user.isSuperAdmin || req.user.role === 'super_admin') {
      return res.json({
        success: true,
        user: {
          id: 0,
          username: req.user.username,
          fullName: 'Super Admin',
          role: 'super_admin',
          isSuperAdmin: true,
          permissions: [...ALL_PERMISSIONS]
        }
      });
    }
    if (process.env.DATABASE_URL && req.user.id) {
      const dbUser = await databaseService.getAdminUserById(req.user.id);
      if (!dbUser || !dbUser.is_active) {
        return res.status(401).json({
          success: false,
          message: 'Account is disabled or no longer exists.'
        });
      }
      return res.json({
        success: true,
        user: {
          id: dbUser.id,
          username: dbUser.username,
          fullName: dbUser.full_name,
          role: dbUser.role || 'admin',
          isSuperAdmin: false,
          permissions: Array.isArray(dbUser.permissions) ? dbUser.permissions : []
        }
      });
    }
    return res.json({ success: true, user: req.user });
  } catch (error) {
    console.error('Error fetching current admin profile:', error);
    return res.status(500).json({ success: false, message: 'Failed to verify session.' });
  }
});

// User Management CRUD Endpoints (Super Admin / manage_users permission)
app.get('/api/admin/users', verifyToken, requirePermission('manage_users'), async (req, res) => {
  try {
    const users = await databaseService.getAllAdminUsers();
    res.json({ success: true, data: users });
  } catch (error) {
    console.error('Error fetching admin users:', error);
    res.status(500).json({ success: false, message: 'Failed to load admin users.' });
  }
});

app.post('/api/admin/users', verifyToken, requirePermission('manage_users'), async (req, res) => {
  try {
    const body = req.body || {};
    const username = sanitizeInput(String(body.username || '').trim());
    const fullName = sanitizeInput(String(body.fullName || '').trim());
    const password = String(body.password || '');
    const rawPerms = Array.isArray(body.permissions) ? body.permissions : ['view_registrations'];
    const permissions = rawPerms.filter((p) => ALL_PERMISSIONS.includes(p));
    const isActive = body.isActive !== undefined ? Boolean(body.isActive) : true;

    if (!username || username.length < 3 || !/^[a-zA-Z0-9._-]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username must be at least 3 characters (letters, numbers, dots, hyphens, underscores).'
      });
    }
    const envSuper = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    if (username.toLowerCase() === envSuper) {
      return res.status(409).json({
        success: false,
        message: 'This username is reserved for the Super Admin.'
      });
    }
    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'Full name is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    if (permissions.length === 0) {
      permissions.push('view_registrations');
    }

    const passwordHash = hashPassword(password);
    const result = await databaseService.createAdminUser({
      username,
      fullName,
      passwordHash,
      permissions,
      isActive,
      createdBy: req.user.username
    });
    if (!result.success) {
      return res.status(result.duplicate ? 409 : 400).json({ success: false, message: result.message });
    }
    return res.status(201).json({ success: true, message: 'Admin user created successfully.', data: result.user });
  } catch (error) {
    console.error('Create admin user error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create admin user.' });
  }
});

app.put('/api/admin/users/:id', verifyToken, requirePermission('manage_users'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID.' });
    }
    const body = req.body || {};
    const updates = {};

    if (body.username !== undefined) {
      const username = sanitizeInput(String(body.username).trim());
      if (username.length < 3 || !/^[a-zA-Z0-9._-]+$/.test(username)) {
        return res.status(400).json({ success: false, message: 'Invalid username format.' });
      }
      const envSuper = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
      if (username.toLowerCase() === envSuper) {
        return res.status(409).json({ success: false, message: 'This username is reserved for the Super Admin.' });
      }
      updates.username = username;
    }
    if (body.fullName !== undefined) {
      const fullName = sanitizeInput(String(body.fullName).trim());
      if (fullName.length < 2) {
        return res.status(400).json({ success: false, message: 'Full name is required.' });
      }
      updates.fullName = fullName;
    }
    if (body.password && String(body.password).length > 0) {
      if (String(body.password).length < 6) {
        return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
      }
      updates.passwordHash = hashPassword(body.password);
    }
    if (Array.isArray(body.permissions)) {
      updates.permissions = body.permissions.filter((p) => ALL_PERMISSIONS.includes(p));
    }
    if (body.isActive !== undefined) {
      updates.isActive = Boolean(body.isActive);
    }

    const result = await databaseService.updateAdminUser(id, updates);
    if (!result.success) {
      const status = result.notFound ? 404 : result.duplicate ? 409 : 400;
      return res.status(status).json({ success: false, message: result.message });
    }
    return res.json({ success: true, message: 'Admin user updated successfully.', data: result.user });
  } catch (error) {
    console.error('Update admin user error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update admin user.' });
  }
});

app.delete('/api/admin/users/:id', verifyToken, requirePermission('manage_users'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID.' });
    }
    if (req.user.id && req.user.id === id) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }
    const result = await databaseService.deleteAdminUser(id);
    if (!result.success) {
      return res.status(404).json({ success: false, message: result.message });
    }
    return res.json({ success: true, message: 'Admin user deleted successfully.' });
  } catch (error) {
    console.error('Delete admin user error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete admin user.' });
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

app.get('/api/registrations', verifyToken, requirePermission('view_registrations'), async (req, res) => {
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

// Admin: Add a new attendee registration from the dashboard
app.post('/api/registrations', verifyToken, requirePermission('add_registrations'), async (req, res) => {
  try {
    const body = req.body || {};
    const name = sanitizeInput(String(body.name || '').trim());
    const memberStatus = sanitizeInput(String(body.memberStatus ?? body.title ?? '').trim());
    const rawContact = String(body.contact || '').trim();
    const location = sanitizeInput(String(body.location ?? body.church ?? '').trim()) || 'N/A';
    const sendSms = body.sendSms !== false;

    if (name.length < 2) {
      return res.status(400).json({ success: false, message: 'Full name is required (min 2 characters).' });
    }
    if (!/^[A-Za-z\u00C0-\u024F\s'.-]+$/.test(name)) {
      return res.status(400).json({ success: false, message: 'Name can only contain letters, spaces, hyphens, apostrophes.' });
    }
    const hasPhone = Boolean(rawContact && rawContact.toLowerCase() !== 'n/a' && rawContact !== '-');
    let storedContact = 'N/A';
    if (hasPhone) {
      const rawDigits = rawContact.replace(/\D/g, '');
      if (rawDigits.length < 7 || rawDigits.length > 17) {
        return res.status(400).json({ success: false, message: 'Please enter a valid phone number (7 to 17 digits) or leave it blank.' });
      }
      storedContact = toStoredContact(rawContact);
    }

    const saveResult = await databaseService.saveRegistrationWithDedup({
      name,
      contact: storedContact,
      memberStatus: memberStatus || null,
      location,
      email: null
    });

    if (!saveResult.success) {
      if (saveResult.duplicate) {
        return res.status(409).json({
          success: false,
          code: 'DUPLICATE_CONTACT',
          message: 'This phone number is already registered in the system.'
        });
      }
      return res.status(500).json({ success: false, message: 'Failed to add registration.' });
    }

    let finalRow = saveResult.row;
    const ticketId = saveResult.ticketId;

    // Apply explicit Day 1-4 attendance flags if provided by the admin
    const hasDayFlags =
      body.day1_attended !== undefined ||
      body.day2_attended !== undefined ||
      body.day3_attended !== undefined ||
      body.day4_attended !== undefined;

    if (hasDayFlags && finalRow && finalRow.id) {
      const dayUpdates = {};
      if (body.day1_attended !== undefined) dayUpdates.day1_attended = Boolean(body.day1_attended);
      if (body.day2_attended !== undefined) dayUpdates.day2_attended = Boolean(body.day2_attended);
      if (body.day3_attended !== undefined) dayUpdates.day3_attended = Boolean(body.day3_attended);
      if (body.day4_attended !== undefined) dayUpdates.day4_attended = Boolean(body.day4_attended);
      const updRes = await databaseService.updateRegistration(finalRow.id, dayUpdates);
      if (updRes && updRes.success && updRes.row) {
        finalRow = updRes.row;
      }
    }

    // Dispatch confirmation SMS in background only if a phone number was provided and SMS was requested
    if (hasPhone && sendSms) {
      const ticketDownloadUrl = `${process.env.TICKET_DOWNLOAD_BASE_URL}/${ticketId}`;
      (async () => {
        try {
          const smsRes = await smsService.sendRegistrationSMS(storedContact, name, ticketId, ticketDownloadUrl);
          if (smsRes && smsRes.success) {
            await databaseService.updateRegistrationStatus(ticketId, null, true).catch(() => {});
          }
        } catch (smsErr) {
          console.error('Admin-added registration SMS error:', smsErr.message);
        }
      })();
    }

    return res.status(201).json({
      success: true,
      message: `Attendee "${name}" registered successfully (${ticketId}).`,
      ticketId,
      data: finalRow
    });
  } catch (error) {
    console.error('Admin add registration error:', error);
    return res.status(500).json({ success: false, message: 'Failed to add registration.' });
  }
});

// Admin: Edit a registration record
app.put('/api/registrations/:id', verifyToken, requirePermission('edit_registrations'), async (req, res) => {
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
      const trimmedContact = String(body.contact).trim();
      if (!trimmedContact || trimmedContact.toLowerCase() === 'n/a' || trimmedContact === '-') {
        updates.contact = 'N/A';
      } else {
        const rawDigits = trimmedContact.replace(/\D/g, '');
        if (rawDigits.length < 7 || rawDigits.length > 17) {
          return res.status(400).json({ success: false, message: 'Please enter a valid phone number or leave it blank.' });
        }
        updates.contact = toStoredContact(trimmedContact);
      }
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
app.delete('/api/registrations/:id', verifyToken, requirePermission('delete_registrations'), async (req, res) => {
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

app.get('/api/export-csv', verifyToken, requirePermission('export_data'), async (req, res) => {
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

app.get('/api/stats', verifyToken, requirePermission('view_registrations'), async (req, res) => {
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
