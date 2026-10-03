// Docs drift (plan 2.15): the README and the runbook are only worth
// something while they match the code. (a) every environment variable the
// code reads has a row in the README table "Environment"; (b) every alert
// tag, from lib/alerts.js RULES and from the places that raise one directly,
// has a row in the README table "Alerts"; (c) with the app repo checked out
// next to this one (../CMM, a local working copy; CI has none), each of those
// tags also has its row in CMM/docs/RUNBOOK.md, table "Alarme". Plain file
// reads, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const RUNBOOK = path.join(root, "..", "CMM", "docs", "RUNBOOK.md");

/** Every .js file under `rel` (a file or a directory), skipping node_modules. */
function jsFiles(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const child = path.join(rel, e.name);
    return e.isDirectory() ? jsFiles(child) : e.name.endsWith(".js") ? [child] : [];
  });
}

const SOURCES = ["app.js", "index.js", "socket.js", "lib", "routes", "models", "scripts"].flatMap(jsFiles);
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
// Block and line comments out (not "//" after a colon or quote, as in URLs)
const code = (file) => source(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** The section of `doc` under `heading` ("## Alerts") up to the next "## ". */
function section(doc, heading, where) {
  const start = doc.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `${where} has a section "${heading}"`);
  const rest = doc.slice(start + heading.length + 2);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The backticked names in the first column of the tables of `text`. */
function firstColumn(text) {
  const names = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[1];
    for (const m of cell.matchAll(/`([^`]+)`/g)) names.add(m[1]);
  }
  return names;
}

// Read by the code but deliberately without a row in the table. Every
// entry needs its reason; better a row than an entry here.
const ENV_ALLOWLIST = {};

test("env-drift: every process.env variable the code reads has a row in the README table Environment", () => {
  const used = new Map();
  // process.env.NAME, process.env["NAME"], and env.NAME where a function
  // takes `env = process.env` (lib/sentry.js, routes/verify.js)
  const patterns = [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g, /\benv\.([A-Z][A-Z0-9_]*)/g];
  for (const file of SOURCES) {
    const text = code(file);
    for (const re of patterns) for (const m of text.matchAll(re)) used.set(m[1], [...(used.get(m[1]) || []), file]);
    // A computed name (process.env[name]) can't be checked: keep it out of the code
    assert.doesNotMatch(text, /process\.env\[\s*[^"'`\s]/, `${file} reads process.env with a computed name; read each variable by its name, so this test can see it`);
  }
  const documented = firstColumn(section(readme, "## Environment", "README.md"));
  const missing = [...used.keys()].filter((name) => !documented.has(name) && !ENV_ALLOWLIST[name]).sort();
  assert.deepEqual(missing, [], `Without a row in README.md "Environment": ${missing.map((n) => `${n} (${[...new Set(used.get(n))].join(", ")})`).join("; ")}. Add a row (variable, required, purpose).`);
  // The scan works: it sees the ones we know are there
  for (const name of ["MONGODB_URI", "JWT_SECRET", "SENTRY_DSN", "REVIEW_UNTIL", "PHONE_HASH_PEPPER"]) assert.ok(used.has(name), `the scan finds ${name}`);
});

/**
 * Every alert tag: the RULES of lib/alerts.js, every alert("tag", …) with
 * a literal tag, and the tag constants (`…_TAG = "tag"`) of the places that
 * book an AlertState themselves (lib/adminPush.js dead-man rules).
 */
function alertTags() {
  const tags = new Map(require("../lib/alerts").RULES.map((r) => [r.tag, "lib/alerts.js RULES"]));
  for (const file of SOURCES) {
    const text = code(file);
    for (const m of text.matchAll(/\balert\(\s*["'`]([a-z][a-z0-9_]+)["'`]/g)) tags.set(m[1], file);
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*_TAG\s*=\s*["'`]([a-z][a-z0-9_]+)["'`]/g)) tags.set(m[1], file);
    for (const m of text.matchAll(/AlertState\.(?:updateOne|create|findOneAndUpdate)\(\s*\{\s*tag:\s*["'`]([a-z][a-z0-9_]+)["'`]/g)) tags.set(m[1], file);
    // A tag this test can't read: alert(variable, …) outside the RULES loop
    for (const m of text.matchAll(/(?<!function\s+)\balert\(\s*([A-Za-z_$][\w.$]*)\s*,/g)) {
      if (file === "lib/alerts.js" && m[1] === "rule.tag") continue;
      assert.fail(`${file} raises alert(${m[1]}, …): pass the tag as a literal (or a *_TAG constant), so the docs check sees it`);
    }
  }
  return tags;
}

test("alert-tags: every alert tag has a row in the README table Alerts", () => {
  const tags = alertTags();
  // The scan works: the tags raised outside RULES are found
  for (const tag of ["pepper_changed", "sentry_fatal", "owner_silent", "weekly_silent", "agora_tokens"]) assert.ok(tags.has(tag), `the scan finds ${tag}`);
  const documented = firstColumn(section(readme, "## Alerts", "README.md"));
  const missing = [...tags.keys()].filter((tag) => !documented.has(tag)).sort();
  assert.deepEqual(missing, [], `Without a row in README.md "Alerts": ${missing.map((t) => `${t} (${tags.get(t)})`).join(", ")}. Add tag, level, when it fires and what to do.`);
});

// Tags whose runbook row the app repo adds in its own commit of the same
// plan item (CMM/docs/RUNBOOK.md, plan 2.15/2.6b-docs). Tolerated only
// while the row is missing; remove the entry once it is there.
const RUNBOOK_PENDING = new Set(["agora_tokens", "agent_failed"]);

test("runbook: every alert tag has a row in CMM/docs/RUNBOOK.md, table Alarme", (t) => {
  if (!fs.existsSync(RUNBOOK)) {
    t.skip("../CMM/docs/RUNBOOK.md not found: the app repo isn't checked out next to this one (as in CI)");
    return;
  }
  const documented = firstColumn(section(fs.readFileSync(RUNBOOK, "utf8"), "## Alarme", "CMM/docs/RUNBOOK.md"));
  const tags = alertTags();
  const missing = [...tags.keys()].filter((tag) => !documented.has(tag) && !RUNBOOK_PENDING.has(tag)).sort();
  assert.deepEqual(missing, [], `Without a row in CMM/docs/RUNBOOK.md "Alarme": ${missing.join(", ")}. Add tag, Stufe, Bedeutung and Gegenmaßnahme there (app repo).`);
  const arrived = [...RUNBOOK_PENDING].filter((tag) => documented.has(tag));
  if (arrived.length) t.diagnostic(`RUNBOOK_PENDING can lose ${arrived.join(", ")}: the runbook has the row now`);
});
