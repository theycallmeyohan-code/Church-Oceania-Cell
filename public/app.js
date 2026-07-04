const ROLES = [
  { value: "", label: "일반" },
  { value: "cell_leader", label: "셀장" },
  { value: "assistant_leader", label: "부셀장" },
  { value: "prayer_leader", label: "기도장" }
];

const INITIAL_CELLS = [
  { id: "male-8", name: "남자 8셀", meta: "66~68년생", gender: "남자", sortOrder: 10 },
  { id: "male-16", name: "남자 16셀", meta: "90년생이하", gender: "남자", sortOrder: 20 },
  { id: "female-3", name: "여자 3셀", meta: "47~48년생", gender: "여자", sortOrder: 30 },
  { id: "female-9", name: "여자 9셀", meta: "58년생", gender: "여자", sortOrder: 40 },
  { id: "female-15", name: "여자 15셀", meta: "66년생", gender: "여자", sortOrder: 50 },
  { id: "female-25", name: "여자 25셀", meta: "77년생", gender: "여자", sortOrder: 60 },
  { id: "female-33", name: "여자 33셀", meta: "86~87년생", gender: "여자", sortOrder: 70 }
];

const PHOTO_VERSION = "20260704-photo-fix-2";

const seedRows = [];

const INITIAL_MEMBERS = seedRows.map((row, index) => ({
  id: `seed-${String(index + 1).padStart(3, "0")}`,
  cellId: row[0],
  name: row[1],
  title: row[2] || "",
  role: row[3] || "",
  phone: "",
  homePhone: "",
  birth: "",
  registeredAt: "",
  address: "",
  memo: "",
  photoUrl: `photos/seed-${String(index + 1).padStart(3, "0")}.jpg?v=${PHOTO_VERSION}`,
  photoKey: "",
  photoRemoved: false,
  archivedAt: "",
  createdAt: "2026-07-04T00:00:00.000Z",
  updatedAt: "2026-07-04T00:00:00.000Z"
}));

const STORE_KEY = "seosanch-cell:v1";

const state = {
  cells: [],
  members: [],
  visits: [],
  selectedCellId: "",
  selectedMemberId: "",
  query: "",
  showArchived: false,
  mode: "view",
  pendingPhotoData: null,
  selectedVisitDate: "",
  apiOnline: false
};

const el = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindEvents();
  el.memberBirth.max = today();
  populateRoleOptions();
  await loadState();
  state.selectedCellId = state.selectedCellId || state.cells[0]?.id || "";
  render();
}

