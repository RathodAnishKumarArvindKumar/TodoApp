const form = document.getElementById("todo-form");
const input = document.getElementById("todo-input");
const dueInput = document.getElementById("todo-due");
const list = document.getElementById("todo-list");
const count = document.getElementById("todo-count");
const filterButtons = document.querySelectorAll("[data-filter]");
const clearCompletedButton = document.getElementById("clear-completed");
const enableRemindersButton = document.getElementById("enable-reminders");
const reminderStatus = document.getElementById("reminder-status");
const logoutButton = document.getElementById("logout-btn");
const accountEmail = document.getElementById("account-email");

const token = localStorage.getItem("todo-token");
const userEmail = localStorage.getItem("todo-user-email") || "Signed in";

if (!token) {
  window.location.href = "login.html";
}

let todos = [];
let currentFilter = "all";
let audioContext = null;

updateReminderStatus();
setInterval(checkReminders, 10000);
accountEmail.textContent = userEmail;

document.addEventListener("click", ensureAudioReady, { once: true });

logoutButton.addEventListener("click", () => {
  localStorage.removeItem("todo-token");
  localStorage.removeItem("todo-user-email");
  window.location.href = "login.html";
});

enableRemindersButton.addEventListener("click", async () => {
  await ensureAudioReady();

  if (!("Notification" in window)) {
    reminderStatus.textContent = "This browser does not support notifications.";
    return;
  }

  if (Notification.permission === "granted") {
    reminderStatus.textContent = "Notifications are enabled.";
    return;
  }

  const result = await Notification.requestPermission();
  if (result === "granted") {
    reminderStatus.textContent = "Notifications are enabled.";
  } else {
    reminderStatus.textContent = "Notifications blocked. Allow them in browser settings.";
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  void createTodo();
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;

    filterButtons.forEach((btn) => btn.classList.remove("active"));
    button.classList.add("active");

    render();
  });
});

clearCompletedButton.addEventListener("click", () => {
  void clearCompleted();
});

list.addEventListener("click", (event) => {
  const target = event.target;
  const item = target.closest(".todo-item");
  if (!item) return;

  const id = item.dataset.id;

  if (target.matches(".toggle")) {
    const todo = todos.find((entry) => entry.id === id);
    if (!todo) return;
    void updateTodo(id, { completed: !todo.completed });
  }

  if (target.matches(".delete")) {
    void deleteTodo(id);
  }
});

void bootstrap();

async function bootstrap() {
  const ok = await validateSession();
  if (!ok) return;

  await fetchTodos();
  render();
}

async function validateSession() {
  try {
    const response = await apiFetch("/api/me");
    if (!response.ok) {
      handleAuthFailure();
      return false;
    }

    return true;
  } catch {
    handleAuthFailure();
    return false;
  }
}

async function createTodo() {
  const text = input.value.trim();
  if (!text) return;

  const dueAt = dueInput.value ? new Date(dueInput.value).toISOString() : null;

  const response = await apiFetch("/api/todos", {
    method: "POST",
    body: JSON.stringify({ text, dueAt }),
  });

  if (await handlePotentialAuthError(response)) return;
  if (!response.ok) return;

  const created = await response.json();
  todos.unshift(created);
  input.value = "";
  dueInput.value = "";
  render();
}

function render() {
  const visibleTodos = todos.filter((todo) => {
    if (currentFilter === "active") return !todo.completed;
    if (currentFilter === "completed") return todo.completed;
    return true;
  });

  list.innerHTML = visibleTodos
    .map(
      (todo) => `
        <li class="todo-item ${todo.completed ? "completed" : ""}" data-id="${todo.id}">
          <input
            class="toggle"
            type="checkbox"
            ${todo.completed ? "checked" : ""}
            aria-label="Toggle todo"
          />
          <div class="todo-main">
            <span class="text">${escapeHtml(todo.text)}</span>
            ${todo.dueAt ? `<span class="todo-meta">Reminder: ${formatDueDate(todo.dueAt)}</span>` : ""}
          </div>
          <button type="button" class="delete" aria-label="Delete todo">Delete</button>
        </li>
      `
    )
    .join("");

  const activeCount = todos.filter((todo) => !todo.completed).length;
  count.textContent = `${activeCount} item${activeCount === 1 ? "" : "s"} left`;
}

function checkReminders() {
  const now = Date.now();
  const dueItems = todos.filter((todo) => {
    if (todo.completed || !todo.dueAt || todo.reminderSent) return false;
    const dueTime = new Date(todo.dueAt).getTime();
    return Number.isFinite(dueTime) && dueTime <= now;
  });

  if (!dueItems.length) return;

  dueItems.forEach((todo) => {
    triggerReminder(todo);
    void updateTodo(todo.id, { reminderSent: true }, false);
  });
}

function triggerReminder(todo) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Todo reminder", {
      body: todo.text,
      tag: `todo-${todo.id}`,
      renotify: true,
    });
  }

  playRing();
}

function playRing() {
  if (!audioContext) return;

  const now = audioContext.currentTime;
  const beeps = [0, 0.25, 0.5];

  beeps.forEach((offset) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0;

    osc.connect(gain);
    gain.connect(audioContext.destination);

    gain.gain.setValueAtTime(0, now + offset);
    gain.gain.linearRampToValueAtTime(0.25, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.18);

    osc.start(now + offset);
    osc.stop(now + offset + 0.2);
  });
}

async function ensureAudioReady() {
  if (!window.AudioContext && !window.webkitAudioContext) return;

  if (!audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtx();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

function updateReminderStatus() {
  if (!("Notification" in window)) {
    reminderStatus.textContent = "This browser does not support notifications.";
    return;
  }

  if (Notification.permission === "granted") {
    reminderStatus.textContent = "Notifications are enabled.";
    return;
  }

  if (Notification.permission === "denied") {
    reminderStatus.textContent = "Notifications blocked. Allow them in browser settings.";
    return;
  }

  reminderStatus.textContent = "Notifications not enabled";
}

function formatDueDate(isoString) {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return "Invalid date";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function fetchTodos() {
  const response = await apiFetch("/api/todos");
  if (await handlePotentialAuthError(response)) return;
  if (!response.ok) return;

  todos = await response.json();
}

async function updateTodo(id, updates, rerender = true) {
  const response = await apiFetch(`/api/todos/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });

  if (await handlePotentialAuthError(response)) return;
  if (!response.ok) return;

  const updated = await response.json();
  todos = todos.map((todo) => (todo.id === id ? updated : todo));
  if (rerender) render();
}

async function deleteTodo(id) {
  const response = await apiFetch(`/api/todos/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (await handlePotentialAuthError(response)) return;
  if (!response.ok) return;

  todos = todos.filter((todo) => todo.id !== id);
  render();
}

async function clearCompleted() {
  const response = await apiFetch("/api/todos", {
    method: "DELETE",
  });

  if (await handlePotentialAuthError(response)) return;
  if (!response.ok) return;

  todos = todos.filter((todo) => !todo.completed);
  render();
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...options, headers });
}

async function handlePotentialAuthError(response) {
  if (response.status !== 401) return false;
  handleAuthFailure();
  return true;
}

function handleAuthFailure() {
  localStorage.removeItem("todo-token");
  localStorage.removeItem("todo-user-email");
  window.location.href = "login.html";
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
