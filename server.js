// server.js
// Quote Tool Backend – internal single-service version
// 06 Nov 2025

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const turf = require("@turf/turf");
const nodemailer = require("nodemailer");

// --- dynamic import for node-fetch (ESM) ---
let fetchRef = null;
async function getFetch() {
  if (!fetchRef) {
    const { default: fetch } = await import("node-fetch");
    fetchRef = fetch;
  }
  return fetchRef;
}

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- Middleware ----------
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// ---------- Load Auto-Quote Area (Polygon/MultiPolygon) ----------
const AUTO_AREA = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "auto_area.geojson"), "utf8")
);

// ---------- Pricing Config ----------
const LIDAR_SMALL_THRESHOLD = 35;
const LIDAR_SMALL_RATE = 100;
const LIDAR_MINIMUM = 2000;
const LIDAR_LARGE_RATE = 45;
const LIDAR_BASE_FEE = 3500;

const PHOTO_SMALL_THRESHOLD = 35;
const PHOTO_SMALL_RATE = 40;
const PHOTO_MINIMUM = 800;
const PHOTO_LARGE_RATE = 20;
const PHOTO_BASE_FEE = 1400;

const LIDAR_DENSITY_FACTORS = { "8": 0.9, "20": 1.0, "40": 1.15, "60": 1.25, "250": 1.6 };
const LIDAR_ACCURACY_FACTORS = { "0.5": 0.9, "0.3": 1.0, "0.1": 1.15 };
const PHOTO_GSD_FACTORS = { "6in": 0.85, "3in": 1.0, "1in": 1.25 };

// ---------- Add-ons ----------
const ADD_ONS = {
  dtm: 450,
  las: 450,
  contours2ft: 450,
  intensityGeoTIFF: 450,
  dsm: 450,
  planimetric: 1200,
};

// ---------- Helpers ----------
const clampNumber = (n) =>
  (typeof n !== "number" || !isFinite(n)) ? 0 : Math.max(0, n);

const fmtNum = (n, digits = 2) =>
  (typeof n === "number" && isFinite(n))
    ? n.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "";

