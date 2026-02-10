const express = require("express");
const { query } = require("../db");

const router = express.Router();

// Disaster geometry: affected_radius = base + (max-base)*(S/5), evacuation = 1.5*affected
const DISASTER_CONFIG = {
  Flood: { base: 30000, max: 120000 },
  Cyclone: { base: 60000, max: 450000 },
  Earthquake: { base: 40000, max: 200000 },
  Wildfire: { base: 25000, max: 100000 },
  Tsunami: { base: 120000, max: 600000 },
};

function computeRadii(type, severity) {
  const cfg = DISASTER_CONFIG[type] || DISASTER_CONFIG.Flood;
  const S = Math.min(5, Math.max(1, Number(severity) || 1));
  const affected = cfg.base + (cfg.max - cfg.base) * (S / 5);
  const evacuation = 1.5 * affected;
  return { affected, evacuation };
}

// Zone radii (non-overlapping): HIGH inner, MED ring, LOW ring
// HIGH = 0.5*affected, MED = affected (ring), LOW = evacuation (ring)
function getZoneRadiiM(affectedRadius, evacuationRadius) {
  return {
    HIGH: affectedRadius * 0.5,
    MED: affectedRadius,
    LOW: evacuationRadius,
  };
}

// Physical capacity per unit (conservative early-response)
const CAP_PER_UNIT = { ambulance: 6, rescue_teams: 50, helicopters: 15, food: 1 };

// Zone effectiveness weights (usefulness)
const ZONE_WEIGHTS = {
  HIGH: { ambulance: 1.0, rescue_teams: 1.0, helicopters: 1.0, food: 0.3 },
  MED: { ambulance: 0.7, rescue_teams: 0.8, helicopters: 0.3, food: 0.7 },
  LOW: { ambulance: 0.3, rescue_teams: 0.4, helicopters: 0.0, food: 1.0 },
};

// ETA: (distance_km / speed_km_per_hr) * 60. Road=50, Air=200
function etaMinutes(distanceKm, mode) {
  const speed = mode === "air" || mode === "helicopter" ? 200 : 50;
  return (distanceKm / speed) * 60;
}

// Point at distance `radiusM` from (lat,lng) in direction of (toLat, toLng) (bearing)
function pointAtDistance(lat, lng, toLat, toLng, radiusM) {
  const R = 6371000; // meters
  const d = radiusM / R;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const lat2 = (toLat * Math.PI) / 180;
  const lng2 = (toLng * Math.PI) / 180;
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  const brng = Math.atan2(y, x);
  const latOut = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lngOut = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(latOut));
  return { lat: (latOut * 180) / Math.PI, lng: (lngOut * 180) / Math.PI };
}

