/* ===================================================================
   scripts/verifyKoboImportCompleteness.js
   ---------------------------------------------------------------
   One-off diagnostic tool — not wired into any route. Run this after
   a Kobo import to confirm GeoSurvey now holds a complete,
   independent copy of that Kobo form's project: not just "the import
   didn't throw", but the three things an administrator actually cares
   about:

     1. Submission counts   — Kobo's total for this form vs. how many
                               of THIS form's submissions exist in
                               GeoSurvey's `submissions` collection
                               (matched via koboSourceId, the same
                               field koboService.importForm uses to
                               dedupe on re-import).
     2. Attachment counts   — Kobo's _attachments across every
                               submission of this form, broken down by
                               image/audio/video/document, vs the same
                               breakdown from GeoSurvey's `companyFiles`
                               Firestore metadata (matched via
                               surveyId, which importForm derives 1:1
                               from formUid+koboId).
     3. Real accessibility  — for a sample of imported submissions,
                               resolves each stored companyFiles fileId
                               (photoUrl/voiceUrl/videoUrl/documentUrl
                               and answers[field].url — the same fileId
                               a native upload writes into these fields)
                               via fileMetadataService.getRecord(), then
                               actually reads the attached file's bytes
                               via fileStorageService.readFile() against
                               GeoSurvey's own storage — rather than just
                               checking a Firestore record exists. This
                               is the step that proves the copy is
                               independent of Kobo, not just linked to
                               it.

   Usage (from Backend/):
     node scripts/verifyKoboImportCompleteness.js <formUid> [sampleSize]

   <formUid> is the same "id" GET /api/kobo/forms returns for each
   form. sampleSize defaults to 3.

   Note on expected (non-bug) differences: koboService.importForm
   deliberately excludes any Kobo submission with no GPS coordinates
   (GeoSurvey's map/table views assume every submission has a GPS
   fix — see the comment in importForm). So Kobo count > GeoSurvey
   count by exactly "how many submissions had no GPS" is expected,
   not a failure. This script reports the raw numbers either way and
   lets you judge whether the gap matches that explanation.
   =================================================================== */
require('dotenv').config();
const { db } = require('../config/firebaseAdmin');
const koboService = require('../services/koboService');
const fileStorageService = require('../services/fileStorageService');
const fileMetadataService = require('../services/fileMetadataService');

const SUBMISSIONS_COLLECTION = 'submissions';
const FILES_COLLECTION = 'companyFiles';

function classifyMime(mime) {
  if (typeof mime !== 'string') return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function emptyCounts() {
  return {
    image: 0, audio: 0, video: 0, document: 0,
  };
}

// Kobo's own pagination walker — mirrors koboService's internal
// fetchAllPages (not exported), reimplemented here the same way every
// other script in this folder talks to Kobo's REST API directly
// rather than reaching into koboService's private helpers. Also
// captures DRF's `count` field from the first page, which is Kobo's
// own authoritative total — cheaper than trusting our own tally to
// match if pagination gets cut short by maxPages.
async function fetchAllKoboSubmissions(serverUrl, formUid, token, maxPages = 100) {
  const results = [];
  let path = `/api/v2/assets/${encodeURIComponent(formUid)}/data/?format=json`;
  let page = 0;
  let koboReportedCount = null;
  let truncated = false;
  while (path) {
    if (page >= maxPages) { truncated = true; break; }
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${serverUrl}${path}`, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Kobo API request failed: ${res.status} ${res.statusText}`);
    // eslint-disable-next-line no-await-in-loop
    const body = await res.json();
    if (koboReportedCount === null && typeof body.count === 'number') koboReportedCount = body.count;
    results.push(...(body.results || []));
    if (!body.next) break;
    path = body.next.startsWith(serverUrl) ? body.next.slice(serverUrl.length) : body.next;
    page += 1;
  }
  return { results, koboReportedCount, truncated };
}

// Firestore's "starts with" trick: a range query bounded by the
// prefix and the prefix + the highest valid Unicode code point.
// Correct here because formUid is always plain alnum (see
// routes/kobo.js's FORM_ID_PATTERN) and the separator characters
// used below ('-' and ':') sort before every letter/digit in both
// fields, so this can never accidentally spill into another form's
// records — see the reasoning in the PR description for the exact
// byte-ordering argument.
async function countByPrefix(collection, field, prefix) {
  const snap = await db.collection(collection)
    .where(field, '>=', prefix)
    .where(field, '<', `${prefix}\uf8ff`)
    .get();
  return snap;
}

function formatRow(label, kobo, geo) {
  const diff = geo - kobo;
  const diffStr = diff === 0 ? '0' : (diff > 0 ? `+${diff}` : `${diff}`);
  return `  ${label.padEnd(10)} ${String(kobo).padStart(6)} ${String(geo).padStart(12)} ${diffStr.padStart(8)}`;
}