const yesno = (b) => (b ? "Yes" : "No");
const nl = (s = "") => (s || "").trim() ? s : "—";
const makeRequestId = () => `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;

// Base formulas
function computeLidarBase(acres) {
  if (acres <= LIDAR_SMALL_THRESHOLD) return Math.max(LIDAR_MINIMUM, acres * LIDAR_SMALL_RATE);
  if (acres <= 300) return (acres * LIDAR_LARGE_RATE) + LIDAR_BASE_FEE;
  return null; // manual
}
function computePhotoBase(acres) {
  if (acres <= PHOTO_SMALL_THRESHOLD) return Math.max(PHOTO_MINIMUM, acres * PHOTO_SMALL_RATE);
  if (acres <= 300) return (acres * PHOTO_LARGE_RATE) + PHOTO_BASE_FEE;
  return null; // manual
}

function calcLidar(acres, opts = {}) {
  const base = computeLidarBase(acres);
  if (base === null) return { manualQuote: true, price: null, breakdown: { base: null } };

  const densityFactor  = LIDAR_DENSITY_FACTORS[String(opts.density || "20")] ?? 1.0;
  const accuracyFactor = LIDAR_ACCURACY_FACTORS[String(opts.accuracy || "0.3")] ?? 1.0;
  const addOns = opts.addOns || [];

  let price = base * densityFactor * accuracyFactor;
  let addOnsTotal = 0;
  addOns.forEach(k => addOnsTotal += (ADD_ONS[k] || 0));
  price += addOnsTotal;

  return { manualQuote: false, price, breakdown: { base, densityFactor, accuracyFactor, addOns, addOnsTotal } };
}
function calcPhoto(acres, opts = {}) {
  const base = computePhotoBase(acres);
  if (base === null) return { manualQuote: true, price: null, breakdown: { base: null } };
  const factor = PHOTO_GSD_FACTORS[String(opts.gsd || "3in")] ?? 1.0;
  return { manualQuote: false, price: base * factor, breakdown: { base, gsd: (opts.gsd || "3in"), factor } };
}

// ---------- Mobilization ----------
const BUDA_TX = { lon: -97.8403, lat: 30.0810 };

function calcMobilizationMiles(centroidLonLat) {
  try {
    if (!Array.isArray(centroidLonLat) || centroidLonLat.length !== 2) return 0;
    const from = turf.point([BUDA_TX.lon, BUDA_TX.lat]);
    const to   = turf.point(centroidLonLat);
    const miles = turf.distance(from, to, { units: 'miles' });
    return (isFinite(miles) && miles > 0) ? miles : 0;
  } catch { return 0; }
}

function calcMobilizationCharge(centroidLonLat, on = false) {
  if (!on) return { miles: 0, charge: 0 };
  const miles = calcMobilizationMiles(centroidLonLat);
  if (miles <= 30) return { miles, charge: 0 };
  const over = Math.max(0, miles - 30);
  // $250 base + $1/mi beyond 30 (rounded)
  return { miles, charge: 250 + Math.round(over) };
}

// ---------- Mailer (Ethereal fallback) ----------
let mailer = null;
let usingEthereal = false;

async function initMailer() {
  const hasSMTP =
    process.env.SMTP_HOST && process.env.SMTP_PORT &&
    process.env.SMTP_USER && process.env.SMTP_PASS;

  if (hasSMTP) {
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    usingEthereal = false;
    console.log("📧 Mailer: using real SMTP.");
  } else {
    const test = await nodemailer.createTestAccount();
    mailer = nodemailer.createTransport({
      host: test.smtp.host,
      port: test.smtp.port,
      secure: test.smtp.secure,
      auth: { user: test.user, pass: test.pass },
    });
    usingEthereal = true;
    console.log("🧪 Mailer: using Nodemailer test account (Ethereal).");
  }
}

// ---------- Email (formatted HTML) ----------
async function sendInternalEmail({ payload, flags, service, quote }) {
  if (!mailer) return;

  const c = payload?.contact || {};
  const p = payload?.project || {};
  const a = payload?.aoi || {};
  const q = quote || {};

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.45;color:#111;">
    <h2 style="margin:0 0 12px;">New Quote Submission — ${nl(p.projectName)}</h2>

    <h3 style="margin:18px 0 6px;">Contact</h3>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Name</td><td>${nl(c.name)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Company</td><td>${nl(c.company)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Email</td><td>${nl(c.email)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Phone</td><td>${nl(c.phone)}</td></tr>
    </table>

    <h3 style="margin:18px 0 6px;">Project</h3>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Name</td><td>${nl(p.projectName)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Location</td><td>${nl(p.location)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Schedule</td><td>${nl(p.schedule)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Not a legal survey</td><td>${yesno(p.notLegalSurvey)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;vertical-align:top;">Notes</td><td>${nl(p.notes)}</td></tr>
    </table>

    <h3 style="margin:18px 0 6px;">AOI</h3>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Polygons</td><td>${a.count || 0}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Total Area (acres)</td><td>${fmtNum(a.totalArea_acres)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Total Area (hectares)</td><td>${fmtNum(a.totalArea_hectares)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Total Area (sq km)</td><td>${fmtNum(a.totalArea_sqKm)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Centroid [lon, lat]</td><td>${a.centroid_lonlat ? a.centroid_lonlat.join(", ") : "—"}</td></tr>
    </table>

    <h3 style="margin:18px 0 6px;">Flags</h3>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr><td style="padding:2px 8px 2px 0;color:#555;">In service area</td><td>${flags.inServiceArea === null ? "Unknown" : yesno(flags.inServiceArea)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Area &gt; 300 acres</td><td>${yesno(flags.areaOver300Acres)}</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Auto-quote eligible</td><td>${flags.autoQuoteEligible === null ? "Unknown" : yesno(flags.autoQuoteEligible)}</td></tr>
    </table>

    <h3 style="margin:18px 0 6px;">Service</h3>
    <p style="margin:0 0 8px;"><strong>Type:</strong> ${service}</p>

    <h3 style="margin:18px 0 6px;">Selected Options</h3>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Service</td><td>${nl(payload?.options?.service)}</td></tr>
      ${payload?.options?.service === 'lidar' ? `
        <tr><td style="padding:2px 8px 2px 0;color:#555;">LiDAR Density</td><td>${nl(payload?.options?.lidar?.density)}</td></tr>
        <tr><td style="padding:2px 8px 2px 0;color:#555;">LiDAR Accuracy</td><td>${nl(payload?.options?.lidar?.accuracy)}</td></tr>
        <tr><td style="padding:2px 8px 2px 0;color:#555;vertical-align:top;">LiDAR Add-ons</td>
            <td>${Array.isArray(payload?.options?.lidar?.addOns) && payload.options.lidar.addOns.length
                ? payload.options.lidar.addOns.join(", ")
                : "—"}</td></tr>
      ` : `
        <tr><td style="padding:2px 8px 2px 0;color:#555;">Photo GSD</td><td>${nl(payload?.options?.photo?.gsd)}</td></tr>
      `}
      <tr><td style="padding:2px 8px 2px 0;color:#555;">Mobilization</td>
          <td>${payload?.options?.mobilization?.on ? "On" : "Off"}</td></tr>
      ${quote?.breakdown?.mobilizationMiles != null ? `
        <tr><td style="padding:2px 8px 2px 0;color:#555;">Mobilization Details</td>
            <td>${quote.breakdown.mobilizationMiles} mi · $${fmtNum(quote.breakdown.mobilizationCharge,0)}</td></tr>
      ` : ""}
    </table>

    <h3 style="margin:18px 0 6px;">Calculated Quote (internal)</h3>
    ${q?.manualQuote ? `
      <p style="margin:0;">Over 300 acres — manual quote required.</p>
    ` : `
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr><td style="padding:2px 8px 2px 0;color:#555;">Estimated Price</td>
            <td><strong>$${fmtNum(q.price, 0)}</strong></td></tr>
        ${q.breakdown?.base != null ? `<tr><td style="padding:2px 8px 2px 0;color:#555;">Base</td><td>$${fmtNum(q.breakdown.base, 0)}</td></tr>` : ""}
        ${q.breakdown?.densityFactor ? `<tr><td style="padding:2px 8px 2px 0;color:#555;">Density factor</td><td>${q.breakdown.densityFactor}</td></tr>` : ""}
        ${q.breakdown?.accuracyFactor ? `<tr><td style="padding:2px 8px 2px 0;color:#555;">Accuracy factor</td><td>${q.breakdown.accuracyFactor}</td></tr>` : ""}
        ${Array.isArray(q.breakdown?.addOns) && q.breakdown.addOns.length
          ? `<tr><td style="padding:2px 8px 2px 0;color:#555;">Add-ons</td>
              <td>${q.breakdown.addOns.join(", ")} ($${fmtNum(q.breakdown.addOnsTotal,0)})</td></tr>` : ""}
        ${q.breakdown?.mobilizationMiles != null
          ? `<tr><td style="padding:2px 8px 2px 0;color:#555;">Mobilization</td>
              <td>${q.breakdown.mobilizationMiles} mi · $${fmtNum(q.breakdown.mobilizationCharge,0)}</td></tr>` : ""}
      </table>
    `}

    <p style="margin:18px 0 0;color:#666;font-size:12px;">
      Submitted: ${new Date(payload?.meta?.submittedAt || Date.now()).toLocaleString()}
      &nbsp;·&nbsp; v${payload?.meta?.version || "—"}
      &nbsp;·&nbsp; Request ID: ${nl(payload?.meta?.requestId)}
    </p>
  </div>`;

  const subject = `New Quote Submission — ${nl(p.projectName)}`;

  const info = await mailer.sendMail({
    from: process.env.FROM_EMAIL || "no-reply@example.com",
    to: process.env.TO_EMAIL || "dev-inbox@example.com",
    subject,
    html,
  });

  if (usingEthereal) {
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.log("🔗 Email preview:", preview);
  }
}

