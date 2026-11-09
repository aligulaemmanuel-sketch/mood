(() => {
  "use strict";

  const MEDICAL_ID_STORAGE_KEY = "beacon-kenya-medical-id-v1";
  const THEME_STORAGE_KEY = "beacon-kenya-theme";
  const TEXT_SIZE_STORAGE_KEY = "beacon-kenya-text-size";
  const $ = (id) => document.getElementById(id);
  const state = {
    location: null,
    map: null,
    userMarker: null,
    facilityLayer: null,
    countdownTimer: null,
    countdownRemaining: 10,
    requestKey: null,
    toastTimer: null,
    facilities: null,
    incidents: [],
    incidentsLoaded: false,
    firebaseAuth: null,
    firebaseUser: null,
    firebaseRoles: [],
    medicRefreshTimer: null,
    backendAvailable: true,
  };

  function updateDashboardInsights() {
    const nearbyCount = state.facilities?.length;
    const nearbyValue = $("nearbyFacilitiesValue");
    const nearbyCaption = $("nearbyFacilitiesCaption");
    const nearbyAccessible = $("nearbyFacilitiesAccessible");
    const activeCount = state.incidents.filter((incident) =>
      ["active", "acknowledged"].includes(incident.status),
    ).length;
    const searchStatus = !navigator.onLine
      ? ["OFFLINE", "Reconnect to search nearby listings"]
      : state.location
        ? ["READY", "Location set · search when you are ready"]
        : ["SET LOCATION", "GPS is requested only when you choose"];

    nearbyValue.textContent = nearbyCount == null ? "—" : String(nearbyCount);
    nearbyCaption.textContent = nearbyCount == null
      ? state.location ? "Search within 10 km to see listings" : "Search after setting your location"
      : `${nearbyCount === 1 ? "listing" : "listings"} · verify details first`;
    nearbyAccessible.textContent = nearbyCount == null
      ? `Nearby facilities: ${nearbyCaption.textContent}. Activate to flip this card.`
      : `Nearby facilities: ${nearbyCount} ${nearbyCount === 1 ? "listing" : "listings"} found in the last search. Verify details first. Activate to flip this card.`;

    $("activeAlertsValue").textContent = state.incidentsLoaded ? String(activeCount) : "—";
    $("activeAlertsCaption").textContent = !state.incidentsLoaded
      ? "Loading local queue…"
      : activeCount
        ? `${activeCount === 1 ? "Simulation" : "Simulations"} · local queue only`
        : "Local simulations only";
    $("activeAlertsAccessible").textContent = state.incidentsLoaded
      ? `Active test alerts: ${activeCount}. Local simulations only. Activate to flip this card.`
      : "Active test alerts: loading the local queue. Activate to flip this card.";

    $("searchStatusValue").textContent = searchStatus[0];
    $("searchStatusCaption").textContent = searchStatus[1];
    $("searchStatusAccessible").textContent =
      `Search status: ${searchStatus[0].toLowerCase()}. ${searchStatus[1]}. Activate to flip this card.`;
  }

  const insightCards = [...document.querySelectorAll("[data-insight-card]")];
  const insightSection = $("dashboardInsights");
  let insightRotationTimer = null;
  let insightRotationIndex = 0;
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  function stopInsightRotation() {
    window.clearInterval(insightRotationTimer);
    insightRotationTimer = null;
  }

  function startInsightRotation() {
    stopInsightRotation();
    if (reducedMotionQuery.matches || document.hidden
      || insightSection.matches(":hover") || insightSection.contains(document.activeElement)) return;
    insightRotationTimer = window.setInterval(() => {
      const card = insightCards[insightRotationIndex];
      card.classList.toggle("is-flipped");
      card.setAttribute("aria-pressed", String(card.classList.contains("is-flipped")));
      insightRotationIndex = (insightRotationIndex + 1) % insightCards.length;
    }, 5000);
  }

  insightSection.addEventListener("click", (event) => {
    const card = event.target.closest("[data-insight-card]");
    if (!card) return;
    card.classList.toggle("is-flipped");
    card.setAttribute("aria-pressed", String(card.classList.contains("is-flipped")));
  });
  insightSection.addEventListener("pointerenter", stopInsightRotation);
  insightSection.addEventListener("pointerleave", startInsightRotation);
  insightSection.addEventListener("focusin", stopInsightRotation);
  insightSection.addEventListener("focusout", (event) => {
    if (!insightSection.contains(event.relatedTarget)) startInsightRotation();
  });
  document.addEventListener("visibilitychange", startInsightRotation);
  reducedMotionQuery.addEventListener("change", startInsightRotation);
  startInsightRotation();

  function showToast(message, isError = false) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.toggle("is-error", isError);
    toast.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 5000);
  }

  function applyTheme(theme) {
    const isLight = theme === "light";
    document.documentElement.dataset.theme = isLight ? "light" : "dark";
    $("themeToggle").textContent = isLight ? "☾" : "☀";
    $("themeToggle").setAttribute("aria-label", `Switch to ${isLight ? "dark" : "light"} mode`);
    $("themeToggle").title = `Switch to ${isLight ? "dark" : "light"} mode`;
    $("themeToggle").setAttribute("aria-pressed", String(isLight));
    document.querySelector('meta[name="theme-color"]').content = isLight ? "#f5f8fa" : "#070b16";
  }

  function initializeTheme() {
    let theme = "dark";
    try {
      const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme === "light" || savedTheme === "dark") theme = savedTheme;
    } catch {
      showToast("Theme preference storage is unavailable; using dark mode for this visit.", true);
    }
    applyTheme(theme);
  }

  $("themeToggle").addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(nextTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      showToast("Theme changed, but this browser could not save your preference.", true);
    }
  });

  function initializeTextSize() {
    let large = false;
    try {
      large = localStorage.getItem(TEXT_SIZE_STORAGE_KEY) === "large";
    } catch {
      showToast("Text-size preference storage is unavailable; using standard size.", true);
    }
    applyTextSize(large);
  }

  function applyTextSize(large) {
    if (large) document.documentElement.dataset.textSize = "large";
    else delete document.documentElement.dataset.textSize;
    $("textSizeToggle").setAttribute("aria-pressed", String(large));
    $("textSizeToggle").setAttribute("aria-label", large ? "Use standard text size" : "Use larger text");
    $("textSizeToggle").title = large ? "Use standard text size" : "Use larger text";
    $("textSizeToggle").textContent = large ? "A−" : "A+";
  }

  $("textSizeToggle").addEventListener("click", () => {
    const large = document.documentElement.dataset.textSize !== "large";
    applyTextSize(large);
    try {
      localStorage.setItem(TEXT_SIZE_STORAGE_KEY, large ? "large" : "standard");
    } catch {
      showToast("Text size changed, but this browser could not save your preference.", true);
    }
  });

  function updateConnectivity() {
    const offline = !navigator.onLine;
    const notice = $("connectionNotice");
    $("environmentLabel").textContent = offline ? "KENYA · OFFLINE" : "KENYA · LIVE MAP";
    notice.hidden = !offline;
    const backendBlocked = !state.backendAvailable;
    $("searchFacilitiesButton").disabled = offline || backendBlocked || !state.location;
    if (offline) {
      $("facilitySubheading").textContent = "Offline · map and facility search unavailable";
    } else if (backendBlocked) {
      $("facilitySubheading").textContent = "Backend unavailable · retry connection to search again";
    } else if (state.location) {
      $("facilitySubheading").textContent = `Ready to search within 10 km · ${$("locationText").textContent}`;
    }
    updateDashboardInsights();
  }

  window.addEventListener("online", updateConnectivity);
  window.addEventListener("offline", updateConnectivity);
  updateConnectivity();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js")
      .catch(() => showToast("Offline first-aid caching could not be enabled in this browser.", true));
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `Request failed (${response.status}).`);
    return body;
  }

  function loadFirebaseScript(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Firebase sign-in library could not be loaded."));
      document.head.appendChild(script);
    });
  }

  async function medicApi(path, options = {}) {
    if (!state.firebaseUser) throw new Error("Sign in to continue.");
    const token = await state.firebaseUser.getIdToken();
    return api(path, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
  }

  function setMedicStatus(message, isError = false) {
    $("medicAuthStatus").textContent = message;
    $("medicAuthStatus").classList.toggle("is-error", isError);
  }

  function isFirebaseRole(claims, role) {
    return claims.role === role || (Array.isArray(claims.roles) && claims.roles.includes(role));
  }

  function renderMedicIncidents(incidents) {
    const list = $("medicIncidentList");
    if (!incidents.length) {
      list.innerHTML = '<div class="empty-facilities"><p>No active incidents are assigned to your account.</p></div>';
      return;
    }
    list.innerHTML = incidents.map((incident) => {
      const details = incident.patient_details;
      const patientFields = details
        ? [
          ["Name", details.name],
          ["Blood group", details.blood_group],
          ["Allergies", details.allergies],
          ["Conditions", details.conditions],
          ["Medicines", details.medicines],
          ["Emergency contact", [details.contact_name, details.contact_phone].filter(Boolean).join(" · ")],
        ].filter(([, value]) => value)
          .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
          .join("")
        : "<p>Patient did not share a medical ID for this incident.</p>";
      const mapUrl = new URL("https://www.openstreetmap.org/");
      mapUrl.searchParams.set("mlat", String(incident.latitude));
      mapUrl.searchParams.set("mlon", String(incident.longitude));
      mapUrl.hash = `map=16/${incident.latitude}/${incident.longitude}`;
      const title = incident.source === "simulated_crash" ? "Simulated crash" : "Test SOS";
      return `<article class="medic-incident-card">
        <div class="medic-incident-heading">
          <strong>${title}</strong>
          <span class="status-pill status-${escapeHtml(incident.status)}">${escapeHtml(incident.status)}</span>
        </div>
        <p>Created ${escapeHtml(formatTime(incident.created_at))}</p>
        <a href="${escapeHtml(mapUrl.href)}" target="_blank" rel="noopener noreferrer">Open incident location ↗</a>
        <dl>${patientFields}</dl>
        <button class="incident-action resolve" type="button" data-medic-resolve="${escapeHtml(incident.id)}">Mark resolved &amp; delete shared details</button>
      </article>`;
    }).join("");
  }

  async function refreshMedicIncidents() {
    if (!state.firebaseUser || !state.firebaseRoles.includes("medic")) return;
    $("medicIncidentList").innerHTML = '<p>Loading assigned incidents…</p>';
    try {
      renderMedicIncidents(await medicApi("/api/medic/incidents"));
      setMedicStatus("Signed in. Patient details are limited to incidents assigned to your account.");
    } catch (error) {
      $("medicIncidentList").replaceChildren();
      setMedicStatus(error.message, true);
    }
  }

  async function refreshDispatchIncidents() {
    if (!state.firebaseUser || !state.firebaseRoles.includes("dispatcher")) return;
    const select = $("dispatchIncidentSelect");
    select.replaceChildren();
    try {
      const incidents = await medicApi("/api/dispatch/incidents");
      for (const incident of incidents) {
        const option = document.createElement("option");
        option.value = incident.id;
        option.textContent = `${incident.id.slice(0, 8)} · ${incident.status} · ${incident.has_patient_details ? "patient details shared" : "no details shared"} · ${formatTime(incident.created_at)}`;
        select.appendChild(option);
      }
      if (!incidents.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No active incidents";
        select.appendChild(option);
      }
      $("assignIncidentButton").disabled = incidents.length === 0;
    } catch (error) {
      setMedicStatus(error.message, true);
    }
  }

  async function initializeMedicAuth() {
    try {
      const config = await api("/api/auth/config");
      if (!config.enabled) {
        setMedicStatus("Medic sign-in is not configured. See the Firebase setup in README.", true);
        return;
      }
      const version = "10.14.1";
      await loadFirebaseScript(`https://www.gstatic.com/firebasejs/${version}/firebase-app-compat.js`);
      await loadFirebaseScript(`https://www.gstatic.com/firebasejs/${version}/firebase-auth-compat.js`);
      if (!window.firebase) throw new Error("Firebase sign-in library did not initialize.");
      if (!window.firebase.apps.length) {
        window.firebase.initializeApp({
          apiKey: config.apiKey,
          authDomain: config.authDomain,
          projectId: config.projectId,
          appId: config.appId,
        });
      }
      state.firebaseAuth = window.firebase.auth();
      await state.firebaseAuth.setPersistence(window.firebase.auth.Auth.Persistence.SESSION);
      $("medicSignInForm").hidden = false;
      state.firebaseAuth.onAuthStateChanged(async (user) => {
        state.firebaseUser = user;
        $("medicSignInForm").hidden = Boolean(user);
        $("medicSession").hidden = !user;
        $("medicIncidentList").replaceChildren();
        $("dispatchAssignmentPanel").hidden = true;
        if (state.medicRefreshTimer) window.clearInterval(state.medicRefreshTimer);
        state.medicRefreshTimer = null;
        if (!user) {
          state.firebaseRoles = [];
          setMedicStatus("Sign in with an account provisioned by an authorized administrator.");
          return;
        }
        $("medicAccountLabel").textContent = user.email || "Signed-in medic";
        try {
          const tokenResult = await user.getIdTokenResult();
          state.firebaseRoles = [];
          if (isFirebaseRole(tokenResult.claims, "medic")) state.firebaseRoles.push("medic");
          if (isFirebaseRole(tokenResult.claims, "dispatcher")) state.firebaseRoles.push("dispatcher");
          if (!state.firebaseRoles.length) {
            await state.firebaseAuth.signOut();
            setMedicStatus("This account has no medic or dispatcher role. Contact your system administrator.", true);
            return;
          }
          setMedicStatus("Checking assigned incidents…");
          if (state.firebaseRoles.includes("medic")) await refreshMedicIncidents();
          if (state.firebaseRoles.includes("dispatcher")) {
            $("dispatchAssignmentPanel").hidden = false;
            await refreshDispatchIncidents();
          }
          state.medicRefreshTimer = window.setInterval(() => {
            refreshMedicIncidents();
            refreshDispatchIncidents();
          }, 30000);
        } catch (error) {
          setMedicStatus(error.message, true);
        }
      });
    } catch (error) {
      setMedicStatus(`Medic sign-in unavailable: ${error.message}`, true);
    }
  }

  $("medicSignInForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.firebaseAuth) return;
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    setMedicStatus("Signing in…");
    try {
      await state.firebaseAuth.signInWithEmailAndPassword(
        $("medicEmail").value.trim(),
        $("medicPassword").value,
      );
      $("medicPassword").value = "";
    } catch {
      setMedicStatus("Sign-in failed. Check your credentials or contact your administrator.", true);
    } finally {
      button.disabled = false;
    }
  });

  $("medicSignOutButton").addEventListener("click", async () => {
    try {
      await state.firebaseAuth?.signOut();
    } catch (error) {
      setMedicStatus(`Could not sign out: ${error.message}`, true);
    }
  });

  $("refreshMedicIncidents").addEventListener("click", async () => {
    await refreshMedicIncidents();
    await refreshDispatchIncidents();
  });

  $("medicIncidentList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-medic-resolve]");
    if (!button) return;
    button.disabled = true;
    try {
      await medicApi(
        `/api/medic/incidents/${encodeURIComponent(button.dataset.medicResolve)}/resolve`,
        { method: "POST" },
      );
      await refreshMedicIncidents();
      await refreshDispatchIncidents();
    } catch (error) {
      setMedicStatus(error.message, true);
      button.disabled = false;
    }
  });

  $("assignIncidentButton").addEventListener("click", async () => {
    const incidentId = $("dispatchIncidentSelect").value;
    const medicUid = $("assignedMedicUid").value.trim();
    if (!incidentId || !medicUid) {
      setMedicStatus("Choose an active incident and enter the medic's Firebase UID.", true);
      return;
    }
    $("assignIncidentButton").disabled = true;
    try {
      await medicApi(`/api/incidents/${encodeURIComponent(incidentId)}/assign`, {
        method: "POST",
        body: JSON.stringify({ medic_uid: medicUid }),
      });
      $("assignedMedicUid").value = "";
      setMedicStatus("Incident assigned. Only that medic account can view its details.");
      await refreshDispatchIncidents();
      await refreshMedicIncidents();
    } catch (error) {
      setMedicStatus(error.message, true);
    } finally {
      $("assignIncidentButton").disabled = false;
    }
  });

  function initMap() {
    if (!window.L) {
      $("mapOverlay").innerHTML =
        '<span class="map-crosshair" aria-hidden="true">⌖</span><strong>Map could not load</strong><span>Check your internet connection and reload.</span>';
      showToast("The map library did not load. The responder queue and aid guides still work.", true);
      return;
    }
    state.map = L.map("map", { zoomControl: true, scrollWheelZoom: false }).setView([-0.8, 37.8], 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(state.map);
    state.facilityLayer = L.layerGroup().addTo(state.map);
  }

  function setLocation(location, label) {
    state.location = {
      lat: location.lat,
      lon: location.lon,
      accuracy: location.accuracy ?? null,
      capturedAt: new Date(location.timestamp || Date.now()).toISOString(),
    };
    $("locationStatus").classList.add("is-set");
    $("locationText").textContent = label;
    $("accuracyText").textContent = state.location.accuracy == null
      ? ""
      : `±${Math.round(state.location.accuracy)} m`;
    $("searchFacilitiesButton").disabled = !navigator.onLine;
    $("facilityTypeFilter").disabled = true;
    $("facilityTypeFilter").value = "all";
    state.facilities = null;
    $("facilitySubheading").textContent = `Search within 10 km · ${label}`;

    if (state.map) {
      $("mapOverlay").hidden = true;
      $("mapLegend").hidden = false;
      const point = [state.location.lat, state.location.lon];
      state.map.setView(point, 13);
      if (state.userMarker) state.map.removeLayer(state.userMarker);
      state.userMarker = L.circleMarker(point, {
        radius: 8,
        color: "#fff",
        weight: 3,
        fillColor: "#4b9e91",
        fillOpacity: 1,
      }).bindPopup("Your current location").addTo(state.map);
    }

    state.facilityLayer?.clearLayers();
    $("facilityList").innerHTML =
      '<div class="empty-facilities"><span>⌖</span><p>Search for nearby health-facility listings.</p></div>';
    $("facilityCount").textContent = "";
    updateDashboardInsights();
  }

  $("locateButton").addEventListener("click", () => {
    if (!navigator.geolocation) {
      showToast("This browser does not support GPS location. Try a device/browser with location services enabled.", true);
      return;
    }
    $("locateButton").disabled = true;
    $("locationText").textContent = "Requesting location permission…";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        }, "Current location");
        $("locateButton").disabled = false;
        showToast("Current GPS location set. Search for nearby health-facility listings when ready.");
      },
      (error) => {
        $("locateButton").disabled = false;
        $("locationText").textContent = "Location not set";
        const messages = {
          1: "Location permission was denied. Allow location access in your browser or device settings, then try again.",
          2: "Your location is unavailable. Check that device location services are enabled, then try again.",
          3: "Location request timed out. Check your GPS reception and try again.",
        };
        showToast(messages[error.code] || "Could not get your location.", true);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });

  function distanceKm(lat1, lon1, lat2, lon2) {
    const radians = (degrees) => (degrees * Math.PI) / 180;
    const dLat = radians(lat2 - lat1);
    const dLon = radians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function renderFacilities() {
    const facilities = state.facilities || [];
    const sorted = facilities
      .map((facility) => ({
        ...facility,
        latitude: Number(facility.latitude),
        longitude: Number(facility.longitude),
      }))
      .filter((facility) => Number.isFinite(facility.latitude) && Number.isFinite(facility.longitude))
      .map((facility) => ({
        ...facility,
        distance: distanceKm(
          state.location.lat, state.location.lon, facility.latitude, facility.longitude,
        ),
      }))
      .sort((a, b) => a.distance - b.distance);
    const selectedType = $("facilityTypeFilter").value;
    const typeMatches = {
      hospital: (type) => type.includes("hospital"),
      clinic: (type) => ["clinic", "doctor", "doctors"].includes(type),
      health_centre: (type) => ["centre", "health_centre", "health_center"].includes(type),
      dispensary: (type) => type.includes("dispensary"),
    };
    const filtered = selectedType === "all"
      ? sorted
      : sorted.filter((facility) => {
        const type = String(facility.facility_type || "").toLowerCase().replaceAll(" ", "_");
        return typeMatches[selectedType]?.(type) || false;
      });
    $("facilityCount").textContent = selectedType === "all"
      ? `${filtered.length} found`
      : `${filtered.length} of ${sorted.length}`;
    $("facilityDisclaimer").hidden = false;
    $("facilityTypeFilter").disabled = sorted.length === 0;

    if (!sorted.length) {
      $("facilityList").innerHTML =
        '<div class="empty-facilities"><span>⌖</span><p>No health-facility listings found nearby. Try another location.</p></div>';
    } else if (!filtered.length) {
      $("facilityList").innerHTML =
        '<div class="empty-facilities"><span>⌕</span><p>No facilities match this type. Choose another filter.</p></div>';
    } else {
      $("facilityList").innerHTML = filtered.map((facility) => {
        const contacts = [];
        const phoneNumber = String(facility.phone || "").replace(/[^\d+]/g, "");
        if (/^\+?\d{3,15}$/.test(phoneNumber)) {
          contacts.push(`<a href="tel:${escapeHtml(phoneNumber)}">Call listing · verify</a>`);
        }
        if (facility.website) {
          try {
            const website = new URL(facility.website);
            if (website.protocol === "https:" || website.protocol === "http:") {
              contacts.push(`<a href="${escapeHtml(website.href)}" target="_blank" rel="noopener noreferrer">Website ↗</a>`);
            }
          } catch {
            // Ignore malformed public map tags.
          }
        }
        const directions = new URL("https://www.google.com/maps/dir/");
        directions.searchParams.set("api", "1");
        directions.searchParams.set("origin", `${state.location.lat},${state.location.lon}`);
        directions.searchParams.set("destination", `${facility.latitude},${facility.longitude}`);
        directions.searchParams.set("travelmode", "driving");
        contacts.push(
          `<a href="${escapeHtml(directions.href)}" target="_blank" rel="noopener noreferrer">Directions ↗</a>`,
        );
        const type = String(facility.facility_type || "health facility").replaceAll("_", " ");
        const emergency = facility.emergency === "yes"
          ? "Emergency capability tagged · verify"
          : "Emergency capability unknown";
        return `<article class="facility-row">
          <span class="facility-name">${escapeHtml(facility.name)}</span>
          <span class="facility-distance">${facility.distance.toFixed(1)} km direct</span>
          <span class="facility-meta"><span>${escapeHtml(type)}</span><span>${escapeHtml(emergency)}</span>${contacts.join("")}</span>
        </article>`;
      }).join("");
    }

    if (!state.facilityLayer) return;
    state.facilityLayer.clearLayers();
    for (const facility of filtered) {
      const type = String(facility.facility_type || "health facility").replaceAll("_", " ");
      L.circleMarker([facility.latitude, facility.longitude], {
        radius: 7,
        color: "#fff",
        weight: 2,
        fillColor: "#d65760",
        fillOpacity: 1,
      }).bindPopup(
        `<strong>${escapeHtml(facility.name)}</strong><br>${escapeHtml(type)} · ${facility.distance.toFixed(1)} km direct`,
      ).addTo(state.facilityLayer);
    }
    const points = [state.userMarker, ...state.facilityLayer.getLayers()].filter(Boolean);
    if (points.length) state.map.fitBounds(L.featureGroup(points).getBounds().pad(0.18), { maxZoom: 14 });
  }

  $("searchFacilitiesButton").addEventListener("click", async () => {
    if (!state.location) return;
    if (!navigator.onLine) {
      showToast("Facility search needs internet. First-aid guides remain available offline.", true);
      return;
    }
    if (!state.backendAvailable) {
      showToast("The backend is unavailable. Retry connection to search nearby facilities again.", true);
      return;
    }
    $("searchFacilitiesButton").disabled = true;
    $("searchFacilitiesButton").innerHTML =
      '<span class="loading-spinner" aria-hidden="true"></span> Searching…';
    $("facilitySubheading").textContent = "Searching OpenStreetMap health-facility listings…";
    try {
      const params = new URLSearchParams({
        latitude: String(state.location.lat),
        longitude: String(state.location.lon),
        radius_m: "10000",
      });
      const result = await api(`/api/facilities/nearby?${params}`);
      state.facilities = result.facilities;
      $("facilityTypeFilter").value = "all";
      renderFacilities();
      updateDashboardInsights();
      $("facilitySubheading").textContent = `Within 10 km · ${result.source} · approximate direct distance`;
      showToast(result.facilities.length
        ? `Found ${result.facilities.length} health-facility listing(s). Verify details before relying on them.`
        : "No health-facility listings found within 10 km.");
    } catch (error) {
      $("facilitySubheading").textContent = "Search is temporarily unavailable";
      state.backendAvailable = false;
      await refreshSystemStatus();
      showToast(error.message, true);
    } finally {
      $("searchFacilitiesButton").disabled = !state.location || !navigator.onLine || !state.backendAvailable;
      $("searchFacilitiesButton").innerHTML = '<span aria-hidden="true">⌕</span> Search nearby';
    }
  });

  $("facilityTypeFilter").addEventListener("change", renderFacilities);

  function setMedicalIdStatus(message, isError = false) {
    const status = $("medicalIdStatus");
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function loadMedicalId() {
    try {
      const saved = JSON.parse(localStorage.getItem(MEDICAL_ID_STORAGE_KEY) || "{}");
      for (const [name, value] of Object.entries(saved)) {
        const field = $("medicalIdForm").elements.namedItem(name);
        if (field && typeof value === "string") field.value = value;
      }
      if (Object.keys(saved).length) setMedicalIdStatus("Saved on this device only.");
    } catch {
      setMedicalIdStatus("Could not read local medical ID storage in this browser.", true);
    }
  }

  $("medicalIdForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const profile = Object.fromEntries(
      [...formData.entries()].map(([key, value]) => [key, String(value).trim()]),
    );
    try {
      localStorage.setItem(MEDICAL_ID_STORAGE_KEY, JSON.stringify(profile));
      setMedicalIdStatus("Medical ID saved in this browser. It is not sent with test alerts.");
    } catch {
      setMedicalIdStatus("Could not save. Browser storage may be disabled or full.", true);
    }
  });

  $("clearMedicalIdButton").addEventListener("click", () => {
    try {
      localStorage.removeItem(MEDICAL_ID_STORAGE_KEY);
      $("medicalIdForm").reset();
      setMedicalIdStatus("Saved medical ID cleared from this browser.");
    } catch {
      setMedicalIdStatus("Could not clear local medical ID storage.", true);
    }
  });

  $("aidFilterList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    const selectedFilter = button.dataset.filter;
    $("aidFilterList").querySelectorAll("button[data-filter]").forEach((filterButton) => {
      const selected = filterButton === button;
      filterButton.classList.toggle("is-active", selected);
      filterButton.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll(".aid-guide[data-category]").forEach((guide) => {
      guide.hidden = selectedFilter !== "all" && guide.dataset.category !== selectedFilter;
    });
  });

  function startCountdown(source) {
    if (!state.location) {
      showToast("Set your location before starting a test alert.", true);
      return;
    }
    if (state.countdownTimer) return;
    state.requestKey = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.countdownRemaining = 10;
    $("countdownValue").textContent = state.countdownRemaining;
    $("countdownPanel").hidden = false;
    $("sosButton").disabled = true;
    $("crashButton").disabled = true;
    $("triggerMessage").textContent = "Countdown started. This will only create a local simulation.";
    state.countdownTimer = window.setInterval(async () => {
      state.countdownRemaining -= 1;
      $("countdownValue").textContent = state.countdownRemaining;
      if (state.countdownRemaining <= 0) {
        window.clearInterval(state.countdownTimer);
        state.countdownTimer = null;
        await createTestIncident(source);
      }
    }, 1000);
  }

  async function createTestIncident(source) {
    $("countdownPanel").hidden = true;
    const sharePatientDetails = $("sharePatientDetails").checked;
    try {
      let patientDetails = null;
      if (sharePatientDetails) {
        const savedProfile = JSON.parse(localStorage.getItem(MEDICAL_ID_STORAGE_KEY) || "{}");
        patientDetails = {
          name: savedProfile.name || "",
          blood_group: savedProfile.bloodGroup || "",
          allergies: savedProfile.allergies || "",
          conditions: savedProfile.conditions || "",
          medicines: savedProfile.medicines || "",
          contact_name: savedProfile.contactName || "",
          contact_phone: savedProfile.contactPhone || "",
        };
        if (!Object.values(patientDetails).some((value) => String(value).trim())) {
          patientDetails = null;
          showToast("No saved medical details to share. Add details in Medical ID or uncheck sharing.", true);
        }
      }
      const incident = await api("/api/incidents", {
        method: "POST",
        body: JSON.stringify({
          request_key: state.requestKey,
          source,
          latitude: state.location.lat,
          longitude: state.location.lon,
          accuracy_m: state.location.accuracy,
          location_captured_at: state.location.capturedAt,
          share_patient_details: Boolean(sharePatientDetails && patientDetails),
          patient_details: patientDetails,
        }),
      });
      $("triggerMessage").textContent = incident.simulation_notice;
      $("sharePatientDetails").checked = false;
      showToast(incident.patient_details_shared
        ? "Test incident created. Details are visible only to a medic assigned by an authorized dispatcher."
        : "Test incident created in the local responder queue. No one was contacted.");
      await loadIncidents();
    } catch (error) {
      $("triggerMessage").textContent = "";
      $("sharePatientDetails").checked = false;
      showToast(error.message, true);
    } finally {
      $("sosButton").disabled = false;
      $("crashButton").disabled = false;
    }
  }

  function cancelCountdown() {
    if (state.countdownTimer) window.clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    $("countdownPanel").hidden = true;
    $("sosButton").disabled = false;
    $("crashButton").disabled = false;
    $("sharePatientDetails").checked = false;
    $("triggerMessage").textContent = "Test alert cancelled before creation.";
  }

  $("sosButton").addEventListener("click", () => startCountdown("manual_sos"));
  $("crashButton").addEventListener("click", () => startCountdown("simulated_crash"));
  $("cancelCountdownButton").addEventListener("click", cancelCountdown);

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString("en-KE", {
      timeZone: "Africa/Nairobi",
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function renderIncidents(incidents) {
    state.incidents = incidents;
    state.incidentsLoaded = true;
    $("exportIncidentsButton").disabled = incidents.length === 0 || !state.backendAvailable;
    const activeCount = incidents.filter((incident) =>
      ["active", "acknowledged"].includes(incident.status),
    ).length;
    $("queueCount").textContent = `${activeCount} active`;
    updateDashboardInsights();
    const list = $("incidentList");
    if (!incidents.length) {
      list.innerHTML = `<div class="queue-empty">
        <span class="empty-icon" aria-hidden="true">✓</span>
        <strong>All clear</strong><p>Simulated incidents will appear here.</p>
      </div>`;
      return;
    }
    list.innerHTML = incidents.map((incident) => {
      const title = incident.source === "simulated_crash" ? "Simulated crash alert" : "Test SOS";
      const status = incident.status;
      let actions = "";
      if (status === "active") {
        actions = `<button class="incident-action" data-action="acknowledge" data-id="${escapeHtml(incident.id)}">Acknowledge</button>
          <button class="incident-action resolve" data-action="resolve" data-id="${escapeHtml(incident.id)}">Resolve</button>`;
      } else if (status === "acknowledged") {
        actions = `<button class="incident-action resolve" data-action="resolve" data-id="${escapeHtml(incident.id)}">Resolve</button>`;
      }
      const isQueueActionDisabled = !state.backendAvailable;
      return `<article class="incident-row">
        <div>
          <div class="incident-top"><span class="incident-title">${title}</span>
            <span class="status-pill status-${status}">${status}</span></div>
          <div class="incident-time">${formatTime(incident.created_at)} · ${Number(incident.latitude).toFixed(4)}, ${Number(incident.longitude).toFixed(4)}</div>
        </div>
        <div class="incident-actions">${actions.replaceAll(
          'class="incident-action',
          isQueueActionDisabled ? 'class="incident-action is-disabled' : 'class="incident-action'
        )}</div>
      </article>`;
    }).join("");

    if (!state.backendAvailable) {
      const actionButtons = list.querySelectorAll("button[data-action]");
      actionButtons.forEach((button) => {
        button.disabled = true;
        button.title = "Backend unavailable. Retry connection to use queue actions.";
      });
    }
  }

  function exportIncidents() {
    if (!state.incidents.length) return;
    const columns = ["id", "source", "status", "created_at", "latitude", "longitude"];
    const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [
      columns.join(","),
      ...state.incidents.map((incident) => columns.map((column) => csvCell(incident[column])).join(",")),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `beacon-test-incidents-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Exported ${state.incidents.length} local test record(s), including location coordinates.`);
  }

  async function refreshSystemStatus() {
    const status = $("systemStatus");
    const banner = $("backendStatusBanner");
    const exportButton = $("exportIncidentsButton");
    const healthBackendState = $("healthBackendState");
    const healthFirebaseState = $("healthFirebaseState");
    const healthMapState = $("healthMapState");
    if (!status && !banner && !exportButton && !healthBackendState && !healthFirebaseState && !healthMapState) return;

    try {
      const health = await api("/api/health");
      const dbReady = health.database?.ready !== false;
      const firebaseAuthEnabled = Boolean(health.firebase?.enabled);
      const firebaseDatabaseEnabled = Boolean(health.firebase?.database?.enabled);
      const patientDetailsEnabled = health.patient_details?.enabled !== false;
      $("sharePatientDetails").closest(".patient-sharing-consent").hidden = !patientDetailsEnabled;
      $("patientDetailsUnavailable").hidden = patientDetailsEnabled;
      if (!patientDetailsEnabled) $("sharePatientDetails").checked = false;
      state.backendAvailable = dbReady;

      if (status) {
        status.classList.toggle("is-error", !dbReady);
        status.textContent = dbReady
          ? (firebaseDatabaseEnabled ? "Backend ready · RTDB on" : "Backend ready · RTDB off")
          : "Backend offline";
        status.title = dbReady
          ? `Local database ready. Realtime Database ${firebaseDatabaseEnabled ? "enabled" : "not configured"}; Firebase Auth ${firebaseAuthEnabled ? "enabled" : "not configured"}.`
          : `Database not ready. Check the server and SQLite path.`;
      }

      if (healthBackendState) {
        healthBackendState.textContent = `Backend: ${dbReady ? "ready" : "offline"}`;
        healthBackendState.classList.toggle("is-ok", dbReady);
        healthBackendState.classList.toggle("is-error", !dbReady);
      }
      if (healthFirebaseState) {
        healthFirebaseState.textContent =
          `Firebase Auth: ${firebaseAuthEnabled ? "on" : "off"} · RTDB: ${firebaseDatabaseEnabled ? "on" : "off"}`;
        healthFirebaseState.classList.toggle(
          "is-ok",
          firebaseAuthEnabled || firebaseDatabaseEnabled,
        );
        healthFirebaseState.classList.toggle(
          "is-error",
          !firebaseAuthEnabled && !firebaseDatabaseEnabled,
        );
      }
      if (healthMapState) {
        healthMapState.textContent = `Map: ${navigator.onLine ? "ready" : "offline"}`;
        healthMapState.classList.toggle("is-ok", navigator.onLine);
        healthMapState.classList.toggle("is-error", !navigator.onLine);
      }

      if (banner) {
        banner.hidden = dbReady;
        if (!dbReady) {
          banner.textContent = "Backend unavailable: the local queue and app settings may be stale. Check the server and SQLite database.";
        }
      }

      if (exportButton) {
        exportButton.disabled = !state.incidents.length || !dbReady;
      }
    } catch (error) {
      state.backendAvailable = false;
      if (status) {
        status.classList.add("is-error");
        status.textContent = "Backend offline";
        status.title = error.message || "The app could not reach the backend.";
      }
      if (healthBackendState) {
        healthBackendState.textContent = "Backend: offline";
        healthBackendState.classList.remove("is-ok");
        healthBackendState.classList.add("is-error");
      }
      if (healthFirebaseState) {
        healthFirebaseState.textContent = "Firebase: unknown";
        healthFirebaseState.classList.remove("is-ok");
        healthFirebaseState.classList.add("is-error");
      }
      if (healthMapState) {
        healthMapState.textContent = `Map: ${navigator.onLine ? "ready" : "offline"}`;
        healthMapState.classList.toggle("is-ok", navigator.onLine);
        healthMapState.classList.toggle("is-error", !navigator.onLine);
      }
      if (banner) {
        banner.hidden = false;
        banner.textContent = "Backend unavailable: the local queue and app settings may be stale. Check the server and SQLite database.";
      }
      if (exportButton) {
        exportButton.disabled = true;
      }
    }
  }

  $("exportIncidentsButton").addEventListener("click", exportIncidents);

  $("retryBackendButton").addEventListener("click", async () => {
    $("retryBackendButton").disabled = true;
    try {
      await refreshSystemStatus();
      await loadIncidents({ silent: false });
      showToast("Backend connection check complete.");
    } catch (error) {
      showToast(error.message || "The backend retry failed.", true);
    } finally {
      $("retryBackendButton").disabled = false;
    }
  });

  async function loadIncidents({ silent = false } = {}) {
    try {
      renderIncidents(await api("/api/incidents"));
      if (!silent) await refreshSystemStatus();
    } catch (error) {
      if (!silent) {
        showToast(`Could not load the local responder queue: ${error.message}`, true);
      }
      await refreshSystemStatus();
    }
  }

  $("incidentList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    button.disabled = true;
    try {
      const path = `/api/incidents/${encodeURIComponent(button.dataset.id)}/${button.dataset.action}`;
      await api(path, {
        method: "POST",
        ...(button.dataset.action === "resolve"
          ? { body: JSON.stringify({ note: "Resolved in local simulation." }) }
          : {}),
      });
      await loadIncidents({ silent: true });
    } catch (error) {
      await refreshSystemStatus();
      showToast(`${error.message} Retrying the queue shortly…`, true);
      window.setTimeout(() => {
        loadIncidents({ silent: true }).catch(() => {});
      }, 1500);
      button.disabled = false;
    }
  });

  $("refreshButton").addEventListener("click", async () => {
    await refreshSystemStatus();
    await loadIncidents();
  });
  initializeTheme();
  initializeTextSize();
  loadMedicalId();
  initializeMedicAuth();
  initMap();
  updateConnectivity();
  refreshSystemStatus();
  loadIncidents();
  window.setInterval(refreshSystemStatus, 30000);
})();
