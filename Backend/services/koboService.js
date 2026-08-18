/* ===================================================================
   services/koboService.js
   ---------------------------------------------------------------
   Real integration with the KoboToolbox REST API (v2). Replaces the
   old frontend-only mock: the API token now lives server-side only
   (encrypted at rest in Firestore), and every "form list" / "import"
   action the admin UI shows is a live call to Kobo, not a canned
   demo array.

   Firestore:
     koboConnections/default
       { serverUrl, encryptedToken: { iv, tag, data } (base64 each),
         connectedBy, connectedAt }
     One connection for the whole app (matches the single admin-facing
     "Connect to KoboToolbox" panel in the UI) rather than per-user —
     change this to a per-uid doc id if independent per-admin
     connections are ever needed.

   Encryption: AES-256-GCM using KOBO_TOKEN_ENCRYPTION_KEY (a 32-byte
   key, hex-encoded — 64 hex chars) from the environment. Generate one
   with:
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   Add it to .env as KOBO_TOKEN_ENCRYPTION_KEY=<that value>. Never
   reuse the same key across environments; losing it means any stored
   token becomes unrecoverable (by design — rotate the Kobo token and
   reconnect rather than trying to recover it).

   Requires Node 18+ (uses the global `fetch`). If this backend runs on
   an older Node, install node-fetch and swap the `fetch(...)` calls
   below for it.

   Form-definition export (buildFormExportWorkbook, below) uses the
   `exceljs` package to build a real .xlsx workbook — not part of this
   backend's existing dependencies, so:
     npm install exceljs
   =================================================================== */
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { db, admin } = require('../config/firebaseAdmin');
const fileStorageService = require('./fileStorageService');
const fileMetadataService = require('./fileMetadataService');
const { isValidFileId } = require('../utils/fileIdPattern');

const CONNECTIONS_COLLECTION = 'koboConnections';
const CONNECTION_DOC_ID = 'default';
const SUBMISSIONS_COLLECTION = 'submissions';

const ALGO = 'aes-256-gcm';

// Kobo-imported submissions now get tied to an auto-mapped forms/{id}
// template where possible (see resolveFormTemplate/resolvedFormId in
// importForm below) — but their media still doesn't route through
// formFolderService's claim system the way a normal admin-created
// form's uploads do. That system's (1)/(2)/... de-dup only runs
// against forms actually built by hand in the Form Builder and knows
// nothing about Kobo-originated ones, so every Kobo form instead gets
// its own storage folder here, namespaced with this prefix so it can
// never collide with a real claimed folder name.
const KOBO_STORAGE_FOLDER_PREFIX = 'Kobo Import - ';

// Attachment filenames/koboIds only ever need to become part of a
// filename (via fileStorageService.saveFile's surveyId param), so they
// go through the same safe, boring character set as every other
// on-disk identifier in this app.
const UNSAFE_SURVEY_ID_CHARS = /[^A-Za-z0-9_-]/g;

function getEncryptionKey() {
  const hex = process.env.KOBO_TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    const err = new Error(
      'KOBO_TOKEN_ENCRYPTION_KEY is not set (or is not a 64-character hex string). '
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
    err.statusCode = 500;
    throw err;
  }
  return Buffer.from(hex, 'hex');
}

function encryptToken(plainToken) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
}

function decryptToken(enc) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(enc.data, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

// Accepts either a bare hostname ("kf.kobotoolbox.org") or a full URL
// pasted into the "Custom server URL" field; always resolves down to
// just an https:// origin, dropping any path/query the admin might
// have included — the actual Kobo API path is always appended by this
// service, never trusted verbatim from client input.
function normalizeServerUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    const err = new Error('Server is required.');
    err.statusCode = 400;
    throw err;
  }
  let candidate = raw.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    const err = new Error('Invalid server URL.');
    err.statusCode = 400;
    throw err;
  }
  if (url.protocol !== 'https:') {
    const err = new Error('Server URL must use https://.');
    err.statusCode = 400;
    throw err;
  }
  return url.origin;
}

