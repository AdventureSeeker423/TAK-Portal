const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { isAuthentikPkToken, isUuid } = require("../services/directoryRepo.service");

assert.strictEqual(isUuid("08078bff-cca2-4b47-b4aa-fd87229168ef"), true);
assert.strictEqual(isAuthentikPkToken("08078bff-cca2-4b47-b4aa-fd87229168ef"), true);
assert.strictEqual(isAuthentikPkToken("42"), true);
assert.strictEqual(isAuthentikPkToken("not-a-pk"), false);

const sql002 = fs.readFileSync(
  path.join(__dirname, "..", "db", "migrations", "002_authentik_pk_text.sql"),
  "utf8"
);
assert.ok(/DROP VIEW IF EXISTS v_group_users/.test(sql002));
assert.ok(/ALTER COLUMN authentik_pk TYPE TEXT/.test(sql002));
assert.ok(/CREATE OR REPLACE VIEW v_group_users/.test(sql002));

const init = fs.readFileSync(
  path.join(__dirname, "..", "db", "migrations", "001_init.sql"),
  "utf8"
);
assert.ok(/authentik_pk TEXT UNIQUE/.test(init));
assert.ok(!/authentik_pk INT UNIQUE/.test(init));

const repoSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "directoryRepo.service.js"),
  "utf8"
);
assert.ok(
  !/id = \$1::uuid OR authentik_pk = \$1(?!::)/.test(repoSrc),
  "reusing $1 as uuid and text makes Postgres error: operator does not exist: text = uuid"
);
assert.ok(/id = \$1::uuid OR authentik_pk = \$2 LIMIT 1/.test(repoSrc));

console.log("directoryPkText.test.js: ok");
