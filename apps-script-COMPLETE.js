/**
 * TM Measure — submission backend. COMPLETE FILE.
 * ===============================================
 *
 * HOW TO USE THIS FILE
 *   Apps Script editor → Code.gs → click in the code → Ctrl+A → Delete
 *   → paste this entire file → Save (disk icon) →
 *   Deploy → Manage deployments → pencil → Version: New version → Deploy.
 *
 * This is the whole backend, not a patch. Replacing everything with it
 * is the correct action.
 *
 * Receives JSON POSTs from the TM Measure mobile/web app. Appends one
 * row per room to the bound Google Sheet, uploads photos to Drive, and
 * emails an HTML summary to the address in CONFIG.
 *
 * Author: TM Architectural Designs Ltd.
 */

// ─── CONFIG ────────────────────────────────────────────────
const CONFIG = {
  // Goes to the Gmail account directly.
  //
  // This used to be inquiries@tmdesignsltd.com. MailApp accepted every
  // message and the send quota decremented, but nothing was ever
  // delivered — a search of that label found only three emails, all
  // from April. So no submission notification had ever arrived, while
  // the sheet and Drive were filling up correctly the whole time.
  //
  // Point this back at inquiries@ once that address is confirmed to
  // deliver; test with emailDiagnostic() before trusting it.
  recipientEmail: 'tmarchitecturalltd@gmail.com',
  sheetName: 'Submissions',
  companyName: 'TM Architectural Designs Ltd.',
  photoMaxBytes: 5 * 1024 * 1024,
  photoAllowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
  // Voice memos are short and already compressed; 10 MB is a generous
  // ceiling for a few minutes of speech. The MIME list covers what
  // MediaRecorder actually emits: Chrome/Android give audio/webm,
  // iOS Safari gives audio/mp4, Firefox may give audio/ogg.
  audioMaxBytes: 10 * 1024 * 1024,
  audioAllowedMimes: ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'],
};

/**
 * Architect secret. Set in Project Settings → Script Properties as
 * ADMIN_SECRET.
 */
function adminSecret_() {
  const value = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
  return value || null;
}

/** Constant-time compare so timing can't probe the secret. */
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

/**
 * Gate on the architect secret. Fails CLOSED.
 *
 * This used to return early when ADMIN_SECRET was unset, which meant a
 * missing or mistyped Script Property silently published every
 * submission the business holds — customer names, email addresses,
 * property details and photo links — to anyone who had the /exec URL.
 * That URL is not a secret: it travels in the app bundle and is
 * pasted into the console on any device the architect uses. The
 * failure mode of a misconfiguration must be "nothing works", not
 * "everything is readable".
 */
function requireAdminSecret_(provided) {
  const expected = adminSecret_();
  if (expected === null) {
    console.error('ADMIN_SECRET is not set — refusing architect request.');
    throw new Error(
      'Server not configured: ADMIN_SECRET is not set in Script Properties. ' +
      'Set it, redeploy, then try again.'
    );
  }
  if (!safeEqual_(provided, expected)) {
    throw new Error('Unauthorised. Provide the correct admin secret.');
  }
}

/** Coarse anti-abuse limiter: cap submissions per UTC hour. */
function checkSubmissionRate_() {
  const cache = CacheService.getScriptCache();
  const hourBucket = String(Math.floor(Date.now() / 3600000));
  const key = 'tm.submitcount.' + hourBucket;
  const current = parseInt(cache.get(key) || '0', 10);
  if (current >= 60) {
    throw new Error('Rate limit reached. Try again in an hour.');
  }
  cache.put(key, String(current + 1), 3700);
}

// ─── HTTP ENDPOINTS ────────────────────────────────────────

