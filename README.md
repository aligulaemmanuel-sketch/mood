# Beacon Kenya Emergency Support

A Kenya-focused support app with device GPS, OpenStreetMap maps and nearby health-facility lookup. SOS and crash buttons still create local simulation records only; there is no real dispatch integration.

**App alerts do not contact emergency contacts, hospitals, police, EMS, or public emergency services.** Emergency contacts are displayed as tap-to-call links only. Official UK government travel guidance lists **999** for ambulance, fire and police: [Getting help in Kenya](https://www.gov.uk/foreign-travel-advice/kenya/getting-help). The displayed **112** and the Kenya Red Cross E-Plus / St John Ambulance numbers were provided for this prototype; verify all numbers and availability with the relevant Kenyan service before relying on them. No number is dialled by an SOS or crash simulation.

Facility lookup uses OpenStreetMap data and may be incomplete or out of date. This is not a certified emergency-response service. Confirm numbers and procedures with Kenyan authorities before real-world deployment.

## Run locally

Requires Python 3.10 or newer.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). GPS is requested only after you press **Use current location**. On a public device deployment, browser geolocation requires HTTPS; localhost is treated as a secure context for development. This starts a local server; it does not publish the app to the internet.

If PowerShell blocks activation, use the environment's Python directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

The SQLite database is created at `data/incidents.sqlite3`. Set `EMERGENCY_DB_PATH` to use another local path.

## Prototype behavior

- **Use current location** requests a fresh device GPS position after the user grants browser permission. The map starts centered on Kenya and updates to the user's location when available.
- **Search nearby** sends the selected coordinates to this app's backend, which looks up nearby hospitals, clinics, doctors and health centres from OpenStreetMap. Results are cached for up to 60 seconds. The map uses OpenStreetMap tiles via Leaflet. This shares the coordinates with this app and map-data providers; facility details and emergency capability are not verified.
- Facility results can be filtered by hospital, clinic, health centre, or dispensary. Results show approximate straight-line distance, not ETA. A listed phone number opens the device dialer only after a user taps it, and **Directions** opens Google Maps with the current location and facility coordinates. Search requires an internet connection.
- The **Nairobi A&E and trauma hospitals** directory displays contact details supplied for this prototype. Tap-to-call links require a user action; map links open a map search. Verify phone numbers, location, services, and availability with each facility before relying on them.
- **Send test SOS** and **Simulate crash alert** create records in the local responder queue after a 10-second cancel window. These are mock incidents only—no messages leave the application.
- The responder queue can acknowledge and resolve simulated incidents. State changes are stored locally in SQLite.
- **First aid basics** provides a DRABC check and expandable illustrated English/Kiswahili reminders for CPR, severe bleeding, choking, burns, severe allergy, fractures/sprains, shock, snakebite and road-crash handover. Category filters help narrow the guides. This is general education, not a substitute for emergency dispatch, certified training or clinician-reviewed Kenyan guidance.
- The **Fire response** guide explains RACE evacuation priorities and PASS extinguisher operation, with guidance to evacuate rather than fight a spreading fire. Nairobi Fire Brigade phone numbers were user-provided and are explicitly marked to verify; call 999/112 for emergencies.
- **Emergency medical ID** is optional and stored only in this browser's local storage. It is not included in alerts or sent to the backend; clear it before sharing the device.
- **Offline first aid:** after the app has loaded online once, the service worker caches the app shell and illustrated first-aid guides. Facility search, map tiles, and the SQLite-backed responder queue still require a connection to this app's server. The service worker never caches API responses or location records.
- **Local incident export:** the queue shows up to 50 most recent records from the app's local SQLite database. Export CSV downloads those rows, including coordinates and timestamps; keep the file private.
- **Medic portal:** when Firebase is configured, provisioned staff can sign in. A dispatcher-role account can assign an active incident to a medic's Firebase UID; only that UID with a medic role can view the assigned incident and patient details. Patients must separately opt in on each test alert. Shared details are deleted when the incident is resolved or cancelled. No alerts are sent to responders or hospitals.
- The responsive interface supports dark and light themes plus a larger-text view. Facility search results come from public map data, which may be incomplete or out of date. Nairobi directory contacts were supplied for this prototype and are labeled for verification.
- Use the sun/moon control in the header to switch between dark and light mode. The selection is saved in this browser; the app defaults to dark mode when no preference has been saved.

## Optional Firebase medic sign-in

The medic portal is disabled until both the Firebase Web app configuration and Firebase Admin credentials are configured. Never commit service-account credentials or paste them into source control.

1. Create a Firebase project and register a Web app. Enable the Email/Password sign-in provider. Create medic and dispatcher accounts yourself in the trusted Firebase console; this app has no public sign-up flow.
2. Configure these environment variables for the server using the values from the Firebase Web app:

   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_WEB_API_KEY`
   - `FIREBASE_WEB_AUTH_DOMAIN`
   - `FIREBASE_WEB_APP_ID`
   - `GOOGLE_APPLICATION_CREDENTIALS` pointing to an Admin SDK service-account file stored outside this repository, or use the deployment platform's Application Default Credentials.

3. Use a trusted Firebase Admin SDK process to set custom claims: `{"role": "medic"}` for clinicians and `{"role": "dispatcher"}` for dispatchers. Refresh the user's sign-in token after changing claims. Do not let users set their own claims.
4. Restart the server. Use the dispatcher portal to assign an active incident to the exact Firebase UID of a provisioned medic. The dispatcher can see incident routing metadata but not the patient medical ID; assigned medics see only their own active incidents. The signed-in portal refreshes assigned incidents every 30 seconds; medics can also refresh manually. This is in-app polling, not a push notification, and requires the portal to remain open.

The server verifies Firebase ID tokens and role claims. The current prototype stores explicitly shared patient details in **unencrypted local SQLite**. Use only synthetic data. A real deployment must add managed encrypted storage, HTTPS, audited access, backups and deletion controls, review applicable Kenyan privacy obligations, and pass an independent security/privacy review before handling real medical data. Firebase authentication does not by itself make the database or deployment suitable for health information.

## Tests

```powershell
python -m unittest discover -s tests -v
```

## Before any real deployment

For a Kenya deployment, obtain written approval and interface specifications from the relevant Kenyan public-safety dispatch authority and any participating county health services and hospitals. Confirm the emergency numbers, facility sources, dispatch workflow, privacy obligations, and data hosting/retention requirements for the intended counties. Add only authorized, test-environment integrations behind a feature flag. Conduct privacy, security, accessibility, and operational reviews; use synthetic data for development; and complete an approved end-to-end exercise before launch. Do not automate calls or messages to public emergency numbers.
