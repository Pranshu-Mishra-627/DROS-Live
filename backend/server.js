require("dotenv").config();

const express = require("express");
const cors = require("cors");

const disastersRouter = require("./routes/disasters");
const hospitalsRouter = require("./routes/hospitals");
const resourcesRouter = require("./routes/resources");
const towersRouter = require("./routes/towers");
const optimizeRouter = require("./routes/optimize");
const smsRouter = require("./routes/sms");

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "dros-backend", time: new Date().toISOString() });
});

app.use("/api/disasters", disastersRouter);
app.use("/api/hospitals", hospitalsRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/towers", towersRouter);
app.use("/api", optimizeRouter); // /api/disaster, /api/optimize
app.use("/api/sms", smsRouter); // /api/sms/send

// Basic error handler (keeps responses consistent)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "internal_error", message: "Unexpected server error" });
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

