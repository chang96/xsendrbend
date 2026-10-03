// Socket handlers for the owner-only task manager.
// - tasks:organize  -> run the LLM organizer on new entries, return operations to apply
// - tasks:hello / tasks:sync -> relay the task list between the owner's own devices
// The server never stores tasks; it only relays between owner devices and calls the LLM.
const { organize, isConfigured } = require("./organizer");

const ownersKey = (alias) => "owners:@" + alias;
const buckets = new Map();

function allow(key, max, windowMs) {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    b.count += 1;
    return b.count <= max;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}, 60 * 1000).unref();

module.exports = function registerTaskHandlers(io, socket) {
    const ack = (cb, payload) => { if (typeof cb === "function") cb(payload); };
    const owner = () => socket.data.owner || null;

    socket.on("tasks:status", (data, cb) => {
        if (!owner()) return ack(cb, { ok: false, error: "not_owner" });
        ack(cb, { ok: true, organizer: isConfigured() });
    });

    socket.on("tasks:organize", async (data, cb) => {
        const o = owner();
        if (!o) return ack(cb, { ok: false, error: "not_owner" });
        if (!allow(`organize:${o.alias}`, 30, 60 * 60 * 1000)) return ack(cb, { ok: false, error: "rate_limited" });
        try {
            const ops = await organize(data);
            ack(cb, { ok: true, ops });
        } catch (e) {
            if (e.code === "not_configured") return ack(cb, { ok: false, error: "not_configured" });
            console.error("tasks:organize failed:", e.message);
            ack(cb, { ok: false, error: "ai_error" });
        }
    });

    // A device just opened the room: send its list to the other owner devices (they merge and reply)
    socket.on("tasks:hello", (data) => {
        const o = owner();
        if (!o || !data || typeof data.state !== "object") return;
        socket.to(ownersKey(o.alias)).emit("tasks:hello", { state: data.state });
    });

    // Any change: pass the full list to the other owner devices
    socket.on("tasks:sync", (data) => {
        const o = owner();
        if (!o || !data || typeof data.state !== "object") return;
        socket.to(ownersKey(o.alias)).emit("tasks:sync", { state: data.state });
    });
};
