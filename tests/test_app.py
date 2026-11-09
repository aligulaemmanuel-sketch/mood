import tempfile
import unittest
from datetime import datetime, timezone
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

from google.auth.exceptions import DefaultCredentialsError
from fastapi.testclient import TestClient

import app as emergency_app


class MemoryDatabaseReference:
    def __init__(self, data, path=()):
        self.data = data
        self.path = path

    def child(self, key):
        return MemoryDatabaseReference(self.data, (*self.path, key))

    def _parent_and_key(self):
        parent = self.data
        for key in self.path[:-1]:
            parent = parent.setdefault(key, {})
        return parent, self.path[-1] if self.path else None

    def get(self):
        value = self.data
        for key in self.path:
            if not isinstance(value, dict):
                return None
            value = value.get(key)
        return value

    def update(self, values):
        current = self.get()
        if not isinstance(current, dict):
            current = {}
            parent, key = self._parent_and_key()
            parent[key] = current
        current.update(values)

    def transaction(self, update_fn):
        current = self.get()
        updated = update_fn(current)
        parent, key = self._parent_and_key()
        parent[key] = updated
        return updated


class EmergencyAppTests(unittest.TestCase):
    def setUp(self):
        self.firebase_url_patcher = patch.dict(os.environ, {"FIREBASE_DATABASE_URL": ""})
        self.firebase_url_patcher.start()
        self.addCleanup(self.firebase_url_patcher.stop)
        self.temp_dir = tempfile.TemporaryDirectory()
        emergency_app.DATABASE_PATH = Path(self.temp_dir.name) / "incidents.sqlite3"
        emergency_app._initialize_database()
        emergency_app.FACILITY_CACHE.clear()
        self.firebase_data = {}
        self.firebase_reference_patcher = patch.object(
            emergency_app,
            "_firebase_realtime_database_reference",
            return_value=MemoryDatabaseReference(self.firebase_data),
        )
        self.firebase_reference_patcher.start()
        self.addCleanup(self.firebase_reference_patcher.stop)
        self.client = TestClient(emergency_app.app)

    def tearDown(self):
        self.client.close()
        self.temp_dir.cleanup()

    def create_incident(self, **overrides):
        payload = {
            "request_key": "test-key-0001",
            "source": "manual_sos",
            "latitude": -1.2864,
            "longitude": 36.8172,
            "accuracy_m": 12,
            "location_captured_at": datetime.now(timezone.utc).isoformat(),
        }
        payload.update(overrides)
        return self.client.post("/api/incidents", json=payload)

    def auth_headers(self, token="test-token"):
        return {"Authorization": f"Bearer {token}"}

    def test_health_is_simulation_only(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mode"], "simulation")
        self.assertTrue(response.json()["database"]["ready"])
        self.assertIn("incidents.sqlite3", response.json()["database"]["path"])
        self.assertIn("firebase", response.json())
        self.assertIn("database", response.json()["firebase"])
        self.assertEqual(
            response.json()["firebase"]["database"]["type"], "realtime_database"
        )
        self.assertFalse(response.json()["firebase"]["database"]["enabled"])

    def test_health_reports_realtime_database_as_primary_when_configured(self):
        with patch.dict(
            "os.environ",
            {"FIREBASE_DATABASE_URL": "https://example-default-rtdb.firebaseio.com"},
        ):
            response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["database"]["primary"], "firebase_realtime_database"
        )
        self.assertTrue(response.json()["firebase"]["database"]["ready"])

    def test_service_worker_is_available_for_root_scope(self):
        response = self.client.get("/sw.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["service-worker-allowed"], "/")
        self.assertEqual(response.headers["cache-control"], "no-cache")
        self.assertIn("addAll(APP_SHELL)", response.text)
        self.assertIn("beacon-kenya-shell-v8", response.text)
        self.assertIn("/static/aid-fire.svg", response.text)
        self.assertEqual(self.client.get("/static/aid-fire.svg").status_code, 200)

    def test_homepage_uses_live_location_and_keeps_alerts_simulation_only(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("KENYA · LIVE MAP", response.text)
        self.assertIn('href="tel:999"', response.text)
        self.assertIn("Skip to main content", response.text)
        self.assertIn("Use current location", response.text)
        self.assertIn("Search nearby", response.text)
        self.assertIn("SIMULATED · NO REAL ALERT", response.text)
        self.assertNotIn("demoLocationButton", response.text)
        self.assertNotIn("Demo routes", response.text)
        self.assertNotIn("Major Nairobi hospitals", response.text)

    def test_create_incident_and_idempotent_retry(self):
        first = self.create_incident()
        second = self.create_incident()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(
            first.json()["simulation_notice"],
            "Simulated only. No contacts or emergency services were notified.",
        )
        self.assertEqual(len(self.client.get("/api/incidents").json()), 1)

    def test_realtime_database_is_primary_for_incident_lifecycle(self):
        with patch.dict(
            "os.environ",
            {"FIREBASE_DATABASE_URL": "https://example-default-rtdb.firebaseio.com"},
        ):
            created = self.create_incident(
                share_patient_details=True,
                patient_details={"name": "Synthetic Patient"},
            )
            incident = created.json()
            incident_id = incident["id"]

            repeated = self.create_incident(
                share_patient_details=True,
                patient_details={"name": "Different Patient"},
            )
            self.assertEqual(repeated.json()["id"], incident_id)
            self.assertFalse(repeated.json()["patient_details_shared"])

            self.assertEqual(
                self.client.get("/api/incidents").json()[0]["id"], incident_id
            )
            acknowledged = self.client.post(
                f"/api/incidents/{incident_id}/acknowledge"
            )
            self.assertEqual(acknowledged.json()["status"], "acknowledged")
            resolved = self.client.post(
                f"/api/incidents/{incident_id}/resolve",
                json={"note": "Private resolution note"},
            )
            self.assertEqual(resolved.json()["status"], "resolved")

        stored = self.firebase_data["incidents"][incident_id]
        self.assertEqual(stored["status"], "resolved")
        self.assertNotIn("patient_details", stored)
        self.assertNotIn("resolution_note", stored)

    def test_firebase_primary_dispatcher_assignment_and_medic_resolution(self):
        with patch.dict(
            "os.environ",
            {"FIREBASE_DATABASE_URL": "https://example-default-rtdb.firebaseio.com"},
        ):
            incident_id = self.create_incident().json()["id"]
            with patch.object(
                emergency_app,
                "_verify_firebase_id_token",
                return_value={"uid": "dispatcher-1", "role": "dispatcher"},
            ):
                assigned = self.client.post(
                    f"/api/incidents/{incident_id}/assign",
                    headers=self.auth_headers(),
                    json={"medic_uid": "medic-1"},
                )
                self.assertEqual(assigned.status_code, 200)

            with patch.object(
                emergency_app,
                "_verify_firebase_id_token",
                return_value={"uid": "medic-1", "role": "medic"},
            ):
                medic_incidents = self.client.get(
                    "/api/medic/incidents", headers=self.auth_headers()
                )
                self.assertEqual(medic_incidents.status_code, 200)
                self.assertEqual(medic_incidents.json()[0]["id"], incident_id)
                resolved = self.client.post(
                    f"/api/medic/incidents/{incident_id}/resolve",
                    headers=self.auth_headers(),
                )
                self.assertEqual(resolved.status_code, 200)

        stored = self.firebase_data["incidents"][incident_id]
        self.assertEqual(stored["status"], "resolved")
        self.assertIsNone(stored["medic_uid"])

    def test_firebase_primary_failure_does_not_fall_back_to_sqlite(self):
        broken_reference = MagicMock()
        broken_reference.child.return_value.get.side_effect = OSError(
            "database unavailable"
        )
        with patch.dict(
            "os.environ",
            {"FIREBASE_DATABASE_URL": "https://example-default-rtdb.firebaseio.com"},
        ):
            with patch.object(
                emergency_app,
                "_firebase_realtime_database_reference",
                return_value=broken_reference,
            ):
                response = self.client.get("/api/incidents")
        self.assertEqual(response.status_code, 503)
        with emergency_app._connect() as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM incidents"
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_patient_details_require_explicit_consent(self):
        rejected = self.create_incident(
            patient_details={"name": "Synthetic Patient"},
        )
        self.assertEqual(rejected.status_code, 422)

        created = self.create_incident(
            request_key="test-key-consent",
            share_patient_details=True,
            patient_details={
                "name": "Synthetic Patient",
                "blood_group": "O+",
                "allergies": "Synthetic allergy",
            },
        )
        self.assertEqual(created.status_code, 201)
        self.assertTrue(created.json()["patient_details_shared"])
        self.assertNotIn("Synthetic Patient", created.text)
        self.assertNotIn("patient_details", self.client.get("/api/incidents").json()[0])

    def test_patient_details_can_be_disabled_for_ephemeral_deployments(self):
        with patch.dict(os.environ, {"PATIENT_DETAILS_ENABLED": "false"}):
            health = self.client.get("/api/health")
            rejected = self.create_incident(
                request_key="test-key-no-patient-details",
                share_patient_details=True,
                patient_details={"name": "Synthetic Patient"},
            )

        self.assertFalse(health.json()["patient_details"]["enabled"])
        self.assertEqual(rejected.status_code, 403)
        with emergency_app._connect() as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM incident_patient_details"
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_only_assigned_medic_can_view_consented_details_and_close_deletes_them(self):
        incident_id = self.create_incident(
            request_key="test-key-assigned",
            share_patient_details=True,
            patient_details={
                "name": "Synthetic Patient",
                "blood_group": "O+",
                "allergies": "Synthetic allergy",
            },
        ).json()["id"]

        self.assertEqual(self.client.get("/api/medic/incidents").status_code, 401)

        with patch.object(
            emergency_app,
            "_verify_firebase_id_token",
            return_value={"uid": "medic-1", "role": "medic"},
        ):
            unassigned = self.client.get(
                "/api/medic/incidents", headers=self.auth_headers()
            )
            self.assertEqual(unassigned.status_code, 200)
            self.assertEqual(unassigned.json(), [])

        with patch.object(
            emergency_app,
            "_verify_firebase_id_token",
            return_value={"uid": "medic-1", "role": "medic"},
        ):
            forbidden_assignment = self.client.post(
                f"/api/incidents/{incident_id}/assign",
                headers=self.auth_headers(),
                json={"medic_uid": "medic-1"},
            )
            self.assertEqual(forbidden_assignment.status_code, 403)

        with patch.object(
            emergency_app,
            "_verify_firebase_id_token",
            return_value={"uid": "dispatcher-1", "role": "dispatcher"},
        ):
            assigned = self.client.post(
                f"/api/incidents/{incident_id}/assign",
                headers=self.auth_headers(),
                json={"medic_uid": "medic-1"},
            )
            self.assertEqual(assigned.status_code, 200)

        with patch.object(
            emergency_app,
            "_verify_firebase_id_token",
            return_value={"uid": "medic-2", "role": "medic"},
        ):
            other_medic = self.client.get(
                "/api/medic/incidents", headers=self.auth_headers()
            )
            self.assertEqual(other_medic.json(), [])

        with patch.object(
            emergency_app,
            "_verify_firebase_id_token",
            return_value={"uid": "medic-1", "role": "medic"},
        ):
            visible = self.client.get(
                "/api/medic/incidents", headers=self.auth_headers()
            )
            self.assertEqual(visible.status_code, 200)
            self.assertEqual(
                visible.json()[0]["patient_details"]["name"], "Synthetic Patient"
            )

        with patch.object(
            emergency_app,
            "_verify_firebase_id_token",
            return_value={"uid": "medic-2", "role": "medic"},
        ):
            forbidden_resolution = self.client.post(
                f"/api/medic/incidents/{incident_id}/resolve",
                headers=self.auth_headers(),
            )
            self.assertEqual(forbidden_resolution.status_code, 404)

        with patch.object(
            emergency_app,
            "_verify_firebase_id_token",
            return_value={"uid": "medic-1", "role": "medic"},
        ):
            resolved = self.client.post(
                f"/api/medic/incidents/{incident_id}/resolve",
                headers=self.auth_headers(),
            )
            self.assertEqual(resolved.status_code, 200)
            self.assertEqual(resolved.json()["status"], "resolved")

        with emergency_app._connect() as connection:
            remaining_details = connection.execute(
                "SELECT COUNT(*) FROM incident_patient_details WHERE incident_id = ?",
                (incident_id,),
            ).fetchone()[0]
            remaining_assignment = connection.execute(
                "SELECT COUNT(*) FROM incident_assignments WHERE incident_id = ?",
                (incident_id,),
            ).fetchone()[0]
        self.assertEqual(remaining_details, 0)
        self.assertEqual(remaining_assignment, 0)

    def test_firebase_initialization_failure_returns_service_unavailable(self):
        import firebase_admin

        with (
            patch.object(
                emergency_app,
                "_firebase_web_config",
                return_value={"enabled": True},
            ),
            patch.dict("os.environ", {"FIREBASE_PROJECT_ID": "demo-project"}),
            patch.object(firebase_admin, "get_app", side_effect=ValueError("not initialized")),
            patch.object(
                firebase_admin,
                "initialize_app",
                side_effect=DefaultCredentialsError("credentials unavailable"),
            ),
        ):
            response = self.client.get(
                "/api/medic/incidents", headers=self.auth_headers()
            )
        self.assertEqual(response.status_code, 503)
        self.assertIn("Firebase Admin", response.json()["detail"])

    def test_firebase_web_config_is_disabled_without_project_settings(self):
        with patch.object(
            emergency_app, "_firebase_web_config", return_value={"enabled": False}
        ):
            response = self.client.get("/api/auth/config")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["enabled"])

    def test_rejects_invalid_coordinates_and_future_time(self):
        invalid_location = self.create_incident(latitude=91)
        future_time = self.create_incident(
            request_key="test-key-0002",
            location_captured_at="2999-01-01T00:00:00+00:00",
        )
        self.assertEqual(invalid_location.status_code, 422)
        self.assertEqual(future_time.status_code, 422)

    def test_acknowledge_resolve_and_reject_post_resolution_ack(self):
        created = self.create_incident().json()
        incident_id = created["id"]
        acknowledged = self.client.post(
            f"/api/incidents/{incident_id}/acknowledge"
        )
        repeated_ack = self.client.post(
            f"/api/incidents/{incident_id}/acknowledge"
        )
        resolved = self.client.post(
            f"/api/incidents/{incident_id}/resolve",
            json={"note": "Test completed."},
        )
        rejected_ack = self.client.post(
            f"/api/incidents/{incident_id}/acknowledge"
        )
        self.assertEqual(acknowledged.json()["status"], "acknowledged")
        self.assertEqual(repeated_ack.json()["status"], "acknowledged")
        self.assertEqual(resolved.json()["status"], "resolved")
        self.assertEqual(resolved.json()["resolution_note"], "Test completed.")
        self.assertEqual(rejected_ack.status_code, 409)

    def test_cancel_active_incident(self):
        incident_id = self.create_incident(
            share_patient_details=True,
            patient_details={"name": "Synthetic Patient"},
        ).json()["id"]
        with patch.object(
            emergency_app,
            "_verify_firebase_id_token",
            return_value={"uid": "dispatcher-1", "role": "dispatcher"},
        ):
            assigned = self.client.post(
                f"/api/incidents/{incident_id}/assign",
                headers=self.auth_headers(),
                json={"medic_uid": "medic-1"},
            )
        self.assertEqual(assigned.status_code, 200)

        cancelled = self.client.post(f"/api/incidents/{incident_id}/cancel")
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.json()["status"], "cancelled")
        with emergency_app._connect() as connection:
            remaining_details = connection.execute(
                "SELECT COUNT(*) FROM incident_patient_details WHERE incident_id = ?",
                (incident_id,),
            ).fetchone()[0]
            remaining_assignment = connection.execute(
                "SELECT COUNT(*) FROM incident_assignments WHERE incident_id = ?",
                (incident_id,),
            ).fetchone()[0]
        self.assertEqual(remaining_details, 0)
        self.assertEqual(remaining_assignment, 0)
        self.assertEqual(
            self.client.post(f"/api/incidents/{incident_id}/resolve", json={}).status_code,
            409,
        )

    def test_facility_search_is_bounded_and_marked_unverified(self):
        mock_facilities = [{
            "id": "node/1",
            "name": "Demo Hospital",
            "latitude": -1.28,
            "longitude": 36.82,
            "facility_type": "hospital",
            "emergency": "unknown",
            "phone": None,
            "website": None,
            "source": "OpenStreetMap contributors",
        }]
        with patch.object(emergency_app, "_fetch_facilities", return_value=mock_facilities):
            response = self.client.get(
                "/api/facilities/nearby?latitude=-1.28&longitude=36.82&radius_m=5000"
            )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["verified"])
        self.assertEqual(response.json()["facilities"][0]["name"], "Demo Hospital")
        self.assertEqual(
            response.json()["facilities"][0]["facility_type"], "hospital"
        )
        invalid_radius = self.client.get(
            "/api/facilities/nearby?latitude=0&longitude=0&radius_m=50000"
        )
        self.assertEqual(invalid_radius.status_code, 422)


if __name__ == "__main__":
    unittest.main()
