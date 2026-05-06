const express = require("express");
const path = require("path");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3000;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
const backendStartedAt = new Date().toISOString();

function logInfo(message, meta = {}) {
  console.log(`[push-backend][info] ${message}`, meta);
}

function logWarn(message, meta = {}) {
  console.warn(`[push-backend][warn] ${message}`, meta);
}

function logError(message, meta = {}) {
  console.error(`[push-backend][error] ${message}`, meta);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  logInfo("VAPID configured.", {
    subject: VAPID_SUBJECT,
    publicKeyPreview: `${VAPID_PUBLIC_KEY.slice(0, 10)}...`,
  });
} else {
  logWarn("Missing VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.");
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use((req, _res, next) => {
  logInfo("Incoming request", {
    method: req.method,
    path: req.path,
    origin: req.headers.origin || "n/a",
  });
  next();
});
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});

const subscriptions = new Map();

app.get("/api/vapid-public-key", (_req, res) => {
  logInfo("Serving VAPID public key.", { hasKey: Boolean(VAPID_PUBLIC_KEY) });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    vapidConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
    subscriptions: subscriptions.size,
  });
});

app.post("/api/subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    logWarn("Rejected invalid subscription payload.", {
      hasBody: Boolean(subscription),
    });
    return res.status(400).json({ error: "Invalid subscription payload." });
  }

  subscriptions.set(subscription.endpoint, subscription);
  logInfo("Subscription saved.", {
    endpointTail: subscription.endpoint.slice(-24),
    totalSubscriptions: subscriptions.size,
  });
  return res.status(201).json({ ok: true, subscribed: subscriptions.size });
});

app.post("/api/send-notification", async (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    logError("Send requested without VAPID config.");
    return res.status(500).json({ error: "VAPID keys not configured." });
  }

  if (!subscriptions.size) {
    logWarn("Send requested with zero subscriptions.");
    return res.status(404).json({ error: "No active subscriptions yet." });
  }

  const repeatCount = Math.max(1, Math.min(Number(req.body?.count) || 1, 20));
  const burstDelayMs = Math.max(100, Math.min(Number(req.body?.delayMs) || 350, 2000));
  const batchSize = Math.max(1, Math.min(Number(req.body?.batchSize) || 1, 5));

  let sent = 0;
  const stale = [];
  logInfo("Sending notification batch.", {
    targetSubscriptions: subscriptions.size,
    title: req.body?.title || "Antivirus Scanner",
    repeatCount,
    burstDelayMs,
    batchSize,
  });
  for (let round = 1; round <= repeatCount; round += batchSize) {
    const upperRound = Math.min(round + batchSize - 1, repeatCount);
    for (let currentRound = round; currentRound <= upperRound; currentRound += 1) {
    const payload = JSON.stringify({
      title: req.body?.title || "Antivirus Scanner",
      body: req.body?.body || "Virus scan completed successfully.",
      icon: req.body?.icon || "/icon.png",
      tag: `scan-${Date.now()}-${currentRound}`,
    });

      for (const [endpoint, subscription] of subscriptions.entries()) {
        try {
          await webpush.sendNotification(subscription, payload);
          sent += 1;
          logInfo("Push sent.", { endpointTail: endpoint.slice(-24), round: currentRound });
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            stale.push(endpoint);
            logWarn("Removing stale subscription.", {
              endpointTail: endpoint.slice(-24),
              statusCode: error.statusCode,
            });
          } else {
            logError("Push send error.", {
              endpointTail: endpoint.slice(-24),
              round: currentRound,
              statusCode: error.statusCode || "unknown",
              body: error.body || "n/a",
              message: error.message || String(error),
            });
          }
        }
      }
    }
    if (upperRound < repeatCount) {
      await sleep(burstDelayMs);
    }
  }

  stale.forEach((endpoint) => subscriptions.delete(endpoint));
  logInfo("Notification batch complete.", {
    sent,
    staleRemoved: stale.length,
    remainingSubscriptions: subscriptions.size,
  });
  return res.json({ ok: true, sent, staleRemoved: stale.length });
});

app.listen(PORT, () => {
  logInfo("Push backend started.", {
    url: `http://localhost:${PORT}`,
    startedAt: backendStartedAt,
  });
});