/**
 * POST /exec
 *
 * Handles survey submissions and every action that carries a secret or
 * personal data, so neither ends up in a URL query string.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Empty request body.');
    }
    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || '').toLowerCase();

    // Customer status lookup. Needs BOTH the submission ID and the
    // email on it, so no admin secret is required.
    if (action === 'status') {
      return jsonResponse_({
        ok: true,
        status: getStatusForCustomer_(
          String(payload.id || ''),
          String(payload.email || '')
        ),
      });
    }

    // Architect endpoints. Secret travels in the body, never the URL.
    if (action === 'list') {
      requireAdminSecret_(payload.secret);
      return jsonResponse_({ ok: true, submissions: listSubmissions_() });
    }
    if (action === 'detail') {
      requireAdminSecret_(payload.secret);
      return jsonResponse_({
        ok: true,
        submission: getSubmission_(String(payload.id || '')),
      });
    }
    if (action === 'approve') {
      requireAdminSecret_(payload.secret);
      return jsonResponse_({
        ok: true,
        approvedAt: approveSubmission_(String(payload.id || '')),
      });
    }

    // No action → a survey submission.
    validatePayload_(payload);
    checkSubmissionRate_();

    const submissionId = Utilities.getUuid().slice(0, 8).toUpperCase();
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
 * GET /exec — health check, plus legacy read endpoints.
 *
 * The app now uses POST for status, list and detail. These GET forms
 * are kept so nothing breaks mid-rollout; they can be deleted once the
 * updated app is live everywhere.
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = String(params.action || '').toLowerCase();
    if (!action) {
      return jsonResponse_({
        ok: true,
        service: 'TM Measure submission endpoint',
        note: 'Use POST to submit. GET supports ?action=status only; list and detail are POST-only.',
      });
    }
    if (action === 'status') {
      return jsonResponse_({
        ok: true,
        status: getStatusForCustomer_(String(params.id || ''), String(params.email || '')),
      });
    }
    // list/detail are POST-only. They used to be reachable here with
    // ?secret=… in the query string, which contradicts the rule stated
    // in doPost that the secret never travels in a URL — and a URL is
    // the worst place for it: Apps Script records the full request in
    // the execution log, and it lands in browser history and in the
    // Referer header of anything the page subsequently loads. Every
    // caller in the app already POSTs, so nothing is lost by refusing.
    if (action === 'list' || action === 'detail') {
      throw new Error(
        'Use POST for ' + action + '. Query-string secrets are not accepted.'
      );
    }
    throw new Error('Unknown action: ' + action);
  } catch (err) {
    console.error(err);
    return jsonResponse_({ ok: false, error: String(err.message || err) });
  }
}

// ─── ARCHITECT READ ENDPOINTS ──────────────────────────────

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
  const cApproved = idxOf('Approved At');

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
      };
    }
    byId[id].roomCount += 1;
  });
  return Object.keys(byId)
    .map(function (k) { return byId[k]; })
    .sort(function (a, b) { return (b.submittedAt || '').localeCompare(a.submittedAt || ''); });
}

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
  const target = email.trim().toLowerCase();
  const match = rows.find(function (r) {
    return String(r[cId] || '') === id &&
      String(r[cEmail] || '').toLowerCase().trim() === target;
  });
  if (!match) throw new Error('No matching submission found.');
  return {
    submissionId: id,
    projectName: match[cProject] || '',
    submittedAt: match[cSubmitted] ? new Date(match[cSubmitted]).toISOString() : null,
    approvedAt: cApproved >= 0 && match[cApproved]
      ? (match[cApproved] instanceof Date ? match[cApproved].toISOString() : String(match[cApproved]))
      : null,
    state: cApproved >= 0 && match[cApproved] ? 'approved' : 'pending',
  };
}

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
  return parsed;
}

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
    cApproved = lastCol;
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

// ─── PHOTO UPLOAD ──────────────────────────────────────────

/**
 * Upload every photo carrying a dataUri to a per-submission Drive
 * folder and replace the inline base64 with a link.
 *
 * Covers room photos, per-wall photos, exterior elevations and
 * proposal sketches. The last two used to be skipped entirely, so
 * their base64 survived into the sheet's "Raw payload" cell — and
 * Sheets caps a cell at 50,000 characters, which one photo exceeds
 * several times over. dataUri is now dropped on every path, including
 * failures, so an oversized string can never reach the sheet.
 */
