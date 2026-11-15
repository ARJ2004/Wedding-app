import { WEDDING_ROLES } from './index';

test('wedding roles match the core schema check constraint', () => {
  expect(WEDDING_ROLES).toEqual(['owner', 'co_host', 'planner_member', 'desk_staff']);
});
