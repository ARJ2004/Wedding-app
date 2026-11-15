import { z } from 'zod';
import { AppError, mapError } from './errors';

describe('mapError', () => {
  it('keeps an AppError as given', () => {
    expect(mapError(new AppError('RSVP_CLOSED', 'RSVP is closed', 409))).toEqual({
      status: 409,
      body: { error: { code: 'RSVP_CLOSED', message: 'RSVP is closed' } },
    });
  });

  it('turns a ZodError into VALIDATION_FAILED with paths', () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 1 });
    const mapped = mapError(result.error);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe('VALIDATION_FAILED');
    expect(mapped.body.error.details).toEqual([{ path: 'name', message: expect.any(String) }]);
  });

  it('maps body-parser failures', () => {
    expect(mapError({ type: 'entity.parse.failed' }).body.error.code).toBe('INVALID_JSON');
    expect(mapError({ type: 'entity.too.large' }).status).toBe(413);
  });

  it('hides unknown errors behind INTERNAL', () => {
    const mapped = mapError(new Error('db password is hunter2'));
    expect(mapped).toEqual({ status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong' } } });
  });
});
