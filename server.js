const express = require("express");
const path = require("path");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3000;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn(
    "Missing VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY before sending push.",
  );
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const subscriptions = new Map();

app.get("/api/vapid-public-key", (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription payload." });
  }

  subscriptions.set(subscription.endpoint, subscription);
  return res.status(201).json({ ok: true, subscribed: subscriptions.size });
});

app.post("/api/send-notification", async (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: "VAPID keys not configured." });
  }

  if (!subscriptions.size) {
    return res.status(404).json({ error: "No active subscriptions yet." });
  }

  const payload = JSON.stringify({
    title: req.body?.title || "Antivirus Scanner",
    body: req.body?.body || "Virus scan completed successfully.",
    icon: req.body?.icon || "/icon.png",
  });

  let sent = 0;
  const stale = [];
  for (const [endpoint, subscription] of subscriptions.entries()) {
    try {
      await webpush.sendNotification(subscription, payload);
      sent += 1;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        stale.push(endpoint);
      } else {
        console.error("Push send error:", error.message || error);
      }
    }
  }

  stale.forEach((endpoint) => subscriptions.delete(endpoint));
  return res.json({ ok: true, sent, staleRemoved: stale.length });
});

app.listen(PORT, () => {
  console.log(`Push backend running on http://localhost:${PORT}`);
});
