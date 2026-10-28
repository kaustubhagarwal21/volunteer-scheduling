import { Router } from 'express';
import { currentUser, requireAuth } from '../auth/middleware';
import { IdParam, parse } from '../http/validate';
import { cancelSignup } from './service';

export const signupsRouter = Router();
signupsRouter.use(requireAuth);

// A cancellation is a state change, not a deletion: the row is kept with cancelled_at set.
signupsRouter.post('/:id/cancel', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await cancelSignup(currentUser(req), id);
  res.status(204).end();
});
