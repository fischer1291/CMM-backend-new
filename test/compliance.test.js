// COMPLIANCE.md is the record of processing (GDPR Art. 30): every collection
// in models/ needs a row there, written in the same PR that adds the model,
// and no row may name a model that is gone. The check runs with the suite,
// so a new model without its row turns the CI red (plan 1.6).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const doc = fs.readFileSync(path.join(root, "COMPLIANCE.md"), "utf8");
const models = fs
  .readdirSync(path.join(root, "models"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => f.replace(/\.js$/, ""))
  .sort();

/** First-column names of the table under "Verarbeitungsverzeichnis je Collection". */
function tableRows() {
  const section = /## Verarbeitungsverzeichnis je Collection([\s\S]*?)(?:\n## |$)/.exec(doc);
  assert.ok(section, 'COMPLIANCE.md has a section "## Verarbeitungsverzeichnis je Collection"');
  return section[1]
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[1].trim().replace(/^`|`$/g, ""))
    .filter((name) => name && name !== "Collection" && !/^-+$/.test(name));
}

test("compliance: every file in models/ has a row in COMPLIANCE.md", () => {
  const rows = new Set(tableRows());
  const missing = models.filter((m) => !rows.has(m));
  assert.deepEqual(
    missing,
    [],
    `models/${missing.join(".js, models/")}.js without a row in COMPLIANCE.md. Add one to the table ` +
      '"Verarbeitungsverzeichnis je Collection" (first column: the file name without .js) with purpose, ' +
      "personal fields, legal basis, retention/TTL and whether lib/account.js deletes it; see CMM/docs/PRIVACY-CHANGE.md.",
  );
});

test("compliance: no row names a model that no longer exists", () => {
  const stale = tableRows().filter((name) => !models.includes(name));
  assert.deepEqual(stale, [], `rows in COMPLIANCE.md without a file in models/: ${stale.join(", ")}`);
});
