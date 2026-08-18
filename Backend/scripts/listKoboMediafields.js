/* ===================================================================
   scripts/listKoboMediaFields.js
   ---------------------------------------------------------------
   One-off diagnostic tool — not wired into any route. Prints every
   media-bearing question (image/audio/video/file/signature) that
   koboService.getFormMediaFields() detects in a form's schema, so you
   can confirm it matches reality before the importer starts relying
   on it to decide which answers need a file downloaded.

   Usage (from Backend/):
     node scripts/listKoboMediaFields.js <formUid>

   <formUid> is the same "id" GET /api/kobo/forms already returns for
   each form.
   =================================================================== */
require('dotenv').config();
const koboService = require('../services/koboService');

async function main() {
  const formUid = process.argv[2];
  if (!formUid) {
    console.error('Usage: node scripts/listKoboMediaFields.js <formUid>');
    process.exit(1);
  }

  const fields = await koboService.getFormMediaFields(formUid);

  if (fields.length === 0) {
    console.log(`No image/audio/video/file/signature questions found on form ${formUid}.`);
    console.log('(If that\'s unexpected, double-check the formUid, or that the form is deployed.)');
    process.exit(0);
  }

  console.log(`\nMedia fields detected on form ${formUid}:\n`);
  fields.forEach((f) => {
    const labelPart = f.label ? ` — "${f.label}"` : '';
    console.log(`  [${f.type}]  ${f.name}${labelPart}`);
  });
  console.log(`\n${fields.length} media field(s) total.\n`);

  console.log('Next: cross-check these names against a real submission');
  console.log('(scripts/inspectKoboSubmission.js) — each of these names should show up');
  console.log('as a top-level answer key whose value is a filename matching an entry');
  console.log('in that submission\'s _attachments array.');

  process.exit(0);
}

main().catch((err) => {
  console.error('Listing media fields failed:', err);
  process.exit(1);
});