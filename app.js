const STORAGE_KEY = "ufc-kuthiradam-tournament-v2";
const DEFAULT_ROOM = "ufc-kuthiradam-2026";

const params = new URLSearchParams(window.location.search);
const isViewer = params.get("mode") === "view";

const defaultState = {
  teams: Array.from({ length: 10 }, (_, i) => ({
    id: `team-${i + 1}`,
    name: `Team ${String(i + 1).padStart(2, "0")}`,
    image: "",
  })),
  groups: { A: [], B: [] },
  fixtures: { A: [], B: [] },
  knockout: {
    sf1: { home: null, away: null, homeScore: "", awayScore: "", winner: null },
    sf2: { home: null, away: null, homeScore: "", awayScore: "", winner: null },
    final: {
      home: null,
      away: null,
      homeScore: "",
      awayScore: "",
      winner: null,
    },
  },
};

const ROOM_ID =
  (params.get("tournament") || DEFAULT_ROOM)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 80) || DEFAULT_ROOM;

let state = loadLocalState();
let activeGroup = "A";
let cloudClient = null;
let realtimeChannel = null;
let cloudReady = false;
let cloudSyncTimer = null;
let applyingRemoteState = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/* =========================================================
   VIEWER MODE
   ========================================================= */

function blockViewerEdit(message = "Viewer mode: editing is disabled.") {
  if (!isViewer) return false;

  toast(message);
  return true;
}

function applyViewerMode() {
  if (!isViewer) return;

  // Disable team name + image inputs
  $$("#teamGrid input").forEach((el) => {
    el.disabled = true;
  });

  // Disable tournament management buttons
  [
    "#saveTeamsBtn",
    "#fillDemoBtn",
    "#drawGroupsBtn",
    "#regenerateFixturesBtn",
    "#resetBtn",
  ].forEach((selector) => {
    const el = $(selector);

    if (el) {
      el.disabled = true;
      el.style.opacity = "0.45";
      el.style.cursor = "not-allowed";
    }
  });

  // Disable group-stage score editing
  $$("#rounds .score-input, #rounds .save-match").forEach((el) => {
    el.disabled = true;
    el.style.opacity = "0.55";
    el.style.cursor = "not-allowed";
  });

  // Disable semi-final/final score editing
  $$("#bracket input, #bracket button[data-ko-save]").forEach((el) => {
    el.disabled = true;
    el.style.opacity = "0.55";
    el.style.cursor = "not-allowed";
  });
}

/* ========================================================= */

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeState(parsed) {
  const base = clone(defaultState);

  if (!parsed || typeof parsed !== "object") return base;

  return {
    ...base,
    ...parsed,
    teams:
      Array.isArray(parsed.teams) && parsed.teams.length === 10
        ? parsed.teams
        : base.teams,
    groups: { ...base.groups, ...(parsed.groups || {}) },
    fixtures: { ...base.fixtures, ...(parsed.fixtures || {}) },
    knockout: { ...base.knockout, ...(parsed.knockout || {}) },
  };
}

function loadLocalState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);

    return saved ? normalizeState(JSON.parse(saved)) : clone(defaultState);
  } catch {
    return clone(defaultState);
  }
}

function localPersist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* cache is optional */
  }
}

function setSyncStatus(text, mode = "") {
  const el = $("#syncStatus");

  if (el) el.textContent = text;

  const saveText = $("#saveStateText");

  if (saveText) saveText.textContent = text;

  const dot = $(".save-state i");

  if (dot) dot.className = mode ? mode : "";
}

function persist(message = "Saved locally", syncCloud = true) {
  localPersist();

  setSyncStatus(message, cloudReady ? "live" : "local");

  if (syncCloud && cloudReady && !applyingRemoteState) {
    queueCloudSync();
  }
}

function queueCloudSync() {
  clearTimeout(cloudSyncTimer);

  setSyncStatus("Saving to shared tournament…", "syncing");

  cloudSyncTimer = setTimeout(syncStateToCloud, 350);
}

