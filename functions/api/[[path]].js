const PHOTO_VERSION = "20260704-photo-fix-2";
const PASSWORD_HASH_KEY = "auth.passwordHash";
const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 120000;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Token,X-Call-Note-Token"
};

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  const path = normalizePath(params.path);
  try {
    if (path[0] === "photos") return handlePhotoRead(env, path.slice(1));
    if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 503);

    if (path[0] === "auth") return handleAuth(request, env, path);
    if (request.method === "GET" && path[0] === "bootstrap") return getBootstrap(env);
    if (path[0] === "members") return handleMembers(request, env, path);
    if (path[0] === "visit-notes") return handleVisitNotes(request, env);
    if (path[0] === "sunday-attendance") return handleSundayAttendance(request, env);
    if (path[0] === "call-notes") return handleCallNotes(request, env);

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error.message || "Server error" }, error.status || 500);
  }
}

function normalizePath(path) {
  if (!path) return [];
  return Array.isArray(path) ? path : String(path).split("/").filter(Boolean);
}

async function getBootstrap(env) {
  const cells = await env.DB.prepare(
    "SELECT id, name, meta, gender, sort_order AS sortOrder FROM cells ORDER BY sort_order, name"
  ).all();
  const members = await env.DB.prepare(
    `SELECT id, cell_id AS cellId, name, title, role, phone, home_phone AS homePhone, birth, registered_at AS registeredAt, address, memo,
      photo_key AS photoKey, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM members
     ORDER BY cell_id, role DESC, name`
  ).all();
  const visits = await env.DB.prepare(
    `SELECT id, member_id AS memberId, visit_date AS visitDate, visit_type AS visitType,
      summary, prayer, action, source, created_at AS createdAt
     FROM visit_notes
     ORDER BY visit_date DESC, created_at DESC
     LIMIT 500`
  ).all();
  return json({
    cells: cells.results || [],
    members: cellsWithPhotoUrls(members.results || []),
    visits: visits.results || []
  });
}

async function handleAuth(request, env, path) {
  if (request.method === "POST" && path[1] === "change-password") {
    return changePassword(request, env);
  }
  return json({ error: "Not found" }, 404);
}

