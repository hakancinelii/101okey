// src/config.ts
// The backend URL is injected at build time via VITE_BACKEND_URL env variable.
// Locally it falls back to localhost:4000.
export const BACKEND_URL: string =
    import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';
