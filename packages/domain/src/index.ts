/** Wedding-team roles; the permission matrix lands in permissions.ts with ROL-02a. */
export const WEDDING_ROLES = ['owner', 'co_host', 'planner_member', 'desk_staff'] as const;
export type WeddingRole = (typeof WEDDING_ROLES)[number];

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
