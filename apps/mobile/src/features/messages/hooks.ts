import type { components } from '@mehfil/api-client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../lib/api';

export type Message = components['schemas']['Message'];
export type AudienceSpec = components['schemas']['AudienceSpec'];
export type AudiencePreview = components['schemas']['AudiencePreview'];
export type MessageTemplate = components['schemas']['MessageTemplate'];

export const msgKeys = {
  list: (w: string) => ['wedding', w, 'messages'] as const,
  one: (w: string, m: string) => ['wedding', w, 'message', m] as const,
  preview: (w: string, m: string, v: number) => ['wedding', w, 'message', m, 'preview', v] as const,
  audience: (w: string, a: AudienceSpec) => ['wedding', w, 'audience', a] as const,
  templates: (w: string) => ['wedding', w, 'message-templates'] as const,
};

export function useMessages(weddingId: string) {
  return useQuery({
    queryKey: msgKeys.list(weddingId),
    queryFn: async (): Promise<Message[]> => unwrap(await api.GET('/v1/weddings/{weddingId}/messages', { params: { path: { weddingId }, query: {} } })).items,
    // Poll while something is going out; MSG-06 switches this to SSE progress.
    refetchInterval: (q) => (q.state.data?.some((m) => m.status === 'resolving' || m.status === 'sending') ? 3000 : false),
  });
}

export function useMessage(weddingId: string, messageId: string | null) {
  return useQuery({
    enabled: !!messageId,
    queryKey: msgKeys.one(weddingId, messageId ?? ''),
    queryFn: async (): Promise<Message> => unwrap(await api.GET('/v1/weddings/{weddingId}/messages/{messageId}', { params: { path: { weddingId, messageId: messageId! } } })),
  });
}

export function useMessageTemplates(weddingId: string) {
  return useQuery({
    queryKey: msgKeys.templates(weddingId),
    queryFn: async (): Promise<MessageTemplate[]> => unwrap(await api.GET('/v1/weddings/{weddingId}/message-templates', { params: { path: { weddingId }, query: {} } })).items,
    staleTime: 10 * 60_000,
  });
}

/** Live recipient count while the host picks an audience. */
export function useAudiencePreview(weddingId: string, audience: AudienceSpec, templateKey: string | null) {
  return useQuery({
    queryKey: [...msgKeys.audience(weddingId, audience), templateKey],
    queryFn: async (): Promise<AudiencePreview> =>
      unwrap(
        await api.POST('/v1/weddings/{weddingId}/messages/audience-preview', {
          params: { path: { weddingId } },
          body: { audience, templateKey: templateKey ?? undefined, channels: ['whatsapp', 'push'] },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useMessagePreview(weddingId: string, message: Message | undefined) {
  return useQuery({
    enabled: !!message,
    queryKey: msgKeys.preview(weddingId, message?.id ?? '', message?.version ?? 0),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/weddings/{weddingId}/messages/{messageId}/preview', {
          params: { path: { weddingId, messageId: message!.id }, query: { language: message!.sourceLanguage } },
        }),
      ),
  });
}

export interface DraftFields {
  templateKey: string;
  title: string;
  bodyText: string;
  audience: AudienceSpec;
}

/** Creates the draft (with the composer's stable Idempotency-Key) or saves a new version of it. */
export function useSaveDraft(weddingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { fields: DraftFields; idempotencyKey: string; existing: Message | null }): Promise<Message> => {
      const body = { ...input.fields, title: input.fields.title || null };
      if (input.existing) {
        return unwrap(
          await api.PATCH('/v1/weddings/{weddingId}/messages/{messageId}', {
            params: { path: { weddingId, messageId: input.existing.id } },
            body: { ...body, version: input.existing.version },
          }),
        );
      }
      return unwrap(
        await api.POST('/v1/weddings/{weddingId}/messages', {
          params: { path: { weddingId } },
          headers: { 'Idempotency-Key': input.idempotencyKey },
          body,
        }),
      );
    },
    onSuccess: (m) => {
      qc.setQueryData(msgKeys.one(weddingId, m.id), m);
      void qc.invalidateQueries({ queryKey: msgKeys.list(weddingId) });
    },
  });
}

export function useSendTest(weddingId: string) {
  return useMutation({
    mutationFn: async (messageId: string) =>
      unwrap(await api.POST('/v1/weddings/{weddingId}/messages/{messageId}/test', { params: { path: { weddingId, messageId } } })),
  });
}

/** Sends a saved draft now. The key is derived from the composer's draft key, so a retry after a lost response can't send twice. */
export function useSendMessage(weddingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { messageId: string; idempotencyKey: string }) =>
      unwrap(
        await api.POST('/v1/weddings/{weddingId}/messages/{messageId}/send', {
          params: { path: { weddingId, messageId: input.messageId } },
          headers: { 'Idempotency-Key': input.idempotencyKey },
          body: {},
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: msgKeys.list(weddingId) });
      void qc.invalidateQueries({ queryKey: ['wedding', weddingId, 'message'] });
    },
  });
}

export type MessageSummary = components['schemas']['MessageSummary'];
export type MessageDelivery = components['schemas']['MessageDelivery'];

export function useMessageSummary(weddingId: string, messageId: string) {
  return useQuery({
    queryKey: [...msgKeys.one(weddingId, messageId), 'summary'],
    queryFn: async (): Promise<MessageSummary> =>
      unwrap(await api.GET('/v1/weddings/{weddingId}/messages/{messageId}/summary', { params: { path: { weddingId, messageId } } })),
  });
}

export function useFailedDeliveries(weddingId: string, messageId: string) {
  return useQuery({
    queryKey: [...msgKeys.one(weddingId, messageId), 'deliveries', 'failed'],
    queryFn: async (): Promise<MessageDelivery[]> =>
      unwrap(
        await api.GET('/v1/weddings/{weddingId}/messages/{messageId}/deliveries', { params: { path: { weddingId, messageId }, query: { status: 'failed' } } }),
      ).items,
  });
}

export function useRetryFailed(weddingId: string, messageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/v1/weddings/{weddingId}/messages/{messageId}/retry-failed', { params: { path: { weddingId, messageId } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: msgKeys.one(weddingId, messageId) });
      void qc.invalidateQueries({ queryKey: msgKeys.list(weddingId) });
    },
  });
}
