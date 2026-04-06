const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BOOKINGS_PER_SLOT = parseInt(process.env.MAX_ZOOM_ACCOUNTS || '5');

// ─── DATABASE ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('railway.internal')
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY,
      datetime TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      datetime TEXT NOT NULL,
      booked_at TEXT NOT NULL
    )
  `);
  // Add new columns if they don't exist yet
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS zoom_account_index INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS zoom_link TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS zoom_meeting_id TEXT`);
  console.log('✅ Database ready');
}

// ─── ZOOM ACCOUNTS ──────────────────────────────────────────
const ZOOM_ACCOUNTS = [];
for (let i = 1; i <= 5; i++) {
  const accountId = process.env[`ZOOM_${i}_ACCOUNT_ID`];
  const clientId = process.env[`ZOOM_${i}_CLIENT_ID`];
  const clientSecret = process.env[`ZOOM_${i}_CLIENT_SECRET`];
  console.log(`ZOOM_${i}: accountId=${accountId ? 'SET' : 'MISSING'}, clientId=${clientId ? 'SET' : 'MISSING'}, clientSecret=${clientSecret ? 'SET' : 'MISSING'}`);
  if (accountId && clientId && clientSecret) {
    ZOOM_ACCOUNTS.push({ index: i - 1, accountId, clientId, clientSecret });
  }
}

