import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireCoordinator } from '../auth/middleware';
import { Id, parse } from '../http/validate';
import { dismissAlert, listAlerts } from './service';

export const alertsRouter = Router();

// Every signed-in user: understaffed shifts in the programs they can see.
alertsRouter.get('/', async (req, res) => {
  res.json(await listAlerts(currentUser(req)));
});

alertsRouter.post('/:shiftId/dismiss', requireCoordinator, async (req, res) => {
  const { shiftId } = parse(z.object({ shiftId: Id }), req.params);
  await dismissAlert(currentUser(req), shiftId);
  res.status(204).end();
});
