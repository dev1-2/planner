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