function uploadPhotos_(payload, submissionId) {
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const exterior = (payload.exterior && typeof payload.exterior === 'object')
    ? payload.exterior : {};
  const sketches = (payload.proposal && Array.isArray(payload.proposal.sketches))
    ? payload.proposal.sketches : [];

  const anyWithData = function (list) {
    return (list || []).some(function (p) { return p && p.dataUri; });
  };

  let hasData = rooms.some(function (r) {
    if (anyWithData(r.photos)) return true;
    if (anyWithData(r.voiceMemos)) return true;
    return (r.walls || []).some(function (w) { return anyWithData(w.photos); });
  });
  if (!hasData) {
    hasData = Object.keys(exterior).some(function (side) {
      return anyWithData(exterior[side]);
    }) || anyWithData(sketches);
  }
  if (!hasData) return;

  const root = findOrCreateFolder_(DriveApp.getRootFolder(), 'TM Measure Submissions');
  const folder = root.createFolder(submissionId + ' — ' + (payload.projectName || 'project'));

  const safeFilename = function (raw, fallback) {
    let name = String(raw || fallback || 'photo');
    name = name.replace(/[\\/\x00-\x1f]/g, '_');
    name = name.replace(/^\.+/, '');
    name = name.replace(/[^A-Za-z0-9_-]/g, '_');
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

  const audioAllowedMimes = CONFIG.audioAllowedMimes;
  const audioExtByMime = {
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
  };

  /**
   * Generic media upload. `kind` only changes the allowlist, size cap,
   * extension table and log wording — the important part is that
   * dataUri is deleted on EVERY exit path, so an unhandled file can
   * never leak its base64 into the sheet's Raw payload cell.
   */
  const uploadMedia = function (item, fallbackName, kind) {
    if (!item || !item.dataUri) return;
    const isAudio = kind === 'audio';
    const allowed = isAudio ? audioAllowedMimes : allowedMimes;
    const maxBytes = isAudio ? CONFIG.audioMaxBytes : CONFIG.photoMaxBytes;
    const extTable = isAudio ? audioExtByMime : extByMime;
    try {
      // Tolerate MIME parameters. MediaRecorder emits data URIs like
      // "data:audio/webm;codecs=opus;base64,…" — a regex anchored on
      // ";base64," straight after the MIME type does not match those,
      // so every Chrome and Android voice memo was being discarded as
      // malformed before it could be looked at.
      const match = String(item.dataUri).match(/^data:([^;,]+)(;[^,]*)?;base64,(.+)$/);
      if (!match) {
        console.warn('Skipping ' + kind + ' with malformed data URI:', fallbackName);
        delete item.dataUri;
        return;
      }
      const mime = String(match[1]).toLowerCase();
      if (allowed.indexOf(mime) === -1) {
        console.warn('Rejected ' + kind + ' with disallowed MIME:', mime, fallbackName);
        delete item.dataUri;
        return;
      }
      const bytes = Utilities.base64Decode(match[3]);
      if (bytes.length > maxBytes) {
        console.warn('Rejected oversized ' + kind + ':', bytes.length, 'bytes', fallbackName);
        delete item.dataUri;
        return;
      }
      const ext = extTable[mime] || 'bin';
      const safeName = safeFilename(item.name, fallbackName);
      const file = folder.createFile(Utilities.newBlob(bytes, mime, safeName + '.' + ext));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      item.driveUrl = file.getUrl();
      delete item.dataUri;
    } catch (err) {
      console.error(kind + ' upload failed', err);
      try { delete item.dataUri; } catch (ignored) {}
    }
  };

  const uploadPhoto = function (photo, fallbackName) {
    uploadMedia(photo, fallbackName, 'photo');
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
    // Voice memos were never uploaded. The app base64s them into the
    // payload exactly like photos, but nothing here consumed them, so
    // the audio survived into safeRaw_ — where a single 120 KB memo
    // blows the 45k cap and truncates the whole Raw payload cell,
    // taking every field after it with it. The memo itself was lost
    // either way, and the customer had no idea.
    (room.voiceMemos || []).forEach(function (memo, mi) {
      uploadMedia(memo, 'room-' + (ri + 1) + '-voice-' + (mi + 1), 'audio');
    });
  });

  Object.keys(exterior).forEach(function (side) {
    (exterior[side] || []).forEach(function (photo, pi) {
      uploadPhoto(photo, 'exterior-' + side + '-' + (pi + 1));
    });
  });

  sketches.forEach(function (photo, pi) {
    uploadPhoto(photo, 'proposal-sketch-' + (pi + 1));
  });
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
  'Project Type',
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
  'Floor',
  'Position X (m)',
  'Position Z (m)',
  'Rotation (°)',
  'Voice memos',
  'Exterior photos',
  'Proposal',
  'Proposal sketches',
  'Raw payload',
];

