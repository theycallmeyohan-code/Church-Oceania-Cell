const PHOTO_VERSION = "20260704-photo-fix-2";

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

    if (request.method === "GET" && path[0] === "bootstrap") return getBootstrap(env);
    if (path[0] === "members") return handleMembers(request, env, path);
    if (path[0] === "visit-notes") return handleVisitNotes(request, env);
    if (path[0] === "call-notes") return handleCallNotes(request, env);

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error.message || "Server error" }, error.status || 500);
  }
}

function normalizePath(path) {
  if (!path) return [];
  return Array.isArray(path) ? path : [path];
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
