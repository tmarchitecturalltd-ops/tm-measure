/**
 * TM Measure — submission backend.
 *
 * Receives JSON POSTs from the TM Measure mobile/web app.
 * Appends one row per room to the bound Google Sheet, and
 * emails a tidy HTML summary to the address set in CONFIG.
 *
 * Deploy as:
 *   Extensions → Apps Script → paste this file → Deploy →
 *   New deployment → Type: Web app → Execute as: Me →
 *   Who has access: Anyone → Deploy.
 *
 * The first deployment asks for OAuth consent to send mail
 * and edit the sheet. Accept it.
 *
 * Author: TM Architectural Designs Ltd.
 */

// ─── CONFIG ────────────────────────────────────────────────
const CONFIG = {
  // Email address that receives every submission.
  // Routed through the inquiries@ alias which forwards to the
  // tmarchitecturalltd@gmail.com inbox.
  // Was inquiries@tmdesignsltd.com. MailApp accepted every message and
  // the send quota decremented, but nothing was ever delivered -- the
  // sheet and Drive filled up correctly for months while no submission
  // notification ever arrived.
  //
  // apps-script-COMPLETE.js was changed to the Gmail address at the
  // time; this copy was not, and the two files have since drifted apart
  // in both directions. Whichever one is deployed, it now sends
  // somewhere that delivers.
  //
  // Point this back at inquiries@ only once that address is confirmed
  // to deliver; test with emailDiagnostic() before trusting it.
  recipientEmail: 'tmarchitecturalltd@gmail.com',

  // Name of the sheet tab used as the customer log.
  // Created automatically on the first submission.
  sheetName: 'Submissions',

  // Company display name used in email signature.
  companyName: 'TM Architectural Designs Ltd.',

  // Photo upload limits — server side. Client compresses to ~200KB
  // but a malicious caller could send anything via raw fetch.
  photoMaxBytes: 5 * 1024 * 1024,           // 5 MB per photo
  photoAllowedMimes: ['image/jpeg', 'image/png', 'image/webp'],

  // Voice-memo upload limits.
  audioMaxBytes: 8 * 1024 * 1024,           // 8 MB ≈ 5 min @ 200 kbps
  audioAllowedMimes: [
    'audio/webm', 'audio/webm;codecs=opus',
    'audio/ogg', 'audio/ogg;codecs=opus',
    'audio/mp4', 'audio/mpeg', 'audio/aac',
    'audio/wav',
  ],
};

/**
 * Architect secret — gate every read / approval endpoint. Set this in
 * Project Settings → Script Properties as `ADMIN_SECRET=<long random>`.
 * If the property is missing the endpoints behave as before (open) to
 * keep the dev experience working, but the script logs a warning that
 * shows up in Stackdriver.
 */
function adminSecret_() {
  const value = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
  if (!value) {
    console.warn('ADMIN_SECRET not set — architect endpoints are unauthenticated.');
    return null;
  }
  return value;
}

/**
 * Constant-time string compare so brute-force timing attacks can't
 * probe the secret character-by-character.
 */
function safeEqual_(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function requireAdminSecret_(provided) {
  const expected = adminSecret_();
  if (expected === null) return; // dev mode — log already warned
  if (!safeEqual_(provided, expected)) {
    throw new Error('Unauthorised. Provide the correct admin secret.');
  }
}

/**
 * Coarse anti-abuse rate limiter. Apps Script web apps run as the
 * deployer identity — there are no per-IP signals — so we cap the
 * global hourly submission count instead. 60 / hour comfortably covers
 * a legitimate weekend trade show but blocks a misconfigured script
 * spamming in a loop.
 */
function checkSubmissionRate_() {
  const cache = CacheService.getScriptCache();
  const hourBucket = String(Math.floor(Date.now() / 3600000));
  const key = 'tm.submitcount.' + hourBucket;
  const current = parseInt(cache.get(key) || '0', 10);
  if (current >= 60) {
    throw new Error('Rate limit reached. Try again in an hour.');
  }
  cache.put(key, String(current + 1), 3700); // 1h + a bit
}

// ─── HTTP ENDPOINTS ────────────────────────────────────────

/**
 * POST /exec — receives a submission from the app.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Empty request body.');
    }
    const payload = JSON.parse(e.postData.contents);

    // Architect-side mutations (currently only "approve") share the
    // POST endpoint so we can demand the admin secret in the request
    // body, never in URL params where it would leak to logs and
    // browser history.
    const action = String(payload.action || '').toLowerCase();
    if (action === 'approve') {
      requireAdminSecret_(payload.secret);
      return jsonResponse_({
        ok: true,
        approvedAt: approveSubmission_(String(payload.id || '')),
      });
    }
    if (action === 'set_status') {
      requireAdminSecret_(payload.secret);
      return jsonResponse_({
        ok: true,
        status: setSubmissionStatus_(
          String(payload.id || ''),
          String(payload.status || ''),
          typeof payload.note === 'string' ? payload.note : '',
        ),
      });
    }
    if (action === 'save_annotation') {
      requireAdminSecret_(payload.secret);
      return jsonResponse_({
        ok: true,
        driveUrl: saveAnnotation_(
          String(payload.id || ''),
          String(payload.name || 'annotation'),
          String(payload.dataUri || ''),
        ),
      });
    }

    validatePayload_(payload);

    // Coarse-grained anti-abuse counter: cap the number of new
    // submissions per UTC hour. CacheService gives us atomic
    // increments without external infra. If exceeded we 429-style
    // bail before doing any Drive / Sheet work.
    checkSubmissionRate_();

    const submissionId = Utilities.getUuid().slice(0, 8).toUpperCase();
    // Tier-2: any photo carrying a dataUri is uploaded to a per-
    // submission Drive folder and the inline data is replaced with a
    // public Drive URL so the sheet/email stay light.
    uploadPhotos_(payload, submissionId);
    appendRows_(payload, submissionId);
    sendEmail_(payload, submissionId);

    return jsonResponse_({ ok: true, submissionId: submissionId });
  } catch (err) {
    console.error(err);
    return jsonResponse_({ ok: false, error: String(err.message || err) });
  }
}

/**
 * GET /exec — health check + architect read-only endpoints.
 *
 *   /exec                                   → health check (no secret)
 *   /exec?action=list&secret=…              → submission summaries
 *   /exec?action=detail&id=…&secret=…       → full payload for one submission
 *
 * Mutating actions (approve) live on doPost so the secret never lands
 * in URL query strings. Read actions still require the secret because
 * the data contains customer PII.
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = String(params.action || '').toLowerCase();
    if (!action) {
      return jsonResponse_({
        ok: true,
        service: 'TM Measure submission endpoint',
        note: 'Use POST to submit. GET supports ?action=status|list|detail.',
      });
    }
    // Customer-facing status lookup. Gated by email match instead
    // of admin secret: caller must already know the submission ID
    // *and* the email on the submission. Returns only public-safe
    // fields (status flags + timestamps), no PII or measurements.
    if (action === 'status') {
      return jsonResponse_({
        ok: true,
        status: getStatusForCustomer_(String(params.id || ''), String(params.email || '')),
      });
    }
    requireAdminSecret_(params.secret);
    if (action === 'list')   return jsonResponse_({ ok: true, submissions: listSubmissions_() });
    if (action === 'detail') return jsonResponse_({ ok: true, submission: getSubmission_(String(params.id || '')) });
    throw new Error('Unknown action: ' + action);
  } catch (err) {
    console.error(err);
    return jsonResponse_({ ok: false, error: String(err.message || err) });
  }
}

// ─── ARCHITECT READ ENDPOINTS ──────────────────────────────

/**
 * Return one row per *submission* (de-duped by submission ID), most
 * recent first. Each entry has just enough to render the list view.
 */
function listSubmissions_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const idxOf = function (h) { return headers.indexOf(h); };
  const cSubmitted = idxOf('Submitted At');
  const cId = idxOf('Submission ID');
  const cName = idxOf('Customer Name');
  const cEmail = idxOf('Email');
  const cProject = idxOf('Project Name');
  const cApproved = idxOf('Approved At'); // -1 if column not present yet
  const cStatus = idxOf('Status');
  const cNote = idxOf('Internal note');

  const byId = {};
  rows.forEach(function (row) {
    const id = String(row[cId] || '');
    if (!id) return;
    if (!byId[id]) {
      byId[id] = {
        id: id,
        submittedAt: row[cSubmitted] ? new Date(row[cSubmitted]).toISOString() : null,
        customerName: row[cName] || '',
        email: row[cEmail] || '',
        projectName: row[cProject] || '',
        roomCount: 0,
        approvedAt: cApproved >= 0 && row[cApproved]
          ? (row[cApproved] instanceof Date ? row[cApproved].toISOString() : String(row[cApproved]))
          : null,
        status: cStatus >= 0 ? String(row[cStatus] || 'pending') : 'pending',
        internalNote: cNote >= 0 ? String(row[cNote] || '') : '',
      };
    }
    byId[id].roomCount += 1;
  });
  return Object.keys(byId)
    .map(function (k) { return byId[k]; })
    .sort(function (a, b) { return (b.submittedAt || '').localeCompare(a.submittedAt || ''); });
}

