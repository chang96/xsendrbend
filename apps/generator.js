// Turns a description into a small app that runs inside faax.
// Provider: APPS_AI = claude (default) | openai | gemini; model: APPS_AI_MODEL.
const PROVIDER = (process.env.APPS_AI || "claude").toLowerCase();
const DEFAULT_MODELS = { claude: "claude-sonnet-5-5" };
const MODEL = process.env.APPS_AI_MODEL || DEFAULT_MODELS[PROVIDER];
const TIMEOUT_MS = 240000;
const MAX_HTML = 250 * 1024;
const MAX_SECRETS = 100 * 1024;

const WHO = {
    me: "JUST ME: one person uses it, possibly on several of their own devices. No multiplayer needed; the owner view holds settings and data tools.",
    room: "ME + ROOM: the owner and whoever is in the room use it together, live (games, shared lists, votes). The owner's device is the host.",
    class: "A CLASS: the owner is a teacher and members are students. The owner view is the teacher console: set up, run rounds, see every student's progress and results. Students never see answers or each other's private results unless the teacher reveals them.",
};

const SDK = `THE RUNTIME (read carefully, everything else is blocked)
- Your HTML runs in a sandboxed iframe with no origin. There is NO network: no external scripts, fonts, images, fetch, XHR or WebSocket. Use inline CSS/JS, the system font stack, inline SVG or CSS for graphics.
- alert/confirm/prompt, localStorage, sessionStorage, indexedDB and cookies do NOT work. Use faax.store for saving and your own in-page UI for dialogs.
- A global \`faax\` object is already defined before your code runs:

  const ctx = await faax.ready();
    // ctx.me      = { id, role: "owner" | "member", name, isHost }
    // ctx.members = [{ id, role, name, isHost }]   everyone in the room right now, including me
    // ctx.who     = "me" | "room" | "class"
    // ctx.secrets = the object you returned as secrets_json (answer keys, solutions, hidden words),
    //               delivered ONLY to owner devices; null on member devices
  faax.onMembers((members, me) => { ... })     // someone joined or left, or the host changed
  faax.send(data)                // to everyone else in the room (owners and members)
  faax.sendToOwners(data)        // ONLY owner devices receive it (enforced by the server)
  faax.sendTo(memberId, data)    // owners only: a private message to one person
  faax.onMessage((data, from) => { ... })      // from = { id, role, name }, stamped by the server: trust it
  await faax.store.get(key)      // JSON value or undefined; saved on this person's device
  await faax.store.set(key, value)             // owners: synced to all of the owner's devices
  await faax.store.remove(key);  await faax.store.keys()
  faax.notify("text")            // small toast outside the app (optional)

- data must be JSON-serialisable and small (under 60 KB per message).

HOW TO STRUCTURE IT
- Start everything after \`const ctx = await faax.ready()\` inside an async init function.
- Exactly one device is the HOST: the owner device with me.isHost === true. The host keeps the true state in faax.store, applies the rules, and broadcasts the public state with faax.send. Everyone renders from state.
- Members never change shared state directly: they send intents (e.g. {type:"move", cell:4}) with faax.sendToOwners; the host validates them, updates state, saves it and broadcasts.
- Other owner devices that are not the host just render the broadcast state (they are the same person on another device).
- When onMembers fires, the host re-sends the current public state so late joiners catch up. If the host changes, the new host loads state from faax.store and carries on.
- With nobody else in the room, show a friendly waiting state instead of breaking.
- In 2-player games the owner plays too: the host device is both referee and a player.

THE OWNER VIEW (always required)
- Every app has an area only owners see (when ctx.me.role === "owner"), e.g. an "Owner" tab or panel: results and progress of others, settings, round controls, reset, the answers.
- Owner-only data (answers, everyone's scores, private submissions) is kept on owner devices and NEVER sent to members. Send members only what they are allowed to see. Members send their own answers with faax.sendToOwners.
- Members simply do not see the owner area.
- The HTML itself is copied to members' devices when the owner shares the app, so NEVER write answers, solutions, hidden words or any other secret into the HTML. Put them in secrets_json and read them from ctx.secrets on the host. The host checks members' answers and sends back only what they may see (right/wrong, their own score).

LOOK AND FEEL
- Mobile first: works from 320 px to 1200 px wide, fills the frame height (html, body { height: 100% }), no horizontal scrolling, touch targets at least 44 px, readable contrast.
- Follow the style the person asked for; otherwise make something clean and modern with its own personality. Respect prefers-reduced-motion.
- Keep the whole file under about 60 KB. Robust code: guard against missing data, never throw on an unknown message.`;