function bindElements() {
  [
    "workspace", "cellTabs", "searchInput", "showArchived", "memberGrid", "cellTitle", "cellMeta",
    "activeCount", "archivedCount", "addMemberBtn", "visitDatesBtn", "settingsBtn", "settingsModal", "settingsForm", "settingsCloseBtn", "settingsCancelBtn", "logoutBtn",
    "currentPassword", "newPassword", "confirmPassword", "visitDatesModal", "visitDatesCloseBtn", "visitDateChips", "visitDateEntries", "detailPanel", "emptyDetail",
    "memberForm", "formMode", "formTitle", "backToListBtn", "closePanelBtn", "photoPreview",
    "photoInput", "memberName", "memberTitle", "memberCell",
    "memberRole", "memberPhone", "memberHomePhone", "memberBirth", "memberRegisteredAt", "memberAge", "memberCalendar", "memberAddress", "memberMemo",
    "archiveBtn", "restoreBtn", "deleteBtn", "visitCount", "visitDate",
    "visitType", "visitSummary", "visitPrayer", "visitAction", "addVisitBtn", "visitList",
    "toast"
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function bindEvents() {
  el.searchInput.addEventListener("input", () => {
    state.query = el.searchInput.value.trim();
    renderMembers();
  });

  el.showArchived.addEventListener("change", () => {
    state.showArchived = el.showArchived.checked;
    persist();
    renderMembers();
  });

  el.addMemberBtn.addEventListener("click", startNewMember);
  el.visitDatesBtn.addEventListener("click", openVisitDates);
  el.visitDatesCloseBtn.addEventListener("click", closeVisitDates);
  el.visitDatesModal.addEventListener("click", (event) => {
    if (event.target === el.visitDatesModal) closeVisitDates();
  });
  el.backToListBtn.addEventListener("click", closeDetail);
  el.settingsBtn.addEventListener("click", openSettings);
  el.settingsCloseBtn.addEventListener("click", closeSettings);
  el.settingsCancelBtn.addEventListener("click", closeSettings);
  el.settingsModal.addEventListener("click", (event) => {
    if (event.target === el.settingsModal) closeSettings();
  });
  el.settingsForm.addEventListener("submit", changePassword);
  el.logoutBtn.addEventListener("click", () => {
    window.location.href = "/__auth/logout";
  });
  el.closePanelBtn.addEventListener("click", closeDetail);
  el.memberForm.addEventListener("submit", saveMember);
  el.photoInput.addEventListener("change", handlePhotoPick);
  el.memberBirth.addEventListener("input", updateBirthAge);
  el.memberBirth.addEventListener("change", updateBirthAge);
  el.archiveBtn.addEventListener("click", archiveSelected);
  el.restoreBtn.addEventListener("click", restoreSelected);
  el.deleteBtn.addEventListener("click", deleteSelected);
  el.addVisitBtn.addEventListener("click", addVisit);
}

function populateRoleOptions() {
  el.memberRole.innerHTML = ROLES.map((role) => `<option value="${role.value}">${role.label}</option>`).join("");
}

async function loadState() {
  const local = readLocal();
  state.cells = local.cells;
  state.members = local.members;
  state.visits = local.visits;
  state.selectedCellId = local.selectedCellId || "";
  state.showArchived = Boolean(local.showArchived);
  el.showArchived.checked = state.showArchived;

  try {
    const response = await fetch("/api/bootstrap", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("api unavailable");
    const data = await response.json();
    if (Array.isArray(data.cells) && data.cells.length) {
      state.cells = data.cells;
      state.members = data.members || [];
      hydrateSeedPhotoUrls(state.members);
      applyMemberDetails(state.members);
      state.visits = data.visits || [];
      state.apiOnline = true;
    }
  } catch {
    state.apiOnline = false;
  }
}

function readLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved?.cells?.length && Array.isArray(saved.members)) {
      hydrateSeedPhotoUrls(saved.members);
      applyMemberDetails(saved.members);
      return {
        cells: saved.cells,
        members: saved.members,
        visits: saved.visits || [],
        selectedCellId: saved.selectedCellId || "",
        showArchived: saved.showArchived || false
      };
    }
  } catch {
    localStorage.removeItem(STORE_KEY);
  }
  const initialMembers = structuredClone(INITIAL_MEMBERS);
  hydrateSeedPhotoUrls(initialMembers);
  applyMemberDetails(initialMembers);
  return {
    cells: structuredClone(INITIAL_CELLS),
    members: initialMembers,
    visits: [],
    selectedCellId: INITIAL_CELLS[0]?.id || "",
    showArchived: false
  };
}

function hydrateSeedPhotoUrls(members) {
  members.forEach((member) => {
    if (member.id?.startsWith("seed-") && !member.photoRemoved && !member.photoKey) {
      const isSeedPhoto = !member.photoUrl || member.photoUrl.includes(`photos/${member.id}.jpg`);
      if (isSeedPhoto) member.photoUrl = `photos/${member.id}.jpg?v=${PHOTO_VERSION}`;
    }
  });
}

function applyMemberDetails(members) {
  const details = window.MEMBER_DETAILS || {};
  members.forEach((member) => {
    const detail = details[member.id];
    if (!detail) return;
    if (member.id?.startsWith("seed-")) {
      member.phone = member.phone || detail.phone || "";
      member.homePhone = member.homePhone || detail.homePhone || "";
      member.birth = mergeBirthDetail(member.birth, detail.birth);
      member.registeredAt = member.registeredAt || detail.registeredAt || "";
      member.address = member.address || detail.address || "";
      member.memo = mergeDetailMemo(member.memo, detail.memo);
      return;
    }
    if (!member.phone && detail.phone) member.phone = detail.phone;
    if (!member.homePhone && detail.homePhone) member.homePhone = detail.homePhone;
    member.birth = mergeBirthDetail(member.birth, detail.birth);
    if (!member.registeredAt && detail.registeredAt) member.registeredAt = detail.registeredAt;
    if (!member.address && detail.address) member.address = detail.address;
    member.memo = mergeDetailMemo(member.memo, detail.memo);
  });
}

