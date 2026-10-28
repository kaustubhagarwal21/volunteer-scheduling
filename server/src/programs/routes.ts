import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireCoordinator } from '../auth/middleware';
import { Id, IdParam, parse } from '../http/validate';
import { toCsv } from '../lib/csv';
import { generateShifts } from '../shifts/generate';
import { GenerateBody, rejectDerivedFields, ShiftBody } from '../shifts/schemas';
import { createShift } from '../shifts/service';
import { orgClock } from '../time/orgClock';
import {
  addMember,
  createProgram,
  getProgram,
  listMembers,
  listMyPrograms,
  listPrograms,
  removeMember,
  rosterRows,
  setArchived,
  updateProgram,
} from './service';

const Name = z.string().trim().min(1, 'Name is required').max(120);
const Description = z.string().trim().max(2000);
const ProgramBody = z.strictObject({ name: Name, description: Description.default('') });
const ProgramPatch = z
  .strictObject({ name: Name, description: Description })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Send at least one field to change' });
const ListQuery = z.strictObject({ archived: z.enum(['true', 'false']).default('false') });
const MemberBody = z.strictObject({ userId: Id });
const MemberParams = z.object({ id: Id, userId: Id });

export const programsRouter = Router();

programsRouter.get('/', async (req, res) => {
  const { archived } = parse(ListQuery, req.query);
  res.json({ programs: await listPrograms(currentUser(req), archived === 'true') });
});

programsRouter.post('/', requireCoordinator, async (req, res) => {
  res.status(201).json({ program: await createProgram(currentUser(req), parse(ProgramBody, req.body)) });
});

programsRouter.get('/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json({ program: await getProgram(currentUser(req), id) });
});

programsRouter.patch('/:id', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json({ program: await updateProgram(currentUser(req), id, parse(ProgramPatch, req.body)) });
});

programsRouter.post('/:id/archive', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json({ program: await setArchived(currentUser(req), id, true) });
});

programsRouter.post('/:id/restore', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json({ program: await setArchived(currentUser(req), id, false) });
});

programsRouter.get('/:id/members', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await getProgram(currentUser(req), id); // 404 for unknown programs
  res.json({ members: await listMembers(id) });
});

programsRouter.post('/:id/members', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await addMember(currentUser(req), id, parse(MemberBody, req.body).userId);
  res.status(201).end();
});

programsRouter.delete('/:id/members/:userId', requireCoordinator, async (req, res) => {
  const { id, userId } = parse(MemberParams, req.params);
  res.json(await removeMember(currentUser(req), id, userId));
});

programsRouter.post('/:id/shifts', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  rejectDerivedFields(req.body);
  res.status(201).json({ shift: await createShift(currentUser(req), id, parse(ShiftBody, req.body)) });
});

programsRouter.post('/:id/shifts/generate', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  rejectDerivedFields(req.body);
  res.status(201).json(await generateShifts(currentUser(req), id, parse(GenerateBody, req.body)));
});

programsRouter.get('/:id/roster.csv', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const program = await getProgram(currentUser(req), id);
  const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
  const csv = toCsv(
    ['Volunteer', 'Email', 'Current member', 'Active signups', 'Total hours', 'Hours on closed shifts'],
    (await rosterRows(id)).map((row) => [
      row.name,
      row.email,
      row.is_member ? 'yes' : 'no',
      row.signups,
      hours(row.total_minutes),
      hours(row.closed_minutes),
    ]),
  );
  // ASCII-only file name: anything else in the program name becomes '-', so the header is always valid.
  const slug = program.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'program';
  res.attachment(`${slug}-roster-${orgClock().today}.csv`);
  res.type('text/csv; charset=utf-8');
  // The byte-order mark makes Excel read the file as UTF-8, so names with accents survive.
  res.send(`﻿${csv}`);
});

/** Goal 5: the signed-in volunteer's programs, each with its shifts. */
export const meRouter = Router();

meRouter.get('/programs', async (req, res) => {
  const { includePast } = parse(z.strictObject({ includePast: z.enum(['true', 'false']).default('false') }), req.query);
  res.json({ programs: await listMyPrograms(currentUser(req), includePast === 'true') });
});
