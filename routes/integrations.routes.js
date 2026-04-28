const router = require("express").Router();
const fs = require("fs");
const users = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const auditSvc = require("../services/auditLog.service");
const takSshSvc = require("../services/takSsh.service");
const takSvc = require("../services/tak.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");
const archiver = require("archiver");

function toErrorPayload(err) {
  return toSafeApiError(err);
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
}

function parseStoredDataFeedPort(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * GET /api/integrations
 * List all users whose username starts with "nodered-".
 * Mounted with requirePermission("page.integrations") in server.js.
 */
router.get("/", async (req, res) => {
  try {
    const list = await users.findIntegrationUsers();
    const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
    const groupByPk = new Map(
      (allGroups || []).map((g) => [String(g.pk), g])
    );

    const usersWithGroupNames = list.map((u) => {
      const groupPks = Array.isArray(u.groups) ? u.groups : [];
      const groupNames = groupPks
        .map((pk) => {
          const name = groupByPk.get(String(pk))?.name;
          return name ? stripTakPrefix(name) : null;
        })
        .filter(Boolean);
      const dataFeedName = u.attributes?.tak_data_feed_name || null;
      return {
        pk: u.pk,
        username: u.username,
        name: u.name,
        email: u.email || "",
        is_active: !!u.is_active,
        groups: groupPks,
        groupNames,
        integrationTitle: String(u.attributes?.integration_title || "").trim(),
        certBundleReady: takSshSvc.hasStoredIntegrationCertFiles(u.username),
        dataFeedName,
        dataFeedPort: parseStoredDataFeedPort(u.attributes?.tak_data_feed_port),
      };
    });

    if (takSvc.isTakConfigured()) {
      const takClient = takSvc.buildTakAxios();
      await Promise.all(
        usersWithGroupNames.map(async (row) => {
          if (!row.dataFeedName || row.dataFeedPort != null) return;
          try {
            const dfRes = await takClient.get(
              `/api/datafeeds/${encodeURIComponent(row.dataFeedName)}`
            );
            const dataFeedPayload = dfRes.data?.data || dfRes.data;
            const port = dataFeedPayload?.port;
            const n =
              port == null
                ? null
                : typeof port === "number"
                  ? port
                  : parseInt(String(port), 10);
            if (n != null && Number.isFinite(n) && n > 0) {
              row.dataFeedPort = n;
              try {
                await users.updateUserAttributes(row.pk, {
                  tak_data_feed_port: n,
                });
              } catch (persistErr) {
                console.warn(
                  "Failed to persist tak_data_feed_port:",
                  persistErr?.message || persistErr
                );
              }
            }
          } catch (_) {
            /* leave dataFeedPort unset */
          }
        })
      );
    }

    res.json({ users: usersWithGroupNames });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/integrations
 * Create a new integration user: username "nodered-{slug from title}", single group.
 * Mounted with requirePermission("page.integrations") in server.js.
 */
router.post("/", async (req, res) => {
  try {
    const { type, title, groupId, state, county, agencySuffix, skipDataFeed, protocol, authType, port, coreVersion, coreVersion2TlsVersions, multicastGroup, iface, syncCacheRetention, archive, anongroup, archiveOnly, sync, federated, tags, filterGroups } = req.body || {};
    const authUser = req.authentikUser || null;
    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const titleStr = String(title || "").trim();
    const isSkipDataFeed = String(skipDataFeed) === "true";
    let streamingDataFeedName = null;
    if (!isSkipDataFeed) {
      streamingDataFeedName = users.getStreamingDataFeedNameForTitle(titleStr);
    }

    const result = await users.createIntegrationUser(
      {
        type: type || "global",
        title: titleStr,
        groupId,
        state: state ? String(state).trim() : undefined,
        county: county ? String(county).trim() : undefined,
        agencySuffix: agencySuffix ? String(agencySuffix).trim() : undefined,
      },
      { createdBy }
    );

    let certBundleReady = false;
    let certError = "";
    try {
      await takSshSvc.provisionIntegrationCertFiles(result?.user?.username || "");
      certBundleReady = true;
    } catch (certErr) {
      certError = certErr?.message || String(certErr);
    }

    let dataFeedError = "";
    const finalDataFeedName =
      !isSkipDataFeed && takSvc.isTakConfigured() ? streamingDataFeedName : null;

    if (!isSkipDataFeed && finalDataFeedName && takSvc.isTakConfigured()) {
      try {
        const payloadTags = tags ? tags.split(/[\n,]+/).map(t => t.trim()).filter(Boolean) : [];
        const strippedGroups = Array.isArray(filterGroups) ? filterGroups.map(stripTakPrefix) : [];
        
        const dataFeedPayload = {
          type: "Streaming",
          name: finalDataFeedName,
          protocol: protocol || "tls",
          auth: authType || "X_509",
          port: port ? parseInt(port, 10) : 8089,
          coreVersion: coreVersion || "2",
          coreVersion2TlsVersions: coreVersion2TlsVersions || "",
          group: multicastGroup || "",
          iface: iface || "",
          syncCacheRetentionSeconds: syncCacheRetention ? String(syncCacheRetention) : "3600",
          archive: archive === "true",
          anongroup: anongroup === "true",
          archiveOnly: archiveOnly === "true",
          sync: sync === "true",
          federated: federated === "true",
          tag: payloadTags,
          filtergroup: strippedGroups
        };

        const takClient = takSvc.buildTakAxios();
        await takClient.post("/api/datafeeds", dataFeedPayload);

        try {
          if (result && result.user && result.user.pk) {
            await users.updateUserAttributes(result.user.pk, {
              tak_data_feed_name: finalDataFeedName,
              tak_data_feed_port: dataFeedPayload.port,
            });
          }
        } catch (attrsErr) {
           console.warn("Failed to securely hook data feed name into Authentik attributes:", attrsErr);
        }
      } catch (feedErr) {
        let det = null;
        if (feedErr.response && feedErr.response.data) {
           det = typeof feedErr.response.data === 'object' ? JSON.stringify(feedErr.response.data) : String(feedErr.response.data);
        }
        dataFeedError = (feedErr.message || "TAK API failed") + (det ? " | " + det : "");
      }
    }

    const groupName =
      Array.isArray(result?.groups) && result.groups[0]
        ? result.groups[0].name
        : "";
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_INTEGRATION_USER",
      targetType: "user",
      targetId: String(result?.user?.pk || ""),
      details: {
        username: result?.user?.username,
        group: groupName,
        certBundleReady,
        certError: certError || undefined,
        summary: `Created integration user ${result?.user?.username || ""}${
          groupName ? ` in group ${groupName}` : ""
        }. Client certificate bundle ${
          certBundleReady ? "was prepared successfully" : "could not be fully prepared"
        }${certError ? `: ${certError}` : ""}.`,
      },
    });

    res.json({ success: true, certBundleReady, certError, dataFeedError, ...result });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/:userId/certs/download", async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await users.getUserById(userId);
    const username = String(user?.username || "").toLowerCase();
    if (!username.startsWith("nodered-")) {
      return res.status(403).json({ error: "Not an integration user." });
    }

    const certPaths = await takSshSvc.getOrProvisionIntegrationCertFiles(username);
    if (!certPaths || !certPaths.pemPath || !certPaths.keyPath) {
      return res.status(404).json({ error: "Integration cert files not available." });
    }
    if (!fs.existsSync(certPaths.pemPath) || !fs.existsSync(certPaths.keyPath)) {
      return res.status(404).json({ error: "Integration cert files not found on disk." });
    }

    const safeName = String(username).replace(/[^a-z0-9-]/g, "");
    const includesP12 =
      !!(certPaths.p12Path && fs.existsSync(certPaths.p12Path));
    const fileList = includesP12
      ? `${safeName}.pem, ${safeName}.key, ${safeName}.p12`
      : `${safeName}.pem, ${safeName}.key`;
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action: "DOWNLOAD_INTEGRATION_CERT_BUNDLE",
      targetType: "user",
      targetId: String(userId),
      details: {
        username,
        displayName: String(user?.name || "").trim() || undefined,
        zipFileName: `${safeName}-certs.zip`,
        filesIncluded: includesP12 ? ["pem", "key", "p12"] : ["pem", "key"],
        summary: `Downloaded integration certificate bundle for ${username} (${fileList} in zip).`,
      },
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-certs.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try {
        if (!res.headersSent) {
          res.status(500).json({ error: err?.message || String(err) });
          return;
        }
        res.end();
      } catch (_) {}
    });
    archive.pipe(res);
    archive.file(certPaths.pemPath, { name: `${safeName}.pem` });
    archive.file(certPaths.keyPath, { name: `${safeName}.key` });
    if (certPaths.p12Path && fs.existsSync(certPaths.p12Path)) {
      archive.file(certPaths.p12Path, { name: `${safeName}.p12` });
    }
    archive.finalize();
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

/**
 * PUT /api/integrations/:userId/group
 * Set the integration user's group (replaces current). Only for nodered- users; bypasses action lock.
 */
router.put("/:userId/group", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { groupId } = req.body || {};
    const user = await users.getUserById(userId);
    const username = String(user?.username || "").toLowerCase();
    if (!username.startsWith("nodered-")) {
      return res.status(403).json({ error: "Not an integration user." });
    }
    const groupIdStr = String(groupId || "").trim();
    if (!groupIdStr) return res.status(400).json({ error: "groupId required." });
    await users.setUserGroups(userId, [groupIdStr], { ignoreLocks: true });
    const authUser = req.authentikUser || null;
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "SET_INTEGRATION_GROUP",
      targetType: "user",
      targetId: String(userId),
      details: {
        username: user?.username,
        groupId: groupIdStr,
        summary: `Changed integration user ${user?.username || userId} to Authentik group id ${groupIdStr}.`,
      },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

/**
 * DELETE /api/integrations/:userId
 * Delete the integration user. Only for nodered- users; bypasses action lock.
 */
router.delete("/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await users.getUserById(userId);
    const username = String(user?.username || "").toLowerCase();
    if (!username.startsWith("nodered-")) {
      return res.status(403).json({ error: "Not an integration user." });
    }

    const dataFeedName = user.attributes?.tak_data_feed_name;
    if (dataFeedName && takSvc.isTakConfigured()) {
       try {
           const takClient = takSvc.buildTakAxios();
           await takClient.delete(`/api/datafeeds/${encodeURIComponent(dataFeedName)}`);
       } catch (err) {
           console.warn(`Failed to inherently delete associated data feed '${dataFeedName}' for user '${username}':`, err.message);
       }
    }

    await takSshSvc.revokeIntegrationCertViaSshScript(username);
    await users.deleteUser(userId, { ignoreLocks: true });
    const authUser = req.authentikUser || null;
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "DELETE_INTEGRATION_USER",
      targetType: "user",
      targetId: String(userId),
      details: {
        username: user?.username,
        sshRevokeScript: "ok",
        summary: `Deleted integration user ${user?.username || userId} and revoked its TAK client certificate on the server.`,
      },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

/**
 * GET /api/integrations/:username/datafeed
 * Fetches the upstream TAK Server Data Feed payload for a matching integration.
 */
router.get("/:username/datafeed", async (req, res) => {
  try {
    const list = await users.findIntegrationUsers();
    const user = list.find((u) => u.username === req.params.username);
    if (!user) {
      return res.status(404).json({ error: "Integration user not found." });
    }

    const dataFeedName = user.attributes?.tak_data_feed_name;
    if (!dataFeedName) {
      return res.status(404).json({ error: "No Data Feed is associated with this integration." });
    }

    if (!takSvc.isTakConfigured()) {
      return res.status(503).json({ error: "TAK Server connection is not configured." });
    }

    const takClient = takSvc.buildTakAxios();
    // TAK API: GET /api/datafeeds/{name}
    const dfRes = await takClient.get(`/api/datafeeds/${encodeURIComponent(dataFeedName)}`);
    const dataFeedPayload = dfRes.data?.data || dfRes.data;
    
    res.json({ dataFeed: dataFeedPayload });
  } catch (err) {
    console.error("Error pulling retroactive Data Feed properties:", err);
    let msg = err.message || "Failed reading from upstream Data Feed API";
    if (err.response && err.response.data) {
       msg += " | " + (typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : String(err.response.data));
    }
    return res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/integrations/:username/datafeed
 * Creates a TAK Server Data Feed retroactively for an integration that doesn't have one.
 */
router.post("/:username/datafeed", async (req, res) => {
  try {
    const list = await users.findIntegrationUsers();
    const user = list.find((u) => u.username === req.params.username);
    if (!user) {
      return res.status(404).json({ error: "Integration user not found." });
    }

    if (user.attributes?.tak_data_feed_name) {
      return res.status(400).json({ error: "Integration already has an associated Data Feed." });
    }

    const { protocol, authType, port, coreVersion, coreVersion2TlsVersions, multicastGroup, iface, syncCacheRetention, archive, anongroup, archiveOnly, sync, federated, tags, filterGroups } = req.body || {};

    const titleForFeed = String(user.attributes?.integration_title || "").trim();
    if (!titleForFeed) {
      return res.status(400).json({
        error:
          "This integration has no stored title; cannot create a data feed name. Recreate the integration or set integration_title in Authentik.",
      });
    }

    let dataFeedName;
    try {
      dataFeedName = users.getStreamingDataFeedNameForTitle(titleForFeed);
    } catch (e) {
      return res.status(400).json({ error: toErrorPayload(e) });
    }

    if (!takSvc.isTakConfigured()) {
      return res.status(503).json({ error: "TAK Server connection is not configured." });
    }

    const payloadTags = tags ? tags.split(/[\n,]+/).map(t => t.trim()).filter(Boolean) : [];
    const strippedGroups = Array.isArray(filterGroups) ? filterGroups.map(stripTakPrefix) : [];
    
    const dataFeedPayload = {
      type: "Streaming",
      name: dataFeedName,
      protocol: protocol || "tls",
      auth: authType || "X_509",
      port: port ? parseInt(port, 10) : 8089,
      coreVersion: coreVersion || "2",
      coreVersion2TlsVersions: coreVersion2TlsVersions || "",
      group: multicastGroup || "",
      iface: iface || "",
      syncCacheRetentionSeconds: syncCacheRetention ? String(syncCacheRetention) : "3600",
      archive: archive === "true",
      anongroup: anongroup === "true",
      archiveOnly: archiveOnly === "true",
      sync: sync === "true",
      federated: federated === "true",
      tag: payloadTags,
      filtergroup: strippedGroups
    };

    const takClient = takSvc.buildTakAxios();
    await takClient.post("/api/datafeeds", dataFeedPayload);

    await users.updateUserAttributes(user.pk, {
      tak_data_feed_name: dataFeedName,
      tak_data_feed_port: dataFeedPayload.port,
    });

    res.json({ message: "Data Feed successfully created and bound to Integration." });
  } catch (err) {
    const upstreamError = err?.response?.data?.message || err?.message || String(err);
    res.status(500).json({ error: "TAK Server Error: " + upstreamError });
  }
});

module.exports = router;
