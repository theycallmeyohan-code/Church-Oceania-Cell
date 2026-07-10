export const PASSKEYS_SETTING_KEY = "auth.passkeys";

const CHALLENGE_TTL_SECONDS = 5 * 60;
const MAX_PASSKEYS = 10;
const MAX_REQUEST_BYTES = 128 * 1024;
const ES256_ALGORITHM = -7;
const EC2_KEY_TYPE = 2;
const P256_CURVE = 1;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;
const SPKI_P256_PREFIX = hexToBytes("3059301306072a8648ce3d020106082a8648ce3d03010703420004");

export class PasskeyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function readPasskeyRequest(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new PasskeyError("요청 크기가 너무 큽니다", 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) {
    throw new PasskeyError("요청 크기가 너무 큽니다", 413);
  }

  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
    return body;
  } catch {
    throw new PasskeyError("올바른 패스키 요청이 아닙니다");
  }
}

export async function getPasskeys(env) {
  if (!env.DB) return [];
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(PASSKEYS_SETTING_KEY)
      .first();
    const parsed = JSON.parse(typeof row?.value === "string" ? row.value : "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredPasskey).slice(0, MAX_PASSKEYS);
  } catch {
    return [];
  }
}

export async function clearPasskeys(env) {
  await ensureSettingsTable(env);
  await env.DB.prepare("DELETE FROM app_settings WHERE key = ?")
    .bind(PASSKEYS_SETTING_KEY)
    .run();
}

export async function createRegistrationOptions(request, env) {
  const { origin, rpId } = relyingParty(request);
  const passkeys = await getPasskeys(env);
  if (passkeys.length >= MAX_PASSKEYS) {
    throw new PasskeyError("등록 가능한 패스키 수를 초과했습니다", 409);
  }

  const userId = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`church-oceania-admin:${rpId}`)
  ));

  return {
    challenge: await createChallenge(env, "register", origin, rpId),
    rp: { id: rpId, name: "오세아니아 공동체" },
    user: {
      id: base64Url(userId),
      name: "admin",
      displayName: "공동체 관리자"
    },
    pubKeyCredParams: [{ type: "public-key", alg: ES256_ALGORITHM }],
    timeout: CHALLENGE_TTL_SECONDS * 1000,
    attestation: "none",
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      requireResidentKey: false,
      userVerification: "required"
    },
    excludeCredentials: passkeys.map((passkey) => ({
      id: passkey.id,
      type: "public-key"
    }))
  };
}

export async function registerPasskey(request, env, credential) {
  const { origin, rpId } = relyingParty(request);
  validateCredentialEnvelope(credential);

  const rawId = decodeField(credential.rawId || credential.id, "자격증명 ID", 2048);
  const canonicalId = base64Url(rawId);
  if (credential.id && credential.id !== canonicalId) {
    throw new PasskeyError("자격증명 ID가 일치하지 않습니다");
  }

  const clientDataBytes = decodeField(credential.response?.clientDataJSON, "clientDataJSON", 8192);
  await validateClientData(clientDataBytes, "webauthn.create", "register", origin, rpId, env);

  const attestationBytes = decodeField(
    credential.response?.attestationObject,
    "attestationObject",
    MAX_REQUEST_BYTES
  );
  const decodedAttestation = decodeCbor(attestationBytes).value;
  if (!(decodedAttestation instanceof Map)) {
    throw new PasskeyError("패스키 등록 응답 형식이 올바르지 않습니다");
  }

  const authData = decodedAttestation.get("authData");
  if (!(authData instanceof Uint8Array)) {
    throw new PasskeyError("authenticatorData가 없습니다");
  }
  const parsedAuthData = await parseAuthenticatorData(authData, rpId, true);
  if (!timingSafeBytesEqual(parsedAuthData.credentialId, rawId)) {
    throw new PasskeyError("등록된 자격증명 ID가 일치하지 않습니다");
  }

  const cose = decodeCbor(authData, parsedAuthData.coseOffset).value;
  if (!(cose instanceof Map)) {
    throw new PasskeyError("패스키 공개키 형식이 올바르지 않습니다");
  }
  const publicKey = coseToP256Spki(cose);

  const passkeys = await getPasskeys(env);
  if (passkeys.some((passkey) => passkey.id === canonicalId)) {
    throw new PasskeyError("이미 등록된 패스키입니다", 409);
  }
  if (passkeys.length >= MAX_PASSKEYS) {
    throw new PasskeyError("등록 가능한 패스키 수를 초과했습니다", 409);
  }

  const updated = [
    ...passkeys,
    {
      id: canonicalId,
      publicKey: base64Url(publicKey),
      algorithm: ES256_ALGORITHM,
      signCount: parsedAuthData.signCount
    }
  ];
  await storePasskeys(env, updated);
  return { registered: true, count: updated.length };
}

