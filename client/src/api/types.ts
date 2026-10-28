// Shapes returned by the API, kept by hand in step with the server's DTOs
// (server/src/shifts/dto.ts, programs/service.ts, dashboard/service.ts, alerts/service.ts).

export type Role = 'coordinator' | 'volunteer';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export type ShiftState = 'open' | 'partially_filled' | 'filled' | 'closed';

/** Dates and times are the organisation's wall-clock values: '2026-11-07', '09:00'. */
export interface Shift {
  id: number;
  programId: number;
  programName: string;
  programArchived: boolean;
  date: string;
  startTime: string;
  endTime: string;
  endDate: string | null;
  durationMinutes: number;
  location: string;
  requiredHeadcount: number;
  signupCount: number;
  spotsLeft: number;
  state: ShiftState;
  hasStarted: boolean;
  hasEnded: boolean;
  closedAt: string | null;
  deletedAt: string | null;
}

export interface ShiftListItem extends Shift {
  mySignupId: number | null;
}

export interface FinderResult {
  items: ShiftListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SignupSummary {
  id: number;
  volunteer: { id: number; name: string; email?: string };
  createdBy: { id: number; name: string };
  createdAt: string;
}

export interface ShiftDetail {
  shift: Shift;
  signups: SignupSummary[];
  mySignupId: number | null;
}

export type TimelineEventType =
  | 'created'
  | 'updated'
  | 'state_changed'
  | 'signup_created'
  | 'signup_cancelled'
  | 'note'
  | 'alert_dismissed'
  | 'deleted';

export interface TimelineEntry {
  id: number;
  type: TimelineEventType;
  actor: { id: number; name: string; role: Role };
  volunteer: { id: number; name: string } | null;
  fromState: ShiftState | null;
  toState: ShiftState | null;
  note: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface Program {
  id: number;
  name: string;
  description: string;
  archived: boolean;
  archivedAt: string | null;
  memberCount: number;
  upcomingShiftCount: number;
}

export interface MyProgram extends Program {
  shifts: ShiftListItem[];
}

export interface Member {
  id: number;
  name: string;
  email: string;
  addedAt: string;
  upcomingSignups: number;
}

export interface VolunteerOption {
  id: number;
  name: string;
  email: string;
}

export interface GenerateResult {
  created: Shift[];
  skipped: { date: string; reason: 'holiday' | 'already_exists' }[];
  unusedExclusions: string[];
}

type StateCounts = Record<ShiftState, number>;

export interface Dashboard {
  weekStart: string;
  weekEnd: string;
  headline: {
    shiftsThisWeek: number;
    openShiftsThisWeek: number;
    partiallyFilledThisWeek: number;
    signupsThisWeek: number;
    closedThisWeek: number;
  };
  byState: StateCounts;
  byProgram: ({ programId: number; name: string; total: number } & StateCounts)[];
  signupsPerWeek: { weekStart: string; signups: number }[];
}

export interface AlertsResponse {
  count: number;
  alerts: ShiftListItem[];
  dismissed: ShiftListItem[];
}
