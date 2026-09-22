# Planer

Kleine Terminverwaltung mit SQLite-Datenbank, Benutzerkonten und WhatsApp-Web-Erinnerungen.

## Benutzer und Datenbank

Beim ersten Aufruf kannst du einen Account erstellen. Passwörter werden als `scrypt`-Hash gespeichert, Login-Sessions liegen als HttpOnly-Cookie vor und jeder Termin gehört serverseitig genau einem Benutzer. Die Datenbank liegt lokal unter `data/planner.sqlite` und wird nicht ins Git-Repository übertragen.

## UI lokal testen

Die App wird auf dem VPS mit `node server.js` gestartet und dann ueber die Domain geoeffnet. Die Termine liegen in `data/appointments.json`.

## WhatsApp Web verbinden

1. Die App auf dem VPS starten.
2. Planner im Browser öffnen.
3. In WhatsApp auf dem Handy `Einstellungen > Verknüpfte Geräte > Gerät verknüpfen` öffnen.
4. Den QR-Code aus der Planner-Oberfläche scannen.

Jeder Benutzer bekommt eine eigene WhatsApp-Web-Sitzung und einen eigenen QR-Code. Die Sitzungen werden unter `.wwebjs_auth` gespeichert. Der Server prüft alle 30 Sekunden fällige Erinnerungen und sendet über die jeweilige Benutzer-Nummer. Jede aktive Sitzung startet Chromium; für 2 bis 3 gleichzeitig verbundene Benutzer sollte der VPS mindestens 4 GB RAM haben. Diese Methode ist nicht die offizielle WhatsApp Business API, kann gegen WhatsApp-Regeln verstoßen und zur Sperrung einer Nummer führen. Nur mit Einwilligung der Empfänger verwenden.

Für Erinnerungen gibt es drei Vorlagen: `Sachlich`, `Freundlich` und `Persönlich`. Mit `Zufällig auswählen` wird beim Versand eine der drei Varianten gewählt. Bestehende Termine erhalten automatisch die Einstellung `Zufällig`.

## Auf dem STRATO VPS installieren

Die folgenden Befehle auf deinem VPS per SSH ausfuehren. `deine-domain.de` ersetzt du durch deine echte Domain.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx nodejs npm libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2
sudo adduser --system --group planner
sudo mkdir -p /opt/planner
sudo chown -R planner:planner /opt/planner
```

Dann die Projektdateien nach `/opt/planner` kopieren, zum Beispiel von deinem Windows-PC aus:

```powershell
scp -i "$env:USERPROFILE\strato" -r .\* root@DEINE_SERVER_IP:/opt/planner/
```

Danach auf dem VPS die Pakete installieren:

```bash
cd /opt/planner
sudo -u planner -H bash -c 'npm install --omit=dev && npx puppeteer browsers install chrome'
```

Auf dem VPS die geheimen Werte eintragen:

```bash
sudo -u planner nano /opt/planner/.env
```

Inhalt:

```text
PORT=3000
```

Danach den Dienst einrichten:

```bash
sudo cp /opt/planner/planner.service /etc/systemd/system/planner.service
sudo systemctl daemon-reload
sudo systemctl enable --now planner
sudo systemctl status planner
```

Nginx konfigurieren:

```bash
sudo cp /opt/planner/planner.nginx.conf /etc/nginx/sites-available/planner
sudo sed -i 's/deine-domain.de/DEINE_DOMAIN/g' /etc/nginx/sites-available/planner
sudo ln -s /etc/nginx/sites-available/planner /etc/nginx/sites-enabled/planner
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS aktivieren:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d DEINE_DOMAIN -d www.DEINE_DOMAIN
```

Pruefen kannst du die Installation mit `https://DEINE_DOMAIN/api/health`. Als Antwort sollte `{"ok":true}` erscheinen. Logs findest du mit `sudo journalctl -u planner -f`.
