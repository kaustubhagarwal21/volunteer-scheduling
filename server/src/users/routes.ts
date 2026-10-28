import { Router } from 'express';
import { z } from 'zod';
import { requireCoordinator } from '../auth/middleware';
import { containsPattern, QueryParams } from '../db/params';
import { pool } from '../db/pool';
import { Id, parse, SearchText } from '../http/validate';

const VolunteerQuery = z.strictObject({
  q: SearchText.optional(),
  /** Leave out volunteers who already belong to this program (for the "add member" picker). */
  excludeProgramId: Id.optional(),
});

export const usersRouter = Router();
usersRouter.use(requireCoordinator);

usersRouter.get('/volunteers', async (req, res) => {
  const query = parse(VolunteerQuery, req.query);
  const params = new QueryParams();
  const where = ["u.role = 'volunteer'"];
  if (query.q) {
    const pattern = params.add(containsPattern(query.q));
    where.push(`(u.name ILIKE ${pattern} OR u.email ILIKE ${pattern})`);
  }
  if (query.excludeProgramId) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM program_members pm WHERE pm.user_id = u.id AND pm.program_id = ${params.add(query.excludeProgramId)})`,
    );
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email FROM users u WHERE ${where.join(' AND ')} ORDER BY u.name LIMIT 50`,
    params.values,
  );
  res.json({ volunteers: rows });
});
