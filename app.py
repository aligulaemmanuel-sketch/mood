from __future__ import annotations

import json
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, model_validator


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATABASE_PATH = Path(
    os.environ.get("EMERGENCY_DB_PATH", str(ROOT / "data" / "incidents.sqlite3"))
)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_USER_AGENT = "EmergencyAlertPrototype/1.0 (local safety demo)"
FACILITY_CACHE_SECONDS = 60
FACILITY_CACHE: dict[tuple[float, float, int], tuple[datetime, list[dict]]] = {}

app = FastAPI(
    title="Emergency Alert Prototype",
    description=(
        "A simulation-only emergency alert prototype. It never contacts public "
        "emergency services, hospitals, or real contacts."
    ),
    version="0.1.0",
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _initialize_database() -> None:
    with _connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS incidents (
                id TEXT PRIMARY KEY,
                request_key TEXT NOT NULL UNIQUE,
                source TEXT NOT NULL CHECK (source IN ('manual_sos', 'simulated_crash')),
                status TEXT NOT NULL CHECK (
                    status IN ('active', 'acknowledged', 'resolved', 'cancelled')
                ),
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                accuracy_m REAL,
                location_captured_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                resolution_note TEXT
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS incidents_created_at ON incidents(created_at)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS incident_patient_details (
                incident_id TEXT PRIMARY KEY REFERENCES incidents(id) ON DELETE CASCADE,
                name TEXT NOT NULL DEFAULT '',
                blood_group TEXT NOT NULL DEFAULT '',
                allergies TEXT NOT NULL DEFAULT '',
                conditions TEXT NOT NULL DEFAULT '',
                medicines TEXT NOT NULL DEFAULT '',
                contact_name TEXT NOT NULL DEFAULT '',
                contact_phone TEXT NOT NULL DEFAULT '',
                shared_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS incident_assignments (
                incident_id TEXT PRIMARY KEY REFERENCES incidents(id) ON DELETE CASCADE,
                medic_uid TEXT NOT NULL,
                assigned_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS incident_assignments_medic_uid "
            "ON incident_assignments(medic_uid)"
        )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _incident_dict(row: sqlite3.Row) -> dict:
    return dict(row)


class PatientDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(default="", max_length=80)
    blood_group: str = Field(default="", max_length=24)
    allergies: str = Field(default="", max_length=500)
    conditions: str = Field(default="", max_length=500)
    medicines: str = Field(default="", max_length=500)
    contact_name: str = Field(default="", max_length=80)
    contact_phone: str = Field(default="", max_length=24)


class IncidentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_key: str = Field(min_length=8, max_length=80)
    source: Literal["manual_sos", "simulated_crash"]
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0, le=100_000)
    location_captured_at: datetime
    share_patient_details: bool = False
    patient_details: PatientDetails | None = None

    @model_validator(mode="after")
    def require_consent_for_patient_details(self) -> IncidentCreate:
        if self.patient_details is not None and not self.share_patient_details:
            raise ValueError("Patient details require explicit incident-sharing consent.")
        return self


class IncidentAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    medic_uid: str = Field(min_length=1, max_length=128)


class Resolution(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: str = Field(default="", max_length=300)


def _firebase_web_config() -> dict:
    project_id = os.environ.get("FIREBASE_PROJECT_ID", "")
    values = {
        "apiKey": os.environ.get("FIREBASE_WEB_API_KEY", ""),
        "authDomain": os.environ.get("FIREBASE_WEB_AUTH_DOMAIN", ""),
        "projectId": project_id,
        "appId": os.environ.get("FIREBASE_WEB_APP_ID", ""),
    }
    return {"enabled": all(values.values()), **values}


def _verify_firebase_id_token(token: str) -> dict:
    if not _firebase_web_config()["enabled"]:
        raise HTTPException(
            status_code=503,
            detail="Medic sign-in is not configured on this server.",
        )
    try:
        from firebase_admin import auth, get_app, initialize_app
        from firebase_admin.exceptions import FirebaseError
        from google.auth.exceptions import GoogleAuthError
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="Firebase Admin SDK is not installed on this server.",
        ) from exc

    try:
        try:
            firebase_app = get_app()
        except ValueError:
            try:
                firebase_app = initialize_app(
                    options={"projectId": os.environ["FIREBASE_PROJECT_ID"]}
                )
            except ValueError:
                firebase_app = get_app()
    except (FirebaseError, GoogleAuthError, ValueError) as exc:
        raise HTTPException(
            status_code=503,
            detail="Could not initialize Firebase Admin. Check server credentials and project settings.",
        ) from exc

    try:
        return auth.verify_id_token(token, app=firebase_app, check_revoked=True)
    except (
        auth.InvalidIdTokenError,
        auth.ExpiredIdTokenError,
        auth.RevokedIdTokenError,
        auth.UserDisabledError,
    ) as exc:
        raise HTTPException(status_code=401, detail="Firebase sign-in is invalid or expired.") from exc
    except FirebaseError as exc:
        raise HTTPException(
            status_code=503,
            detail="Could not verify Firebase sign-in. Check server credentials and connectivity.",
        ) from exc


def firebase_identity(authorization: str | None = Header(default=None)) -> dict:
    if not authorization:
        raise HTTPException(status_code=401, detail="Sign in with an authorized account.")
    scheme, separator, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not separator or not token.strip():
        raise HTTPException(status_code=401, detail="A valid Firebase bearer token is required.")
    identity = _verify_firebase_id_token(token.strip())
    uid = identity.get("uid") or identity.get("sub")
    if not isinstance(uid, str) or not uid:
        raise HTTPException(status_code=401, detail="Firebase token has no user identifier.")
    identity["uid"] = uid
    return identity


def _require_role(identity: dict, role: str) -> None:
    roles = identity.get("roles")
    if identity.get("role") != role and not (
        isinstance(roles, list) and role in roles
    ):
        raise HTTPException(status_code=403, detail=f"An authorized {role} account is required.")


def _fetch_facilities(latitude: float, longitude: float, radius_m: int) -> list[dict]:
    selectors = (
        f'nwr["amenity"~"^(hospital|clinic|doctors)$"]'
        f"(around:{radius_m},{latitude},{longitude});"
        f'nwr["healthcare"~"^(hospital|clinic|centre|health_centre|health_center|'
        f'dispensary|doctor)$"](around:{radius_m},{latitude},{longitude});'
    )
    query = (
        "[out:json][timeout:15];("
        f"{selectors}"
        ");out center tags;"
    )
    request = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": query}).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": OVERPASS_USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=503,
            detail="OpenStreetMap facility search is temporarily unavailable.",
        ) from exc

    facilities: list[dict] = []
    for element in payload.get("elements", []):
        tags = element.get("tags", {})
        center = element.get("center", {})
        lat = element.get("lat", center.get("lat"))
        lon = element.get("lon", center.get("lon"))
        if lat is None or lon is None:
            continue
        facilities.append(
            {
                "id": f'{element.get("type", "object")}/{element.get("id", "")}',
                "name": tags.get("name", "Unnamed health facility"),
                "latitude": lat,
                "longitude": lon,
                "facility_type": tags.get("healthcare") or tags.get("amenity") or "health facility",
                "emergency": tags.get("emergency", "unknown"),
                "phone": tags.get("phone") or tags.get("contact:phone"),
                "website": tags.get("website") or tags.get("contact:website"),
                "source": "OpenStreetMap contributors",
            }
        )
    return facilities


@app.on_event("startup")
def initialize() -> None:
    _initialize_database()


@app.get("/", include_in_schema=False)
def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/sw.js", include_in_schema=False)
def service_worker() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-cache",
        },
    )


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "mode": "simulation"}


