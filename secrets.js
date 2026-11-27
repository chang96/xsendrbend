// Secrets (passwords, codes, private notes) from an owner device to devices the owner picks:
// their own devices, or people who are in the room with them right now.
// End-to-end encrypted in the browser: each open tab makes a throwaway ECDH key and tells us
// only the public half. Here we see ciphertext, relay it once, and keep nothing.
const MAX_ITEM = 24 * 1024;
const buckets = new Map();
function allow(key, max, ms) {
    const now = Date.now(), b = buckets.get(key);
    if (!b || b.resetAt < now) { buckets.set(key, { n: 1, resetAt: now + ms }); return true; }
    return ++b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k); }, 60000).unref();

const isB64 = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=_-]+$/.test(s);

module.exports = function registerSecretHandlers(io, socket) {
    const ack = (cb, x) => { if (typeof cb === "function") cb(x); };
    // who can get a secret from me right now: my other devices + anyone sharing a room with me
    const reachable = () => {
        const o = socket.data.owner;
        if (!o) return [];
        const out = new Map();
        const rooms = [...socket.rooms].filter((r) => r !== socket.id);
        for (const room of rooms) {
            for (const id of io.sockets.adapter.rooms.get(room) || []) {
                if (id === socket.id || out.has(id)) continue;
                const s = io.sockets.sockets.get(id);
                if (s && s.data.secretPub) out.set(id, { s, mine: !!(s.data.owner && s.data.owner.alias === o.alias) });
            }
        }
        return [...out.values()];
    };

    socket.on("secret:hello", (d) => {
        if (d && isB64(d.pub, 200)) socket.data.secretPub = d.pub;
    });

    socket.on("secret:peers", (d, cb) => {
        if (!socket.data.owner) return ack(cb, { ok: false, error: "owners_only" });
        ack(cb, { ok: true, peers: reachable().map(({ s, mine }) => ({ id: s.id, name: s.data.name || "A device", mine, pub: s.data.secretPub })) });
    });

    socket.on("secret:send", (d, cb) => {
        if (!socket.data.owner) return ack(cb, { ok: false, error: "owners_only" });
        if (!allow(`secret:${socket.id}`, 30, 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        const items = Array.isArray(d && d.items) ? d.items.slice(0, 20) : [];
        if (!items.length || !isB64(d.pub, 200)) return ack(cb, { ok: false, error: "bad_request" });
        const allowed = new Map(reachable().map(({ s }) => [s.id, s]));
        const from = { name: socket.data.name || "A device" };
        let sent = 0;
        for (const it of items) {
            const t = it && allowed.get(String(it.to));
            if (!t || !isB64(it.iv, 40) || !isB64(it.ct, MAX_ITEM)) continue;
            t.emit("secret:incoming", { iv: it.iv, ct: it.ct, pub: d.pub, from, at: Date.now() });
            sent += 1;
        }
        ack(cb, { ok: true, sent });
    });
};