async function koboFetch(serverUrl, path, token, options = {}) {
  const res = await fetch(`${serverUrl}${path}`, {
    ...options,
    headers: {
      // KoboToolbox uses DRF TokenAuthentication — the header scheme
      // is literally "Token <value>", not "Bearer <value>".
      Authorization: `Token ${token}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('KoboToolbox rejected this token (invalid, expired, or insufficient permissions).');
    err.statusCode = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`KoboToolbox request failed (${res.status}).`);
    err.statusCode = 502;
    throw err;
  }
  return res.json();
}

async function testConnection(serverUrl, token) {
  // Cheapest authenticated call available — confirms the token
  // actually works against this exact server before persisting
  // anything.
  await koboFetch(serverUrl, '/api/v2/assets/?format=json&limit=1', token);
}

async function saveConnection(rawServerUrl, token, connectedByUid) {
  if (typeof token !== 'string' || !token.trim()) {
    const err = new Error('API token is required.');
    err.statusCode = 400;
    throw err;
  }
  const serverUrl = normalizeServerUrl(rawServerUrl);
  await testConnection(serverUrl, token.trim());

  const encryptedToken = encryptToken(token.trim());
  await db.collection(CONNECTIONS_COLLECTION).doc(CONNECTION_DOC_ID).set({
    serverUrl,
    encryptedToken,
    connectedBy: connectedByUid,
    connectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { serverUrl };
}

async function getConnection() {
  const snap = await db.collection(CONNECTIONS_COLLECTION).doc(CONNECTION_DOC_ID).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return { serverUrl: data.serverUrl, token: decryptToken(data.encryptedToken) };
}

async function clearConnection() {
  await db.collection(CONNECTIONS_COLLECTION).doc(CONNECTION_DOC_ID).delete();
}

function requireConnection(conn) {
  if (!conn) {
    const err = new Error('Not connected to KoboToolbox.');
    err.statusCode = 400;
    throw err;
  }
}

// Follows Kobo's `next` pagination link until exhausted. Capped so a
// misbehaving server (or an account with an unusually large number of
// assets/submissions) can't make this loop forever.
async function fetchAllPages(serverUrl, firstPath, token, maxPages = 40) {
  const results = [];
  let path = firstPath;
  let page = 0;
  while (path && page < maxPages) {
    // eslint-disable-next-line no-await-in-loop
    const body = await koboFetch(serverUrl, path, token);
    results.push(...(body.results || []));
    if (!body.next) break;
    // `next` comes back as a full URL from Kobo; strip the origin back
    // off so the `${serverUrl}${path}` concatenation in koboFetch still
    // works on the following iteration.
    path = body.next.startsWith(serverUrl) ? body.next.slice(serverUrl.length) : body.next;
    page += 1;
  }
  return results;
}

// XLSForm/Kobo question types whose answer value is a reference to an
// uploaded file rather than a plain answer. This is the authoritative
// list the importer should use to decide "does this answer need a
// file downloaded", instead of guessing from the answer value's shape
// (see scripts/inspectKoboSubmission.js, which showed those values are
// bare filenames — this is the other half: knowing WHICH answer keys
// to even look at).
//
// Deliberately NOT included: 'background-audio' (audio recorded
// silently for the whole submission, not tied to one question — a
// real Kobo type, but a different feature with different handling;
// left out so it isn't accidentally treated as a normal media answer
// until that's explicitly designed for).
const MEDIA_QUESTION_TYPES = new Set(['image', 'audio', 'video', 'file', 'signature']);

// Some Kobo/Enketo deployments still express "signature" as an
// ordinary `image` question with `appearance: "signature"` rather
// than the dedicated `signature` type (which is the newer, more
// common form). Both end up holding an image file, so both are
// reported with type: 'signature' in the returned list — the caller
// shouldn't have to know about this quirk to treat them consistently.
function normalizedFieldType(row) {
  if (row.type === 'image' && typeof row.appearance === 'string' && row.appearance.includes('signature')) {
    return 'signature';
  }
  return row.type;
}

/**
 * getFormMediaFields(formUid)
 * Fetches this form's schema (not its submissions) from Kobo and
 * returns every question that holds a file, in the shape:
 *   [{ name, type, label }, ...]
 *
 * `name` is the fully qualified answer key as it will appear in a
 * submission's JSON — i.e. group-prefixed with '/' when the question
 * lives inside a begin_group/begin_repeat, matching how Kobo actually
 * keys grouped answers (e.g. "site_info/photo"), not just the bare
 * question name. `type` is one of MEDIA_QUESTION_TYPES' values (or
 * 'signature' for the image+appearance quirk above). `label` is the
 * question's own label where present, purely for human-readable
 * logging/debugging — never used as a key.
 *
 * NOTE on repeats: a question inside a begin_repeat still gets a
 * qualified name here (e.g. "damage_photos/photo"), but a real
 * submission stores repeat instances as an array of objects under the
 * repeat's own key rather than one flat top-level field — matching
 * those to _attachments correctly is a separate concern from simply
 * knowing the field exists, and isn't handled by this function.
 */
async function getFormMediaFields(formUid) {
  const conn = await getConnection();
  requireConnection(conn);

  const asset = await koboFetch(conn.serverUrl, `/api/v2/assets/${encodeURIComponent(formUid)}/?format=json`, conn.token);
  const survey = (asset.content && Array.isArray(asset.content.survey)) ? asset.content.survey : [];

  const mediaFields = [];
  const groupStack = [];

  survey.forEach((row) => {
    const type = row.type;

    if (type === 'begin_group' || type === 'begin_repeat') {
      // Deployed forms carry a stable machine name on `name` (or
      // `$autoname` if the row predates a manual rename) — either
      // works as a path segment; `name` is preferred since it's what
      // actually shows up in submission JSON keys.
      groupStack.push(row.name || row.$autoname || row.$kuid);
      return;
    }
    if (type === 'end_group' || type === 'end_repeat') {
      groupStack.pop();
      return;
    }

    if (!MEDIA_QUESTION_TYPES.has(type) && normalizedFieldType(row) !== 'signature') return;

    const bareName = row.name || row.$autoname;
    if (!bareName) return; // malformed row; nothing to key an answer by

    const qualifiedName = [...groupStack, bareName].join('/');
    const label = Array.isArray(row.label) ? row.label[0] : row.label;

    mediaFields.push({ name: qualifiedName, type: normalizedFieldType(row), label: label || null });
  });

  return mediaFields;
}

// Kobo's own bookkeeping rows — populated automatically by Kobo/Enketo,
// never actually presented to a respondent as a question — so they're
// left out of a "here's what this form asks" preview the same way
// splitKoboRecord() (below) treats their submission-side counterparts
// as metadata rather than answers.
const META_QUESTION_TYPES = new Set([
  'start', 'end', 'today', 'deviceid', 'phonenumber', 'username',
  'simserial', 'subscriberid', 'caseid', 'audit',
]);

/**
 * getFormFields(formUid)
 * Fetches this form's schema (not its submissions) from Kobo and
 * returns its full question list — every question a respondent
 * actually sees, not just the media ones getFormMediaFields() above
 * cares about — in the shape:
 *   [{ name, label, type }, ...]
 *
 * Read-only preview for the admin UI: lets an admin see what a Kobo
 * form actually asks before importing it. Shares getFormMediaFields()'s
 * asset-fetch + group-stack walk so qualified names line up with real
 * submission keys the same way (see that function's own doc comment
 * for the group/repeat naming details), just without the media-type
 * filter.
 */
async function getFormFields(formUid) {
  const conn = await getConnection();
  requireConnection(conn);

  const asset = await koboFetch(conn.serverUrl, `/api/v2/assets/${encodeURIComponent(formUid)}/?format=json`, conn.token);
  const survey = (asset.content && Array.isArray(asset.content.survey)) ? asset.content.survey : [];

  const fields = [];
  const groupStack = [];

  survey.forEach((row) => {
    const type = row.type;

    if (type === 'begin_group' || type === 'begin_repeat') {
      groupStack.push(row.name || row.$autoname || row.$kuid);
      return;
    }
    if (type === 'end_group' || type === 'end_repeat') {
      groupStack.pop();
      return;
    }

    if (!type || META_QUESTION_TYPES.has(type)) return;

    const bareName = row.name || row.$autoname;
    if (!bareName) return; // malformed row; nothing to key an answer by

    const qualifiedName = [...groupStack, bareName].join('/');
    const label = Array.isArray(row.label) ? row.label[0] : row.label;

    fields.push({ name: qualifiedName, label: label || null, type: normalizedFieldType(row) });
  });

  return fields;
}

const FORMS_COLLECTION = 'forms';
// index.html's Survey Templates page (a separate list from the Form
// Builder's own forms/{id} templates) reads this collection directly —
// see its "Save Template" button handler for the doc shape this module
// mirrors in ensureFirstSurveyTemplateVersion below.
const SURVEY_TEMPLATES_COLLECTION = 'surveyTemplates';

// Maps a Kobo/XLSForm question type to the closest GeoSurvey Form
// Builder question type (see index.html's QUESTION_TYPES: short_text,
// number, single_choice, multi_choice, date, gps, photo, audio — no
// video, geotrace/geoshape, barcode, rank, score, etc.). Anything not
// listed here falls back to 'short_text' below rather than being
// dropped — the question still comes through on import so an admin
// can see it and fix up its type by hand in the builder, instead of a
// Kobo question silently vanishing from the imported form.
const KOBO_TYPE_TO_GEOSURVEY_TYPE = {
  text: 'short_text',
  integer: 'number',
  decimal: 'number',
  range: 'number',
  select_one: 'single_choice',
  select_multiple: 'multi_choice',
  date: 'date',
  datetime: 'date',
  time: 'date',
  geopoint: 'gps',
  image: 'photo',
  signature: 'photo',
  audio: 'audio',
};

// Kobo question types that don't collect an actual answer from the
// respondent — display-only notes, computed/hidden values — so unlike
// META_QUESTION_TYPES above (Kobo's own bookkeeping) these DO show up
// in the getFormFields() preview, but shouldn't become an answerable
// GeoSurvey question when a form template is built from this schema.
const NON_ANSWER_QUESTION_TYPES = new Set(['note', 'calculate', 'hidden', 'acknowledge', 'xml-external']);

async function fetchKoboAsset(formUid) {
  const conn = await getConnection();
  requireConnection(conn);
  return koboFetch(conn.serverUrl, `/api/v2/assets/${encodeURIComponent(formUid)}/?format=json`, conn.token);
}

// Kobo keeps a select question's actual choices on a separate sheet
// (content.choices), joined back to the question via
// select_from_list_name — not inline on the survey row itself, unlike
// GeoSurvey's own {id,label,subOptions} option objects. This groups
// that sheet by list_name once so building each select question's
// options below is just a lookup.
function buildChoicesByListName(asset) {
  const choices = (asset.content && Array.isArray(asset.content.choices)) ? asset.content.choices : [];
  const map = {};
  choices.forEach((c) => {
    const listName = c.list_name;
    if (!listName) return;
    const label = Array.isArray(c.label) ? c.label[0] : c.label;
    const name = c.name || c.$autoname;
    if (!name) return;
    if (!map[listName]) map[listName] = [];
    map[listName].push({ name, label: label || name });
  });
  return map;
}

function newKoboImportId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * buildQuestionsFromKoboAsset(asset)
 * Walks the same Kobo survey schema getFormFields()/getFormMediaFields()
 * do, but builds actual GeoSurvey Form Builder question objects
 * ({id, type, label, required, options?}) instead of a flat preview
 * list — this is what lets an imported Kobo form open in the Form
 * Builder afterward like any hand-built one.
 *
 * Each question also carries `koboFieldName`, the same qualified
 * answer key getFormMediaFields()/importAttachmentsForRecord() use —
 * not read by the Form Builder UI, but keeps a traceable link back to
 * the exact Kobo field this question came from for later debugging.
 */
function buildQuestionsFromKoboAsset(asset) {
  const survey = (asset.content && Array.isArray(asset.content.survey)) ? asset.content.survey : [];
  const choicesByListName = buildChoicesByListName(asset);

  const questions = [];
  const groupStack = [];

  survey.forEach((row) => {
    const type = row.type;

    if (type === 'begin_group' || type === 'begin_repeat') {
      groupStack.push(row.name || row.$autoname || row.$kuid);
      return;
    }
    if (type === 'end_group' || type === 'end_repeat') {
      groupStack.pop();
      return;
    }

    if (!type || META_QUESTION_TYPES.has(type) || NON_ANSWER_QUESTION_TYPES.has(type)) return;

    const bareName = row.name || row.$autoname;
    if (!bareName) return;

    const qualifiedName = [...groupStack, bareName].join('/');
    const rawLabel = Array.isArray(row.label) ? row.label[0] : row.label;
    const label = rawLabel || qualifiedName;

    const koboType = normalizedFieldType(row);
    const geoSurveyType = KOBO_TYPE_TO_GEOSURVEY_TYPE[koboType] || 'short_text';

    const question = {
      id: newKoboImportId('kbq'),
      type: geoSurveyType,
      label,
      required: !!row.required,
      koboFieldName: qualifiedName,
    };

    if (geoSurveyType === 'single_choice' || geoSurveyType === 'multi_choice') {
      const listName = row.select_from_list_name;
      const koboChoices = (listName && choicesByListName[listName]) || [];
      question.options = koboChoices.length
        ? koboChoices.map((c) => ({ id: newKoboImportId('kbo'), label: c.label, subOptions: [] }))
        // A select question with no resolvable choice list still gets
        // built rather than dropped — same "surface it, let the admin
        // fix it up" posture as the short_text type fallback above.
        : [{ id: newKoboImportId('kbo'), label: 'Option 1', subOptions: [] }];
    }

    questions.push(question);
  });

  return questions;
}

/**
 * resolveFormTemplate(formUid, formName, importedByUid, presetAsset)
 * Finds (or, on a form's first import, creates) the GeoSurvey
 * forms/{id} template this Kobo form's submissions should be tied to,
 * and returns its id.
 *
 * Matched on koboSourceFormId rather than name/formUid-in-doc-id, so a
 * re-import of the same Kobo form reuses the same template — and,
 * importantly, does NOT overwrite it: an admin may have already
 * edited the auto-mapped questions (fixed a type, added an option,
 * reordered things) since the first import, and a later re-import
 * pulling in new submissions shouldn't silently discard that editing
 * work.
 *
 * `presetAsset`, if given, is used instead of fetching the Kobo asset
 * again — for a caller (e.g. exportFormAndSaveAsTemplate below) that
 * already fetched it for another reason. Still skipped entirely when
 * a template already exists, since it isn't needed in that case.
 */
async function resolveFormTemplate(formUid, formName, importedByUid, presetAsset) {
  const existing = await db.collection(FORMS_COLLECTION)
    .where('koboSourceFormId', '==', formUid).limit(1).get();
  if (!existing.empty) {
    return existing.docs[0].id;
  }

  const asset = presetAsset || await fetchKoboAsset(formUid);
  const questions = buildQuestionsFromKoboAsset(asset);

  const ref = await db.collection(FORMS_COLLECTION).add({
    name: formName,
    description: `Imported from KoboToolbox (form "${formUid}"). Auto-mapped questions — review types and options below.`,
    active: false,
    questions,
    version: 1,
    createdBy: importedByUid,
    koboSourceFormId: formUid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function listForms() {
  const conn = await getConnection();
  requireConnection(conn);
  const assets = await fetchAllPages(
    conn.serverUrl,
    '/api/v2/assets/?format=json&q=asset_type:survey',
    conn.token,
  );
  return assets
    .filter((a) => a.deployment__active) // only deployed forms have real submissions to pull
    .map((a) => ({
      id: a.uid,
      name: a.name || '(untitled form)',
      count: a.deployment__submission_count || 0,
      modified: a.date_modified ? a.date_modified.slice(0, 10) : '',
    }));
}

// Fuller project/form overview than listForms() above — that one is
// filtered down to just "ready to import" candidates (deployed forms
// only, a handful of fields). This one is for the admin's "View Forms"
// browser: every survey asset regardless of deployment state, with the
// extra bookkeeping columns (owner, created date, status) that browser
// wants to show. Read-only, same as listForms — never touches
// Firestore.
async function listFormsOverview() {
  const conn = await getConnection();
  requireConnection(conn);
  const assets = await fetchAllPages(
    conn.serverUrl,
    '/api/v2/assets/?format=json&q=asset_type:survey',
    conn.token,
  );
  return assets.map((a) => ({
    id: a.uid,
    name: a.name || '(untitled form)',
    owner: a.owner__username || '',
    dateCreated: a.date_created ? a.date_created.slice(0, 10) : '',
    // null (rather than 0) when Kobo hasn't reported a count at all —
    // e.g. a draft that's never been deployed has no deployment object
    // to read a count off of. Lets the frontend show "—" instead of a
    // misleading "0 submissions" for those.
    submissionCount: a.has_deployment && typeof a.deployment__submission_count === 'number'
      ? a.deployment__submission_count
      : null,
    // Kobo doesn't expose a single "status" field directly — derive
    // one from has_deployment/deployment__active, the same two flags
    // the rest of this file already keys off of.
    status: !a.has_deployment ? 'draft' : (a.deployment__active ? 'deployed' : 'archived'),
  }));
}

// Kobo internal bookkeeping keys on a survey/choices row — $kuid,
// $autoname, $xpath, etc. Real XLSForm columns never start with "$",
// so these are dropped from the exported workbook rather than shown
// as if they were actual spreadsheet columns an admin authored.
const KOBO_INTERNAL_ROW_KEY = /^\$/;

// label/hint/constraint_message (etc.) come back from Kobo as an
// array — one string per language, in the same order as
// asset.content.translations — rather than the single string an
// untranslated XLSForm column holds. This expands one such value into
// however many "<column>::<language>" columns it actually needs, and
// folds a plain (non-array) value straight through as a single
// "<column>" column, matching how XLSForm itself distinguishes a
// translated column from an untranslated one.
function expandTranslatedValue(columnName, value, translations) {
  if (!Array.isArray(value)) {
    return value === undefined || value === null ? {} : { [columnName]: value };
  }
  const out = {};
  value.forEach((v, i) => {
    if (v === undefined || v === null) return;
    const lang = translations && translations[i] ? translations[i] : null;
    out[lang ? `${columnName}::${lang}` : columnName] = v;
  });
  return out;
}

// Flattens one raw Kobo survey/choices row (as found in
// asset.content.survey / asset.content.choices) into a plain
// { columnName: value } object suitable for a spreadsheet row —
// expanding any translated fields per expandTranslatedValue() above
// and dropping Kobo's internal $-prefixed bookkeeping keys.
//
// One exception: $autoname. A question/choice that was never given an
// explicit "name" in the Kobo form builder has no plain `name` key at
// all — only $autoname, which Kobo generates from its label. Every
// other $-prefixed key ($kuid, $xpath, etc.) really is throwaway
// bookkeeping, but $autoname is the row's only identifier in that
// case, so it's preserved here as `name` — matching the
// row.name || row.$autoname fallback buildQuestionsFromKoboAsset(),
// getFormFields(), and getFormMediaFields() already use when reading
// straight from the live Kobo API. Without this, an auto-named
// question survives a live import fine but comes back with a blank
// name column on a round trip through export -> re-import, since the
// exported .xlsx never captured $autoname in the first place.
function flattenKoboSheetRow(row, translations) {
  const out = {};
  Object.entries(row).forEach(([key, value]) => {
    if (KOBO_INTERNAL_ROW_KEY.test(key)) return;
    Object.assign(out, expandTranslatedValue(key, value, translations));
  });
  if ((out.name === undefined || out.name === '') && row.$autoname) {
    out.name = row.$autoname;
  }
  return out;
}

// Writes `rows` (already-flattened { columnName: value } objects) to
// `sheet`, working out the header row as the union of every column
// used across all rows — rows don't all share the same set of
// columns (e.g. not every survey row has a `constraint`), so this
// can't just read the first row's keys.
function writeFlattenedRowsToSheet(sheet, rows) {
  const columns = [];
  const seen = new Set();
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    });
  });
  if (columns.length === 0) return;
  sheet.columns = columns.map((key) => ({ header: key, key, width: Math.min(Math.max(key.length + 4, 14), 40) }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((row) => {
    sheet.addRow(columns.map((key) => (row[key] === undefined ? '' : row[key])));
  });
}

/**
 * buildFormExportWorkbookFromAsset(asset, formUid)
 * The actual workbook-building logic behind buildFormExportWorkbook
 * below, pulled out so a caller that already has the Kobo asset in
 * hand (exportFormAndSaveAsTemplate) can reuse it without a second
 * Kobo API round trip. `formUid` is only used as a last-resort
 * filename fallback if the asset has no name.
 */
function buildFormExportWorkbookFromAsset(asset, formUid) {
  const content = asset.content || {};
  const survey = Array.isArray(content.survey) ? content.survey : [];
  const choices = Array.isArray(content.choices) ? content.choices : [];
  const settings = content.settings || {};
  // Kobo represents settings as a single object even though XLSForm's
  // own "settings" sheet is a one-row table — normalize to an array
  // of one row here so writeFlattenedRowsToSheet's "union of columns
  // across rows" logic still applies cleanly.
  const settingsRows = Array.isArray(settings) ? settings : (Object.keys(settings).length ? [settings] : []);
  // translations: array of language names (a null entry marks the
  // default/unnamed language), parallel to each label/hint array's
  // own indices — absent entirely on a single-language form.
  const translations = Array.isArray(content.translations) ? content.translations : [];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GeoSurvey — Kobo form export';
  workbook.created = new Date();

  writeFlattenedRowsToSheet(
    workbook.addWorksheet('survey'),
    survey.map((row) => flattenKoboSheetRow(row, translations)),
  );
  writeFlattenedRowsToSheet(
    workbook.addWorksheet('choices'),
    choices.map((row) => flattenKoboSheetRow(row, translations)),
  );
  writeFlattenedRowsToSheet(
    workbook.addWorksheet('settings'),
    settingsRows.map((row) => flattenKoboSheetRow(row, translations)),
  );

  const metaSheet = workbook.addWorksheet('metadata');
  metaSheet.columns = [
    { header: 'Field', key: 'field', width: 22 },
    { header: 'Value', key: 'value', width: 50 },
  ];
  metaSheet.getRow(1).font = { bold: true };
  const status = !asset.has_deployment ? 'draft' : (asset.deployment__active ? 'deployed' : 'archived');
  let serverOrigin = '';
  try { serverOrigin = asset.url ? new URL(asset.url).origin : ''; } catch { serverOrigin = ''; }
  [
    ['Form name', asset.name || '(untitled form)'],
    ['Kobo form ID', asset.uid || formUid],
    ['Kobo owner', asset.owner__username || ''],
    ['Kobo server', serverOrigin],
    ['Status', status],
    ['Date created (Kobo)', asset.date_created || ''],
    ['Date last modified (Kobo)', asset.date_modified || ''],
    ['Submission count at export time', asset.has_deployment ? (asset.deployment__submission_count ?? 0) : 'n/a (not deployed)'],
    ['Exported at', new Date().toISOString()],
  ].forEach(([field, value]) => metaSheet.addRow({ field, value }));

  // Strips only the characters actually invalid in a Windows/macOS
  // filename (/ \ : * ? " < > |), replacing each run with a single
  // "-" — spaces and casing from the Kobo form's own name are kept, so
  // "Water Point Survey" exports as "Water Point Survey.xlsx", not
  // "Water_Point_Survey.xlsx". Matches index.html's sanitizeExportName,
  // used by every other export button in the app, so a form's exported
  // filename is consistent no matter which one produced it.
  const safeName = String(asset.name || formUid).replace(/[\/\\:*?"<>|]+/g, '-').trim().slice(0, 80) || formUid;
  return { workbook, filename: `${safeName}.xlsx` };
}

/**
 * buildFormExportWorkbook(formUid)
 * Fetches a Kobo form's full definition (schema only — never its
 * submissions; see the module doc comment) and converts it into an
 * XLSForm-shaped .xlsx workbook an admin can download and later
 * re-import. See buildFormExportWorkbookFromAsset above for the sheet
 * layout; this is just that function plus the Kobo fetch, kept around
 * for any caller that only wants the file (no template save).
 */
async function buildFormExportWorkbook(formUid) {
  const asset = await fetchKoboAsset(formUid);
  return buildFormExportWorkbookFromAsset(asset, formUid);
}

/**
 * ensureFirstSurveyTemplateVersion(sourceFormId, formData, importedByUid)
 * Mirrors index.html's "Save Template" button (save-as-template-btn):
 * snapshots a forms/{id} doc's current name/description/questions into
 * a new surveyTemplates doc, version 1, so it's visible on the admin's
 * Survey Templates page — not just the Form Builder's own list, which
 * reads the forms collection directly.
 *
 * Only writes a version 1 doc if this sourceFormId has no
 * surveyTemplates entry yet (checked the same way that button does —
 * query by sourceFormId, most recent version first). If one already
 * exists — whether from an earlier "Save Template" click or an earlier
 * export of this same Kobo form — this is a no-op, same "never
 * overwrite a saved version" posture as everywhere else version
 * history is involved in this app. Returns true only when it actually
 * created the version 1 doc.
 */
async function ensureFirstSurveyTemplateVersion(sourceFormId, formData, importedByUid) {
  const existing = await db.collection(SURVEY_TEMPLATES_COLLECTION)
    .where('sourceFormId', '==', sourceFormId).orderBy('version', 'desc').limit(1).get();
  if (!existing.empty) return false;

  await db.collection(SURVEY_TEMPLATES_COLLECTION).add({
    name: formData.name,
    description: formData.description || '',
    koboFormId: formData.koboSourceFormId || null,
    version: 1,
    sourceFormId,
    // Deep-cloned via JSON round-trip, same as save-as-template-btn
    // does client-side, so this snapshot can never be mutated by a
    // later in-place edit to the forms/{id} doc's own questions array.
    questions: JSON.parse(JSON.stringify(formData.questions || [])),
    dateImported: formData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    dateModified: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: importedByUid,
    savedBy: importedByUid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return true;
}

/**
 * exportFormAndSaveAsTemplate(formUid, importedByUid)
 * What the "Export" action in the admin's View Forms browser actually
 * calls: builds the same .xlsx definition file buildFormExportWorkbook
 * does, resolves (finds-or-creates) the matching GeoSurvey forms/{id}
 * Draft Template, AND snapshots that template into the Survey
 * Templates page as its version 1 (see ensureFirstSurveyTemplateVersion
 * above) — so exporting a Kobo form makes it show up in both places an
 * admin would look for it, not just the Form Builder's own list.
 *
 * Fetches the Kobo asset once and reuses it for the workbook and the
 * forms/{id} template, rather than two separate Kobo API round trips.
 *
 * Returns { workbook, filename, templateId, templateCreated,
 * surveyTemplateCreated } — templateCreated/surveyTemplateCreated are
 * each false when that particular doc already existed (the export
 * still succeeds either way; nothing existing is overwritten).
 */
async function exportFormAndSaveAsTemplate(formUid, importedByUid) {
  const asset = await fetchKoboAsset(formUid);
  const { workbook, filename } = buildFormExportWorkbookFromAsset(asset, formUid);

  // resolveFormTemplate only ever returns the template id, not whether
  // it created one — checking here first (a cheap indexed limit(1)
  // read) is what lets us report templateCreated below without
  // changing that function's return shape for its other caller
  // (importForm's live-API path, which doesn't need this flag).
  const existing = await db.collection(FORMS_COLLECTION)
    .where('koboSourceFormId', '==', formUid).limit(1).get();
  const templateCreated = existing.empty;
  const templateId = await resolveFormTemplate(formUid, asset.name || '(untitled form)', importedByUid, asset);

  // Read back the resulting forms/{id} doc (rather than reusing
  // locally-computed values) so the Survey Templates snapshot always
  // matches what the Form Builder actually has for this template —
  // true whether it was just created above or already existed from an
  // earlier import.
  const formSnap = await db.collection(FORMS_COLLECTION).doc(templateId).get();
  const formData = formSnap.exists ? formSnap.data() : {};
  const surveyTemplateCreated = await ensureFirstSurveyTemplateVersion(templateId, formData, importedByUid);

  return {
    workbook, filename, templateId, templateCreated, surveyTemplateCreated,
  };
}

// ===================================================================
// Import Form (from a previously-exported .xlsx workbook)
// -------------------------------------------------------------------
// The reverse of buildFormExportWorkbook above: takes a workbook built
// by that function (survey/choices/settings/metadata sheets) — whether
// downloaded straight from GeoSurvey or handed off and possibly
// touched up by hand in Excel — validates its structure, converts it
// into GeoSurvey Form Builder questions (reusing
// buildQuestionsFromKoboAsset against a synthesized
// {content:{survey,choices}} "asset", same as the live-API import
// path does), and saves it as a new, inactive forms/{id} Draft
// Template.
//
// Kept as its own function rather than folded into resolveFormTemplate
// above: the failure mode here is different on purpose. resolveFormTemplate
// is a live re-sync, so it reuses an existing template and never
// overwrites an admin's edits. This is a one-off file upload, so a
// re-upload of a form that's already been imported is REJECTED with a
// clear "already imported" message instead — the admin's likely intent
// is "did I already do this?", not "sync this again".
// ===================================================================

const KOBO_FORM_ID_PATTERN = /^[A-Za-z0-9]{1,40}$/;
const REQUIRED_IMPORT_SHEETS = ['survey', 'metadata'];

// Best-effort flattening of whatever ExcelJS hands back for a cell:
// plain values (string/number/boolean/Date) pass straight through;
// rich-text/hyperlink/formula cells (typeof 'object') are reduced to
// their displayable text so a hand-edited workbook doesn't break
// parsing just because Excel stored a cell in one of those richer
// forms.
function cellToPlainValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
  if (typeof value.text === 'string') return value.text; // hyperlink cell
  if (value.result !== undefined) return value.result; // formula cell
  return value;
}

function getSheetHeaders(sheet) {
  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cellToPlainValue(cell.value) ?? '').trim();
  });
  return headers;
}

// Reads every data row (row 2 onward) of `sheet` into a plain
// { header: value } object per row, using row 1 as the header — the
// inverse of writeFlattenedRowsToSheet above. Rows with no non-empty
// cells at all are dropped (trailing blank rows are common in a
// hand-edited workbook).
function readSheetRows(sheet) {
  const headers = getSheetHeaders(sheet);
  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const obj = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      const value = cellToPlainValue(cell.value);
      if (value !== null && value !== undefined && value !== '') hasValue = true;
      obj[key] = value;
    });
    if (hasValue) rows.push(obj);
  }
  return rows;
}

// expandTranslatedValue (above) expands a translated column like
// `label` into `label::English`, `label::French`, ... on export. This
// is the inverse lookup: prefer the plain, untranslated column if
// present, otherwise fall back to whichever `<base>::<language>`
// column comes first — good enough to recover a single display
// label, which is all question-building below actually needs.
function pickPrimaryColumn(row, baseName) {
  if (row[baseName] !== undefined && row[baseName] !== '') return row[baseName];
  const key = Object.keys(row).find((k) => k.startsWith(`${baseName}::`) && row[k] !== '');
  return key ? row[key] : undefined;
}

// A checkbox-style column round-trips through Excel in more shapes
// than just a JS boolean (e.g. hand-typed "TRUE"/"yes"/"1") — this
// normalizes any of those to a real boolean so buildQuestionsFromKoboAsset's
// `!!row.required` behaves whether the workbook came straight from
// buildFormExportWorkbook or was edited by hand.
function coerceRequired(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
  return false;
}

// Reshapes raw `survey`/`choices` sheet rows into the same row shape
// buildQuestionsFromKoboAsset() expects from a live Kobo asset's
// content.survey/content.choices (label collapsed to a plain string,
// required coerced to a real boolean) so that function can be reused
// unchanged for both the live-API and file-upload import paths.
function normalizeImportedSurveyRows(rows) {
  return rows.map((row) => ({
    ...row,
    name: row.name || row.$autoname,
    label: pickPrimaryColumn(row, 'label'),
    required: coerceRequired(row.required),
  }));
}

function normalizeImportedChoiceRows(rows) {
  return rows.map((row) => ({
    ...row,
    name: row.name || row.$autoname,
    label: pickPrimaryColumn(row, 'label'),
  }));
}

// The `metadata` sheet is a two-column Field/Value table (see
// buildFormExportWorkbook), not a data table with a header per
// column — read it into a simple { 'Field text': value } lookup
// instead of reusing readSheetRows' row-per-object shape as-is.
function readMetadataSheetValues(sheet) {
  const out = {};
  readSheetRows(sheet).forEach((row) => {
    const field = row.Field ?? row.field;
    if (field) out[String(field).trim()] = row.Value ?? row.value;
  });
  return out;
}

/**
 * validateAndParseImportWorkbook(workbook)
 * Checks the workbook actually looks like a GeoSurvey Kobo-form
 * export before any of it is trusted, collecting every problem found
 * (rather than stopping at the first) so an admin fixing a hand-edited
 * file isn't stuck fixing one error per re-upload.
 *
 * Returns { errors, surveyRows, choiceRows, metadata }. `errors` is
 * empty when (and only when) the workbook is importable; the other
 * three fields are only meaningfully populated in that case.
 */
function validateAndParseImportWorkbook(workbook) {
  const errors = [];

  const missingSheets = REQUIRED_IMPORT_SHEETS.filter((name) => !workbook.getWorksheet(name));
  missingSheets.forEach((name) => errors.push(`Missing required "${name}" worksheet.`));
  if (missingSheets.length) {
    return {
      errors, surveyRows: [], choiceRows: [], metadata: {},
    };
  }

  const surveySheet = workbook.getWorksheet('survey');
  const choicesSheet = workbook.getWorksheet('choices'); // optional — a form with no select questions has none
  const metadataSheet = workbook.getWorksheet('metadata');

  const surveyHeaders = getSheetHeaders(surveySheet);
  if (!surveyHeaders.includes('type') || !surveyHeaders.includes('name')) {
    errors.push('The "survey" worksheet must have "type" and "name" columns.');
  }

  const rawSurveyRows = readSheetRows(surveySheet);
  if (rawSurveyRows.length === 0) {
    errors.push('The "survey" worksheet has no question rows.');
  }

  const rawChoiceRows = choicesSheet ? readSheetRows(choicesSheet) : [];
  const metadata = readMetadataSheetValues(metadataSheet);

  const koboFormId = metadata['Kobo form ID'];
  if (!koboFormId || !KOBO_FORM_ID_PATTERN.test(String(koboFormId))) {
    errors.push('The "metadata" worksheet is missing a valid "Kobo form ID" value — this file may not be a GeoSurvey Kobo export.');
  }

  return {
    errors,
    surveyRows: normalizeImportedSurveyRows(rawSurveyRows),
    choiceRows: normalizeImportedChoiceRows(rawChoiceRows),
    metadata,
  };
}

/**
 * importFormFromWorkbookBuffer(buffer, importedByUid)
 * Parses an uploaded .xlsx buffer as a GeoSurvey Kobo-export workbook,
 * validates its structure, converts it into GeoSurvey Form Builder
 * questions (reusing buildQuestionsFromKoboAsset against a synthesized
 * {content:{survey,choices}} "asset"), and saves it as a new,
 * inactive forms/{id} Draft Template.
 *
 * Throws (with .statusCode set) instead of returning, for every
 * failure case:
 *   400 — not a readable .xlsx file, or it failed structural
 *         validation (err.validationErrors carries the individual
 *         messages so the caller can show them all at once)
 *   409 — a form with this same Kobo form ID has already been
 *         imported (err.existingFormId names the forms/{id} doc it
 *         collided with)
 */
async function importFormFromWorkbookBuffer(buffer, importedByUid) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    const e = new Error('This file could not be read as an .xlsx workbook.');
    e.statusCode = 400;
    throw e;
  }

  const {
    errors, surveyRows, choiceRows, metadata,
  } = validateAndParseImportWorkbook(workbook);
  if (errors.length) {
    const e = new Error(`This file isn't a valid form template: ${errors.join(' ')}`);
    e.statusCode = 400;
    e.validationErrors = errors;
    throw e;
  }

  const koboFormId = String(metadata['Kobo form ID']).trim();

  // Dedupe check — see this section's own header comment for why this
  // rejects rather than silently reusing the existing template the way
  // resolveFormTemplate's live-API path does.
  const existing = await db.collection(FORMS_COLLECTION)
    .where('koboSourceFormId', '==', koboFormId).limit(1).get();
  if (!existing.empty) {
    const existingDoc = existing.docs[0];
    const e = new Error(`This form has already been imported (as "${existingDoc.data().name}").`);
    e.statusCode = 409;
    e.existingFormId = existingDoc.id;
    throw e;
  }

  const asset = { content: { survey: surveyRows, choices: choiceRows } };
  const questions = buildQuestionsFromKoboAsset(asset);
  if (questions.length === 0) {
    const e = new Error('No importable questions were found in the "survey" worksheet.');
    e.statusCode = 400;
    throw e;
  }

  const formName = (metadata['Form name'] && String(metadata['Form name']).trim()) || 'Imported Kobo Form';
  const description = `Imported from a Kobo form-definition file (Kobo form "${koboFormId}"). Review question types and options below.`;

  const ref = await db.collection(FORMS_COLLECTION).add({
    name: formName,
    // Always imported as an inactive Draft Template — an admin reviews
    // and explicitly activates it, same posture as resolveFormTemplate's
    // live-API path and every hand-built form's initial state.
    active: false,
    description,
    questions,
    version: 1,
    createdBy: importedByUid,
    koboSourceFormId: koboFormId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    // `questions` (and `description`) are included so the frontend can
    // drop this straight into its local FORM_TEMPLATES cache and open the
    // Template Editor on it immediately, instead of waiting on the next
    // Firestore onSnapshot round trip to see what was just imported.
    formId: ref.id,
    name: formName,
    description,
    questions,
    questionCount: questions.length,
    koboFormId,
  };
}

// Kobo prefixes every piece of its own bookkeeping on a submission
// record with "_" (e.g. _id, _geolocation, _submission_time), plus one
// unprefixed "formhub/uuid" field. Anything else is an actual answer.
function splitKoboRecord(record) {
  const meta = {};
  const answers = {};
  Object.entries(record).forEach(([key, value]) => {
    if (key.startsWith('_') || key === 'formhub/uuid') meta[key] = value;
    else answers[key] = value;
  });
  return { meta, answers };
}

/**
 * locateAttachmentsForSubmission({ record, mediaFields, formUid, serverUrl, token })
 * Pure lookup — makes no network calls. For one already-fetched
 * submission and the media fields getFormMediaFields() found for its
 * form, works out exactly where (if anywhere) each field's file
 * lives, WITHOUT downloading it. Kept separate from the actual
 * download so "can this attachment even be located" is independently
 * verifiable/loggable from "did the download itself succeed" — a
 * field that resolves correctly here but then fails to download is a
 * network/auth problem; a field that never resolves here is a data
 * problem (bad match, or the question was left blank).
 *
 * Returns one entry per media field, in the same order mediaFields
 * was given:
 *   {
 *     fieldName, fieldType, value,
 *     found: boolean,
 *     reason: null | 'not_answered' | 'attachment_missing',
 *     attachmentId, mimetype, endpointUrl, requestHeaders,
 *   }
 *
 * Matching logic: `value` is the bare filename Kobo stores as the
 * answer (see scripts/inspectKoboSubmission.js) — it carries no path,
 * no id, nothing else. Kobo's own _attachments entries store the
 * SAME filename as the tail end of their own `filename` field (the
 * rest being a server-side storage path prefix). That shared tail is
 * the only reliable join key between "this answer" and "this
 * attachment" — the attachment objects themselves never reference
 * which question they belong to.
 *
 * `endpointUrl` prefers the `download_url` Kobo already supplies on
 * the matched _attachments entry (the normal, documented way to fetch
 * one). If a deployment's response ever omits that field, this falls
 * back to Kobo's documented attachment-by-id endpoint instead of
 * giving up:
 *   GET /api/v2/assets/{formUid}/data/{koboId}/attachments/{attachmentId}/
 * so a missing download_url doesn't silently mean "unreachable" —
 * there's a second, equally valid path to the same bytes.
 *
 * `requestHeaders` always carries the Token auth header every Kobo
 * attachment endpoint requires — same header shape koboFetch()
 * already uses elsewhere in this file.
 * Missing/empty token is treated as a hard error rather than quietly
 * returning URLs nothing could actually be fetched with.
 */
function locateAttachmentsForSubmission({
  record, mediaFields, formUid, serverUrl, token,
}) {
  if (!token) {
    const err = new Error('Cannot locate attachments without an authenticated Kobo connection.');
    err.statusCode = 401;
    throw err;
  }

  const koboId = record._id;
  const attachments = Array.isArray(record._attachments) ? record._attachments : [];

  return mediaFields.map((field) => {
    const value = record[field.name];

    if (value === undefined || value === null || value === '') {
      return {
        fieldName: field.name,
        fieldType: field.type,
        value: null,
        found: false,
        reason: 'not_answered',
        attachmentId: null,
        mimetype: null,
        endpointUrl: null,
        requestHeaders: null,
      };
    }

    const attachment = attachments.find((att) => att.filename && att.filename.endsWith(value));

    if (!attachment) {
      return {
        fieldName: field.name,
        fieldType: field.type,
        value,
        found: false,
        reason: 'attachment_missing',
        attachmentId: null,
        mimetype: null,
        endpointUrl: null,
        requestHeaders: null,
      };
    }

    const endpointUrl = attachment.download_url
      || `${serverUrl}/api/v2/assets/${encodeURIComponent(formUid)}/data/${encodeURIComponent(koboId)}/attachments/${encodeURIComponent(attachment.id)}/`;

    return {
      fieldName: field.name,
      fieldType: field.type,
      value,
      found: true,
      reason: null,
      attachmentId: attachment.id,
      mimetype: attachment.mimetype || null,
      endpointUrl,
      requestHeaders: { Authorization: `Token ${token}` },
    };
  });
}

// Recognizes the actual bytes of the media formats Enketo/Collect
// (the apps that actually submit to Kobo) commonly produce, independent
// of whatever mimetype Kobo's own _attachments entry declares. This is
// defense-in-depth — the same "verify the actual content, don't just
// trust a declared type" posture routes/upload.js already applies via
// middleware/uploadValidation.js's magic-byte re-check on a live PWA
// upload. Kobo's declared attachment mimetype is reasonably
// trustworthy (it comes from Kobo's own server, not client input this
// app received directly), but this gives an independent second
// opinion rather than a blind pass-through.
//
// Returns null — not a guess — for formats this can't confidently
// distinguish by magic bytes alone (most notably WebM: its EBML
// header is byte-identical whether the file is audio-only or has
// video too). Callers should fall back to the declared mimetype in
// that case rather than being handed a potentially wrong answer.
function sniffMimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  const ascii = (start, len) => buffer.toString('ascii', start, start + len);

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg'; // MP3 frame sync, no ID3 tag

  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4).trim().toLowerCase();
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'm4a' || brand === 'm4b') return 'audio/mp4';
    return 'video/mp4'; // isom/mp41/mp42/avc1/iso2/etc — generic MP4 video container
  }

  // WebM/Matroska EBML header (0x1A 0x45 0xDF 0xA3) — deliberately not
  // matched here; see the function comment above.
  return null;
}

