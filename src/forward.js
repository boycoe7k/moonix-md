// Makes every outgoing message show "Forwarded" + the channel header
// ("Forwarded from <channel>") by attaching forwardedNewsletterMessageInfo.
// The channel's JID is looked up once from its invite code (override with CHANNEL_JID).
const CHANNEL_CODE = process.env.CHANNEL_INVITE_CODE || "0029VbBxPYN2kNFj3I1H1e0f";
const CHANNEL_NAME = process.env.CHANNEL_NAME || "Moonix MD";
let cached = process.env.CHANNEL_JID ? { jid: process.env.CHANNEL_JID, name: CHANNEL_NAME } : null;

async function resolveChannel(sock) {
  if (cached) return cached;
  try {
    const meta = await sock.newsletterMetadata("invite", CHANNEL_CODE);
    if (meta?.id) cached = { jid: meta.id, name: meta.name || meta.thread_metadata?.name?.text || CHANNEL_NAME };
  } catch (_) {}
  return cached; // null -> messages simply go out without the forward header
}

async function forwardContext(sock) {
  const ch = await resolveChannel(sock);
  if (!ch) return undefined;
  return { isForwarded: true, forwardingScore: 999, forwardedNewsletterMessageInfo: { newsletterJid: ch.jid, newsletterName: ch.name, serverMessageId: -1 } };
}

function wrapForward(sock) {
  sock.forwardContext = () => forwardContext(sock);
  const send = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options) => {
    const skip = !content || content.react || content.delete || content.forward || content.edit || content.poll;
    if (!skip && !String(jid).endsWith("@newsletter")) {
      const ch = await resolveChannel(sock);
      if (ch) {
        content = {
          ...content,
          contextInfo: {
            ...(content.contextInfo || {}),
            isForwarded: true,
            forwardingScore: 999,
            forwardedNewsletterMessageInfo: { newsletterJid: ch.jid, newsletterName: ch.name, serverMessageId: -1 },
          },
        };
      }
    }
    return send(jid, content, options);
  };
  return sock;
}

module.exports = { wrapForward };
