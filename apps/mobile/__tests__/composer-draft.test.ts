import { initKv, kv } from '../src/lib/kv';
import { useComposerDraft } from '../src/features/messages/draft';

describe('composer draft (MSG-03)', () => {
  beforeAll(async () => {
    await initKv();
  });

  it('survives a restart with the same Idempotency-Key until the server has it', () => {
    const first = useComposerDraft.getState().open('w1', null);
    useComposerDraft.getState().update({ bodyText: 'Buses at 4:15', audience: { groups: ['g1'] } });
    useComposerDraft.setState({ draft: null }); // app killed
    const resumed = useComposerDraft.getState().open('w1', null);
    expect(resumed).toMatchObject({ bodyText: 'Buses at 4:15', audience: { groups: ['g1'] }, idempotencyKey: first.idempotencyKey });

    const other = useComposerDraft.getState().open('w2', null); // another wedding starts fresh
    expect(other.bodyText).toBe('');
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);

    useComposerDraft.getState().clear();
    expect(kv.getItem('composer-draft.v1')).toBeNull();
  });
});