/**
 * downloadKoboAttachment(resolved)
 * Actually fetches one attachment's bytes, given a `found: true` entry
 * from locateAttachmentsForSubmission(). This is the real network I/O
 * everything so far has been resolving toward:
 *
 *   1. authenticated request — resolved.requestHeaders carries the
 *      Token auth header locateAttachmentsForSubmission() already
 *      built for this exact endpoint.
 *   2. binary, not text — reads the response with res.arrayBuffer(),
 *      never .text()/.json(), so raw bytes (JPEG/PNG/MP3/etc.) are
 *      never run through a text decoder that could corrupt them.
 *   3. MIME type detection — sniffMimeFromBuffer() checks the actual
 *      downloaded bytes; falls back to Kobo's own declared mimetype
 *      only for formats the sniffer can't confidently identify (e.g.
 *      WebM), and to 'application/octet-stream' only if neither is
 *      available.
 *   4. original filename preserved — returned as `originalFilename`
 *      for the CALLER to use (e.g. a debug script writing it to disk,
 *      or a log line). This function does not write it anywhere
 *      itself: this app's companyFiles Firestore schema deliberately
 *      never stores a source filename (see the comment at the top of
 *      fileMetadataService.js — "deliberately not persisting the
 *      client's original filename or anything else outside this
 *      list"), so silently adding it to a saved record here would
 *      contradict that documented decision. Persisting it anywhere
 *      new is a call for the caller to make explicitly, not something
 *      this function decides on its own.
 *
 * Throws if `resolved.found` is false — callers should check that (or
 * only ever pass already-filtered found:true entries from
 * locateAttachmentsForSubmission()).
 */
