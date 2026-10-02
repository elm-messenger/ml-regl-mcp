// Render trees from the hosts, in one shape, and bounded views of them for
// agents: a summary and node queries. The full tree never goes to the agent.
//
// The hosts send the same protobuf Renderable as JSON with different key
// names: desktop fields look like {key, value: {number | numbers | string |
// strings | bool}}, browser fields like {key, val: {numberValue |
// numberArrayValue: {values} | stringValue | stringArrayValue: {values} |
// boolValue}}, and the browser includes empty effects and camera: null.
//
// Normalized nodes:
//   {kind: "group", effects: [{program, fields}], camera?, children: [node]}
//   {kind: "atomic", program, fields}
//   {kind: "composite", program, fields, children: [left, right]}
// A path is the list of child indices from the root joined by "." ("" is the
// root, "2.0" the first child of the root's third child; a composite's left
// side is 0 and its right side 1).

const MAX_TEXTS = 100;
const MAX_OUTLINE = 80;
const OUTLINE_DEPTH = 2;
const MAX_ARRAY = 32;

function fieldValue(raw) {
  const v = raw?.value ?? raw?.val;
  if (!v || typeof v !== "object") return null;
  if ("number" in v) return v.number;
  if ("numbers" in v) return v.numbers;
  if ("string" in v) return v.string;
  if ("strings" in v) return v.strings;
  if ("bool" in v) return v.bool;
  if ("numberValue" in v) return v.numberValue;
  if ("numberArrayValue" in v) return v.numberArrayValue?.values ?? [];
  if ("stringValue" in v) return v.stringValue;
  if ("stringArrayValue" in v) return v.stringArrayValue?.values ?? [];
  if ("boolValue" in v) return v.boolValue;
  return null;
}

function fields(list) {
  const out = {};
  for (const f of list || []) if (f && f.key != null) out[f.key] = fieldValue(f);
  return out;
}

function call(c) {
  return { program: c?.program ?? null, fields: fields(c?.fields) };
}

export function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.atomic) return { kind: "atomic", ...call(raw.atomic) };
  if (raw.group) {
    const g = raw.group;
    const node = {
      kind: "group",
      effects: (g.effects || []).map(call),
      children: (g.children || []).map(normalize).filter(Boolean),
    };
    if (g.camera) {
      const { x = 0, y = 0, zoom = 1, rotation = 0 } = g.camera;
      node.camera = { x, y, zoom, rotation };
    }
    return node;
  }
  if (raw.composite) {
    const c = raw.composite;
    return {
      kind: "composite",
      ...call(c.compositor),
      children: [normalize(c.left), normalize(c.right)].map(
        (n) => n || { kind: "group", effects: [], children: [] },
      ),
    };
  }
  return null;
}

function* walk(node, path = [], depth = 0) {
  yield { node, path, depth };
  for (const [i, child] of (node.children || []).entries()) {
    yield* walk(child, [...path, i], depth + 1);
  }
}

const pathString = (path) => path.join(".");

function brief(node, path) {
  const out = { path: pathString(path), kind: node.kind };
  if (node.program) out.program = node.program;
  if (node.kind !== "atomic") out.children = node.children.length;
  if (node.effects?.length) out.effects = node.effects.map((e) => e.program);
  if (node.camera) out.camera = node.camera;
  return out;
}

function textOf(node) {
  if (node.kind !== "atomic" || node.program !== "textbox") return null;
  const f = node.fields;
  const out = { text: f.text ?? "" };
  if (Array.isArray(f.offset)) [out.x, out.y] = f.offset;
  if (f.size != null) out.size = f.size;
  if (f.font != null) out.font = f.font;
  if (f.fonts != null) out.fonts = f.fonts;
  if (f.align != null) out.align = f.align;
  return out;
}

export function summarize(root) {
  const programs = {};
  const effects = {};
  const texts = [];
  const outline = [];
  let nodes = 0;
  let depth = 0;
  let textCount = 0;
  for (const { node, path, depth: d } of walk(root)) {
    nodes += 1;
    depth = Math.max(depth, d);
    if (node.kind !== "group") {
      const key = node.kind === "composite" ? `${node.program} (compositor)` : node.program;
      programs[key] = (programs[key] || 0) + 1;
    }
    for (const e of node.effects || []) effects[e.program] = (effects[e.program] || 0) + 1;
    const text = textOf(node);
    if (text) {
      textCount += 1;
      if (texts.length < MAX_TEXTS) texts.push({ path: pathString(path), ...text });
    }
    if (d <= OUTLINE_DEPTH && outline.length < MAX_OUTLINE) outline.push(brief(node, path));
  }
  return {
    nodes,
    depth,
    programs,
    effects,
    texts,
    textsTruncated: textCount > texts.length ? textCount - texts.length : 0,
    outline,
    outlineDepth: OUTLINE_DEPTH,
  };
}

function trimFields(f, fullArrays) {
  if (fullArrays) return f;
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] = Array.isArray(v) && v.length > MAX_ARRAY
      ? { first: v.slice(0, MAX_ARRAY), length: v.length }
      : v;
  }
  return out;
}

function detail(node, path, depth, fullArrays) {
  const out = brief(node, path);
  if (node.kind !== "group") out.fields = trimFields(node.fields, fullArrays);
  if (node.effects?.length) {
    out.effects = node.effects.map((e) => ({ program: e.program, fields: trimFields(e.fields, fullArrays) }));
  }
  if (node.kind !== "atomic" && depth > 0) {
    out.children = node.children.map((c, i) => detail(c, [...path, i], depth - 1, fullArrays));
  }
  return out;
}

function parsePath(s) {
  if (s === undefined || s === null || s === "") return [];
  const parts = String(s).split(".");
  if (parts.some((p) => !/^\d+$/.test(p))) throw new Error(`bad path '${s}': use child indices joined by '.'`);
  return parts.map(Number);
}

function nodeAt(root, path) {
  let node = root;
  for (const [i, index] of path.entries()) {
    node = node.children?.[index];
    if (!node) throw new Error(`no node at path '${pathString(path.slice(0, i + 1))}'`);
  }
  return node;
}

// Find nodes under [path] (default the root) matching every given filter.
// Without filters, returns the node at [path] itself.
export function query(root, { path, program, text, depth = 0, limit = 20, fullArrays = false }) {
  const base = parsePath(path);
  const start = nodeAt(root, base);
  const filtered = program !== undefined || text !== undefined;
  const matches = [];
  let total = 0;
  for (const { node, path: rel } of walk(start)) {
    if (!filtered && rel.length > 0) break;
    if (program !== undefined && node.program !== program) continue;
    if (text !== undefined) {
      const t = textOf(node);
      if (!t || !String(t.text).includes(text)) continue;
    }
    total += 1;
    if (matches.length < limit) matches.push(detail(node, [...base, ...rel], depth, fullArrays));
  }
  return { matches, total, truncated: total > matches.length };
}