// ---------- Sheets logging ----------
async function logToSheets(payload, flags, service, quote) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;

  const body = {
    contact: payload?.contact,
    project: payload?.project,
    aoi: payload?.aoi,
    flags,
    service,
    quote,
    options: payload?.options,
    meta: payload?.meta
  };

  try {
    const fetch = await getFetch();
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    console.log("📄 Sheets webhook:", resp.status, text);
  } catch (e) {
    console.error("Sheets webhook error:", e.message);
  }
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.send("Quote Tool Backend is running ✅"));

app.use('/data', express.static(path.join(__dirname, 'data')));

app.post("/submitQuote", async (req, res) => {
  try {
    const payload = req.body;

    // guarantee meta + requestId for dedupe downstream
    payload.meta = payload.meta || {};
    if (!payload.meta.requestId) payload.meta.requestId = makeRequestId();

    const acres = clampNumber(payload?.aoi?.totalArea_acres || 0);
    const service = String(payload?.options?.service || "lidar").toLowerCase();

    // Service area check
    let inServiceArea = null;
    try {
      const features = payload?.aoi?.features || [];
      if (features.length > 0) {
        inServiceArea = features.some(f => turf.booleanIntersects(f, AUTO_AREA));
      }
    } catch (e) {
      console.warn("Service-area check failed:", e.message);
      inServiceArea = null;
    }

    const areaOver300Acres = acres > 300;
    const autoQuoteEligible = (!areaOver300Acres) && (inServiceArea === true);

    // Compute internal quote (single service)
    let quote = null;
    if (service === "lidar") {
      quote = calcLidar(acres, payload?.options?.lidar || {});
    } else if (service === "photo" || service === "photogrammetry") {
      quote = calcPhoto(acres, payload?.options?.photo || {});
    } else {
      // fallback: treat as lidar
      quote = calcLidar(acres, payload?.options?.lidar || {});
    }

    // Mobilization
    const mobOpt = payload?.options?.mobilization || {};
    const mob = calcMobilizationCharge(payload?.aoi?.centroid_lonlat || null, !!mobOpt.on);

    if (quote && !quote.manualQuote && typeof quote.price === "number") {
      quote.price += mob.charge;
      quote.breakdown = quote.breakdown || {};
      quote.breakdown.mobilizationMiles = Math.round(mob.miles);
      quote.breakdown.mobilizationCharge = mob.charge;
    } else {
      quote.breakdown = quote.breakdown || {};
      quote.breakdown.mobilizationMiles = Math.round(mob.miles);
      quote.breakdown.mobilizationCharge = mob.charge;
    }

    const flags = { areaOver300Acres, inServiceArea, autoQuoteEligible };

    // Fire-and-forget side effects
    sendInternalEmail({ payload, flags, service, quote }).catch(err => console.error("Email error:", err));
    logToSheets(payload, flags, service, quote);

    res.json({ status: "ok", receivedAt: new Date().toISOString() });

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

// ---------- Start ----------
(async () => {
  await initMailer();
  app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));
})();
