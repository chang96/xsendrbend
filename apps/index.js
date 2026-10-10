// Generated-app plumbing for alias rooms. Nothing is stored here: the server only
//  - relays app messages, stamping WHO sent them (role comes from faax keys, never from the app)
//  - enforces "owners only" delivery, so secrets never reach member devices
//  - passes app bundles and their data between the owner's own devices (sync) and to guests (share)
//  - calls the AI to plan / build / improve apps (owners only, rate limited)
const { roomKey, ownersKey } = require("../aliases");
const { plan, build, isConfigured } = require("./generator");

const MAX_MSG_BYTES = 64 * 1024;          // one app message
const MAX_BUNDLE_BYTES = 600 * 1024;      // one shared app (html + meta)
const MAX_RECORD_BYTES = 3 * 1024 * 1024; // one synced app record (incl. up to 5 versions)
const MSGS_PER_SECOND = 40;

const buckets = new Map();
function allow(key, max, windowMs) {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return true; }
    b.count += 1;
    return b.count <= max;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}, 60 * 1000).unref();

function bytes(x) {
    try { return Buffer.byteLength(JSON.stringify(x) || ""); } catch (e) { return Infinity; }
}
const str = (s, max) => (typeof s === "string" ? s.slice(0, max) : "");

module.exports = function registerAppHandlers(io, socket) {
    const ack = (cb, payload) => { if (typeof cb === "function") cb(payload); };

    // Which alias room is this socket in, and as what?
    function seat() {
        const o = socket.data.owner;
        if (o && socket.rooms.has(roomKey(o.alias))) return { alias: o.alias, role: "owner" };
        const g = socket.data.guestOf;
        if (g && socket.rooms.has(roomKey(g))) return { alias: g, role: "member" };
        return null;
    }
    const who = (s, sock = socket) => ({ id: sock.id, role: s.role, name: sock.data.name || (s.role === "owner" ? "Owner" : "Guest") });
    const isOwner = (s) => s && s.role === "owner";

    function members(alias) {
        const ids = io.sockets.adapter.rooms.get(roomKey(alias)) || new Set();
        const list = [];
        for (const id of ids) {
            const s = io.sockets.sockets.get(id);
            if (!s) continue;
            const owner = s.data.owner && s.data.owner.alias === alias;
            list.push({ id, role: owner ? "owner" : "member", name: s.data.name || (owner ? "Owner" : "Guest") });
        }
        return list;
    }

    socket.on("room:members", (data, cb) => {
        const s = seat();
        if (!s) return ack(cb, { ok: false, error: "not_in_room" });
        ack(cb, { ok: true, me: who(s), members: members(s.alias) });
    });

    // ---- live messages from inside an app ----
    socket.on("app:msg", (data) => {
        const s = seat();
        if (!s || !data || typeof data.appId !== "string") return;
        if (!allow(`msg:${socket.id}`, MSGS_PER_SECOND, 1000)) return;
        if (bytes(data.data) > MAX_MSG_BYTES) return;
        const base = { appId: str(data.appId, 64), data: data.data, from: who(s) };

        if (data.to === "owners") {
            socket.to(ownersKey(s.alias)).emit("app:msg", { ...base, channel: "owners" });
        } else if (data.to === "room" || data.to === undefined) {
            socket.to(roomKey(s.alias)).emit("app:msg", { ...base, channel: "room" });
        } else if (typeof data.to === "string" && isOwner(s)) {
            // private message from an owner device to one person in the room
            const target = io.sockets.sockets.get(data.to);
            if (target && target.rooms.has(roomKey(s.alias))) target.emit("app:msg", { ...base, channel: "direct" });
        }
    });

    // ---- sharing an app with the room (or with one guest who just arrived) ----
    socket.on("app:share", (data, cb) => {
        const s = seat();
        if (!isOwner(s)) return ack(cb, { ok: false, error: "not_owner" });
        const app = data && data.app;
        if (!app || typeof app.id !== "string" || typeof app.html !== "string") return ack(cb, { ok: false, error: "bad_app" });
        if (bytes(app) > MAX_BUNDLE_BYTES) return ack(cb, { ok: false, error: "too_large" });
        const payload = { app, from: who(s) };
        if (typeof data.to === "string") {
            const target = io.sockets.sockets.get(data.to);
            if (target && target.rooms.has(roomKey(s.alias))) target.emit("app:shared", payload);
        } else {
            socket.to(roomKey(s.alias)).emit("app:shared", payload);
        }
        ack(cb, { ok: true });
    });

    socket.on("app:unshare", (data) => {
        const s = seat();
        if (!isOwner(s) || !data || typeof data.appId !== "string") return;
        socket.to(roomKey(s.alias)).emit("app:unshared", { appId: str(data.appId, 64) });
    });

    // A guest arrived: ask the owner devices to send whatever is shared
    socket.on("apps:want", () => {
        const s = seat();
        if (!s || s.role !== "member") return;
        if (!allow(`want:${socket.id}`, 10, 60 * 1000)) return;
        socket.to(ownersKey(s.alias)).emit("apps:want", { from: socket.id });
    });

    // ---- keeping the owner's own devices in sync (apps + their data) ----
    socket.on("apps:hello", (data) => {
        const s = seat();
        if (!isOwner(s) || !data || typeof data.manifest !== "object" || bytes(data) > MAX_MSG_BYTES) return;
        socket.to(ownersKey(s.alias)).emit("apps:hello", { manifest: data.manifest, reply: !!data.reply, from: socket.id });
    });

    socket.on("apps:put", (data) => {
        const s = seat();
        if (!isOwner(s) || !data || !data.record || typeof data.record.id !== "string") return;
        if (bytes(data.record) > MAX_RECORD_BYTES) return;
        if (typeof data.to === "string") {
            const target = io.sockets.sockets.get(data.to);
            if (target && target.data.owner && target.data.owner.alias === s.alias) target.emit("apps:put", { record: data.record });
        } else {
            socket.to(ownersKey(s.alias)).emit("apps:put", { record: data.record });
        }
    });

    socket.on("apps:data", (data) => {
        const s = seat();
        if (!isOwner(s) || !data || typeof data.appId !== "string" || bytes(data) > MAX_MSG_BYTES * 8) return;
        if (!allow(`data:${socket.id}`, MSGS_PER_SECOND, 1000)) return;
        socket.to(ownersKey(s.alias)).emit("apps:data", data);
    });

    // ---- AI: plan questions, build, improve, fix (owners only) ----
    socket.on("apps:status", (data, cb) => {
        if (!isOwner(seat())) return ack(cb, { ok: false, error: "not_owner" });
        ack(cb, { ok: true, generator: isConfigured() });
    });

    socket.on("apps:plan", async (data, cb) => {
        const s = seat();
        if (!isOwner(s)) return ack(cb, { ok: false, error: "not_owner" });
        if (!allow(`plan:${s.alias}`, 40, 60 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        try {
            ack(cb, { ok: true, plan: await plan(data || {}) });
        } catch (e) {
            if (e.code === "not_configured") return ack(cb, { ok: false, error: "not_configured" });
            console.error("apps:plan failed:", e.message);
            ack(cb, { ok: false, error: "ai_error" });
        }
    });

    socket.on("apps:build", async (data, cb) => {
        const s = seat();
        if (!isOwner(s)) return ack(cb, { ok: false, error: "not_owner" });
        if (!allow(`build:${s.alias}`, 20, 60 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        try {
            ack(cb, { ok: true, app: await build(data || {}) });
        } catch (e) {
            if (e.code === "not_configured") return ack(cb, { ok: false, error: "not_configured" });
            if (e.code === "bad_output") return ack(cb, { ok: false, error: "bad_output" });
            console.error("apps:build failed:", e.message);
            ack(cb, { ok: false, error: "ai_error" });
        }
    });
};
