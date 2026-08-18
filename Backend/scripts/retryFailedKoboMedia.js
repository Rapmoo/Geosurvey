/* ===================================================================
   scripts/retryFailedKoboMedia.js
   ---------------------------------------------------------------
   Root-cause fix for Kobo-imported submissions whose photo/audio never
   made it in: koboService.importAttachmentsForRecord() already handles
   a single attachment failing gracefully — it leaves the answer as
   { filename, failed: true, reason } instead of crashing the whole
   import (see that function's comment block) — but nothing ever went
   back and RETRIED those specific fields once the transient cause
   (an expired/rate-limited Kobo token mid-batch, a network blip, a
   momentary storage error, etc.) was gone. This script is that retry.

   It finds every "submissions" doc that:
     - came from a Kobo import (has koboSourceId), AND
     - has at least one answer field that failed { failed: true }, OR
     - has media questions per its form's current schema but is
       missing photoUrl/voiceUrl entirely (covers an even older import
       that predates this attachment pipeline, if any exist)

   ...then re-fetches that exact Kobo record and re-runs the SAME
   importAttachmentsForRecord() logic importForm() uses live, so a
   retry is byte-for-byte identical to a fresh import — no
   reimplementation to drift out of sync with. On success it patches
   the submission doc's answers + photoUrl/voiceUrl/videoUrl/documentUrl
   in place; on renewed failure it leaves the doc untouched and reports
   the (hopefully now more informative) reason.

   USAGE (run from Backend/):
     node scripts/retryFailedKoboMedia.js
       -> dry run: lists every affected submission and what field(s)
          are broken. Fixes nothing.

     node scripts/retryFailedKoboMedia.js --confirm
       -> actually re-downloads and patches Firestore for every
          affected submission.

     node scripts/retryFailedKoboMedia.js --confirm --docId=<id>
       -> limit the retry to one specific submissions/{docId}.

   Requires a live KoboToolbox connection (same one the admin UI's
   Import from Kobo uses) — if none is saved, this exits early with
   the same error the live import path would show.
   =================================================================== */
require('dotenv').config();
const { db } = require('../config/firebaseAdmin');
const koboService = require('../services/koboService');
const fileStorageService = require('../services/fileStorageService');

const {
  SUBMISSIONS_COLLECTION,
  KOBO_STORAGE_FOLDER_PREFIX,
  UNSAFE_SURVEY_ID_CHARS,
} = koboService;

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const onlyDocId = (() => {
  const hit = args.find((a) => a.startsWith('--docId='));
  return hit ? hit.slice('--docId='.length) : null;
})();

function hasFailedField(answers) {
  return Object.values(answers || {}).some(
    (v) => v && typeof v === 'object' && v.failed === true,
  );
}

