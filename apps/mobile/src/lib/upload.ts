import { api, ApiError, unwrap } from './api';
import { config } from './config';

/** CAM-01a flow: ask for a presigned PUT, upload the bytes straight to storage, confirm. */
export async function uploadFile(weddingId: string, purpose: 'import' | 'cover', file: { type: string; size: number; body: Blob }) {
  const ticket = unwrap(
    await api.POST('/v1/weddings/{weddingId}/uploads', {
      params: { path: { weddingId } },
      body: { purpose, contentType: file.type, byteSize: file.size },
    }),
  );
  const url = ticket.uploadUrl.startsWith('/') ? `${config.apiUrl}${ticket.uploadUrl}` : ticket.uploadUrl;
  const put = await fetch(url, { method: 'PUT', headers: ticket.headers, body: file.body });
  if (!put.ok) throw new ApiError('UPLOAD_FAILED', 'Upload failed. Check your connection and try again.', put.status);
  unwrap(await api.POST('/v1/uploads/{mediaId}/complete', { params: { path: { mediaId: ticket.mediaId } } }));
  return ticket.mediaId;
}
