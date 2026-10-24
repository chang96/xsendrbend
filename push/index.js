// Push notifications for an alias room's owner devices: "a file is coming", "someone is knocking",
// "your app is ready". Only the device's push address is stored (no messages, no files).
const { db, DATA_DIR } = require("../db");
const { loadVapid, sendPush } = require("./webpush");

db.exec(`
    CREATE TABLE IF NOT EXISTS push_subs (
        endpoint    TEXT PRIMARY KEY,
        alias       TEXT NOT NULL REFERENCES aliases(alias) ON DELETE CASCADE,
        device_id   TEXT NOT NULL,
        p256dh      TEXT NOT NULL,
        auth        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_alias ON push_subs(alias);
`);
const q = {
    upsert: db.prepare(`INSERT INTO push_subs (endpoint, alias, device_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET alias = excluded.alias, device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    remove: db.prepare("DELETE FROM push_subs WHERE endpoint = ?"),
    removeDevice: db.prepare("DELETE FROM push_subs WHERE device_id = ?"),
    forAlias: db.prepare("SELECT * FROM push_subs WHERE alias = ?"),
    validDevice: db.prepare("SELECT device_id FROM owner_devices WHERE alias = ?"),
};

let ready = false;
function vapidKey() {
    try { const v = loadVapid(DATA_DIR); ready = true; return v.publicKey; } catch (e) { console.error("push: vapid", e.message); return null; }
}
vapidKey();

const roomKey = (a) => "@" + a, ownersKey = (a) => "owners:@" + a;
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

// Which owner devices of this alias have a socket in the room right now?
function onlineDevices(io, alias) {
    const ids = io.sockets.adapter.rooms.get(ownersKey(alias)) || new Set();
    const out = new Set();
    for (const id of ids) { const s = io.sockets.sockets.get(id); if (s && s.data.owner) out.add(s.data.owner.deviceId); }
    return out;
}

// Send to the alias's owner devices. Default: only devices that are NOT in the room right now.
async function notifyOwners(io, alias, payload, { exceptDeviceId = null, includeOnline = false, ttl, urgency } = {}) {
    if (!ready) return 0;
    const online = includeOnline ? new Set() : onlineDevices(io, alias);
    const valid = new Set(q.validDevice.all(alias).map((r) => r.device_id));
    const subs = q.forAlias.all(alias).filter((s) => valid.has(s.device_id) && s.device_id !== exceptDeviceId && !online.has(s.device_id));
    const body = { alias, url: payload.url || `/${alias}`, ...payload, title: clean(payload.title, 80), body: clean(payload.body, 240) };
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
        const r = await sendPush(s, body, { ttl, urgency });
        if (r.status === 404 || r.status === 410) q.remove.run(s.endpoint);
        else if (r.status >= 200 && r.status < 300) sent += 1;
        else console.warn("push: failed", r.status, r.error || "");
    }));
    return sent;
}

const buckets = new Map();
function allow(key, max, ms) {
    const now = Date.now(), b = buckets.get(key);
    if (!b || b.resetAt < now) { buckets.set(key, { n: 1, resetAt: now + ms }); return true; }
    return ++b.n <= max;
}

function registerPushHandlers(io, socket) {
    const ack = (cb, x) => { if (typeof cb === "function") cb(x); };
    const owner = () => (socket.data.owner && socket.rooms.has(roomKey(socket.data.owner.alias)) ? socket.data.owner : null);

    socket.on("push:key", (d, cb) => { const k = vapidKey(); ack(cb, k ? { ok: true, key: k } : { ok: false, error: "unavailable" }); });

    socket.on("push:subscribe", (d, cb) => {
        const o = owner();
        if (!o) return ack(cb, { ok: false, error: "not_owner" });
        const sub = d && d.subscription;
        const ep = sub && typeof sub.endpoint === "string" ? sub.endpoint : "";
        if (!/^https:\/\/[^\s]{10,1000}$/.test(ep) || !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return ack(cb, { ok: false, error: "bad_subscription" });
        q.upsert.run(ep, o.alias, o.deviceId, sub.keys.p256dh.slice(0, 200), sub.keys.auth.slice(0, 100), Date.now());
        ack(cb, { ok: true });
    });

    socket.on("push:unsubscribe", (d, cb) => {
        if (d && typeof d.endpoint === "string") q.remove.run(d.endpoint);
        ack(cb, { ok: true });
    });

    // "Is this working?" -> a notification on this very device
    socket.on("push:test", async (d, cb) => {
        const o = owner();
        if (!o) return ack(cb, { ok: false, error: "not_owner" });
        if (!allow(`test:${o.deviceId}`, 5, 10 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const subs = q.forAlias.all(o.alias).filter((s) => s.device_id === o.deviceId);
        let sent = 0;
        for (const s of subs) { const r = await sendPush(s, { alias: o.alias, title: "faax notifications are on", body: "You'll hear from your room here.", url: `/${o.alias}`, tag: "test" }); if (r.status >= 200 && r.status < 300) sent++; else if (r.status === 404 || r.status === 410) q.remove.run(s.endpoint); }
        ack(cb, { ok: true, sent });
    });

    // Sent something but the other device isn't here: tap my other devices on the shoulder
    socket.on("push:notify", async (d, cb) => {
        const o = owner();
        if (!o) return ack(cb, { ok: false, error: "not_owner" });
        if (!allow(`notify:${o.deviceId}`, 30, 10 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const from = clean(socket.data.name, 40) || "Your other device";
        const kind = d && d.kind;
        let payload;
        if (kind === "file") {
            const n = Math.max(1, Math.min(99, Number(d.count) || 1));
            payload = { title: `${from} is sending you ${n > 1 ? `${n} files` : clean(d.name, 80) || "a file"}`, body: `${d.size ? clean(d.size, 20) + " · " : ""}Tap to receive. Keep faax open on ${from} until it arrives.`, tag: "file", url: `/${o.alias}?view=chat` };
        } else if (kind === "text") {
            payload = { title: from, body: clean(d.text, 240), tag: "text-" + Date.now(), url: `/${o.alias}?view=chat` };
        } else return ack(cb, { ok: false, error: "bad_kind" });
        const sent = await notifyOwners(io, o.alias, payload, { exceptDeviceId: o.deviceId });
        ack(cb, { ok: true, sent });
    });
}

module.exports = { registerPushHandlers, notifyOwners, removeDeviceSubs: (id) => q.removeDevice.run(id) };