function mergeBirthDetail(currentBirth, detailBirth) {
  const current = String(currentBirth || "").trim();
  const detail = String(detailBirth || "").trim();
  if (!current) return detail;
  if (!detail) return current;

  const currentParsed = parseBirthValue(current);
  const detailParsed = parseBirthValue(detail);
  if (detailParsed.marker !== "\uC74C" || currentParsed.marker === "\uC74C") return current;

  const date = currentParsed.date || detailParsed.date;
  if (!date) return current;
  const age = calculateAge(date);
  return [date, "\uC74C", Number.isFinite(age) ? "(" + age + "\uC138)" : ""].filter(Boolean).join(" ");
}

function mergeDetailMemo(currentMemo, detailMemo) {
  const current = String(currentMemo || "").trim();
  const detail = String(detailMemo || "").trim();
  if (!current) return detail;
  if (!detail) return current;

  const childPrefix = "\uC790\uB140:";
  const currentLines = current.split("\n").map((line) => line.trim()).filter(Boolean);
  const hasChildLine = currentLines.some((line) => line.startsWith(childPrefix));
  if (hasChildLine) return current;

  const childLines = detail.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(childPrefix));
  if (!childLines.length) return current;
  return [...currentLines, ...childLines].join("\n");
}

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify({
    cells: state.cells,
    members: state.members,
    visits: state.visits,
    selectedCellId: state.selectedCellId,
    showArchived: state.showArchived
  }));
}

function render() {
  renderCellTabs();
  renderCellSelect();
  renderMembers();
  renderDetail();
  updateMobileDetailState();
}

function renderCellTabs() {
  el.cellTabs.innerHTML = state.cells
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((cell) => {
      const count = state.members.filter((member) => member.cellId === cell.id && !member.archivedAt).length;
      return `<button class="cell-tab ${cell.id === state.selectedCellId ? "active" : ""}" data-cell-id="${cell.id}" type="button">
        <strong>${escapeHtml(cell.name)}</strong>
        <span>${count}</span>
      </button>`;
    })
    .join("");

  el.cellTabs.querySelectorAll("[data-cell-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCellId = button.dataset.cellId;
      state.selectedMemberId = "";
      persist();
      render();
    });
  });
}

function renderCellSelect() {
  el.memberCell.innerHTML = state.cells
    .map((cell) => `<option value="${cell.id}">${escapeHtml(cell.name)} ${escapeHtml(cell.meta || "")}</option>`)
    .join("");
}


function renderMembers() {
  const cell = currentCell();
  if (!cell) return;

  const rawQuery = state.query.trim();
  const isSearching = Boolean(rawQuery);
  const allInCell = state.members.filter((member) => member.cellId === cell.id);
  const active = allInCell.filter((member) => !member.archivedAt);
  const archived = allInCell.filter((member) => member.archivedAt);

  const baseMembers = isSearching ? state.members : allInCell;
  const visible = baseMembers
    .filter((member) => state.showArchived || !member.archivedAt)
    .filter((member) => !isSearching || memberMatchesSearch(member, rawQuery))
    .sort((a, b) => compareMembersForDisplay(a, b, isSearching));

  if (isSearching) {
    const archivedMatches = state.members.filter((member) => member.archivedAt && memberMatchesSearch(member, rawQuery)).length;
    el.cellTitle.textContent = "\uC804\uCCB4 \uAC80\uC0C9 \uACB0\uACFC";
    el.cellMeta.textContent = rawQuery;
    el.activeCount.textContent = `\uAC80\uC0C9 ${visible.length}\uBA85`;
    el.archivedCount.textContent = state.showArchived ? "\uBCF4\uAD00 \uD3EC\uD568" : (archivedMatches ? `\uBCF4\uAD00 ${archivedMatches}\uBA85 \uC228\uAE40` : "\uBCF4\uAD00 \uC81C\uC678");
  } else {
    el.cellTitle.textContent = cell.name;
    el.cellMeta.textContent = cell.meta || cell.gender || "";
    el.activeCount.textContent = `${active.length}\uBA85`;
    el.archivedCount.textContent = `\uBCF4\uAD00 ${archived.length}\uBA85`;
  }

  if (!visible.length) {
    const emptyTitle = isSearching ? "\uAC80\uC0C9 \uACB0\uACFC \uC5C6\uC74C" : "\uACB0\uACFC \uC5C6\uC74C";
    const emptyHint = isSearching ? "\uC774\uB984, \uC804\uD654, \uC9D1\uC804\uD654, \uAC00\uC871/\uC790\uB140\uBA54\uBAA8\uB97C \uD655\uC778\uD558\uC138\uC694" : "\uAC80\uC0C9 \uC870\uAC74\uC744 \uC870\uC815\uD558\uC138\uC694";
    el.memberGrid.innerHTML = `<div class="member-card"><span class="member-name">${emptyTitle}</span><span class="member-sub">${emptyHint}</span></div>`;
    return;
  }

  el.memberGrid.innerHTML = visible.map((member) => memberCardHtml(member, isSearching)).join("");
  el.memberGrid.querySelectorAll("[data-member-id]").forEach((button) => {
    button.addEventListener("click", () => selectMember(button.dataset.memberId));
  });
}

