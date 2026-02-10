const express = require("express");
const { query } = require("../db");

const router = express.Router();

function featureCollection(features) {
  return { type: "FeatureCollection", features };
}

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         id,
         type,
         severity,
         affected_radius,
         evacuation_radius,
         created_at,
         ST_AsGeoJSON(location::geometry) AS geom
       FROM disasters
       ORDER BY id DESC`
    );

    const features = rows.map((r) => ({
      type: "Feature",
      geometry: JSON.parse(r.geom),
      properties: {
        id: r.id,
        type: r.type,
        severity: r.severity,
        affected_radius: Number(r.affected_radius),
        evacuation_radius: Number(r.evacuation_radius),
        created_at: r.created_at,
      },
    }));

    res.json(featureCollection(features));
  } catch (err) {
    next(err);
  }
});

// DELETE all disasters (must come before DELETE /:id)
router.delete("/", async (req, res, next) => {
  try {
    const result = await query("DELETE FROM disasters");
    res.json({ success: true, message: "All disasters deleted", deleted_count: result.rowCount || 0 });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    await query("DELETE FROM disasters WHERE id = $1", [id]);
    res.json({ success: true, message: `Disaster ${id} deleted` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