/**
 * Customer-facing status check. Requires the caller to know BOTH the
 * submission ID and the email on the submission — so leaking an ID
 * alone doesn't expose anything, and enumerating IDs without a known
 * email is fruitless. Returns just enough for a "Where's my quote?"
 * status page: project name, dates, approval flag.
 */
function getStatusForCustomer_(id, email) {
  if (!id) throw new Error('Missing submission ID.');
  if (!email) throw new Error('Missing email.');
  if (!validEmail_(email)) throw new Error('Invalid email.');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  if (!sheet) throw new Error('No matching submission found.');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No matching submission found.');
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const cId = headers.indexOf('Submission ID');
  const cEmail = headers.indexOf('Email');
  const cProject = headers.indexOf('Project Name');
  const cSubmitted = headers.indexOf('Submitted At');
  const cApproved = headers.indexOf('Approved At');
  const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  // Case-insensitive email compare so a different capitalisation
  // still finds the right row.
  const target = email.trim().toLowerCase();
  const match = rows.find(function (r) {
    return String(r[cId] || '') === id &&
      String(r[cEmail] || '').toLowerCase().trim() === target;
  });
  if (!match) throw new Error('No matching submission found.');
  return {
    submissionId: id,
    projectName: match[cProject] || '',
    submittedAt: match[cSubmitted]
      ? new Date(match[cSubmitted]).toISOString()
      : null,
    approvedAt: cApproved >= 0 && match[cApproved]
      ? (match[cApproved] instanceof Date ? match[cApproved].toISOString() : String(match[cApproved]))
      : null,
    state: cApproved >= 0 && match[cApproved] ? 'approved' : 'pending',
  };
}

/**
 * Return the full raw payload for a single submission (parsed from
 * the "Raw payload" column of the first row matching this ID). If
 * the column is missing we fall back to reconstructing from cells.
 */
function getSubmission_(id) {
  if (!id) throw new Error('Missing id.');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  if (!sheet) throw new Error('No Submissions sheet found.');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Submission not found: ' + id);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const cId = headers.indexOf('Submission ID');
  const cRaw = headers.indexOf('Raw payload');
  const cApproved = headers.indexOf('Approved At');
  const cStatus = headers.indexOf('Status');
  const cNote = headers.indexOf('Internal note');
  const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const match = rows.find(function (r) { return String(r[cId] || '') === id; });
  if (!match) throw new Error('Submission not found: ' + id);
  let parsed = null;
  if (cRaw >= 0 && match[cRaw]) {
    try { parsed = JSON.parse(String(match[cRaw])); } catch (err) { parsed = null; }
  }
  if (!parsed) throw new Error('Raw payload missing or corrupt for ' + id);
  parsed.submissionId = id;
  parsed.approvedAt = cApproved >= 0 && match[cApproved]
    ? (match[cApproved] instanceof Date ? match[cApproved].toISOString() : String(match[cApproved]))
    : null;
  parsed.status = cStatus >= 0 ? String(match[cStatus] || 'pending') : 'pending';
  parsed.internalNote = cNote >= 0 ? String(match[cNote] || '') : '';
  return parsed;
}

/**
 * Stamp every row of the matching submission with an "Approved At"
 * timestamp. Adds the column if it doesn't already exist.
 */
function approveSubmission_(id) {
  if (!id) throw new Error('Missing id.');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  if (!sheet) throw new Error('No Submissions sheet found.');
  let lastCol = sheet.getLastColumn();
  let headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  let cApproved = headers.indexOf('Approved At');
  if (cApproved < 0) {
    sheet.insertColumnAfter(lastCol);
    sheet.getRange(1, lastCol + 1).setValue('Approved At')
      .setFontWeight('bold').setBackground('#1c1c1a').setFontColor('#fcf9f5');
    cApproved = lastCol; // 0-indexed
    lastCol = sheet.getLastColumn();
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  }
  const cId = headers.indexOf('Submission ID');
  const now = new Date();
  const lastRow = sheet.getLastRow();
  const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  let touched = 0;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][cId] || '') === id) {
      sheet.getRange(i + 2, cApproved + 1).setValue(now);
      touched++;
    }
  }
  if (!touched) throw new Error('Submission not found: ' + id);
  return now.toISOString();
}

/**
 * Set the architect-side workflow status + optional internal note on
 * every row of a submission. Used by the architect console to flag
 * progress without having to touch the sheet directly.
 *   Valid statuses: pending | in-review | approved | rejected.
 * Auto-adds the "Status" and "Internal note" columns the first time
 * they're written.
 */
function setSubmissionStatus_(id, status, note) {
  if (!id) throw new Error('Missing id.');
  const allowed = ['pending', 'in-review', 'approved', 'rejected'];
  if (allowed.indexOf(status) === -1) {
    throw new Error('Invalid status: ' + status);
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  if (!sheet) throw new Error('No Submissions sheet found.');
  let lastCol = sheet.getLastColumn();
  let headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  // Ensure "Status" and "Internal note" columns exist.
  const ensure = function (name) {
    let idx = headers.indexOf(name);
    if (idx < 0) {
      sheet.insertColumnAfter(lastCol);
      sheet.getRange(1, lastCol + 1).setValue(name)
        .setFontWeight('bold').setBackground('#1c1c1a').setFontColor('#fcf9f5');
      idx = lastCol;
      lastCol = sheet.getLastColumn();
      headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    }
    return idx;
  };
  const cStatus = ensure('Status');
  const cNote = ensure('Internal note');
  const cId = headers.indexOf('Submission ID');
  const lastRow = sheet.getLastRow();
  const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  let touched = 0;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][cId] || '') === id) {
      sheet.getRange(i + 2, cStatus + 1).setValue(status);
      if (note) sheet.getRange(i + 2, cNote + 1).setValue(note);
      touched++;
    }
  }
  if (!touched) throw new Error('Submission not found: ' + id);
  return status;
}

/**
 * Save an architect-drawn annotation. Drops a new JPEG into the
 * submission's Drive folder named `<safe>-annotated-<ts>.jpg` and
 * returns its public URL. Uses the same MIME / size guards as the
 * customer upload path so a hostile actor with the admin secret
 * can't dump executables onto Drive.
 */
function saveAnnotation_(submissionId, suggestedName, dataUri) {
  if (!submissionId) throw new Error('Missing submission ID.');
  if (!dataUri) throw new Error('Missing dataUri.');
  const match = String(dataUri).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Malformed dataUri.');
  const mime = String(match[1]).toLowerCase();
  if (CONFIG.photoAllowedMimes.indexOf(mime) === -1) {
    throw new Error('Disallowed MIME: ' + mime);
  }
  const bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > CONFIG.photoMaxBytes) {
    throw new Error('Annotation too large.');
  }
  const root = findOrCreateFolder_(DriveApp.getRootFolder(), 'TM Measure Submissions');
  const subfolders = root.getFolders();
  let folder = null;
  while (subfolders.hasNext()) {
    const f = subfolders.next();
    if (f.getName().indexOf(submissionId) === 0) { folder = f; break; }
  }
  if (!folder) {
    // No existing folder — create one. Lets the architect annotate
    // submissions made before the Drive-upload feature shipped.
    folder = root.createFolder(submissionId + ' — annotations');
  }
  const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const safe = String(suggestedName || 'photo')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .substring(0, 80);
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const file = folder.createFile(
    Utilities.newBlob(bytes, mime, safe + '-annotated-' + ts + '.' + ext),
  );
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ─── PHOTO UPLOAD ──────────────────────────────────────────

