/** Permission matrix (ROL-02a, docs/architecture/10-rol.md §4.1). One file for the API and the app. */
export const WEDDING_ROLES = ['owner', 'co_host', 'planner_member', 'desk_staff'] as const;
export type WeddingRole = (typeof WEDDING_ROLES)[number];
export type Role = WeddingRole | 'guest';

export const ACTIONS = [
  'wedding.read', 'wedding.update', 'wedding.settings.update', 'wedding.delete', 'wedding.transfer_ownership',
  'event.read', 'event.write', 'venue.write', 'contact.write',
  'guest.read', 'guest.contact.read', 'guest.write', 'group.write', 'guest.import', 'guest.merge', 'guest.export',
  'link.rotate', 'rsvp.read', 'rsvp.headcount', 'rsvp.write_on_behalf', 'rsvp.self',
  'travel.read', 'travel.read_logistics', 'travel.write', 'travel.self',
  'arrival.read', 'arrival.checkin', 'arrival.self',
  'message.read', 'message.send', 'message.inbox.self',
  'media.upload', 'gallery.read', 'media.moderate', 'album.download',
  'pickup.read', 'pickup.write', 'room.read', 'room.write', 'idv.view', 'idv.self',
  'team.read', 'team.invite', 'team.remove', 'audit.read', 'billing.manage',
  'privacy.delete_guest', 'privacy.request.self',
] as const;
export type Action = (typeof ACTIONS)[number];

const HOST_ALL: Action[] = ACTIONS.filter(
  (a) => !a.endsWith('.self') && a !== 'rsvp.headcount' && a !== 'travel.read_logistics',
);
const without = (list: Action[], drop: Action[]) => list.filter((a) => !drop.includes(a));

export const MATRIX: Record<Role, ReadonlySet<Action>> = {
  owner: new Set(HOST_ALL),
  co_host: new Set(without(HOST_ALL, ['wedding.delete', 'wedding.transfer_ownership', 'billing.manage', 'idv.view'])),
  planner_member: new Set(without(HOST_ALL, ['wedding.delete', 'wedding.transfer_ownership', 'privacy.delete_guest', 'idv.view'])),
  desk_staff: new Set<Action>([
    'wedding.read', 'event.read', 'guest.read', 'rsvp.headcount', 'travel.read_logistics',
    'arrival.read', 'arrival.checkin', 'media.upload', 'gallery.read', 'pickup.read', 'room.read',
  ]),
  guest: new Set<Action>([
    'rsvp.self', 'travel.self', 'arrival.self', 'message.inbox.self', 'media.upload',
    'gallery.read', 'idv.self', 'privacy.request.self',
  ]),
};

export const can = (role: Role, action: Action): boolean => MATRIX[role].has(action);

/** Who may grant which role (team.invite / team.remove / role change). */
const ASSIGNABLE: Record<WeddingRole, readonly WeddingRole[]> = {
  owner: ['co_host', 'planner_member', 'desk_staff'],
  co_host: ['planner_member', 'desk_staff'],
  planner_member: ['desk_staff'],
  desk_staff: [],
};
export const canAssign = (actor: WeddingRole, target: WeddingRole): boolean => ASSIGNABLE[actor].includes(target);

export function isWeddingRole(value: string): value is WeddingRole {
  return (WEDDING_ROLES as readonly string[]).includes(value);
}
