/** SET-02 event presets. Changes ship with app releases; per-planner reuse is PLN-05 templates. */
export const EVENT_KINDS = ['haldi', 'mehendi', 'sangeet', 'baraat', 'pheras', 'reception', 'custom'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventPreset {
  kind: Exclude<EventKind, 'custom'>;
  defaultName: string;
  /** Local start time in the wedding timezone, HH:mm. */
  defaultStart: string;
  durationMinutes: number;
  dressCodeHint: string;
  icon: string;
}

export const EVENT_PRESETS: readonly EventPreset[] = [
  { kind: 'haldi', defaultName: 'Haldi', defaultStart: '10:00', durationMinutes: 180, dressCodeHint: 'Yellow', icon: 'sun' },
  { kind: 'mehendi', defaultName: 'Mehendi', defaultStart: '16:00', durationMinutes: 240, dressCodeHint: 'Green or pastels', icon: 'leaf' },
  { kind: 'sangeet', defaultName: 'Sangeet', defaultStart: '19:30', durationMinutes: 240, dressCodeHint: 'Indo-western', icon: 'music' },
  { kind: 'baraat', defaultName: 'Baraat', defaultStart: '17:00', durationMinutes: 120, dressCodeHint: 'Traditional', icon: 'horse' },
  { kind: 'pheras', defaultName: 'Pheras', defaultStart: '20:30', durationMinutes: 150, dressCodeHint: 'Traditional', icon: 'flame' },
  { kind: 'reception', defaultName: 'Reception', defaultStart: '19:00', durationMinutes: 240, dressCodeHint: 'Formal', icon: 'glass' },
];

export function presetFor(kind: EventKind): EventPreset | undefined {
  return EVENT_PRESETS.find((p) => p.kind === kind);
}