/** Defuse spreadsheet formula injection. */
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

/** "front: name → url; back: …" for the sheet cell. */
function exteriorSummary_(payload) {
  const exterior = (payload.exterior && typeof payload.exterior === 'object')
    ? payload.exterior : {};
  const parts = [];
  Object.keys(exterior).forEach(function (side) {
    const list = exterior[side] || [];
    if (!list.length) return;
    const items = list.map(function (p) {
      return p.driveUrl ? (p.name || 'photo') + ' → ' + p.driveUrl : (p.name || 'photo');
    }).join(', ');
    parts.push(side + ': ' + items);
  });
  return parts.join('\n');
}

function sketchesSummary_(payload) {
  const sketches = (payload.proposal && Array.isArray(payload.proposal.sketches))
    ? payload.proposal.sketches : [];
  return sketches.map(function (p) {
    return p.driveUrl ? (p.name || 'sketch') + ' → ' + p.driveUrl : (p.name || 'sketch');
  }).join('\n');
}

/**
 * Serialise the payload for the "Raw payload" cell without exceeding
 * the Sheets per-cell limit. A backstop: better a truncated record
 * than appendRow throwing and losing the submission.
 */
function safeRaw_(payload) {
  const LIMIT = 45000;
  let raw;
  try {
    raw = JSON.stringify(payload);
  } catch (err) {
    return '(payload could not be serialised: ' + String(err) + ')';
  }
  if (raw.length <= LIMIT) return raw;
  console.warn('Raw payload truncated at ' + LIMIT + ' of ' + raw.length + ' chars.');
  return raw.substring(0, LIMIT) +
    '\n…TRUNCATED (' + raw.length + ' chars total). Photos are in Drive.';
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
    migrateHeaders_(sheet);
  }

  const submittedAt = payload.submittedAt || new Date().toISOString();
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const connections = Array.isArray(payload.connections) ? payload.connections : [];
  const connectionsStr = connectionsSummary_(connections);
  const exteriorStr = exteriorSummary_(payload);
  const proposalText = (payload.proposal && payload.proposal.description)
    ? String(payload.proposal.description) : '';
  const sketchesStr = sketchesSummary_(payload);
  const raw = safeRaw_(payload);

  /**
   * Build a row from a header→value map so it cannot drift out of
   * alignment with HEADERS.
   *
   * The no-rooms branch below used to be a hand-counted array with runs
   * of bare '' placeholders. Adding a column anywhere left of the end
   * silently shifted every later value one cell to the left, so the
   * Raw payload would land in Proposal sketches and so on — with no
   * error, because the row was still an array of the wrong length.
   */
  const rowFrom = function (values) {
    return HEADERS.map(function (h) {
      return Object.prototype.hasOwnProperty.call(values, h) ? values[h] : '';
    });
  };

  if (rooms.length === 0) {
    sheet.appendRow(rowFrom({
      'Submitted At': submittedAt,
      'Submission ID': submissionId,
      'Customer Name': csvSafe_(payload.customerName || ''),
      'Email': csvSafe_(payload.email || ''),
      'Project Name': csvSafe_(payload.projectName || ''),
      'Project Type': csvSafe_(payload.projectType || ''),
      'Unit': csvSafe_(payload.unitPreference || ''),
      'Room': '(no rooms submitted)',
      'Connections': csvSafe_(connectionsStr),
      'Exterior photos': csvSafe_(exteriorStr),
      'Proposal': csvSafe_(proposalText),
      'Proposal sketches': csvSafe_(sketchesStr),
      'Raw payload': raw,
    }));
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

    const photoLine = function (p, label) {
      const name = label || p.name || 'photo';
      return p.driveUrl ? name + ' → ' + p.driveUrl : name;
    };
    // Per-wall photos were uploaded to Drive but their links appeared
    // nowhere — not the sheet, not the email. The files sit in the
    // submission folder under the customer's own camera filenames, so
    // there was no way to tell which wall any of them showed. Prefix
    // each with its wall label so the cell is actually usable.
    const wallPhotos = (room.walls || []).reduce(function (acc, w, wi) {
      (w.photos || []).forEach(function (p) {
        acc.push(photoLine(p, (w.label || ('Wall ' + (wi + 1))) + ': ' + (p.name || 'photo')));
      });
      return acc;
    }, []);
    const photos = (room.photos || []).map(function (p) { return photoLine(p); })
      .concat(wallPhotos)
      .filter(Boolean).join('\n');

    const voice = (room.voiceMemos || []).map(function (m, i) {
      const label = m.name || ('Voice memo ' + (i + 1));
      const secs = (typeof m.durationMs === 'number' && isFinite(m.durationMs))
        ? ' (' + Math.round(m.durationMs / 1000) + 's)' : '';
      return m.driveUrl ? label + secs + ' → ' + m.driveUrl : label + secs;
    }).filter(Boolean).join('\n');

    const placement = room.placement;
    const hasPlacement = placement && placement.positionM &&
      typeof placement.positionM.x === 'number' &&
      typeof placement.positionM.z === 'number';
    const floorCell = hasPlacement ? placement.floor : '';
    const posXCell = hasPlacement ? Number(placement.positionM.x).toFixed(2) : '';
    const posZCell = hasPlacement ? Number(placement.positionM.z).toFixed(2) : '';
    const rotationCell = hasPlacement ? (placement.rotationDeg || 0) + '°' : '';

    sheet.appendRow(rowFrom({
      'Submitted At': submittedAt,
      'Submission ID': submissionId,
      'Customer Name': csvSafe_(payload.customerName || ''),
      'Email': csvSafe_(payload.email || ''),
      'Project Name': csvSafe_(payload.projectName || ''),
      'Project Type': csvSafe_(payload.projectType || ''),
      'Unit': csvSafe_(payload.unitPreference || ''),
      'Room': csvSafe_(room.name || room.label || ''),
      'Walls (m)': csvSafe_(wallsStr),
      'Ceiling (m)': csvSafe_(ceiling),
      'Doors': csvSafe_(doorsStr),
      'Windows': csvSafe_(windowsStr),
      'Irregular notes': csvSafe_(room.irregularShapeNotes || ''),
      'Room notes': csvSafe_(room.notes || ''),
      'Photo filenames': csvSafe_(photos),
      'Connections': csvSafe_(connectionsStr),
      'Floor': floorCell,
      'Position X (m)': posXCell,
      'Position Z (m)': posZCell,
      'Rotation (°)': rotationCell,
      'Voice memos': csvSafe_(voice),
      'Exterior photos': csvSafe_(exteriorStr),
      'Proposal': csvSafe_(proposalText),
      'Proposal sketches': csvSafe_(sketchesStr),
      'Raw payload': raw,
    }));
  });
}

