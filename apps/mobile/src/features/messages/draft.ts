import { create } from 'zustand';
import { kv } from '../../lib/kv';
import type { AudienceSpec } from './hooks';

/**
 * Composer draft kept on the phone (07-msg §6): the text survives an app restart, and the
 * Idempotency-Key stays the same until the server has the draft, so a dropped network can't
 * create it twice.
 */
export interface ComposerDraft {
  weddingId: string;
  messageId: string | null;
  idempotencyKey: string;
  templateKey: string;
  title: string;
  bodyText: string;
  audience: AudienceSpec;
}

const KEY = 'composer-draft.v1';
const newKey = () => `compose-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
export const emptyDraft = (weddingId: string): ComposerDraft => ({
  weddingId,
  messageId: null,
  idempotencyKey: newKey(),
  templateKey: 'announcement_text',
  title: '',
  bodyText: '',
  audience: {},
});

function read(): ComposerDraft | null {
  try {
    const raw = kv.getItem(KEY);
    return raw ? (JSON.parse(raw) as ComposerDraft) : null;
  } catch {
    return null;
  }
}

interface State {
  draft: ComposerDraft | null;
  /** Resumes the saved draft for this wedding and message, or starts a fresh one. */
  open(weddingId: string, messageId: string | null): ComposerDraft;
  update(patch: Partial<ComposerDraft>): void;
  clear(): void;
}

export const useComposerDraft = create<State>((set, get) => ({
  draft: null,
  open: (weddingId, messageId) => {
    const saved = read();
    const draft = saved && saved.weddingId === weddingId && saved.messageId === messageId ? saved : { ...emptyDraft(weddingId), messageId };
    set({ draft });
    return draft;
  },
  update: (patch) => {
    const cur = get().draft;
    if (!cur) return;
    const draft = { ...cur, ...patch };
    set({ draft });
    try {
      kv.setItem(KEY, JSON.stringify(draft));
    } catch {
      /* kv not ready (tests): memory only */
    }
  },
  clear: () => {
    set({ draft: null });
    try {
      kv.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
}));