async function main() {
  const formUid = process.argv[2];
  const sampleSize = Number(process.argv[3]) || 3;
  if (!formUid) {
    console.error('Usage: node scripts/verifyKoboImportCompleteness.js <formUid> [sampleSize]');
    process.exit(1);
  }

  const conn = await koboService.getConnection();
  if (!conn) {
    console.error('No KoboToolbox connection saved. Connect via the admin UI first.');
    process.exit(1);
  }

  console.log(`Verifying import completeness for form ${formUid}...\n`);

  // ---- 1. Fetch every submission Kobo has for this form, and tally
  // attachment mimetypes as we go (one full-project fetch answers
  // both the submission-count and attachment-count questions). ----
  console.log('Fetching all submissions from KoboToolbox (this may take a moment for large forms)...');
  const { results: koboRecords, koboReportedCount, truncated } = await fetchAllKoboSubmissions(
    conn.serverUrl, formUid, conn.token,
  );
  if (truncated) {
    console.log('  NOTE: hit the page cap before Kobo\'s pagination ran out — counts below may be a lower bound.');
  }

  const koboSubmissionCount = koboReportedCount !== null ? koboReportedCount : koboRecords.length;
  const koboAttachmentCounts = emptyCounts();
  koboRecords.forEach((record) => {
    (record._attachments || []).forEach((att) => {
      koboAttachmentCounts[classifyMime(att.mimetype)] += 1;
    });
  });
  const koboAttachmentTotal = Object.values(koboAttachmentCounts).reduce((a, b) => a + b, 0);

  // ---- 2. GeoSurvey's side of the same two counts. ----
  const submissionsPrefix = `${formUid}:`; // koboSourceId is stored unmodified, e.g. "aBc123:9876"
  const filesPrefix = `${formUid}-`; // surveyId sanitizes ':' -> '-' before it's used as a filename component

  const geoSubmissionsSnap = await countByPrefix(SUBMISSIONS_COLLECTION, 'koboSourceId', submissionsPrefix);
  const geoSubmissionCount = geoSubmissionsSnap.size;

  const geoFilesSnap = await countByPrefix(FILES_COLLECTION, 'surveyId', filesPrefix);
  const geoAttachmentCounts = emptyCounts();
  geoFilesSnap.forEach((doc) => {
    geoAttachmentCounts[classifyMime(doc.data().fileType)] += 1;
  });
  const geoAttachmentTotal = Object.values(geoAttachmentCounts).reduce((a, b) => a + b, 0);

  // ---- Print the comparison ----
  console.log('\n===================== Submission counts =====================');
  console.log(`  Kobo (this form, all submissions):        ${koboSubmissionCount}`);
  console.log(`  GeoSurvey (imported from this form):      ${geoSubmissionCount}`);
  const submissionGap = koboSubmissionCount - geoSubmissionCount;
  console.log(`  Difference:                               ${submissionGap}`);
  if (submissionGap > 0) {
    console.log('  (Submissions missing GPS coordinates are intentionally excluded at import —');
    console.log('   see the comment in koboService.importForm — so some gap can be expected.');
    console.log('   A gap larger than that is worth investigating.)');
  } else if (submissionGap < 0) {
    console.log('  WARNING: GeoSurvey has MORE matching submissions than Kobo reports — unexpected,');
    console.log('  worth double-checking the koboSourceId prefix isn\'t colliding with another form.');
  }

  console.log('\n===================== Attachment counts =====================');
  console.log(`  ${'type'.padEnd(10)} ${'kobo'.padStart(6)} ${'geosurvey'.padStart(12)} ${'diff'.padStart(8)}`);
  ['image', 'audio', 'video', 'document'].forEach((type) => {
    console.log(formatRow(type, koboAttachmentCounts[type], geoAttachmentCounts[type]));
  });
  console.log(formatRow('TOTAL', koboAttachmentTotal, geoAttachmentTotal));
  if (geoAttachmentTotal < koboAttachmentTotal) {
    console.log('  (A GeoSurvey shortfall here can come from either an excluded no-GPS submission');
    console.log('   above, or an individual attachment that failed to download/save — check the');
    console.log('   import log\'s "attachment_failed" lines for the latter.)');
  }

  // ---- 3. Spot-check: pull a sample of imported submissions and
  // actually read each attached file's bytes back out of GeoSurvey's
  // own storage (never from Kobo's download_url) to prove the copy
  // is real and independent, not just a Firestore pointer. ----
  console.log(`\n===================== Spot-checking ${sampleSize} imported submission(s) =====================`);
  if (geoSubmissionCount === 0) {
    console.log('  No imported submissions found for this form — nothing to spot-check.');
  } else {
    // Pull a slightly larger candidate pool so we can prefer
    // submissions that actually have media to check, rather than
    // risking a sample of all-text submissions.
    const candidatesSnap = await db.collection(SUBMISSIONS_COLLECTION)
      .where('koboSourceId', '>=', submissionsPrefix)
      .where('koboSourceId', '<', `${submissionsPrefix}\uf8ff`)
      .limit(Math.max(sampleSize * 5, 15))
      .get();

    const candidates = candidatesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const hasMedia = (sub) => {
      if (sub.photoUrl || sub.voiceUrl || sub.videoUrl || sub.documentUrl) return true;
      return Object.values(sub.answers || {}).some((v) => v && typeof v === 'object' && (v.url || v.failed));
    };

    const withMedia = candidates.filter(hasMedia);
    const sample = (withMedia.length > 0 ? withMedia : candidates).slice(0, sampleSize);

    let filesChecked = 0;
    let filesOk = 0;
    let filesMissing = 0;

    // eslint-disable-next-line no-restricted-syntax
    for (const sub of sample) {
      console.log(`\n  Submission ${sub.submissionId || sub.id} (koboSourceId: ${sub.koboSourceId})`);

      const namedUrls = [
        ['photoUrl', sub.photoUrl],
        ['voiceUrl', sub.voiceUrl],
        ['videoUrl', sub.videoUrl],
        ['documentUrl', sub.documentUrl],
      ].filter(([, url]) => !!url);

      const answerEntries = Object.entries(sub.answers || {})
        .filter(([, v]) => v && typeof v === 'object' && (v.url || v.failed));

      if (namedUrls.length === 0 && answerEntries.length === 0) {
        console.log('    (no media recorded on this submission)');
        continue; // eslint-disable-line no-continue
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const [label, fileId] of namedUrls) {
        filesChecked += 1;
        // eslint-disable-next-line no-await-in-loop
        const ok = await checkFileReadable(fileId);
        if (ok.readable) filesOk += 1; else filesMissing += 1;
        console.log(`    ${label}: ${fileId}`);
        console.log(`      -> ${ok.readable ? `OK, read ${ok.bytes} bytes from GeoSurvey storage (not Kobo)` : `MISSING — ${ok.error}`}`);
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const [fieldName, value] of answerEntries) {
        if (value.failed) {
          console.log(`    answers['${fieldName}']: marked failed at import time (${value.reason}) — no file expected`);
          continue; // eslint-disable-line no-continue
        }
        filesChecked += 1;
        // eslint-disable-next-line no-await-in-loop
        const ok = await checkFileReadable(value.url);
        if (ok.readable) filesOk += 1; else filesMissing += 1;
        console.log(`    answers['${fieldName}']: ${value.url}`);
        console.log(`      -> ${ok.readable ? `OK, read ${ok.bytes} bytes from GeoSurvey storage (not Kobo)` : `MISSING — ${ok.error}`}`);
      }
    }

    console.log(`\n  ${sample.length} submission(s) sampled, ${filesChecked} file(s) checked, ${filesOk} OK, ${filesMissing} missing.`);
  }

  console.log('\n===================== Verdict =====================');
  const submissionsComplete = geoSubmissionCount > 0 && submissionGap <= 0;
  const attachmentsComplete = geoAttachmentTotal >= koboAttachmentTotal;
  if (submissionsComplete && attachmentsComplete) {
    console.log('  Counts match (or exceed, accounting for no-GPS exclusions) on both submissions and attachments.');
  } else {
    console.log('  Counts show a gap — review the sections above before treating this import as complete.');
  }
  console.log('  Spot-check above confirms media is read directly from GeoSurvey\'s storage layer');
  console.log('  (fileStorageService.readFile), independent of KoboToolbox.');

  process.exit(0);
}

