/* ===================================================================
   scripts/locateKoboAttachments.js
   ---------------------------------------------------------------
   One-off diagnostic tool — not wired into any route. Fetches one
   submission for a form, then for every media field the form's
   schema declares (via koboService.getFormMediaFields), resolves
   exactly where its attachment lives — WITHOUT downloading anything.
   Confirms endpoints and auth headers are correct before the importer
   ever touches the network for real bytes.

   Usage (from Backend/):
     node scripts/locateKoboAttachments.js <formUid>
   =================================================================== */
require('dotenv').config();
const koboService = require('../services/koboService');

async function main() {
  const formUid = process.argv[2];
  if (!formUid) {
    console.error('Usage: node scripts/locateKoboAttachments.js <formUid>');
    process.exit(1);
  }

  const conn = await koboService.getConnection();
  if (!conn) {
    console.error('No KoboToolbox connection saved. Connect via the admin UI first.');
    process.exit(1);
  }

  console.log('Reading form schema for media fields...');
  const mediaFields = await koboService.getFormMediaFields(formUid);
  if (mediaFields.length === 0) {
    console.log('This form has no image/audio/video/file/signature questions. Nothing to locate.');
    process.exit(0);
  }
  console.log(`Found ${mediaFields.length} media field(s): ${mediaFields.map((f) => f.name).join(', ')}`);

  console.log('\nFetching 1 submission...');
  const res = await fetch(
    `${conn.serverUrl}/api/v2/assets/${encodeURIComponent(formUid)}/data/?format=json&limit=1`,
    { headers: { Authorization: `Token ${conn.token}`, Accept: 'application/json' } },
  );
  if (!res.ok) {
    console.error(`Kobo API request failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const body = await res.json();
  const record = (body.results || [])[0];
  if (!record) {
    console.error('This form has no submissions yet — try a different formUid.');
    process.exit(1);
  }
  console.log(`Using submission _id ${record._id}.`);

  const resolved = koboService.locateAttachmentsForSubmission({
    record, mediaFields, formUid, serverUrl: conn.serverUrl, token: conn.token,
  });

  console.log('\n===================== Resolved attachment locations =====================\n');
  resolved.forEach((r) => {
    console.log(`  [${r.fieldType}] ${r.fieldName}`);
    if (!r.found) {
      console.log(`    -> NOT FOUND (${r.reason})`);
      return;
    }
    console.log(`    value:        ${r.value}`);
    console.log(`    attachmentId: ${r.attachmentId}`);
    console.log(`    mimetype:     ${r.mimetype}`);
    console.log(`    endpoint:     ${r.endpointUrl}`);
    // Never print the actual token to console — just confirm the
    // Authorization header is present and correctly shaped.
    const hasAuthHeader = !!(r.requestHeaders && /^Token .+/.test(r.requestHeaders.Authorization || ''));
    console.log(`    auth header:  ${hasAuthHeader ? 'present (Token <redacted>)' : 'MISSING — this would fail'}`);
  });

  const foundCount = resolved.filter((r) => r.found).length;
  console.log(`\n${foundCount}/${resolved.length} media field(s) resolved to a downloadable attachment.\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Locating attachments failed:', err);
  process.exit(1);
});