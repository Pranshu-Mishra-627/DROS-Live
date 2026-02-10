const express = require("express");
const { query } = require("../db");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         id,
         name,
         capacity,
         COALESCE(ambulances, 0) AS ambulances,
         ST_AsGeoJSON(location::geometry) AS geom
       FROM hospitals
       ORDER BY id ASC`
    );

    res.json({
      type: "FeatureCollection",
      features: rows.map((r) => ({
        type: "Feature",
        geometry: JSON.parse(r.geom),
        properties: {
          id: r.id,
          name: r.name,
          capacity: r.capacity,
          ambulances: Number(r.ambulances) || 0,
        },
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

