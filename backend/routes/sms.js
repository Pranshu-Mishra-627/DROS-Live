const express = require("express");
const { query } = require("../db");
const { buildTowerAlertMessage } = require("../utils/messageBuilder");

const router = express.Router();

// Twilio client (only initialized if credentials are present)
let twilioClient = null;
const SMS_ENABLED = process.env.SMS_ENABLED === "true";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// Tower name -> phone number mapping (ONLY these two towers send SMS)
// Note: Database has "Tower — Gopalpur Coast" and "Tower — Visakhapatnam"
const TOWER_PHONE_MAP = {
  "Tower — Gopalpur Coast": "9625557034",
  "Tower — Visakhapatnam": "6301658123",
  // Also support without prefix for flexibility
  "Gopalpur Coast": "9625557034",
  "Visakhapatnam": "6301658123",
};

// Initialize Twilio client if credentials are available
if (SMS_ENABLED && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require("twilio");
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log("[sms] Twilio client initialized");
  } catch (err) {
    console.error("[sms] Failed to initialize Twilio:", err.message);
  }
} else {
  console.log("[sms] SMS disabled or Twilio credentials missing");
}

// Optimization data comes from request body (frontend sends it)

/**
 * POST /api/sms/send
 * Body: { tower_id, optimization_data? }
 * 
 * Sends SMS to the phone number associated with the tower (if eligible)
 */
router.post("/send", async (req, res, next) => {
  try {
    if (!SMS_ENABLED) {
      return res.status(200).json({
        success: false,
        status: "disabled",
        message: "SMS sending is disabled (SMS_ENABLED=false)",
      });
    }

    if (!twilioClient) {
      return res.status(500).json({
        success: false,
        status: "not_configured",
        message: "Twilio client not initialized. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
      });
    }

    if (!TWILIO_FROM_NUMBER) {
      return res.status(500).json({
        success: false,
        status: "not_configured",
        message: "TWILIO_FROM_NUMBER not set.",
      });
    }

    const { tower_id, optimization_data } = req.body || {};

    if (!tower_id) {
      return res.status(400).json({
        success: false,
        status: "invalid_input",
        message: "tower_id is required",
      });
    }

    // Get tower info
    const towerRes = await query(
      `SELECT id, name, coverage_radius, ST_AsGeoJSON(location::geometry) AS geom,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM cell_towers
       WHERE id = $1`,
      [tower_id]
    );

    if (towerRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        status: "not_found",
        message: `Tower ${tower_id} not found`,
      });
    }

    const tower = towerRes.rows[0];
    const towerName = tower.name.trim();

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

    // Normalize tower name to extract location
    const normalizedTowerName = normalizeTowerName(towerName);
    
    // Check if this tower is eligible to send SMS by matching location names
    const eligibleLocations = {
      "gopalpur coast": "9625557034",
      "visakhapatnam": "6301658123"
    };
    
    let phoneNumber = null;
    for (const [location, phone] of Object.entries(eligibleLocations)) {
      if (normalizedTowerName.includes(location) || location.includes(normalizedTowerName)) {
        phoneNumber = phone;
        console.log(`[sms] Matched tower "${towerName}" (normalized: "${normalizedTowerName}") to location "${location}"`);
        break;
      }
    }

    if (!phoneNumber) {
      return res.status(200).json({
        success: false,
        status: "not_eligible",
        message: `Tower "${towerName}" is not configured to send SMS. Eligible towers: ${Object.keys(TOWER_PHONE_MAP).join(", ")}`,
      });
    }

    // Use zones from frontend if provided (they already calculated spatial intersection)
    // Otherwise recalculate from database
    let zones = [];
    
    if (req.body.zones && Array.isArray(req.body.zones) && req.body.zones.length > 0) {
      // Use zones sent from frontend (they already verified spatial intersection)
      console.log(`[sms] Using zones from frontend for tower "${towerName}":`, req.body.zones.length);
      zones = req.body.zones.map(z => ({
        disaster_id: z.disaster_id,
        disaster_type: z.disaster_type,
        zone: z.zone,
        eta_min: optimization_data?.[`${z.disaster_id}_${z.zone}`]?.eta_min || z.eta_min || null,
        food_quantity: optimization_data?.[`${z.disaster_id}_${z.zone}`]?.food_quantity || z.food_quantity || null,
      }));
    } else {
      // Recalculate zones from database (fallback)
      console.log(`[sms] Recalculating zones from database for tower "${towerName}"`);
      const disastersRes = await query(
        `SELECT d.id, d.type, d.severity, d.affected_radius, d.evacuation_radius,
                ST_Distance(t.location, d.location) AS meters
         FROM disasters d
         CROSS JOIN (SELECT location FROM cell_towers WHERE id = $1) t
         ORDER BY d.id DESC`,
        [tower_id]
      );

      for (const d of disastersRes.rows) {
        const highR = Number(d.affected_radius) * 0.5;
        const midR = Number(d.affected_radius);
        const lowR = Number(d.evacuation_radius);
        const distM = Number(d.meters);

        // CRITICAL: Tower point must be INSIDE the zone (not circle overlap)
        let zone = "NONE";
        if (distM <= highR) {
          zone = "HIGH";
        } else if (distM <= midR) {
          zone = "MED";
        } else if (distM <= lowR) {
          zone = "LOW";
        }

        if (zone !== "NONE") {
          // Get ETA and food from optimization_data if provided
          const optKey = `${d.id}_${zone}`;
          const optData = optimization_data?.[optKey] || {};
          const eta = optData.eta_min != null ? optData.eta_min : null;
          const food = optData.food_quantity != null ? optData.food_quantity : null;

          zones.push({
            disaster_id: d.id,
            disaster_type: d.type,
            zone,
            eta_min: eta,
            food_quantity: food,
          });
        }
      }
    }
    
    console.log(`[sms] Final zones for tower "${towerName}":`, zones.length, zones.map(z => `${z.disaster_type}(${z.zone})`));

    // If no zones (RISK = NONE), do NOT send SMS
    if (zones.length === 0) {
      return res.status(200).json({
        success: false,
        status: "no_risk",
        message: `Tower "${towerName}" has RISK = NONE (tower point is not inside any disaster zone). No SMS sent. Add disasters that intersect this tower's location.`,
      });
    }

    // Build message using shared builder
    const messageText = buildTowerAlertMessage({
      towerName,
      zones,
      format: "sms",
    });

    // Send SMS via Twilio
    let twilioResult;
    try {
      twilioResult = await twilioClient.messages.create({
        body: messageText,
        from: TWILIO_FROM_NUMBER,
        to: `+91${phoneNumber}`, // India country code
      });

      console.log(`[sms] SMS sent to +91${phoneNumber} for tower "${towerName}". SID: ${twilioResult.sid}`);

      return res.json({
        success: true,
        status: "sent",
        message: `SMS sent to +91${phoneNumber}`,
        tower_name: towerName,
        phone_number: `+91${phoneNumber}`,
        message_preview: messageText.substring(0, 100) + "...",
        twilio_sid: twilioResult.sid,
      });
    } catch (twilioErr) {
      console.error(`[sms] Twilio error for tower "${towerName}":`, twilioErr);
      return res.status(500).json({
        success: false,
        status: "twilio_error",
        message: `Twilio error: ${twilioErr.message}`,
        error_code: twilioErr.code,
      });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
