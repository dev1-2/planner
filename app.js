const list = document.querySelector('#appointmentList');
const emptyState = document.querySelector('#emptyState');
const dialog = document.querySelector('#appointmentDialog');
const form = document.querySelector('#appointmentForm');
const searchInput = document.querySelector('#searchInput');
const filterSelect = document.querySelector('#filterSelect');
const whatsappStatus = document.querySelector('#whatsappStatus');
const whatsappHint = document.querySelector('#whatsappHint');
const whatsappQr = document.querySelector('#whatsappQr');
const authScreen = document.querySelector('#authScreen');
const authForm = document.querySelector('#authForm');
const authError = document.querySelector('#authError');
const registerButton = document.querySelector('#registerButton');
const logoutButton = document.querySelector('#logoutButton');
const userLabel = document.querySelector('#userLabel');
const toast = document.querySelector('#toast');

let appointments = [];

const dateFormatter = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const fullDateFormatter = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long' });

function toDate(appointment) { return new Date(`${appointment.date}T${appointment.time}`); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character])); }
function showAuthError(message) { authError.textContent = message; authError.hidden = false; }
function showToast(message) { toast.textContent = message; toast.hidden = false; window.clearTimeout(showToast.timeout); showToast.timeout = window.setTimeout(() => { toast.hidden = true; }, 3200); }
function showPlanner(user) { authScreen.hidden = true; document.querySelector('main').hidden = false; userLabel.textContent = user.username; loadAppointments().catch(() => {}); loadWhatsAppStatus().catch(() => {}); }
function render() {
  const now = new Date();
  const query = searchInput.value.trim().toLowerCase();
  const filter = filterSelect.value;
  const visible = appointments
    .filter(item => !query || `${item.title} ${item.contactName}`.toLowerCase().includes(query))
    .filter(item => filter === 'all' || (filter === 'today' ? toDate(item).toDateString() === now.toDateString() : toDate(item) >= new Date(now.getTime() - 60000)))
    .sort((a, b) => toDate(a) - toDate(b));

  const styleLabels = { random: 'Zufällig', concise: 'Sachlich', friendly: 'Freundlich', personal: 'Persönlich' };
  list.innerHTML = visible.map(item => {
    const appointmentDate = toDate(item);
    const past = appointmentDate < now;
    return `<article class="appointment ${past ? 'past' : ''}">
      <div class="appointment-date">${escapeHtml(dateFormatter.format(appointmentDate))}<small>${escapeHtml(item.time)} Uhr</small></div>
      <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.contactName || 'Kein Kontakt')} ${item.phone ? `· ${escapeHtml(item.phone)}` : ''}</p><span class="message-type">${escapeHtml(styleLabels[item.messageStyle] || 'Zufällig')}</span></div>
      <div class="appointment-actions"><span class="status">${item.sent ? 'Gesendet' : 'Geplant'}</span><button class="delete-button" data-delete="${item.id}" aria-label="Termin löschen">×</button></div>
    </article>`;
  }).join('');
  emptyState.hidden = visible.length > 0;
  document.querySelector('#plannedCount').textContent = appointments.filter(item => toDate(item) >= now).length;
  document.querySelector('#todayCount').textContent = appointments.filter(item => toDate(item).toDateString() === now.toDateString()).length;
  document.querySelector('#sentCount').textContent = appointments.filter(item => item.sent).length;
}

document.querySelector('#todayLabel').textContent = fullDateFormatter.format(new Date()).split(',')[0];
document.querySelector('#todayDate').textContent = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(new Date());
document.querySelector('#openFormButton').addEventListener('click', () => { form.reset(); form.date.value = new Date().toISOString().slice(0, 10); form.time.value = '09:00'; dialog.showModal(); });
document.querySelector('#closeFormButton').addEventListener('click', () => dialog.close());
form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(form);
  const response = await fetch('/api/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(data)) });
  if (!response.ok) return showToast('Der Termin konnte nicht gespeichert werden.');
  await loadAppointments(); dialog.close(); showToast('Termin gespeichert');
});
list.addEventListener('click', async event => { const button = event.target.closest('[data-delete]'); if (!button) return; await fetch(`/api/appointments/${button.dataset.delete}`, { method: 'DELETE' }); await loadAppointments(); showToast('Termin gelöscht'); });
searchInput.addEventListener('input', render); filterSelect.addEventListener('change', render);

async function loadAppointments() {
  const response = await fetch('/api/appointments');
  appointments = response.ok ? await response.json() : [];
  render();
}

async function loadWhatsAppStatus() {
  const response = await fetch('/api/whatsapp/status');
  if (!response.ok) throw new Error('WhatsApp-Status konnte nicht geladen werden.');
  const status = await response.json();
  whatsappStatus.textContent = status.ready ? 'WhatsApp ist verbunden' : status.status;
  whatsappHint.textContent = status.ready ? 'Deine Erinnerungen werden über deine verknüpfte Sitzung gesendet.' : 'Scanne den QR-Code deiner eigenen Nummer unter „Verknüpfte Geräte“. Der QR-Code läuft regelmäßig ab.';
  whatsappQr.hidden = !status.qr;
  if (status.qr) whatsappQr.src = status.qr;
}

async function authenticate(endpoint) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(authForm))) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Anmeldung fehlgeschlagen.');
  showPlanner(result.user);
}

authForm.addEventListener('submit', async event => { event.preventDefault(); authError.hidden = true; try { await authenticate('/api/auth/login'); } catch (error) { showAuthError(error.message); } });
registerButton.addEventListener('click', async () => { authError.hidden = true; try { await authenticate('/api/auth/register'); } catch (error) { showAuthError(error.message); } });
logoutButton.addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.reload(); });

(async () => {
  const response = await fetch('/api/auth/me');
  const result = await response.json();
  if (result.user) showPlanner(result.user);
})();
setInterval(() => { if (!authScreen.hidden) return; loadWhatsAppStatus().catch(() => {}); }, 5000);
