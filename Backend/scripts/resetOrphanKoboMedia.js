/* ===================================================================
   scripts/resetOrphanKoboMedia.js
   ---------------------------------------------------------------
   Companion to retryFailedKoboMedia.js. If that script was ever run
   from a process whose STORAGE_ROOT resolves somewhere other than
   the real backend's storage volume (classic case: run on a host
   machine instead of `docker compose exec backend ...`), it will
   have downloaded real files, written them to the WRONG disk, and
   then written Firestore companyFiles + submissions records that
   confidently point at files that don't actually exist where the
   real API container reads from — surfacing as ENOENT on
   GET /api/files/:id.

   This script finds exactly that state and undoes it:
     - for every submission with a photoUrl/voiceUrl/videoUrl/
       documentUrl (or a media answer field carrying a
       { filename, url, mimeType } object), tries to actually read
       the referenced file via fileStorageService.readFile()
       (same code path routes/files.js uses)
     - if that read fails with ENOENT, the companyFiles record is
       deleted and the submission field is reverted to a `failed`
       marker so retryFailedKoboMedia.js will treat it as broken
       and retry it again — this time hopefully run from the right
       place.

   IMPORTANT: run this from the SAME process/container whose storage
   you want to treat as "the real one" — i.e. run it the same way
   you'll run retryFailedKoboMedia.js next (normally
   `docker compose exec backend node scripts/resetOrphanKoboMedia.js`).
   Running it from the wrong place will make it think everything is
   orphaned (or nothing is), not the actual state.

   USAGE (run from Backend/, ideally inside the backend container):
     node scripts/resetOrphanKoboMedia.js
       -> dry run, lists what's orphaned. Changes nothing.

     node scripts/resetOrphanKoboMedia.js --confirm
       -> deletes the orphan companyFiles records and reverts the
          affected submission fields to a retryable failed state.
   =================================================================== */
require('dotenv').config();
const { db } = require('../config/firebaseAdmin');
const koboService = require('../services/koboService');
const fileStorageService = require('../services/fileStorageService');
const fileMetadataService = require('../services/fileMetadataService');

const { SUBMISSIONS_COLLECTION } = koboService;

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');

const URL_FIELDS = ['photoUrl', 'voiceUrl', 'videoUrl', 'documentUrl'];

async function fileExists(fileId) {
  if (!fileId) return true; // nothing to check
  const record = await fileMetadataService.getRecord(fileId);
  if (!record) return false; // metadata itself already gone
  try {
    await fileStorageService.readFile(record.filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err; // some other error (permissions, etc.) — don't guess, surface it
  }
}

async function main() {
  console.log('Loading submissions...');
  const snap = await db.collection(SUBMISSIONS_COLLECTION).get();

  let orphansFound = 0;
  let fixed = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!data.koboSourceId) continue; // eslint-disable-line no-continue

    const patch = {};
    const answerPatch = {};
    const orphanFileIds = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const field of URL_FIELDS) {
      // eslint-disable-next-line no-await-in-loop
      if (data[field] && !(await fileExists(data[field]))) {
        orphanFileIds.push(data[field]);
        patch[field] = null;
      }
    }

    const answers = data.answers || {};
    // eslint-disable-next-line no-restricted-syntax
    for (const [fieldName, value] of Object.entries(answers)) {
      if (value && typeof value === 'object' && value.url) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await fileExists(value.url))) {
          orphanFileIds.push(value.url);
          answerPatch[fieldName] = {
            filename: value.filename || null,
            failed: true,
            reason: 'File metadata pointed at a file that does not exist on this storage — likely written from the wrong environment. Reset for retry.',
          };
        }
      }
    }

    if (orphanFileIds.length === 0) continue; // eslint-disable-line no-continue

    orphansFound += 1;
    const label = data.submissionId || doc.id;
    console.log(`--- ${label}: ${orphanFileIds.length} orphan file reference(s) ---`);
    console.log(`  Orphan fileId(s): ${orphanFileIds.join(', ')}`);
    console.log(`  Affected answer field(s): ${Object.keys(answerPatch).join(', ') || '(none)'}`);
    console.log(`  Affected url field(s): ${Object.keys(patch).join(', ') || '(none)'}`);

    if (!confirmed) {
      console.log('  (dry run — would reset this submission)\n');
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const fileId of orphanFileIds) {
      // eslint-disable-next-line no-await-in-loop
      await fileMetadataService.deleteRecord(fileId).catch((err) => {
        console.error(`  Could not delete orphan companyFiles/${fileId}: ${err.message}`);
      });
    }

    const mergedAnswers = { ...answers, ...answerPatch };
    // eslint-disable-next-line no-await-in-loop
    await doc.ref.update({ ...patch, answers: mergedAnswers, updatedAt: new Date() });
    console.log('  Reset — will be picked up by retryFailedKoboMedia.js on its next run.\n');
    fixed += 1;
  }

  console.log(`\n${orphansFound} submission(s) with orphan media found${confirmed ? `, ${fixed} reset` : ' (dry run — nothing changed)'}.`);
  if (orphansFound > 0 && confirmed) {
    console.log('Next: run scripts/retryFailedKoboMedia.js --confirm from the SAME environment (e.g. inside the backend container) to re-download and save them correctly.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});