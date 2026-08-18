/* ===================================================================
   scripts/downloadKoboAttachments.js
   ---------------------------------------------------------------
   One-off diagnostic tool — not wired into any route, does not touch
   the app's real storage/ folders or Firestore. Fetches one
   submission, resolves every media field's attachment, downloads each
   one for real, and writes it to a local scratch folder under its
   ORIGINAL filename — proving all four requirements concretely:

     1. authenticated request      -> would 401 without the Token header
     2. binary, not text           -> byte length + a hex preview below
     3. MIME type detected         -> printed, with source (sniffed vs
                                       Kobo-declared) so you can see
                                       when the two disagree
     4. original filename kept     -> literally the on-disk filename
                                       here (diagnostic-only; the real
                                       import pipeline does not persist
                                       it — see downloadKoboAttachment's
                                       comment in koboService.js)

   Usage (from Backend/):
     node scripts/downloadKoboAttachments.js <formUid> [outDir]

   outDir defaults to ./tmp/kobo-attachment-check
   =================================================================== */
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const koboService = require('../services/koboService');

function hexPreview(buffer, bytes = 12) {
  return buffer.subarray(0, bytes).toString('hex').match(/.{1,2}/g).join(' ');
}

async function main() {
  const formUid = process.argv[2];
  const outDir = process.argv[3] || path.join(__dirname, '..', 'tmp', 'kobo-attachment-check');
  if (!formUid) {
    console.error('Usage: node scripts/downloadKoboAttachments.js <formUid> [outDir]');
    process.exit(1);
  }

  const conn = await koboService.getConnection();
  if (!conn) {
    console.error('No KoboToolbox connection saved. Connect via the admin UI first.');
    process.exit(1);
  }

  const mediaFields = await koboService.getFormMediaFields(formUid);
  if (mediaFields.length === 0) {
    console.log('This form has no media fields. Nothing to download.');
    process.exit(0);
  }

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

  const resolved = koboService.locateAttachmentsForSubmission({
    record, mediaFields, formUid, serverUrl: conn.serverUrl, token: conn.token,
  });
  const found = resolved.filter((r) => r.found);

  if (found.length === 0) {
    console.log('No media fields on this submission resolved to a downloadable attachment.');
    console.log('(All were either unanswered or had no matching _attachments entry.)');
    process.exit(0);
  }

  await fs.mkdir(outDir, { recursive: true });
  console.log(`Writing ${found.length} file(s) to ${outDir}\n`);

  // eslint-disable-next-line no-restricted-syntax
  for (const entry of found) {
    // eslint-disable-next-line no-await-in-loop
    const result = await koboService.downloadKoboAttachment(entry);
    const outPath = path.join(outDir, `${result.fieldName.replace(/\//g, '_')}__${result.originalFilename}`);
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(outPath, result.buffer);

    console.log(`  [${entry.fieldType}] ${entry.fieldName}`);
    console.log(`    original filename: ${result.originalFilename}`);
    console.log(`    saved to:          ${outPath}`);
    console.log(`    size:              ${result.buffer.length} bytes`);
    console.log(`    mime type:         ${result.mimeType}  (${result.mimeSource})`);
    console.log(`    first bytes (hex): ${hexPreview(result.buffer)}`);
    if (entry.mimetype && entry.mimetype !== result.mimeType) {
      console.log(`    NOTE: Kobo declared "${entry.mimetype}" but sniffed bytes say "${result.mimeType}"`);
    }
    console.log('');
  }

  console.log('Done. Open the saved files to confirm they render/play correctly.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Download check failed:', err);
  process.exit(1);
});