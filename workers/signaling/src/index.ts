import { Hono } from 'hono';
import type { AppContext } from './types';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error';
import auth from './routes/auth';
import users from './routes/users';

const app = new Hono<AppContext>();

app.use('*', corsMiddleware);
app.onError(errorHandler);

app.get('/health', (c) => c.json({ status: 'ok' }));

app.route('/api/auth', auth);
app.route('/api/users', users);

export default app;