/** Insert any headers the sheet is missing, at the right position. */
function migrateHeaders_(sheet) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  for (let i = 0; i < HEADERS.length; i++) {
    const want = HEADERS[i];
    if (existing[i] === want) continue;
    if (existing.indexOf(want) === -1) {
      sheet.insertColumnBefore(i + 1);
      sheet.getRange(1, i + 1).setValue(want)
        .setFontWeight('bold').setBackground('#1c1c1a').setFontColor('#fcf9f5');
      existing.splice(i, 0, want);
    }
  }
}

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
        // Wall photos are uploaded but were never linked from anywhere.
        // Hang them off the wall they belong to, which is the only place
        // they mean anything.
        const shots = (w.photos || []).filter(function (p) { return p && p.driveUrl; });
        const shotsHtml = shots.length
          ? '<div style="margin-top:4px;">' +
              shots.map(function (p) {
                return '<a href="' + p.driveUrl + '" style="color:' + gold + ';text-decoration:none;font-size:12px;">' +
                  escapeHtml_(p.name || 'photo') + '</a>';
              }).join('<span style="color:' + mid + ';font-size:12px;"> · </span>') +
            '</div>'
          : '';
        return '<tr>' +
          '<td style="padding:6px 12px;color:' + mid + ';font-size:13px;">' +
            (w.label || ('Wall ' + (i + 1))) +
          '</td>' +
          '<td style="padding:6px 12px;font-family:monospace;font-size:14px;color:' + dark + ';text-align:right;">' +
            formatDual_(w.lengthM) + shotsHtml +
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
    const voiceBlock = uploadedMemos.length
      ? '<div style="margin-top:12px;padding:0 12px;">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:' + mid + ';margin-bottom:4px;">Voice notes (' + uploadedMemos.length + ')</div>' +
          uploadedMemos.map(function (m, i) {
            const secs = (typeof m.durationMs === 'number' && isFinite(m.durationMs))
              ? ' · ' + Math.round(m.durationMs / 1000) + 's' : '';
            return '<div style="font-size:13px;line-height:1.5;">→ <a href="' + m.driveUrl + '" style="color:' + gold + ';text-decoration:none;">' +
              escapeHtml_(m.name || ('Voice memo ' + (i + 1))) + '</a><span style="color:' + mid + ';">' + secs + '</span></div>';
          }).join('') +
        '</div>'
      : '';

    // room.name, not room.label — the app sends name, so every room in
    // the email used to be headed simply "Room".
    return '<div style="margin-top:20px;border:1px solid ' + border + ';border-radius:8px;overflow:hidden;">' +
      '<div style="padding:12px 16px;background:' + dark + ';color:' + cream + ';font-weight:600;font-size:15px;">' +
        escapeHtml_(room.name || room.label || 'Room') +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;">' +
        walls + ceilingRow + doorsRow + windowsRow +
      '</table>' +
      (notesBlock ? '<div style="padding:0 12px 12px 12px;">' + notesBlock + '</div>' : '') +
      (photosBlock ? '<div style="padding:0 0 12px 0;">' + photosBlock + '</div>' : '') +
      (voiceBlock ? '<div style="padding:0 0 12px 0;">' + voiceBlock + '</div>' : '') +
    '</div>';
  }).join('');

  return '' +
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;background:#f4efe5;padding:32px 16px;">' +
      '<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +

        '<div style="padding:24px 28px;border-bottom:1px solid ' + border + ';">' +
          '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:' + gold + ';font-weight:700;">TM Measure</div>' +
          '<h1 style="margin:4px 0 0 0;font-size:22px;color:' + dark + ';font-weight:600;">New measurement submission</h1>' +
        '</div>' +

        '<div style="padding:20px 28px;background:' + cream + ';border-bottom:1px solid ' + border + ';">' +
          '<table style="width:100%;border-collapse:collapse;font-size:14px;color:' + dark + ';">' +
            row_('Customer', escapeHtml_(payload.customerName || '—'), mid) +
            row_('Email', '<a href="mailto:' + encodeURIComponent(payload.email || '') + '" style="color:' + gold + ';text-decoration:none;">' + escapeHtml_(payload.email || '—') + '</a>', mid) +
            row_('Project', escapeHtml_(payload.projectName || '—'), mid) +
            // The customer picks loft / extension / garage on the home
            // screen and it shapes how the job is quoted, but it was
            // collected and then never shown anywhere.
            (payload.projectType
              ? row_('Project type', escapeHtml_(String(payload.projectType)), mid)
              : '') +
            row_('Unit preference', (payload.unitPreference || 'metric'), mid) +
            row_('Submitted', when, mid) +
            row_('Submission ID', submissionId, mid) +
          '</table>' +
        '</div>' +

        '<div style="padding:8px 28px 24px 28px;">' +
          '<h2 style="margin:20px 0 0 0;font-size:16px;color:' + dark + ';font-weight:600;">Rooms (' + rooms.length + ')</h2>' +
          roomsHtml +
        '</div>' +

        connectionsHtmlBlock_(payload, gold, cream, dark, mid, border) +

        proposalHtmlBlock_(payload, gold, cream, dark, mid, border) +

        floorPlanHtmlBlock_(payload, gold, cream, dark, mid, border) +

        '<div style="padding:16px 28px;border-top:1px solid ' + border + ';background:#fafafa;font-size:12px;color:' + mid + ';">' +
          'This submission was sent automatically from the TM Measure app. The full row is stored in your Submissions sheet. Reply to this email to contact the customer directly.' +
        '</div>' +

      '</div>' +
    '</div>';
}

