import { Router } from 'express';
import { currentUser } from '../auth/middleware';
import { getDashboard } from './service';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (req, res) => {
  res.json(await getDashboard(currentUser(req)));
});