/**
 * Walk every room's photos. If a photo carries a `dataUri` field
 * (base64 JPEG produced by the client-side compressor), upload it
 * to a Drive folder named after the submission ID and rewrite the
 * photo entry in place so the sheet column and the email both link
 * directly to the Drive file rather than embedding raw base64.
 *
 * Drive root is shared with anyone-with-link. Folder names use the
 * submission ID so it's easy to clean up old data.
 *
 * No-op for photos without a dataUri (older clients), so this stays
 * backwards-compatible.
 */
function uploadPhotos_(payload, submissionId) {
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const exterior = payload.exterior && payload.exterior.bySide ? payload.exterior.bySide : null;
  const proposal = payload.proposal && Array.isArray(payload.proposal.sketches) ? payload.proposal : null;
  if (!rooms.length && !exterior && !proposal) return;

  // Only touch Drive if at least one photo has data to upload —
  // includes room-level, per-wall, exterior, and proposal photos.
  const hasData = (function () {
    if (rooms.some(function (r) {
      if ((r.photos || []).some(function (p) { return p && p.dataUri; })) return true;
      if ((r.voiceMemos || []).some(function (m) { return m && m.dataUri; })) return true;
      return (r.walls || []).some(function (w) {
        return (w.photos || []).some(function (p) { return p && p.dataUri; });
      });
    })) return true;
    if (exterior) {
      const sides = ['front', 'back', 'left', 'right'];
      for (let i = 0; i < sides.length; i++) {
        const arr = exterior[sides[i]] || [];
        if (arr.some(function (p) { return p && p.dataUri; })) return true;
      }
    }
    if (proposal && proposal.sketches.some(function (p) { return p && p.dataUri; })) return true;
    return false;
  })();
  if (!hasData) return;

  // Find-or-create a single root folder for all submissions; per-
  // submission subfolders go inside it. NOTE: we deliberately do NOT
  // share the folder publicly — the architect console fetches it via
  // the authenticated Apps Script GET endpoint, so anonymous folder
  // browsing should be impossible. Individual photo files are made
  // ANYONE_WITH_LINK so the email links work directly; folder-level
  // sharing would expose siblings.
  const root = findOrCreateFolder_(DriveApp.getRootFolder(), 'TM Measure Submissions');
  const folder = root.createFolder(submissionId + ' — ' + (payload.projectName || 'project'));

  /**
   * Sanitise a user-supplied filename. Strips path traversal, leading
   * dots, control characters; allows letters/digits/underscore/hyphen
   * plus a single internal dot before the extension we choose.
   */
  const safeFilename = function (raw, fallback) {
    let name = String(raw || fallback || 'photo');
    name = name.replace(/[\\/\x00-\x1f]/g, '_');     // path sep + control chars
    name = name.replace(/^\.+/, '');                  // no leading dots
    name = name.replace(/[^A-Za-z0-9_-]/g, '_');      // strict allowlist
    if (!name.length) name = fallback || 'photo';
    if (name.length > 120) name = name.substring(0, 120);
    return name;
  };

  const allowedMimes = CONFIG.photoAllowedMimes;
  const extByMime = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };

  const uploadPhoto = function (photo, fallbackName) {
    if (!photo || !photo.dataUri) return;
    try {
      const match = String(photo.dataUri).match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        console.warn('Skipping photo with malformed data URI:', fallbackName);
        return;
      }
      const mime = String(match[1]).toLowerCase();
      // Server-side MIME allowlist. Client compresses to JPEG by
      // default, but a malicious caller could send executables.
      if (allowedMimes.indexOf(mime) === -1) {
        console.warn('Rejected photo with disallowed MIME:', mime, fallbackName);
        return;
      }
      const bytes = Utilities.base64Decode(match[2]);
      if (bytes.length > CONFIG.photoMaxBytes) {
        console.warn('Rejected oversized photo:', bytes.length, 'bytes', fallbackName);
        return;
      }
      const ext = extByMime[mime] || 'bin';
      const safeName = safeFilename(photo.name, fallbackName);
      const file = folder.createFile(Utilities.newBlob(bytes, mime, safeName + '.' + ext));
      // Share each file individually so siblings aren't exposed via
      // folder-level access. Anyone with the file URL can view, but
      // there's no way to enumerate the folder.
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      photo.driveUrl = file.getUrl();
      // Drop the heavy base64 string so it doesn't end up in the
      // sheet's "Raw payload" column or the email body.
      delete photo.dataUri;
    } catch (err) {
      console.error('Photo upload failed', err);
    }
  };

  /**
   * Upload one voice memo. Audio gets its own MIME allowlist and
   * size cap separate from photos. Drops the heavy base64 once the
   * file is in Drive.
   */
  const audioExt = function (mime) {
    if (mime.indexOf('mp4') >= 0) return 'm4a';
    if (mime.indexOf('mpeg') >= 0) return 'mp3';
    if (mime.indexOf('aac') >= 0) return 'aac';
    if (mime.indexOf('wav') >= 0) return 'wav';
    if (mime.indexOf('ogg') >= 0) return 'ogg';
    return 'webm';
  };
  const uploadAudio = function (memo, fallbackName) {
    if (!memo || !memo.dataUri) return;
    try {
      const match = String(memo.dataUri).match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return;
      const mime = String(match[1]).toLowerCase();
      if (CONFIG.audioAllowedMimes.indexOf(mime.split(';')[0]) === -1
          && CONFIG.audioAllowedMimes.indexOf(mime) === -1) {
        console.warn('Rejected audio with disallowed MIME:', mime, fallbackName);
        return;
      }
      const bytes = Utilities.base64Decode(match[2]);
      if (bytes.length > CONFIG.audioMaxBytes) {
        console.warn('Rejected oversized voice memo:', bytes.length, 'bytes', fallbackName);
        return;
      }
      const safeName = safeFilename(memo.name, fallbackName);
      const file = folder.createFile(
        Utilities.newBlob(bytes, mime, safeName + '.' + audioExt(mime)),
      );
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      memo.driveUrl = file.getUrl();
      delete memo.dataUri;
    } catch (err) {
      console.error('Audio upload failed', err);
    }
  };

  rooms.forEach(function (room, ri) {
    (room.photos || []).forEach(function (photo, pi) {
      uploadPhoto(photo, 'room-' + (ri + 1) + '-photo-' + (pi + 1));
    });
    (room.walls || []).forEach(function (wall, wi) {
      (wall.photos || []).forEach(function (photo, pi) {
        uploadPhoto(photo, 'room-' + (ri + 1) + '-wall-' + (wi + 1) + '-photo-' + (pi + 1));
      });
    });
    (room.voiceMemos || []).forEach(function (memo, mi) {
      uploadAudio(memo, 'room-' + (ri + 1) + '-voice-' + (mi + 1));
    });
  });

  if (exterior) {
    const sides = ['front', 'back', 'left', 'right'];
    sides.forEach(function (side) {
      const arr = exterior[side] || [];
      arr.forEach(function (photo, pi) {
        uploadPhoto(photo, 'exterior-' + side + '-photo-' + (pi + 1));
      });
    });
  }
  if (proposal) {
    proposal.sketches.forEach(function (photo, pi) {
      uploadPhoto(photo, 'proposal-sketch-' + (pi + 1));
    });
  }
}

function findOrCreateFolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

// ─── SHEET ─────────────────────────────────────────────────

const HEADERS = [
  'Submitted At',
  'Submission ID',
  'Customer Name',
  'Email',
  'Project Name',
  'Unit',
  'Room',
  'Walls (m)',
  'Ceiling (m)',
  'Doors',
  'Windows',
  'Irregular notes',
  'Room notes',
  'Photo filenames',
  'Connections',
  // Floor-plan placement — one row per room, so these capture where
  // the customer dragged the room on the FloorPlanEditor canvas.
  // Empty when the room was never placed.
  'Floor',
  'Position X (m)',
  'Position Z (m)',
  'Rotation (°)',
  'Raw payload',
];

/**
 * Defuse spreadsheet formula injection. If a cell value would be
 * interpreted as a formula by Sheets (=, +, -, @, or a literal tab),
 * prefix it with an apostrophe so the cell shows the raw text instead.
 * Numbers, dates, and other non-string values are passed through.
 */
function csvSafe_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return v;
  if (!v.length) return v;
  const first = v.charAt(0);
  if (first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r') {
    return "'" + v;
  }
  return v;
}

