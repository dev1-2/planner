const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const port = Number(process.env.PORT || 3000);
const root = __dirname;
const dataDirectory = path.join(root, 'data');
let reminderCheckRunning = false;
const whatsapp = { status: 'WhatsApp wird gestartet ...', qr: null, ready: false };

fs.mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(path.join(dataDirectory, 'planner.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  reminder_minutes INTEGER NOT NULL,
  reminder_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  error TEXT,
    created_at TEXT NOT NULL
  );
`);

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 1000000) reject(new Error('Request too large')); });
  request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
  request.on('error', reject);
  });
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(cookie => {
    const separator = cookie.indexOf('=');
    return [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1).trim())];
  }));
}

function currentUser(request) {
  const token = parseCookies(request).planner_session;
  if (!token) return null;
  return database.prepare(`SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > ?`).get(token, new Date().toISOString()) || null;
}

function requireUser(request, response) {
  const user = currentUser(request);
  if (!user) sendJson(response, 401, { error: 'Bitte zuerst anmelden.' });
  return user;
}

function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function validPassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 200; }
function appointmentDate(appointment) { return new Date(`${appointment.date}T${appointment.time}`); }
function validAppointment(body) { return body.title && body.date && body.time && body.phone && !Number.isNaN(appointmentDate(body).getTime()); }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  database.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString());
  return token;
}

function sessionCookie(token) { return `planner_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`; }

function migrateLegacyAppointments(userId) {
  const legacyFile = path.join(dataDirectory, 'appointments.json');
  if (!fs.existsSync(legacyFile)) return;
  try {
    const appointments = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    const insert = database.prepare('INSERT OR IGNORE INTO appointments (id, user_id, title, date, time, contact_name, phone, reminder_minutes, reminder_at, sent, sent_at, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const item of appointments) insert.run(item.id || crypto.randomUUID(), userId, item.title, item.date, item.time, item.contactName || '', item.phone || '', Number(item.reminderMinutes || 1440), item.reminderAt || new Date(appointmentDate(item).getTime() - Number(item.reminderMinutes || 1440) * 60000).toISOString(), item.sent ? 1 : 0, item.sentAt || null, item.error || null, item.createdAt || new Date().toISOString());
    fs.renameSync(legacyFile, `${legacyFile}.migrated`);
  } catch (error) { console.error('Legacy-Termine konnten nicht migriert werden:', error.message); }
}

async function sendWhatsApp(appointment) {
  if (!whatsapp.ready) throw new Error('WhatsApp ist noch nicht verbunden');
  const phone = appointment.phone.replace(/[^0-9]/g, '');
  if (!phone) throw new Error('Ungueltige WhatsApp-Nummer');
  return whatsappClient.sendMessage(`${phone}@c.us`, `Erinnerung: ${appointment.title} am ${appointment.date} um ${appointment.time} Uhr.`);
}

async function processReminders() {
  if (reminderCheckRunning) return;
  reminderCheckRunning = true;
  try {
    const due = database.prepare('SELECT * FROM appointments WHERE sent = 0 AND reminder_at <= ? AND error IS NULL').all(new Date().toISOString());
    for (const appointment of due) {
      try {
        await sendWhatsApp(appointment);
        database.prepare('UPDATE appointments SET sent = 1, sent_at = ?, error = NULL WHERE id = ?').run(new Date().toISOString(), appointment.id);
      } catch (error) {
        database.prepare('UPDATE appointments SET error = ? WHERE id = ?').run(error.message, appointment.id);
        console.error(`WhatsApp-Erinnerung fehlgeschlagen: ${appointment.title}`, error.message);
      }
    }
  } finally { reminderCheckRunning = false; }
}

function serveStatic(response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) return sendJson(response, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (error, content) => {
    if (error) return sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Not found' });
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  });
}

const whatsappClient = new Client({ authStrategy: new LocalAuth({ dataPath: path.join(root, '.wwebjs_auth') }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] } });
whatsappClient.on('qr', async qr => { whatsapp.qr = await qrcode.toDataURL(qr); whatsapp.ready = false; whatsapp.status = 'QR-Code zum Verbinden bereit'; });
whatsappClient.on('authenticated', () => { whatsapp.qr = null; whatsapp.status = 'WhatsApp authentifiziert'; });
whatsappClient.on('ready', () => { whatsapp.qr = null; whatsapp.ready = true; whatsapp.status = 'WhatsApp verbunden'; console.log('WhatsApp ist verbunden.'); });
whatsappClient.on('disconnected', reason => { whatsapp.ready = false; whatsapp.status = `WhatsApp getrennt: ${reason}`; });
whatsappClient.on('auth_failure', () => { whatsapp.ready = false; whatsapp.status = 'WhatsApp-Authentifizierung fehlgeschlagen'; });

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health' && request.method === 'GET') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/auth/me' && request.method === 'GET') return sendJson(response, 200, { user: currentUser(request) });
    if (url.pathname === '/api/auth/register' && request.method === 'POST') {
      const body = await readBody(request);
      const username = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(username) || !validPassword(body.password)) return sendJson(response, 400, { error: 'Benutzername: 3-40 Zeichen. Passwort: mindestens 8 Zeichen.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const userId = crypto.randomUUID();
      try { database.prepare('INSERT INTO users (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, username, passwordHash(body.password, salt), salt, new Date().toISOString()); }
      catch { return sendJson(response, 409, { error: 'Dieser Benutzername ist bereits vergeben.' }); }
      migrateLegacyAppointments(userId);
      return sendJson(response, 201, { user: { id: userId, username }, }, { 'Set-Cookie': sessionCookie(createSession(userId)) });
    }
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await readBody(request); const user = database.prepare('SELECT * FROM users WHERE username = ?').get(String(body.username || '').trim().toLowerCase());
      if (!user || !validPassword(body.password) || !crypto.timingSafeEqual(Buffer.from(passwordHash(body.password, user.salt), 'hex'), Buffer.from(user.password_hash, 'hex'))) return sendJson(response, 401, { error: 'Benutzername oder Passwort ist falsch.' });
      return sendJson(response, 200, { user: { id: user.id, username: user.username } }, { 'Set-Cookie': sessionCookie(createSession(user.id)) });
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') { const token = parseCookies(request).planner_session; if (token) database.prepare('DELETE FROM sessions WHERE token = ?').run(token); return sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'planner_session=; Path=/; HttpOnly; Max-Age=0' }); }
    if (url.pathname === '/api/whatsapp/status' && request.method === 'GET') { const user = requireUser(request, response); if (!user) return; return sendJson(response, 200, whatsapp); }
    if (url.pathname === '/api/appointments' && request.method === 'GET') { const user = requireUser(request, response); if (!user) return; return sendJson(response, 200, database.prepare('SELECT id, title, date, time, contact_name AS contactName, phone, reminder_minutes AS reminderMinutes, sent, sent_at AS sentAt, error FROM appointments WHERE user_id = ? ORDER BY date, time').all(user.id)); }
    if (url.pathname === '/api/appointments' && request.method === 'POST') {
      const user = requireUser(request, response); if (!user) return;
      const body = await readBody(request); if (!validAppointment(body)) return sendJson(response, 400, { error: 'title, date, time und phone sind erforderlich' });
      const reminderMinutes = Number(body.reminderMinutes || 1440); const appointment = { id: crypto.randomUUID(), userId: user.id, title: String(body.title).slice(0, 80), date: body.date, time: body.time, contactName: String(body.contactName || '').slice(0, 80), phone: String(body.phone), reminderMinutes, reminderAt: new Date(appointmentDate(body).getTime() - reminderMinutes * 60000).toISOString(), sent: 0, createdAt: new Date().toISOString() };
      database.prepare('INSERT INTO appointments (id, user_id, title, date, time, contact_name, phone, reminder_minutes, reminder_at, sent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').run(appointment.id, user.id, appointment.title, appointment.date, appointment.time, appointment.contactName, appointment.phone, appointment.reminderMinutes, appointment.reminderAt, appointment.createdAt);
      return sendJson(response, 201, appointment);
    }
    if (url.pathname.startsWith('/api/appointments/') && request.method === 'DELETE') { const user = requireUser(request, response); if (!user) return; const result = database.prepare('DELETE FROM appointments WHERE id = ? AND user_id = ?').run(url.pathname.split('/').pop(), user.id); return sendJson(response, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Termin nicht gefunden' }); }
    if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'Not found' });
    return serveStatic(response, url.pathname);
  } catch (error) { console.error(error); return sendJson(response, 500, { error: error.message }); }
});

server.listen(port, '127.0.0.1', () => console.log(`Planner running on http://127.0.0.1:${port}`));
setInterval(processReminders, 30000);
processReminders();
whatsappClient.initialize().catch(error => { whatsapp.status = `WhatsApp konnte nicht starten: ${error.message}`; console.error(error); });
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const port = Number(process.env.PORT || 3000);
const root = __dirname;
const dataDirectory = path.join(root, 'data');
const dataFile = path.join(dataDirectory, 'appointments.json');
let reminderCheckRunning = false;
const whatsapp = { status: 'WhatsApp wird gestartet ...', qr: null, ready: false };
const whatsappClient = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(root, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

whatsappClient.on('qr', async qr => {
  whatsapp.qr = await qrcode.toDataURL(qr);
  whatsapp.ready = false;
  whatsapp.status = 'QR-Code zum Verbinden bereit';
  console.log('WhatsApp QR-Code ist in der Planner-Weboberflaeche verfuegbar.');
});
whatsappClient.on('authenticated', () => { whatsapp.qr = null; whatsapp.status = 'WhatsApp authentifiziert'; });
whatsappClient.on('ready', () => { whatsapp.qr = null; whatsapp.ready = true; whatsapp.status = 'WhatsApp verbunden'; console.log('WhatsApp ist verbunden.'); });
whatsappClient.on('disconnected', reason => { whatsapp.ready = false; whatsapp.status = `WhatsApp getrennt: ${reason}`; });
whatsappClient.on('auth_failure', () => { whatsapp.ready = false; whatsapp.status = 'WhatsApp-Authentifizierung fehlgeschlagen'; });

fs.mkdirSync(dataDirectory, { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '[]', 'utf8');

function readAppointments() {
  try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch { return []; }
}

function writeAppointments(appointments) {
  const temporaryFile = `${dataFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(appointments, null, 2), 'utf8');
  fs.renameSync(temporaryFile, dataFile);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 1000000) reject(new Error('Request too large')); });
    request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    request.on('error', reject);
  });
}

function appointmentDate(appointment) { return new Date(`${appointment.date}T${appointment.time}`); }
function validAppointment(body) { return body.title && body.date && body.time && body.phone && !Number.isNaN(appointmentDate(body).getTime()); }

async function sendWhatsApp(appointment) {
  if (!whatsapp.ready) throw new Error('WhatsApp ist noch nicht verbunden');
  const phone = appointment.phone.replace(/[^0-9]/g, '');
  if (!phone) throw new Error('Ungueltige WhatsApp-Nummer');
  return whatsappClient.sendMessage(`${phone}@c.us`, `Erinnerung: ${appointment.title} am ${appointment.date} um ${appointment.time} Uhr.`);
}

async function processReminders() {
  if (reminderCheckRunning) return;
  reminderCheckRunning = true;
  try {
    const appointments = readAppointments();
    let changed = false;
    for (const appointment of appointments) {
      if (appointment.sent || appointment.sending || new Date(appointment.reminderAt) > new Date()) continue;
      appointment.sending = true;
      changed = true;
      try {
        await sendWhatsApp(appointment);
        appointment.sent = true;
        appointment.sentAt = new Date().toISOString();
        delete appointment.error;
        console.log(`WhatsApp reminder sent for ${appointment.title}`);
      } catch (error) {
        appointment.error = error.message;
        console.error(`WhatsApp reminder failed for ${appointment.title}:`, error.message);
      } finally { delete appointment.sending; }
    }
    if (changed) writeAppointments(appointments);
  } finally { reminderCheckRunning = false; }
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) return sendJson(response, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (error, content) => {
    if (error) return sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Not found' });
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health' && request.method === 'GET') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/whatsapp/status' && request.method === 'GET') return sendJson(response, 200, whatsapp);
    if (url.pathname === '/api/appointments' && request.method === 'GET') return sendJson(response, 200, readAppointments());
    if (url.pathname === '/api/appointments' && request.method === 'POST') {
      const body = await readBody(request);
      if (!validAppointment(body)) return sendJson(response, 400, { error: 'title, date, time und phone sind erforderlich' });
      const reminderMinutes = Number(body.reminderMinutes || 1440);
      const appointment = { id: crypto.randomUUID(), title: String(body.title).slice(0, 80), date: body.date, time: body.time, contactName: String(body.contactName || '').slice(0, 80), phone: String(body.phone), reminderMinutes, reminderAt: new Date(appointmentDate(body).getTime() - reminderMinutes * 60000).toISOString(), sent: false, createdAt: new Date().toISOString() };
      const appointments = readAppointments(); appointments.push(appointment); writeAppointments(appointments);
      return sendJson(response, 201, appointment);
    }
    if (url.pathname.startsWith('/api/appointments/') && request.method === 'DELETE') {
      const id = url.pathname.split('/').pop();
      const appointments = readAppointments(); const filtered = appointments.filter(appointment => appointment.id !== id);
      if (filtered.length === appointments.length) return sendJson(response, 404, { error: 'Termin nicht gefunden' });
      writeAppointments(filtered); return sendJson(response, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'Not found' });
    return serveStatic(request, response, url.pathname);
  } catch (error) { return sendJson(response, 500, { error: error.message }); }
});

server.listen(port, '127.0.0.1', () => console.log(`Planner running on http://127.0.0.1:${port}`));
setInterval(processReminders, 30000);
processReminders();
whatsappClient.initialize().catch(error => { whatsapp.status = `WhatsApp konnte nicht starten: ${error.message}`; console.error(error); });