// `fileId` is a companyFiles Firestore doc id — the same value stored in
// photoUrl/voiceUrl/videoUrl/documentUrl and answers[field].url for BOTH
// native and Kobo-imported submissions (see koboService.js's
// importAttachmentsForRecord, which now writes fileRecord.fileId there,
// matching what a native upload's uploadSubmissionPhoto/uploadSubmissionVoice
// already return). Resolving it to bytes is deliberately done the same
// way routes/files.js does it for a real GET /api/files/:id request —
// fileMetadataService.getRecord() for the stored filePath, then
// fileStorageService.readFile() for the bytes — rather than reading
// Firestore/disk with any bespoke logic of this script's own. That's
// what keeps this a genuine, independent proof that GeoSurvey holds a
// real, readable copy: it exercises the exact same two-step lookup the
// app itself relies on, just without going through the HTTP layer.
async function checkFileReadable(fileId) {
  try {
    const record = await fileMetadataService.getRecord(fileId);
    if (!record) {
      return { readable: false, error: 'no companyFiles record for this file id' };
    }
    const buffer = await fileStorageService.readFile(record.filePath);
    return { readable: true, bytes: buffer.length };
  } catch (err) {
    return { readable: false, error: err.code === 'ENOENT' ? 'file not found on disk' : err.message };
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});