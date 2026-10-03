// Turns raw "brain dump" entries into grouped, ordered, de-duplicated tasks using an LLM.
// Provider is chosen by env TASKS_AI = claude (default) | openai | gemini.
// Nothing is stored: input comes from the owner's device, the result goes straight back.

const PROVIDER = (process.env.TASKS_AI || "claude").toLowerCase();
const DEFAULT_MODELS = { claude: "claude-haiku-4-5-20251001" };
const MODEL = process.env.TASKS_AI_MODEL || DEFAULT_MODELS[PROVIDER];
const TIMEOUT_MS = 30000;

const SYSTEM_PROMPT = `You organize one person's daily to-do list. It works like a paper planner: long-term GOALS on one sheet, and a fresh sheet for TODAY. They type quick, messy notes ("entries") about anything.

You receive (JSON):
- today: the current date (YYYY-MM-DD) and weekday
- goals: long-term goals (id, title)
- bundles: today's bundles (id, title). A bundle is a small group of steps done together, e.g. "Shopping trip" with "buy gas on the way back" and "pick up charger from Tunde".
- tasks: open tasks (id, text, bundle_id, goal_id, day)
- entries: new raw entries (id, text)

For EVERY entry, output one or more items:
- "merge": the entry is the same thing as an existing open task (even if worded differently). merge_into = that task id. title only if the entry adds useful detail (e.g. a time), else null.
- "goal": the entry states a long-term aim rather than a task ("goal: learn SQL", "I want to get fit this year"). title = short goal name ("Learn SQL"). If an equal goal already exists, still output it; it will be de-duplicated.
- "add": a new task. title: short and clear, start with a verb when natural, keep the user's language, names, amounts, dates and times. Fix obvious typos. Don't invent details.
- Several entries that are the same thing -> ONE item listing all their entry_ids. One entry with several distinct tasks -> several items sharing that entry id.

For "add" items also decide:
- goal_id: the id of an existing goal ONLY if doing this task clearly moves that goal forward (e.g. "do 2 SQL exercises" -> Learn SQL). Otherwise null. Never guess.
- bundle: if the task is naturally done together with other tasks (same trip, place or sequence), put it in a bundle: bundle_id = existing bundle id, or new_bundle = a short title (2-3 words, e.g. "Shopping trip", "Bank visit") shared by all items of that new bundle. Most tasks are NOT bundled; only bundle when it clearly helps. Never both bundle_id and new_bundle.
- day: YYYY-MM-DD only if the entry clearly refers to a LATER day ("tomorrow", "on Monday", "12 Oct"); otherwise null (= today). Never a past date.
- position_before: id of an existing task in the same list (same bundle, or both unbundled) that this task should come before because it is more urgent or must happen first; null to append. Do not reorder existing tasks.
- note: a very short clarifying question if the entry is ambiguous (unclear what, which, or when). Otherwise null.

Never drop an entry. Never create items that aren't backed by an entry.

Return the result only through the save_organized_tasks tool.`;

