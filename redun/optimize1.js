const express = require("express");
const { query } = require("../db");

const router = express.Router();

// Disaster config: base + max radii (meters) for severity scaling
const DISASTER_CONFIG = {
  Flood: { base: 30000, max: 120000 },
  Cyclone: { base: 60000, max: 450000 },
  Earthquake: { base: 40000, max: 200000 },
  Wildfire: { base: 25000, max: 100000 },
  Tsunami: { base: 120000, max: 600000 },
};

function computeRadii(type, severity) {
  const cfg = DISASTER_CONFIG[type] || DISASTER_CONFIG.Flood;
  const sev = Math.min(5, Math.max(1, Number(severity) || 1));
  const f = sev / 5;
  const affected = cfg.base + (cfg.max - cfg.base) * f;
  const evacuation = affected * 1.5;
  return { affected, evacuation };
}

// Three-tier risk zones
function getZoneRadii(affectedRadius, evacuationRadius) {
  return {
    HIGH: affectedRadius * 0.5, // Inner 50% of affected zone
    MED: affectedRadius, // Full affected zone
    LOW: evacuationRadius, // Evacuation zone
  };
}

// Check if disaster impacts land (has population)
async function checkLandImpact(disasterLocation, affectedRadius) {
  const { rows } = await query(
    `SELECT SUM(population) AS total_pop
     FROM population_zones
     WHERE ST_DWithin($1::geography, boundary, $2)`,
    [disasterLocation, affectedRadius]
  );
  const pop = Number(rows[0]?.total_pop || 0);
  return { hasLandImpact: pop > 0, population: pop };
}

// Get population in each zone
async function getZonePopulations(disasterLocation, affectedRadius, evacuationRadius) {
  const zones = getZoneRadii(affectedRadius, evacuationRadius);
  const [highRes, medRes, lowRes] = await Promise.all([
    query(
      `SELECT SUM(population) AS pop FROM population_zones
       WHERE ST_DWithin($1::geography, boundary, $2)`,
      [disasterLocation, zones.HIGH]
    ),
    query(
      `SELECT SUM(population) AS pop FROM population_zones
       WHERE ST_DWithin($1::geography, boundary, $2) AND NOT ST_DWithin($1::geography, boundary, $3)`,
      [disasterLocation, zones.MED, zones.HIGH]
    ),
    query(
      `SELECT SUM(population) AS pop FROM population_zones
       WHERE ST_DWithin($1::geography, boundary, $2) AND NOT ST_DWithin($1::geography, boundary, $3)`,
      [disasterLocation, zones.LOW, zones.MED]
    ),
  ]);
  return {
    HIGH: Number(highRes.rows[0]?.pop || 0),
    MED: Number(medRes.rows[0]?.pop || 0),
    LOW: Number(lowRes.rows[0]?.pop || 0),
  };
}

// Fractional greedy allocation: distribute resources fairly across zones based on population
function fractionalGreedyAllocation(totalNeed, zonePops, totalPop) {
  if (totalPop === 0) return { HIGH: 0, MED: 0, LOW: 0 };
  const allocations = {
    HIGH: Math.round((totalNeed * zonePops.HIGH) / totalPop),
    MED: Math.round((totalNeed * zonePops.MED) / totalPop),
    LOW: Math.round((totalNeed * zonePops.LOW) / totalPop),
  };
  // Ensure we don't exceed total need
  const sum = allocations.HIGH + allocations.MED + allocations.LOW;
  if (sum > totalNeed) {
    const diff = sum - totalNeed;
    if (allocations.LOW >= diff) allocations.LOW -= diff;
    else if (allocations.MED >= diff - allocations.LOW) {
      allocations.MED -= diff - allocations.LOW;
      allocations.LOW = 0;
    }
  }
  return allocations;
}