async function syncStateToCloud() {
  // Viewer must never write to Supabase
  if (isViewer) return;

  if (!cloudClient || !cloudReady || applyingRemoteState) {
    return;
  }

  setSyncStatus("Saving to shared tournament…", "syncing");

  const payload = {
    tournament_id: ROOM_ID,
    state,
    updated_at: new Date().toISOString(),
  };

  const { error } = await cloudClient
    .from("ufc_tournaments")
    .upsert(payload, { onConflict: "tournament_id" });

  if (error) {
    console.error("Supabase sync error:", error);

    setSyncStatus("Cloud sync failed · local cache active", "error");

    toast("Cloud sync failed. Check Supabase setup.");

    return;
  }

  setSyncStatus("Live · synced across devices", "live");
}

async function initCloud() {
  const cfg = window.UFC_SUPABASE_CONFIG || {};

  if (
    !cfg.url ||
    !cfg.anonKey ||
    cfg.url.includes("YOUR_SUPABASE") ||
    cfg.anonKey.includes("YOUR-")
  ) {
    setSyncStatus(
      "Local mode · add Supabase config to enable sharing",
      "local",
    );

    return;
  }

  if (!window.supabase?.createClient) {
    setSyncStatus("Supabase library unavailable · local mode", "local");

    return;
  }

  try {
    cloudClient = window.supabase.createClient(cfg.url, cfg.anonKey);

    cloudReady = true;

    setSyncStatus("Loading shared tournament…", "syncing");

    const { data, error } = await cloudClient
      .from("ufc_tournaments")
      .select("state, updated_at")
      .eq("tournament_id", ROOM_ID)
      .maybeSingle();

    if (error) throw error;

    if (data?.state) {
      applyingRemoteState = true;

      state = normalizeState(data.state);

      localPersist();

      applyingRemoteState = false;

      renderAll();
    } else if (!isViewer) {
      // Only organizer can create tournament
      await syncStateToCloud();
    } else {
      setSyncStatus("Viewer mode · waiting for tournament data", "live");
    }

    subscribeToRealtime();

    setSyncStatus("Live · synced across devices", "live");
  } catch (error) {
    console.error("Cloud initialization error:", error);

    cloudClient = null;

    setSyncStatus("Cloud unavailable · local cache active", "error");

    toast("Could not connect to shared tournament. Local mode is active.");
  }
}

