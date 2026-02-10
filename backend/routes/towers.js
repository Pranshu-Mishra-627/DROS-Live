const express = require("express");
const { query } = require("../db");

const router = express.Router();

function riskRank(level) {
  if (level === "HIGH") return 3;
  if (level === "MED") return 2;
  if (level === "LOW") return 1;
  return 0;
}

/**
 * CRITICAL GEOMETRY RULE:
 * A tower includes a disaster ONLY IF the tower center point lies INSIDE that disaster's zone.
 * We check: distance(tower_center, disaster_center) <= zone_radius
 */
router.get("/", async (req, res, next) => {
  try {
    const towersRes = await query(
      `SELECT id, name, coverage_radius, ST_AsGeoJSON(location::geometry) AS geom,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM cell_towers
       ORDER BY id ASC`
    );

    const disastersRes = await query(
      `SELECT id, type, severity, affected_radius, evacuation_radius,
              ST_AsGeoJSON(location::geometry) AS geom
       FROM disasters
       ORDER BY id DESC`
    );

    const disasters = disastersRes.rows.map((d) => ({
      id: d.id,
      type: d.type,
      severity: d.severity,
      affected_radius: Number(d.affected_radius),
      evacuation_radius: Number(d.evacuation_radius),
    }));

    // For each tower-disaster pair, compute distance and check zone membership
    const pairsRes = disasters.length
      ? await query(
          `SELECT t.id AS tower_id, d.id AS disaster_id, ST_Distance(t.location, d.location) AS meters
           FROM cell_towers t
           CROSS JOIN disasters d`
        )
      : { rows: [] };

    const distByTower = new Map();
    for (const r of pairsRes.rows) {
      const arr = distByTower.get(r.tower_id) || [];
      arr.push({ disaster_id: r.disaster_id, meters: Number(r.meters) });
      distByTower.set(r.tower_id, arr);
    }

    const features = towersRes.rows.map((t) => {
      const towerId = t.id;
      const towerName = t.name;
      const coverageRadius = Number(t.coverage_radius);
      const lat = Number(t.lat);
      const lng = Number(t.lng);

      const zones = [];
      const pairs = distByTower.get(towerId) || [];

      // CRITICAL: Tower point must be INSIDE the zone (not just circle overlap)
      for (const p of pairs) {
        const d = disasters.find((x) => x.id === p.disaster_id);
        if (!d) continue;

        const highR = d.affected_radius * 0.5;
        const midR = d.affected_radius;
        const lowR = d.evacuation_radius;
        const distM = p.meters;

        // Check if tower center is INSIDE each zone (innermost zone wins)
        let zone = "NONE";
        if (distM <= highR) {
          zone = "HIGH";
        } else if (distM <= midR) {
          zone = "MED";
        } else if (distM <= lowR) {
          zone = "LOW";
        }

        // Only include if tower is actually inside a zone
        if (zone !== "NONE") {
          // Deduplicate: check if this (disaster_id, zone) already exists
          const exists = zones.some((z) => z.disaster_id === d.id && z.zone === zone);
          if (!exists) {
            zones.push({
              disaster_id: d.id,
              disaster_type: d.type,
              zone,
            });
          }
        }
      }

      // Determine highest risk level
      const best = zones.length ? zones.reduce((a, b) => (riskRank(b.zone) > riskRank(a.zone) ? b : a), zones[0]) : null;
      const risk_level = best ? best.zone : "NONE";

      return {
        type: "Feature",
        geometry: JSON.parse(t.geom),
        properties: {
          id: towerId,
          name: towerName,
          coverage_radius: coverageRadius,
          lat,
          lng,
          risk_level,
          zones, // Array of { disaster_id, disaster_type, zone }
        },
      };
    });

    res.json({ type: "FeatureCollection", features });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
