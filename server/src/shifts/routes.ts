import { Router } from 'express';
import { currentUser, requireCoordinator } from '../auth/middleware';
import { IdParam, parse } from '../http/validate';
import { signUp } from '../signups/service';
import { FinderQuery, findShifts } from './finder';
import { NoteBody, rejectDerivedFields, ShiftPatch, SignupBody } from './schemas';
import { addNote, closeShift, deleteShift, getShiftDetail, getTimeline, updateShift } from './service';

export const shiftsRouter = Router();

shiftsRouter.get('/', async (req, res) => {
  res.json(await findShifts(currentUser(req), parse(FinderQuery, req.query)));
});

shiftsRouter.get('/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await getShiftDetail(currentUser(req), id));
});

shiftsRouter.patch('/:id', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  rejectDerivedFields(req.body);
  res.json({ shift: await updateShift(currentUser(req), id, parse(ShiftPatch, req.body)) });
});

shiftsRouter.delete('/:id', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await deleteShift(currentUser(req), id));
});

shiftsRouter.post('/:id/close', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json({ shift: await closeShift(currentUser(req), id) });
});

// Both roles: volunteers sign themselves up, coordinators sign up any volunteer.
shiftsRouter.post('/:id/signups', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { volunteerId } = parse(SignupBody, req.body ?? {});
  const signup = await signUp(currentUser(req), id, volunteerId);
  res.status(201).json({ signup });
});

shiftsRouter.get('/:id/timeline', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json({ events: await getTimeline(currentUser(req), id) });
});

shiftsRouter.post('/:id/notes', requireCoordinator, async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await addNote(currentUser(req), id, parse(NoteBody, req.body).note);
  res.status(201).end();
});
