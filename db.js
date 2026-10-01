// SQLite storage for permanent alias rooms.
// Stores ONLY: aliases, hashed owner-device keys, hashed recovery codes, timestamps.
// No messages and no files are ever written here.
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "faax.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
    CREATE TABLE IF NOT EXISTS aliases (
        alias           TEXT PRIMARY KEY,
        recovery_hash   TEXT,
        created_at      INTEGER NOT NULL,
        last_active_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owner_devices (
        device_id     TEXT PRIMARY KEY,
        alias         TEXT NOT NULL REFERENCES aliases(alias) ON DELETE CASCADE,
        key_hash      TEXT NOT NULL,
        name          TEXT,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_owner_devices_alias ON owner_devices(alias);
`);

const stmts = {
    getAlias: db.prepare("SELECT * FROM aliases WHERE alias = ?"),
    insertAlias: db.prepare("INSERT INTO aliases (alias, recovery_hash, created_at, last_active_at) VALUES (?, ?, ?, ?)"),
    touchAlias: db.prepare("UPDATE aliases SET last_active_at = ? WHERE alias = ?"),
    setRecovery: db.prepare("UPDATE aliases SET recovery_hash = ? WHERE alias = ?"),

    getDevice: db.prepare("SELECT * FROM owner_devices WHERE device_id = ?"),
    listDevices: db.prepare("SELECT device_id, name, created_at, last_seen_at FROM owner_devices WHERE alias = ? ORDER BY created_at ASC"),
    countDevices: db.prepare("SELECT COUNT(*) AS n FROM owner_devices WHERE alias = ?"),
    insertDevice: db.prepare("INSERT INTO owner_devices (device_id, alias, key_hash, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"),
    touchDevice: db.prepare("UPDATE owner_devices SET last_seen_at = ? WHERE device_id = ?"),
    deleteDevice: db.prepare("DELETE FROM owner_devices WHERE device_id = ? AND alias = ?"),
};

// Claim = create alias + first owner device atomically (PRIMARY KEY makes a race lose cleanly)
const claimAlias = db.transaction((alias, recoveryHash, device) => {
    const now = Date.now();
    stmts.insertAlias.run(alias, recoveryHash, now, now);
    stmts.insertDevice.run(device.deviceId, alias, device.keyHash, device.name, now, now);
});

module.exports = { db, stmts, claimAlias, DATA_DIR };