// zone_population_Z = Σ population where ST_DWithin(disaster_location, zone_boundary_Z)
async function getZonePopulations(disasterLocation, affectedRadius, evacuationRadius) {
  const r = getZoneRadiiM(affectedRadius, evacuationRadius);
  const [highRes, medRes, lowRes] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(population), 0) AS pop FROM population_zones
       WHERE ST_DWithin($1::geography, boundary, $2)`,
      [disasterLocation, r.HIGH]
    ),
    query(
      `SELECT COALESCE(SUM(population), 0) AS pop FROM population_zones
       WHERE ST_DWithin($1::geography, boundary, $2)
         AND NOT ST_DWithin($1::geography, boundary, $3)`,
      [disasterLocation, r.MED, r.HIGH]
    ),
    query(
      `SELECT COALESCE(SUM(population), 0) AS pop FROM population_zones
       WHERE ST_DWithin($1::geography, boundary, $2)
         AND NOT ST_DWithin($1::geography, boundary, $3)`,
      [disasterLocation, r.LOW, r.MED]
    ),
  ]);
  return {
    HIGH: Math.round(Number(highRes.rows[0]?.pop || 0)),
    MED: Math.round(Number(medRes.rows[0]?.pop || 0)),
    LOW: Math.round(Number(lowRes.rows[0]?.pop || 0)),
  };
}

async function getLatestDisasterByIdOrLast(id) {
  if (id) {
    const { rows } = await query("SELECT * FROM disasters WHERE id = $1", [id]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await query("SELECT * FROM disasters ORDER BY id DESC LIMIT 1");
  return rows[0] || null;
}

router.post("/disaster", async (req, res, next) => {
  try {
    const { type, severity, lat, lng } = req.body || {};
    if (!type || lat == null || lng == null) {
      return res.status(400).json({ error: "invalid_input", message: "type, lat, lng are required" });
    }
    const S = Math.min(5, Math.max(1, Number(severity) || 1));
    const { affected, evacuation } = computeRadii(type, S);

    const { rows } = await query(
      `INSERT INTO disasters (type, severity, location, affected_radius, evacuation_radius)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)
       RETURNING id, type, severity, affected_radius, evacuation_radius, ST_AsGeoJSON(location::geometry) AS geom`,
      [type, S, lng, lat, affected, evacuation]
    );

    const d = rows[0];
    res.status(201).json({
      type: "Feature",
      geometry: JSON.parse(d.geom),
      properties: {
        id: d.id,
        type: d.type,
        severity: d.severity,
        affected_radius: Number(d.affected_radius),
        evacuation_radius: Number(d.evacuation_radius),
      },
    });
  } catch (err) {
    next(err);
  }
});

async function runOptimizeForDisaster(disaster) {
  if (!disaster) return null;
  try {
    const dId = disaster.id;
    const type = disaster.type;
    const severity = disaster.severity;
    const affectedRadius = Number(disaster.affected_radius);
    const evacuationRadius = Number(disaster.evacuation_radius);
    const disasterLocation = disaster.location;

    const geom = await query(
      `SELECT ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat FROM disasters WHERE id = $1`,
      [dId]
    );
    const epicenterLat = Number(geom.rows[0].lat);
    const epicenterLng = Number(geom.rows[0].lng);
    const zoneRadii = getZoneRadiiM(affectedRadius, evacuationRadius);

    const zonePops = await getZonePopulations(disasterLocation, affectedRadius, evacuationRadius);
    const totalPop = zonePops.HIGH + zonePops.MED + zonePops.LOW;

    if (totalPop === 0) {
      return {
        disaster_id: dId,
        type,
        severity,
        population_at_risk: 0,
        total_people_served: 0,
        lives_saved_estimate: 0,
        message: "Disaster epicenter is in ocean or unpopulated area. No resource allocation.",
        allocations: [],
        zones: { HIGH: [], MED: [], LOW: [] },
        zone_populations: zonePops,
      };
    }

    // Hospitals: exclude those inside HIGH or MED zone (destroyed)
    const hospitalsRes = await query(
      `SELECT h.id, h.name, h.capacity, COALESCE(h.ambulances, 0) AS ambulances,
              ST_Distance($1, h.location) AS meters,
              ST_Y(h.location::geometry) AS lat, ST_X(h.location::geometry) AS lng,
              ST_AsGeoJSON(h.location::geometry) AS geom
       FROM hospitals h
       WHERE ST_Distance($1, h.location) > $2
       ORDER BY ST_Distance($1, h.location) ASC`,
      [disasterLocation, zoneRadii.MED]
    );

    const resourcesRes = await query(
      `SELECT r.id, r.type, r.quantity,
              ST_Distance($1, r.location) AS meters,
              ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng,
              ST_AsGeoJSON(r.location::geometry) AS geom
       FROM resources r
       ORDER BY ST_Distance($1, r.location) ASC`,
      [disasterLocation]
    );

    const hospitals = hospitalsRes.rows.map((h) => ({
      id: h.id,
      name: h.name,
      capacity: h.capacity,
      ambulances: Math.max(0, Number(h.ambulances) || Math.floor(h.capacity / 15)),
      distance_km: Number(h.meters) / 1000,
      lat: Number(h.lat),
      lng: Number(h.lng),
      geom: JSON.parse(h.geom),
    }));

    const resources = resourcesRes.rows.map((r) => ({
      id: r.id,
      type: r.type,
      quantity: r.quantity,
      distance_km: Number(r.meters) / 1000,
      lat: Number(r.lat),
      lng: Number(r.lng),
      geom: JSON.parse(r.geom),
    }));

    const usedH = {};
    const usedR = {};
    const zoneAllocs = { HIGH: [], MED: [], LOW: [] };

    function allocOne(zone, resourceType, source, quantity, mode, sourceName) {
      const cap = CAP_PER_UNIT[resourceType];
      const w = ZONE_WEIGHTS[zone][resourceType];
      const effectiveCap = quantity * cap * w;
      const etaMin = etaMinutes(source.distance_km, mode);
      const zoneRadius = zoneRadii[zone];
      const target = pointAtDistance(epicenterLat, epicenterLng, source.lat, source.lng, zoneRadius);
      const rec = {
        resource: resourceType,
        source_type: source.hospital ? "hospital" : "resource",
        source_id: source.id,
        source_name: sourceName || `Resource ${source.id}`,
        quantity,
        distance_km: Number(source.distance_km.toFixed(1)),
        mode: mode === "helicopter" ? "helicopter" : "road",
        eta_min: Math.round(etaMin),
        zone,
        effective_capacity: Math.round(effectiveCap),
        source_geom: source.geom,
        zone_target: { lat: target.lat, lng: target.lng },
      };
      zoneAllocs[zone].push(rec);
      return rec;
    }

    const needHigh = { ambulance: Math.min(30, 4 + severity * 5), rescue_teams: Math.min(10, 2 + severity * 2), helicopters: severity >= 4 ? Math.min(5, Math.ceil(severity / 2)) : 0, food: Math.min(5000, severity * 800) };
    const needMed = { ambulance: Math.min(25, 3 + severity * 4), rescue_teams: Math.min(8, 1 + severity * 2), helicopters: 0, food: Math.min(4000, severity * 600) };
    const needLow = { ambulance: Math.min(15, 2 + severity * 2), rescue_teams: Math.min(4, severity), helicopters: 0, food: Math.min(3000, severity * 400) };

    const helicopters = resources.filter((r) => r.type === "helicopters");
    const rescueTeams = resources.filter((r) => r.type === "rescue_teams");
    const foodRes = resources.filter((r) => r.type === "food");

    let hA = needHigh.ambulance, hR = needHigh.rescue_teams, hH = needHigh.helicopters, hF = needHigh.food;
    for (const heli of helicopters) {
      if (hH <= 0) break;
      const take = Math.min(heli.quantity - (usedR[heli.id] || 0), hH);
      if (take <= 0) continue;
      usedR[heli.id] = (usedR[heli.id] || 0) + take;
      hH -= take;
      allocOne("HIGH", "helicopters", heli, take, "helicopter", null);
    }
    for (const h of hospitals) {
      if (hA <= 0) break;
      const avail = Math.min(h.ambulances - (usedH[h.id] || 0), hA);
      if (avail <= 0) continue;
      usedH[h.id] = (usedH[h.id] || 0) + avail;
      hA -= avail;
      allocOne("HIGH", "ambulance", h, avail, "road", h.name);
    }
    for (const r of rescueTeams) {
      if (hR <= 0) break;
      const take = Math.min(r.quantity - (usedR[r.id] || 0), hR);
      if (take <= 0) continue;
      usedR[r.id] = (usedR[r.id] || 0) + take;
      hR -= take;
      allocOne("HIGH", "rescue_teams", r, take, r.distance_km > 100 ? "helicopter" : "road", null);
    }
    for (const f of foodRes) {
      if (hF <= 0) break;
      const take = Math.min(f.quantity - (usedR[f.id] || 0), hF);
      if (take <= 0) continue;
      usedR[f.id] = (usedR[f.id] || 0) + take;
      hF -= take;
      allocOne("HIGH", "food", f, take, f.distance_km > 80 ? "helicopter" : "road", null);
    }

    let mA = needMed.ambulance, mR = needMed.rescue_teams, mF = needMed.food;
    for (const h of hospitals) {
      if (mA <= 0) break;
      const avail = Math.min(h.ambulances - (usedH[h.id] || 0), mA);
      if (avail <= 0) continue;
      usedH[h.id] = (usedH[h.id] || 0) + avail;
      mA -= avail;
      allocOne("MED", "ambulance", h, avail, "road", h.name);
    }
    for (const r of rescueTeams) {
      if (mR <= 0) break;
      const take = Math.min(r.quantity - (usedR[r.id] || 0), mR);
      if (take <= 0) continue;
      usedR[r.id] = (usedR[r.id] || 0) + take;
      mR -= take;
      allocOne("MED", "rescue_teams", r, take, "road", null);
    }
    for (const f of foodRes) {
      if (mF <= 0) break;
      const take = Math.min(f.quantity - (usedR[f.id] || 0), mF);
      if (take <= 0) continue;
      usedR[f.id] = (usedR[f.id] || 0) + take;
      mF -= take;
      allocOne("MED", "food", f, take, f.distance_km > 150 ? "helicopter" : "road", null);
    }

    let lA = needLow.ambulance, lF = needLow.food;
    for (const h of hospitals.slice(-5)) {
      if (lA <= 0) break;
      const avail = Math.min(Math.max(0, h.ambulances - (usedH[h.id] || 0)), lA);
      if (avail <= 0) continue;
      usedH[h.id] = (usedH[h.id] || 0) + avail;
      lA -= avail;
      allocOne("LOW", "ambulance", h, avail, "road", h.name);
    }
    for (const f of foodRes) {
      if (lF <= 0) break;
      const take = Math.min(f.quantity - (usedR[f.id] || 0), lF);
      if (take <= 0) continue;
      usedR[f.id] = (usedR[f.id] || 0) + take;
      lF -= take;
      allocOne("LOW", "food", f, take, "road", null);
    }

    function zoneCapacity(zone) {
      const arr = zoneAllocs[zone];
      let cap = 0;
      for (const a of arr) {
        const w = ZONE_WEIGHTS[zone][a.resource];
        const c = CAP_PER_UNIT[a.resource];
        cap += a.quantity * c * w;
      }
      return cap;
    }

    const capacityHIGH = zoneCapacity("HIGH");
    const capacityMED = zoneCapacity("MED");
    const capacityLOW = zoneCapacity("LOW");

    const peopleServedHIGH = Math.min(zonePops.HIGH, capacityHIGH);
    const peopleServedMED = Math.min(zonePops.MED, capacityMED);
    const peopleServedLOW = Math.min(zonePops.LOW, capacityLOW);

    const totalPeopleServed = peopleServedHIGH + peopleServedMED + peopleServedLOW;

    const allAllocs = [...zoneAllocs.HIGH, ...zoneAllocs.MED, ...zoneAllocs.LOW];
    const avgEta = allAllocs.length ? allAllocs.reduce((s, a) => s + a.eta_min, 0) / allAllocs.length : 0;
    const timeFactor = Math.max(0.3, 1 - avgEta / 600);
    const severityFactor = severity / 5;
    let livesSaved = Math.round(totalPeopleServed * severityFactor * timeFactor);
    livesSaved = Math.min(livesSaved, totalPeopleServed);
    livesSaved = Math.max(0, livesSaved);

    const peopleServedByZone = { HIGH: peopleServedHIGH, MED: peopleServedMED, LOW: peopleServedLOW };
    const capByZone = { HIGH: capacityHIGH, MED: capacityMED, LOW: capacityLOW };

    for (const z of ["HIGH", "MED", "LOW"]) {
      const zoneCap = capByZone[z];
      const zoneServed = peopleServedByZone[z];
      for (const a of zoneAllocs[z]) {
        const w = ZONE_WEIGHTS[z][a.resource];
        const c = CAP_PER_UNIT[a.resource];
        const contrib = a.quantity * c * w;
        a.people_served = zoneCap > 0 ? Math.round((contrib / zoneCap) * zoneServed) : 0;
      }
    }

    return {
      disaster_id: dId,
      type,
      severity,
      population_at_risk: totalPop,
      zone_populations: zonePops,
      total_people_served: totalPeopleServed,
      people_served_by_zone: peopleServedByZone,
      capacity_by_zone: { HIGH: capacityHIGH, MED: capacityMED, LOW: capacityLOW },
      estimated_response_time_min: Math.round(avgEta),
      time_factor: Math.round(timeFactor * 100) / 100,
      severity_factor: severityFactor,
      lives_saved_estimate: livesSaved,
      allocations: allAllocs.filter((a) => a.people_served > 0),
      zones: zoneAllocs,
      epicenter: { lat: epicenterLat, lng: epicenterLng },
      zone_radii_m: zoneRadii,
    };
  } catch (err) {
    console.error("[optimize] Error for disaster:", disaster.id, err);
    return null;
  }
}

router.post("/optimize", async (req, res, next) => {
  try {
    const { disaster_id: requestedId, disaster_ids: requestedIds } = req.body || {};
    const ids = Array.isArray(requestedIds) && requestedIds.length > 0
      ? requestedIds
      : requestedId != null ? [requestedId] : null;

    if (ids && ids.length > 0) {
      const results = [];
      for (const id of ids) {
        const disaster = await getLatestDisasterByIdOrLast(id);
        const one = await runOptimizeForDisaster(disaster);
        if (one) results.push(one);
      }
      if (results.length === 0) {
        return res.status(400).json({ error: "no_disaster", message: "No valid disasters found." });
      }
      return res.json(results.length === 1 ? results[0] : { results });
    }

    const disaster = await getLatestDisasterByIdOrLast(requestedId);
    if (!disaster) {
      return res.status(400).json({ error: "no_disaster", message: "No disasters found in database." });
    }
    const one = await runOptimizeForDisaster(disaster);
    return res.json(one);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