function subscribeToRealtime() {
  if (!cloudClient) return;

  realtimeChannel = cloudClient
    .channel(`ufc-tournament-${ROOM_ID}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "ufc_tournaments",
        filter: `tournament_id=eq.${ROOM_ID}`,
      },

      (payload) => {
        if (!payload.new?.state) return;

        applyingRemoteState = true;

        state = normalizeState(payload.new.state);

        localPersist();

        renderAll();

        applyingRemoteState = false;

        setSyncStatus("Live · updated from another device", "live");
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setSyncStatus("Live · synced across devices", "live");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setSyncStatus("Realtime disconnected · refreshing manually", "error");
      }
    });
}

function toast(message) {
  const el = $("#toast");

  el.textContent = message;

  el.classList.add("show");

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => el.classList.remove("show"), 2300);
}

function initials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();
}

function avatarHTML(team, className = "") {
  if (!team) return `<div class="team-mini-avatar ${className}">?</div>`;

  return team.image
    ? `<img class="${className}" src="${team.image}" alt="${escapeHtml(team.name)} crest">`
    : `<div class="team-mini-avatar ${className}">${escapeHtml(initials(team.name))}</div>`;
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>'"]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[c],
  );
}

function getTeam(id) {
  return state.teams.find((t) => t.id === id);
}

function getTeamById(id) {
  return state.teams.find((t) => t.id === id) || null;
}

function validTeams() {
  return state.teams.every((t) => t.name.trim());
}

/* =========================================================
   TEAMS
   ========================================================= */

function renderTeams() {
  $("#teamGrid").innerHTML = state.teams
    .map(
      (team, i) => `
    <div class="team-card">

      <span class="team-number">
        ${String(i + 1).padStart(2, "0")}
      </span>

      <div
        class="avatar-upload"
        title="Upload team image"
      >

        ${
          team.image
            ? `<img src="${team.image}" alt="${escapeHtml(team.name)}">`
            : `<span>${escapeHtml(initials(team.name))}</span>`
        }

        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          data-team-image="${team.id}"
          aria-label="Upload image for ${escapeHtml(team.name)}"
        >

      </div>

      <label for="name-${team.id}">
        TEAM NAME
      </label>

      <input
        id="name-${team.id}"
        type="text"
        maxlength="30"
        value="${escapeHtml(team.name)}"
        data-team-name="${team.id}"
        autocomplete="off"
      >

    </div>
  `,
    )
    .join("");

  $$("#teamGrid [data-team-name]").forEach((input) =>
    input.addEventListener("input", (e) => {
      const team = getTeam(e.target.dataset.teamName);

      team.name = e.target.value;

      persist("Team changes syncing…");

      renderGroups();
      renderFixtures();
      renderStandings();
      renderBracket();
    }),
  );

  $$("#teamGrid [data-team-image]").forEach((input) =>
    input.addEventListener("change", handleImage),
  );

  applyViewerMode();
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = reject;

    reader.onload = () => {
      const img = new Image();

      img.onerror = reject;

      img.onload = () => {
        const max = 420;

        const scale = Math.min(1, max / Math.max(img.width, img.height));

        const canvas = document.createElement("canvas");

        canvas.width = Math.max(1, Math.round(img.width * scale));

        canvas.height = Math.max(1, Math.round(img.height * scale));

        const ctx = canvas.getContext("2d");

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        resolve(canvas.toDataURL("image/webp", 0.72));
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

async function handleImage(e) {
  if (blockViewerEdit("Viewer mode: team images cannot be changed.")) return;

  const file = e.target.files[0];

  if (!file) return;

  if (file.size > 8 * 1024 * 1024) {
    toast("Please choose an image under 8 MB.");

    return;
  }

  try {
    const team = getTeam(e.target.dataset.teamImage);

    team.image = await compressImage(file);

    persist("Team image syncing…");

    renderTeams();
    renderGroups();
    renderFixtures();
    renderStandings();
    renderBracket();

    toast("Team image saved and synced.");
  } catch {
    toast("Could not process that image.");
  }
}

function saveTeams() {
  if (blockViewerEdit("Viewer mode: teams cannot be edited.")) return;

  if (!validTeams()) {
    toast("Please enter all 10 team names first.");

    return;
  }

  persist("Teams saved · syncing…");

  toast("All team details saved.");
}

function fillDemo() {
  if (blockViewerEdit("Viewer mode: teams cannot be changed.")) return;

  const names = [
    "ALPHA UNITED",
    "BLACK PANTHERS",
    "EMPIRE FC",
    "ROYAL STRIKES",
    "TARGARIAN FC",
    "BLITZ FC",
    "NOVA FC",
    "ROVERS FC",
    "TITAN FC",
    "VIKINGS FC",
  ];

  state.teams.forEach((team, i) => {
    team.name = names[i];
  });

  persist("Demo teams syncing…");

  renderAll();

  toast("Demo teams loaded — edit them anytime.");
}

/* =========================================================
   FIXTURE GENERATION
   ========================================================= */

function makeFiveTeamFixtures(teamIds) {
  // Team order is preserved.
  // NO randomisation.

  const a = [...teamIds];

  const schedule = [
    [
      [0, 1],
      [2, 3],
    ],
    [
      [0, 2],
      [3, 4],
    ],
    [
      [0, 3],
      [1, 4],
    ],
    [
      [0, 4],
      [1, 2],
    ],
    [
      [1, 3],
      [2, 4],
    ],
  ];

  return schedule.map((round) =>
    round.map(([x, y]) => ({
      home: a[x],
      away: a[y],
      homeScore: "",
      awayScore: "",
      played: false,
    })),
  );
}

function drawGroups() {
  if (blockViewerEdit("Viewer mode: groups cannot be changed.")) return;

  if (!validTeams()) {
    toast("Enter all 10 team names before drawing groups.");

    document.querySelector("#setup").scrollIntoView({
      behavior: "smooth",
    });

    return;
  }

  // First 5 → Group A
  // Next 5 → Group B

  const teams = state.teams.map((t) => t.id);

  state.groups.A = teams.slice(0, 5);

  state.groups.B = teams.slice(5, 10);

  state.fixtures.A = makeFiveTeamFixtures(state.groups.A);

  state.fixtures.B = makeFiveTeamFixtures(state.groups.B);

  state.knockout = clone(defaultState.knockout);

  persist("Groups drawn · syncing…");

  renderAll();

  $("#drawHint").textContent =
    "Groups drawn in entry order. First 5 teams are in Group A; next 5 are in Group B.";

  toast("Groups drawn: first 5 → Group A, next 5 → Group B!");

  document.querySelector("#groups").scrollIntoView({
    behavior: "smooth",
  });
}

function regenerateFixtures() {
  if (blockViewerEdit("Viewer mode: fixtures cannot be regenerated.")) return;

  if (!state.groups.A.length || !state.groups.B.length) {
    toast("Draw the groups first.");

    return;
  }

  state.fixtures.A = makeFiveTeamFixtures(state.groups.A);

  state.fixtures.B = makeFiveTeamFixtures(state.groups.B);

  state.knockout = clone(defaultState.knockout);

  persist("Fixtures regenerated · syncing…");

  renderAll();

  toast(
    `Group ${activeGroup} fixtures regenerated. All previous scores were cleared.`,
  );
}

/* =========================================================
   GROUPS
   ========================================================= */

function renderGroups() {
  const hasGroups = state.groups.A.length === 5 && state.groups.B.length === 5;

  $("#groupsGrid").innerHTML = hasGroups
    ? ["A", "B"]
        .map((group) => {
          const ids = state.groups[group];

          return `
              <div class="group-card">

                <div class="group-card-head">
                  <h3>GROUP ${group}</h3>
                  <span>${ids.length} TEAMS</span>
                </div>

                <div class="group-team-list">

                  ${ids
                    .map((id) => {
                      const t = getTeamById(id);

                      return `
                        <div class="group-team">

                          ${avatarHTML(t)}

                          <div title="${escapeHtml(t.name)}">
                            ${escapeHtml(t.name)}
                          </div>

                        </div>
                      `;
                    })
                    .join("")}

                </div>

              </div>
            `;
        })
        .join("")
    : `
        <div
          class="empty-state"
          style="grid-column:1/-1"
        >
          Your two groups will appear here after the official draw.
        </div>
      `;
}

/* =========================================================
   GROUP FIXTURES
   ========================================================= */

function renderFixtures() {
  const rounds = state.fixtures[activeGroup] || [];

  $("#rounds").innerHTML = rounds.length
    ? rounds
        .map(
          (games, ri) => `
              <div class="round-card">

                <div class="round-head">
                  <b>Matchday ${ri + 1}</b>
                  <span>${games.length} FIXTURES</span>
                </div>

                <div class="match-list">

                  ${games
                    .map((match, mi) => renderMatch(match, ri, mi))
                    .join("")}

                </div>

              </div>
            `,
        )
        .join("")
    : `
        <div class="empty-state">
          Draw the groups to generate your round-robin fixtures.
        </div>
      `;

  $$("#rounds .save-match").forEach((btn) =>
    btn.addEventListener("click", () =>
      saveMatch(Number(btn.dataset.round), Number(btn.dataset.match)),
    ),
  );

  applyViewerMode();
}

function renderMatch(match, ri, mi) {
  const home = getTeam(match.home);

  const away = getTeam(match.away);

  return `
    <div class="match">

      <div class="team-side">
        ${avatarHTML(home)}
        <span>
          ${escapeHtml(home?.name || "TBD")}
        </span>
      </div>

      <div class="score-box">

        <input
          class="score-input"
          id="score-${activeGroup}-${ri}-${mi}-h"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="2"
          value="${match.homeScore}"
          aria-label="Home score"
        >

        <span class="score-sep">:</span>

        <input
          class="score-input"
          id="score-${activeGroup}-${ri}-${mi}-a"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="2"
          value="${match.awayScore}"
          aria-label="Away score"
        >

      </div>

      <div class="team-side right">

        <span>
          ${escapeHtml(away?.name || "TBD")}
        </span>

        ${avatarHTML(away)}

      </div>

      <div class="match-status">

        ${match.played ? "Result saved" : "Enter result"}

        ·

        <button
          class="save-match"
          data-round="${ri}"
          data-match="${mi}"
        >
          ${match.played ? "Update" : "Save"}
        </button>

      </div>

    </div>
  `;
}

function saveMatch(ri, mi) {
  if (blockViewerEdit("Viewer mode: scores cannot be edited.")) return;

  const match = state.fixtures[activeGroup][ri][mi];

  const h = $(`#score-${activeGroup}-${ri}-${mi}-h`).value.trim();

  const a = $(`#score-${activeGroup}-${ri}-${mi}-a`).value.trim();

  if (h === "" || a === "" || Number(h) < 0 || Number(a) < 0) {
    toast("Enter both scores first.");

    return;
  }

  match.homeScore = Number(h);

  match.awayScore = Number(a);

  match.played = true;

  state.knockout.sf1.winner = null;

  state.knockout.sf2.winner = null;

  state.knockout.final.winner = null;

  persist("Result saved · syncing…");

  renderFixtures();
  renderStandings();
  renderBracket();

  toast("Result saved — standings updated for everyone.");
}

/* =========================================================
   STANDINGS
   ========================================================= */

function getStandings(group) {
  const rows = state.groups[group].map((id) => ({
    id,
    team: getTeam(id),
    p: 0,
    w: 0,
    d: 0,
    l: 0,
    gf: 0,
    ga: 0,
    gd: 0,
    pts: 0,
  }));

  const map = Object.fromEntries(rows.map((r) => [r.id, r]));

  (state.fixtures[group] || []).flat().forEach((m) => {
    if (!m.played) return;

    const h = map[m.home];

    const a = map[m.away];

    if (!h || !a) return;

    const hs = Number(m.homeScore);

    const as = Number(m.awayScore);

    h.p++;
    a.p++;

    h.gf += hs;
    h.ga += as;

    a.gf += as;
    a.ga += hs;

    if (hs > as) {
      h.w++;
      h.pts += 3;
      a.l++;
    } else if (hs < as) {
      a.w++;
      a.pts += 3;
      h.l++;
    } else {
      h.d++;
      a.d++;

      h.pts++;
      a.pts++;
    }
  });

  rows.forEach((r) => (r.gd = r.gf - r.ga));

  rows.sort(
    (a, b) =>
      b.pts - a.pts ||
      b.gd - a.gd ||
      b.gf - a.gf ||
      a.team.name.localeCompare(b.team.name),
  );

  return rows;
}

function renderStandings() {
  $("#standingsGrid").innerHTML = ["A", "B"]
    .map((group) => {
      const rows = getStandings(group);

      return `
          <div class="table-card">

            <div class="table-head">

              <h3>
                GROUP ${group}
              </h3>

              <span>
                TOP 2 QUALIFY
              </span>

            </div>

            <div class="table-wrap">

              <table>

                <thead>
                  <tr>
                    <th>#</th>
                    <th>TEAM</th>
                    <th>P</th>
                    <th>W</th>
                    <th>D</th>
                    <th>L</th>
                    <th>GD</th>
                    <th>PTS</th>
                  </tr>
                </thead>

                <tbody>

                  ${rows
                    .map(
                      (r, i) => `
                        <tr>

                          <td class="rank ${i < 2 ? "top" : ""}">
                            ${i + 1}
                          </td>

                          <td>

                            <div class="table-team">

                              ${avatarHTML(r.team)}

                              <span>
                                ${escapeHtml(r.team.name)}
                              </span>

                            </div>

                          </td>

                          <td>${r.p}</td>
                          <td>${r.w}</td>
                          <td>${r.d}</td>
                          <td>${r.l}</td>

                          <td>
                            ${r.gd > 0 ? "+" + r.gd : r.gd}
                          </td>

                          <td class="pts">
                            ${r.pts}
                          </td>

                        </tr>
                      `,
                    )
                    .join("")}

                </tbody>

              </table>

            </div>

          </div>
        `;
    })
    .join("");
}

function qualification() {
  const a = getStandings("A");

  const b = getStandings("B");

  return {
    a1: a[0]?.team || null,

    a2: a[1]?.team || null,

    b1: b[0]?.team || null,

    b2: b[1]?.team || null,
  };
}

/* =========================================================
   KNOCKOUT
   ========================================================= */

function resolveKnockout(match) {
  if (!match.home || !match.away) return null;

  if (match.winner) return getTeam(match.winner);

  if (match.homeScore === "" || match.awayScore === "") return null;

  const h = Number(match.homeScore);

  const a = Number(match.awayScore);

  if (h === a) return null;

  return h > a ? getTeam(match.home) : getTeam(match.away);
}

function renderBracket() {
  const q = qualification();

  const sf1 = state.knockout.sf1;

  const sf2 = state.knockout.sf2;

  sf1.home = q.a1?.id || null;

  sf1.away = q.b2?.id || null;

  sf2.home = q.b1?.id || null;

  sf2.away = q.a2?.id || null;

  const sf1Winner = resolveKnockout(sf1);

  const sf2Winner = resolveKnockout(sf2);

  state.knockout.final.home = sf1Winner?.id || null;

  state.knockout.final.away = sf2Winner?.id || null;

  const final = state.knockout.final;

  const champion = resolveKnockout(final);

  $("#bracket").innerHTML = `

    <div class="bracket-col left">

      <div class="bracket-title">
        SEMI-FINAL 01 · GROUP A WINNER VS GROUP B RUNNER-UP
      </div>

      ${bracketMatchHTML(sf1, "sf1")}

    </div>

    <div class="bracket-col final">

      <div class="bracket-title">
        THE FINAL
      </div>

      ${bracketMatchHTML(final, "final", true)}

    </div>

    <div class="bracket-col right">

      <div class="bracket-title">
        SEMI-FINAL 02 · GROUP B WINNER VS GROUP A RUNNER-UP
      </div>

      ${bracketMatchHTML(sf2, "sf2")}

    </div>
  `;

  attachBracketListeners();

  updateChampion(champion);

  localPersist();

  applyViewerMode();
}

function bracketMatchHTML(match, key, isFinal = false) {
  const home = getTeam(match.home);

  const away = getTeam(match.away);

  const winner = match.winner;

  const disabled = !home || !away ? "disabled" : "";

  return `
    <div class="bracket-match ${isFinal ? "final-card" : ""}">

      <div class="bracket-team ${winner === match.home ? "winner" : ""}">

        ${avatarHTML(home)}

        <span>
          ${escapeHtml(home?.name || "TBD")}
        </span>

        <span class="seed"></span>

      </div>

      <div class="bracket-team ${winner === match.away ? "winner" : ""}">

        ${avatarHTML(away)}

        <span>
          ${escapeHtml(away?.name || "TBD")}
        </span>

        <span class="seed"></span>

      </div>

      <div class="bracket-score">

        <input
          data-ko-key="${key}"
          data-ko-field="homeScore"
          inputmode="numeric"
          maxlength="2"
          value="${match.homeScore}"
          ${disabled}
          aria-label="${key} home score"
        >

        <span>:</span>

        <input
          data-ko-key="${key}"
          data-ko-field="awayScore"
          inputmode="numeric"
          maxlength="2"
          value="${match.awayScore}"
          ${disabled}
          aria-label="${key} away score"
        >

        <button
          data-ko-save="${key}"
          ${disabled}
        >
          ${winner ? "Update" : "Save"}
        </button>

      </div>

    </div>
  `;
}

function attachBracketListeners() {
  $$("[data-ko-save]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (blockViewerEdit("Viewer mode: knockout scores cannot be edited."))
        return;

      const key = btn.dataset.koSave;

      const match = state.knockout[key];

      const h = document
        .querySelector(`[data-ko-key="${key}"][data-ko-field="homeScore"]`)
        .value.trim();

      const a = document
        .querySelector(`[data-ko-key="${key}"][data-ko-field="awayScore"]`)
        .value.trim();

      if (h === "" || a === "") {
        toast("Enter both knockout scores.");

        return;
      }

      if (Number(h) === Number(a)) {
        toast(
          "A knockout match cannot end level here. Enter a decisive result.",
        );

        return;
      }

      match.homeScore = Number(h);

      match.awayScore = Number(a);

      match.winner = Number(h) > Number(a) ? match.home : match.away;

      persist("Knockout result saved · syncing…");

      renderBracket();

      toast(
        key === "final"
          ? "Champion crowned and synced!"
          : "Winner advanced to the next round.",
      );
    }),
  );
}

