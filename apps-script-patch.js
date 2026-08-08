/**
 * TM Measure — Apps Script corrections
 * ====================================
 *
 * Five replacements for the backend script. Each block below replaces
 * one existing function or constant of the same name — find it in the
 * Apps Script editor, delete it, paste this in its place. Nothing else
 * needs to change.
 *
 * WHAT THESE FIX
 *
 * 1. Exterior photos and the proposal were received and discarded.
 *    The script never read payload.exterior or payload.proposal, so
 *    the customer's written description of the work they want — the
 *    most useful field in the survey — never reached you.
 *
 * 2. Those photos' base64 stayed in the payload and was written into
 *    the "Raw payload" cell. Sheets caps a cell at 50,000 characters
 *    and one compressed photo is several times that, so a survey with
 *    a few elevations would throw on append and lose the submission.
 *
 * 3. Every room in the HTML email was headed "Room", because it read
 *    room.label while the app sends room.name.
 *
 * DEPLOY AFTER PASTING
 *   Deploy → Manage deployments → edit the active one → Version: New
 *   version → Deploy. The /exec URL stays the same.
 */


// ─── 1. REPLACE the HEADERS constant ───────────────────────
// Three new columns before "Raw payload". migrateHeaders_ inserts them
// into the existing sheet automatically on the next submission, so
// historical rows keep their data.

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
  'Floor',
  'Position X (m)',
  'Position Z (m)',
  'Rotation (°)',
  'Exterior photos',
  'Proposal',
  'Proposal sketches',
  'Raw payload',
];


// ─── 2. REPLACE uploadPhotos_ ──────────────────────────────
// Now also uploads exterior elevations and proposal sketches, and
// strips their base64 the same way room photos are handled.

function uploadPhotos_(payload, submissionId) {
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const exterior = (payload.exterior && typeof payload.exterior === 'object')
    ? payload.exterior : {};
  const sketches = (payload.proposal && Array.isArray(payload.proposal.sketches))
    ? payload.proposal.sketches : [];

  const anyWithData = function (list) {
    return (list || []).some(function (p) { return p && p.dataUri; });
  };

  // Only touch Drive if something actually needs uploading.
  let hasData = rooms.some(function (r) {
    if (anyWithData(r.photos)) return true;
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

  const uploadPhoto = function (photo, fallbackName) {
    if (!photo || !photo.dataUri) return;
    try {
      const match = String(photo.dataUri).match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        console.warn('Skipping photo with malformed data URI:', fallbackName);
        // Still drop the field — an unusable string must not reach the
        // Raw payload cell and blow the 50,000-character limit.
        delete photo.dataUri;
        return;
      }
      const mime = String(match[1]).toLowerCase();
      if (allowedMimes.indexOf(mime) === -1) {
        console.warn('Rejected photo with disallowed MIME:', mime, fallbackName);
        delete photo.dataUri;
        return;
      }
      const bytes = Utilities.base64Decode(match[2]);
      if (bytes.length > CONFIG.photoMaxBytes) {
        console.warn('Rejected oversized photo:', bytes.length, 'bytes', fallbackName);
        delete photo.dataUri;
        return;
      }
      const ext = extByMime[mime] || 'bin';
      const safeName = safeFilename(photo.name, fallbackName);
      const file = folder.createFile(Utilities.newBlob(bytes, mime, safeName + '.' + ext));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      photo.driveUrl = file.getUrl();
      delete photo.dataUri;
    } catch (err) {
      console.error('Photo upload failed', err);
      // Drop it regardless, for the same cell-size reason.
      try { delete photo.dataUri; } catch (ignored) {}
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


// ─── 3. ADD these three helpers (new functions) ────────────

/**
 * "front: name → url, name → url; back: …" for the sheet cell.
 */
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
 * Stringify the payload for the "Raw payload" cell, never exceeding
 * the Sheets per-cell limit.
 *
 * uploadPhotos_ strips every base64 string it sees, so this should
 * normally be small. It is a backstop: if anything slips through, we
 * would rather store a truncated record than have appendRow throw and
 * lose the submission entirely.
 */
function safeRaw_(payload) {
  const LIMIT = 45000; // Sheets caps a cell at 50,000 characters.
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


// ─── 4. REPLACE appendRows_ ────────────────────────────────
// Writes the three new columns on every row of the submission.

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
      '', '', '', '',
      csvSafe_(exteriorStr),
      csvSafe_(proposalText),
      csvSafe_(sketchesStr),
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
      csvSafe_(exteriorStr),
      csvSafe_(proposalText),
      csvSafe_(sketchesStr),
      raw,
    ]);
  });
}


// ─── 5. ADD this helper (new function) ─────────────────────
// Renders the proposal and exterior elevations for the HTML email.

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


/**
 * ─── 6. TWO SMALL EDITS INSIDE buildHtmlEmail_ ─────────────
 *
 * (a) Fix the room heading. Find this line:
 *
 *         escapeHtml_(room.label || 'Room') +
 *
 *     and change it to:
 *
 *         escapeHtml_(room.name || room.label || 'Room') +
 *
 *     The app sends `name`, not `label`, so every room in the email is
 *     currently headed "Room". The sheet and the plain-text email
 *     already get this right — only the HTML heading is reversed.
 *
 * (b) Show the proposal. Find this line near the end:
 *
 *         connectionsHtmlBlock_(payload, gold, cream, dark, mid, border) +
 *
 *     and add the new block immediately after it:
 *
 *         proposalHtmlBlock_(payload, gold, cream, dark, mid, border) +
 *
 * ─── 7. ONE EDIT INSIDE buildPlainTextEmail_ ───────────────
 *
 *     Just before the final `return lines.join('\n');`, add:
 *
 *         if (payload.proposal && payload.proposal.description) {
 *           lines.push('— What the customer wants —');
 *           lines.push('  ' + payload.proposal.description);
 *           lines.push('');
 *         }
 */
