// The CI workflow (.github/workflows/test.yml) has no runtime to test
// against, so this pins down what must not drift (as db-backup.test.js):
// the suite on every pull request and push to main, and the api/<date>-<sha>
// tag only for a green main, from a job that alone may write (plan 2.1).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const yml = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "test.yml"), "utf8");
/** The text of one job, from "  <name>:" to the next job or the end. */
const job = (name) => new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][\\w-]*:\\n|$)`).exec(yml)?.[1] || "";

test("test.yml: the suite runs on every pull request and every push to main, with a read-only token", () => {
  assert.match(yml, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/m);
  assert.match(yml, /^permissions:\n {2}contents: read$/m);
  const steps = job("test");
  assert.match(steps, /- run: npm ci\n\s+- run: npm test/);
  assert.doesNotMatch(steps, /contents: write|git tag|git push/);
});

test("test.yml: the api tag job runs only after the tests, only for a push to main, and alone may write", () => {
  const tag = job("tag");
  assert.ok(tag, "a job named tag");
  assert.match(tag, /^ {4}needs: test$/m);
  assert.match(tag, /^ {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m);
  assert.match(tag, /^ {4}permissions:\n {6}contents: write$/m);
  assert.equal((yml.match(/contents: write/g) || []).length, 1, "write access nowhere else");
});

test("test.yml: the tag is api/<YYYY-MM-DD in Europe/Berlin>-<short sha>, idempotent, pushed as a tag only", () => {
  const tag = job("tag");
  assert.match(tag, /tag="api\/\$\(TZ=Europe\/Berlin date \+%F\)-\$\{GITHUB_SHA::7\}"/);
  assert.match(tag, /git ls-remote --exit-code --tags origin "refs\/tags\/\$tag"/, "a re-run doesn't fail on an existing tag");
  assert.match(tag, /git tag -a "\$tag" -m "[^"]*" "\$GITHUB_SHA"/);
  assert.match(tag, /git push origin "refs\/tags\/\$tag"/);
  assert.doesNotMatch(tag, /git push(?! origin "refs\/tags\/)/, "never pushes a branch");
});