function updateChampion(champion) {
  const name = $("#championName");

  const sub = $("#championSub");

  if (champion) {
    name.innerHTML = `${escapeHtml(champion.name)}<br><em>ARE CHAMPIONS.</em>`;

    sub.textContent = "UFC Kuthiradam tournament champions";
  } else {
    name.innerHTML = "THE CHAMPION<br><em>IS WAITING.</em>";

    sub.textContent = "Complete the knockout stage to crown the winner.";
  }
}

/* =========================================================
   MAIN RENDER
   ========================================================= */

function renderAll() {
  renderTeams();
  renderGroups();
  renderFixtures();
  renderStandings();
  renderBracket();

  $("#statTeams").textContent = state.teams.length;

  $("#drawHint").textContent = state.groups.A.length
    ? "Groups drawn in entry order. First 5 teams are in Group A; next 5 are in Group B."
    : "Enter all ten teams above to activate the draw.";

  $("#roomCodeLabel").textContent = `ROOM: ${ROOM_ID.toUpperCase()}`;

  applyViewerMode();
}

/* =========================================================
   RESET
   ========================================================= */

async function resetTournament() {
  if (blockViewerEdit("Viewer mode: tournament reset is disabled.")) return;

  if (
    !confirm(
      "Reset all teams, groups, fixtures, scores and shared tournament data?",
    )
  )
    return;

  state = clone(defaultState);

  localStorage.removeItem(STORAGE_KEY);

  renderAll();

  if (cloudReady) {
    await syncStateToCloud();
  } else {
    persist("Fresh tournament");
  }

  toast("Tournament reset for this shared room.");

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
}

