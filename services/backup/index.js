"use strict";

const catalog = require("./catalog");
const jobs = require("./jobs");
const exportSvc = require("./export");
const importSvc = require("./import");
const files = require("./files");
const crypto = require("./crypto");

let _busy = false;

async function processJob(job) {
  const opts = job.options || {};
  const onProgress = async (progress) => {
    try {
      await jobs.updateProgress(job.id, progress);
    } catch (_) {}
  };
  if (job.kind === "backup_export") {
    const out = await exportSvc.runExport({
      categories: opts.categories,
      includeSecrets: !!opts.includeSecrets,
      passphrase: opts.passphrase,
      onProgress,
    });
    await jobs.completeJob(job.id, {
      artifactPath: out.artifactPath,
      result: {
        counts: out.counts,
        manifest: out.manifest,
        downloadName: out.downloadName,
      },
    });
    return;
  }
  if (job.kind === "backup_import") {
    const out = await importSvc.runImport({
      archivePath: opts.archivePath,
      passphrase: opts.passphrase,
      categories: opts.categories,
      mode: opts.mode,
      dryRun: !!opts.dryRun,
      includeSecrets: opts.includeSecrets,
      sendOnboardingEmail: !!opts.sendOnboardingEmail,
      onProgress,
    });
    await jobs.completeJob(job.id, { result: out });
    return;
  }
  throw new Error("Unknown backup job kind: " + job.kind);
}

async function runOnce() {
  if (_busy) return;
  let job;
  try {
    job = await jobs.claimNext();
  } catch (e) {
    console.warn("[backup] claim failed:", e?.message || e);
    return;
  }
  if (!job) return;
  _busy = true;
  try {
    await processJob(job);
  } catch (e) {
    console.error("[backup] job failed:", job.id, e?.message || e);
    try {
      await jobs.failJob(job.id, e?.message || e);
    } catch (_) {}
  } finally {
    _busy = false;
  }
}

module.exports = {
  catalog,
  jobs,
  files,
  crypto,
  exportSvc,
  importSvc,
  runOnce,
};