function appendRows_(payload, submissionId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.sheetName);
    sheet.appendRow(HEADERS);
    const header = sheet.getRange(1, 1, 1, HEADERS.length);
    header.setFontWeight('bold').setBackground('#1c1c1a').setFontColor('#fcf9f5');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, HEADERS.length, 160);
  } else {
    // Self-heal: if HEADERS has grown since the sheet was first created
    // (e.g. a newer version added "Connections"), physically insert the
    // missing column(s) at the correct index so historical rows' "Raw
    // payload" shifts right rather than being mislabelled. Safe to run
    // idempotently — only inserts when needed.
    migrateHeaders_(sheet);
  }

  const submittedAt = payload.submittedAt || new Date().toISOString();
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const connections = Array.isArray(payload.connections) ? payload.connections : [];
  const connectionsStr = connectionsSummary_(connections);
  const raw = JSON.stringify(payload);

  if (rooms.length === 0) {
    sheet.appendRow([
      submittedAt,
      submissionId,
      csvSafe_(payload.customerName || ''),
      csvSafe_(payload.email || ''),
      csvSafe_(payload.projectName || ''),
      csvSafe_(payload.unitPreference || ''),
      '(no rooms submitted)',
      '', '', '', '', '', '', '', csvSafe_(connectionsStr),
      '', '', '', '', // no placement for "no rooms"
      raw,
    ]);
    return;
  }

  rooms.forEach(function (room) {
    const walls = Array.isArray(room.walls) ? room.walls : [];
    const wallsStr = walls
      .map(function (w) { return formatMeters_(w.lengthM); })
      .filter(Boolean)
      .join(', ');

    const ceiling = room.ceilingHeightM != null ? formatMeters_(room.ceilingHeightM) : '';

    const doorsStr = (room.doors || [])
      .map(function (d) {
        return formatMeters_(d.widthM) + (d.note ? ' (' + d.note + ')' : '');
      })
      .join('; ');

    const windowsStr = (room.windows || [])
      .map(function (w) {
        return formatMeters_(w.widthM) + (w.note ? ' (' + w.note + ')' : '');
      })
      .join('; ');

    const photos = (room.photos || []).map(function (p) {
      // Prefer the Drive URL if uploadPhotos_ produced one; fall back
      // to the filename for older payloads or upload failures.
      return p.driveUrl ? (p.name || 'photo') + ' → ' + p.driveUrl : (p.name || '');
    }).filter(Boolean).join('\n');

    const placement = room.placement;
    const hasPlacement = placement && placement.positionM &&
      typeof placement.positionM.x === 'number' &&
      typeof placement.positionM.z === 'number';
    const floorCell = hasPlacement ? placement.floor : '';
    const posXCell = hasPlacement ? Number(placement.positionM.x).toFixed(2) : '';
    const posZCell = hasPlacement ? Number(placement.positionM.z).toFixed(2) : '';
    const rotationCell = hasPlacement ? (placement.rotationDeg || 0) + '°' : '';

    sheet.appendRow([
      submittedAt,
      submissionId,
      csvSafe_(payload.customerName || ''),
      csvSafe_(payload.email || ''),
      csvSafe_(payload.projectName || ''),
      csvSafe_(payload.unitPreference || ''),
      csvSafe_(room.name || room.label || ''),
      csvSafe_(wallsStr),
      csvSafe_(ceiling),
      csvSafe_(doorsStr),
      csvSafe_(windowsStr),
      csvSafe_(room.irregularShapeNotes || ''),
      csvSafe_(room.notes || ''),
      csvSafe_(photos),
      csvSafe_(connectionsStr),
      floorCell,
      posXCell,
      posZCell,
      rotationCell,
      raw,
    ]);
  });
}

/**
 * Compare the sheet's existing header row against the canonical HEADERS
 * array. For any canonical header missing from the sheet, insert a blank
 * column at the correct position and write the new header. Leaves any
 * unknown extra columns alone.
 */
function migrateHeaders_(sheet) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  for (let i = 0; i < HEADERS.length; i++) {
    const want = HEADERS[i];
    if (existing[i] === want) continue;
    // If this header doesn't appear further right either, insert a new
    // column here; otherwise, leave it — existing columns retain order.
    if (existing.indexOf(want) === -1) {
      sheet.insertColumnBefore(i + 1);
      sheet.getRange(1, i + 1).setValue(want)
        .setFontWeight('bold').setBackground('#1c1c1a').setFontColor('#fcf9f5');
      existing.splice(i, 0, want);
    }
  }
}

/**
 * One-line summary of all room connections for a submission.
 * Example: "Kitchen ↔ Hallway (door 0.90 m); Hallway ↔ Living (opening); Kitchen → external wall"
 */
function connectionsSummary_(connections) {
  if (!connections || !connections.length) return '';
  return connections.map(function (c) {
    return describeConnection_(c);
  }).join('; ');
}

function describeConnection_(c) {
  const a = c.roomAName || '(room)';
  if (c.kind === 'external') {
    return a + ' → external wall' + (c.notes ? ' (' + c.notes + ')' : '');
  }
  const b = c.roomBName || '(room)';
  const verb =
    c.kind === 'door' ? 'door' :
    c.kind === 'opening' ? 'opening' :
    c.kind === 'stairs' ? 'stairs' :
    'shared wall';
  const width = (typeof c.widthM === 'number' && isFinite(c.widthM))
    ? ' ' + c.widthM.toFixed(2) + ' m' : '';
  const notes = c.notes ? ' · ' + c.notes : '';
  return a + ' ↔ ' + b + ' (' + verb + width + ')' + notes;
}

// ─── EMAIL ─────────────────────────────────────────────────

function sendEmail_(payload, submissionId) {
  const subject = 'TM Measure — ' +
    (payload.projectName || 'New project') + ' — ' +
    (payload.customerName || 'Customer');

  MailApp.sendEmail({
    to: CONFIG.recipientEmail,
    replyTo: validEmail_(payload.email) ? payload.email : CONFIG.recipientEmail,
    subject: subject,
    htmlBody: buildHtmlEmail_(payload, submissionId),
    body: buildPlainTextEmail_(payload, submissionId),
  });

  // Customer confirmation — short branded receipt so they know we
  // got their submission, with the submission ID for the status page
  // and our reply timeline expectation. Best-effort: failures here
  // shouldn't take down the architect email.
  if (validEmail_(payload.email)) {
    try {
      MailApp.sendEmail({
        to: payload.email,
        replyTo: CONFIG.recipientEmail,
        subject: 'TM Measure — we\'ve got your submission (' + submissionId + ')',
        htmlBody: buildCustomerHtmlEmail_(payload, submissionId),
        body: buildCustomerPlainTextEmail_(payload, submissionId),
      });
    } catch (err) {
      console.warn('Customer confirmation email failed:', err);
    }
  }
}

function buildCustomerHtmlEmail_(payload, submissionId) {
  const gold = '#b89650';
  const cream = '#fcf9f5';
  const dark = '#1c1c1a';
  const mid = '#6e6a63';
  const border = '#e8e2d5';
  const name = escapeHtml_(String(payload.customerName || '').split(' ')[0] || 'there');
  const project = escapeHtml_(payload.projectName || 'your project');
  return '' +
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;background:#f4efe5;padding:32px 16px;">' +
      '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
        '<div style="padding:24px 28px;border-bottom:1px solid ' + border + ';">' +
          '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:' + gold + ';font-weight:700;">TM Measure</div>' +
          '<h1 style="margin:6px 0 0 0;font-size:22px;color:' + dark + ';font-weight:600;">Thanks, ' + name + '.</h1>' +
        '</div>' +
        '<div style="padding:20px 28px;color:' + dark + ';font-size:15px;line-height:1.55;">' +
          '<p style="margin:0 0 12px 0;">We\'ve received your measurements for <strong>' + project + '</strong>.</p>' +
          '<p style="margin:0 0 12px 0;">Your architect will review the dimensions and reply within <strong>two working days</strong>. If you don\'t hear back by then, just reply to this email.</p>' +
          '<div style="margin:18px 0 6px 0;padding:14px;background:' + cream + ';border-left:3px solid ' + gold + ';">' +
            '<div style="font-size:11px;color:' + mid + ';text-transform:uppercase;letter-spacing:1px;">Your submission ID</div>' +
            '<div style="font-family:monospace;font-size:18px;color:' + gold + ';margin-top:4px;">' + submissionId + '</div>' +
            '<div style="font-size:12px;color:' + mid + ';margin-top:6px;">Save this. You can check progress any time on the Project status page in the app.</div>' +
          '</div>' +
        '</div>' +
        '<div style="padding:14px 28px;border-top:1px solid ' + border + ';background:#fafafa;font-size:12px;color:' + mid + ';">' +
          'TM Architectural Designs Ltd. · inquiries@tmdesignsltd.com' +
        '</div>' +
      '</div>' +
    '</div>';
}

