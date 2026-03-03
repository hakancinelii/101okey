// src/server.ts
import http from 'http';
import app from './app';
import { initSocket } from './socket';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);
// Initialize Socket.IO with the same server
initSocket(server);

server.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