@app.get("/api/auth/config")
def firebase_auth_config() -> dict:
    return _firebase_web_config()


@app.get("/api/incidents")
def list_incidents(limit: int = Query(default=50, ge=1, le=100)) -> list[dict]:
    with _connect() as connection:
        rows = connection.execute(
            "SELECT * FROM incidents ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_incident_dict(row) for row in rows]


@app.post("/api/incidents", status_code=201)
def create_incident(payload: IncidentCreate) -> dict:
    captured_at = payload.location_captured_at
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    now = _now()
    if captured_at > now + timedelta(minutes=1):
        raise HTTPException(status_code=422, detail="Location timestamp is in the future.")

    incident_id = str(uuid.uuid4())
    with _connect() as connection:
        inserted = connection.execute(
            """
            INSERT OR IGNORE INTO incidents (
                id, request_key, source, status, latitude, longitude, accuracy_m,
                location_captured_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
            """,
            (
                incident_id,
                payload.request_key,
                payload.source,
                payload.latitude,
                payload.longitude,
                payload.accuracy_m,
                captured_at.astimezone(timezone.utc).isoformat(),
                now.isoformat(),
                now.isoformat(),
            ),
        ).rowcount == 1
        if inserted and payload.share_patient_details and payload.patient_details:
            details = payload.patient_details.model_dump()
            connection.execute(
                """
                INSERT INTO incident_patient_details (
                    incident_id, name, blood_group, allergies, conditions,
                    medicines, contact_name, contact_phone, shared_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    incident_id,
                    details["name"].strip(),
                    details["blood_group"].strip(),
                    details["allergies"].strip(),
                    details["conditions"].strip(),
                    details["medicines"].strip(),
                    details["contact_name"].strip(),
                    details["contact_phone"].strip(),
                    now.isoformat(),
                ),
            )
        row = connection.execute(
            "SELECT * FROM incidents WHERE request_key = ?",
            (payload.request_key,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Incident could not be saved.")
    result = _incident_dict(row)
    result["simulation_notice"] = (
        "Simulated only. No contacts or emergency services were notified."
    )
    result["patient_details_shared"] = bool(
        payload.share_patient_details and payload.patient_details
    ) if inserted else False
    return result


@app.get("/api/dispatch/incidents")
def dispatch_incidents(identity: dict = Depends(firebase_identity)) -> list[dict]:
    _require_role(identity, "dispatcher")
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT i.id, i.source, i.status, i.latitude, i.longitude, i.created_at,
                   CASE WHEN d.incident_id IS NULL THEN 0 ELSE 1 END AS has_patient_details,
                   a.medic_uid
            FROM incidents AS i
            LEFT JOIN incident_patient_details AS d ON d.incident_id = i.id
            LEFT JOIN incident_assignments AS a ON a.incident_id = i.id
            WHERE i.status IN ('active', 'acknowledged')
            ORDER BY i.created_at DESC
            LIMIT 100
            """
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/incidents/{incident_id}/assign")
def assign_incident(
    incident_id: str,
    payload: IncidentAssignment,
    identity: dict = Depends(firebase_identity),
) -> dict:
    _require_role(identity, "dispatcher")
    medic_uid = payload.medic_uid.strip()
    if not medic_uid:
        raise HTTPException(status_code=422, detail="A medic Firebase UID is required.")
    with _connect() as connection:
        row = connection.execute(
            "SELECT status FROM incidents WHERE id = ?", (incident_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Incident not found.")
        if row["status"] not in ("active", "acknowledged"):
            raise HTTPException(status_code=409, detail="Only active incidents can be assigned.")
        connection.execute(
            """
            INSERT INTO incident_assignments (incident_id, medic_uid, assigned_at)
            VALUES (?, ?, ?)
            ON CONFLICT(incident_id) DO UPDATE SET
                medic_uid = excluded.medic_uid,
                assigned_at = excluded.assigned_at
            """,
            (incident_id, medic_uid, _now().isoformat()),
        )
    return {"incident_id": incident_id, "medic_uid": medic_uid, "assigned": True}


@app.get("/api/medic/incidents")
def medic_incidents(identity: dict = Depends(firebase_identity)) -> list[dict]:
    _require_role(identity, "medic")
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT i.id, i.source, i.status, i.latitude, i.longitude, i.created_at,
                   i.location_captured_at,
                   d.name, d.blood_group, d.allergies, d.conditions, d.medicines,
                   d.contact_name, d.contact_phone, d.shared_at
            FROM incident_assignments AS a
            JOIN incidents AS i ON i.id = a.incident_id
            LEFT JOIN incident_patient_details AS d ON d.incident_id = i.id
            WHERE a.medic_uid = ? AND i.status IN ('active', 'acknowledged')
            ORDER BY i.created_at DESC
            LIMIT 100
            """,
            (identity["uid"],),
        ).fetchall()
    incidents: list[dict] = []
    for row in rows:
        item = {
            "id": row["id"],
            "source": row["source"],
            "status": row["status"],
            "latitude": row["latitude"],
            "longitude": row["longitude"],
            "created_at": row["created_at"],
            "location_captured_at": row["location_captured_at"],
            "patient_details": None,
        }
        if row["shared_at"]:
            item["patient_details"] = {
                "name": row["name"],
                "blood_group": row["blood_group"],
                "allergies": row["allergies"],
                "conditions": row["conditions"],
                "medicines": row["medicines"],
                "contact_name": row["contact_name"],
                "contact_phone": row["contact_phone"],
                "shared_at": row["shared_at"],
            }
        incidents.append(item)
    return incidents


@app.post("/api/medic/incidents/{incident_id}/resolve")
def medic_resolve_incident(
    incident_id: str,
    identity: dict = Depends(firebase_identity),
) -> dict:
    _require_role(identity, "medic")
    now = _now().isoformat()
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT i.status
            FROM incidents AS i
            JOIN incident_assignments AS a ON a.incident_id = i.id
            WHERE i.id = ? AND a.medic_uid = ?
            """,
            (incident_id, identity["uid"]),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Assigned incident not found.")
        if row["status"] not in ("active", "acknowledged"):
            raise HTTPException(status_code=409, detail="Incident is no longer active.")
        connection.execute(
            "UPDATE incidents SET status = 'resolved', updated_at = ? WHERE id = ?",
            (now, incident_id),
        )
        connection.execute(
            "DELETE FROM incident_patient_details WHERE incident_id = ?",
            (incident_id,),
        )
        connection.execute(
            "DELETE FROM incident_assignments WHERE incident_id = ?",
            (incident_id,),
        )
    return {"incident_id": incident_id, "status": "resolved"}


@app.post("/api/incidents/{incident_id}/acknowledge")
def acknowledge_incident(incident_id: str) -> dict:
    with _connect() as connection:
        row = connection.execute(
            "SELECT * FROM incidents WHERE id = ?", (incident_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Incident not found.")
        if row["status"] == "acknowledged":
            return _incident_dict(row)
        if row["status"] != "active":
            raise HTTPException(status_code=409, detail="Incident is no longer active.")
        connection.execute(
            "UPDATE incidents SET status = 'acknowledged', updated_at = ? WHERE id = ?",
            (_now().isoformat(), incident_id),
        )
        updated = connection.execute(
            "SELECT * FROM incidents WHERE id = ?", (incident_id,)
        ).fetchone()
    return _incident_dict(updated)


@app.post("/api/incidents/{incident_id}/resolve")
def resolve_incident(incident_id: str, payload: Resolution) -> dict:
    with _connect() as connection:
        row = connection.execute(
            "SELECT * FROM incidents WHERE id = ?", (incident_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Incident not found.")
        if row["status"] == "resolved":
            return _incident_dict(row)
        if row["status"] not in ("active", "acknowledged"):
            raise HTTPException(status_code=409, detail="Incident cannot be resolved.")
        connection.execute(
            """
            UPDATE incidents
            SET status = 'resolved', updated_at = ?, resolution_note = ?
            WHERE id = ?
            """,
            (_now().isoformat(), payload.note.strip(), incident_id),
        )
        connection.execute(
            "DELETE FROM incident_patient_details WHERE incident_id = ?",
            (incident_id,),
        )
        connection.execute(
            "DELETE FROM incident_assignments WHERE incident_id = ?",
            (incident_id,),
        )
        updated = connection.execute(
            "SELECT * FROM incidents WHERE id = ?", (incident_id,)
        ).fetchone()
    return _incident_dict(updated)


@app.post("/api/incidents/{incident_id}/cancel")
def cancel_incident(incident_id: str) -> dict:
    with _connect() as connection:
        row = connection.execute(
            "SELECT * FROM incidents WHERE id = ?", (incident_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Incident not found.")
        if row["status"] == "cancelled":
            return _incident_dict(row)
        if row["status"] != "active":
            raise HTTPException(status_code=409, detail="Incident can no longer be cancelled.")
        connection.execute(
            "UPDATE incidents SET status = 'cancelled', updated_at = ? WHERE id = ?",
            (_now().isoformat(), incident_id),
        )
        connection.execute(
            "DELETE FROM incident_patient_details WHERE incident_id = ?",
            (incident_id,),
        )
        connection.execute(
            "DELETE FROM incident_assignments WHERE incident_id = ?",
            (incident_id,),
        )
        updated = connection.execute(
            "SELECT * FROM incidents WHERE id = ?", (incident_id,)
        ).fetchone()
    return _incident_dict(updated)


@app.get("/api/facilities/nearby")
def nearby_facilities(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
    radius_m: int = Query(default=10_000, ge=500, le=20_000),
) -> dict:
    key = (round(latitude, 4), round(longitude, 4), radius_m)
    now = _now()
    cached = FACILITY_CACHE.get(key)
    if cached and now - cached[0] < timedelta(seconds=FACILITY_CACHE_SECONDS):
        facilities = cached[1]
    else:
        facilities = _fetch_facilities(latitude, longitude, radius_m)
        FACILITY_CACHE[key] = (now, facilities)
    return {
        "facilities": facilities,
        "source": "OpenStreetMap contributors",
        "verified": False,
        "notice": (
            "Map data may be incomplete or out of date. Call the facility directly "
            "to verify emergency services; this app does not contact it."
        ),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
