// The backup workflow has no runtime to test against, so this pins down what
// must not drift: schedule, the six secrets and their check, encryption before
// upload, no plain archive anywhere. Plus the URI helper the restore drill uses.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withDatabase } = require("./helpers");

const yml = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "db-backup.yml"), "utf8");
const SECRETS = ["MONGODB_URI", "BACKUP_AGE_PUBLIC_KEY", "BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"];
// The backup ping (routes/ops.js) is optional: without them the step is skipped
const OPTIONAL = ["BACKUP_PING_URL", "BACKUP_PING_KEY"];

test("db-backup.yml: weekly schedule, manual run, read-only token, one run at a time", () => {
  assert.match(yml, /^\s+- cron: "17 3 \* \* 0"$/m);
  assert.match(yml, /^\s+workflow_dispatch:$/m);
  assert.match(yml, /^permissions:\n {2}contents: read$/m);
  assert.match(yml, /^concurrency:\n {2}group: db-backup$/m);
  assert.doesNotMatch(yml, /actions\/checkout/, "nothing from the repo is needed on the runner");
});

test("db-backup.yml: exactly the documented secrets, the required ones checked before anything runs", () => {
  const used = [...new Set([...yml.matchAll(/\$\{\{ secrets\.(\w+) \}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, [...SECRETS, ...OPTIONAL].sort());
  const check = /name: Secrets vorhanden\?[\s\S]*?for name in ([^;]+);/.exec(yml);
  assert.ok(check, "the first step checks the secrets");
  assert.deepEqual(check[1].trim().split(/\s+/).sort(), [...SECRETS].sort());
  assert.match(yml, /echo "::error::Secret\(s\) fehlen:\$missing/);
  assert.equal(yml.indexOf("name: Secrets vorhanden?") < yml.indexOf("name: mongodump und age installieren"), true);
});

test("db-backup.yml: dump is gzipped, encrypted for the public key, removed, never an artifact", () => {
  assert.match(yml, /mongodump --uri "\$MONGODB_URI" --archive=dump\.archive\.gz --gzip/);
  assert.match(yml, /age -r "\$BACKUP_AGE_PUBLIC_KEY" -o "\$name" dump\.archive\.gz/);
  assert.match(yml, /trap 'rm -f dump\.archive\.gz' EXIT/);
  assert.match(yml, /case "\$BACKUP_AGE_PUBLIC_KEY" in\n\s+age1\*\)/, "a private key pasted as the public one is refused");
  assert.doesNotMatch(yml, /upload-artifact/);
  assert.doesNotMatch(yml, /AGE-SECRET-KEY-1[0-9A-Z]{20}/, "no private key in the repo");
});

test("db-backup.yml: upload to mongo/<date>.archive.gz.age at the endpoint, keep the newest eight", () => {
  assert.match(yml, /name="\$\(date -u \+%Y-%m-%d\)\.archive\.gz\.age"/);
  assert.match(yml, /prefix="s3:\/\/\$BACKUP_S3_BUCKET\/mongo\/"/);
  assert.match(yml, /aws s3 cp "\$RUNNER_TEMP\/\$NAME" "\$prefix\$NAME" --endpoint-url "\$BACKUP_S3_ENDPOINT"/);
  assert.match(yml, /^\s+KEEP: 8$/m);
  assert.match(yml, /head -n -"\$KEEP" .*\| while read -r old; do\n\s+echo [^\n]*\n\s+aws s3 rm "\$prefix\$old" --endpoint-url "\$BACKUP_S3_ENDPOINT"/);
});

test("db-backup.yml: steps with pipes run under shell: bash, so a failed left side fails the step", () => {
  // Without an explicit shell GitHub runs bash -e without pipefail: a failed
  // "aws s3 ls" would skip the cleanup silently and the run would stay green.
  for (const step of ["mongodump und age installieren", "Upload in den Bucket und alte Dumps löschen"]) {
    assert.match(yml, new RegExp(`- name: ${step}\\n\\s+shell: bash\\n`), `${step}: shell: bash`);
  }
});

test("db-backup.yml: the backup ping runs last, only with both secrets, with the key in the header", () => {
  const steps = [...yml.matchAll(/- name: (.+)/g)].map((m) => m[1]);
  assert.equal(steps.at(-1), "Backend benachrichtigen");
  assert.match(yml, /- name: Backend benachrichtigen\n\s+if: \$\{\{ env\.BACKUP_PING_URL != '' && env\.BACKUP_PING_KEY != '' \}\}/);
  assert.match(yml, /curl -fsS -X POST "\$BACKUP_PING_URL"/);
  assert.match(yml, /-H "Authorization: Bearer \$BACKUP_PING_KEY"/);
  assert.match(yml, /echo "bytes=\$\(stat -c %s "\$name"\)" >> "\$GITHUB_OUTPUT"/);
});

test("withDatabase: same cluster and options, only the database changes", () => {
  assert.equal(withDatabase("mongodb+srv://u:p%2Fw@c0.x.mongodb.net/wannayap?retryWrites=true&w=majority", "wannayap-test-1"), "mongodb+srv://u:p%2Fw@c0.x.mongodb.net/wannayap-test-1?retryWrites=true&w=majority");
  assert.equal(withDatabase("mongodb://h1:27017,h2:27017/", "t"), "mongodb://h1:27017,h2:27017/t");
  assert.equal(withDatabase("mongodb://127.0.0.1:27017", "t"), "mongodb://127.0.0.1:27017/t");
  assert.equal(withDatabase("mongodb://127.0.0.1:27017?directConnection=true", "t"), "mongodb://127.0.0.1:27017/t?directConnection=true");
  assert.throws(() => withDatabase("postgres://x/y", "t"), /not a MongoDB URI/);
});