function compareMembersForDisplay(a, b, isSearching = false) {
  if (isSearching) {
    const cellDiff = cellSortRank(a.cellId) - cellSortRank(b.cellId);
    if (cellDiff) return cellDiff;
  }

  const roleDiff = roleSortRank(a.role) - roleSortRank(b.role);
  if (roleDiff) return roleDiff;

  const nameDiff = compareKoreanNames(a.name, b.name);
  if (nameDiff) return nameDiff;

  return String(a.id || "").localeCompare(String(b.id || ""), "ko-KR", { numeric: true });
}

function roleSortRank(role) {
  const ranks = {
    cell_leader: 0,
    assistant_leader: 1,
    prayer_leader: 2
  };
  return Object.prototype.hasOwnProperty.call(ranks, role) ? ranks[role] : 10;
}

function cellSortRank(cellId) {
  const cell = state.cells.find((item) => item.id === cellId);
  return cell?.sortOrder ?? 9999;
}

function compareKoreanNames(a, b) {
  return String(a || "").localeCompare(String(b || ""), "ko-KR", {
    sensitivity: "base",
    numeric: true
  });
}

function memberMatchesSearch(member, rawQuery) {
  const textQuery = normalizeSearchText(rawQuery);
  const phoneQuery = normalizePhoneSearch(rawQuery);
  const fields = [
    member.name,
    member.title,
    member.phone,
    member.homePhone,
    member.birth,
    member.registeredAt,
    member.address,
    member.memo,
    memberCellLabel(member),
    memberRoleLabel(member)
  ];
  const searchText = normalizeSearchText(fields.join(" "));
  if (textQuery && searchText.includes(textQuery)) return true;
  if (phoneQuery) {
    return [member.phone, member.homePhone]
      .filter(Boolean)
      .some((value) => normalizePhoneSearch(value).includes(phoneQuery));
  }
  return false;
}

function normalizeSearchText(value) {
  return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
}

