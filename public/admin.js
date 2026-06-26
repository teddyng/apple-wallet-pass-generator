const adminState = {
  users: [],
  resetRequests: []
};

const adminStatus = document.querySelector("#adminStatus");
const pendingUsers = document.querySelector("#pendingUsers");
const pendingResets = document.querySelector("#pendingResets");
const allUsers = document.querySelector("#allUsers");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function setAdminStatus(message, tone = "") {
  adminStatus.textContent = message;
  adminStatus.classList.toggle("is-error", tone === "error");
  adminStatus.classList.toggle("is-success", tone === "success");
}

async function apiAction(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "The action could not be completed.");
  }
}

async function approveUser(username) {
  await apiAction("/api/admin/users/approve", { username });
  setAdminStatus(`${username} approved.`, "success");
  await loadAdminState();
}

async function rejectUser(username) {
  await apiAction("/api/admin/users/reject", { username });
  setAdminStatus(`${username} rejected.`, "success");
  await loadAdminState();
}

async function deleteUser(username) {
  if (!window.confirm(`Delete ${username}? This also removes pending password reset requests for that user.`)) {
    return;
  }
  await apiAction("/api/admin/users/delete", { username });
  setAdminStatus(`${username} deleted.`, "success");
  await loadAdminState();
}

async function approveReset(id, username) {
  await apiAction("/api/admin/password-resets/approve", { id });
  setAdminStatus(`${username}'s password was reset.`, "success");
  await loadAdminState();
}

async function rejectReset(id, username) {
  await apiAction("/api/admin/password-resets/reject", { id });
  setAdminStatus(`${username}'s reset was rejected.`, "success");
  await loadAdminState();
}

function emptyMarkup(label) {
  return `<div class="empty-state">${escapeHtml(label)}</div>`;
}

function renderPendingUsers() {
  const users = adminState.users.filter((user) => user.status === "pending");
  pendingUsers.innerHTML = users.length ? users.map((user) => `
    <article class="admin-item">
      <div>
        <strong>${escapeHtml(user.username)}</strong>
        <span>Requested ${escapeHtml(formatDate(user.createdAt))}</span>
      </div>
      <div class="admin-actions">
        <button class="primary-button" type="button" data-approve-user="${escapeHtml(user.username)}">Approve</button>
        <button class="secondary-button danger-button" type="button" data-reject-user="${escapeHtml(user.username)}">Reject</button>
      </div>
    </article>
  `).join("") : emptyMarkup("No pending account requests.");
}

function renderPendingResets() {
  const requests = adminState.resetRequests.filter((request) => request.status === "pending");
  pendingResets.innerHTML = requests.length ? requests.map((request) => `
    <article class="admin-item">
      <div>
        <strong>${escapeHtml(request.username)}</strong>
        <span>Requested ${escapeHtml(formatDate(request.createdAt))}</span>
      </div>
      <div class="admin-actions">
        <button class="primary-button" type="button" data-approve-reset="${escapeHtml(request.id)}" data-username="${escapeHtml(request.username)}">Approve</button>
        <button class="secondary-button danger-button" type="button" data-reject-reset="${escapeHtml(request.id)}" data-username="${escapeHtml(request.username)}">Reject</button>
      </div>
    </article>
  `).join("") : emptyMarkup("No pending password resets.");
}

function renderUsers() {
  allUsers.innerHTML = adminState.users.length ? adminState.users.map((user) => `
    <article class="admin-item compact">
      <div>
        <strong>${escapeHtml(user.username)}</strong>
        <span>${escapeHtml(user.role)} · ${escapeHtml(user.status)}</span>
      </div>
      <div class="admin-actions">
        <span>${escapeHtml(formatDate(user.approvedAt || user.createdAt))}</span>
        ${user.role === "admin" ? "" : `<button class="secondary-button danger-button" type="button" data-delete-user="${escapeHtml(user.username)}">Delete</button>`}
      </div>
    </article>
  `).join("") : emptyMarkup("No users yet.");
}

function render() {
  renderPendingUsers();
  renderPendingResets();
  renderUsers();
}

async function loadAdminState() {
  const response = await fetch("/api/admin/state");
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Could not load admin state.");
  }

  const payload = await response.json();
  adminState.users = payload.users || [];
  adminState.resetRequests = payload.resetRequests || [];
  render();

  const pendingCount = adminState.users.filter((user) => user.status === "pending").length;
  const resetCount = adminState.resetRequests.filter((request) => request.status === "pending").length;
  setAdminStatus(`${pendingCount} account request${pendingCount === 1 ? "" : "s"} · ${resetCount} password reset${resetCount === 1 ? "" : "s"}`);
}

document.addEventListener("click", async (event) => {
  const approveUserButton = event.target.closest("[data-approve-user]");
  const rejectUserButton = event.target.closest("[data-reject-user]");
  const deleteUserButton = event.target.closest("[data-delete-user]");
  const approveResetButton = event.target.closest("[data-approve-reset]");
  const rejectResetButton = event.target.closest("[data-reject-reset]");

  try {
    if (approveUserButton) await approveUser(approveUserButton.dataset.approveUser);
    if (rejectUserButton) await rejectUser(rejectUserButton.dataset.rejectUser);
    if (deleteUserButton) await deleteUser(deleteUserButton.dataset.deleteUser);
    if (approveResetButton) await approveReset(approveResetButton.dataset.approveReset, approveResetButton.dataset.username);
    if (rejectResetButton) await rejectReset(rejectResetButton.dataset.rejectReset, rejectResetButton.dataset.username);
  } catch (error) {
    setAdminStatus(error.message, "error");
  }
});

loadAdminState().catch((error) => {
  setAdminStatus(error.message, "error");
});
