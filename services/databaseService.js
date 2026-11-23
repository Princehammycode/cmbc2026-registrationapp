const { Pool } = require('pg');

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: !isLocalDb ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
  console.log('✅ PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err);
});

const CONFERENCE_DAYS = [
  { day: 1, date: '2026-11-24', label: 'Tue Nov 24th - Day 1', shortLabel: 'Day 1 (Tue 24)' },
  { day: 2, date: '2026-11-25', label: 'Wed Nov 25th - Day 2', shortLabel: 'Day 2 (Wed 25)' },
  { day: 3, date: '2026-11-26', label: 'Thu Nov 26th - Day 3', shortLabel: 'Day 3 (Thu 26)' },
  { day: 4, date: '2026-11-27', label: 'Fri Nov 27th - Day 4', shortLabel: 'Day 4 (Fri 27)' }
];

function getActiveConferenceDay(overrideDay) {
  const parsedOverride = parseInt(overrideDay || process.env.ACTIVE_CONFERENCE_DAY, 10);
  if (parsedOverride >= 1 && parsedOverride <= 4) {
    return parsedOverride;
  }
  const todayStr = new Date().toISOString().slice(0, 10); // Ghana GMT (UTC+0)
  if (todayStr <= '2026-11-24') return 1;
  if (todayStr === '2026-11-25') return 2;
  if (todayStr === '2026-11-26') return 3;
  return 4;
}

const NORMALIZE_CONTACT_SQL = `
  CREATE OR REPLACE FUNCTION normalize_contact(phone TEXT) RETURNS TEXT AS $$
  BEGIN
    phone := regexp_replace(phone, '[\\s\\-\\+\\(\\)]', '', 'g');
    IF phone LIKE '0%' AND length(phone) = 10 THEN
      phone := '233' || substring(phone FROM 2);
    END IF;
    IF length(phone) = 9 AND phone NOT LIKE '233%' THEN
      phone := '233' || phone;
    END IF;
    RETURN phone;
  END;
  $$ LANGUAGE plpgsql IMMUTABLE;
`;

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(NORMALIZE_CONTACT_SQL);

    await client.query(`
      CREATE TABLE IF NOT EXISTS registrations (
        id SERIAL PRIMARY KEY,
        ticket_id VARCHAR(20) NOT NULL,
        name VARCHAR(255) NOT NULL,
        contact VARCHAR(20) NOT NULL,
        contact_normalized VARCHAR(20) NOT NULL,
        email VARCHAR(255),
        location VARCHAR(255),
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        email_sent BOOLEAN DEFAULT FALSE,
        sms_sent BOOLEAN DEFAULT FALSE,
        day1_attended BOOLEAN DEFAULT FALSE,
        day2_attended BOOLEAN DEFAULT FALSE,
        day3_attended BOOLEAN DEFAULT FALSE,
        day4_attended BOOLEAN DEFAULT FALSE,
        day1_checkin_at TIMESTAMP,
        day2_checkin_at TIMESTAMP,
        day3_checkin_at TIMESTAMP,
        day4_checkin_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_registrations_ticket_id
        ON registrations(ticket_id)
    `);
    // Enforce unique phone number per registrant
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_registrations_contact_norm
          ON registrations(contact_normalized)
      `);
    } catch (uqErr) {
      console.warn('⚠️ Could not create unique phone index (existing duplicates?):', uqErr.message);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_registrations_contact_norm
          ON registrations(contact_normalized)
      `);
    }
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_registration_date
        ON registrations(registration_date)
    `);

    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='registrations' AND column_name='contact_normalized'
    `);
    if (colCheck.rows.length === 0) {
      await client.query(`ALTER TABLE registrations ADD COLUMN contact_normalized VARCHAR(20)`);
      await client.query(`UPDATE registrations SET contact_normalized = normalize_contact(contact)`);
      await client.query(`ALTER TABLE registrations ALTER COLUMN contact_normalized SET NOT NULL`);
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_registrations_contact_norm ON registrations(contact_normalized)
        `);
      } catch (_) { }
    }

    const memberCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='registrations' AND column_name='member_status'
    `);
    if (memberCheck.rows.length === 0) {
      try {
        await client.query(`ALTER TABLE registrations ADD COLUMN member_status VARCHAR(100)`);
      } catch (_) { }
    }

    // Ensure multi-day attendance columns exist on existing databases
    const dayCols = [
      'day1_attended BOOLEAN DEFAULT FALSE',
      'day2_attended BOOLEAN DEFAULT FALSE',
      'day3_attended BOOLEAN DEFAULT FALSE',
      'day4_attended BOOLEAN DEFAULT FALSE',
      'day1_checkin_at TIMESTAMP',
      'day2_checkin_at TIMESTAMP',
      'day3_checkin_at TIMESTAMP',
      'day4_checkin_at TIMESTAMP'
    ];
    for (const colDef of dayCols) {
      try {
        await client.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS ${colDef}`);
      } catch (_) { }
    }

    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_reg_name_phone
          ON registrations(LOWER(TRIM(name)), contact_normalized)
      `);
    } catch (_) { }

    console.log('✅ Database table (registrations) initialized with unique phone & multi-day attendance');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  } finally {
    client.release();
  }
}