function normalizePhoneSearch(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function memberCellLabel(member) {
  const cell = state.cells.find((item) => item.id === member.cellId);
  return cell ? `${cell.name} ${cell.meta || ""}`.trim() : "";
}

function memberRoleLabel(member) {
  return ROLES.find((item) => item.value === member.role)?.label || "";
}

function memberCardHtml(member, showCell = false) {
  const role = memberRoleLabel(member);
  const cellLabel = showCell ? memberCellLabel(member) : "";
  return `<button class="member-card ${member.id === state.selectedMemberId ? "selected" : ""} ${member.archivedAt ? "archived" : ""}" data-member-id="${member.id}" type="button">
    ${portraitHtml(member)}
    <span>
      <span class="member-name">${escapeHtml(member.name)}</span>
      <span class="member-sub">${escapeHtml(member.title || "\uC9C1\uBD84 \uC5C6\uC74C")}</span>
      ${cellLabel ? `<span class="member-cell">${escapeHtml(cellLabel)}</span>` : ""}
      ${role && member.role ? `<span class="role-chip">${escapeHtml(role)}</span>` : ""}
    </span>
  </button>`;
}

function portraitHtml(member, large = false) {
  const classes = `portrait ${large ? "large" : ""}`;
  const src = member.photoUrl || (member.photoKey ? `/api/photos/${encodeURIComponent(member.photoKey)}` : "");
  if (src) {
    return `<span class="${classes}"><img src="${escapeAttribute(src)}" alt="${escapeAttribute(member.name)}"></span>`;
  }
  return `<span class="${classes}" aria-hidden="true">${escapeHtml(initials(member.name))}</span>`;
}

function selectMember(memberId) {
  const member = state.members.find((item) => item.id === memberId);
  if (member?.cellId) state.selectedCellId = member.cellId;
  state.selectedMemberId = memberId;
  state.mode = "view";
  state.pendingPhotoData = null;
  persist();
  renderCellTabs();
  renderMembers();
  renderDetail();
  scrollMobileToTop();
}

function renderDetail() {
  const member = selectedMember();
  if (!member) {
    el.emptyDetail.classList.remove("hidden");
    el.memberForm.classList.add("hidden");
    return;
  }

  el.emptyDetail.classList.add("hidden");
  el.memberForm.classList.remove("hidden");
  el.formMode.textContent = member.id.startsWith("new-") ? "신규" : "상세";
  el.formTitle.textContent = member.name || "성도 정보";
  el.photoPreview.outerHTML = portraitHtml(member, true).replace("<span", "<div id=\"photoPreview\"").replace("</span>", "</div>");
  el.photoPreview = document.getElementById("photoPreview");

  el.memberName.value = member.name || "";
  el.memberTitle.value = member.title || "";
  el.memberCell.value = member.cellId || state.selectedCellId;
  el.memberRole.value = member.role || "";
  el.memberPhone.value = member.phone || "";
  el.memberHomePhone.value = member.homePhone || "";
  const birth = parseBirthValue(member.birth);
  el.memberBirth.value = birth.date || "";
  el.memberRegisteredAt.value = member.registeredAt || "";
  el.memberAge.value = birth.date ? ageLabel(birth.date) : (birth.age ? birth.age + "\uC138" : "");
  renderLunarMarker(birth.marker);
  el.memberAddress.value = member.address || "";
  el.memberMemo.value = member.memo || "";
  el.archiveBtn.classList.toggle("hidden", Boolean(member.archivedAt));
  el.restoreBtn.classList.toggle("hidden", !member.archivedAt);
  el.deleteBtn.classList.toggle("hidden", member.id.startsWith("new-"));
  renderVisits(member.id);
  updateMobileDetailState();
}

function startNewMember() {
  const now = new Date().toISOString();
  const member = {
    id: `new-${crypto.randomUUID()}`,
    cellId: state.selectedCellId,
    name: "",
    title: "",
    role: "",
    phone: "",
    homePhone: "",
    birth: "",
    registeredAt: "",
    address: "",
    memo: "",
    photoUrl: "",
    photoKey: "",
    archivedAt: "",
    createdAt: now,
    updatedAt: now
  };
  state.members.push(member);
  state.selectedMemberId = member.id;
  state.pendingPhotoData = null;
  render();
  scrollMobileToTop();
  el.memberName.focus();
}

async function saveMember(event) {
  event.preventDefault();
  const member = selectedMember();
  if (!member) return;

  const wasNew = member.id.startsWith("new-");
  const payload = {
    name: el.memberName.value.trim(),
    title: el.memberTitle.value.trim(),
    cellId: el.memberCell.value,
    role: el.memberRole.value,
    phone: el.memberPhone.value.trim(),
    homePhone: el.memberHomePhone.value.trim(),
    birth: buildBirthValue(el.memberBirth.value, member.birth),
    registeredAt: el.memberRegisteredAt.value.trim(),
    address: el.memberAddress.value.trim(),
    memo: el.memberMemo.value.trim()
  };

  if (!payload.name) {
    toast("이름을 입력하세요");
    el.memberName.focus();
    return;
  }

  Object.assign(member, payload, { updatedAt: new Date().toISOString() });
  if (state.pendingPhotoData) {
    member.photoUrl = state.pendingPhotoData;
    member.photoKey = "";
  }

  if (state.apiOnline) {
    try {
      const saved = await saveMemberToApi(member, wasNew);
      Object.assign(member, saved);
      if (state.pendingPhotoFile) await uploadPhotoToApi(member.id, state.pendingPhotoFile);
    } catch {
      state.apiOnline = false;
      toast("로컬에 저장되었습니다");
    }
  }

  if (wasNew && member.id.startsWith("new-")) {
    member.id = `local-${crypto.randomUUID()}`;
  }

  state.selectedCellId = member.cellId;
  state.selectedMemberId = member.id;
  state.pendingPhotoData = null;
  state.pendingPhotoFile = null;
  persist();
  render();
  toast("저장되었습니다");
}

async function saveMemberToApi(member, wasNew) {
  const method = wasNew ? "POST" : "PATCH";
  const url = wasNew ? "/api/members" : `/api/members/${encodeURIComponent(member.id)}`;
  const response = await writeFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(member)
  });
  if (!response.ok) throw new Error("save failed");
  return response.json();
}

