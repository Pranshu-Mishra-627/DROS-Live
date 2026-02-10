const express = require("express");
const { query } = require("../db");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         id,
         type,
         quantity,
         ST_AsGeoJSON(location::geometry) AS geom
       FROM resources
       ORDER BY id ASC`
    );

    res.json({
      type: "FeatureCollection",
      features: rows.map((r) => ({
        type: "Feature",
        geometry: JSON.parse(r.geom),
        properties: {
          id: r.id,
          type: r.type,
          quantity: r.quantity,
        },
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

