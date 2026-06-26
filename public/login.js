const message = document.querySelector("#loginMessage");
const params = new URLSearchParams(window.location.search);
const error = params.get("error");
const notice = params.get("notice");

const messages = {
  invalid: "The username or password was not correct.",
  setup: "Login is not configured yet. Set ADMIN_PASSWORD on the server.",
  expired: "Your session expired. Sign in again.",
  pending: "That account is still awaiting admin approval.",
  inactive: "That account is not active.",
  request: "The request could not be completed."
};

const notices = {
  registered: "Account request submitted. An admin needs to approve it.",
  reset: "Password reset request submitted. An admin needs to approve it."
};

function showAuthPanel(name) {
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.authTab === name);
  });
  document.querySelectorAll(".auth-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.authPanel === name);
  });
}

document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => showAuthPanel(tab.dataset.authTab));
});

if (error) {
  message.textContent = messages[error] || decodeURIComponent(error);
  message.hidden = false;
  message.classList.remove("is-success");
}

if (notice && notices[notice]) {
  message.textContent = notices[notice];
  message.hidden = false;
  message.classList.add("is-success");
}
