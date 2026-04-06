const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

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
  console.log('✅ Database ready');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SLOT ROUTES ───────────────────────────────────────────────

// GET all available slots (for candidates)
app.get('/api/slots', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.* FROM slots s
      WHERE s.id NOT IN (SELECT slot_id FROM bookings)
      ORDER BY s.datetime ASC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET all slots + bookings (for admin)
app.get('/api/admin/slots', async (req, res) => {
  try {
    const { rows: slots } = await pool.query('SELECT * FROM slots ORDER BY datetime ASC');
    const { rows: bookings } = await pool.query('SELECT * FROM bookings');
    const enriched = slots.map(slot => ({
      ...slot,
      booking: bookings.find(b => b.slot_id === slot.id) || null
    }));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create slots (admin)
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

// DELETE a slot (admin)
app.delete('/api/admin/slots/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM slots WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── BOOKING ROUTES ────────────────────────────────────────────

// POST book a slot (candidate)
app.post('/api/book', async (req, res) => {
  const { slotId, name, email } = req.body;
  if (!slotId || !name || !email) {
    return res.status(400).json({ error: 'slotId, name, and email are required' });
  }

  try {
    const { rows: slots } = await pool.query('SELECT * FROM slots WHERE id = $1', [slotId]);
    if (slots.length === 0) return res.status(404).json({ error: 'Slot not found' });

    const { rows: slotBookings } = await pool.query('SELECT id FROM bookings WHERE slot_id = $1', [slotId]);
    if (slotBookings.length > 0) return res.status(409).json({ error: 'Slot already booked' });

    const { rows: candidateBookings } = await pool.query(
      'SELECT id FROM bookings WHERE LOWER(email) = LOWER($1)', [email]
    );
    if (candidateBookings.length > 0) {
      return res.status(409).json({ error: 'You have already booked an interview slot. Only one booking per candidate is allowed.' });
    }

    const slot = slots[0];
    const booking = {
      id: `booking-${Date.now()}`,
      slot_id: slotId,
      name,
      email,
      datetime: slot.datetime,
      booked_at: new Date().toISOString()
    };

    await pool.query(
      'INSERT INTO bookings (id, slot_id, name, email, datetime, booked_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [booking.id, booking.slot_id, booking.name, booking.email, booking.datetime, booking.booked_at]
    );

    res.json({ success: true, booking: { ...booking, slotId } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET all bookings (admin)
app.get('/api/admin/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY datetime ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE a booking (admin)
app.delete('/api/admin/bookings/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET bookings as CSV (admin download)
app.get('/api/admin/bookings/export', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY datetime ASC');
    const csvRows = [
      ['Name', 'Email', 'Date', 'Time', 'Booked At'],
      ...rows.map(b => {
        const d = new Date(b.datetime);
        const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        const bookedAt = new Date(b.booked_at).toLocaleString('en-IN');
        return [b.name, b.email, date, time, bookedAt];
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
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