function buildCustomerPlainTextEmail_(payload, submissionId) {
  const name = String(payload.customerName || '').split(' ')[0] || 'there';
  return [
    'Thanks, ' + name + '.',
    '',
    'We\'ve received your TM Measure submission for ' + (payload.projectName || 'your project') + '.',
    'Your architect will reply within two working days.',
    '',
    'Submission ID: ' + submissionId,
    '',
    '— TM Architectural Designs Ltd.',
    'inquiries@tmdesignsltd.com',
  ].join('\n');
}

function buildHtmlEmail_(payload, submissionId) {
  const gold = '#b89650';
  const cream = '#fcf9f5';
  const dark = '#1c1c1a';
  const mid = '#6e6a63';
  const border = '#e8e2d5';

  const when = payload.submittedAt
    ? new Date(payload.submittedAt).toLocaleString('en-GB', {
        dateStyle: 'long', timeStyle: 'short',
      })
    : new Date().toLocaleString('en-GB');

  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];

  const roomsHtml = rooms.map(function (room) {
    const walls = (room.walls || [])
      .map(function (w, i) {
        return '<tr>' +
          '<td style="padding:6px 12px;color:' + mid + ';font-size:13px;">' +
            (w.label || ('Wall ' + (i + 1))) +
          '</td>' +
          '<td style="padding:6px 12px;font-family:monospace;font-size:14px;color:' + dark + ';text-align:right;">' +
            formatDual_(w.lengthM) +
          '</td>' +
        '</tr>';
      })
      .join('');

    const ceilingRow = room.ceilingHeightM != null
      ? '<tr>' +
          '<td style="padding:6px 12px;color:' + mid + ';font-size:13px;">Ceiling height</td>' +
          '<td style="padding:6px 12px;font-family:monospace;font-size:14px;color:' + dark + ';text-align:right;">' +
            formatDual_(room.ceilingHeightM) +
          '</td>' +
        '</tr>'
      : '';

    const doors = (room.doors || []);
    const doorsRow = doors.length
      ? '<tr>' +
          '<td style="padding:6px 12px;color:' + mid + ';font-size:13px;vertical-align:top;">Doors</td>' +
          '<td style="padding:6px 12px;font-size:13px;color:' + dark + ';text-align:right;">' +
            doors.map(function (d) {
              return formatDual_(d.widthM) + (d.note ? ' <span style="color:' + mid + ';">(' + escapeHtml_(d.note) + ')</span>' : '');
            }).join('<br>') +
          '</td>' +
        '</tr>'
      : '';

    const windows = (room.windows || []);
    const windowsRow = windows.length
      ? '<tr>' +
          '<td style="padding:6px 12px;color:' + mid + ';font-size:13px;vertical-align:top;">Windows</td>' +
          '<td style="padding:6px 12px;font-size:13px;color:' + dark + ';text-align:right;">' +
            windows.map(function (w) {
              return formatDual_(w.widthM) + (w.note ? ' <span style="color:' + mid + ';">(' + escapeHtml_(w.note) + ')</span>' : '');
            }).join('<br>') +
          '</td>' +
        '</tr>'
      : '';

    const notes = [room.irregularShapeNotes, room.notes].filter(Boolean);
    const notesBlock = notes.length
      ? '<div style="margin-top:12px;padding:10px 12px;background:' + cream + ';border-left:3px solid ' + gold + ';color:' + dark + ';font-size:13px;line-height:1.5;">' +
          notes.map(escapeHtml_).join('<br><br>') +
        '</div>'
      : '';

    // Photo links — Drive URLs produced by uploadPhotos_(). Listed as
    // a compact bullet list so the architect can open each photo in
    // its own tab without needing the attachment.
    const uploadedPhotos = (room.photos || []).filter(function (p) { return p && p.driveUrl; });
    const photosBlock = uploadedPhotos.length
      ? '<div style="margin-top:12px;padding:0 12px;">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:' + mid + ';margin-bottom:4px;">Reference photos (' + uploadedPhotos.length + ')</div>' +
          uploadedPhotos.map(function (p) {
            return '<div style="font-size:13px;line-height:1.5;">→ <a href="' + p.driveUrl + '" style="color:' + gold + ';text-decoration:none;">' + escapeHtml_(p.name || 'photo') + '</a></div>';
          }).join('') +
        '</div>'
      : '';

    const uploadedMemos = (room.voiceMemos || []).filter(function (m) { return m && m.driveUrl; });
    const memosBlock = uploadedMemos.length
      ? '<div style="margin-top:12px;padding:0 12px;">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:' + mid + ';margin-bottom:4px;">Voice memos (' + uploadedMemos.length + ')</div>' +
          uploadedMemos.map(function (m) {
            const dur = m.durationMs ? ' · ' + (m.durationMs / 1000).toFixed(1) + 's' : '';
            return '<div style="font-size:13px;line-height:1.5;">🎙 <a href="' + m.driveUrl + '" style="color:' + gold + ';text-decoration:none;">' + escapeHtml_(m.name || 'voice memo') + '</a>' + dur + '</div>';
          }).join('') +
        '</div>'
      : '';

    return '<div style="margin-top:20px;border:1px solid ' + border + ';border-radius:8px;overflow:hidden;">' +
      '<div style="padding:12px 16px;background:' + dark + ';color:' + cream + ';font-weight:600;font-size:15px;">' +
        escapeHtml_(room.label || 'Room') +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;">' +
        walls + ceilingRow + doorsRow + windowsRow +
      '</table>' +
      (notesBlock ? '<div style="padding:0 12px 12px 12px;">' + notesBlock + '</div>' : '') +
      (photosBlock ? '<div style="padding:0 0 12px 0;">' + photosBlock + '</div>' : '') +
      (memosBlock ? '<div style="padding:0 0 12px 0;">' + memosBlock + '</div>' : '') +
    '</div>';
  }).join('');

  return '' +
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;background:#f4efe5;padding:32px 16px;">' +
      '<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +

        // Header
        '<div style="padding:24px 28px;border-bottom:1px solid ' + border + ';">' +
          '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:' + gold + ';font-weight:700;">TM Measure</div>' +
          '<h1 style="margin:4px 0 0 0;font-size:22px;color:' + dark + ';font-weight:600;">New measurement submission</h1>' +
        '</div>' +

        // Customer block
        '<div style="padding:20px 28px;background:' + cream + ';border-bottom:1px solid ' + border + ';">' +
          '<table style="width:100%;border-collapse:collapse;font-size:14px;color:' + dark + ';">' +
            row_('Customer', escapeHtml_(payload.customerName || '—'), mid) +
            row_('Email', '<a href="mailto:' + encodeURIComponent(payload.email || '') + '" style="color:' + gold + ';text-decoration:none;">' + escapeHtml_(payload.email || '—') + '</a>', mid) +
            row_('Project', escapeHtml_(payload.projectName || '—'), mid) +
            row_('Unit preference', (payload.unitPreference || 'metric'), mid) +
            row_('Submitted', when, mid) +
            row_('Submission ID', submissionId, mid) +
          '</table>' +
        '</div>' +

        // Rooms
        '<div style="padding:8px 28px 24px 28px;">' +
          '<h2 style="margin:20px 0 0 0;font-size:16px;color:' + dark + ';font-weight:600;">Rooms (' + rooms.length + ')</h2>' +
          roomsHtml +
        '</div>' +

        // Connections
        connectionsHtmlBlock_(payload, gold, cream, dark, mid, border) +

        // Floor plan — one block per floor, only if any rooms are placed
        floorPlanHtmlBlock_(payload, gold, cream, dark, mid, border) +

        // Exterior + proposal — only if the customer added them.
        exteriorHtmlBlock_(payload, gold, cream, dark, mid, border) +
        proposalHtmlBlock_(payload, gold, cream, dark, mid, border) +

        // Footer
        '<div style="padding:16px 28px;border-top:1px solid ' + border + ';background:#fafafa;font-size:12px;color:' + mid + ';">' +
          'This submission was sent automatically from the TM Measure app. The full row is stored in your Submissions sheet. Reply to this email to contact the customer directly.' +
        '</div>' +

      '</div>' +
    '</div>';
}

