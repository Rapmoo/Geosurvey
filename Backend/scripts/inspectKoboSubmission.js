/* ===================================================================
   scripts/inspectKoboSubmission.js
   ---------------------------------------------------------------
   One-off diagnostic tool — not wired into any route, not part of
   the app's normal request flow. Run it manually to see exactly what
   Kobo sends back for one submission, before trusting any assumption
   about how file questions (photo/audio/video/document) are
   represented in the JSON.

   Usage (from Backend/):
     node scripts/inspectKoboSubmission.js <formUid>

   <formUid> is the same "id" GET /api/kobo/forms already returns for
   each form (Kobo's asset uid, e.g. "aBcDeFgH1234567890abcdefgh").

   Reuses koboService.getConnection() so this authenticates with
   whatever connection is already saved via the admin "Connect to
   KoboToolbox" panel — no separate credentials needed.
   =================================================================== */
require('dotenv').config();
const koboService = require('../services/koboService');

// Common file-answer extensions across Kobo's image/audio/video/file
// question types, just for flagging candidates below — not exhaustive,
// just enough to catch the obvious cases at a glance.
const FILE_LIKE_EXT = /\.(jpg|jpeg|png|webp|heic|heif|mp3|mp4|wav|webm|m4a|3gp|amr|pdf|docx|xlsx|csv)$/i;

async function main() {
  const formUid = process.argv[2];
  if (!formUid) {
    console.error('Usage: node scripts/inspectKoboSubmission.js <formUid>');
    process.exit(1);
  }

  const conn = await koboService.getConnection();
  if (!conn) {
    console.error('No KoboToolbox connection saved. Connect via the admin UI first.');
    process.exit(1);
  }

  console.log(`Fetching 1 submission for form ${formUid} from ${conn.serverUrl} ...`);

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

  console.log('\n===================== FULL RAW SUBMISSION =====================\n');
  console.log(JSON.stringify(record, null, 2));

  console.log('\n===================== _attachments array =====================');
  console.log('(This is where Kobo actually stores media locations — download_url,');
  console.log(' filename, mimetype, id — separate from the answer fields below.)\n');
  console.log(JSON.stringify(record._attachments || [], null, 2));

  console.log('\n===================== Answer fields that look like file refs =====================');
  console.log('(These come from the plain question/answer pairs, NOT from _attachments.');
  console.log(' If a value here matches the tail of a _attachments[].filename, that\'s');
  console.log(' the link between "which question" and "which downloadable file".)\n');

  let foundAny = false;
  Object.entries(record).forEach(([key, value]) => {
    // Kobo prefixes its own bookkeeping fields with "_", plus one
    // unprefixed "formhub/uuid" — skip those, they're metadata, not
    // answers a form question actually produced.
    if (key.startsWith('_') || key === 'formhub/uuid') return;
    if (typeof value === 'string' && FILE_LIKE_EXT.test(value)) {
      foundAny = true;
      const matchingAttachment = (record._attachments || []).find(
        (att) => att.filename && att.filename.endsWith(value),
      );
      console.log(`  "${key}" = "${value}"`);
      console.log(
        matchingAttachment
          ? `    -> matches _attachments filename "${matchingAttachment.filename}" (mimetype: ${matchingAttachment.mimetype}, download_url: ${matchingAttachment.download_url})`
          : '    -> no matching entry found in _attachments (unexpected — worth a closer look)',
      );
    }
  });

  if (!foundAny) {
    console.log('  (No answer values matched a known file extension. This form\'s file');
    console.log('   questions may use a different representation — check the full raw');
    console.log('   submission printed above for anything under _attachments-adjacent keys.)');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Inspection failed:', err);
  process.exit(1);
});