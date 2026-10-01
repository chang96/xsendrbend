// Permanent alias rooms (faax.me/<alias>)
//
// - Owners are identified by a per-device secret key (no sign-in). Only a SHA-256 hash is stored.
// - More devices become owners by redeeming a short-lived pairing code (QR) from an existing
//   owner device, or with the one-time-shown recovery code.
// - Guests "knock"; any online owner device lets them in or not.
// - Claims never expire: lose every device + the recovery code and the name stays taken.
const crypto = require("crypto");
const { stmts, claimAlias } = require("./db");

const ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]{1,18})[a-z0-9]$/; // 3-20 chars, no leading/trailing dash
const RESERVED = new Set([
    "api", "admin", "administrator", "new", "join", "create", "claim", "pair", "recover", "recovery",
    "about", "help", "faq", "faax", "www", "app", "static", "assets", "public", "settings", "login",
    "logout", "signin", "signup", "register", "account", "support", "terms", "privacy", "root",
    "system", "owner", "owners", "room", "rooms", "home", "index", "manifest", "robots", "favicon",
    "null", "undefined", "test", "status", "stats", "security", "legal", "contact",
]);

const PAIR_TTL_MS = 5 * 60 * 1000;
const GUEST_PASS_TTL_MS = 12 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const roomKey = (alias) => "@" + alias;
const ownersKey = (alias) => "owners:@" + alias;

// ---------- in-memory, short-lived state (fine to lose on restart) ----------
const knocks = new Map();      // requestId -> { alias, socketId, name, at }
const pairCodes = new Map();   // code -> { alias, expiresAt, byDeviceId }
const guestPasses = new Map(); // token -> { alias, expiresAt }
const buckets = new Map();     // rate-limit key -> { count, resetAt }

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pairCodes) if (v.expiresAt < now) pairCodes.delete(k);
    for (const [k, v] of guestPasses) if (v.expiresAt < now) guestPasses.delete(k);
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}, 60 * 1000).unref();

// ---------- helpers ----------
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const token = (bytes) => crypto.randomBytes(bytes).toString("base64url");

function safeEqualHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function randomCode(len) {
    const bytes = crypto.randomBytes(len);
    let out = "";
    for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
}

const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const normalizeAlias = (a) => String(a || "").trim().toLowerCase().replace(/^@/, "");
const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) || "Unknown device";

function validateAlias(alias) {
    if (!alias) return "empty";
    if (alias.length < 3) return "too_short";
    if (alias.length > 20) return "too_long";
    if (!ALIAS_RE.test(alias) || alias.includes("--")) return "invalid_chars";
    if (RESERVED.has(alias)) return "reserved";
    return null;
}

function clientIp(socket) {
    const fwd = socket.handshake.headers["x-forwarded-for"];
    return (fwd ? String(fwd).split(",")[0] : socket.handshake.address || "").trim();
}

function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    b.count += 1;
    return b.count <= max;
}

function newDevice(alias, name) {
    const deviceId = "dev_" + token(9);
    const key = token(32);
    return { deviceId, key, keyHash: sha256(key), name: cleanName(name), alias };
}

function newRecoveryCode() {
    // 20 chars from a 32-char alphabet = 100 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX
    return randomCode(20).match(/.{5}/g).join("-");
}