/**
 * Render a "Room connections" section for the HTML email, if any.
 */
/**
 * Render the four sides of the building envelope as a 2×2 photo grid
 * inside the email. Drives off the uploaded Drive links so the
 * architect can open each at full resolution. Returns "" if the
 * customer skipped the Exterior step.
 */
function exteriorHtmlBlock_(payload, gold, cream, dark, mid, border) {
  const ext = payload.exterior && payload.exterior.bySide ? payload.exterior.bySide : null;
  if (!ext) return '';
  const sides = [
    { key: 'front', label: 'Front (street side)' },
    { key: 'back',  label: 'Back (garden side)' },
    { key: 'left',  label: 'Left' },
    { key: 'right', label: 'Right' },
  ];
  const cells = sides.map(function (s) {
    const arr = ext[s.key] || [];
    const inner = arr.length
      ? arr.map(function (p) {
          return p.driveUrl
            ? '<div style="font-size:13px;"><a href="' + p.driveUrl + '" style="color:' + gold + ';text-decoration:none;">→ ' + escapeHtml_(p.name || 'photo') + '</a></div>'
            : '<div style="font-size:13px;color:' + mid + ';">→ ' + escapeHtml_(p.name || 'photo') + '</div>';
        }).join('')
      : '<div style="font-size:12px;color:' + mid + ';font-style:italic;">No photo provided.</div>';
    return '<td style="padding:10px;vertical-align:top;width:50%;border:1px solid ' + border + ';">' +
      '<div style="font-size:11px;color:' + mid + ';text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">' + s.label + ' (' + arr.length + ')</div>' +
      inner +
    '</td>';
  });
  return '<div style="padding:0 28px 24px 28px;">' +
    '<h2 style="margin:20px 0 10px 0;font-size:16px;color:' + dark + ';font-weight:600;">Exterior photos</h2>' +
    '<table style="width:100%;border-collapse:collapse;">' +
      '<tr>' + cells[0] + cells[1] + '</tr>' +
      '<tr>' + cells[2] + cells[3] + '</tr>' +
    '</table>' +
  '</div>';
}

/**
 * Render the customer's proposal: text description + any sketches /
 * inspiration they attached. Returns "" if both are empty.
 */
function proposalHtmlBlock_(payload, gold, cream, dark, mid, border) {
  const prop = payload.proposal;
  if (!prop) return '';
  const desc = (prop.description || '').trim();
  const sketches = Array.isArray(prop.sketches) ? prop.sketches : [];
  if (!desc && !sketches.length) return '';
  const descBlock = desc
    ? '<div style="padding:12px 14px;background:' + cream + ';border-left:3px solid ' + gold + ';color:' + dark + ';font-size:14px;line-height:1.5;white-space:pre-wrap;">' +
        escapeHtml_(desc) +
      '</div>'
    : '';
  const sketchBlock = sketches.length
    ? '<div style="margin-top:14px;">' +
        '<div style="font-size:11px;color:' + mid + ';text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Sketches / inspiration (' + sketches.length + ')</div>' +
        sketches.map(function (p) {
          return p.driveUrl
            ? '<div style="font-size:13px;"><a href="' + p.driveUrl + '" style="color:' + gold + ';text-decoration:none;">→ ' + escapeHtml_(p.name || 'sketch') + '</a></div>'
            : '<div style="font-size:13px;color:' + mid + ';">→ ' + escapeHtml_(p.name || 'sketch') + '</div>';
        }).join('') +
      '</div>'
    : '';
  return '<div style="padding:0 28px 24px 28px;">' +
    '<h2 style="margin:20px 0 10px 0;font-size:16px;color:' + dark + ';font-weight:600;">Proposal — what the customer wants</h2>' +
    descBlock +
    sketchBlock +
  '</div>';
}

function connectionsHtmlBlock_(payload, gold, cream, dark, mid, border) {
  const conns = Array.isArray(payload.connections) ? payload.connections : [];
  if (!conns.length) return '';

  const rows = conns.map(function (c) {
    const desc = describeConnection_(c);
    const badge = c.kind === 'external' ? 'EXT' :
                  c.kind === 'door' ? 'DOOR' :
                  c.kind === 'opening' ? 'OPEN' : 'WALL';
    return '<tr>' +
      '<td style="padding:6px 12px;font-size:12px;color:' + gold + ';font-weight:700;letter-spacing:0.5px;vertical-align:top;width:60px;">' +
        badge +
      '</td>' +
      '<td style="padding:6px 12px;font-size:13px;color:' + dark + ';line-height:1.5;">' +
        escapeHtml_(desc) +
      '</td>' +
    '</tr>';
  }).join('');

  return '<div style="padding:0 28px 24px 28px;">' +
    '<div style="margin-top:20px;border:1px solid ' + border + ';border-radius:8px;overflow:hidden;">' +
      '<div style="padding:12px 16px;background:' + dark + ';color:' + cream + ';font-weight:600;font-size:15px;">' +
        'Room connections (' + conns.length + ')' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>' +
    '</div>' +
  '</div>';
}

function row_(label, value, mutedColor) {
  return '<tr>' +
    '<td style="padding:4px 0;width:140px;color:' + mutedColor + ';font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">' + label + '</td>' +
    '<td style="padding:4px 0;">' + value + '</td>' +
  '</tr>';
}

/**
 * Human-friendly floor label mirroring measure-core/floorplan.ts.
 */
function floorLabel_(index) {
  const fixed = {
    '-2': 'Sub-basement',
    '-1': 'Basement',
    '0': 'Ground floor',
    '1': 'First floor',
    '2': 'Second floor',
    '3': 'Third floor',
    '4': 'Fourth floor',
  };
  const key = String(index);
  if (fixed[key]) return fixed[key];
  if (index < 0) return 'Basement ' + (-index);
  return 'Floor ' + index;
}

/**
 * Render one HTML block per floor: SVG floor plan (for Apple Mail,
 * Outlook, Thunderbird, etc.) + a coordinate listing as fallback for
 * clients that strip inline SVG (notably Gmail web/app). The fallback
 * is precise enough that the architect can recreate the layout in any
 * CAD without needing the image.
 */
function floorPlanHtmlBlock_(payload, gold, cream, dark, mid, border) {
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const placed = rooms.filter(function (r) {
    return r.placement && r.placement.positionM &&
      typeof r.placement.positionM.x === 'number' &&
      typeof r.placement.positionM.z === 'number';
  });
  if (!placed.length) return '';

  // Group placed rooms by floor index.
  const byFloor = {};
  placed.forEach(function (r) {
    const f = (r.placement && typeof r.placement.floor === 'number') ? r.placement.floor : 0;
    if (!byFloor[f]) byFloor[f] = [];
    byFloor[f].push(r);
  });
  const floors = Object.keys(byFloor)
    .map(function (k) { return Number(k); })
    .sort(function (a, b) { return a - b; });

  const sections = floors.map(function (floor) {
    const floorRooms = byFloor[floor];
    const svg = renderFloorSvg_(floorRooms, gold, cream, dark, mid);
    const listing = floorRooms.map(function (r) {
      const size = roomFootprint_(r);
      const p = r.placement;
      const name = escapeHtml_(r.name || 'Room');
      return '<tr>' +
        '<td style="padding:4px 12px;font-size:13px;color:' + dark + ';font-weight:600;">' +
          name +
        '</td>' +
        '<td style="padding:4px 12px;font-family:monospace;font-size:12px;color:' + mid + ';text-align:right;white-space:nowrap;">' +
          'at (' + p.positionM.x.toFixed(2) + ', ' + p.positionM.z.toFixed(2) + ') m · ' +
          size.widthM.toFixed(2) + ' × ' + size.lengthM.toFixed(2) + ' m · ' +
          (p.rotationDeg || 0) + '°' +
        '</td>' +
      '</tr>';
    }).join('');

    return '<div style="margin-top:20px;border:1px solid ' + border + ';border-radius:8px;overflow:hidden;">' +
      '<div style="padding:12px 16px;background:' + dark + ';color:' + cream + ';font-weight:600;font-size:15px;">' +
        escapeHtml_(floorLabel_(floor)) + ' (' + floorRooms.length + ' room' + (floorRooms.length === 1 ? '' : 's') + ')' +
      '</div>' +
      '<div style="padding:16px;background:' + cream + ';text-align:center;">' +
        svg +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;border-top:1px solid ' + border + ';">' +
        listing +
      '</table>' +
    '</div>';
  }).join('');

  return '<div style="padding:0 28px 24px 28px;">' +
    '<h2 style="margin:20px 0 0 0;font-size:16px;color:' + dark + ';font-weight:600;">' +
      'Floor plan (' + floors.length + ' floor' + (floors.length === 1 ? '' : 's') + ')' +
    '</h2>' +
    '<p style="margin:6px 0 0 0;font-size:12px;color:' + mid + ';">' +
      'If this section shows only a list, your mail client stripped the inline SVG. ' +
      'The coordinates below are exact — x and z are in metres from the floor origin.' +
    '</p>' +
    sections +
  '</div>';
}

