// Minimal Web Push sender, no dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).
// The push service (Google / Apple / Mozilla) only ever sees ciphertext; the device decrypts it.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// ---- VAPID keys: from env, else generated once and kept in the data volume
let vapid = null;
function loadVapid(dataDir) {
    if (vapid) return vapid;
    let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
    const file = path.join(dataDir, "vapid.json");
    if (!pub || !priv) {
        try { ({ publicKey: pub, privateKey: priv } = JSON.parse(fs.readFileSync(file, "utf8"))); } catch (e) {}
    }
    if (!pub || !priv) {
        const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const jwk = publicKey.export({ format: "jwk" });
        pub = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
        priv = privateKey.export({ format: "jwk" }).d;
        try { fs.writeFileSync(file, JSON.stringify({ publicKey: pub, privateKey: priv }), { mode: 0o600 }); } catch (e) {}
    }
    const raw = fromB64u(pub);
    const key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d: priv }, format: "jwk" });
    vapid = { publicKey: pub, key, subject: process.env.VAPID_SUBJECT || "mailto:hello@faax.me" };
    return vapid;
}

function vapidHeader(endpoint) {
    const { origin } = new URL(endpoint);
    const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const body = b64u(JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject }));
    const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: vapid.key, dsaEncoding: "ieee-p1363" });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// RFC 8291 / 8188: one record, padded with the 0x02 delimiter
function encrypt(p256dh, auth, plaintext) {
    const uaPublic = fromB64u(p256dh);
    const authSecret = fromB64u(auth);
    const ecdh = crypto.createECDH("prime256v1");
    const asPublic = ecdh.generateKeys();
    const shared = ecdh.computeSecret(uaPublic);
    const prkKey = hmac(authSecret, shared);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
    const salt = crypto.randomBytes(16);
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
    const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
    const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// -> { status } ; 404/410 mean the subscription is gone for good
async function sendPush(sub, payload, { ttl = 3600, urgency = "high", topic } = {}) {
    if (!vapid) throw new Error("vapid not loaded");
    const data = encrypt(sub.p256dh, sub.auth, JSON.stringify(payload));
    const headers = {
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
        TTL: String(ttl), Urgency: urgency, Authorization: vapidHeader(sub.endpoint),
    };
    if (topic) headers.Topic = topic;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
        const res = await fetch(sub.endpoint, { method: "POST", headers, body: data, signal: ctrl.signal });
        return { status: res.status };
    } catch (e) {
        return { status: 0, error: e.message };
    } finally { clearTimeout(t); }
}

module.exports = { loadVapid, sendPush, encrypt, b64u, fromB64u };
