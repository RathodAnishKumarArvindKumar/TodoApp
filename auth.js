const form = document.getElementById("auth-form");
const message = document.getElementById("auth-message");

const isSignup = window.location.pathname.endsWith("signup.html");
const endpoint = isSignup ? "/api/auth/signup" : "/api/auth/login";

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    setMessage("Email and password are required", true);
    return;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    const result = await response.json();

    if (!response.ok) {
      setMessage(result.message || "Request failed", true);
      return;
    }

    localStorage.setItem("todo-token", result.token);
    localStorage.setItem("todo-user-email", result.user.email);

    window.location.href = "index.html";
  } catch {
    setMessage("Network error. Please try again.", true);
  }
});

function setMessage(text, isError) {
  message.textContent = text;
  message.classList.toggle("error", Boolean(isError));
}