/**
 * Mirror of measure-core/floorplan.ts roomFootprint() — width = walls[0],
 * length = walls[1], with fallback to 3×3 m for rooms missing dimensions.
 */
function roomFootprint_(room) {
  const walls = Array.isArray(room.walls) ? room.walls : [];
  const w = walls[0] ? Number(walls[0].lengthM) : NaN;
  const l = walls[1] ? Number(walls[1].lengthM) : NaN;
  return {
    widthM: isFinite(w) && w > 0 ? w : 3,
    lengthM: isFinite(l) && l > 0 ? l : 3,
  };
}

/**
 * Render one floor's rooms as an inline SVG, viewBox in metres so
 * rects are 1:1 with dimensions. Top-left-anchor rotation to match
 * the editor.
 */
function renderFloorSvg_(floorRooms, gold, cream, dark, mid) {
  // Compute bounding box across all rooms on this floor.
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const bboxes = [];
  for (let i = 0; i < floorRooms.length; i++) {
    const r = floorRooms[i];
    const size = roomFootprint_(r);
    const p = r.placement;
    const rot = p.rotationDeg || 0;
    // Rotated extents about top-left anchor (x=anchor.x, z=anchor.z).
    let dx, dz;
    if (rot === 90)      { dx = size.lengthM;  dz = -size.widthM;  }
    else if (rot === 180){ dx = -size.widthM;  dz = -size.lengthM; }
    else if (rot === 270){ dx = -size.lengthM; dz = size.widthM;   }
    else                 { dx = size.widthM;   dz = size.lengthM;  }
    const x1 = p.positionM.x, z1 = p.positionM.z;
    const x2 = x1 + dx,       z2 = z1 + dz;
    const bb = {
      minX: Math.min(x1, x2), maxX: Math.max(x1, x2),
      minZ: Math.min(z1, z2), maxZ: Math.max(z1, z2),
    };
    bboxes.push(bb);
    if (bb.minX < minX) minX = bb.minX;
    if (bb.maxX > maxX) maxX = bb.maxX;
    if (bb.minZ < minZ) minZ = bb.minZ;
    if (bb.maxZ > maxZ) maxZ = bb.maxZ;
  }
  const padM = 1;
  const viewX = minX - padM;
  const viewZ = minZ - padM;
  const viewW = Math.max(8, (maxX - minX) + padM * 2);
  const viewH = Math.max(8, (maxZ - minZ) + padM * 2);

  // Render rooms.
  const roomsSvg = floorRooms.map(function (r) {
    const size = roomFootprint_(r);
    const p = r.placement;
    const rot = p.rotationDeg || 0;
    const transform = 'translate(' + p.positionM.x + ',' + p.positionM.z + ') rotate(' + rot + ' 0 0)';
    const name = escapeHtml_(r.name || 'Room');
    const w = size.widthM;
    const h = size.lengthM;
    // Build the floor polygon path (rectangle by default, L-shape if
    // the customer flagged it on the rooms step).
    let pathD = 'M 0 0 L ' + w + ' 0 L ' + w + ' ' + h + ' L 0 ' + h + ' Z';
    if (r.shape === 'l-shape') {
      const nw = Math.min(Math.max(Number(r.notchWidthM) || 0, 0), w * 0.95);
      const nl = Math.min(Math.max(Number(r.notchLengthM) || 0, 0), h * 0.95);
      if (nw > 0 && nl > 0) {
        pathD = 'M 0 0 L ' + w + ' 0 L ' + w + ' ' + (h - nl) +
                ' L ' + (w - nw) + ' ' + (h - nl) +
                ' L ' + (w - nw) + ' ' + h +
                ' L 0 ' + h + ' Z';
      }
    } else if (r.shape === 'custom' && Array.isArray(r.floorPolygonM) && r.floorPolygonM.length >= 3) {
      pathD = r.floorPolygonM.map(function (p, i) {
        return (i === 0 ? 'M ' : 'L ') + p.x + ' ' + p.z;
      }).join(' ') + ' Z';
    }
    // Door / window tick marks. Map wallIndex 0..3 → top / right /
    // bottom / left of the bounding rectangle, then place an offset
    // segment of width = opening width.
    const openings = []
      .concat((r.doors || []).map(function (d) { return Object.assign({}, d, { kind: 'door' }); }))
      .concat((r.windows || []).map(function (wn) { return Object.assign({}, wn, { kind: 'window' }); }));
    const openingsSvg = openings.map(function (op) {
      const widthM = Number(op.widthM) || 0;
      if (widthM <= 0) return '';
      const wallIndex = (Number(op.wallIndex) || 0) % 4;
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
      if (wallIndex === 0) { x1 = 0; y1 = 0; x2 = w; y2 = 0; }
      else if (wallIndex === 1) { x1 = w; y1 = 0; x2 = w; y2 = h; }
      else if (wallIndex === 2) { x1 = w; y1 = h; x2 = 0; y2 = h; }
      else { x1 = 0; y1 = h; x2 = 0; y2 = 0; }
      const wallLen = Math.hypot(x2 - x1, y2 - y1);
      const centre = Number(op.positionM) > 0 ? Number(op.positionM) : wallLen / 2;
      const t1 = Math.max(0, centre - widthM / 2) / wallLen;
      const t2 = Math.min(wallLen, centre + widthM / 2) / wallLen;
      const px1 = x1 + (x2 - x1) * t1;
      const py1 = y1 + (y2 - y1) * t1;
      const px2 = x1 + (x2 - x1) * t2;
      const py2 = y1 + (y2 - y1) * t2;
      const colour = op.kind === 'door' ? gold : '#5a6a80';
      return '<line x1="' + px1 + '" y1="' + py1 + '" x2="' + px2 + '" y2="' + py2 +
        '" stroke="' + colour + '" stroke-width="4" vector-effect="non-scaling-stroke"/>';
    }).join('');
    return '<g transform="' + transform + '">' +
      '<path d="' + pathD + '" fill="#fff8ea" fill-opacity="0.92" stroke="' + gold +
        '" stroke-width="1.6" vector-effect="non-scaling-stroke"/>' +
      openingsSvg +
      '<text x="' + (w / 2) + '" y="' + (h / 2 - 0.05) + '" ' +
        'font-size="0.42" fill="' + dark + '" font-weight="600" text-anchor="middle" ' +
        'font-family="Helvetica,Arial,sans-serif">' + name + '</text>' +
      '<text x="' + (w / 2) + '" y="' + (h / 2 + 0.45) + '" ' +
        'font-size="0.3" fill="' + mid + '" text-anchor="middle" ' +
        'font-family="Helvetica,Arial,sans-serif">' +
        w.toFixed(2) + ' × ' + h.toFixed(2) + ' m</text>' +
    '</g>';
  }).join('');

  // Grid backdrop.
  const gridPath = [];
  for (let gx = Math.ceil(viewX); gx <= viewX + viewW; gx++) {
    gridPath.push('M ' + gx + ' ' + viewZ + ' L ' + gx + ' ' + (viewZ + viewH));
  }
  for (let gz = Math.ceil(viewZ); gz <= viewZ + viewH; gz++) {
    gridPath.push('M ' + viewX + ' ' + gz + ' L ' + (viewX + viewW) + ' ' + gz);
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'viewBox="' + viewX + ' ' + viewZ + ' ' + viewW + ' ' + viewH + '" ' +
    'preserveAspectRatio="xMidYMid meet" ' +
    'style="width:100%;max-width:560px;height:auto;background:' + cream + ';">' +
    '<rect x="' + viewX + '" y="' + viewZ + '" width="' + viewW + '" height="' + viewH + '" fill="' + cream + '"/>' +
    '<path d="' + gridPath.join(' ') + '" stroke="#c9c0ab" stroke-width="0.02" fill="none"/>' +
    roomsSvg +
  '</svg>';
}

function buildPlainTextEmail_(payload, submissionId) {
  const lines = [];
  lines.push('TM Measure — new submission');
  lines.push('');
  lines.push('Customer: ' + (payload.customerName || '—'));
  lines.push('Email: ' + (payload.email || '—'));
  lines.push('Project: ' + (payload.projectName || '—'));
  lines.push('Unit: ' + (payload.unitPreference || 'metric'));
  lines.push('Submission ID: ' + submissionId);
  lines.push('');
  (payload.rooms || []).forEach(function (room) {
    lines.push('— ' + (room.name || room.label || 'Room') + ' —');
    (room.walls || []).forEach(function (w, i) {
      lines.push('  ' + (w.label || 'Wall ' + (i + 1)) + ': ' + formatDual_(w.lengthM));
    });
    if (room.ceilingHeightM != null) {
      lines.push('  Ceiling: ' + formatDual_(room.ceilingHeightM));
    }
    if (room.notes) lines.push('  Notes: ' + room.notes);
    lines.push('');
  });
  const conns = Array.isArray(payload.connections) ? payload.connections : [];
  if (conns.length) {
    lines.push('— Room connections —');
    conns.forEach(function (c) { lines.push('  • ' + describeConnection_(c)); });
    lines.push('');
  }
  // Floor plan summary — same coordinates as the sheet columns so the
  // architect can recreate the layout directly from the email.
  const placed = (payload.rooms || []).filter(function (r) {
    return r.placement && r.placement.positionM &&
      typeof r.placement.positionM.x === 'number' &&
      typeof r.placement.positionM.z === 'number';
  });
  if (placed.length) {
    const byFloor = {};
    placed.forEach(function (r) {
      const f = (r.placement && typeof r.placement.floor === 'number') ? r.placement.floor : 0;
      if (!byFloor[f]) byFloor[f] = [];
      byFloor[f].push(r);
    });
    const floors = Object.keys(byFloor)
      .map(function (k) { return Number(k); })
      .sort(function (a, b) { return a - b; });
    lines.push('— Floor plan —');
    floors.forEach(function (floor) {
      lines.push('  ' + floorLabel_(floor) + ':');
      byFloor[floor].forEach(function (r) {
        const size = roomFootprint_(r);
        const p = r.placement;
        lines.push(
          '    ' + (r.name || 'Room') +
          ' at (' + p.positionM.x.toFixed(2) + ', ' + p.positionM.z.toFixed(2) + ') m' +
          ' · ' + size.widthM.toFixed(2) + ' × ' + size.lengthM.toFixed(2) + ' m' +
          ' · ' + (p.rotationDeg || 0) + '°'
        );
      });
    });
    lines.push('');
  }
  return lines.join('\n');
}

// ─── FORMATTING HELPERS ────────────────────────────────────

function formatMeters_(m) {
  const n = Number(m);
  if (!isFinite(n)) return '';
  return n.toFixed(2) + ' m';
}

function formatImperial_(m) {
  const n = Number(m);
  if (!isFinite(n)) return '';
  const totalInches = n * 39.3700787;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - feet * 12);
  if (inches === 12) return (feet + 1) + "' 0\"";
  return feet + "' " + inches + '"';
}