export async function createLoginOptions(request, env) {
  const { origin, rpId } = relyingParty(request);
  const passkeys = await getPasskeys(env);
  if (!passkeys.length) return { available: false };

  return {
    available: true,
    publicKey: {
      challenge: await createChallenge(env, "login", origin, rpId),
      rpId,
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        type: "public-key"
      })),
      timeout: CHALLENGE_TTL_SECONDS * 1000,
      userVerification: "required"
    }
  };
}

export async function verifyPasskeyLogin(request, env, credential) {
  const { origin, rpId } = relyingParty(request);
  validateCredentialEnvelope(credential);

  const rawId = decodeField(credential.rawId || credential.id, "자격증명 ID", 2048);
  const canonicalId = base64Url(rawId);
  if (credential.id && credential.id !== canonicalId) {
    throw new PasskeyError("자격증명 ID가 일치하지 않습니다", 401);
  }

  const passkeys = await getPasskeys(env);
  const passkeyIndex = passkeys.findIndex((passkey) => passkey.id === canonicalId);
  if (passkeyIndex === -1) throw new PasskeyError("등록되지 않은 패스키입니다", 401);
  const passkey = passkeys[passkeyIndex];

  const clientDataBytes = decodeField(credential.response?.clientDataJSON, "clientDataJSON", 8192);
  await validateClientData(clientDataBytes, "webauthn.get", "login", origin, rpId, env);

  const authData = decodeField(credential.response?.authenticatorData, "authenticatorData", 8192);
  const parsedAuthData = await parseAuthenticatorData(authData, rpId, false);
  const signatureDer = decodeField(credential.response?.signature, "signature", 4096);
  const signatureRaw = derEcdsaToRaw(signatureDer);
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes));
  const signedData = concatBytes(authData, clientDataHash);

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "spki",
      decodeField(passkey.publicKey, "저장된 공개키", 512),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    throw new PasskeyError("저장된 패스키 공개키를 읽을 수 없습니다", 500);
  }

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signatureRaw,
    signedData
  );
  if (!valid) throw new PasskeyError("패스키 서명이 올바르지 않습니다", 401);

  const previousCount = Number(passkey.signCount || 0);
  const nextCount = parsedAuthData.signCount;
  if (previousCount > 0 && nextCount > 0 && nextCount <= previousCount) {
    throw new PasskeyError("패스키 서명 카운터를 확인할 수 없습니다", 401);
  }
  if (nextCount !== previousCount) {
    passkeys[passkeyIndex] = { ...passkey, signCount: nextCount };
    await storePasskeys(env, passkeys);
  }

  return { ok: true };
}

async function createChallenge(env, purpose, origin, rpId) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    purpose,
    origin,
    rpId,
    iat: now,
    exp: now + CHALLENGE_TTL_SECONDS,
    nonce: base64Url(crypto.getRandomValues(new Uint8Array(32)))
  };
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await signChallenge(env, encodedPayload);
  return base64Url(new TextEncoder().encode(`${encodedPayload}.${signature}`));
}

async function validateChallenge(challenge, expectedPurpose, origin, rpId, env) {
  let token;
  try {
    token = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(challenge, 4096));
  } catch {
    throw new PasskeyError("패스키 challenge가 올바르지 않습니다", 401);
  }
  const parts = token.split(".");
  if (parts.length !== 2) throw new PasskeyError("패스키 challenge가 올바르지 않습니다", 401);

  const expectedSignature = await signChallenge(env, parts[0]);
  if (!timingSafeStringEqual(parts[1], expectedSignature)) {
    throw new PasskeyError("패스키 challenge 서명이 올바르지 않습니다", 401);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(parts[0], 4096)));
  } catch {
    throw new PasskeyError("패스키 challenge가 올바르지 않습니다", 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const validLifetime = Number.isInteger(payload.iat)
    && Number.isInteger(payload.exp)
    && payload.exp - payload.iat === CHALLENGE_TTL_SECONDS
    && payload.iat <= now + 30
    && payload.exp >= now;
  const validContext = payload.v === 1
    && payload.purpose === expectedPurpose
    && payload.origin === origin
    && payload.rpId === rpId
    && typeof payload.nonce === "string"
    && payload.nonce.length >= 40;
  if (!validLifetime || !validContext) {
    throw new PasskeyError("패스키 challenge가 만료되었거나 현재 사이트와 일치하지 않습니다", 401);
  }
}

async function validateClientData(bytes, expectedType, purpose, origin, rpId, env) {
  let clientData;
  try {
    clientData = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PasskeyError("clientDataJSON이 올바르지 않습니다");
  }
  if (clientData.type !== expectedType) {
    throw new PasskeyError("패스키 요청 종류가 일치하지 않습니다", 401);
  }
  if (clientData.origin !== origin || clientData.crossOrigin === true) {
    throw new PasskeyError("패스키 origin이 일치하지 않습니다", 401);
  }
  if (typeof clientData.challenge !== "string") {
    throw new PasskeyError("패스키 challenge가 없습니다", 401);
  }
  await validateChallenge(clientData.challenge, purpose, origin, rpId, env);
}

async function parseAuthenticatorData(authData, rpId, registration) {
  if (!(authData instanceof Uint8Array) || authData.length < 37) {
    throw new PasskeyError("authenticatorData가 올바르지 않습니다");
  }

  const expectedRpIdHash = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rpId)
  ));
  if (!timingSafeBytesEqual(authData.slice(0, 32), expectedRpIdHash)) {
    throw new PasskeyError("패스키 rpId가 일치하지 않습니다", 401);
  }

  const flags = authData[32];
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) {
    throw new PasskeyError("지문, 얼굴 또는 화면잠금 확인이 필요합니다", 401);
  }
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false);
  if (!registration) return { flags, signCount };

  if ((flags & FLAG_ATTESTED_CREDENTIAL_DATA) === 0 || authData.length < 55) {
    throw new PasskeyError("등록용 authenticatorData가 올바르지 않습니다");
  }
  const credentialIdLength = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0, false);
  const credentialIdStart = 55;
  const coseOffset = credentialIdStart + credentialIdLength;
  if (!credentialIdLength || coseOffset >= authData.length) {
    throw new PasskeyError("등록된 자격증명 데이터가 올바르지 않습니다");
  }
  return {
    flags,
    signCount,
    credentialId: authData.slice(credentialIdStart, coseOffset),
    coseOffset
  };
}