function normalizeContact(phone) {
  if (!phone) return '';
  let cleaned = String(phone).replace(/[\s\-+\(\)]/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '233' + cleaned.substring(1);
  }
  if (cleaned.length === 9 && !cleaned.startsWith('233')) {
    cleaned = '233' + cleaned;
  }
  return cleaned;
}

function generateTicketId() {
  const randomNumber = Math.floor(100000 + Math.random() * 900000);
  return `CMBC26-${randomNumber}`;
}

async function saveRegistration(registration) {
  return saveRegistrationWithDedup(registration);
}

async function saveRegistrationWithDedup(registration, dayOverride) {
  const normalizedContact = normalizeContact(registration.contact);
  const activeDay = getActiveConferenceDay(dayOverride);
  const dayCol = `day${activeDay}_attended`;
  const dayTimeCol = `day${activeDay}_checkin_at`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockKey = parseInt(
      normalizedContact.substring(normalizedContact.length - 9) || '0',
      10
    );
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    // Strict phone uniqueness: no two registrations may share a phone number
    const dupCheck = await client.query(
      `SELECT id, ticket_id, name, contact, member_status, location,
              day1_attended, day2_attended, day3_attended, day4_attended
       FROM registrations
       WHERE contact_normalized = $1 OR contact = $2
       LIMIT 1`,
      [normalizedContact, registration.contact]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      const existing = dupCheck.rows[0];
      console.log('⚠️ Duplicate phone rejected:', normalizedContact, 'existing:', existing.name);
      return {
        success: false,
        duplicate: true,
        code: 'DUPLICATE_CONTACT',
        ticketId: existing.ticket_id,
        existing,
        message: 'This phone number is already registered! Please use "Returning Attendee" to check in.'
      };
    }

    let ticketId = null;
    let inserted = null;
    const maxAttempts = 50;
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = generateTicketId();
      try {
        const res = await client.query(
          `
          INSERT INTO registrations
            (ticket_id, name, contact, contact_normalized, email, location, member_status, email_sent, sms_sent, ${dayCol}, ${dayTimeCol})
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, CURRENT_TIMESTAMP)
          RETURNING *
          `,
          [
            candidate,
            registration.name,
            registration.contact,
            normalizedContact,
            registration.email || null,
            registration.location || null,
            registration.memberStatus || null,
            false,
            false
          ]
        );
        ticketId = candidate;
        inserted = res.rows[0];
        break;
      } catch (insErr) {
        if (String(insErr.code) === '23505' && /ticket_id/.test(insErr.constraint || '')) {
          console.log(`⚠️ Ticket ID collision: ${candidate}, retrying (${i + 1}/${maxAttempts})`);
          continue;
        }
        throw insErr;
      }
    }

    if (!inserted) {
      await client.query('ROLLBACK');
      throw new Error('Failed to generate unique ticket ID after multiple attempts');
    }

    registration.ticketId = ticketId;
    await client.query('COMMIT');
    console.log(`✅ Registration saved to PostgreSQL (Day ${activeDay}):`, ticketId, 'for', registration.name);
    return { success: true, row: inserted, ticketId, activeDay };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    console.error('❌ Database save error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function checkInAttendee(contact, dayOverride) {
  const normalizedContact = normalizeContact(contact);
  const activeDay = getActiveConferenceDay(dayOverride);
  const dayCol = `day${activeDay}_attended`;
  const dayTimeCol = `day${activeDay}_checkin_at`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query(
      `SELECT * FROM registrations WHERE contact_normalized = $1 OR contact = $2 LIMIT 1 FOR UPDATE`,
      [normalizedContact, contact]
    );
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        success: false,
        notFound: true,
        message: 'No registration found for this phone number. Please register under "New Registration".'
      };
    }

    const row = existingRes.rows[0];
    if (row[dayCol] === true) {
      await client.query('COMMIT');
      return {
        success: true,
        alreadyCheckedIn: true,
        activeDay,
        row
      };
    }

    const updatedRes = await client.query(
      `UPDATE registrations
       SET ${dayCol} = TRUE,
           ${dayTimeCol} = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [row.id]
    );
    await client.query('COMMIT');
    console.log(`✅ Check-in recorded for Day ${activeDay}:`, updatedRes.rows[0].ticket_id, updatedRes.rows[0].name);
    return {
      success: true,
      alreadyCheckedIn: false,
      activeDay,
      row: updatedRes.rows[0]
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    console.error('❌ Check-in error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function updateRegistration(id, updates) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query('SELECT * FROM registrations WHERE id = $1 FOR UPDATE', [id]);
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, notFound: true, message: 'Registration not found.' };
    }
    const current = existingRes.rows[0];

    const newName = updates.name !== undefined ? String(updates.name).trim() : current.name;
    const newTitle = updates.memberStatus !== undefined ? String(updates.memberStatus).trim() : current.member_status;
    const newLocation = updates.location !== undefined ? (String(updates.location).trim() || 'N/A') : current.location;
    const newContact = updates.contact !== undefined ? String(updates.contact).trim() : current.contact;
    const newNormalized = normalizeContact(newContact);

    if (newNormalized !== current.contact_normalized) {
      const conflict = await client.query(
        'SELECT id FROM registrations WHERE contact_normalized = $1 AND id <> $2 LIMIT 1',
        [newNormalized, id]
      );
      if (conflict.rows.length > 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          duplicate: true,
          message: 'Another attendee is already registered with this phone number.'
        };
      }
    }

    const d1 = updates.day1_attended !== undefined ? Boolean(updates.day1_attended) : Boolean(current.day1_attended);
    const d2 = updates.day2_attended !== undefined ? Boolean(updates.day2_attended) : Boolean(current.day2_attended);
    const d3 = updates.day3_attended !== undefined ? Boolean(updates.day3_attended) : Boolean(current.day3_attended);
    const d4 = updates.day4_attended !== undefined ? Boolean(updates.day4_attended) : Boolean(current.day4_attended);

    const updatedRes = await client.query(
      `UPDATE registrations
       SET name = $1,
           member_status = $2,
           contact = $3,
           contact_normalized = $4,
           location = $5,
           day1_attended = $6,
           day2_attended = $7,
           day3_attended = $8,
           day4_attended = $9,
           day1_checkin_at = CASE WHEN $6 AND day1_checkin_at IS NULL THEN CURRENT_TIMESTAMP WHEN NOT $6 THEN NULL ELSE day1_checkin_at END,
           day2_checkin_at = CASE WHEN $7 AND day2_checkin_at IS NULL THEN CURRENT_TIMESTAMP WHEN NOT $7 THEN NULL ELSE day2_checkin_at END,
           day3_checkin_at = CASE WHEN $8 AND day3_checkin_at IS NULL THEN CURRENT_TIMESTAMP WHEN NOT $8 THEN NULL ELSE day3_checkin_at END,
           day4_checkin_at = CASE WHEN $9 AND day4_checkin_at IS NULL THEN CURRENT_TIMESTAMP WHEN NOT $9 THEN NULL ELSE day4_checkin_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $10
       RETURNING *`,
      [newName, newTitle || null, newContact, newNormalized, newLocation, d1, d2, d3, d4, id]
    );
    await client.query('COMMIT');
    return { success: true, row: updatedRes.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    console.error('❌ Update registration error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteRegistration(id) {
  const client = await pool.connect();
  try {
    const res = await client.query('DELETE FROM registrations WHERE id = $1 RETURNING id, ticket_id, name', [id]);
    if (res.rows.length === 0) {
      return { success: false, notFound: true, message: 'Registration not found.' };
    }
    return { success: true, deleted: res.rows[0] };
  } catch (error) {
    console.error('❌ Delete registration error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function isContactRegisteredAny(contact) {
  const normalized = normalizeContact(contact);
  const variants = [normalized];
  if (normalized.startsWith('233') && normalized.length === 12) {
    variants.push('0' + normalized.substring(3));
  }
  if (contact && contact.startsWith('0')) {
    variants.push(normalizeContact(contact));
  }
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT 1 FROM registrations WHERE contact_normalized = ANY($1::text[]) LIMIT 1`,
      [variants.filter((v, i, a) => a.indexOf(v) === i)]
    );
    return res.rows.length > 0;
  } finally {
    client.release();
  }
}

