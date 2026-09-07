const assert = require("assert");
const form = require("../services/locatorForm.service");

assert.strictEqual(form.normalizeColor("cyan"), "Cyan");
assert.strictEqual(form.normalizeColor("nope"), "Cyan");
assert.strictEqual(form.normalizeColor("Dark Blue"), "Dark Blue");

const normalized = form.normalizeForm({
  heading: "  Hello  ",
  intro: "Keep open",
  fields: [
    { type: "firstName", label: "First", required: true },
    { type: "firstName", label: "Dup" },
    { type: "lastName", label: "Last" },
    { type: "text", label: "Unit", required: false },
    { type: "choice", label: "Status", options: ["Ok", "Hurt", "Ok"] },
    { type: "choice", label: "Empty", options: [] },
  ],
});
assert.strictEqual(normalized.heading, "Hello");
assert.strictEqual(normalized.fields.filter((f) => f.type === "firstName").length, 1);
assert.ok(normalized.fields.some((f) => f.type === "choice" && f.options.length === 2));
assert.ok(!normalized.fields.some((f) => f.label === "Empty"));

const answers = form.validateAnswers(normalized, {
  [normalized.fields[0].id]: "Jane",
  [normalized.fields[1].id]: "Doe",
  [normalized.fields.find((f) => f.type === "choice").id]: "Hurt",
});
assert.ok(!answers.error);
assert.strictEqual(
  form.formatLiveCallsign("Hiker 14", normalized, answers.answers),
  "Doe, Jane"
);
assert.strictEqual(form.formatLiveCallsign("Hiker 14", normalized, {}), "LOCATOR - Hiker 14");
assert.ok(form.formatLiveRemarks(normalized, answers.answers).includes("Status: Hurt"));

const missing = form.validateAnswers(normalized, {});
assert.ok(missing.error);

const parsed = form.parseAnswers({ answers: JSON.stringify({ a: "1" }) });
assert.strictEqual(parsed.a, "1");
const parsed2 = form.parseAnswers({ answer_x: "y" });
assert.strictEqual(parsed2.x, "y");

console.log("locatorForm.test.js: ok");