async function handlePhotoPick(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("이미지 파일을 선택하세요");
    return;
  }
  const dataUrl = await fileToDataUrl(file);
  state.pendingPhotoData = dataUrl;
  state.pendingPhotoFile = file;
  const member = selectedMember();
  if (member) {
    member.photoUrl = dataUrl;
    member.photoKey = "";
    member.photoRemoved = false;
    renderMembers();
    renderDetail();
  }
}

function removePhoto() {
  const member = selectedMember();
  if (!member) return;
  member.photoUrl = "";
  member.photoKey = "";
  member.photoRemoved = true;
  state.pendingPhotoData = null;
  state.pendingPhotoFile = null;
  persist();
  renderMembers();
  renderDetail();
}

async function uploadPhotoToApi(memberId, file) {
  const formData = new FormData();
  formData.append("photo", file);
  const response = await writeFetch(`/api/members/${encodeURIComponent(memberId)}/photo`, {
    method: "POST",
    body: formData
  });
  if (!response.ok) throw new Error("photo failed");
  const saved = await response.json();
  const member = state.members.find((item) => item.id === memberId);
  if (member) {
    member.photoKey = saved.photoKey || "";
    member.photoUrl = saved.photoUrl || "";
  }
}

function archiveSelected() {
  const member = selectedMember();
  if (!member) return;
  member.archivedAt = new Date().toISOString();
  member.updatedAt = member.archivedAt;
  callApi(`/api/members/${encodeURIComponent(member.id)}/archive`, { method: "POST" });
  persist();
  render();
  toast("보관되었습니다");
}

function restoreSelected() {
  const member = selectedMember();
  if (!member) return;
  member.archivedAt = "";
  member.updatedAt = new Date().toISOString();
  callApi(`/api/members/${encodeURIComponent(member.id)}/restore`, { method: "POST" });
  persist();
  render();
  toast("복구되었습니다");
}

function deleteSelected() {
  const member = selectedMember();
  if (!member) return;
  const ok = confirm(`${member.name} 성도 정보를 완전히 삭제할까요?`);
  if (!ok) return;
  state.members = state.members.filter((item) => item.id !== member.id);
  state.visits = state.visits.filter((visit) => visit.memberId !== member.id);
  callApi(`/api/members/${encodeURIComponent(member.id)}`, { method: "DELETE" });
  state.selectedMemberId = "";
  persist();
  render();
  toast("삭제되었습니다");
}

function addVisit() {
  const member = selectedMember();
  if (!member) return;
  const summary = el.visitSummary.value.trim();
  if (!summary) {
    toast("요약을 입력하세요");
    el.visitSummary.focus();
    return;
  }
  const visit = {
    id: `visit-${crypto.randomUUID()}`,
    memberId: member.id,
    visitDate: el.visitDate.value || today(),
    visitType: el.visitType.value,
    summary,
    prayer: el.visitPrayer.value.trim(),
    action: el.visitAction.value.trim(),
    source: "manual",
    createdAt: new Date().toISOString()
  };
  state.visits.unshift(visit);
  callApi("/api/visit-notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(visit)
  });
  el.visitSummary.value = "";
  el.visitPrayer.value = "";
  el.visitAction.value = "";
  persist();
  renderVisits(member.id);
  if (!el.visitDatesModal.classList.contains("hidden")) renderVisitDates();
  toast("심방내역이 추가되었습니다");
}

function renderVisits(memberId) {
  const visits = state.visits
    .filter((visit) => visit.memberId === memberId)
    .sort((a, b) => `${b.visitDate || ""}${b.createdAt || ""}`.localeCompare(`${a.visitDate || ""}${a.createdAt || ""}`));
  el.visitCount.textContent = `${visits.length}건`;
  el.visitDate.value = today();
  el.visitList.innerHTML = visits.length
    ? visits.map((visit) => `<article class="visit-item">
        <strong>${escapeHtml(visit.visitDate || "")} · ${escapeHtml(visit.visitType || "심방")}</strong>
        <p>${escapeHtml(visit.summary || "")}</p>
        ${visit.prayer ? `<small>기도제목: ${escapeHtml(visit.prayer)}</small>` : ""}
        ${visit.action ? `<small>후속 조치: ${escapeHtml(visit.action)}</small>` : ""}
      </article>`).join("")
    : `<article class="visit-item"><small>기록 없음</small></article>`;
}

async function callApi(url, options) {
  if (!state.apiOnline) return;
  try {
    const response = await writeFetch(url, options);
    if (!response.ok) throw new Error("api failed");
  } catch {
    state.apiOnline = false;
  }
}

