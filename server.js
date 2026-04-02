const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

const dbPath = path.join(__dirname, "todo.sqlite");
const db = new sqlite3.Database(dbPath);

app.use(express.json());
app.use(express.static(__dirname));

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`
  );
});

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row || null);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows || []);
    });
  });
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

    const existingUser = await getQuery("SELECT id FROM users WHERE email = ?", [email]);
    if (existingUser) {
      res.status(409).json({ message: "Email already in use" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const created = await runQuery(
      "INSERT INTO users (email, password_hash) VALUES (?, ?)",
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

    const userRow = await getQuery("SELECT id, email, password_hash FROM users WHERE email = ?", [email]);
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
       WHERE user_id = ?
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
       VALUES (?, ?, 0, ?, 0)`,
      [req.user.id, text, dueAt]
    );

    const row = await getQuery(
      `SELECT id, text, completed, due_at AS dueAt, reminder_sent AS reminderSent
       FROM todos
       WHERE id = ? AND user_id = ?`,
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
       WHERE id = ? AND user_id = ?`,
      [todoId, req.user.id]
    );

    if (!existing) {
      res.status(404).json({ message: "Todo not found" });
      return;
    }

    const nextText =
      typeof req.body.text === "string" ? req.body.text.trim() || existing.text : existing.text;
    const nextCompleted =
      typeof req.body.completed === "boolean" ? Number(req.body.completed) : Number(existing.completed);
    const nextDueAt =
      Object.prototype.hasOwnProperty.call(req.body, "dueAt")
        ? req.body.dueAt
          ? String(req.body.dueAt)
          : null
        : existing.dueAt;
    const nextReminderSent =
      typeof req.body.reminderSent === "boolean"
        ? Number(req.body.reminderSent)
        : Number(existing.reminderSent);

    await runQuery(
      `UPDATE todos
       SET text = ?, completed = ?, due_at = ?, reminder_sent = ?
       WHERE id = ? AND user_id = ?`,
      [nextText, nextCompleted, nextDueAt, nextReminderSent, todoId, req.user.id]
    );

    res.json({
      id: String(existing.id),
      text: nextText,
      completed: Boolean(nextCompleted),
      dueAt: nextDueAt,
      reminderSent: Boolean(nextReminderSent),
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

    const deleted = await runQuery("DELETE FROM todos WHERE id = ? AND user_id = ?", [
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
    await runQuery("DELETE FROM todos WHERE user_id = ? AND completed = 1", [req.user.id]);
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
