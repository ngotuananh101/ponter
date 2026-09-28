import { Hono } from 'hono';
import type { AppContext } from './types';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error';
import auth from './routes/auth';
import users from './routes/users';
import devices from './routes/devices';
import agents from './routes/agents';
import sessions from './routes/sessions';
import signal from './routes/signal';
import ws from './routes/ws';

const app = new Hono<AppContext>();

app.use('*', corsMiddleware);
app.onError(errorHandler);

app.get('/health', (c) => c.json({ status: 'ok' }));

app.route('/api/auth', auth);
app.route('/api/users', users);
app.route('/api/devices', devices);
app.route('/api/agents', agents);
app.route('/api/sessions', sessions);
app.route('/api/signal', signal);
app.route('/api/ws', ws);

export default app;
