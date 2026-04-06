const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const SLOTS_FILE = path.join(__dirname, 'data/slots.json');
const BOOKINGS_FILE = path.join(__dirname, 'data/bookings.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: read/write JSON
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ─── SLOT ROUTES ───────────────────────────────────────────────

// GET all slots (for candidates — only available ones)
app.get('/api/slots', (req, res) => {
  const slots = readJSON(SLOTS_FILE);
  const bookings = readJSON(BOOKINGS_FILE);
  const bookedSlotIds = bookings.map(b => b.slotId);
  const available = slots
    .filter(s => !bookedSlotIds.includes(s.id))
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  res.json(available);
});

// GET all slots + bookings (for admin)
app.get('/api/admin/slots', (req, res) => {
  const slots = readJSON(SLOTS_FILE);
  const bookings = readJSON(BOOKINGS_FILE);
  const enriched = slots.map(slot => {
    const booking = bookings.find(b => b.slotId === slot.id);
    return { ...slot, booking: booking || null };
  }).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  res.json(enriched);
});

// POST create slots (admin)
app.post('/api/admin/slots', (req, res) => {
  const { date, startTime, endTime } = req.body;
  if (!date || !startTime || !endTime) {
    return res.status(400).json({ error: 'date, startTime, endTime are required' });
  }

  const slots = readJSON(SLOTS_FILE);
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);
  const startTotal = startH * 60 + startM;
  const endTotal = endH * 60 + endM;

  if (endTotal <= startTotal) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }

  const newSlots = [];
  for (let t = startTotal; t + 30 <= endTotal; t += 30) {
    const h = Math.floor(t / 60).toString().padStart(2, '0');
    const m = (t % 60).toString().padStart(2, '0');
    const datetime = `${date}T${h}:${m}:00`;
    const alreadyExists = slots.some(s => s.datetime === datetime);
    if (!alreadyExists) {
      const slot = { id: `${date}-${h}${m}-${Date.now()}`, datetime, date, time: `${h}:${m}` };
      slots.push(slot);
      newSlots.push(slot);
    }
  }

  writeJSON(SLOTS_FILE, slots);
  res.json({ created: newSlots.length, slots: newSlots });
});

// DELETE a slot (admin)
app.delete('/api/admin/slots/:id', (req, res) => {
  let slots = readJSON(SLOTS_FILE);
  let bookings = readJSON(BOOKINGS_FILE);
  slots = slots.filter(s => s.id !== req.params.id);
  bookings = bookings.filter(b => b.slotId !== req.params.id);
  writeJSON(SLOTS_FILE, slots);
  writeJSON(BOOKINGS_FILE, bookings);
  res.json({ success: true });
});

// ─── BOOKING ROUTES ────────────────────────────────────────────

// POST book a slot (candidate)
app.post('/api/book', (req, res) => {
  const { slotId, name, email } = req.body;
  if (!slotId || !name || !email) {
    return res.status(400).json({ error: 'slotId, name, and email are required' });
  }

  const slots = readJSON(SLOTS_FILE);
  const bookings = readJSON(BOOKINGS_FILE);

  const slot = slots.find(s => s.id === slotId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });

  const alreadyBooked = bookings.some(b => b.slotId === slotId);
  if (alreadyBooked) return res.status(409).json({ error: 'Slot already booked' });

  const candidateAlreadyBooked = bookings.some(b => b.email.toLowerCase() === email.toLowerCase());
  if (candidateAlreadyBooked) return res.status(409).json({ error: 'You have already booked an interview slot. Only one booking per candidate is allowed.' });

  const booking = {
    id: `booking-${Date.now()}`,
    slotId,
    name,
    email,
    datetime: slot.datetime,
    bookedAt: new Date().toISOString()
  };

  bookings.push(booking);
  writeJSON(BOOKINGS_FILE, bookings);

  res.json({ success: true, booking });
});

// GET all bookings (admin)
app.get('/api/admin/bookings', (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE);
  res.json(bookings.sort((a, b) => new Date(a.datetime) - new Date(b.datetime)));
});

// DELETE a booking (admin — frees the slot)
app.delete('/api/admin/bookings/:id', (req, res) => {
  let bookings = readJSON(BOOKINGS_FILE);
  bookings = bookings.filter(b => b.id !== req.params.id);
  writeJSON(BOOKINGS_FILE, bookings);
  res.json({ success: true });
});

// GET bookings as CSV (admin download)
app.get('/api/admin/bookings/export', (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE);
  const rows = [
    ['Name', 'Email', 'Date', 'Time', 'Booked At'],
    ...bookings
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
      .map(b => {
        const d = new Date(b.datetime);
        const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        const bookedAt = new Date(b.bookedAt).toLocaleString('en-IN');
        return [b.name, b.email, date, time, bookedAt];
      })
  ];
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`\n✅ Booking tool running at http://localhost:${PORT}`);
  console.log(`📋 Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`👤 Candidate page: http://localhost:${PORT}/\n`);
});
