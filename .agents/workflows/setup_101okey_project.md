---
description: Setup 101 Okey Online Project (Full Stack)
---

// turbo-all

1. **Create project structure**
   ```bash
   mkdir -p /Users/hakancineli/ders101/frontend
   mkdir -p /Users/hakancineli/ders101/backend
   ```

2. **Initialize Frontend (Vite + React + TypeScript)**
   ```bash
   cd /Users/hakancineli/ders101/frontend
   npx -y create-vite@latest . --template react-ts
   ```

3. **Install Frontend dependencies**
   ```bash
   npm install
   npm install tailwindcss@latest postcss@latest autoprefixer@latest @radix-ui/react-dialog @radix-ui/react-popover @radix-ui/react-tooltip @stitches/react
   ```

4. **Configure Tailwind CSS** (add `tailwind.config.cjs` and `postcss.config.cjs` – files will be created later by the setup script).

5. **Initialize Backend (Express + TypeScript + Socket.IO + Prisma)**
   ```bash
   cd /Users/hakancineli/ders101/backend
   npm init -y
   npm install express socket.io cors dotenv bcryptjs jsonwebtoken
   npm install -D typescript ts-node-dev @types/express @types/node @types/cors @types/bcryptjs @types/jsonwebtoken
   npx -y prisma init
   ```

6. **Create Prisma schema** – edit `prisma/schema.prisma` (will be added later).

7. **Generate .env files** for both frontend and backend (placeholders for DB URL, JWT secret, etc.).

8. **Create basic folder structure for authentication, game logic, and socket handling** (folders: `src/auth`, `src/game`, `src/socket`).

9. **Generate a simple logo image** for the app.
   ```bash
   # This step will be performed with the generate_image tool.
   ```

10. **Add scripts to package.json** for dev servers:
    - Frontend: `npm run dev`
    - Backend: `npm run dev` (using `ts-node-dev`)

11. **Commit initial project** (optional).

---

**Not:** After this workflow is created, every step that contains a `run_command` will be auto‑executed because of the `// turbo-all` annotation.
