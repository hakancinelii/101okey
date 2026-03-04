// src/server.ts
import http from 'http';
import app from './app';
import { initSocket } from './socket';
import dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.PORT) || 4000;

const server = http.createServer(app);
// Initialize Socket.IO with the same server
initSocket(server);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
});