// JSON schema shared by all providers (OpenAI strict mode: every property required, nulls allowed)
const nullableString = (description) => ({ type: ["string", "null"], description });
const ITEM_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        entry_ids: { type: "array", items: { type: "string" }, description: "ids of the entries this item came from" },
        action: { type: "string", enum: ["add", "merge", "goal"] },
        merge_into: nullableString("existing task id when action is merge"),
        title: nullableString("task text or goal title"),
        goal_id: nullableString("existing goal id this task moves forward"),
        bundle_id: nullableString("existing bundle id"),
        new_bundle: nullableString("title of a new bundle"),
        day: nullableString("YYYY-MM-DD for a later day, null for today"),
        position_before: nullableString("existing task id to insert before, or null to append"),
        note: nullableString("short clarifying question if ambiguous"),
    },
    required: ["entry_ids", "action", "merge_into", "title", "goal_id", "bundle_id", "new_bundle", "day", "position_before", "note"],
};
const RESULT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: { items: { type: "array", items: ITEM_SCHEMA } },
    required: ["items"],
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
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${PROVIDER} HTTP ${res.status}: ${text.slice(0, 300)}`);
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
    }
}

const providers = {
    async claude(userContent) {
        const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
        const data = await postJson(`${base}/v1/messages`, {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        }, {
            model: MODEL,
            max_tokens: 4096,
            temperature: 0,
            system: SYSTEM_PROMPT,
            tools: [{
                name: "save_organized_tasks",
                description: "Save the organized result for the given entries.",
                input_schema: RESULT_SCHEMA,
            }],
            tool_choice: { type: "tool", name: "save_organized_tasks" },
            messages: [{ role: "user", content: userContent }],
        });
        const block = (data.content || []).find((b) => b.type === "tool_use");
        if (!block) throw new Error("claude: no tool_use block in response");
        return block.input;
    },

    async openai(userContent) {
        const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
        const data = await postJson(`${base}/v1/chat/completions`, {
            authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        }, {
            model: MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT.replace("through the save_organized_tasks tool", "as JSON matching the schema") },
                { role: "user", content: userContent },
            ],
            response_format: { type: "json_schema", json_schema: { name: "organized_tasks", strict: true, schema: RESULT_SCHEMA } },
        });
        return JSON.parse(data.choices[0].message.content);
    },

    async gemini(userContent) {
        // Gemini uses an OpenAPI-style schema: "nullable" instead of type unions
        const toGemini = (s) => {
            if (Array.isArray(s.type)) return { ...toGemini({ ...s, type: s.type.find((t) => t !== "null") }), nullable: true };
            const out = { type: s.type.toUpperCase() };
            if (s.enum) out.enum = s.enum;
            if (s.description) out.description = s.description;
            if (s.items) out.items = toGemini(s.items);
            if (s.properties) {
                out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGemini(v)]));
                out.required = s.required;
            }
            return out;
        };
        const base = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
        const data = await postJson(`${base}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
            "x-goog-api-key": process.env.GEMINI_API_KEY,
        }, {
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT.replace("through the save_organized_tasks tool", "as JSON matching the schema") }] },
            contents: [{ role: "user", parts: [{ text: userContent }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: toGemini(RESULT_SCHEMA) },
        });
        return JSON.parse(data.candidates[0].content.parts[0].text);
    },
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Make sure the model's answer is safe to apply: known ids only, every entry accounted for.
function validate(raw, input) {
    const entryIds = new Set(input.entries.map((e) => e.id));
    const taskById = new Map(input.tasks.map((t) => [t.id, t]));
    const goalIds = new Set(input.goals.map((g) => g.id));
    const goalByTitle = new Map(input.goals.map((g) => [g.title.toLowerCase(), g.id]));
    const bundleIds = new Set(input.bundles.map((b) => b.id));
    const covered = new Set();
    const items = [];
    const clean = (s, max) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null);
    const laterDay = (d) => (typeof d === "string" && DAY_RE.test(d) && d > input.today ? d : null);

    for (const it of (raw && Array.isArray(raw.items) ? raw.items : [])) {
        const ids = (Array.isArray(it.entry_ids) ? it.entry_ids : []).filter((id) => entryIds.has(id));
        if (ids.length === 0) continue;
        const title = clean(it.title, 200);
        const note = clean(it.note, 200);

        if (it.action === "goal" && title) {
            const existing = goalByTitle.get(title.toLowerCase());
            items.push({ type: "goal", entryIds: ids, title: title.slice(0, 60), existingGoalId: existing || null });
        } else if (it.action === "merge" && taskById.has(it.merge_into)) {
            items.push({ type: "merge", entryIds: ids, taskId: it.merge_into, title, note, day: laterDay(it.day) });
        } else {
            const bundleId = bundleIds.has(it.bundle_id) ? it.bundle_id : null;
            const newBundle = bundleId ? null : clean(it.new_bundle, 40);
            const before = taskById.get(it.position_before);
            const sameList = before && (before.bundle_id || null) === bundleId && !newBundle;
            items.push({
                type: "add",
                entryIds: ids,
                title: title || input.entries.find((e) => e.id === ids[0]).text.trim().slice(0, 200),
                goalId: goalIds.has(it.goal_id) ? it.goal_id : null,
                bundleId,
                newBundle,
                day: laterDay(it.day),
                before: sameList ? before.id : null,
                note,
            });
        }
        ids.forEach((id) => covered.add(id));
    }

    // Anything the model skipped is kept as a plain task for today rather than lost
    for (const e of input.entries) {
        if (!covered.has(e.id)) {
            items.push({ type: "add", entryIds: [e.id], title: e.text.trim().slice(0, 200), goalId: null, bundleId: null, newBundle: null, day: null, before: null, note: null });
        }
    }
    return items;
}

function sanitizeInput(data) {
    const str = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, max);
    const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
    const today = DAY_RE.test(String(data && data.today)) ? data.today : new Date().toISOString().slice(0, 10);
    const entries = list(data && data.entries, 100)
        .map((e) => ({ id: str(e && e.id, 64), text: str(e && e.text, 1000) }))
        .filter((e) => e.id && e.text.trim());
    const goals = list(data && data.goals, 100)
        .map((g) => ({ id: str(g && g.id, 64), title: str(g && g.title, 60) }))
        .filter((g) => g.id && g.title.trim());
    const bundles = list(data && data.bundles, 100)
        .map((b) => ({ id: str(b && b.id, 64), title: str(b && b.title, 40) }))
        .filter((b) => b.id && b.title.trim());
    const tasks = list(data && data.tasks, 500)
        .map((t) => ({
            id: str(t && t.id, 64),
            text: str(t && t.text, 200),
            bundle_id: t && t.bundle_id ? str(t.bundle_id, 64) : null,
            goal_id: t && t.goal_id ? str(t.goal_id, 64) : null,
            day: t && DAY_RE.test(String(t.day)) ? t.day : today,
        }))
        .filter((t) => t.id && t.text.trim());
    return { today, entries, goals, bundles, tasks };
}

async function organize(data) {
    if (!isConfigured()) {
        const err = new Error("not_configured");
        err.code = "not_configured";
        throw err;
    }
    const input = sanitizeInput(data);
    if (input.entries.length === 0) return [];
    const weekday = WEEKDAYS[new Date(input.today + "T12:00:00Z").getUTCDay()];
    const userContent = JSON.stringify({
        today: `${input.today} (${weekday})`,
        goals: input.goals,
        bundles: input.bundles,
        tasks: input.tasks,
        entries: input.entries,
    }, null, 1);
    const raw = await providers[PROVIDER](userContent);
    return validate(raw, input);
}

module.exports = { organize, isConfigured, validate, sanitizeInput, PROVIDER, MODEL };