async function getLatestDisasterByIdOrLast(id) {
  if (id) {
    const { rows } = await query("SELECT * FROM disasters WHERE id = $1", [id]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await query("SELECT * FROM disasters ORDER BY id DESC LIMIT 1");
  return rows[0] || null;
}

// POST /api/disaster
router.post("/disaster", async (req, res, next) => {
  try {
    const { type, severity, lat, lng } = req.body || {};
    if (!type || lat == null || lng == null) {
      return res.status(400).json({ error: "invalid_input", message: "type, lat, lng are required" });
    }
    const sev = Math.min(5, Math.max(1, Number(severity) || 1));
    const { affected, evacuation } = computeRadii(type, sev);

    const { rows } = await query(
      `INSERT INTO disasters (type, severity, location, affected_radius, evacuation_radius)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)
       RETURNING id, type, severity, affected_radius, evacuation_radius, ST_AsGeoJSON(location::geometry) AS geom`,
      [type, sev, lng, lat, affected, evacuation]
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

// POST /api/optimize
router.post("/optimize", async (req, res, next) => {
  try {
    const { disaster_id: requestedId } = req.body || {};
    const disaster = await getLatestDisasterByIdOrLast(requestedId);
    if (!disaster) {
      return res.status(400).json({ error: "no_disaster", message: "No disasters found in database." });
    }

    const dId = disaster.id;
    const type = disaster.type;
    const severity = disaster.severity;
    const affectedRadius = Number(disaster.affected_radius);
    const evacuationRadius = Number(disaster.evacuation_radius);
    const disasterLocation = disaster.location;

    // Check if disaster impacts land
    const landCheck = await checkLandImpact(disasterLocation, affectedRadius);
    if (!landCheck.hasLandImpact) {
      return res.json({
        disaster_id: dId,
        type,
        severity,
        population_estimate: 0,
        message: "Disaster epicenter is in ocean or unpopulated area. No resource allocation needed.",
        allocations: [],
        zones: { HIGH: [], MED: [], LOW: [] },
      });
    }

    // Get zone populations
    const zonePops = await getZonePopulations(disasterLocation, affectedRadius, evacuationRadius);
    const totalPop = zonePops.HIGH + zonePops.MED + zonePops.LOW;

    // Compute needs per zone using fractional greedy
    const totalNeedAmb = Math.min(40, 5 + severity * 6);
    const totalNeedTeams = Math.min(15, 2 + severity * 3);
    const totalNeedFood = severity * 3000;
    const totalNeedHeli = severity >= 4 ? Math.min(5, Math.ceil(severity / 2)) : 0;

    const zoneNeeds = {
      HIGH: {
        ambulances: Math.max(1, Math.ceil(totalNeedAmb * 0.5)), // HIGH gets priority
        rescue_teams: Math.max(1, Math.ceil(totalNeedTeams * 0.5)),
        food: Math.max(500, Math.ceil(totalNeedFood * 0.3)),
        helicopters: totalNeedHeli, // Only HIGH risk uses helicopters
      },
      MED: {
        ambulances: Math.max(0, Math.floor(totalNeedAmb * 0.35)),
        rescue_teams: Math.max(0, Math.floor(totalNeedTeams * 0.35)),
        food: Math.max(500, Math.ceil(totalNeedFood * 0.4)),
        helicopters: 0,
      },
      LOW: {
        ambulances: Math.max(0, Math.floor(totalNeedAmb * 0.15)),
        rescue_teams: Math.max(0, Math.floor(totalNeedTeams * 0.15)),
        food: Math.max(500, Math.ceil(totalNeedFood * 0.3)),
        helicopters: 0,
      },
    };

    // Get hospitals and resources with distances
    const hospitalsRes = await query(
      `SELECT h.id, h.name, h.capacity,
              ST_Distance($1, h.location) AS meters,
              ST_AsGeoJSON(h.location::geometry) AS geom
       FROM hospitals h
       ORDER BY ST_Distance($1, h.location) ASC`,
      [disasterLocation]
    );

    const resourcesRes = await query(
      `SELECT r.id, r.type, r.quantity,
              ST_Distance($1, r.location) AS meters,
              ST_AsGeoJSON(r.location::geometry) AS geom
       FROM resources r
       ORDER BY ST_Distance($1, r.location) ASC`,
      [disasterLocation]
    );

    const hospitals = hospitalsRes.rows.map((h) => ({
      id: h.id,
      name: h.name,
      capacity: h.capacity,
      distance_km: Number(h.meters) / 1000,
      geom: JSON.parse(h.geom),
    }));

    const resources = resourcesRes.rows.map((r) => ({
      id: r.id,
      type: r.type,
      quantity: r.quantity,
      distance_km: Number(r.meters) / 1000,
      geom: JSON.parse(r.geom),
    }));

    function etaMinutes(distanceKm, mode) {
      const speed = mode === "air" || mode === "helicopter" ? 200 : 50;
      return (distanceKm / speed) * 60;
    }

    // Track used resources
    const used = {
      hospitals: {},
      resources: {},
    };

    const zoneAllocations = { HIGH: [], MED: [], LOW: [] };

    // Allocate to HIGH risk zone (priority: helicopters, ambulances, rescue, food)
    const highNeeds = zoneNeeds.HIGH;
    let highAmb = highNeeds.ambulances;
    let highTeams = highNeeds.rescue_teams;
    let highFood = highNeeds.food;
    let highHeli = highNeeds.helicopters;

    // Helicopters for HIGH risk (air evacuation)
    const helicopters = resources.filter((r) => r.type === "helicopters");
    for (const heli of helicopters) {
      if (highHeli <= 0) break;
      const available = heli.quantity - (used.resources[heli.id] || 0);
      const take = Math.min(available, highHeli);
      if (take <= 0) continue;
      used.resources[heli.id] = (used.resources[heli.id] || 0) + take;
      highHeli -= take;
      const etaMin = etaMinutes(heli.distance_km, "helicopter");
      zoneAllocations.HIGH.push({
        resource: "helicopters",
        source_type: "resource",
        source_id: heli.id,
        quantity: take,
        distance_km: Number(heli.distance_km.toFixed(1)),
        mode: "helicopter",
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.HIGH * 0.1 * take), // Estimate
        zone: "HIGH",
        source_geom: heli.geom,
      });
    }

    // Ambulances for HIGH risk (nearest hospitals)
    for (const h of hospitals) {
      if (highAmb <= 0) break;
      const maxAmb = Math.max(2, Math.floor(h.capacity / 20));
      const available = maxAmb - (used.hospitals[h.id] || 0);
      const take = Math.min(available, highAmb);
      if (take <= 0) continue;
      used.hospitals[h.id] = (used.hospitals[h.id] || 0) + take;
      highAmb -= take;
      const etaMin = etaMinutes(h.distance_km, "road");
      zoneAllocations.HIGH.push({
        resource: "ambulance",
        source_type: "hospital",
        source_id: h.id,
        source_name: h.name,
        quantity: take,
        distance_km: Number(h.distance_km.toFixed(1)),
        mode: "road",
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.HIGH * 0.05 * take),
        zone: "HIGH",
        source_geom: h.geom,
      });
    }

    // Rescue teams for HIGH risk
    const rescueTeams = resources.filter((r) => r.type === "rescue_teams");
    for (const team of rescueTeams) {
      if (highTeams <= 0) break;
      const available = team.quantity - (used.resources[team.id] || 0);
      const take = Math.min(available, highTeams);
      if (take <= 0) continue;
      used.resources[team.id] = (used.resources[team.id] || 0) + take;
      highTeams -= take;
      const mode = team.distance_km > 100 ? "helicopter" : "road";
      const etaMin = etaMinutes(team.distance_km, mode);
      zoneAllocations.HIGH.push({
        resource: "rescue_teams",
        source_type: "resource",
        source_id: team.id,
        quantity: take,
        distance_km: Number(team.distance_km.toFixed(1)),
        mode,
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.HIGH * 0.08 * take),
        zone: "HIGH",
        source_geom: team.geom,
      });
    }

    // Food for HIGH risk (helicopters if far, road if near)
    const foodRes = resources.filter((r) => r.type === "food");
    for (const food of foodRes) {
      if (highFood <= 0) break;
      const available = food.quantity - (used.resources[food.id] || 0);
      const take = Math.min(available, highFood);
      if (take <= 0) continue;
      used.resources[food.id] = (used.resources[food.id] || 0) + take;
      highFood -= take;
      const mode = food.distance_km > 80 ? "helicopter" : "road";
      const etaMin = etaMinutes(food.distance_km, mode);
      zoneAllocations.HIGH.push({
        resource: "food",
        source_type: "resource",
        source_id: food.id,
        quantity: take,
        distance_km: Number(food.distance_km.toFixed(1)),
        mode,
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.HIGH * 0.02 * take),
        zone: "HIGH",
        source_geom: food.geom,
      });
    }

    // Allocate to MED risk zone
    const medNeeds = zoneNeeds.MED;
    let medAmb = medNeeds.ambulances;
    let medTeams = medNeeds.rescue_teams;
    let medFood = medNeeds.food;

    // Ambulances for MED (farther hospitals OK)
    for (const h of hospitals.slice(Math.floor(hospitals.length * 0.3))) {
      if (medAmb <= 0) break;
      const maxAmb = Math.max(1, Math.floor(h.capacity / 25));
      const available = maxAmb - (used.hospitals[h.id] || 0);
      const take = Math.min(available, medAmb);
      if (take <= 0) continue;
      used.hospitals[h.id] = (used.hospitals[h.id] || 0) + take;
      medAmb -= take;
      const etaMin = etaMinutes(h.distance_km, "road");
      zoneAllocations.MED.push({
        resource: "ambulance",
        source_type: "hospital",
        source_id: h.id,
        source_name: h.name,
        quantity: take,
        distance_km: Number(h.distance_km.toFixed(1)),
        mode: "road",
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.MED * 0.03 * take),
        zone: "MED",
        source_geom: h.geom,
      });
    }

    // Rescue teams for MED
    for (const team of rescueTeams) {
      if (medTeams <= 0) break;
      const available = team.quantity - (used.resources[team.id] || 0);
      const take = Math.min(available, medTeams);
      if (take <= 0) continue;
      used.resources[team.id] = (used.resources[team.id] || 0) + take;
      medTeams -= take;
      const etaMin = etaMinutes(team.distance_km, "road");
      zoneAllocations.MED.push({
        resource: "rescue_teams",
        source_type: "resource",
        source_id: team.id,
        quantity: take,
        distance_km: Number(team.distance_km.toFixed(1)),
        mode: "road",
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.MED * 0.05 * take),
        zone: "MED",
        source_geom: team.geom,
      });
    }

    // Food for MED (helicopters only if very far)
    for (const food of foodRes) {
      if (medFood <= 0) break;
      const available = food.quantity - (used.resources[food.id] || 0);
      const take = Math.min(available, medFood);
      if (take <= 0) continue;
      used.resources[food.id] = (used.resources[food.id] || 0) + take;
      medFood -= take;
      const mode = food.distance_km > 150 ? "helicopter" : "road";
      const etaMin = etaMinutes(food.distance_km, mode);
      zoneAllocations.MED.push({
        resource: "food",
        source_type: "resource",
        source_id: food.id,
        quantity: take,
        distance_km: Number(food.distance_km.toFixed(1)),
        mode,
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.MED * 0.015 * take),
        zone: "MED",
        source_geom: food.geom,
      });
    }

    // Allocate to LOW risk zone (food priority, minimal medical)
    const lowNeeds = zoneNeeds.LOW;
    let lowAmb = lowNeeds.ambulances;
    let lowFood = lowNeeds.food;

    // Minimal ambulances for LOW
    for (const h of hospitals.slice(-3)) {
      if (lowAmb <= 0) break;
      const available = Math.max(1, Math.floor(h.capacity / 30)) - (used.hospitals[h.id] || 0);
      const take = Math.min(available, lowAmb);
      if (take <= 0) continue;
      used.hospitals[h.id] = (used.hospitals[h.id] || 0) + take;
      lowAmb -= take;
      const etaMin = etaMinutes(h.distance_km, "road");
      zoneAllocations.LOW.push({
        resource: "ambulance",
        source_type: "hospital",
        source_id: h.id,
        source_name: h.name,
        quantity: take,
        distance_km: Number(h.distance_km.toFixed(1)),
        mode: "road",
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.LOW * 0.02 * take),
        zone: "LOW",
        source_geom: h.geom,
      });
    }

    // Food for LOW (road only)
    for (const food of foodRes) {
      if (lowFood <= 0) break;
      const available = food.quantity - (used.resources[food.id] || 0);
      const take = Math.min(available, lowFood);
      if (take <= 0) continue;
      used.resources[food.id] = (used.resources[food.id] || 0) + take;
      lowFood -= take;
      const etaMin = etaMinutes(food.distance_km, "road");
      zoneAllocations.LOW.push({
        resource: "food",
        source_type: "resource",
        source_id: food.id,
        quantity: take,
        distance_km: Number(food.distance_km.toFixed(1)),
        mode: "road",
        eta_min: Math.round(etaMin),
        people_served: Math.round(zonePops.LOW * 0.01 * take),
        zone: "LOW",
        source_geom: food.geom,
      });
    }

    // Compute summary stats
    const allAllocs = [...zoneAllocations.HIGH, ...zoneAllocations.MED, ...zoneAllocations.LOW];
    const avgEta = allAllocs.length > 0 ? allAllocs.reduce((s, a) => s + a.eta_min, 0) / allAllocs.length : 0;
    const totalPeopleServed = allAllocs.reduce((s, a) => s + (a.people_served || 0), 0);
    const livesSaved = Math.round((totalPeopleServed * severity) / (avgEta + 1));

    res.json({
      disaster_id: dId,
      type,
      severity,
      population_estimate: totalPop,
      zone_populations: zonePops,
      assigned_ambulances: allAllocs.filter((a) => a.resource === "ambulance").reduce((s, a) => s + a.quantity, 0),
      assigned_helicopters: allAllocs.filter((a) => a.resource === "helicopters").reduce((s, a) => s + a.quantity, 0),
      estimated_response_time: Math.round(avgEta),
      lives_saved_estimate: livesSaved,
      total_people_served: totalPeopleServed,
      allocations: allAllocs,
      zones: zoneAllocations,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
