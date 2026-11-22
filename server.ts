import express from 'express';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { createApiRouter } from './server/routes.js';
import {
  getActiveBotToken,
  getUserData,
  getUsers,
  initDatabase,
  saveUserData,
} from './server/storage.js';
import { processInvestmentAutoDebits } from './server/ledgerEngine.js';
import { syncBotCommands } from './server/telegram.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.get(['/api/health', '/api/ping', '/healthz'], (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

app.use('/api', createApiRouter());

async function startServer() {
  await initDatabase();

  // Hourly auto-debit runner for SIPs & RDs
  setInterval(() => {
    for (const user of getUsers()) {
      try {
        const store = getUserData(user.id);
        const res = processInvestmentAutoDebits(user.id, store);
        if (res.processedCount > 0) saveUserData(user.id, store);
      } catch (err) {
        console.error('[AutoDebit] Error for user', user.id, err);
      }
    }
  }, 60 * 60 * 1000);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distPath, 'index.html');

    if (fs.existsSync(distPath)) {
      app.use(
        '/assets',
        express.static(path.join(distPath, 'assets'), {
          maxAge: '1y',
          immutable: true,
        })
      );
      app.use(
        express.static(distPath, {
          setHeaders: (res, filePath) => {
            if (
              filePath.endsWith('.html') ||
              filePath.endsWith('sw.js') ||
              filePath.endsWith('manifest.webmanifest')
            ) {
              res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            }
          },
        })
      );
    }

    app.get('*', (_req, res) => {
      if (fs.existsSync(indexHtmlPath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(indexHtmlPath);
        return;
      }
      res.status(200).send('TeleExpense API server running.');
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TeleExpense server listening on http://0.0.0.0:${PORT}`);
    const token = getActiveBotToken();
    if (token) {
      syncBotCommands(token).catch(() => {});
    }
  });
}

startServer();
