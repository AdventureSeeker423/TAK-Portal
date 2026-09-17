const assert = require("assert");
const fs = require("fs");
const path = require("path");

const groupsSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "groups.service.js"),
  "utf8"
);
const applyStart = groupsSrc.indexOf("async function applyBulkGroupMembership");
const applyEnd = groupsSrc.indexOf("async function fetchUsersByIds");
assert.ok(applyStart >= 0 && applyEnd > applyStart, "applyBulkGroupMembership not found");
const applyFn = groupsSrc.slice(applyStart, applyEnd);

assert.ok(
  applyFn.includes("getGroupMemberPks"),
  "group add/remove must use Postgres group_members, not Authentik group.users"
);
assert.ok(
  !applyFn.includes("group?.users") && !applyFn.includes("group.users"),
  "group.users is not populated on local directory group rows"
);

assert.ok(
  groupsSrc.includes("enqueueGroupMembershipOutbox") &&
    groupsSrc.includes("authentikUserPksFromUsers"),
  "membership outbox must send Authentik user pks to the worker"
);
assert.ok(
  /removeLocalMembers[\s\S]{0,400}enqueueGroupMembershipOutbox\(group, "remove_members"/.test(
    groupsSrc
  ),
  "removing a member must write Postgres and enqueue remove_members for the worker"
);
assert.ok(
  /addLocalMembers[\s\S]{0,400}enqueueGroupMembershipOutbox\(group, "add_members"/.test(
    groupsSrc
  ),
  "adding a member must write Postgres and enqueue add_members for the worker"
);

const repoSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "directoryRepo.service.js"),
  "utf8"
);
assert.ok(
  repoSrc.includes("refreshUserGroupsHashes"),
  "local membership changes must refresh users.groups_hash so inbound sync does not restore them"
);

const outboxSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "authentikOutbox.service.js"),
  "utf8"
);
assert.ok(
  /add_members[\s\S]{0,200}remove_members[\s\S]{0,300}userPks/.test(outboxSrc),
  "pending outbox keys must include membership userPks so inbound snapshot skips those users"
);

const syncSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "directorySync.service.js"),
  "utf8"
);
assert.ok(
  /add_user[\s\S]{0,400}remove_user/.test(syncSrc) &&
    syncSrc.includes("for (const userPk of users)"),
  "worker must add/remove Authentik group members one user at a time"
);
assert.ok(
  !/add_user\/`, \{ pk: users \}/.test(syncSrc),
  "worker must not send an array of user pks to Authentik add_user/remove_user"
);
assert.ok(
  !syncSrc.includes("g.data.users"),
  "worker must not rewrite a group's full users list as a membership fallback"
);

const usersSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "users.service.js"),
  "utf8"
);
const tplStart = usersSrc.indexOf("async function applyTemplateSyncWorkItems");
const tplEnd = usersSrc.indexOf("async function syncUsersForTemplateSave");
assert.ok(tplStart >= 0 && tplEnd > tplStart, "applyTemplateSyncWorkItems not found");
const tplFn = usersSrc.slice(tplStart, tplEnd);
assert.ok(
  tplFn.includes("applyBulkGroupMembership"),
  "template group overwrite must use Postgres membership + worker outbox"
);
assert.ok(
  !tplFn.includes("api.patch(`/core/users/${item.userId}/`, item.payload)"),
  "template sync must not live-patch Authentik user groups"
);

const agenciesViewSrc = fs.readFileSync(
  path.join(__dirname, "..", "views", "agencies.ejs"),
  "utf8"
);
assert.ok(
  /removeUserFromAdminsGroup[\s\S]{0,800}out\.updated/.test(agenciesViewSrc),
  "agencies admin Remove must not hide the user unless the API actually updated membership"
);

const viewSrc = fs.readFileSync(
  path.join(__dirname, "..", "views", "groups.ejs"),
  "utf8"
);
assert.ok(
  /removeUserFromGroup[\s\S]{0,800}out\.updated/.test(viewSrc),
  "members Remove must not hide the user unless the API actually updated membership"
);
assert.ok(
  /removeUserFromGroup[\s\S]{0,1200}loadMembersPage/.test(viewSrc),
  "members Remove must reload the Postgres member list after a successful unassign"
);

console.log("groupsMembership tests passed");
