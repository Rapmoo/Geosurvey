/* ===================================================================
   app.js
   ---------------------------------------------------------------
   Express app wiring. Kept separate from server.js so it can be
   imported directly by tests without binding a port.
   =================================================================== */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const uploadRoutes = require('./routes/upload');
const fileRoutes = require('./routes/files');
const adminStorageRoutes = require('./routes/adminStorage');
const koboRoutes = require('./routes/kobo');
const systemAlertsRoutes = require('./routes/systemAlerts');
const storageMonitorService = require('./services/storageMonitorService');
const formFolderService = require('./services/formFolderService');
const submissionArchiveService = require('./services/submissionArchiveService');

const app = express();

// Behind a reverse proxy (Cloud Run, ALB, nginx, etc.) so rate-limiting
// and logging see the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow same-origin/non-browser tools (no Origin header) and any
    // explicitly configured origin; reject everything else.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Monitor-Key'],
  // Content-Disposition isn't on the browser's default cross-origin
  // header safelist (Cache-Control, Content-Language, Content-Type,
  // Expires, Last-Modified, Pragma) -- without explicitly exposing it
  // here, res.headers.get('Content-Disposition') on the frontend's
  // koboApiFetchBlob always returns null even though GET
  // /api/kobo/forms/:id/export already sets a correct, form-name-based
  // filename on it. That silent null is what was making every Kobo
  // form export download as the frontend's hardcoded 'export.xlsx'
  // fallback instead of the real form name.
  exposedHeaders: ['Content-Disposition'],
}));

// General API rate limit — generous enough for normal use, tight
// enough to blunt brute-force/credential-stuffing against the token
// verification path and abuse of the upload endpoints.
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// JSON body parsing for any future non-multipart endpoints. Upload
// routes use multer directly and don't go through this.
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.use('/api', uploadRoutes);
app.use('/api', fileRoutes);
app.use('/api', adminStorageRoutes);
app.use('/api', koboRoutes);
app.use('/api', systemAlertsRoutes);

// 404 for anything unmatched under /api
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Central error handler — catches CORS rejection and anything an async
// route handler forwards via next(err) instead of handling itself.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  console.error('[unhandled]', err);
  return res.status(500).json({ error: 'Internal server error.' });
});

// In-process disk-space watchdog — a log-level safety net alongside
// (not instead of) scripts/monitor-disk-space.sh's cron-based check;
// see services/storageMonitorService.js for why both exist.
storageMonitorService.startPeriodicCheck();

// Firestore listeners for data written directly from the PWA (forms and
// submissions go straight into Firestore from index.html — there's no
// backend route for either). Each service's own header comment explains
// why a listener instead of a route; submissionArchiveService.js's
// startSubmissionArchiveWatcher() comment explicitly says to start it
// "alongside formFolderService.startFormFolderWatcher()" at server
// startup — neither was actually being called anywhere, so both features
// (auto-creating form folders on disk, and archiving each submission to
// disk as JSON) were silently inert despite being fully implemented.
formFolderService.startFormFolderWatcher();
submissionArchiveService.startSubmissionArchiveWatcher();

module.exports = app;