function formatDual_(m) {
  const met = formatMeters_(m);
  const imp = formatImperial_(m);
  if (!met && !imp) return '—';
  if (!met) return imp;
  if (!imp) return met;
  return met + ' · ' + imp;
}

function escapeHtml_(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── VALIDATION ────────────────────────────────────────────

/**
 * Strict email validator. Refuses anything containing newlines or
 * commas — the address must be a single, header-safe value before we
 * hand it to MailApp's `replyTo`.
 */
function validEmail_(s) {
  if (typeof s !== 'string') return false;
  if (s.length > 254) return false;
  // Single newline/comma kills the check — these enable header
  // injection. Then a basic shape match.
  if (/[\r\n,;<>]/.test(s)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function validatePayload_(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload is not an object.');
  }
  if (!payload.email || typeof payload.email !== 'string') {
    throw new Error('Missing email.');
  }
  if (!payload.customerName || typeof payload.customerName !== 'string') {
    throw new Error('Missing customer name.');
  }
  if (!Array.isArray(payload.rooms)) {
    throw new Error('Missing rooms array.');
  }
}

// ─── UTIL ──────────────────────────────────────────────────

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── DAILY BACKUP ──────────────────────────────────────────

/**
 * Daily snapshot of the Submissions sheet into a "TM Measure Backups"
 * Drive folder. Set this up once as a time-driven trigger:
 *
 *   Apps Script → Triggers (clock icon on left rail) →
 *     + Add trigger →
 *     Function: dailyBackup
 *     Event source: Time-driven
 *     Type: Day timer
 *     Time of day: 02:00 – 03:00
 *
 * Each run copies the active spreadsheet as a new file dated YYYY-MM-DD
 * and prunes any backup older than 90 days. Quick disaster-recovery
 * win — if someone fat-fingers the live sheet we can restore from
 * yesterday's snapshot.
 */
function dailyBackup() {
  const source = SpreadsheetApp.getActiveSpreadsheet();
  const sourceFile = DriveApp.getFileById(source.getId());
  const folder = findOrCreateFolder_(DriveApp.getRootFolder(), 'TM Measure Backups');
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const name = 'TM Measure — Submissions — ' + stamp;
  // Skip if today's backup already exists (idempotent if the trigger
  // fires twice).
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    console.log('Backup for ' + stamp + ' already exists.');
    return;
  }
  sourceFile.makeCopy(name, folder);
  console.log('Backup created: ' + name);

  // Pruning — drop anything older than 90 days. Keeps Drive tidy
  // without nuking historical records the architect may want.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getDateCreated() < ninetyDaysAgo) {
      f.setTrashed(true);
      console.log('Trashed old backup: ' + f.getName());
    }
  }
}

/**
 * Run this once manually from the Apps Script editor to test
 * the email + sheet write path without going through the app.
 */
function testSubmission() {
  const fake = {
    version: 1,
    submittedAt: new Date().toISOString(),
    customerName: 'Test Customer',
    email: 'test@example.com',
    projectName: 'Kitchen extension (test)',
    unitPreference: 'metric',
    rooms: [
      {
        id: 'r1',
        name: 'Kitchen',
        walls: [
          { id: 'w1', label: 'North wall', lengthM: 4.2 },
          { id: 'w2', label: 'East wall', lengthM: 3.1 },
          { id: 'w3', label: 'South wall', lengthM: 4.2 },
          { id: 'w4', label: 'West wall', lengthM: 3.1 },
        ],
        ceilingHeightM: 2.4,
        doors: [{ id: 'd1', widthM: 0.9, note: 'to hallway' }],
        windows: [{ id: 'wn1', widthM: 1.6, note: 'bay' }],
        irregularShapeNotes: 'Chimney breast on south wall, ~40cm deep.',
        notes: 'Radiator under window.',
        photos: [],
        placement: {
          floor: 0,
          rotationDeg: 0,
          positionM: { x: 0, z: 0 },
        },
      },
      {
        id: 'r2',
        name: 'Hallway',
        walls: [
          { id: 'hw1', label: 'Wall 1', lengthM: 1.2 },
          { id: 'hw2', label: 'Wall 2', lengthM: 3.0 },
          { id: 'hw3', label: 'Wall 3', lengthM: 1.2 },
          { id: 'hw4', label: 'Wall 4', lengthM: 3.0 },
        ],
        ceilingHeightM: 2.4,
        doors: [],
        windows: [],
        irregularShapeNotes: '',
        notes: '',
        photos: [],
        placement: {
          floor: 0,
          rotationDeg: 0,
          positionM: { x: 4.5, z: 0 },
        },
      },
    ],
    connections: [
      {
        id: 'c1',
        roomAId: 'r1',
        roomAName: 'Kitchen',
        roomBId: 'r2',
        roomBName: 'Hallway',
        kind: 'door',
        widthM: 0.90,
        notes: 'Single glazed panel door',
      },
      {
        id: 'c2',
        roomAId: 'r1',
        roomAName: 'Kitchen',
        kind: 'external',
        notes: 'North wall — proposed extension side',
      },
    ],
  };
  appendRows_(fake, 'TEST1234');
  sendEmail_(fake, 'TEST1234');
}