async function downloadKoboAttachment(resolved) {
  if (!resolved || !resolved.found) {
    const err = new Error(
      `Cannot download "${resolved && resolved.fieldName}" — attachment was not located (${resolved && resolved.reason}).`,
    );
    err.statusCode = 404;
    throw err;
  }

  const res = await fetch(resolved.endpointUrl, { headers: resolved.requestHeaders });
  if (!res.ok) {
    const err = new Error(`Failed to download Kobo attachment for "${resolved.fieldName}" (${res.status}).`);
    err.statusCode = 502;
    throw err;
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const sniffed = sniffMimeFromBuffer(buffer);
  const mimeType = sniffed || resolved.mimetype || 'application/octet-stream';

  return {
    buffer,
    mimeType,
    mimeSource: sniffed ? 'sniffed' : (resolved.mimetype ? 'kobo_declared' : 'unknown'),
    originalFilename: resolved.value, // preserved for the caller; not persisted by this function — see comment above
    fieldName: resolved.fieldName,
    attachmentId: resolved.attachmentId,
  };
}

// Maps a media field's schema type (as returned by getFormMediaFields /
// locateAttachmentsForSubmission) to the fileStorageService category it
// belongs in. 'signature' has no dedicated storage category of its own —
// it's still just image bytes on disk, so it's filed under 'photo' like
// any other image question. Any field type not listed here (there isn't
// one today, but this is what protects against a future Kobo question
// type this code doesn't know about yet) is skipped rather than guessed.
const FIELD_TYPE_TO_STORAGE_CATEGORY = {
  image: 'photo',
  signature: 'photo',
  audio: 'audio',
  video: 'video',
  file: 'document',
};

// Maps a storage category to the single submissions/{id} field it's kept
// on. Matches the existing photoUrl/voiceUrl pattern: one slot per media
// type, first attachment of that type wins, extras of the same type are
// skipped (not an array) — same tradeoff this app already made for
// photo/audio, now extended to video/document rather than reconsidered.
const STORAGE_CATEGORY_TO_URL_FIELD = {
  photo: 'photoUrl',
  audio: 'voiceUrl',
  video: 'videoUrl',
  document: 'documentUrl',
};

// Maps a media field's schema type to the word used in progress messages
// (e.g. "Downloading image..."). Kept separate from
// FIELD_TYPE_TO_STORAGE_CATEGORY since the wording an administrator
// reads shouldn't be tied to internal storage-folder naming — 'file'
// fields are stored under the 'document' category but should still
// read as "document" here, not "file".
const FIELD_TYPE_TO_PROGRESS_LABEL = {
  image: 'image',
  signature: 'signature',
  audio: 'audio',
  video: 'video',
  file: 'document',
};

function noopProgress() {}

// Downloads every media attachment on one Kobo record — image, audio,
// video, signature, and file/document questions alike — and saves each
// through the same fileStorageService/fileMetadataService pipeline
// routes/upload.js uses for a live PWA upload, so an imported file is
// indistinguishable on disk and in Firestore from one a worker uploaded
// directly. GeoSurvey ends up owning a permanent local copy of every
// attachment; nothing downstream ever needs to reach back out to Kobo
// for it again.
//
// Reuses locateAttachmentsForSubmission (schema-driven: knows exactly
// which answer keys are media questions and what type each one is,
// rather than guessing from a mimetype string) and downloadKoboAttachment
// (sniffs actual bytes for the MIME type, falling back to Kobo's
// declared mimetype only when sniffing can't tell) — the same functions
// already exercised by scripts/locateKoboAttachments.js and
// scripts/downloadKoboAttachments.js, so the import path and the
// diagnostic path can't silently drift apart.
//
// Runs in two passes rather than one combined download+save loop:
//   1. Download every found attachment, reporting one
//      "Downloading <type>..." progress event per attachment as it
//      starts.
//   2. Once all downloads have settled, report a single "Saving
//      files..." event, then write every successfully-downloaded
//      attachment to disk + Firestore.
// This two-pass shape exists purely to produce the progress sequence
// administrators asked for (all downloads reported, THEN one "saving"
// step) rather than interleaving "Downloading X... / Saving X... /
// Downloading Y... / Saving Y..." per attachment.
//
// Every found attachment is downloaded and stored — not just the first
// of each type — because each one needs to replace ITS OWN answer value
// in-place (see answerReplacements below). The `urls` object below is a
// separate, coarser convenience: still just the first photo/audio/
// video/document found, matching this app's existing single
// photoUrl/voiceUrl/videoUrl/documentUrl submission fields.
//
// Deliberately swallows per-attachment errors (download OR save)
// rather than throwing — one attachment that fails shouldn't sink the
// whole submission's import; that one answer is simply left as Kobo's
// original bare filename string rather than the whole submission
// failing, and the failure is logged for follow-up.
//
// Returns:
//   {
//     urls: { photoUrl, voiceUrl, videoUrl, documentUrl }, // first-of-type, companyFiles fileId|null
//     answerReplacements: {
//       [fieldName]: { filename, url, mimeType }, // one entry per successfully stored attachment
//     },
//   }
// IMPORTANT: `urls.*` and every `answerReplacements[fieldName].url` are
// companyFiles Firestore doc ids (fileRecord.fileId), the exact same
// reference model a native worker upload writes into these fields (see
// index.html's uploadSubmissionPhoto/uploadSubmissionVoice) — NOT a
// storage path. Every consumer of a submission's photoUrl/voiceUrl
// (getMediaObjectUrl -> getFileBlob -> GET /api/files/:id) only knows
// how to resolve a fileId; do not swap this back to fileRecord.filePath.
// `answerReplacements` keys are the SAME qualified field names used as
// keys on the submission's `answers` object (e.g. "site_info/photo") —
// the caller is expected to overwrite answers[fieldName] with the
// returned object in place of Kobo's original bare filename string.
async function importAttachmentsForRecord({
  record, mediaFields, surveyIdForFile, storageFolderName, importedByUid, formId, formUid, serverUrl, token,
  onProgress = noopProgress,
}) {
  const urls = {
    photoUrl: null, voiceUrl: null, videoUrl: null, documentUrl: null,
  };
  const answerReplacements = {};
  if (!storageFolderName) return { urls, answerReplacements };

  const resolved = locateAttachmentsForSubmission({
    record, mediaFields, formUid, serverUrl, token,
  });
  const foundEntries = resolved.filter(
    (r) => r.found && FIELD_TYPE_TO_STORAGE_CATEGORY[r.fieldType],
  );
  if (foundEntries.length === 0) return { urls, answerReplacements };

  // Pass 1: download every attachment, one "Downloading <type>..."
  // event per attachment as it starts. A single attachment's download
  // failing never aborts this loop — every remaining attachment on
  // this submission still gets its turn, and the failed one is marked
  // as failed rather than silently left as Kobo's raw filename string
  // (which would be indistinguishable from a field nothing went wrong
  // with).
  const downloaded = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of foundEntries) {
    const label = FIELD_TYPE_TO_PROGRESS_LABEL[entry.fieldType] || entry.fieldType;
    onProgress({ type: 'downloading', fieldName: entry.fieldName, message: `Downloading ${label}...` });
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await downloadKoboAttachment(entry);
      downloaded.push({ entry, result });
    } catch (err) {
      console.error(
        `[koboService] failed to download attachment for field "${entry.fieldName}" `
        + `(file "${entry.value}", submission ${surveyIdForFile}): ${err.message}`,
      );
      onProgress({
        type: 'attachment_failed',
        fieldName: entry.fieldName,
        filename: entry.value,
        reason: err.message,
        message: `Failed to download ${label} "${entry.value}": ${err.message}`,
      });
      // Explicit failure marker so this field is never confused with
      // one that was simply unanswered or successfully imported —
      // the rest of this submission's attachments (and the
      // submission itself) still proceed normally.
      answerReplacements[entry.fieldName] = {
        filename: entry.value,
        failed: true,
        reason: err.message,
      };
    }
  }
  if (downloaded.length === 0) return { urls, answerReplacements };

  // Pass 2: everything that downloaded successfully gets saved,
  // reported as one batch "Saving files..." event rather than one per
  // attachment.
  onProgress({ type: 'saving', message: 'Saving files...' });
  // eslint-disable-next-line no-restricted-syntax
  for (const { entry, result } of downloaded) {
    const category = FIELD_TYPE_TO_STORAGE_CATEGORY[entry.fieldType];
    try {
      // eslint-disable-next-line no-await-in-loop
      const { relativePath, bytes } = await fileStorageService.saveFile({
        surveyId: surveyIdForFile,
        storageFolderName,
        category,
        buffer: result.buffer,
        mime: result.mimeType,
        timestamp: Date.now(),
      });

      // eslint-disable-next-line no-await-in-loop
      const fileRecord = await fileMetadataService.createRecord({
        firebaseUid: importedByUid,
        surveyId: surveyIdForFile,
        // Kobo imports now do get a forms/{id} template (see
        // resolveFormTemplate) — formId is only null here if that
        // resolution itself failed for this form, same
        // degrade-gracefully fallback importForm uses on the
        // submission doc below.
        formId: formId || null,
        fileType: result.mimeType,
        filePath: relativePath,
        fileSize: bytes,
      });

      // `url` here (and urls[urlField] below) must be fileRecord.fileId —
      // the companyFiles Firestore doc id — NOT fileRecord.filePath.
      // This is the exact same reference model routes/upload.js already
      // uses for a live worker upload (see index.html's
      // uploadSubmissionPhoto/uploadSubmissionVoice, which return
      // record.fileId): GET /api/files/:id validates its :id param
      // against an alphanumeric-only pattern (routes/files.js's
      // isValidFileId, from utils/fileIdPattern.js) and looks it up via
      // fileMetadataService.getRecord(id) — it has no way to resolve a
      // raw storage path. Using fileId here is what lets a
      // Kobo-imported submission's photo/audio load through the exact
      // same getMediaObjectUrl()/getFileBlob() path a native
      // submission's already does, with no branching required anywhere
      // downstream.
      //
      // Enforced, not just documented: fileRecord.fileId is checked
      // against the same shape routes/files.js will later require
      // BEFORE it's allowed anywhere near urls/answerReplacements. This
      // is what makes "the wrong field gets assigned here again" (e.g.
      // filePath instead of fileId, or any future refactor that changes
      // what createRecord returns) fail loudly at import time — as a
      // per-attachment 'attachment_failed' event, same as a download or
      // storage failure — instead of silently writing a reference the
      // read/delete routes will reject later, invisibly, the next time
      // someone tries to view or delete it.
      if (!isValidFileId(fileRecord.fileId)) {
        throw new Error(
          `fileMetadataService.createRecord returned an unusable file id `
          + `("${fileRecord.fileId}") for field "${entry.fieldName}" — refusing to `
          + `save an invalid media reference onto the submission.`,
        );
      }

      answerReplacements[entry.fieldName] = {
        filename: result.originalFilename, // Kobo's original filename, preserved here on the answer itself (not in fileMetadataService — see downloadKoboAttachment's comment on why companyFiles never persists it)
        url: fileRecord.fileId,
        mimeType: result.mimeType,
      };

      const urlField = STORAGE_CATEGORY_TO_URL_FIELD[category];
      if (!urls[urlField]) urls[urlField] = fileRecord.fileId; // first-of-type wins; extras still get their own answerReplacements entry above, just don't also claim the singular convenience field
    } catch (err) {
      console.error(
        `[koboService] failed to save attachment for field "${entry.fieldName}" `
        + `(file "${result.originalFilename}", submission ${surveyIdForFile}): ${err.message}`,
      );
      const label = FIELD_TYPE_TO_PROGRESS_LABEL[entry.fieldType] || entry.fieldType;
      onProgress({
        type: 'attachment_failed',
        fieldName: entry.fieldName,
        filename: result.originalFilename,
        reason: err.message,
        message: `Failed to save ${label} "${result.originalFilename}": ${err.message}`,
      });
      // Same explicit failure marker as a download failure above —
      // this attachment downloaded fine but couldn't be written to
      // disk/Firestore, so it's marked failed rather than left with
      // Kobo's raw filename string. The rest of this submission's
      // attachments still get their turn.
      answerReplacements[entry.fieldName] = {
        filename: result.originalFilename,
        failed: true,
        reason: err.message,
      };
    }
  }

  return { urls, answerReplacements };
}

