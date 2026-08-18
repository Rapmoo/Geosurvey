/* ===================================================================
   scripts/findBrokenSubmissions.js
   ---------------------------------------------------------------
   One-off diagnostic tool — not wired into any route, read-only,
   does not modify Firestore or touch storage/. Scans every doc in
   `submissions` and reports the two failure modes seen in
   submissionArchiveService's logs:

     1. DANGLING formId  — data.formId is set, but forms/{formId}
        does not exist (deleted form, bad id, etc.). This is exactly
        the check formFolderService.getStorageFolderName() does.
     2. MISSING workerId — data.workerId is falsy, which fails Gate 1
        (validation) in submissionArchiveService's archiveSubmission().

   A submission can hit both. Neither check here duplicates writes or
   mutates anything — it only reads.

   Usage (from Backend/):
     node scripts/findBrokenSubmissions.js
   =================================================================== */
require('dotenv').config();
const { db } = require('../config/firebaseAdmin');

const SUBMISSIONS_COLLECTION = 'submissions';
const FORMS_COLLECTION = 'forms';

async function main() {
  console.log('Loading forms...');
  const formsSnap = await db.collection(FORMS_COLLECTION).get();
  const existingFormIds = new Set(formsSnap.docs.map((d) => d.id));
  console.log(`  ${existingFormIds.size} form(s) found.\n`);

  console.log('Loading submissions...');
  const submissionsSnap = await db.collection(SUBMISSIONS_COLLECTION).get();
  console.log(`  ${submissionsSnap.size} submission(s) found.\n`);

  const danglingFormId = [];
  const missingWorkerId = [];

  submissionsSnap.forEach((doc) => {
    const data = doc.data();
    const submissionId = data.submissionId || doc.id;

    if (!data.formId || !existingFormIds.has(data.formId)) {
      danglingFormId.push({ docId: doc.id, submissionId, formId: data.formId || '(none)' });
    }
    if (!data.workerId) {
      missingWorkerId.push({ docId: doc.id, submissionId });
    }
  });

  console.log(`=== Dangling formId (${danglingFormId.length}) ===`);
  if (danglingFormId.length === 0) {
    console.log('  none\n');
  } else {
    danglingFormId.forEach((s) => {
      console.log(`  doc ${s.docId}  submissionId=${s.submissionId}  formId=${s.formId}`);
    });
    console.log('');
  }

  console.log(`=== Missing workerId (${missingWorkerId.length}) ===`);
  if (missingWorkerId.length === 0) {
    console.log('  none\n');
  } else {
    missingWorkerId.forEach((s) => {
      console.log(`  doc ${s.docId}  submissionId=${s.submissionId}`);
    });
    console.log('');
  }

  const totalBroken = new Set([
    ...danglingFormId.map((s) => s.docId),
    ...missingWorkerId.map((s) => s.docId),
  ]).size;
  console.log(`Total submissions affected: ${totalBroken} / ${submissionsSnap.size}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('findBrokenSubmissions failed:', err);
  process.exit(1);
});