// ---------- registration ----------
module.exports = function registerAliasHandlers(io, socket, { emitRoomCount }) {
    const ip = clientIp(socket);
    const ack = (cb, payload) => { if (typeof cb === "function") cb(payload); };
    const limited = (name, max, windowMs) => !rateLimit(`${name}:${ip}`, max, windowMs);

    const ownerOf = () => socket.data.owner || null; // { alias, deviceId }

    function joinAsOwner(alias, deviceId) {
        socket.join(roomKey(alias));
        socket.join(ownersKey(alias));
        socket.data.owner = { alias, deviceId };
        const now = Date.now();
        stmts.touchDevice.run(now, deviceId);
        stmts.touchAlias.run(now, alias);
        emitRoomCount(roomKey(alias));
        // Replay knocks that arrived while no owner was online
        for (const [requestId, k] of knocks) {
            if (k.alias === alias) socket.emit("alias:knock", { requestId, name: k.name, at: k.at });
        }
    }

    function notifyDevicesChanged(alias) {
        io.to(ownersKey(alias)).emit("alias:devices-changed", { alias });
    }

    // Is this name free / valid?
    socket.on("alias:check", (data, cb) => {
        const alias = normalizeAlias(data && data.alias);
        const reason = validateAlias(alias);
        if (reason) return ack(cb, { ok: true, alias, valid: false, available: false, reason });
        const exists = !!stmts.getAlias.get(alias);
        ack(cb, { ok: true, alias, valid: true, available: !exists, exists, reason: exists ? "taken" : null });
    });

    // Claim a free name -> this device becomes the first owner
    socket.on("alias:claim", (data, cb) => {
        if (limited("claim", 10, 60 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const alias = normalizeAlias(data && data.alias);
        const reason = validateAlias(alias);
        if (reason) return ack(cb, { ok: false, error: reason });

        const device = newDevice(alias, data && data.deviceName);
        const recoveryCode = newRecoveryCode();
        try {
            claimAlias(alias, sha256(normalizeCode(recoveryCode)), device);
        } catch (e) {
            if (String(e.code).startsWith("SQLITE_CONSTRAINT")) return ack(cb, { ok: false, error: "taken" });
            console.error("alias:claim failed", e);
            return ack(cb, { ok: false, error: "server_error" });
        }
        ack(cb, { ok: true, alias, deviceId: device.deviceId, key: device.key, recoveryCode });
    });

    // Owner device enters its room
    socket.on("alias:enter", (data, cb) => {
        if (limited("enter", 60, 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const alias = normalizeAlias(data && data.alias);
        if (!stmts.getAlias.get(alias)) return ack(cb, { ok: false, error: "not_found" });
        const dev = stmts.getDevice.get(String((data && data.deviceId) || ""));
        if (!dev || dev.alias !== alias || !safeEqualHex(dev.key_hash, sha256((data && data.key) || ""))) {
            return ack(cb, { ok: false, error: "not_owner" });
        }
        joinAsOwner(alias, dev.device_id);
        ack(cb, { ok: true, alias, room: roomKey(alias), deviceId: dev.device_id });
    });

    // Guest asks to be let in
    socket.on("alias:knock", (data, cb) => {
        if (limited("knock", 20, 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const alias = normalizeAlias(data && data.alias);
        if (!stmts.getAlias.get(alias)) return ack(cb, { ok: false, error: "not_found" });
        if (socket.rooms.has(roomKey(alias))) return ack(cb, { ok: true, admitted: true, room: roomKey(alias) });

        // one pending knock per socket per alias
        for (const [id, k] of knocks) {
            if (k.socketId === socket.id && k.alias === alias) {
                knocks.delete(id);
                io.to(ownersKey(alias)).emit("alias:knock-resolved", { requestId: id });
            }
        }
        const requestId = "k_" + token(9);
        const knock = { alias, socketId: socket.id, name: cleanName(data && data.name), at: Date.now() };
        knocks.set(requestId, knock);
        io.to(ownersKey(alias)).emit("alias:knock", { requestId, name: knock.name, at: knock.at });

        const owners = io.sockets.adapter.rooms.get(ownersKey(alias));
        ack(cb, { ok: true, requestId, ownersOnline: owners ? owners.size : 0 });
    });

    socket.on("alias:cancel-knock", (data) => {
        const requestId = data && data.requestId;
        const k = knocks.get(requestId);
        if (k && k.socketId === socket.id) {
            knocks.delete(requestId);
            io.to(ownersKey(k.alias)).emit("alias:knock-resolved", { requestId });
        }
    });

    // Owner lets a guest in (or not)
    socket.on("alias:decide", (data, cb) => {
        const owner = ownerOf();
        const requestId = data && data.requestId;
        const k = knocks.get(requestId);
        if (!owner) return ack(cb, { ok: false, error: "not_owner" });
        if (!k || k.alias !== owner.alias) return ack(cb, { ok: false, error: "not_found" });
        knocks.delete(requestId);

        const allow = !!(data && data.allow);
        io.to(ownersKey(k.alias)).emit("alias:knock-resolved", { requestId, allow });

        const guest = io.sockets.sockets.get(k.socketId);
        if (!guest) return ack(cb, { ok: false, error: "guest_gone" });

        if (allow) {
            const pass = token(24);
            guestPasses.set(pass, { alias: k.alias, expiresAt: Date.now() + GUEST_PASS_TTL_MS });
            guest.join(roomKey(k.alias));
            guest.emit("alias:admitted", { alias: k.alias, room: roomKey(k.alias), guestPass: pass });
            emitRoomCount(roomKey(k.alias));
        } else {
            guest.emit("alias:denied", { alias: k.alias });
        }
        ack(cb, { ok: true });
    });

    // Admitted guest reconnecting (flaky network / refresh) without knocking again
    socket.on("alias:rejoin", (data, cb) => {
        const alias = normalizeAlias(data && data.alias);
        const pass = guestPasses.get(String((data && data.guestPass) || ""));
        if (!pass || pass.alias !== alias || pass.expiresAt < Date.now()) return ack(cb, { ok: false, error: "expired" });
        socket.join(roomKey(alias));
        emitRoomCount(roomKey(alias));
        ack(cb, { ok: true, alias, room: roomKey(alias) });
    });

    // Owner creates a pairing code (shown as QR) for adding another device
    socket.on("alias:pair-start", (data, cb) => {
        const owner = ownerOf();
        if (!owner) return ack(cb, { ok: false, error: "not_owner" });
        if (limited("pair-start", 20, 10 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const code = randomCode(10);
        const expiresAt = Date.now() + PAIR_TTL_MS;
        pairCodes.set(code, { alias: owner.alias, expiresAt, byDeviceId: owner.deviceId });
        ack(cb, { ok: true, code, expiresAt });
    });

    // New device redeems a pairing code -> becomes an owner
    socket.on("alias:pair-redeem", (data, cb) => {
        if (limited("pair-redeem", 10, 10 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const alias = normalizeAlias(data && data.alias);
        const code = normalizeCode(data && data.code);
        const entry = pairCodes.get(code);
        if (!entry || entry.alias !== alias || entry.expiresAt < Date.now()) {
            return ack(cb, { ok: false, error: "invalid_code" });
        }
        pairCodes.delete(code); // single use
        const device = newDevice(alias, data && data.deviceName);
        const now = Date.now();
        stmts.insertDevice.run(device.deviceId, alias, device.keyHash, device.name, now, now);
        notifyDevicesChanged(alias);
        ack(cb, { ok: true, alias, deviceId: device.deviceId, key: device.key });
    });

    // Lost all devices? Recovery code makes this device an owner again
    socket.on("alias:recover", (data, cb) => {
        if (limited("recover", 5, 15 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const alias = normalizeAlias(data && data.alias);
        const row = stmts.getAlias.get(alias);
        const given = sha256(normalizeCode(data && data.recoveryCode));
        if (!row || !row.recovery_hash || !safeEqualHex(row.recovery_hash, given)) {
            return ack(cb, { ok: false, error: "invalid_code" });
        }
        const device = newDevice(alias, data && data.deviceName);
        const now = Date.now();
        stmts.insertDevice.run(device.deviceId, alias, device.keyHash, device.name, now, now);
        notifyDevicesChanged(alias);
        ack(cb, { ok: true, alias, deviceId: device.deviceId, key: device.key });
    });

    socket.on("alias:recovery-rotate", (data, cb) => {
        const owner = ownerOf();
        if (!owner) return ack(cb, { ok: false, error: "not_owner" });
        const recoveryCode = newRecoveryCode();
        stmts.setRecovery.run(sha256(normalizeCode(recoveryCode)), owner.alias);
        ack(cb, { ok: true, recoveryCode });
    });

    socket.on("alias:devices", (data, cb) => {
        const owner = ownerOf();
        if (!owner) return ack(cb, { ok: false, error: "not_owner" });
        const online = new Set();
        const members = io.sockets.adapter.rooms.get(ownersKey(owner.alias)) || new Set();
        for (const id of members) {
            const s = io.sockets.sockets.get(id);
            if (s && s.data.owner) online.add(s.data.owner.deviceId);
        }
        const devices = stmts.listDevices.all(owner.alias).map((d) => ({
            deviceId: d.device_id,
            name: d.name,
            createdAt: d.created_at,
            lastSeenAt: d.last_seen_at,
            online: online.has(d.device_id),
            current: d.device_id === owner.deviceId,
        }));
        ack(cb, { ok: true, devices });
    });

    socket.on("alias:device-remove", (data, cb) => {
        const owner = ownerOf();
        if (!owner) return ack(cb, { ok: false, error: "not_owner" });
        const deviceId = String((data && data.deviceId) || "");
        if (stmts.countDevices.get(owner.alias).n <= 1) return ack(cb, { ok: false, error: "last_device" });
        const res = stmts.deleteDevice.run(deviceId, owner.alias);
        if (res.changes === 0) return ack(cb, { ok: false, error: "not_found" });

        // Kick that device's live sockets out of owner state
        for (const [, s] of io.sockets.sockets) {
            if (s.data.owner && s.data.owner.deviceId === deviceId) {
                s.leave(ownersKey(owner.alias));
                s.leave(roomKey(owner.alias));
                s.data.owner = null;
                s.emit("alias:removed", { alias: owner.alias });
            }
        }
        emitRoomCount(roomKey(owner.alias));
        notifyDevicesChanged(owner.alias);
        ack(cb, { ok: true });
    });

    socket.on("disconnect", () => {
        for (const [id, k] of knocks) {
            if (k.socketId === socket.id) {
                knocks.delete(id);
                io.to(ownersKey(k.alias)).emit("alias:knock-resolved", { requestId: id });
            }
        }
    });
};

module.exports.normalizeAlias = normalizeAlias;
module.exports.aliasExists = (alias) => !!stmts.getAlias.get(normalizeAlias(alias));