async function importForm(formUid, formName, importedByUid, onProgress = noopProgress) {
  const conn = await getConnection();
  requireConnection(conn);

  const records = await fetchAllPages(
    conn.serverUrl,
    `/api/v2/assets/${encodeURIComponent(formUid)}/data/?format=json`,
    conn.token,
  );

  // Resolved once for the whole form import, not per record — every
  // submission from this form lands in the same folder. If this fails
  // (e.g. a filesystem issue), submissions still get imported below,
  // just without any media, rather than aborting the whole import.
  let storageFolderName = null;
  try {
    storageFolderName = fileStorageService.sanitizeFormName(`${KOBO_STORAGE_FOLDER_PREFIX}${formName}`);
    await fileStorageService.ensureFolderExists(storageFolderName);
  } catch (err) {
    console.error(`[koboService] could not prepare storage folder for form "${formName}":`, err);
    storageFolderName = null;
  }

  // Also resolved once per form, not per record — every submission from
  // this form is checked against the same schema. If this fails (e.g. a
  // transient Kobo API error), submissions still get imported below,
  // just without any media, same degrade-gracefully behavior as the
  // storage folder above.
  let mediaFields = [];
  try {
    mediaFields = await getFormMediaFields(formUid);
  } catch (err) {
    console.error(`[koboService] could not load media field schema for form "${formName}":`, err);
    mediaFields = [];
  }

  // Resolved (or created, on this form's first import) once per form —
  // every submission from this form gets tied to the same forms/{id}
  // template, which is what lets an admin open it in the Form Builder
  // afterward instead of the import being submission-only data with no
  // form behind it. If this fails (e.g. a transient Kobo API error
  // building the schema), submissions still get imported below, just
  // with formId left null — same degrade-gracefully behavior as the
  // storage folder/media fields above; resolving a template is
  // best-effort and never blocks the import itself.
  let resolvedFormId = null;
  try {
    resolvedFormId = await resolveFormTemplate(formUid, formName, importedByUid);
  } catch (err) {
    console.error(`[koboService] could not resolve/create a form template for "${formName}":`, err);
    resolvedFormId = null;
  }

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  // Indexed rather than for...of so each iteration knows its own
  // position for the "Importing submission N of TOTAL..." progress
  // event — index alone (not imported/skipped/failed counts) matches
  // what an administrator watching the list actually wants: "how far
  // through the batch are we", regardless of how many turned out to be
  // duplicates or failures.
  // eslint-disable-next-line no-plusplus
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const current = i + 1;
    const total = records.length;
    const koboId = record._id;

    onProgress({
      type: 'submission_start', current, total, message: `Importing submission ${current} of ${total}...`,
    });

    if (koboId === undefined || koboId === null) {
      failed += 1;
      onProgress({
        type: 'submission_failed', current, total, message: `Submission ${current} of ${total} failed: missing Kobo record id.`,
      });
      continue; // eslint-disable-line no-continue
    }
    const sourceId = `${formUid}:${koboId}`;

    try {
      // eslint-disable-next-line no-await-in-loop
      const existing = await db.collection(SUBMISSIONS_COLLECTION)
        .where('koboSourceId', '==', sourceId).limit(1).get();
      if (!existing.empty) {
        skipped += 1;
        onProgress({
          type: 'submission_skipped', current, total, message: `Submission ${current} of ${total} skipped (already imported).`,
        });
        continue; // eslint-disable-line no-continue
      }

      const { meta, answers } = splitKoboRecord(record);

      let gps = null;
      const geo = meta._geolocation;
      if (Array.isArray(geo) && typeof geo[0] === 'number' && typeof geo[1] === 'number') {
        gps = new admin.firestore.GeoPoint(geo[0], geo[1]);
      }
      if (!gps) {
        // No coordinates on this Kobo record. GeoSurvey's map/table
        // views assume every submission has a GPS fix, so rather than
        // fabricate one (the old mock always did), this record is
        // counted as failed and left out of Firestore. Revisit if
        // ungeolocated Kobo submissions should still be imported with
        // a null gps.
        failed += 1;
        onProgress({
          type: 'submission_failed', current, total, message: `Submission ${current} of ${total} failed: no GPS coordinates.`,
        });
        continue; // eslint-disable-line no-continue
      }

      const surveyIdForFile = sourceId.replace(UNSAFE_SURVEY_ID_CHARS, '-');

      // eslint-disable-next-line no-await-in-loop
      const { urls, answerReplacements } = await importAttachmentsForRecord({
        record,
        mediaFields,
        surveyIdForFile,
        storageFolderName,
        importedByUid,
        formId: resolvedFormId,
        formUid,
        serverUrl: conn.serverUrl,
        token: conn.token,
        onProgress,
      });
      const {
        photoUrl, voiceUrl, videoUrl, documentUrl,
      } = urls;

      // Every media answer that was successfully downloaded and stored
      // gets its raw Kobo filename replaced with the locally-stored
      // file's info, so the submission record points at GeoSurvey's own
      // copy rather than a Kobo filename that means nothing once this
      // app's connection to that Kobo server is gone. Fields that
      // weren't found or failed to download are left as whatever
      // splitKoboRecord already put there (Kobo's original raw value).
      Object.entries(answerReplacements).forEach(([fieldName, fileInfo]) => {
        answers[fieldName] = fileInfo;
      });

      // eslint-disable-next-line no-await-in-loop
      await db.collection(SUBMISSIONS_COLLECTION).add({
        submissionId: `KB-${formUid.slice(0, 4).toUpperCase()}-${koboId}`,
        koboSourceId: sourceId, // used above to detect duplicates on re-import
        workerId: null,
        workerName: 'Kobo Import',
        supervisorId: null,
        // Ties this submission to the auto-mapped forms/{id} template
        // resolved above (or null if that resolution itself failed for
        // this form — the import still proceeds, it just has no linked
        // template to open in the Form Builder).
        formId: resolvedFormId,
        formVersion: resolvedFormId ? 1 : null,
        formName,
        answers,
        gps,
        photoUrl,
        voiceUrl,
        videoUrl,
        documentUrl,
        memoLen: 0,
        status: 'approved',
        reviewComment: null,
        reviewedBy: null,
        reviewedAt: null,
        koboSubmittedAt: meta._submission_time || null,
        importedBy: importedByUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      imported += 1;
      onProgress({
        type: 'submission_done', current, total, message: 'Submission imported successfully.',
      });
    } catch (err) {
      console.error(`[koboService] failed to import record ${sourceId}:`, err);
      failed += 1;
      onProgress({
        type: 'submission_failed', current, total, message: `Submission ${current} of ${total} failed: ${err.message}`,
      });
    }
  }

  const summary = {
    imported, skipped, failed, total: records.length, formId: resolvedFormId,
  };
  onProgress({
    type: 'import_complete',
    message: `Import complete: ${imported} imported, ${skipped} skipped, ${failed} failed.`,
    ...summary,
  });

  return summary;
}

module.exports = {
  saveConnection,
  getConnection,
  clearConnection,
  listForms,
  listFormsOverview,
  buildFormExportWorkbook,
  exportFormAndSaveAsTemplate,
  getFormFields,
  getFormMediaFields,
  locateAttachmentsForSubmission,
  downloadKoboAttachment,
  importForm,
  importFormFromWorkbookBuffer,
  // Exported so scripts/retryFailedKoboMedia.js can re-run the exact same
  // per-record attachment import logic importForm() uses inline, rather
  // than reimplementing (and risking drifting from) it.
  importAttachmentsForRecord,
  KOBO_STORAGE_FOLDER_PREFIX,
  UNSAFE_SURVEY_ID_CHARS,
  SUBMISSIONS_COLLECTION,
};