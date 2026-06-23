const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = require("express").Router();
const mutualAid = require("../services/mutualAid.service");
const emailSvc = require("../services/email.service");
const auditSvc = require("../services/auditLog.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

const MA_LOGO_DIR = path.join(__dirname, "..", "data", "mutual-aid-logos");

const uploadMaLogo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        if (!fs.existsSync(MA_LOGO_DIR)) {
          fs.mkdirSync(MA_LOGO_DIR, { recursive: true });
        }
        cb(null, MA_LOGO_DIR);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
      const safeExt = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
        ? ext
        : ".png";
      cb(null, `upload-${Date.now()}-${Math.random().toString(16).slice(2)}${safeExt}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif)$/i.test(String(file.mimetype || ""));
    cb(null, ok);
  },
});

const uploadPacketPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      String(file.originalname || "").toLowerCase().endsWith(".pdf");
    cb(null, ok);
  },
});

function toErrorPayload(err) {
  return toSafeApiError(err);
}

router.get("/", (req, res) => {
  try {
    const out = mutualAid.list();
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const out = await mutualAid.create({
      type: req.body?.type,
      title: req.body?.title,
      expireEnabled: req.body?.expireEnabled,
      expireAt: req.body?.expireAt,
      groupMode: req.body?.groupMode,
      existingGroupId: req.body?.existingGroupId,
    });

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_MUTUAL_AID",
      targetType: "mutual_aid",
      targetId: String(out?.id || ""),
      details: {
        type: out?.type,
        title: out?.title,
        expireEnabled: !!out?.expireEnabled,
        expireAt: out?.expireAt || null,
        groupMode: out?.groupMode,
        existingGroupId: out?.existingGroupId,
        groupName: out?.groupName,
      },
    });

    res.json({ success: true, item: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/:id/additional-user", async (req, res) => {
  try {
    const out = await mutualAid.createLinkedUser({
      parentId: req.params.id,
      title: req.body?.title,
      expireEnabled: req.body?.expireEnabled,
      expireAt: req.body?.expireAt,
    });

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_MUTUAL_AID_LINKED_USER",
      targetType: "mutual_aid",
      targetId: String(out?.id || ""),
      details: {
        parentId: String(req.params.id),
        type: out?.type,
        title: out?.title,
        groupId: out?.groupId,
        groupName: out?.groupName,
        groupMasterId: out?.groupMasterId,
      },
    });

    res.json({ success: true, item: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.patch("/:id", uploadMaLogo.single("logo"), async (req, res) => {
  try {
    const before = mutualAid.list().find((x) => String(x?.id) === String(req.params.id)) || null;
    const removeLogo =
      req.body?.removeLogo === true ||
      req.body?.removeLogo === "true" ||
      req.body?.removeLogo === "1";
    const out = await mutualAid.update({
      id: req.params.id,
      type: req.body?.type,
      title: req.body?.title,
      expireEnabled: req.body?.expireEnabled,
      expireAt: req.body?.expireAt,
      logoFile: req.file || null,
      removeLogo,
    });

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_MUTUAL_AID",
      targetType: "mutual_aid",
      targetId: String(req.params.id),
      details: { before, after: out },
    });

    res.json({ success: true, item: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const before = mutualAid.list().find((x) => String(x?.id) === String(req.params.id)) || null;
    const out = await mutualAid.remove({ id: req.params.id });

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "DELETE_MUTUAL_AID",
      targetType: "mutual_aid",
      targetId: String(req.params.id),
      details: before,
    });

    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/:id/qr", async (req, res) => {
  try {
    const out = await mutualAid.getQr({ id: req.params.id });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/:id/qr/download", async (req, res) => {
  try {
    const out = await mutualAid.getQrDownload({ id: req.params.id });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.send(out.pngBuffer);
  } catch (err) {
    res.status(400).send(toErrorPayload(err));
  }
});


router.post("/:id/packet/email", (req, res, next) => {
  uploadPacketPdf.single("pdf")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error:
            "Deployment packet is too large to email (max 25 MB). Try downloading it instead.",
        });
      }
      return res.status(400).json({ error: toErrorPayload(err) });
    }
    next();
  });
}, async (req, res) => {
  try {
    const id = req.params.id;
    const toRaw = req.body?.to || req.body?.emails || "";
    const pdfBase64 = req.body?.pdfBase64 || "";
    const filename = req.body?.filename || req.file?.originalname || "deployment-packet.pdf";

    if (!toRaw || !String(toRaw).trim()) {
      return res.status(400).json({ error: "Missing recipient email(s)" });
    }

    let pdfBuffer = req.file?.buffer || null;
    if (!pdfBuffer && pdfBase64 && String(pdfBase64).trim()) {
      pdfBuffer = Buffer.from(String(pdfBase64), "base64");
    }
    if (!pdfBuffer || !pdfBuffer.length) {
      return res.status(400).json({ error: "Missing PDF payload" });
    }

    const emailCfg = emailSvc.getSmtpConfig();
    if (!emailSvc.isEmailEnabled() || !emailCfg.host || !emailCfg.from) {
      return res.status(400).json({
        error: "Email is disabled or SMTP is not configured.",
      });
    }

    // Find the mutual aid item for context
    const items = mutualAid.list();
    const item = items.find((x) => String(x.id) === String(id));

    const subject = item
      ? `TAK Deployment Packet — ${item.type} — ${item.title}`
      : "TAK Deployment Packet";

    const text =
      (item
        ? `Deployment packet for ${item.type} — ${item.title}
Group: ${item.groupName}
Username: ${item.username}

Attached: ${filename}
`
        : `Deployment packet attached: ${filename}
`) +
      `
Sent from TAK Portal.
`;

    const out = await emailSvc.sendMail({
      to: String(toRaw),
      subject,
      text,
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    if (!out.sent) {
      if (out.skipped) {
        return res.status(400).json({ error: "Email is disabled (EMAIL_ENABLED=false)" });
      }
      return res.status(500).json({ error: out.error || "Email send failed" });
    }

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "EMAIL_MUTUAL_AID_PACKET",
      targetType: "mutual_aid",
      targetId: String(id),
      details: {
        to: String(toRaw),
        filename: String(filename),
        mutualAidType: item?.type,
        mutualAidTitle: item?.title,
        groupName: item?.groupName,
        username: item?.username,
        summary: item
          ? `Emailed mutual aid packet for ${item.type} — ${item.title}.`
          : "Emailed mutual aid deployment packet.",
      },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