function coseToP256Spki(cose) {
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (cose.get(1) !== EC2_KEY_TYPE || cose.get(3) !== ES256_ALGORITHM || cose.get(-1) !== P256_CURVE) {
    throw new PasskeyError("ECDSA P-256 패스키만 등록할 수 있습니다");
  }
  if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) {
    throw new PasskeyError("P-256 공개키 좌표가 올바르지 않습니다");
  }
  return concatBytes(SPKI_P256_PREFIX, x, y);
}

function derEcdsaToRaw(signature) {
  if (signature.length === 64) return signature;
  let offset = 0;
  if (signature[offset++] !== 0x30) throw new PasskeyError("ECDSA 서명 형식이 올바르지 않습니다", 401);
  const sequence = readDerLength(signature, offset);
  offset = sequence.offset;
  if (sequence.length !== signature.length - offset) {
    throw new PasskeyError("ECDSA 서명 길이가 올바르지 않습니다", 401);
  }
  const r = readDerInteger(signature, offset);
  const s = readDerInteger(signature, r.offset);
  if (s.offset !== signature.length) throw new PasskeyError("ECDSA 서명 형식이 올바르지 않습니다", 401);
  return concatBytes(leftPad32(r.value), leftPad32(s.value));
}

function readDerInteger(bytes, offset) {
  if (bytes[offset++] !== 0x02) throw new PasskeyError("ECDSA 서명 정수가 올바르지 않습니다", 401);
  const lengthInfo = readDerLength(bytes, offset);
  const end = lengthInfo.offset + lengthInfo.length;
  if (!lengthInfo.length || end > bytes.length) throw new PasskeyError("ECDSA 서명 길이가 올바르지 않습니다", 401);
  let value = bytes.slice(lengthInfo.offset, end);
  if (value[0] & 0x80) throw new PasskeyError("ECDSA 서명 정수가 올바르지 않습니다", 401);
  while (value.length > 1 && value[0] === 0) value = value.slice(1);
  if (value.length > 32) throw new PasskeyError("ECDSA 서명 정수가 올바르지 않습니다", 401);
  return { value, offset: end };
}

function readDerLength(bytes, offset) {
  if (offset >= bytes.length) throw new PasskeyError("ECDSA 서명 길이가 없습니다", 401);
  const first = bytes[offset++];
  if ((first & 0x80) === 0) return { length: first, offset };
  const count = first & 0x7f;
  if (!count || count > 2 || offset + count > bytes.length) {
    throw new PasskeyError("ECDSA 서명 길이가 올바르지 않습니다", 401);
  }
  let length = 0;
  for (let index = 0; index < count; index += 1) length = (length << 8) | bytes[offset++];
  return { length, offset };
}

function leftPad32(value) {
  const output = new Uint8Array(32);
  output.set(value, 32 - value.length);
  return output;
}