/* =========================================================
   COPY VIEWER LINK
   ========================================================= */

async function copyLiveLink() {
  const url = new URL(window.location.href);

  url.searchParams.set("tournament", ROOM_ID);

  // THIS MAKES THE COPIED LINK READ-ONLY
  url.searchParams.set("mode", "view");

  try {
    await navigator.clipboard.writeText(url.toString());

    toast("Viewer link copied.");
  } catch {
    window.prompt("Copy this viewer link:", url.toString());
  }
}

/* =========================================================
   EVENT LISTENERS
   ========================================================= */

$("#saveTeamsBtn").addEventListener("click", saveTeams);

$("#fillDemoBtn").addEventListener("click", fillDemo);

$("#drawGroupsBtn").addEventListener("click", drawGroups);

$("#regenerateFixturesBtn").addEventListener("click", regenerateFixtures);

$("#resetBtn").addEventListener("click", resetTournament);

$("#copyLinkBtn").addEventListener("click", copyLiveLink);

$("#startSetupBtn").addEventListener("click", () =>
  document.querySelector("#setup").scrollIntoView({
    behavior: "smooth",
  }),
);

$("#scrollFixturesBtn").addEventListener("click", () =>
  document.querySelector("#fixtures").scrollIntoView({
    behavior: "smooth",
  }),
);

$("#fixtureTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");

  if (!btn) return;

  activeGroup = btn.dataset.group;

  $$(".tab").forEach((x) => x.classList.toggle("active", x === btn));

  renderFixtures();
});

/* =========================================================
   START APPLICATION
   ========================================================= */

renderAll();
initCloud();
