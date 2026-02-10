/**
 * Shared message builder for tower alerts
 * Used by both frontend (preview) and backend (SMS)
 * 
 * CRITICAL: This function ONLY uses disasters that spatially intersect the tower.
 * It does NOT infer disasters from optimization state or database presence.
 */

/**
 * Builds tower alert message from zone data
 * @param {Object} params
 * @param {string} params.towerName - Tower name
 * @param {Array} params.zones - Array of { disaster_id, disaster_type, zone, eta_min, food_quantity }
 * @param {string} params.format - 'html' or 'sms' (default: 'html')
 * @returns {string} Formatted message
 */
function buildTowerAlertMessage({ towerName, zones, format = "html" }) {
  if (!zones || zones.length === 0) {
    return format === "sms"
      ? `No active alerts for ${towerName}.`
      : `No active alerts for this tower.`;
  }

  // Deduplicate by (disaster_id, zone) - each disaster-zone pair appears once
  const seen = new Set();
  const uniqueZones = zones.filter((z) => {
    const key = `${z.disaster_id}_${z.zone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Group by zone level (HIGH, MED, LOW) for better organization
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

  // Process HIGH, then MED, then LOW
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
        // SMS format (plain text, Unicode-safe)
        parts.push(`\n\n${zoneLabel} (${disasterType}):`);
        if (eta != null) parts.push(`ETA ambulances: ~${eta} min`);
        if (food != null) parts.push(`Food allocated: ${food.toLocaleString()} meals`);
        if (eta == null && food == null) parts.push(`Run optimization for ETA & food.`);
      }
    });
  });

  return parts.join(format === "html" ? "<br>" : "\n");
}

function escapeHtml(text) {
  if (typeof text !== "string") return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

module.exports = { buildTowerAlertMessage };