async function changePassword(request, env) {
  const body = await safeJson(request);
  const currentPassword = clean(body.currentPassword);
  const newPassword = clean(body.newPassword);

  if (!currentPassword || !newPassword) {
    return json({ error: "\uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uC640 \uC0C8 \uBE44\uBC00\uBC88\uD638\uB97C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  if (newPassword.length < 8) {
    return json({ error: "\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 8\uC790 \uC774\uC0C1\uC73C\uB85C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  if (newPassword === currentPassword) {
    return json({ error: "\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 \uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uC640 \uB2E4\uB974\uAC8C \uC785\uB825\uD558\uC138\uC694" }, 400);
  }
  if (!(await verifySitePassword(currentPassword, env))) {
    return json({ error: "\uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uAC00 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4" }, 401);
  }

  await ensureAppSettingsTable(env);
  const passwordHash = await createPasswordHash(newPassword);
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(PASSWORD_HASH_KEY, passwordHash, updatedAt).run();
  await audit(env, request, "auth.password.update", "setting", PASSWORD_HASH_KEY, "", { updatedAt });
  return json({ ok: true });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function ensureAppSettingsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

async function verifySitePassword(password, env) {
  const storedHash = await getStoredPasswordHash(env);
  if (storedHash) return verifyPasswordHash(password, storedHash);
  return Boolean(env.SITE_PASSWORD) && password === env.SITE_PASSWORD;
}

async function getStoredPasswordHash(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(PASSWORD_HASH_KEY)
      .first();
    return typeof row?.value === "string" ? row.value : "";
  } catch {
    return "";
  }
}

async function createPasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derivePasswordBits(password, salt, PASSWORD_ITERATIONS);
  return `${PASSWORD_ALGORITHM}$${PASSWORD_ITERATIONS}$${base64Url(salt)}$${base64Url(bits)}`;
}

async function verifyPasswordHash(password, storedHash) {
  const [algorithm, iterationsText, saltText, expectedText] = String(storedHash || "").split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== PASSWORD_ALGORITHM || !Number.isFinite(iterations) || !saltText || !expectedText) {
    return false;
  }

  const salt = base64UrlToBytes(saltText);
  const expected = base64UrlToBytes(expectedText);
  const actual = new Uint8Array(await derivePasswordBits(password, salt, iterations));
  return timingSafeBytesEqual(actual, expected);
}

async function derivePasswordBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
}

function base64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeBytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a[index] ^ b[index];
  }
  return result === 0;
}
async function handleMembers(request, env, path) {
  const id = path[1];

  if (request.method === "POST" && path.length === 1) {
    await requireWriteAuth(request, env);
    const body = await request.json();
    const member = normalizeMember(body, crypto.randomUUID());
    await env.DB.prepare(
      `INSERT INTO members
        (id, cell_id, name, title, role, phone, home_phone, birth, registered_at, address, memo, photo_key, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      member.id, member.cellId, member.name, member.title, member.role, member.phone, member.homePhone, member.birth, member.registeredAt,
      member.address, member.memo, member.photoKey, member.archivedAt, member.createdAt, member.updatedAt
    ).run();
    await audit(env, request, "member.create", "member", member.id, "", member);
    return json(cellsWithPhotoUrls([member])[0], 201);
  }

  if (!id) return json({ error: "Member id required" }, 400);

  if (request.method === "PATCH" && path.length === 2) {
    await requireWriteAuth(request, env);
    const body = await request.json();
    const previous = await getMember(env, id);
    if (!previous) return json({ error: "Member not found" }, 404);
    const member = normalizeMember({ ...previous, ...body, id }, id);
    await env.DB.prepare(
      `UPDATE members
       SET cell_id = ?, name = ?, title = ?, role = ?, phone = ?, home_phone = ?, birth = ?, registered_at = ?, address = ?,
        memo = ?, photo_key = ?, archived_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      member.cellId, member.name, member.title, member.role, member.phone, member.homePhone, member.birth, member.registeredAt, member.address,
      member.memo, member.photoKey, member.archivedAt, member.updatedAt, id
    ).run();
    await audit(env, request, "member.update", "member", id, previous, member);
    return json(cellsWithPhotoUrls([member])[0]);
  }

  if (request.method === "POST" && path[2] === "archive") {
    await requireWriteAuth(request, env);
    const archivedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET archived_at = ?, updated_at = ? WHERE id = ?")
      .bind(archivedAt, archivedAt, id)
      .run();
    await audit(env, request, "member.archive", "member", id, "", { archivedAt });
    return json({ id, archivedAt });
  }

  if (request.method === "POST" && path[2] === "restore") {
    await requireWriteAuth(request, env);
    const updatedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE members SET archived_at = '', updated_at = ? WHERE id = ?")
      .bind(updatedAt, id)
      .run();
    await audit(env, request, "member.restore", "member", id, "", { archivedAt: "" });
    return json({ id, archivedAt: "" });
  }

  if (request.method === "POST" && path[2] === "photo") {
    await requireWriteAuth(request, env);
    return uploadMemberPhoto(request, env, id);
  }

  if (request.method === "DELETE" && path.length === 2) {
    await requireWriteAuth(request, env);
    const previous = await getMember(env, id);
    await env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id).run();
    await audit(env, request, "member.delete", "member", id, previous || "", "");
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

async function handleVisitNotes(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  await requireWriteAuth(request, env);
  const body = await request.json();
  const visit = normalizeVisit(body);
  await env.DB.prepare(
    `INSERT INTO visit_notes
      (id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    visit.id, visit.memberId, visit.visitDate, visit.visitType, visit.summary,
    visit.prayer, visit.action, visit.source, visit.rawPayload, visit.createdAt
  ).run();
  await audit(env, request, "visit.create", "visit_note", visit.id, "", visit);
  return json(visit, 201);
}

async function handleSundayAttendance(request, env) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const attendanceDate = clean(url.searchParams.get("date"));
    return attendanceDate
      ? getSundayAttendanceByDate(env, attendanceDate)
      : listSundayAttendance(env);
  }

  if (request.method === "POST") {
    await requireWriteAuth(request, env);
    const body = await safeJson(request);
    return saveSundayAttendance(request, env, body);
  }

  return json({ error: "Method not allowed" }, 405);
}

async function listSundayAttendance(env) {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.attendance_date AS attendanceDate, s.label, s.created_at AS createdAt, s.updated_at AS updatedAt,
      COUNT(r.member_id) AS totalCount,
      COALESCE(SUM(CASE WHEN r.present = 1 THEN 1 ELSE 0 END), 0) AS presentCount
     FROM sunday_attendance_sessions s
     LEFT JOIN sunday_attendance_records r ON r.session_id = s.id
     GROUP BY s.id, s.attendance_date, s.label, s.created_at, s.updated_at
     ORDER BY s.attendance_date DESC
     LIMIT 80`
  ).all();
  return json({ sessions: (rows.results || []).map(normalizeAttendanceSessionRow) });
}

async function getSundayAttendanceByDate(env, attendanceDateValue) {
  const attendanceDate = normalizeDateValue(attendanceDateValue, "Attendance date is required");
  const session = await env.DB.prepare(
    `SELECT id, attendance_date AS attendanceDate, label, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_sessions
     WHERE attendance_date = ?`
  ).bind(attendanceDate).first();

  if (!session) return json({ session: null, records: [] });

  const records = await getSundayAttendanceRecords(env, session.id);
  return json({
    session: attendanceSessionWithCounts(session, records),
    records: records.map(attendanceRecordWithPhotoUrl)
  });
}

async function saveSundayAttendance(request, env, body) {
  const attendanceDate = normalizeDateValue(body.attendanceDate, "Attendance date is required");
  const label = clean(body.label);
  const presentMemberIds = new Set(
    (Array.isArray(body.presentMemberIds) ? body.presentMemberIds : [])
      .map(clean)
      .filter(Boolean)
  );
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT id, attendance_date AS attendanceDate, label, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_sessions
     WHERE attendance_date = ?`
  ).bind(attendanceDate).first();
  const sessionId = existing?.id || crypto.randomUUID();
  const createdAt = existing?.createdAt || now;

  const members = await getActiveMembersForAttendance(env);
  const records = members.map((member) => ({
    sessionId,
    memberId: member.id,
    memberName: member.name,
    memberTitle: member.title || "",
    memberRole: member.role || "",
    cellId: member.cellId,
    cellName: member.cellName,
    cellSortOrder: Number(member.cellSortOrder || 0),
    photoKey: member.photoKey || "",
    present: presentMemberIds.has(member.id) ? 1 : 0,
    createdAt: now,
    updatedAt: now
  }));

  const statements = [
    existing
      ? env.DB.prepare(
        "UPDATE sunday_attendance_sessions SET label = ?, updated_at = ? WHERE id = ?"
      ).bind(label, now, sessionId)
      : env.DB.prepare(
        `INSERT INTO sunday_attendance_sessions (id, attendance_date, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(sessionId, attendanceDate, label, createdAt, now),
    env.DB.prepare("DELETE FROM sunday_attendance_records WHERE session_id = ?").bind(sessionId),
    ...records.map((record) => env.DB.prepare(
      `INSERT INTO sunday_attendance_records
        (session_id, member_id, member_name, member_title, member_role, cell_id, cell_name, cell_sort_order, photo_key, present, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      record.sessionId, record.memberId, record.memberName, record.memberTitle, record.memberRole,
      record.cellId, record.cellName, record.cellSortOrder, record.photoKey, record.present,
      record.createdAt, record.updatedAt
    ))
  ];

  await env.DB.batch(statements);
  const session = attendanceSessionWithCounts({
    id: sessionId,
    attendanceDate,
    label,
    createdAt,
    updatedAt: now
  }, records);

  await audit(env, request, "sunday_attendance.save", "sunday_attendance_session", sessionId, existing || "", {
    attendanceDate,
    totalCount: records.length,
    presentCount: session.presentCount
  });

  return json({
    session,
    records: records.map(attendanceRecordWithPhotoUrl)
  }, existing ? 200 : 201);
}

async function getActiveMembersForAttendance(env) {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.name, m.title, m.role, m.cell_id AS cellId, c.name AS cellName,
      c.sort_order AS cellSortOrder, m.photo_key AS photoKey
     FROM members m
     JOIN cells c ON c.id = m.cell_id
     WHERE COALESCE(m.archived_at, '') = ''
     ORDER BY c.sort_order, m.role DESC, m.name`
  ).all();
  return rows.results || [];
}

async function getSundayAttendanceRecords(env, sessionId) {
  const rows = await env.DB.prepare(
    `SELECT session_id AS sessionId, member_id AS memberId, member_name AS memberName,
      member_title AS memberTitle, member_role AS memberRole, cell_id AS cellId, cell_name AS cellName,
      cell_sort_order AS cellSortOrder, photo_key AS photoKey, present, created_at AS createdAt, updated_at AS updatedAt
     FROM sunday_attendance_records
     WHERE session_id = ?
     ORDER BY cell_sort_order, cell_name, member_name`
  ).bind(sessionId).all();
  return rows.results || [];
}

async function handleCallNotes(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  await requireCallNoteAuth(request, env);
  const body = await request.json();
  const member = await findMemberForCall(env, body);
  const importId = crypto.randomUUID();

  if (!member) {
    await env.DB.prepare(
      "INSERT INTO call_note_imports (id, phone, status, payload) VALUES (?, ?, 'needs_review', ?)"
    ).bind(importId, body.phone || "", JSON.stringify(body)).run();
    return json({ status: "needs_review", importId }, 202);
  }

  const visit = normalizeVisit({
    memberId: member.id,
    visitDate: body.callDate || body.visitDate,
    visitType: body.visitType || "전화",
    summary: body.summary || body.note || "",
    prayer: body.prayer || "",
    action: body.action || body.nextAction || "",
    source: "call-note-app",
    rawPayload: JSON.stringify(body)
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO visit_notes
        (id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      visit.id, visit.memberId, visit.visitDate, visit.visitType, visit.summary,
      visit.prayer, visit.action, visit.source, visit.rawPayload, visit.createdAt
    ),
    env.DB.prepare(
      "INSERT INTO call_note_imports (id, member_id, phone, status, payload) VALUES (?, ?, ?, 'attached', ?)"
    ).bind(importId, member.id, body.phone || member.phone || "", JSON.stringify(body))
  ]);

  return json({ status: "attached", memberId: member.id, visitId: visit.id });
}

async function uploadMemberPhoto(request, env, memberId) {
  if (!env.PHOTOS) return json({ error: "R2 binding PHOTOS is not configured" }, 503);
  const formData = await request.formData();
  const photo = formData.get("photo");
  if (!(photo instanceof File)) return json({ error: "photo file is required" }, 400);
  if (!photo.type.startsWith("image/")) return json({ error: "image file is required" }, 400);

  const safeName = photo.name.replace(/[^\w.-]+/g, "_").slice(-80) || "photo";
  const key = `members/${memberId}/${Date.now()}-${safeName}`;
  await env.PHOTOS.put(key, photo.stream(), {
    httpMetadata: { contentType: photo.type }
  });
  const updatedAt = new Date().toISOString();
  await env.DB.prepare("UPDATE members SET photo_key = ?, updated_at = ? WHERE id = ?")
    .bind(key, updatedAt, memberId)
    .run();
  await audit(env, request, "member.photo.update", "member", memberId, "", { photoKey: key });
  return json({ photoKey: key, photoUrl: `/api/photos/${encodeURIComponent(key)}` });
}

async function handlePhotoRead(env, keyParts) {
  if (!env.PHOTOS) return json({ error: "R2 binding PHOTOS is not configured" }, 503);
  const key = decodeURIComponent(keyParts.join("/"));
  const object = await env.PHOTOS.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(object.body, { headers });
}

async function getMember(env, id) {
  return env.DB.prepare(
    `SELECT id, cell_id AS cellId, name, title, role, phone, home_phone AS homePhone, birth, registered_at AS registeredAt, address, memo,
      photo_key AS photoKey, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM members WHERE id = ?`
  ).bind(id).first();
}

async function findMemberForCall(env, body) {
  if (body.memberId) return getMember(env, body.memberId);
  if (!body.phone) return null;
  return env.DB.prepare(
    `SELECT id, cell_id AS cellId, name, title, role, phone, home_phone AS homePhone, birth, registered_at AS registeredAt, address, memo,
      photo_key AS photoKey, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt
     FROM members
     WHERE replace(replace(replace(phone, '-', ''), ' ', ''), '.', '') = ?
        OR replace(replace(replace(home_phone, '-', ''), ' ', ''), '.', '') = ?
     LIMIT 1`
  ).bind(String(body.phone).replace(/[-\s.]/g, ""), String(body.phone).replace(/[-\s.]/g, "")).first();
}

function normalizeMember(body, fallbackId) {
  const now = new Date().toISOString();
  return {
    id: clean(body.id) || fallbackId,
    cellId: clean(body.cellId),
    name: clean(body.name),
    title: clean(body.title),
    role: clean(body.role),
    phone: clean(body.phone),
    homePhone: clean(body.homePhone),
    birth: clean(body.birth),
    registeredAt: clean(body.registeredAt),
    address: clean(body.address),
    memo: clean(body.memo),
    photoKey: clean(body.photoKey),
    archivedAt: clean(body.archivedAt),
    createdAt: clean(body.createdAt) || now,
    updatedAt: now
  };
}

function normalizeVisit(body) {
  const now = new Date().toISOString();
  return {
    id: clean(body.id) || crypto.randomUUID(),
    memberId: clean(body.memberId),
    visitDate: clean(body.visitDate) || now.slice(0, 10),
    visitType: clean(body.visitType) || "심방",
    summary: clean(body.summary),
    prayer: clean(body.prayer),
    action: clean(body.action),
    source: clean(body.source) || "manual",
    rawPayload: clean(body.rawPayload),
    createdAt: clean(body.createdAt) || now
  };
}

function cellsWithPhotoUrls(members) {
  return members.map((member) => ({
    ...member,
    photoUrl: member.photoKey
      ? `/api/photos/${encodeURIComponent(member.photoKey)}`
      : member.id?.startsWith("seed-") ? `/photos/${member.id}.jpg?v=${PHOTO_VERSION}` : ""
  }));
}

function attendanceSessionWithCounts(session, records) {
  const totalCount = records.length;
  const presentCount = records.filter((record) => Number(record.present) === 1).length;
  return {
    id: session.id,
    attendanceDate: session.attendanceDate,
    label: session.label || "",
    totalCount,
    presentCount,
    absentCount: Math.max(totalCount - presentCount, 0),
    createdAt: session.createdAt || "",
    updatedAt: session.updatedAt || ""
  };
}

function normalizeAttendanceSessionRow(row) {
  const totalCount = Number(row.totalCount || 0);
  const presentCount = Number(row.presentCount || 0);
  return {
    id: row.id,
    attendanceDate: row.attendanceDate,
    label: row.label || "",
    totalCount,
    presentCount,
    absentCount: Math.max(totalCount - presentCount, 0),
    createdAt: row.createdAt || "",
    updatedAt: row.updatedAt || ""
  };
}

function attendanceRecordWithPhotoUrl(record) {
  return {
    ...record,
    present: Number(record.present) === 1,
    photoUrl: record.photoKey ? `/api/photos/${encodeURIComponent(record.photoKey)}` : ""
  };
}

function normalizeDateValue(value, message) {
  const date = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(message, 400);
  return date;
}

async function requireWriteAuth(request, env) {
  if (!env.ADMIN_TOKEN) return;
  const token = request.headers.get("X-Admin-Token") || bearer(request);
  if (token !== env.ADMIN_TOKEN) throw new HttpError("Unauthorized", 401);
}

async function requireCallNoteAuth(request, env) {
  if (!env.CALL_NOTE_TOKEN) return;
  const token = request.headers.get("X-Call-Note-Token") || bearer(request);
  if (token !== env.CALL_NOTE_TOKEN) throw new HttpError("Unauthorized", 401);
}

async function audit(env, request, action, entityType, entityId, before, after) {
  const actor = request.headers.get("CF-Access-Authenticated-User-Email") || request.headers.get("X-Actor") || "";
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    crypto.randomUUID(), actor, action, entityType, entityId,
    before ? JSON.stringify(before) : "",
    after ? JSON.stringify(after) : ""
  ).run();
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
}

function clean(value) {
  return String(value ?? "").trim();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