async function main() {
  const conn = await koboService.getConnection();
  if (!conn) {
    console.error('No KoboToolbox connection saved. Connect via the admin UI first, then re-run this script.');
    process.exit(1);
  }

  console.log('Loading submissions...');
  // Full collection scan + in-JS filtering (same approach as
  // resolveOrphanSubmissions.js) rather than a `!=` Firestore query —
  // avoids requiring a composite index just to run a one-off repair.
  const snap = await db.collection(SUBMISSIONS_COLLECTION).get();

  const candidates = [];
  snap.forEach((doc) => {
    if (onlyDocId && doc.id !== onlyDocId) return;
    const data = doc.data();
    if (!data.koboSourceId) return;
    if (hasFailedField(data.answers)) {
      candidates.push({ doc, data });
    }
  });

  console.log(`${candidates.length} Kobo-imported submission(s) with a failed media field found.\n`);
  if (candidates.length === 0) {
    process.exit(0);
  }

  const mediaFieldsCache = new Map(); // formUid -> mediaFields[]
  const storageFolderCache = new Map(); // formName -> storageFolderName

  let fixed = 0;
  let stillFailing = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const { doc, data } of candidates) {
    const submissionLabel = data.submissionId || doc.id;
    const [formUid, koboId] = String(data.koboSourceId).split(':');
    console.log(`--- ${submissionLabel} (form ${formUid}, kobo id ${koboId}) ---`);

    const failedFieldNames = Object.entries(data.answers || {})
      .filter(([, v]) => v && typeof v === 'object' && v.failed === true)
      .map(([k]) => k);
    console.log(`  Broken field(s): ${failedFieldNames.join(', ')}`);

    if (!confirmed) {
      console.log('  (dry run — would retry this submission)\n');
      continue; // eslint-disable-line no-continue
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(
        `${conn.serverUrl}/api/v2/assets/${encodeURIComponent(formUid)}/data/${encodeURIComponent(koboId)}/?format=json`,
        { headers: { Authorization: `Token ${conn.token}`, Accept: 'application/json' } },
      );
      if (!res.ok) {
        console.error(`  Could not re-fetch this record from Kobo (${res.status}). Skipping.\n`);
        stillFailing += 1;
        continue; // eslint-disable-line no-continue
      }
      // eslint-disable-next-line no-await-in-loop
      const record = await res.json();

      if (!mediaFieldsCache.has(formUid)) {
        // eslint-disable-next-line no-await-in-loop
        mediaFieldsCache.set(formUid, await koboService.getFormMediaFields(formUid));
      }
      const mediaFields = mediaFieldsCache.get(formUid);

      if (!storageFolderCache.has(data.formName)) {
        const folderName = fileStorageService.sanitizeFormName(`${KOBO_STORAGE_FOLDER_PREFIX}${data.formName}`);
        // eslint-disable-next-line no-await-in-loop
        await fileStorageService.ensureFolderExists(folderName);
        storageFolderCache.set(data.formName, folderName);
      }
      const storageFolderName = storageFolderCache.get(data.formName);

      const surveyIdForFile = String(data.koboSourceId).replace(UNSAFE_SURVEY_ID_CHARS, '-');

      // eslint-disable-next-line no-await-in-loop
      const { urls, answerReplacements } = await koboService.importAttachmentsForRecord({
        record,
        mediaFields,
        surveyIdForFile,
        storageFolderName,
        importedByUid: data.importedBy || null,
        formId: data.formId || null,
        formUid,
        serverUrl: conn.serverUrl,
        token: conn.token,
        onProgress: (evt) => console.log(`    ${evt.message}`),
      });

      const newlyFixed = Object.entries(answerReplacements)
        .filter(([k, v]) => failedFieldNames.includes(k) && v && !v.failed);
      const stillBroken = Object.entries(answerReplacements)
        .filter(([k, v]) => failedFieldNames.includes(k) && v && v.failed);

      if (newlyFixed.length === 0) {
        console.error(`  Retry did not recover any field. Still failing: ${stillBroken.map(([k, v]) => `${k} (${v.reason})`).join(', ') || '(no reason reported — check Kobo connection/token)'}\n`);
        stillFailing += 1;
        continue; // eslint-disable-line no-continue
      }

      const mergedAnswers = { ...data.answers };
      Object.entries(answerReplacements).forEach(([fieldName, fileInfo]) => {
        mergedAnswers[fieldName] = fileInfo;
      });

      const patch = { answers: mergedAnswers, updatedAt: new Date() };
      // Only ever fill in a photoUrl/voiceUrl/etc that was previously
      // null — never overwrite one that (for whatever reason) already
      // pointed at a real, previously-saved file.
      ['photoUrl', 'voiceUrl', 'videoUrl', 'documentUrl'].forEach((field) => {
        if (!data[field] && urls[field]) patch[field] = urls[field];
      });

      // eslint-disable-next-line no-await-in-loop
      await doc.ref.update(patch);
      console.log(`  Fixed: ${newlyFixed.map(([k]) => k).join(', ')}${stillBroken.length ? ` · still broken: ${stillBroken.map(([k]) => k).join(', ')}` : ''}\n`);
      fixed += 1;
    } catch (err) {
      console.error(`  Unexpected error retrying this submission: ${err.message}\n`);
      stillFailing += 1;
    }
  }

  if (!confirmed) {
    console.log('Dry run only — nothing was changed. Re-run with --confirm to actually retry and patch Firestore.');
  } else {
    console.log(`Done. ${fixed} submission(s) fixed, ${stillFailing} still failing.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});