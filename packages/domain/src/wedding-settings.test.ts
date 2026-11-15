import { mergeSettings, readSettings, WeddingSettingsV1 } from './wedding-settings';

describe('wedding settings (SET-06)', () => {
  it('fills defaults from an empty object', () => {
    expect(WeddingSettingsV1.parse({})).toEqual({
      camera: { shotLimit: 24, limitScope: 'wedding', revealMode: 'next_morning', revealAt: null },
      language: { default: 'en' },
      branding: { palette: null },
      guests: { phoneDefaultRegion: 'IN' },
    });
  });

  it('is strict and requires revealAt for scheduled reveals', () => {
    expect(WeddingSettingsV1.safeParse({ camera: { flash: true } }).success).toBe(false);
    const r = WeddingSettingsV1.safeParse({ camera: { revealMode: 'scheduled' } });
    expect(r.success).toBe(false);
  });

  it('deep-merges patches', () => {
    expect(mergeSettings({ camera: { shotLimit: 24, limitScope: 'event' } }, { camera: { shotLimit: 36 }, language: { default: 'hi' } })).toEqual({
      camera: { shotLimit: 36, limitScope: 'event' },
      language: { default: 'hi' },
    });
  });

  it('reads legacy or partial stored settings without throwing', () => {
    const s = readSettings({ camera: { shotLimit: 12, reveal: 'instant' } });
    expect(s.camera.shotLimit).toBe(24); // invalid section falls back to defaults
    expect(readSettings({ camera: { shotLimit: 12 } }).camera.shotLimit).toBe(12);
  });
});