async function writeFetch(url, options = {}, retried = false) {
  const token = localStorage.getItem("seosanch-cell:admin-token") || "";
  const headers = new Headers(options.headers || {});
  if (token) headers.set("X-Admin-Token", token);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && !retried) {
    const nextToken = prompt("?? ?? ?????");
    if (nextToken) {
      localStorage.setItem("seosanch-cell:admin-token", nextToken.trim());
      return writeFetch(url, options, true);
    }
  }
  return response;
}

function openVisitDates() {
  state.selectedVisitDate = state.selectedVisitDate || latestVisitDate() || today();
  renderVisitDates();
  el.visitDatesModal.classList.remove("hidden");
  el.visitDatesModal.setAttribute("aria-hidden", "false");
}

function closeVisitDates() {
  el.visitDatesModal.classList.add("hidden");
  el.visitDatesModal.setAttribute("aria-hidden", "true");
}

function renderVisitDates() {
  const grouped = groupVisitsByDate();
  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  if (!dates.length) {
    el.visitDateChips.innerHTML = '<p class="visit-date-empty">아직 심방내역이 없습니다.</p>';
    el.visitDateEntries.innerHTML = '';
    return;
  }

  if (!dates.includes(state.selectedVisitDate)) state.selectedVisitDate = dates[0];
  el.visitDateChips.innerHTML = dates.map((date) => {
    const count = grouped[date].length;
    return `<button class="visit-date-chip ${date === state.selectedVisitDate ? "active" : ""}" data-visit-date="${escapeAttribute(date)}" type="button">
      <strong>${escapeHtml(formatDateLabel(date))}</strong>
      <span>${count}건</span>
    </button>`;
  }).join("");

  el.visitDateChips.querySelectorAll("[data-visit-date]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedVisitDate = button.dataset.visitDate;
      renderVisitDates();
    });
  });

  const visits = (grouped[state.selectedVisitDate] || [])
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  el.visitDateEntries.innerHTML = visits.map((visit) => visitDateEntryHtml(visit)).join("");
  el.visitDateEntries.querySelectorAll("[data-member-id]").forEach((button) => {
    button.addEventListener("click", () => {
      closeVisitDates();
      selectMember(button.dataset.memberId);
    });
  });
}

function groupVisitsByDate() {
  return state.visits.reduce((groups, visit) => {
    const date = visitDateKey(visit);
    if (!date) return groups;
    groups[date] = groups[date] || [];
    groups[date].push(visit);
    return groups;
  }, {});
}

function latestVisitDate() {
  return Object.keys(groupVisitsByDate()).sort((a, b) => b.localeCompare(a))[0] || "";
}

function visitDateKey(visit) {
  return String(visit.visitDate || visit.createdAt || "").slice(0, 10);
}

function visitDateEntryHtml(visit) {
  const member = state.members.find((item) => item.id === visit.memberId);
  const memberName = member?.name || "이름 없음";
  const cellLabel = member ? memberCellLabel(member) : "";
  const title = member?.title || "";
  const memberId = member?.id || "";
  return `<article class="visit-date-entry">
    <button class="visit-date-member" type="button" ${memberId ? `data-member-id="${escapeAttribute(memberId)}"` : "disabled"}>
      <strong>${escapeHtml(memberName)}</strong>
      <span>${escapeHtml([cellLabel, title].filter(Boolean).join(" · "))}</span>
    </button>
    <div class="visit-date-body">
      <small>${escapeHtml(visit.visitType || "심방")}</small>
      <p>${escapeHtml(visit.summary || "")}</p>
      ${visit.prayer ? `<small>기도제목: ${escapeHtml(visit.prayer)}</small>` : ""}
      ${visit.action ? `<small>후속 조치: ${escapeHtml(visit.action)}</small>` : ""}
    </div>
  </article>`;
}

function formatDateLabel(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  return match ? match[1] + ". " + match[2] + ". " + match[3] + "." : date;
}

function updateMobileDetailState() {
  el.workspace.classList.toggle("detail-active", Boolean(selectedMember()));
}

function isMobileView() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function scrollMobileToTop() {
  if (isMobileView()) window.scrollTo({ top: 0, behavior: "smooth" });
}

function openSettings() {
  el.settingsForm.reset();
  el.settingsModal.classList.remove("hidden");
  el.settingsModal.setAttribute("aria-hidden", "false");
  setTimeout(() => el.currentPassword.focus(), 0);
}