async function updateRegistrationStatus(ticketId, emailSent, smsSent) {
  const client = await pool.connect();
  try {
    const query = `
      UPDATE registrations 
      SET email_sent = COALESCE($1, email_sent),
          sms_sent = COALESCE($2, sms_sent),
          updated_at = CURRENT_TIMESTAMP
      WHERE ticket_id = $3
      RETURNING *
    `;
    const values = [emailSent, smsSent, ticketId];
    const result = await client.query(query, values);
    if (result.rows.length > 0) {
      console.log('✅ Status updated in PostgreSQL:', ticketId);
      return result.rows[0];
    }
    throw new Error('Registration not found');
  } catch (error) {
    console.error('❌ Database update error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function getAllRegistrations() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT * FROM registrations ORDER BY registration_date DESC
    `);
    return result.rows;
  } catch (error) {
    console.error('❌ Database fetch error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function getRegistrationByTicketId(ticketId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM registrations WHERE ticket_id = $1',
      [ticketId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ Database fetch error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function ticketIdExists(ticketId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT EXISTS(SELECT 1 FROM registrations WHERE ticket_id = $1)',
      [ticketId]
    );
    return result.rows[0].exists;
  } catch (error) {
    console.error('❌ Database exists check error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function getRegistrationByContact(contact) {
  const normalized = normalizeContact(contact);
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM registrations WHERE contact_normalized = $1',
      [normalized]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ Database fetch error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function getStatistics(dayOverride) {
  const activeDay = getActiveConferenceDay(dayOverride);
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(DISTINCT LOWER(TRIM(location))) FILTER (
          WHERE location IS NOT NULL AND TRIM(location) <> '' AND LOWER(TRIM(location)) <> 'n/a'
        )::int AS distinct_churches,
        COUNT(*) FILTER (WHERE sms_sent = true)::int AS sms_sent,
        COUNT(*) FILTER (WHERE day1_attended = true)::int AS day1_count,
        COUNT(*) FILTER (WHERE day2_attended = true)::int AS day2_count,
        COUNT(*) FILTER (WHERE day3_attended = true)::int AS day3_count,
        COUNT(*) FILTER (WHERE day4_attended = true)::int AS day4_count,
        COUNT(*) FILTER (WHERE DATE(registration_date) = CURRENT_DATE)::int AS today
      FROM registrations
    `);
    const row = result.rows[0] || {};
    const dayCounts = {
      1: row.day1_count || 0,
      2: row.day2_count || 0,
      3: row.day3_count || 0,
      4: row.day4_count || 0
    };
    return {
      total: row.total || 0,
      distinctChurches: row.distinct_churches || 0,
      smsSent: row.sms_sent || 0,
      today: row.today || 0,
      activeDay,
      todayAttendance: dayCounts[activeDay] || 0,
      day1Count: dayCounts[1],
      day2Count: dayCounts[2],
      day3Count: dayCounts[3],
      day4Count: dayCounts[4]
    };
  } catch (error) {
    console.error('❌ Database stats error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function isContactRegistered(contact) {
  const registration = await getRegistrationByContact(contact);
  return registration !== null;
}

async function saveNewConvert(data) {
  const name = String(data.name || '').trim();
  const contact = data.contact ? String(data.contact).trim() : null;
  const normalizedContact = contact ? normalizeContact(contact) : null;
  const location = data.location ? String(data.location).trim() : 'Accra';

  const client = await pool.connect();
  try {
    // Check for duplicate new convert: same name (case-insensitive) and same phone number
    if (normalizedContact) {
      const dupCheck = await client.query(
        `SELECT id, name FROM new_converts 
         WHERE (contact_normalized = $1 OR contact = $2) 
           AND LOWER(TRIM(name)) = LOWER(TRIM($3)) 
         LIMIT 1`,
        [normalizedContact, contact, name]
      );
      if (dupCheck.rows.length > 0) {
        console.log('⚠️ Duplicate new convert rejected for:', name, normalizedContact);
        return {
          success: false,
          duplicate: true,
          code: 'DUPLICATE_CONVERT',
          message: 'A new convert record with this name and phone number already exists.'
        };
      }
    }

    const result = await client.query(
      `
      INSERT INTO new_converts (name, contact, contact_normalized, location)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [name, contact, normalizedContact, location]
    );
    console.log('✅ New convert saved to PostgreSQL:', result.rows[0].id, name);
    return { success: true, row: result.rows[0] };
  } catch (error) {
    console.error('❌ Error saving new convert:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function getAllNewConverts() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT * FROM new_converts ORDER BY created_at DESC
    `);
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching new converts:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function getNewConvertsStatistics() {
  const client = await pool.connect();
  try {
    const totalResult = await client.query('SELECT COUNT(*) as count FROM new_converts');
    const uniqueResult = await client.query(`
      SELECT COUNT(DISTINCT contact_normalized) as count 
      FROM new_converts 
      WHERE contact_normalized IS NOT NULL AND TRIM(contact_normalized) != ''
    `);
    const withPhoneResult = await client.query(`
      SELECT COUNT(*) as count 
      FROM new_converts 
      WHERE contact IS NOT NULL AND TRIM(contact) != ''
    `);
    const todayResult = await client.query(`
      SELECT COUNT(*) as count FROM new_converts
      WHERE DATE(created_at) = CURRENT_DATE
    `);
    const total = parseInt(totalResult.rows[0].count);
    const uniqueContacts = parseInt(uniqueResult.rows[0].count);
    return {
      total,
      uniqueContacts,
      sharedContacts: Math.max(0, parseInt(withPhoneResult.rows[0].count) - uniqueContacts),
      withPhone: parseInt(withPhoneResult.rows[0].count),
      today: parseInt(todayResult.rows[0].count)
    };
  } catch (error) {
    console.error('❌ Database new converts stats error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  await pool.end();
  console.log('✅ PostgreSQL pool closed');
}

module.exports = {
  CONFERENCE_DAYS,
  getActiveConferenceDay,
  initializeDatabase,
  saveRegistration,
  saveRegistrationWithDedup,
  checkInAttendee,
  updateRegistration,
  deleteRegistration,
  updateRegistrationStatus,
  getAllRegistrations,
  getRegistrationByTicketId,
  ticketIdExists,
  getRegistrationByContact,
  getStatistics,
  isContactRegistered,
  isContactRegisteredAny,
  normalizeContact,
  closePool
};