async function getZoomToken(account) {
  const credentials = Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64');
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${account.accountId}`,
    { method: 'POST', headers: { Authorization: `Basic ${credentials}` } }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoom auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function createZoomMeeting(account, topic, startDatetime) {
  const token = await getZoomToken(account);
  const res = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      type: 2,
      start_time: new Date(startDatetime).toISOString(),
      duration: 30,
      timezone: 'Asia/Kolkata',
      settings: {
        host_video: true,
        participant_video: true,
        waiting_room: true,
        join_before_host: false
      }
    })
  });
  const data = await res.json();
  if (!data.join_url) throw new Error(`Zoom meeting creation failed: ${JSON.stringify(data)}`);
  return { joinUrl: data.join_url, meetingId: String(data.id) };
}

// ─── EMAIL ──────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

function formatTimeRange(time) {
  const [h, m] = time.split(':').map(Number);
  const endM = m + 30;
  const endH = endM >= 60 ? h + 1 : h;
  const endMin = endM % 60;
  const ampm = endH >= 12 ? 'PM' : 'AM';
  const h12s = h % 12 || 12;
  const h12e = endH % 12 || 12;
  return `${h12s}:${m.toString().padStart(2,'0')} – ${h12e}:${endMin.toString().padStart(2,'0')} ${ampm}`;
}

function formatDateFull(datetimeStr) {
  const d = new Date(datetimeStr);
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function sendConfirmationEmail(booking, slot) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;

  const dateStr = formatDateFull(booking.datetime);
  const timeStr = formatTimeRange(slot.time);
  const zoomLink = booking.zoom_link || 'Will be shared shortly';

  await transporter.sendMail({
    from: `"Cuemath Hiring" <${process.env.GMAIL_USER}>`,
    to: booking.email,
    subject: `Your Cuemath Interview is Confirmed — ${dateStr}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0D0D0D">
        <div style="background:#0D0D0D;padding:20px 28px">
          <span style="font-size:20px;font-weight:900;color:#FFBA07">cue</span><span style="font-size:20px;font-weight:900;color:#fff">math</span>
        </div>
        <div style="padding:32px 28px;border:1px solid #E0E0E0;border-top:none">
          <h2 style="font-size:22px;font-weight:800;margin-bottom:8px">You're confirmed, ${booking.name}!</h2>
          <p style="color:#666;margin-bottom:24px">Your interview has been successfully scheduled. Here are your details:</p>

          <div style="background:#F5F5F5;border-left:4px solid #FFBA07;padding:16px 20px;margin-bottom:24px">
            <div style="margin-bottom:8px"><strong>Date:</strong> ${dateStr}</div>
            <div style="margin-bottom:8px"><strong>Time:</strong> ${timeStr} (30 minutes)</div>
            <div style="margin-bottom:8px"><strong>Format:</strong> Zoom Video Call</div>
            <div><strong>Meeting Link:</strong> <a href="${zoomLink}" style="color:#FFBA07;font-weight:700">${zoomLink}</a></div>
          </div>

          <div style="background:#fff8e1;border:1px solid #FFBA07;padding:14px 18px;margin-bottom:24px;font-size:13px">
            <strong>Important:</strong> Please be available at the scheduled time. We've reserved this slot exclusively for you and look forward to meeting you. Last-minute cancellations are not possible.
          </div>

          <p style="font-size:13px;color:#888">If you have any questions, reply to this email.</p>
          <p style="font-size:13px;color:#888;margin-top:8px">Good luck! — Cuemath Hiring Team</p>
        </div>
      </div>
    `
  });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SLOT ROUTES ───────────────────────────────────────────────

app.get('/api/slots', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, COUNT(b.id)::int AS booking_count
      FROM slots s
      LEFT JOIN bookings b ON b.slot_id = s.id
      GROUP BY s.id
      HAVING COUNT(b.id) < $1
      ORDER BY s.datetime ASC
    `, [MAX_BOOKINGS_PER_SLOT]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/slots', async (req, res) => {
  try {
    const { rows: slots } = await pool.query(`
      SELECT s.*, COUNT(b.id)::int AS booking_count
      FROM slots s
      LEFT JOIN bookings b ON b.slot_id = s.id
      GROUP BY s.id
      ORDER BY s.datetime ASC
    `);
    const { rows: bookings } = await pool.query('SELECT * FROM bookings ORDER BY booked_at ASC');
    const enriched = slots.map(slot => ({
      ...slot,
      bookings: bookings.filter(b => b.slot_id === slot.id),
      capacity: MAX_BOOKINGS_PER_SLOT
    }));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/slots', async (req, res) => {
  const { date, startTime, endTime } = req.body;
  if (!date || !startTime || !endTime) {
    return res.status(400).json({ error: 'date, startTime, endTime are required' });
  }

  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);
  const startTotal = startH * 60 + startM;
  const endTotal = endH * 60 + endM;

  if (endTotal <= startTotal) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }

  try {
    const { rows: existing } = await pool.query('SELECT datetime FROM slots WHERE date = $1', [date]);
    const existingDatetimes = new Set(existing.map(s => s.datetime));
    const newSlots = [];

    for (let t = startTotal; t + 30 <= endTotal; t += 30) {
      const h = Math.floor(t / 60).toString().padStart(2, '0');
      const m = (t % 60).toString().padStart(2, '0');
      const datetime = `${date}T${h}:${m}:00`;
      if (!existingDatetimes.has(datetime)) {
        const id = `${date}-${h}${m}-${Date.now()}`;
        await pool.query(
          'INSERT INTO slots (id, datetime, date, time) VALUES ($1, $2, $3, $4)',
          [id, datetime, date, `${h}:${m}`]
        );
        newSlots.push({ id, datetime, date, time: `${h}:${m}` });
      }
    }
    res.json({ created: newSlots.length, slots: newSlots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/slots/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM slots WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── BOOKING ROUTES ────────────────────────────────────────────

app.post('/api/book', async (req, res) => {
  const { slotId, name, email } = req.body;
  if (!slotId || !name || !email) {
    return res.status(400).json({ error: 'slotId, name, and email are required' });
  }

  try {
    const { rows: slots } = await pool.query('SELECT * FROM slots WHERE id = $1', [slotId]);
    if (slots.length === 0) return res.status(404).json({ error: 'Slot not found' });

    const { rows: slotBookings } = await pool.query(
      'SELECT zoom_account_index FROM bookings WHERE slot_id = $1', [slotId]
    );
    if (slotBookings.length >= MAX_BOOKINGS_PER_SLOT) {
      return res.status(409).json({ error: 'This slot is fully booked. Please choose another time.' });
    }

    const { rows: candidateBookings } = await pool.query(
      'SELECT id FROM bookings WHERE LOWER(email) = LOWER($1)', [email]
    );
    if (candidateBookings.length > 0) {
      return res.status(409).json({ error: 'You have already booked an interview slot. Only one booking per candidate is allowed.' });
    }

    // Round-robin: pick next available zoom account index
    const usedIndexes = slotBookings.map(b => b.zoom_account_index);
    let zoomIndex = 0;
    for (let i = 0; i < MAX_BOOKINGS_PER_SLOT; i++) {
      if (!usedIndexes.includes(i)) { zoomIndex = i; break; }
    }

    const slot = slots[0];

    // Create Zoom meeting if credentials available
    let zoomLink = null;
    let zoomMeetingId = null;
    const zoomAccount = ZOOM_ACCOUNTS.find(a => a.index === zoomIndex) || ZOOM_ACCOUNTS[0];
    if (zoomAccount) {
      try {
        const meeting = await createZoomMeeting(
          zoomAccount,
          `Cuemath Interview — ${name}`,
          slot.datetime
        );
        zoomLink = meeting.joinUrl;
        zoomMeetingId = meeting.meetingId;
      } catch (zoomErr) {
        console.error('Zoom meeting creation failed:', zoomErr.message);
      }
    }

    const booking = {
      id: `booking-${Date.now()}`,
      slot_id: slotId,
      zoom_account_index: zoomIndex,
      name,
      email,
      datetime: slot.datetime,
      booked_at: new Date().toISOString(),
      zoom_link: zoomLink,
      zoom_meeting_id: zoomMeetingId
    };

    await pool.query(
      `INSERT INTO bookings (id, slot_id, zoom_account_index, name, email, datetime, booked_at, zoom_link, zoom_meeting_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [booking.id, booking.slot_id, booking.zoom_account_index, booking.name, booking.email,
       booking.datetime, booking.booked_at, booking.zoom_link, booking.zoom_meeting_id]
    );

    // Send confirmation email (non-blocking)
    sendConfirmationEmail(booking, slot).catch(e => console.error('Email error:', e.message));

    res.json({ success: true, booking: { ...booking, slotId }, zoomLink });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY datetime ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/bookings/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/bookings/export', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY datetime ASC');
    const csvRows = [
      ['Name', 'Email', 'Date', 'Time', 'Zoom Account #', 'Zoom Link', 'Booked At'],
      ...rows.map(b => {
        const d = new Date(b.datetime);
        const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        const bookedAt = new Date(b.booked_at).toLocaleString('en-IN');
        return [b.name, b.email, date, time, `Account ${b.zoom_account_index + 1}`, b.zoom_link || 'Pending', bookedAt];
      })
    ];
    const csv = csvRows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ Booking tool running at http://localhost:${PORT}`);
    console.log(`📋 Admin panel: http://localhost:${PORT}/admin.html`);
    console.log(`👤 Candidate page: http://localhost:${PORT}/\n`);
    console.log(`🎥 Zoom accounts configured: ${ZOOM_ACCOUNTS.length}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
