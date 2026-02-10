/**
 * DROS - Disaster Resource Optimization System
 * Connected to backend API (no MOCK data)
 */

(function () {
  "use strict";

  const API_BASE = window.DROS_API_BASE || "http://localhost:3001/api";
  const REFRESH_INTERVAL_MS = 15000;

  const DISASTER_CONFIG = {
    Flood: { color: "#0ea5e9", baseRadius: 30000, maxRadius: 120000, icon: "🌊" },
    Cyclone: { color: "#8b5cf6", baseRadius: 60000, maxRadius: 450000, icon: "🌀" },
    Earthquake: { color: "#ef4444", baseRadius: 40000, maxRadius: 200000, icon: "🌍" },
    Wildfire: { color: "#f97316", baseRadius: 25000, maxRadius: 100000, icon: "🔥" },
    Tsunami: { color: "#1e3a5f", baseRadius: 120000, maxRadius: 600000, icon: "🌊" },
  };

  const ALLOCATION_COLORS = {
    ambulance: "#22c55e",
    rescue_teams: "#eab308",
    food: "#f97316",
    helicopters: "#8b5cf6",
    water: "#3b82f6",
    medical_kits: "#ec4899",
  };

  let map;
  let hospitals = [];
  let resources = [];
  let activeDisasters = [];
  let hospitalLayer = L.layerGroup();
  let resourceLayer = L.layerGroup();
  let disasterLayer = L.layerGroup();
  let allocationLayer = L.layerGroup();
  let towerLayer = L.layerGroup();
  let refreshTimer = null;
  let viewMode = "risk";
  let editMode = true;
  let currentOptimization = null;
  let optimizationByDisasterId = {};
  let selectedDisasterType = "Flood";

  function getDefaultView() {
    return { center: [19.0, 85.0], zoom: 7 };
  }

  function initMap() {
    const v = getDefaultView();
    map = L.map("map").setView(v.center, v.zoom);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap, &copy; CARTO",
    }).addTo(map);

    const disasterZonesPane = map.createPane("disasterZones");
    if (disasterZonesPane) {
      disasterZonesPane.style.zIndex = 400;
      disasterZonesPane.style.pointerEvents = "none";
    }
    const disasterMarkersPane = map.createPane("disasterMarkers");
    if (disasterMarkersPane) {
      disasterMarkersPane.style.zIndex = 550;
    }
    const allocationPane = map.createPane("allocationLines");
    if (allocationPane) {
      allocationPane.style.zIndex = 450;
    }

    hospitalLayer.addTo(map);
    resourceLayer.addTo(map);
    disasterLayer.addTo(map);
    allocationLayer.addTo(map);

    map.on("click", onMapClick);
  }

  /**
   * Shared message builder (matches backend logic)
   * Builds tower alert message from zone data
   */
  function buildTowerAlertMessage({ towerName, zones, format = "html" }) {
    if (!zones || zones.length === 0) {
      return format === "sms"
        ? `No active alerts for ${towerName}.`
        : `No active alerts for this tower.`;
    }

    // Deduplicate by (disaster_id, zone)
    const seen = new Set();
    const uniqueZones = zones.filter((z) => {
      const key = `${z.disaster_id}_${z.zone}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Group by zone level
    const byZone = { HIGH: [], MED: [], LOW: [] };
    uniqueZones.forEach((z) => {
      if (byZone[z.zone]) byZone[z.zone].push(z);
    });

    const parts = [];
    if (format === "html") {
      parts.push(`<strong>${escapeHtml(towerName)}</strong>`);
    } else {
      parts.push(towerName);
    }

    ["HIGH", "MED", "LOW"].forEach((zoneLevel) => {
      const zoneItems = byZone[zoneLevel];
      if (zoneItems.length === 0) return;

      zoneItems.forEach((z) => {
        const zoneLabel = zoneLevel;
        const disasterType = z.disaster_type || "Disaster";
        const eta = z.eta_min != null ? z.eta_min : null;
        const food = z.food_quantity != null ? z.food_quantity : null;

        if (format === "html") {
          parts.push(`<br><br><strong>${zoneLabel} (${escapeHtml(disasterType)}):</strong>`);
          if (eta != null) parts.push(`ETA ambulances: ~${eta} min`);
          if (food != null) parts.push(`Food allocated: ${food.toLocaleString()} meals`);
          if (eta == null && food == null) parts.push(`Run optimization for ETA & food.`);
        } else {
          parts.push(`\n\n${zoneLabel} (${disasterType}):`);
          if (eta != null) parts.push(`ETA ambulances: ~${eta} min`);
          if (food != null) parts.push(`Food allocated: ${food.toLocaleString()} meals`);
          if (eta == null && food == null) parts.push(`Run optimization for ETA & food.`);
        }
      });
    });

    return parts.join(format === "html" ? "<br>" : "\n");
  }

  function getZoneEtaAndFood(disasterId, zoneKey) {
    const opt = optimizationByDisasterId[disasterId];
    if (!opt || !opt.zones) return { eta_min: null, food_quantity: null };
    const allocs = (opt.zones[zoneKey] || []).filter((a) => a.people_served > 0);
    const ambulanceAllocs = allocs.filter((a) => a.resource === "ambulance");
    const foodAllocs = allocs.filter((a) => a.resource === "food");
    const etaMin = ambulanceAllocs.length ? Math.min(...ambulanceAllocs.map((a) => a.eta_min)) : null;
    const foodTotal = foodAllocs.reduce((s, a) => s + (a.quantity || 0), 0);
    return { eta_min: etaMin, food_quantity: foodTotal || null };
  }

  function getTowerIcon(riskLevel) {
    const colors = { HIGH: "#ef4444", MED: "#f97316", LOW: "#22c55e", NONE: "#64748b" };
    const c = colors[riskLevel] || colors.NONE;
    return L.divIcon({
      className: "tower-marker",
      html: `<span class="tower-symbol" style="color:${c};" title="Tower">📡</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  async function loadTowers() {
    try {
      const data = await fetchJson(`${API_BASE}/towers`);
      towerLayer.clearLayers();
      (data.features || []).forEach((f) => {
        const lat = f.geometry.coordinates[1];
        const lng = f.geometry.coordinates[0];
        const props = f.properties || {};
        const coverageRadius = props.coverage_radius || 15000;
        const riskLevel = props.risk_level || "NONE";
        const zones = props.zones || [];

        // Enrich zones with ETA and food from optimization
        const enrichedZones = zones.map((z) => {
          const { eta_min, food_quantity } = getZoneEtaAndFood(z.disaster_id, z.zone);
          return { ...z, eta_min, food_quantity };
        });

        const circleColor = riskLevel === "HIGH" ? "#ef4444" : riskLevel === "MED" ? "#f97316" : riskLevel === "LOW" ? "#22c55e" : "#64748b";
        const circle = L.circle([lat, lng], {
          radius: coverageRadius,
          color: circleColor,
          fillColor: circleColor,
          fillOpacity: 0.15,
          weight: 2,
        });
        const marker = L.marker([lat, lng], { icon: getTowerIcon(riskLevel) });

        // Build message using shared builder
        const messageHtml = buildTowerAlertMessage({
          towerName: props.name || "Tower",
          zones: enrichedZones,
          format: "html",
        });

        const popupContent = `<div class="tower-popup">${messageHtml}</div>`;
        marker.bindPopup(popupContent);
        circle.bindPopup(popupContent);

        // Store enriched zones on marker for SMS sending
        marker._towerData = { id: props.id, name: props.name, zones: enrichedZones, risk_level: riskLevel };

        towerLayer.addLayer(circle);
        towerLayer.addLayer(marker);
      });
    } catch (err) {
      console.error("Error loading towers:", err);
    }
  }

  function setViewMode(mode) {
    viewMode = mode;
    const isComm = mode === "comm";
    document.getElementById("commModeHint").style.display = isComm ? "block" : "none";
    document.getElementById("sendSmsBtn").style.display = isComm ? "inline-block" : "none";
    document.getElementById("legendAllocation").style.display = isComm ? "none" : "block";

    if (isComm) {
      map.addLayer(towerLayer);
      map.removeLayer(allocationLayer);
      loadTowers();
    } else {
      map.removeLayer(towerLayer);
      if (document.getElementById("layerAllocation").checked) {
        map.addLayer(allocationLayer);
      }
    }
  }

  async function onMapClick(e) {
    if (!editMode) return;

    const severityInput = document.getElementById("severity");
    const maxDisasters = 5;
    if (activeDisasters.length >= maxDisasters) {
      showToast("Maximum " + maxDisasters + " active disasters allowed.");
      return;
    }
    const type = selectedDisasterType;
    const severity = Math.max(1, Math.min(5, Number(severityInput.value) || 3));
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    try {
      const response = await fetch(`${API_BASE}/disaster`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, severity, lat, lng }),
      });

      if (!response.ok) {
        throw new Error("Failed to create disaster");
      }

      const feature = await response.json();
      const props = feature.properties;
      const coords = feature.geometry.coordinates;

      const affectedRadius = props.affected_radius;
      const evacuationRadius = props.evacuation_radius;
      const cfg = DISASTER_CONFIG[type];

      const highRadius = affectedRadius * 0.5;
      const medRadius = affectedRadius;
      const lowRadius = evacuationRadius;

      const highZone = L.circle([coords[1], coords[0]], {
        radius: highRadius,
        color: cfg.color,
        fillColor: cfg.color,
        fillOpacity: 0.7,
        weight: 3,
        pane: "disasterZones",
      });

      const medZone = L.circle([coords[1], coords[0]], {
        radius: medRadius,
        color: cfg.color,
        fillColor: cfg.color,
        fillOpacity: 0.4,
        weight: 2,
        pane: "disasterZones",
      });

      const lowZone = L.circle([coords[1], coords[0]], {
        radius: lowRadius,
        color: cfg.color,
        fillColor: cfg.color,
        fillOpacity: 0.15,
        weight: 1,
        dashArray: "8 4",
        pane: "disasterZones",
      });

      const marker = L.circleMarker([coords[1], coords[0]], {
        radius: 12,
        fillColor: cfg.color,
        color: "#fff",
        weight: 2,
        fillOpacity: 1,
        pane: "disasterMarkers",
      });

      marker.bindPopup(`<strong>${type}</strong><br>Severity: ${severity}`);

      disasterLayer.addLayer(highZone);
      disasterLayer.addLayer(medZone);
      disasterLayer.addLayer(lowZone);
      disasterLayer.addLayer(marker);

      const disaster = {
        id: "d-" + Date.now(),
        backendId: props.id,
        type,
        severity,
        lat: coords[1],
        lng: coords[0],
        affectedRadius,
        evacuationRadius,
        layers: { highZone, medZone, lowZone, marker },
      };

      marker.on("click", async function () {
        await removeDisaster(disaster);
      });

      activeDisasters.push(disaster);
      renderDashboard();
      if (viewMode === "comm") loadTowers();
      showToast(`Added ${type} (severity ${severity})`);
    } catch (err) {
      console.error("Error creating disaster:", err);
      showToast("Failed to create disaster. Check backend connection.");
    }
  }

  async function removeDisaster(disaster) {
    try {
      if (disaster.backendId) {
        await fetch(`${API_BASE}/disasters/${disaster.backendId}`, {
          method: "DELETE",
        });
      }

      disasterLayer.removeLayer(disaster.layers.highZone);
      disasterLayer.removeLayer(disaster.layers.medZone);
      disasterLayer.removeLayer(disaster.layers.lowZone);
      disasterLayer.removeLayer(disaster.layers.marker);

      activeDisasters = activeDisasters.filter((d) => d.id !== disaster.id);
      renderDashboard();
      clearAllocation();
      if (viewMode === "comm") loadTowers();
      showToast("Disaster removed.");
    } catch (err) {
      console.error("Error removing disaster:", err);
      showToast("Failed to remove disaster from backend.");
    }
  }

  function clearAllocation() {
    allocationLayer.clearLayers();
    currentOptimization = null;
    optimizationByDisasterId = {};
    const el = document.getElementById("optimizationResults");
    if (el) el.classList.remove("visible");
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(response.statusText);
    return response.json();
  }

  async function loadHospitals() {
    try {
      const data = await fetchJson(`${API_BASE}/hospitals`);
      hospitals = data.features.map((f) => ({
        id: f.properties.id,
        name: f.properties.name,
        capacity: f.properties.capacity,
        ambulances: f.properties.ambulances ?? Math.max(1, Math.floor((f.properties.capacity || 0) / 15)),
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
      }));
    } catch (err) {
      console.error("Error loading hospitals:", err);
      hospitals = [];
    }
  }

  async function loadResources() {
    try {
      const data = await fetchJson(`${API_BASE}/resources`);
      resources = data.features.map((f) => ({
        id: f.properties.id,
        type: f.properties.type,
        quantity: f.properties.quantity,
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
      }));
    } catch (err) {
      console.error("Error loading resources:", err);
      resources = [];
    }
  }

  async function loadDisasters() {
    try {
      const data = await fetchJson(`${API_BASE}/disasters`);
      const backendIds = new Set(data.features.map((f) => f.properties.id));
      activeDisasters = activeDisasters.filter((d) => {
        if (d.backendId && !backendIds.has(d.backendId)) {
          if (d.layers) {
            disasterLayer.removeLayer(d.layers.highZone);
            disasterLayer.removeLayer(d.layers.medZone);
            disasterLayer.removeLayer(d.layers.lowZone);
            disasterLayer.removeLayer(d.layers.marker);
          }
          return false;
        }
        return true;
      });
      renderDashboard();
    } catch (err) {
      console.error("Error loading disasters:", err);
    }
  }

  async function refreshApiData() {
    await Promise.all([loadHospitals(), loadResources(), loadDisasters()]);
    renderHospitalMarkers();
    renderResourceMarkers();
    renderDashboard();
    if (viewMode === "comm") loadTowers();
  }

  function renderHospitalMarkers() {
    hospitalLayer.clearLayers();
    hospitals.forEach((h) => {
      const marker = L.circleMarker([h.lat, h.lng], {
        radius: 8,
        fillColor: "#10b981",
        color: "#fff",
        weight: 2,
        fillOpacity: 1,
      });
      const amb = h.ambulances ?? "—";
      marker.bindTooltip(h.name, { permanent: false, direction: "top" });
      marker.bindPopup(`<strong>${escapeHtml(h.name)}</strong><br>Beds: ${h.capacity} · Ambulances: ${amb}`);
      hospitalLayer.addLayer(marker);
    });
  }

  function renderResourceMarkers() {
    resourceLayer.clearLayers();
    resources.forEach((r) => {
      const type = (r.type || "resource").replace("_", " ");
      const marker = L.circleMarker([r.lat, r.lng], {
        radius: 6,
        fillColor: "#f59e0b",
        color: "#fff",
        weight: 1,
        fillOpacity: 1,
      });
      marker.bindTooltip(`${type}: ${r.quantity}`, { permanent: false, direction: "top" });
      marker.bindPopup(`<strong>${escapeHtml(type)}</strong><br>${r.quantity} units`);
      resourceLayer.addLayer(marker);
    });
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function renderDashboard() {
    const totalBeds = hospitals.reduce((s, h) => s + (h.capacity || 0), 0);
    const hospitalAmbulances = hospitals.reduce((s, h) => s + (h.ambulances || 0), 0);
    const resourceAmbulances = resources.filter((r) => r.type === "ambulance").reduce((s, r) => s + (r.quantity || 0), 0);
    const totalAmbulances = hospitalAmbulances + resourceAmbulances;
    const foodQty = resources.filter((r) => r.type === "food").reduce((s, r) => s + (r.quantity || 0), 0);
    const teamsQty = resources.filter((r) => r.type === "rescue_teams").reduce((s, r) => s + (r.quantity || 0), 0);

    document.getElementById("statHospitals").textContent = hospitals.length;
    document.getElementById("statBeds").textContent = totalBeds.toLocaleString();
    document.getElementById("statAmbulances").textContent = totalAmbulances;
    document.getElementById("statFood").textContent = foodQty.toLocaleString();
    document.getElementById("statTeams").textContent = teamsQty;
    document.getElementById("statDisasters").textContent = activeDisasters.length;

    const listEl = document.getElementById("activeDisastersList");
    listEl.innerHTML = "";
    activeDisasters.forEach((d) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="badge" style="background:${DISASTER_CONFIG[d.type].color}">${d.type}</span> Severity ${d.severity}`;
      listEl.appendChild(li);
    });
  }

  async function runOptimization() {
    if (activeDisasters.length === 0) {
      showToast("Add at least one disaster on the map first.");
      return;
    }

    const withIds = activeDisasters.filter((d) => d.backendId);
    if (withIds.length === 0) {
      showToast("Disasters not synced with backend. Please wait...");
      return;
    }

    try {
      if (viewMode === "risk") {
        allocationLayer.clearLayers();
      }
      optimizationByDisasterId = {};

      const response = await fetch(`${API_BASE}/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disaster_ids: withIds.map((d) => d.backendId) }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Optimization failed");
      }

      const data = await response.json();
      const results = data.results ? data.results : [data];
      currentOptimization = results;

      results.forEach((result) => {
        optimizationByDisasterId[result.disaster_id] = result;
        if (viewMode === "risk") {
          const disaster = activeDisasters.find((d) => d.backendId === result.disaster_id);
          if (disaster && !(result.message && result.message.includes("ocean"))) {
            renderAllocationLines(result, disaster);
          }
        }
      });

      renderOptimizationPanel(results);
      document.getElementById("optimizationResults").classList.add("visible");
      if (viewMode === "comm") loadTowers();
      showToast("Optimization complete for " + results.length + " disaster(s).");
    } catch (err) {
      console.error("Optimization error:", err);
      showToast("Optimization failed: " + err.message);
    }
  }

  function renderAllocationLines(result, disaster) {
    const allocations = result.allocations || [];
    if (!allocations.length) return;

    allocations.forEach((alloc) => {
      if ((alloc.people_served || 0) === 0) return;

      const sourceLat = alloc.source_geom?.coordinates[1];
      const sourceLng = alloc.source_geom?.coordinates[0];
      const target = alloc.zone_target;
      if (sourceLat == null || sourceLng == null || !target) return;

      const line = L.polyline(
        [[sourceLat, sourceLng], [target.lat, target.lng]],
        {
          pane: "allocationLines",
          color: ALLOCATION_COLORS[alloc.resource] || "#888",
          weight: alloc.zone === "HIGH" ? 4 : alloc.zone === "MED" ? 3 : 2,
          opacity: alloc.zone === "HIGH" ? 1.0 : alloc.zone === "MED" ? 0.8 : 0.6,
          dashArray: alloc.mode === "helicopter" ? "10 5" : null,
        }
      );
      if (alloc.mode === "helicopter") line.setStyle({ color: "#8b5cf6" });

      const originalWeight = line.options.weight;
      line.on("mouseover", function () {
        this.setStyle({ weight: originalWeight + 3 });
      });
      line.on("mouseout", function () {
        this.setStyle({ weight: originalWeight });
      });

      const resourceName = alloc.resource.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase());
      const sourceName = alloc.source_name || `Resource ${alloc.source_id}`;
      const peopleServed = alloc.people_served || 0;
      line.bindTooltip(`${resourceName} → ${sourceName}`, { permanent: false, direction: "right" });
      line.bindPopup(`${resourceName} ${alloc.quantity} · ${sourceName} · ${peopleServed.toLocaleString()} people served`);
      allocationLayer.addLayer(line);
    });
  }

  function renderOptimizationPanel(results) {
    const list = document.getElementById("optimizationResultsList");
    list.innerHTML = "";
    const arr = Array.isArray(results) ? results : [results];

    let totalPop = 0, totalServed = 0, totalLives = 0;
    arr.forEach((result) => {
      if (result.message) return;
      totalPop += result.population_at_risk ?? 0;
      totalServed += result.total_people_served ?? 0;
      totalLives += Math.min(result.lives_saved_estimate ?? 0, result.total_people_served ?? 0);
    });

    document.getElementById("populationAtRisk").textContent = totalPop.toLocaleString();
    document.getElementById("totalPeopleServed").textContent = totalServed.toLocaleString();
    document.getElementById("totalLivesSaved").textContent = totalLives.toLocaleString();

    const zoneOrder = ["HIGH", "MED", "LOW"];
    const zoneLabels = { HIGH: "High Risk", MED: "Medium Risk", LOW: "Low Risk" };

    arr.forEach((result) => {
      if (result.message) {
        list.innerHTML += `<p class="result-section" style="color: var(--text-muted);">${escapeHtml(result.message)}</p>`;
        return;
      }
      const zonePops = result.zone_populations || {};
      const zoneServed = result.people_served_by_zone || {};
      const zones = result.zones || {};
      const header = document.createElement("h3");
      header.className = "result-disaster-header";
      header.textContent = `${result.type} (Severity ${result.severity})`;
      list.appendChild(header);
      zoneOrder.forEach((zoneKey) => {
        const zoneAllocs = (zones[zoneKey] || []).filter((a) => (a.people_served || 0) > 0);
        const popZ = zonePops[zoneKey] || 0;
        const servedZ = zoneServed[zoneKey] || 0;

        const section = document.createElement("div");
        section.className = "result-section";
        const zoneLabel = zoneLabels[zoneKey];
        const zoneColor = zoneKey === "HIGH" ? "#ef4444" : zoneKey === "MED" ? "#f97316" : "#eab308";

        section.innerHTML = `
          <h4 style="color: ${zoneColor};">${zoneLabel} Zone</h4>
          <p class="zone-pop">Population at risk: <strong>${popZ.toLocaleString()}</strong> · People served: <strong>${servedZ.toLocaleString()}</strong></p>
          <ul class="allocation-list"></ul>
        `;

        const ul = section.querySelector(".allocation-list");
        zoneAllocs.forEach((a) => {
          const li = document.createElement("li");
          const resourceName = a.resource.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase());
          const sourceName = a.source_name || `Resource ${a.source_id}`;
          const ps = a.people_served || 0;
          li.textContent = `${resourceName}: ${a.quantity} from ${sourceName} · ${ps.toLocaleString()} people served`;
          ul.appendChild(li);
        });

        list.appendChild(section);
      });
    });
  }

  async function sendSMSAlerts() {
    if (viewMode !== "comm") {
      showToast("SMS alerts only available in Communication Awareness mode.");
      return;
    }

    // Match database names (with "Tower —" prefix) or simple names
    const eligibleTowers = ["Tower — Gopalpur Coast", "Tower — Visakhapatnam", "Gopalpur Coast", "Visakhapatnam"];
    const promises = [];
    let eligibleCount = 0;
    let noneRiskCount = 0;

    try {
      // Helper function to normalize tower names (handle encoding issues, dashes, prefixes)
      function normalizeTowerName(name) {
        if (!name) return "";
        // Remove encoding corruption (â€", â€", etc.) and replace with space
        let normalized = String(name)
          .replace(/â€[""]?/g, " ") // Handle corrupted em-dash
          .replace(/[""''‚„]/g, "") // Remove any quote marks (straight, curly, smart quotes)
          .replace(/[—–-]/g, " ") // Handle various dash types
          .replace(/^tower\s+/i, "") // Remove "Tower" prefix
          .replace(/\s+/g, " ") // Normalize multiple spaces to single space
          .trim()
          .toLowerCase();
        return normalized;
      }

      // Extract location names from eligible towers
      const eligibleLocations = ["gopalpur coast", "visakhapatnam"];

      // Collect all eligible towers
      towerLayer.eachLayer((layer) => {
        if (layer._towerData) {
          const { id, name, zones, risk_level } = layer._towerData;
          
          // Normalize tower name to extract location
          const normalizedName = normalizeTowerName(name);
          
          // Check if tower location matches eligible locations
          const isEligible = eligibleLocations.some(loc => {
            return normalizedName.includes(loc) || loc.includes(normalizedName);
          });
          
          if (!isEligible) {
            console.log(`[sms] Tower "${name}" (normalized: "${normalizedName}") not eligible. Must contain "gopalpur coast" or "visakhapatnam"`);
            return;
          }
          
          eligibleCount++;
          
          // Debug logging
          console.log(`[sms] Tower "${name}" (normalized: "${normalizedName}"): risk_level="${risk_level}", zones=${zones?.length || 0}`, zones);
          
          // Check if tower has any zones (risk != NONE)
          if (!zones || zones.length === 0 || risk_level === "NONE") {
            noneRiskCount++;
            console.log(`[sms] Tower "${name}" has RISK = NONE (no intersecting disaster zones). Zones:`, zones);
            return;
          }

          // Build optimization data for SMS endpoint
          const optimization_data = {};
          zones.forEach((z) => {
            const key = `${z.disaster_id}_${z.zone}`;
            optimization_data[key] = {
              eta_min: z.eta_min,
              food_quantity: z.food_quantity,
            };
          });

          // Create promise for SMS send (include zones so backend doesn't need to recalculate)
          promises.push(
            fetch(`${API_BASE}/sms/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                tower_id: id, 
                optimization_data,
                zones: zones // Send zones so backend trusts frontend's spatial calculation
              }),
            })
              .then((res) => res.json())
              .then((data) => {
                if (data.success) {
                  console.log(`[sms] Sent to tower "${name}": ${data.twilio_sid}`);
                  return { success: true, name, status: "sent" };
                } else {
                  console.log(`[sms] Skipped "${name}": ${data.status} - ${data.message}`);
                  return { success: false, name, status: data.status, message: data.message };
                }
              })
              .catch((err) => {
                console.error(`[sms] Error for "${name}":`, err);
                return { success: false, name, status: "error", message: err.message };
              })
          );
        }
      });

      if (promises.length === 0) {
        if (eligibleCount === 0) {
          showToast("No eligible towers found. Towers must contain 'Gopalpur Coast' or 'Visakhapatnam' in their name.");
        } else if (noneRiskCount > 0) {
          showToast(`${noneRiskCount} eligible tower(s) found but RISK = NONE or no zones. Check console for details.`);
        } else {
          showToast("No eligible towers with risk zones found.");
        }
        return;
      }

      // Wait for all SMS sends to complete
      const results = await Promise.all(promises);
      const sent = results.filter((r) => r.success).length;
      const skipped = results.filter((r) => !r.success && r.status !== "error").length;
      const errors = results.filter((r) => r.status === "error");

      if (sent > 0) {
        showToast(`SMS sent to ${sent} tower(s). Check console for details.`);
      } else if (skipped > 0) {
        showToast(`No SMS sent (${skipped} tower(s) skipped - check eligibility/risk).`);
      } else {
        showToast("SMS sending failed. Check console for errors.");
      }

      if (errors.length > 0) {
        console.error("[sms] Errors:", errors);
      }
    } catch (err) {
      console.error("SMS sending error:", err);
      showToast("SMS sending failed: " + err.message);
    }
  }

  function showToast(message) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(el._tid);
    el._tid = setTimeout(() => el.classList.remove("show"), 3000);
  }

  function renderDisasterSelector() {
    const container = document.getElementById("disasterSelectorItems");
    container.innerHTML = "";
    Object.keys(DISASTER_CONFIG).forEach((type) => {
      const cfg = DISASTER_CONFIG[type];
      const item = document.createElement("div");
      item.className = `disaster-selector-item ${selectedDisasterType === type ? "active" : ""}`;
      item.innerHTML = `<span class="disaster-icon">${cfg.icon}</span><span class="disaster-name">${type}</span>`;
      item.addEventListener("click", () => {
        selectedDisasterType = type;
        renderDisasterSelector();
      });
      container.appendChild(item);
    });
  }

  function initControls() {
    // Mode toggle switch
    const modeToggle = document.getElementById("viewModeToggle");
    modeToggle.addEventListener("change", function () {
      setViewMode(this.checked ? "comm" : "risk");
    });

    // Edit mode toggle
    const editToggle = document.getElementById("editModeToggle");
    editToggle.addEventListener("change", function () {
      editMode = this.checked;
      showToast(editMode ? "Edit mode: Click map to add disasters" : "View mode: Map interactions disabled");
    });

    // Severity slider
    document.getElementById("severityValue").textContent = document.getElementById("severity").value;
    document.getElementById("severity").addEventListener("input", function () {
      document.getElementById("severityValue").textContent = this.value;
    });

    // Clear button - delete all disasters from database
    document.getElementById("clearBtn").addEventListener("click", async () => {
      try {
        // First, remove all from map
        activeDisasters.forEach((d) => {
          if (d.layers) {
            disasterLayer.removeLayer(d.layers.highZone);
            disasterLayer.removeLayer(d.layers.medZone);
            disasterLayer.removeLayer(d.layers.lowZone);
            disasterLayer.removeLayer(d.layers.marker);
          }
        });
        
        // Clear local state
        activeDisasters = [];
        clearAllocation();
        
        // Delete all from database
        const response = await fetch(`${API_BASE}/disasters`, {
          method: "DELETE",
        });
        
        if (!response.ok) {
          throw new Error("Failed to delete disasters from database");
        }
        
        const data = await response.json();
        renderDashboard();
        if (viewMode === "comm") loadTowers();
        showToast(`All disasters cleared from database (${data.deleted_count || 0} deleted).`);
      } catch (err) {
        console.error("Error clearing disasters:", err);
        showToast("Failed to clear disasters: " + err.message);
      }
    });

    // Optimization button
    document.getElementById("runOptimization").addEventListener("click", runOptimization);

    // SMS button
    document.getElementById("sendSmsBtn").addEventListener("click", sendSMSAlerts);

    // Layer toggles
    document.getElementById("layerHospitals").addEventListener("change", function () {
      if (this.checked) map.addLayer(hospitalLayer);
      else map.removeLayer(hospitalLayer);
    });
    document.getElementById("layerResources").addEventListener("change", function () {
      if (this.checked) map.addLayer(resourceLayer);
      else map.removeLayer(resourceLayer);
    });
    document.getElementById("layerAllocation").addEventListener("change", function () {
      if (this.checked && viewMode === "risk") map.addLayer(allocationLayer);
      else map.removeLayer(allocationLayer);
    });

    // Dashboard collapse
    document.getElementById("toggleDashboard").addEventListener("click", function () {
      const sidebar = document.getElementById("sidebar");
      const content = document.getElementById("sidebarContent");
      const isCollapsed = sidebar.classList.contains("collapsed");
      if (isCollapsed) {
        sidebar.classList.remove("collapsed");
        content.style.display = "block";
        this.textContent = "−";
      } else {
        sidebar.classList.add("collapsed");
        content.style.display = "none";
        this.textContent = "+";
      }
    });

    // Panel collapse handlers
    document.querySelectorAll(".btn-toggle-small").forEach((btn) => {
      btn.addEventListener("click", function () {
        const targetId = this.getAttribute("data-target");
        const target = document.getElementById(targetId);
        if (target) {
          const isHidden = target.style.display === "none";
          target.style.display = isHidden ? "block" : "none";
          this.textContent = isHidden ? "−" : "+";
        }
      });
    });

    // Disaster selector
    renderDisasterSelector();
  }

  function boot() {
    initMap();
    initControls();
    setViewMode("risk");
    refreshApiData();
    renderDashboard();
    if (API_BASE) {
      refreshTimer = setInterval(refreshApiData, REFRESH_INTERVAL_MS);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