const PLAN_PROMPT = `You help someone describe a small app that will be built for them inside faax, a private room shared between their devices and the people they invite.

${SDK}

Read their request and draft a plan. Then find the few things that are genuinely ambiguous and would change what gets built (rules, who controls what, what is remembered, scoring, what the owner sees). Ask about those only.
- summary: 2 to 3 plain sentences describing what you will build.
- questions: 0 to 6 multiple-choice questions, each with 2 to 4 short options and the index of the option you recommend. No questions about colours or wording unless the person seems to care. If nothing is ambiguous, return no questions.
Return the result only through the plan_app tool.`;

const BUILD_PROMPT = `You build small apps that run inside faax, a private room shared between a person's devices and the people they invite.

${SDK}

Write ONE complete HTML document (<!doctype html> ... </html>) for the request. Then describe it.
- name: short app name (max 24 characters).
- glyph: 1 or 2 characters for its icon (letters, digits or a simple symbol, no emoji).
- bg, fg: icon background and foreground colours as #rrggbb, matching the app's look.
- summary: one sentence about what it does.
- spec: the app's specification in short markdown (features, rules, roles, what the owner view shows, what faax.store keys hold). It is used for future edits.
- note: what this version changed, max 60 characters ("First version" for a new app).
- secrets_json: a JSON object as a string with everything members must never see (e.g. {"answers":[2,0,3]}), or "{}" if there is nothing secret. Max 100 KB.
When you are given an existing app and a change request, return the WHOLE updated HTML and the whole updated secrets_json, keep everything that was not asked to change, and keep faax.store data compatible (or migrate old keys in code).
When the change request reports an error, find the cause and fix it.
Return the result only through the save_app tool.`;

const PLAN_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
        summary: { type: "string" },
        questions: {
            type: "array",
            items: {
                type: "object", additionalProperties: false,
                properties: {
                    question: { type: "string" },
                    options: { type: "array", items: { type: "string" } },
                    recommended: { type: "integer" },
                },
                required: ["question", "options", "recommended"],
            },
        },
    },
    required: ["summary", "questions"],
};

const APP_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
        name: { type: "string" }, glyph: { type: "string" }, bg: { type: "string" }, fg: { type: "string" },
        summary: { type: "string" }, spec: { type: "string" }, note: { type: "string" }, html: { type: "string" },
        secrets_json: { type: "string" },
    },
    required: ["name", "glyph", "bg", "fg", "summary", "spec", "note", "html", "secrets_json"],
};

function isConfigured() {
    if (PROVIDER === "claude") return !!process.env.ANTHROPIC_API_KEY;
    if (PROVIDER === "openai") return !!process.env.OPENAI_API_KEY && !!MODEL;
    if (PROVIDER === "gemini") return !!process.env.GEMINI_API_KEY && !!MODEL;
    return false;
}

async function postJson(url, headers, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`${PROVIDER} HTTP ${res.status}: ${text.slice(0, 300)}`);
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
    }
}