function closeSettings() {
  el.settingsModal.classList.add("hidden");
  el.settingsModal.setAttribute("aria-hidden", "true");
}

async function changePassword(event) {
  event.preventDefault();
  const currentPassword = el.currentPassword.value.trim();
  const newPassword = el.newPassword.value.trim();
  const confirmPassword = el.confirmPassword.value.trim();

  if (!currentPassword || !newPassword || !confirmPassword) {
    toast("\uBE44\uBC00\uBC88\uD638\uB97C \uBAA8\uB450 \uC785\uB825\uD558\uC138\uC694");
    return;
  }
  if (newPassword.length < 8) {
    toast("\uC0C8 \uBE44\uBC00\uBC88\uD638\uB294 8\uC790 \uC774\uC0C1\uC73C\uB85C \uC785\uB825\uD558\uC138\uC694");
    el.newPassword.focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    toast("\uC0C8 \uBE44\uBC00\uBC88\uD638\uAC00 \uC11C\uB85C \uB2E4\uB985\uB2C8\uB2E4");
    el.confirmPassword.focus();
    return;
  }

  const submitButton = el.settingsForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "password update failed");
    closeSettings();
    toast("\uBE44\uBC00\uBC88\uD638\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4");
  } catch (error) {
    toast(error.message || "\uBE44\uBC00\uBC88\uD638\uB97C \uBCC0\uACBD\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4");
  } finally {
    submitButton.disabled = false;
  }
}
function closeDetail() {
  const member = selectedMember();
  if (member?.id.startsWith("new-")) {
    const ok = confirm("\uC0C8 \uC131\uB3C4 \uC785\uB825\uC744 \uB2EB\uC73C\uBA74 \uC800\uC7A5\uD558\uC9C0 \uC54A\uC740 \uB0B4\uC6A9\uC774 \uC0AC\uB77C\uC9D1\uB2C8\uB2E4.\n\uADF8\uB798\uB3C4 \uB2EB\uC744\uAE4C\uC694?");
    if (!ok) return;
    state.members = state.members.filter((item) => item.id !== member.id);
  }
  state.selectedMemberId = "";
  state.pendingPhotoData = null;
  persist();
  render();
}

function currentCell() {
  return state.cells.find((cell) => cell.id === state.selectedCellId) || state.cells[0];
}

function selectedMember() {
  return state.members.find((member) => member.id === state.selectedMemberId);
}

function initials(name) {
  const compact = String(name || "?").trim();
  if (!compact) return "?";
  return Array.from(compact.replace(/\s/g, "")).slice(-2).join("");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


function parseBirthValue(value) {
  const text = String(value || "").trim();
  const date = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || "";
  const parts = text.split(/\s+/);
  const marker = ["\uC591", "\uC74C", "?"].find((item) => parts.includes(item)) || "";
  const age = text.match(/\((\d+)\uC138\)/)?.[1] || "";
  return { date, marker, age };
}

function buildBirthValue(dateValue, previousValue = "") {
  const date = String(dateValue || "").trim();
  const previous = parseBirthValue(previousValue);
  if (!date) return previous.date ? "" : String(previousValue || "").trim();
  const marker = previous.marker === "\uC74C" ? previous.marker : "";
  const age = calculateAge(date);
  return [date, marker, Number.isFinite(age) ? "(" + age + "\uC138)" : ""].filter(Boolean).join(" ");
}

function renderLunarMarker(marker) {
  const isLunar = marker === "\uC74C";
  el.memberCalendar.textContent = isLunar ? "\uC74C\uB825" : "";
  el.memberCalendar.classList.toggle("hidden", !isLunar);
}

function updateBirthAge() {
  el.memberAge.value = ageLabel(el.memberBirth.value);
}

function ageLabel(dateValue) {
  const age = calculateAge(dateValue);
  return Number.isFinite(age) ? age + "\uC138" : "";
}

function calculateAge(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ""));
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const birthDate = new Date(year, month - 1, day);
  if (birthDate.getFullYear() !== year || birthDate.getMonth() !== month - 1 || birthDate.getDate() !== day) return NaN;
  const now = new Date();
  let age = now.getFullYear() - year;
  const birthdayThisYear = new Date(now.getFullYear(), month - 1, day);
  if (now < birthdayThisYear) age -= 1;
  return age >= 0 ? age : NaN;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove("show"), 1800);
}
