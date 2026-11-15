import { decodeReply, encodeReplyPayload } from './codec';

describe('reply payload codec (MSG-11)', () => {
  const ref = 'abcdefgh23456723';
  it('round-trips action, reply ref and args', () => {
    const p = encodeReplyPayload('arr.running_late', ref, { minutesLate: '30' });
    expect(p).toBe(`arr.running_late|${ref}|minutesLate=30`);
    expect(decodeReply(p, 'Running late')).toEqual({ action: 'arr.running_late', replyRef: ref, args: { minutesLate: '30' } });
    expect(decodeReply(`rsv.attend|${ref}`, null)).toEqual({ action: 'rsv.attend', replyRef: ref, args: {} });
  });
  it('reads STOP / START keywords and ignores free text', () => {
    expect(decodeReply(null, ' Stop. ')?.action).toBe('msg.stop');
    expect(decodeReply(null, 'START')?.action).toBe('msg.start');
    expect(decodeReply(null, 'See you at the sangeet!')).toBeNull();
    expect(decodeReply('not a payload', 'hello')).toBeNull();
  });
  it('drops a malformed reply ref but keeps the action', () => {
    expect(decodeReply('rsv.attend|BAD', null)).toEqual({ action: 'rsv.attend', replyRef: undefined, args: {} });
    expect(() => encodeReplyPayload('RSV', ref)).toThrow();
  });
});