// One structured call: system + user text in, an object matching `schema` out
async function structured({ system, user, tool, description, schema, maxTokens }) {
    if (PROVIDER === "claude") {
        const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
        const data = await postJson(`${base}/v1/messages`, { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, {
            model: MODEL, max_tokens: maxTokens, system,
            tools: [{ name: tool, description, input_schema: schema }],
            tool_choice: { type: "tool", name: tool },
            messages: [{ role: "user", content: user }],
        });
        const block = (data.content || []).find((b) => b.type === "tool_use");
        if (!block) throw new Error("claude: no tool_use block");
        return block.input;
    }
    const sys = system.replace(/through the \w+ tool/, "as JSON matching the schema");
    if (PROVIDER === "openai") {
        const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
        const data = await postJson(`${base}/v1/chat/completions`, { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, {
            model: MODEL, max_completion_tokens: maxTokens,
            messages: [{ role: "system", content: sys }, { role: "user", content: user }],
            response_format: { type: "json_schema", json_schema: { name: tool, strict: true, schema } },
        });
        return JSON.parse(data.choices[0].message.content);
    }
    if (PROVIDER === "gemini") {
        const toGemini = (s) => {
            const out = { type: String(s.type).toUpperCase() };
            if (s.items) out.items = toGemini(s.items);
            if (s.properties) { out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGemini(v)])); out.required = s.required; }
            return out;
        };
        const base = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
        const data = await postJson(`${base}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, { "x-goog-api-key": process.env.GEMINI_API_KEY }, {
            systemInstruction: { parts: [{ text: sys }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json", responseSchema: toGemini(schema) },
        });
        return JSON.parse(data.candidates[0].content.parts[0].text);
    }
    throw new Error("unknown provider");
}

// ---------------------------------------------------------------- inputs
const clip = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, max);
function whoOf(w) { return WHO[w] ? w : "room"; }
function describeAnswers(answers) {
    const list = Array.isArray(answers) ? answers.slice(0, 8) : [];
    return list.map((a) => `- ${clip(a && a.question, 200)} -> ${clip(a && a.answer, 200)}`).join("\n");
}
function baseBlock(base) {
    if (!base || typeof base.html !== "string") return "";
    const secrets = base.secrets && typeof base.secrets === "object" ? JSON.stringify(base.secrets).slice(0, MAX_SECRETS) : "";
    return `\n\nEXISTING APP "${clip(base.name, 40)}"\nSpec:\n${clip(base.spec, 4000)}${secrets ? `\n\nCurrent secrets_json:\n${secrets}` : ""}\n\nCurrent HTML:\n${clip(base.html, MAX_HTML)}`;
}

function notConfigured() {
    const e = new Error("not_configured");
    e.code = "not_configured";
    return e;
}

async function plan(data) {
    if (!isConfigured()) throw notConfigured();
    const who = whoOf(data.who);
    const user = `Who uses it: ${WHO[who]}\n\nRequest:\n${clip(data.prompt, 4000)}${data.base ? `\n\nThis is a change to an existing app.${baseBlock(data.base)}` : ""}`;
    const raw = await structured({ system: PLAN_PROMPT, user, tool: "plan_app", description: "Save the plan and questions.", schema: PLAN_SCHEMA, maxTokens: 2000 });
    const questions = (Array.isArray(raw && raw.questions) ? raw.questions : []).slice(0, 6).map((q) => {
        const options = (Array.isArray(q.options) ? q.options : []).map((o) => clip(o, 80)).filter(Boolean).slice(0, 4);
        const rec = Number.isInteger(q.recommended) && q.recommended >= 0 && q.recommended < options.length ? q.recommended : 0;
        return { question: clip(q.question, 200), options, recommended: rec };
    }).filter((q) => q.question && q.options.length >= 2);
    return { summary: clip(raw && raw.summary, 600), questions };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
function badOutput(msg) {
    const e = new Error(msg);
    e.code = "bad_output";
    return e;
}

async function build(data) {
    if (!isConfigured()) throw notConfigured();
    const who = whoOf(data.who);
    const answers = describeAnswers(data.answers);
    const user = [
        `Who uses it: ${WHO[who]}`,
        data.base ? `Change request:\n${clip(data.prompt, 4000)}` : `Request:\n${clip(data.prompt, 4000)}`,
        answers ? `Decisions the person made:\n${answers}` : "",
        baseBlock(data.base),
    ].filter(Boolean).join("\n\n");
    const raw = await structured({ system: BUILD_PROMPT, user, tool: "save_app", description: "Save the finished app.", schema: APP_SCHEMA, maxTokens: 32000 });

    let html = String((raw && raw.html) || "").trim();
    if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) throw badOutput("no complete html document");
    if (Buffer.byteLength(html) > MAX_HTML) throw badOutput("html too large");
    let secrets = null;
    try {
        const raw2 = String((raw && raw.secrets_json) || "").trim();
        if (raw2 && raw2.length <= MAX_SECRETS) {
            const parsed = JSON.parse(raw2);
            if (parsed && typeof parsed === "object" && Object.keys(parsed).length) secrets = parsed;
        }
    } catch (e) { secrets = null; }
    const glyph = Array.from(clip(raw.glyph, 8).trim()).slice(0, 2).join("") || "A";
    return {
        name: clip(raw.name, 24).trim() || "Untitled app",
        glyph,
        bg: HEX.test(raw.bg) ? raw.bg : "#1c2140",
        fg: HEX.test(raw.fg) ? raw.fg : "#8e9bff",
        summary: clip(raw.summary, 300),
        spec: clip(raw.spec, 6000),
        note: clip(raw.note, 60) || (data.base ? "Updated" : "First version"),
        html,
        secrets,
        who,
        model: MODEL,
    };
}

module.exports = { plan, build, isConfigured, PROVIDER, MODEL, SDK };
