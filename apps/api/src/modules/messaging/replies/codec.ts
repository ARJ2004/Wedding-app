/**
 * Button payload codec (MSG-11, 07-msg §4): "<action>|<reply_ref>[|k=v&k=v]".
 * Actions are "<module>.<verb>" (rsv.attend, arr.landed) or msg.stop / msg.start.
 */
const ACTION = /^[a-z]{2,8}\.[a-z_]{2,24}$/;
const REF = /^[a-z2-7]{16}$/;

export interface DecodedReply {
  action: string;
  replyRef?: string;
  args: Record<string, string>;
}

export function encodeReplyPayload(action: string, replyRef: string, args: Record<string, string> = {}): string {
  if (!ACTION.test(action) || !REF.test(replyRef)) throw new Error(`bad reply payload ${action}`);
  const extra = new URLSearchParams(args).toString();
  return extra ? `${action}|${replyRef}|${extra}` : `${action}|${replyRef}`;
}

const STOP = new Set(['stop', 'unsubscribe', 'stop all', 'band karo', 'बंद']);
const START = new Set(['start', 'subscribe', 'unstop']);

/** Decodes a button payload, or a STOP / START keyword typed as text. Anything else → null (free text). */
export function decodeReply(payload: string | null | undefined, text: string | null | undefined): DecodedReply | null {
  if (payload) {
    const [action = '', ref, extra] = payload.split('|');
    if (ACTION.test(action)) {
      return {
        action,
        replyRef: ref && REF.test(ref) ? ref : undefined,
        args: Object.fromEntries(new URLSearchParams(extra ?? '')),
      };
    }
  }
  const t = (text ?? '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (STOP.has(t)) return { action: 'msg.stop', args: {} };
  if (START.has(t)) return { action: 'msg.start', args: {} };
  return null;
}
