const assert = require("assert");
const mouStore = require("../services/mouStore");

assert.doesNotThrow(() => mouStore.ensureStorage());
assert.strictEqual(mouStore.INDEX_PATH, null);
assert.strictEqual(mouStore.USER_AGREEMENT_PATH, null);

console.log("mouStore.ensure.test.js: ok");
