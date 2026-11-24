// Sticky notes live in each browser. Nothing is stored here: when the owner of a note taps
// "Sync" and picks devices, the note is relayed to exactly those devices (sockets that share a
// room with the sender), once.
const MAX_NOTE_BYTES = 64 * 1024;
const buckets = new Map();
function allow(key, max, ms) {
    const now = Date.now(), b = buckets.get(key);
    if (!b || b.resetAt < now) { buckets.set(key, { n: 1, resetAt: now + ms }); return true; }
    return ++b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k); }, 60000).unref();

const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
// rooms this socket really talks in (not its own id, not an owners: side channel)
const roomsOf = (s) => [...s.rooms].filter((r) => r !== s.id && !r.startsWith("owners:"));

module.exports = function registerStickyHandlers(io, socket) {
    const ack = (cb, x) => { if (typeof cb === "function") cb(x); };

    // A friendly label for devices in plain rooms (alias rooms already name their devices)
    socket.on("sticky:name", (d) => {
        if (!socket.data.name) socket.data.name = cleanName(d && d.name) || "A device";
    });

    // Who could receive a note from me right now?
    socket.on("sticky:peers", (d, cb) => {
        const seen = new Map();
        for (const room of roomsOf(socket)) {
            for (const id of io.sockets.adapter.rooms.get(room) || []) {
                if (id === socket.id || seen.has(id)) continue;
                const s = io.sockets.sockets.get(id);
                if (!s) continue;
                const mine = !!(socket.data.owner && s.data.owner && s.data.owner.alias === socket.data.owner.alias);
                seen.set(id, { id, name: s.data.name || "A device", mine });
            }
        }
        ack(cb, { ok: true, peers: [...seen.values()] });
    });

    socket.on("sticky:send", (d, cb) => {
        if (!allow(`sticky:${socket.id}`, 60, 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const note = d && d.note;
        const to = Array.isArray(d && d.to) ? d.to.slice(0, 20) : [];
        if (!note || typeof note.id !== "string" || !to.length) return ack(cb, { ok: false, error: "bad_request" });
        let size = Infinity;
        try { size = Buffer.byteLength(JSON.stringify(note)); } catch (e) {}
        if (size > MAX_NOTE_BYTES) return ack(cb, { ok: false, error: "too_large" });
        const mine = new Set(roomsOf(socket));
        const from = { id: socket.id, name: socket.data.name || "A device" };
        let sent = 0;
        for (const id of to) {
            const t = io.sockets.sockets.get(String(id));
            if (!t || !roomsOf(t).some((r) => mine.has(r))) continue; // only people in a room with me
            t.emit("sticky:incoming", { note, from });
            sent += 1;
        }
        ack(cb, { ok: true, sent });
    });
};