/**
 * The customer's description of the work, plus sketches and exterior
 * elevations. All three used to be discarded entirely.
 */
function proposalHtmlBlock_(payload, gold, cream, dark, mid, border) {
  const description = (payload.proposal && payload.proposal.description)
    ? String(payload.proposal.description) : '';
  const sketches = (payload.proposal && Array.isArray(payload.proposal.sketches))
    ? payload.proposal.sketches.filter(function (p) { return p && p.driveUrl; })
    : [];
  const exterior = (payload.exterior && typeof payload.exterior === 'object')
    ? payload.exterior : {};
  const sidesWithPhotos = Object.keys(exterior).filter(function (s) {
    return (exterior[s] || []).some(function (p) { return p && p.driveUrl; });
  });

  if (!description && !sketches.length && !sidesWithPhotos.length) return '';

  let inner = '';

  if (description) {
    inner +=
      '<div style="padding:14px 16px;">' +
        '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:' + mid + ';margin-bottom:6px;">What the customer wants</div>' +
        '<div style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:' + dark + ';padding:10px 12px;background:' + cream + ';border-left:3px solid ' + gold + ';">' +
          escapeHtml_(description) +
        '</div>' +
      '</div>';
  }

  if (sketches.length) {
    inner +=
      '<div style="padding:0 16px 14px 16px;">' +
        '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:' + mid + ';margin-bottom:4px;">Sketches / inspiration (' + sketches.length + ')</div>' +
        sketches.map(function (p) {
          return '<div style="font-size:13px;line-height:1.5;">→ <a href="' + p.driveUrl + '" style="color:' + gold + ';text-decoration:none;">' + escapeHtml_(p.name || 'sketch') + '</a></div>';
        }).join('') +
      '</div>';
  }

  if (sidesWithPhotos.length) {
    inner +=
      '<div style="padding:0 16px 14px 16px;">' +
        '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:' + mid + ';margin-bottom:4px;">Exterior elevations</div>' +
        sidesWithPhotos.map(function (side) {
          const links = (exterior[side] || [])
            .filter(function (p) { return p && p.driveUrl; })
            .map(function (p) {
              return '<a href="' + p.driveUrl + '" style="color:' + gold + ';text-decoration:none;">' + escapeHtml_(p.name || 'photo') + '</a>';
            }).join(', ');
          return '<div style="font-size:13px;line-height:1.6;">' +
            '<span style="color:' + mid + ';text-transform:capitalize;">' + escapeHtml_(side) + ':</span> ' + links +
          '</div>';
        }).join('') +
      '</div>';
  }

  return '<div style="padding:0 28px 24px 28px;">' +
    '<div style="margin-top:20px;border:1px solid ' + border + ';border-radius:8px;overflow:hidden;">' +
      '<div style="padding:12px 16px;background:' + dark + ';color:' + cream + ';font-weight:600;font-size:15px;">' +
        'Proposal &amp; exterior' +
      '</div>' +
      inner +
    '</div>' +
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

function floorPlanHtmlBlock_(payload, gold, cream, dark, mid, border) {
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const placed = rooms.filter(function (r) {
    return r.placement && r.placement.positionM &&
      typeof r.placement.positionM.x === 'number' &&
      typeof r.placement.positionM.z === 'number';
  });
  if (!placed.length) return '';

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

function roomFootprint_(room) {
  const walls = Array.isArray(room.walls) ? room.walls : [];
  const w = walls[0] ? Number(walls[0].lengthM) : NaN;
  const l = walls[1] ? Number(walls[1].lengthM) : NaN;
  return {
    widthM: isFinite(w) && w > 0 ? w : 3,
    lengthM: isFinite(l) && l > 0 ? l : 3,
  };
}

function renderFloorSvg_(floorRooms, gold, cream, dark, mid) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const bboxes = [];
  for (let i = 0; i < floorRooms.length; i++) {
    const r = floorRooms[i];
    const size = roomFootprint_(r);
    const p = r.placement;
    const rot = p.rotationDeg || 0;
    // Rotation about the top-left anchor, matching the editor's
    // rotate(deg 0 0). SVG rotates clockwise in this z-down system, so
    // 90° sends the far corner down and to the LEFT.
    let dx, dz;
    if (rot === 90)      { dx = -size.lengthM; dz = size.widthM;   }
    else if (rot === 180){ dx = -size.widthM;  dz = -size.lengthM; }
    else if (rot === 270){ dx = size.lengthM;  dz = -size.widthM;  }
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

  const roomsSvg = floorRooms.map(function (r) {
    const size = roomFootprint_(r);
    const p = r.placement;
    const rot = p.rotationDeg || 0;
    const transform = 'translate(' + p.positionM.x + ',' + p.positionM.z + ') rotate(' + rot + ' 0 0)';
    const name = escapeHtml_(r.name || 'Room');
    return '<g transform="' + transform + '">' +
      '<rect x="0" y="0" width="' + size.widthM + '" height="' + size.lengthM + '" ' +
        'fill="#fff8ea" fill-opacity="0.92" stroke="' + gold + '" stroke-width="1.6" ' +
        'vector-effect="non-scaling-stroke" rx="0.05"/>' +
      '<text x="' + (size.widthM / 2) + '" y="' + (size.lengthM / 2 - 0.05) + '" ' +
        'font-size="0.42" fill="' + dark + '" font-weight="600" text-anchor="middle" ' +
        'font-family="Helvetica,Arial,sans-serif">' + name + '</text>' +
      '<text x="' + (size.widthM / 2) + '" y="' + (size.lengthM / 2 + 0.45) + '" ' +
        'font-size="0.3" fill="' + mid + '" text-anchor="middle" ' +
        'font-family="Helvetica,Arial,sans-serif">' +
        size.widthM.toFixed(2) + ' × ' + size.lengthM.toFixed(2) + ' m</text>' +
    '</g>';
  }).join('');

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

  // The customer's own description of the work. Previously omitted.
  if (payload.proposal && payload.proposal.description) {
    lines.push('— What the customer wants —');
    lines.push('  ' + payload.proposal.description);
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

function validEmail_(s) {
  if (typeof s !== 'string') return false;
  if (s.length > 254) return false;
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
 * Daily snapshot of the Submissions sheet. Set up once as a
 * time-driven trigger: Triggers → Add trigger → dailyBackup →
 * Time-driven → Day timer → 02:00–03:00.
 */
function dailyBackup() {
  const source = SpreadsheetApp.getActiveSpreadsheet();
  const sourceFile = DriveApp.getFileById(source.getId());
  const folder = findOrCreateFolder_(DriveApp.getRootFolder(), 'TM Measure Backups');
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const name = 'TM Measure — Submissions — ' + stamp;
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    console.log('Backup for ' + stamp + ' already exists.');
    return;
  }
  sourceFile.makeCopy(name, folder);
  console.log('Backup created: ' + name);

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

/** Find the bound spreadsheet. Run manually to confirm the binding. */
function whereIsTheSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  console.log('Name: ' + ss.getName());
  console.log('URL:  ' + ss.getUrl());
}

/** Run manually to test the sheet + email path without the app. */
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
        placement: { floor: 0, rotationDeg: 0, positionM: { x: 0, z: 0 } },
      },
    ],
    connections: [],
    exterior: { front: [], back: [], left: [], right: [] },
    proposal: {
      description: 'Rear single-storey extension, open onto the garden.',
      sketches: [],
    },
  };
  appendRows_(fake, 'TEST1234');
  sendEmail_(fake, 'TEST1234');
}
