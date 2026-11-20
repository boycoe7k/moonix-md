// Anti-ban layer. Wraps a Baileys socket so outgoing traffic looks human:
//  - every send goes through one queue per session (never parallel bursts)
//  - random gap between sends, typing indicator scaled to message length
//  - hard cap on messages per minute / hour (excess is queued, not dropped)
//  - per-user command cooldown, and old/backlog messages are ignored
// All numbers are overridable by env vars.
const num = (k, d) => (Number.isFinite(parseInt(process.env[k], 10)) ? parseInt(process.env[k], 10) : d);

const CFG = {
  minGap: num("ANTIBAN_MIN_DELAY_MS", 1200),
  maxGap: num("ANTIBAN_MAX_DELAY_MS", 3200),
  perMinute: num("ANTIBAN_MAX_PER_MINUTE", 18),
  perHour: num("ANTIBAN_MAX_PER_HOUR", 400),
  cooldown: num("ANTIBAN_COOLDOWN_MS", 2500),
  maxTyping: num("ANTIBAN_MAX_TYPING_MS", 3500),
  maxAgeSec: num("ANTIBAN_MAX_MSG_AGE_SEC", 60),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function wrapSocket(sock) {
  if (sock.__antiban) return sock;
  sock.__antiban = true;
  const stamps = []; // send timestamps for rate caps
  let chain = Promise.resolve();
  let lastSend = 0;

  async function throttle() {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > 3600000) stamps.shift();
      const lastMin = stamps.filter((t) => now - t < 60000).length;
      if (lastMin < CFG.perMinute && stamps.length < CFG.perHour) break;
      await sleep(2000);
    }
    const gap = rand(CFG.minGap, CFG.maxGap) - (Date.now() - lastSend);
    if (gap > 0) await sleep(gap);
    lastSend = Date.now();
    stamps.push(lastSend);
  }

  const origSend = sock.sendMessage.bind(sock);
  const origRelay = sock.relayMessage.bind(sock);

  const queued = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  sock.sendMessage = (jid, content, options) => {
    // reactions, deletes and status reads are cheap/silent: light delay only
    const quiet = content && (content.react || content.delete);
    return queued(async () => {
      if (quiet) await sleep(rand(300, 900));
      else {
        await throttle();
        try {
          if (!String(jid).endsWith("status@broadcast")) {
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate(content?.audio && content?.ptt ? "recording" : "composing", jid);
            const len = (content?.text || content?.caption || "").length;
            await sleep(Math.min(CFG.maxTyping, 500 + len * 25 + rand(0, 600)));
            await sock.sendPresenceUpdate("paused", jid);
          }
        } catch (_) {}
      }
      return origSend(jid, content, options);
    });
  };

  sock.relayMessage = (jid, message, options) =>
    queued(async () => {
      await throttle();
      return origRelay(jid, message, options);
    });

  return sock;
}

// Per-user command cooldown. Returns true if the command may run.
const lastCmd = new Map();
function allowCommand(userJid) {
  const now = Date.now();
  const last = lastCmd.get(userJid) || 0;
  if (now - last < CFG.cooldown) return false;
  lastCmd.set(userJid, now);
  if (lastCmd.size > 5000) for (const [k, t] of lastCmd) if (now - t > 60000) lastCmd.delete(k);
  return true;
}

// True for messages too old to answer (reconnect backlog replies look like a bot).
function isStale(msg) {
  const ts = Number(msg?.messageTimestamp?.low ?? msg?.messageTimestamp ?? 0);
  return ts > 0 && Date.now() / 1000 - ts > CFG.maxAgeSec;
}

module.exports = { wrapSocket, allowCommand, isStale, CFG };
