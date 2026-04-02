const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const needsSsl = DATABASE_URL && !/localhost|127\.0\.0\.1/i.test(DATABASE_URL);
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    })
  : null;

const dbReady = pool
  ? pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS todos (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        due_at TIMESTAMPTZ,
        reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
  : Promise.resolve();

app.use(express.json());
app.use(express.static(__dirname));

async function query(sql, params = []) {
  if (!pool) {
    throw new Error("Database is not configured. Set DATABASE_URL before starting the server.");
  }

  await dbReady;
  return pool.query(sql, params);
}

async function runQuery(sql, params = []) {
  const result = await query(sql, params);
  const firstRow = result.rows[0] || null;

  return {
    id: firstRow?.id ?? null,
    changes: typeof result.rowCount === "number" ? result.rowCount : 0,
    row: firstRow,
  };
}

async function getQuery(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function allQuery(sql, params = []) {
  const result = await query(sql, params);
  return result.rows || [];
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/") && !pool) {
    res.status(500).json({
      message: "Database is not configured",
      detail: "Set DATABASE_URL (or POSTGRES_URL) for this deployment.",
    });
    return;
  }

  try {
    await dbReady;
    next();
  } catch (error) {
    res.status(500).json({ message: "Database initialization failed", detail: error.message });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters" });
      return;
    }

    const existingUser = await getQuery("SELECT id FROM users WHERE email = $1", [email]);
    if (existingUser) {
      res.status(409).json({ message: "Email already in use" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const created = await runQuery(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, passwordHash]
    );

    const user = { id: created.id, email };
    const token = signToken(user);

    res.status(201).json({ token, user });
  } catch (error) {
    res.status(500).json({ message: "Could not create account", detail: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }

    const userRow = await getQuery(
      "SELECT id, email, password_hash FROM users WHERE email = $1",
      [email]
    );
    if (!userRow) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const passwordOk = await bcrypt.compare(password, userRow.password_hash);
    if (!passwordOk) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const user = { id: userRow.id, email: userRow.email };
    const token = signToken(user);

    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ message: "Could not sign in", detail: error.message });
  }
});

app.get("/api/todos", requireAuth, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT id, text, completed, due_at AS dueAt, reminder_sent AS reminderSent
       FROM todos
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [req.user.id]
    );

    res.json(
      rows.map((row) => ({
        id: String(row.id),
        text: row.text,
        completed: Boolean(row.completed),
        dueAt: row.dueAt,
        reminderSent: Boolean(row.reminderSent),
      }))
    );
  } catch (error) {
    res.status(500).json({ message: "Could not fetch todos", detail: error.message });
  }
});

app.post("/api/todos", requireAuth, async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    const dueAt = req.body.dueAt ? String(req.body.dueAt) : null;

    if (!text) {
      res.status(400).json({ message: "Todo text is required" });
      return;
    }

    const created = await runQuery(
      `INSERT INTO todos (user_id, text, completed, due_at, reminder_sent)
       VALUES ($1, $2, FALSE, $3, FALSE)
       RETURNING id`,
      [req.user.id, text, dueAt]
    );

    const row = await getQuery(
      `SELECT id, text, completed, due_at AS dueAt, reminder_sent AS reminderSent
       FROM todos
       WHERE id = $1 AND user_id = $2`,
      [created.id, req.user.id]
    );

    res.status(201).json({
      id: String(row.id),
      text: row.text,
      completed: Boolean(row.completed),
      dueAt: row.dueAt,
      reminderSent: Boolean(row.reminderSent),
    });
  } catch (error) {
    res.status(500).json({ message: "Could not create todo", detail: error.message });
  }
});

app.patch("/api/todos/:id", requireAuth, async (req, res) => {
  try {
    const todoId = Number(req.params.id);
    if (!Number.isInteger(todoId)) {
      res.status(400).json({ message: "Invalid todo id" });
      return;
    }

    const existing = await getQuery(
      `SELECT id, text, completed, due_at AS dueAt, reminder_sent AS reminderSent
       FROM todos
       WHERE id = $1 AND user_id = $2`,
      [todoId, req.user.id]
    );

    if (!existing) {
      res.status(404).json({ message: "Todo not found" });
      return;
    }

    const nextText =
      typeof req.body.text === "string" ? req.body.text.trim() || existing.text : existing.text;
    const nextCompleted =
      typeof req.body.completed === "boolean" ? req.body.completed : Boolean(existing.completed);
    const nextDueAt =
      Object.prototype.hasOwnProperty.call(req.body, "dueAt")
        ? req.body.dueAt
          ? String(req.body.dueAt)
          : null
        : existing.dueAt;
    const nextReminderSent =
      typeof req.body.reminderSent === "boolean"
        ? req.body.reminderSent
        : Boolean(existing.reminderSent);

    await runQuery(
      `UPDATE todos
       SET text = $1, completed = $2, due_at = $3, reminder_sent = $4
       WHERE id = $5 AND user_id = $6`,
      [nextText, nextCompleted, nextDueAt, nextReminderSent, todoId, req.user.id]
    );

    res.json({
      id: String(existing.id),
      text: nextText,
      completed: nextCompleted,
      dueAt: nextDueAt,
      reminderSent: nextReminderSent,
    });
  } catch (error) {
    res.status(500).json({ message: "Could not update todo", detail: error.message });
  }
});

app.delete("/api/todos/:id", requireAuth, async (req, res) => {
  try {
    const todoId = Number(req.params.id);
    if (!Number.isInteger(todoId)) {
      res.status(400).json({ message: "Invalid todo id" });
      return;
    }

    const deleted = await runQuery("DELETE FROM todos WHERE id = $1 AND user_id = $2", [
      todoId,
      req.user.id,
    ]);

    if (!deleted.changes) {
      res.status(404).json({ message: "Todo not found" });
      return;
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: "Could not delete todo", detail: error.message });
  }
});

app.delete("/api/todos", requireAuth, async (req, res) => {
  try {
    await runQuery("DELETE FROM todos WHERE user_id = $1 AND completed = TRUE", [req.user.id]);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: "Could not clear completed", detail: error.message });
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
