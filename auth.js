"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const AUTH_FILE = path.resolve(
  process.env.MINT_CONSOLE_AUTH_FILE || path.join(__dirname, ".mint-console-auth.json"),
);
const PASSWORD_MIN_BYTES = 12;
const PASSWORD_MAX_BYTES = 256;
const HASH_BYTES = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function validatePassword(password) {
  const text = String(password ?? "");
  const length = Buffer.byteLength(text, "utf8");
  if (length < PASSWORD_MIN_BYTES || length > PASSWORD_MAX_BYTES) {
    throw new Error(`应用密码长度必须为 ${PASSWORD_MIN_BYTES} 到 ${PASSWORD_MAX_BYTES} 个字节`);
  }
  return text;
}

function createPasswordRecord(password) {
  const text = validatePassword(password);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(text, salt, HASH_BYTES, SCRYPT_OPTIONS);
  const now = new Date().toISOString();
  return {
    version: 1,
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    createdAt: now,
    updatedAt: now,
  };
}

function saveAuthRecord(record) {
  const directory = path.dirname(AUTH_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${AUTH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, AUTH_FILE);
  fs.chmodSync(AUTH_FILE, 0o600);
}

function loadAuthRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (
      record?.algorithm !== "scrypt"
      || typeof record.salt !== "string"
      || typeof record.hash !== "string"
    ) return null;
    return record;
  } catch {
    return null;
  }
}

function verifyPassword(password, record = loadAuthRecord()) {
  if (!record) return false;
  let text;
  try {
    text = validatePassword(password);
  } catch {
    return false;
  }
  try {
    const salt = Buffer.from(record.salt, "base64");
    const expected = Buffer.from(record.hash, "base64");
    const actual = crypto.scryptSync(text, salt, expected.length || HASH_BYTES, SCRYPT_OPTIONS);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

module.exports = {
  AUTH_FILE,
  createPasswordRecord,
  loadAuthRecord,
  saveAuthRecord,
  validatePassword,
  verifyPassword,
};