function decodeCbor(bytes, startOffset = 0, depth = 0) {
  if (depth > 16 || startOffset >= bytes.length) throw new PasskeyError("CBOR 데이터가 올바르지 않습니다");
  const initial = bytes[startOffset];
  const major = initial >> 5;
  const additional = initial & 0x1f;
  const lengthInfo = readCborLength(bytes, startOffset + 1, additional);
  const length = lengthInfo.length;
  let offset = lengthInfo.offset;

  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2 || major === 3) {
    const end = offset + length;
    if (end > bytes.length) throw new PasskeyError("CBOR 데이터 길이가 올바르지 않습니다");
    const value = bytes.slice(offset, end);
    return {
      value: major === 2 ? value : new TextDecoder("utf-8", { fatal: true }).decode(value),
      offset: end
    };
  }
  if (major === 4) {
    if (length > 1000) throw new PasskeyError("CBOR 배열이 너무 큽니다");
    const value = [];
    for (let index = 0; index < length; index += 1) {
      const item = decodeCbor(bytes, offset, depth + 1);
      value.push(item.value);
      offset = item.offset;
    }
    return { value, offset };
  }
  if (major === 5) {
    if (length > 1000) throw new PasskeyError("CBOR 객체가 너무 큽니다");
    const value = new Map();
    for (let index = 0; index < length; index += 1) {
      const key = decodeCbor(bytes, offset, depth + 1);
      const item = decodeCbor(bytes, key.offset, depth + 1);
      value.set(key.value, item.value);
      offset = item.offset;
    }
    return { value, offset };
  }
  if (major === 6) return decodeCbor(bytes, offset, depth + 1);
  if (major === 7) {
    if (additional === 20) return { value: false, offset };
    if (additional === 21) return { value: true, offset };
    if (additional === 22) return { value: null, offset };
  }
  throw new PasskeyError("지원하지 않는 CBOR 데이터입니다");
}

function readCborLength(bytes, offset, additional) {
  if (additional < 24) return { length: additional, offset };
  if (additional === 31) throw new PasskeyError("무기한 CBOR 길이는 지원하지 않습니다");
  const byteCount = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  if (!byteCount || offset + byteCount > bytes.length) throw new PasskeyError("CBOR 길이가 올바르지 않습니다");
  let length = 0n;
  for (let index = 0; index < byteCount; index += 1) length = (length << 8n) | BigInt(bytes[offset + index]);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new PasskeyError("CBOR 길이가 너무 큽니다");
  return { length: Number(length), offset: offset + byteCount };
}

function validateCredentialEnvelope(credential) {
  if (!credential || credential.type !== "public-key" || !credential.response) {
    throw new PasskeyError("올바른 공개키 자격증명이 아닙니다");
  }
}

function relyingParty(request) {
  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new PasskeyError("패스키는 HTTPS에서만 사용할 수 있습니다", 400);
  }
  return { origin: url.origin, rpId: url.hostname };
}

async function signChallenge(env, encodedPayload) {
  const secret = env.SESSION_SECRET || env.SITE_PASSWORD;
  if (!secret) throw new PasskeyError("패스키 서명 키가 설정되어 있지 않습니다", 503);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`passkey-challenge.${encodedPayload}`)
  );
  return base64Url(signature);
}

async function storePasskeys(env, passkeys) {
  await ensureSettingsTable(env);
  const value = JSON.stringify(passkeys.map((passkey) => ({
    id: passkey.id,
    publicKey: passkey.publicKey,
    algorithm: ES256_ALGORITHM,
    signCount: Number(passkey.signCount || 0)
  })));
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(PASSKEYS_SETTING_KEY, value, new Date().toISOString()).run();
}

async function ensureSettingsTable(env) {
  if (!env.DB) throw new PasskeyError("D1 연결이 설정되어 있지 않습니다", 503);
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

function isStoredPasskey(value) {
  const signCount = Number(value?.signCount || 0);
  return value
    && typeof value.id === "string"
    && /^[A-Za-z0-9_-]{1,2048}$/.test(value.id)
    && typeof value.publicKey === "string"
    && /^[A-Za-z0-9_-]{80,512}$/.test(value.publicKey)
    && value.algorithm === ES256_ALGORITHM
    && Number.isInteger(signCount)
    && signCount >= 0
    && signCount <= 0xffffffff;
}

function decodeField(value, label, maxBytes) {
  try {
    return decodeBase64Url(value, maxBytes);
  } catch {
    throw new PasskeyError(`${label} 형식이 올바르지 않습니다`);
  }
}

function decodeBase64Url(value, maxBytes) {
  if (typeof value !== "string" || !value || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url");
  }
  if (value.length > Math.ceil(maxBytes * 4 / 3) + 4) throw new Error("base64url too large");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  if (binary.length > maxBytes) throw new Error("decoded value too large");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function timingSafeStringEqual(a, b) {
  return timingSafeBytesEqual(new TextEncoder().encode(String(a)), new TextEncoder().encode(String(b)));
}

function timingSafeBytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index];
  return result === 0;
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
