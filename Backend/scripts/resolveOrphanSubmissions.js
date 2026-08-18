/* ===================================================================
   scripts/resolveOrphanSubmissions.js
   ---------------------------------------------------------------
   Companion to findBrokenSubmissions.js. That script only reports;
   this one can act — but defaults to a dry run and requires an
   explicit --confirm flag before deleting anything, so it can't be
   fired off by accident.

   Covers the two failure modes seen in submissionArchiveService's
   logs:
     - dangling formId  (data.formId doesn't match any forms/{id} doc)
     - missing workerId (data.workerId is falsy — fails Gate 1 in
       submissionArchiveService.archiveSubmission())

   USAGE (run from Backend/):
     node scripts/resolveOrphanSubmissions.js
       -> dry run, lists what WOULD happen for both categories,
          deletes nothing. Safe to run anytime.

     node scripts/resolveOrphanSubmissions.js --formid=delete --confirm
       -> actually deletes submissions with a dangling formId.

     node scripts/resolveOrphanSubmissions.js --workerid=delete --confirm
       -> actually deletes submissions with a missing workerId.

     node scripts/resolveOrphanSubmissions.js --formid=delete --workerid=delete --confirm
       -> does both.

   Omit --confirm and nothing is ever deleted, no matter what other
   flags are passed — it just prints what it would have deleted.

   NOT covered here: restoring the missing forms themselves. That
   requires importing a Firestore managed export (gcloud firestore
   import) into a scratch database first, per Backup System/RECOVERY.md
   — pulling the specific form doc(s) back out and re-writing them
   into the live forms collection is a manual step after that import,
   since it needs a human to verify the restored data is correct
   before it touches production. See RECOVERY.md, scenario 3.
   =================================================================== */
require('dotenv').config();
const { db } = require('../config/firebaseAdmin');

const SUBMISSIONS_COLLECTION = 'submissions';
const FORMS_COLLECTION = 'forms';

const args = process.argv.slice(2);
const flag = (name) => {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};
const confirmed = args.includes('--confirm');
const formIdAction = flag('formid') || 'keep'; // 'keep' | 'delete'
const workerIdAction = flag('workerid') || 'keep'; // 'keep' | 'delete'

async function main() {
  console.log('Loading forms...');
  const formsSnap = await db.collection(FORMS_COLLECTION).get();
  const existingFormIds = new Set(formsSnap.docs.map((d) => d.id));

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

  await handleCategory('Dangling formId', danglingFormId, formIdAction);
  await handleCategory('Missing workerId', missingWorkerId, workerIdAction);

  if (!confirmed) {
    console.log('\nDry run only — nothing was deleted. Re-run with --confirm to actually delete.');
  }
  process.exit(0);
}

async function handleCategory(label, items, action) {
  console.log(`=== ${label} (${items.length}) — action: ${action} ===`);
  if (items.length === 0) {
    console.log('  none\n');
    return;
  }

  if (action !== 'delete') {
    items.forEach((s) => console.log(`  KEEP  doc ${s.docId}  submissionId=${s.submissionId}`));
    console.log('');
    return;
  }

  if (!confirmed) {
    items.forEach((s) => console.log(`  WOULD DELETE  doc ${s.docId}  submissionId=${s.submissionId}`));
    console.log('  (dry run — pass --confirm to actually delete these)\n');
    return;
  }

  // Firestore batches cap at 500 writes; chunk to stay well under that.
  const CHUNK = 400;
  let deleted = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const batch = db.batch();
    chunk.forEach((s) => batch.delete(db.collection(SUBMISSIONS_COLLECTION).doc(s.docId)));
    await batch.commit();
    deleted += chunk.length;
    console.log(`  deleted ${deleted}/${items.length}...`);
  }
  console.log(`  DELETED ${items.length} submission doc(s).\n`);
}

main().catch((err) => {
  console.error('resolveOrphanSubmissions failed:', err);
  process.exit(1);
});
