// Shapes returned by the API. Kept by hand in step with the server's DTOs (see server/src/**/dto.ts).

export type Role = 'coordinator' | 'volunteer';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export type ShiftState = 'open' | 'partially_filled' | 'filled' | 'closed';

export interface AlertsResponse {
  count: number;
}
