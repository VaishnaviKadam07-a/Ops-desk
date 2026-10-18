// Pure authorization + workflow rules. No I/O here, so they are cheap to unit test.
// Every mutating route calls these on the server; the UI only mirrors them for convenience.
import { forbidden, HttpError, notFound } from './errors.js';

const RANK = { viewer: 1, member: 2, lead: 3 };

export const roleIn = (user, teamId) => user.teams[teamId] || null;
const atLeast = (role, min) => role && RANK[role] >= RANK[min];

/** Items in teams the user doesn't belong to are reported as 404 (no existence leak). */
export function requireRead(user, item) {
  if (!roleIn(user, item.team_id)) throw notFound('Item');
}

export function can(user, action, item) {
  const role = roleIn(user, item.team_id);
  const isOwner = item.creator_id === user.id || item.assignee_id === user.id;
  switch (action) {
    case 'comment':   return atLeast(role, 'member');
    case 'claim':     return atLeast(role, 'member') && item.assignee_id == null;
    // Members may only change items they created or hold; leads may change any item in the team.
    case 'edit':      return role === 'lead' || (atLeast(role, 'member') && isOwner);
    case 'release':   return role === 'lead' || item.assignee_id === user.id;
    case 'assign':    return role === 'lead';
    case 'transition':return role === 'lead' || item.assignee_id === user.id;
    // Separation of duties: nobody approves their own request.
    case 'approve':   return role === 'lead' && item.creator_id !== user.id;
    default:          return false;
  }
}

export function require(user, action, item) {
  requireRead(user, item);
  if (!can(user, action, item)) throw forbidden(`Not allowed to ${action} this item`);
}

// ---- Workflow ----
export const TRANSITIONS = {
  open:        ['in_progress', 'blocked', 'closed'],
  in_progress: ['blocked', 'resolved', 'open'],
  blocked:     ['in_progress', 'open'],
  resolved:    ['closed', 'in_progress'],
  closed:      [],
};

export function checkTransition(user, item, to) {
  const allowed = TRANSITIONS[item.status] || [];
  if (!allowed.includes(to)) {
    throw new HttpError(422, 'invalid_transition', `Cannot move from ${item.status} to ${to}`, { allowed });
  }
  if (['in_progress', 'resolved'].includes(to) && item.assignee_id == null) {
    throw new HttpError(422, 'needs_assignee', 'Claim or assign the item before working on it');
  }
  if (to === 'in_progress' && item.requires_approval && item.approval_state !== 'approved') {
    throw new HttpError(422, 'needs_approval', 'This item needs approval before work can start');
  }
  if (to === 'closed' && roleIn(user, item.team_id) !== 'lead') {
    throw forbidden('Only a team lead can close an item');
  }
}
