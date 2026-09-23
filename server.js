require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const API_KEY = process.env.API_KEY || 'quickcuts123';

app.use(express.json());

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests from this client. Please try again after 1 minute.'
  }
});
app.use(limiter);

const dbPath = path.join(__dirname, 'barbershop.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database: barbershop.db');
  }
});

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
};

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customerName TEXT NOT NULL,
      serviceType TEXT NOT NULL,
      status TEXT NOT NULL,
      timeIn TEXT NOT NULL
    )
  `, (err) => {
    if (err) {
      console.error('Failed to create queue table:', err.message);
    } else {
      console.log('Queue table verified/created successfully.');
    }
  });
});

const ALLOWED_SERVICES = ['Haircut', 'Shave', 'Haircut + Shave'];
const ALLOWED_STATUSES = ['Waiting', 'In Chair', 'Done'];

const requireApiKey = (req, res, next) => {
  const incomingKey =
    req.headers['api-key-ko'] ||
    req.query.apiKey ||
    (req.headers['authorization']
      ? req.headers['authorization'].replace(/^Bearer\s+/i, '')
      : null);

  if (!incomingKey || incomingKey !== API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized: Missing or invalid API key'
    });
  }

  next();
};

const formatQueueEntry = (entry, queueNumber) => ({
  ...entry,
  queueNumber: queueNumber ?? entry.id
});

app.get('/queue', async (req, res, next) => {
  try {
    const queue = await dbAll('SELECT * FROM queue ORDER BY id ASC');
    res.status(200).json(queue.map((entry, index) => formatQueueEntry(entry, index + 1)));
  } catch (err) {
    next(err);
  }
});

app.get('/queue/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const entry = await dbGet('SELECT * FROM queue WHERE id = ?', [id]);

    if (!entry) {
      return res.status(404).json({
        error: `Queue entry with id ${id} not found`
      });
    }

    const queue = await dbAll('SELECT * FROM queue ORDER BY id ASC');
    const queueNumber = queue.findIndex((item) => item.id === Number(id)) + 1;
    res.status(200).json(formatQueueEntry(entry, queueNumber || 1));
  } catch (err) {
    next(err);
  }
});

app.post('/queue', requireApiKey, async (req, res, next) => {
  try {
    const { customerName, serviceType } = req.body;

    if (!customerName || typeof customerName !== 'string' || customerName.trim() === '') {
      return res.status(400).json({
        error: 'customerName is required and cannot be empty'
      });
    }

    if (!serviceType || typeof serviceType !== 'string' || !ALLOWED_SERVICES.includes(serviceType.trim())) {
      return res.status(400).json({
        error: `serviceType is required and must be one of: ${ALLOWED_SERVICES.join(', ')}`
      });
    }

    const trimmedCustomerName = customerName.trim();
    const trimmedServiceType = serviceType.trim();
    const initialStatus = 'Waiting';
    const timeIn = new Date().toISOString();

    const result = await dbRun(
      'INSERT INTO queue (customerName, serviceType, status, timeIn) VALUES (?, ?, ?, ?)',
      [trimmedCustomerName, trimmedServiceType, initialStatus, timeIn]
    );

    const newEntry = await dbGet('SELECT * FROM queue WHERE id = ?', [result.id]);
    const queue = await dbAll('SELECT * FROM queue ORDER BY id ASC');
    const queueNumber = queue.findIndex((item) => item.id === Number(result.id)) + 1;
    res.status(201).json(formatQueueEntry(newEntry, queueNumber || 1));
  } catch (err) {
    next(err);
  }
});

app.put('/queue/:id', requireApiKey, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || typeof status !== 'string' || !ALLOWED_STATUSES.includes(status.trim())) {
      return res.status(400).json({
        error: `status is required and must be one of: ${ALLOWED_STATUSES.join(', ')}`
      });
    }

    const existing = await dbGet('SELECT * FROM queue WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({
        error: `Queue entry with id ${id} not found`
      });
    }

    const trimmedStatus = status.trim();
    await dbRun('UPDATE queue SET status = ? WHERE id = ?', [trimmedStatus, id]);

    const updatedEntry = await dbGet('SELECT * FROM queue WHERE id = ?', [id]);
    res.status(200).json(updatedEntry);
  } catch (err) {
    next(err);
  }
});

app.delete('/queue/:id', requireApiKey, async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await dbGet('SELECT * FROM queue WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({
        error: `Queue entry with id ${id} not found`
      });
    }

    await dbRun('DELETE FROM queue WHERE id = ?', [id]);

    res.status(200).json({
      message: 'Queue entry removed successfully',
      removedEntry: existing
    });
  } catch (err) {
    next(err);
  }
});

app.use((req, res, next) => {
  res.status(404).json({
    error: `Route ${req.method} ${req.originalUrl} not found`
  });
});

app.use((err, req, res, next) => {
  console.error('Centralized Error Handler caught:', err.message || err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error'
  });
});

const startServer = (port) => {
  const server = app.listen(port, () => {
    console.log(`====================================================`);
    console.log(`QuickCuts Barbershop Queue API is running!`);
    console.log(`Port: http://localhost:${port}`);
    console.log(`Queue Endpoint: http://localhost:${port}/queue`);
    console.log(`Configured API Key: ${API_KEY}`);
    console.log(`====================================================`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${nextPort} instead...`);
      startServer(nextPort);
      return;
    }

    console.error('Server failed to start:', error);
    process.exit(1);
  });
};

if (require.main === module) {
  startServer(PORT);
}

module.exports = app;