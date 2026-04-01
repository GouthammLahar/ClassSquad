import { 
  auth, loginWithGoogle, logoutUser, onAuthChange,
  createGroup, joinGroup, leaveGroup, getUserGroups,
  regenerateGroupCode, deleteGroup,
  getGroupProfile, updateGroupProfile, saveGroupSchedule, deleteGroupSchedule,
  getFriendSchedule, getAllGroupStudents, searchGroupFriends, getGroupSquadStatus, getGroupMemberCount
} from './db.js';
import { parseTimetableImage } from './api.js';

document.addEventListener('DOMContentLoaded', () => {

  // --- APP NAVIGATION ---
  const navBtns = document.querySelectorAll('.nav-btn');
  const views = document.querySelectorAll('.view');
  const mainNav = document.getElementById('main-nav');
  const googleLoginBtn = document.getElementById('google-login-btn');
  const logoutBtn = document.getElementById('logout-btn');
  
  // --- SUBVIEWS DOM ---
  const groupSwitcher = document.getElementById('group-switcher-select');
  const profileTabBtn = document.querySelector('[data-target="profile-view"]');

  // --- GLOBAL STATE ---
  let activeGroupId = null;
  let activeGroupMeta = null;
  let currentUserProfile = null; // per group
  let allMyGroups = [];
  let userIsAdmin = false;

  function switchView(targetId) {
    navBtns.forEach(b => b.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    const targetView = document.getElementById(targetId);
    if (targetView) targetView.classList.add('active');
    const targetNav = document.querySelector(`.nav-btn[data-target="${targetId}"]`);
    if (targetNav) targetNav.classList.add('active');
  }

  navBtns.forEach(btn => {
    if (btn.id === 'logout-btn') return;
    btn.addEventListener('click', () => {
      switchView(btn.getAttribute('data-target'));
      if (btn.getAttribute('data-target') === 'groups-view') renderGroupsDashboard();
    });
  });

  if(googleLoginBtn) {
    googleLoginBtn.addEventListener('click', async () => {
      try { await loginWithGoogle(); } catch (e) { console.error("Login failed:", e); }
    });
  }

  const doLogout = async () => { await logoutUser(); };
  if(logoutBtn) logoutBtn.addEventListener('click', doLogout);
  const onboardLogout = document.getElementById('onboard-logout-btn');
  if(onboardLogout) onboardLogout.addEventListener('click', doLogout);

  /* =========================================================
     AUTH ROUTER & GROUP LOAD
  ========================================================= */
  onAuthChange(async (user) => {
    if (user) {
      await reloadAllUserGroups();
    } else {
      mainNav.classList.add('hidden');
      switchView('login-view');
      activeGroupId = null;
      activeGroupMeta = null;
      currentUserProfile = null;
    }
  });

  async function reloadAllUserGroups(forceMessage = null) {
    mainNav.classList.add('hidden');
    if (!auth.currentUser) return;
    
    allMyGroups = await getUserGroups();
    
    if (allMyGroups.length === 0) {
       switchView('groups-view'); // 0 groups, default to Create/Join board
       renderGroupsDashboard();
       const panicEl = document.getElementById('onboard-panic-msg');
       if (forceMessage) {
          panicEl.innerText = forceMessage;
          panicEl.classList.remove('hidden');
       } else {
          panicEl.classList.add('hidden');
       }
       document.getElementById('onboard-logout-btn').classList.remove('hidden');
       return;
    }

    document.getElementById('onboard-logout-btn').classList.add('hidden');
    document.getElementById('onboard-panic-msg').classList.add('hidden');

    // Populate Switcher
    groupSwitcher.innerHTML = "";
    allMyGroups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.innerText = g.name;
      groupSwitcher.appendChild(opt);
    });
    
    // Set active
    if (!activeGroupId || !allMyGroups.find(g => g.id === activeGroupId)) {
      activeGroupId = allMyGroups[0].id;
    }
    groupSwitcher.value = activeGroupId;
    await applyGroupContext(activeGroupId);
  }

  groupSwitcher.addEventListener('change', async (e) => {
    await applyGroupContext(e.target.value);
  });

  async function applyGroupContext(groupId) {
    activeGroupId = groupId;
    activeGroupMeta = allMyGroups.find(g => g.id === groupId);
    userIsAdmin = activeGroupMeta.adminUid === auth.currentUser.uid;
    
    try {
      currentUserProfile = await getGroupProfile(groupId);
    } catch(e) {
      console.warn("Group seems to have been deleted!");
      await reloadAllUserGroups("This group has been deleted by the admin");
      return;
    }
    
    mainNav.classList.remove('hidden');
    allStudentsCache = null; // Clear feature cache

    if (!currentUserProfile || !currentUserProfile.name) {
      switchView('profile-view');
    } else {
      await evaluateTimetableStatus();
      switchView('upload-view'); // My Timetable view default
    }
  }

  /* =========================================================
     SMART TIMETABLE (My Timetable) LOGIC
  ========================================================= */
  const uploadFormArea = document.getElementById('upload-form');
  const displayTimetableArea = document.getElementById('timetable-display-area');
  const myCalendarGrid = document.getElementById('my-calendar-grid');
  
  const updateModal = document.getElementById('update-warning-modal');
  document.getElementById('trigger-update-btn').addEventListener('click', () => {
    updateModal.classList.remove('hidden');
  });
  document.getElementById('cancel-update-btn').addEventListener('click', () => {
    updateModal.classList.add('hidden');
  });
  document.getElementById('confirm-update-btn').addEventListener('click', async () => {
    updateModal.classList.add('hidden');
    timetableStatusText.innerText = "Deleting old schedule...";
    await deleteGroupSchedule(activeGroupId);
    await evaluateTimetableStatus(); // Should loop back to empty state!
  });

  async function evaluateTimetableStatus() {
     const statusTag = document.getElementById('my-timetable-status');
     statusTag.innerText = 'Checking…';
     const scheduleDocument = await getFriendSchedule(activeGroupId, auth.currentUser.uid);
     
     if (scheduleDocument && scheduleDocument.schedule) {
       let dateStr = 'Unknown Date';
       if (scheduleDocument.updatedAt) {
         const d = new Date(scheduleDocument.updatedAt);
         dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
       }
       statusTag.innerText = `✓  Uploaded on: ${dateStr}`;
       statusTag.className = 'upload-status-tag';
       
       uploadFormArea.classList.add('hidden');
       displayTimetableArea.classList.remove('hidden');
       renderGenericCalendar(myCalendarGrid, scheduleDocument.schedule);
     } else {
       statusTag.innerText = 'Not uploaded yet';
       statusTag.className = 'upload-status-tag empty';
       uploadFormArea.classList.remove('hidden');
       displayTimetableArea.classList.add('hidden');
     }
  }

  // File Upload Handlers (for when the user drops a new photo)
  const fileInput = document.getElementById('timetable-image');
  const uploadBtn = document.getElementById('upload-btn');
  const statusEl = document.getElementById('upload-status');
  const statusText = document.getElementById('status-text');
  const imagePreview = document.getElementById('image-preview');

  fileInput.addEventListener('change', function() {
    if (this.files && this.files[0]) {
      const reader = new FileReader();
      reader.onload = (e) => {
        imagePreview.src = e.target.result;
        imagePreview.classList.remove('hidden');
      };
      reader.readAsDataURL(this.files[0]);
    }
  });

  const compressImage = (file, maxDim = 1200) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7)); 
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
  });

  uploadFormArea.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeGroupId) return;
    
    const file = fileInput.files[0];
    if (!file) return alert("Please select an image file first.");

    try {
      uploadBtn.disabled = true;
      statusEl.classList.remove('hidden');
      statusText.innerText = "Optimizing image before upload...";
      const base64Img = await compressImage(file);
      statusText.innerText = "Analyzing image with Gemini Vision...";
      const scheduleData = await parseTimetableImage(base64Img);
      statusText.innerText = "Saving securely to Group database...";
      
      await saveGroupSchedule(activeGroupId, scheduleData);

      statusText.innerText = "Timetable updated successfully";
      statusEl.style.backgroundColor = "rgba(46, 204, 113, 0.2)";
      statusEl.style.color = "#27ae60";

      setTimeout(async () => {
        uploadFormArea.reset();
        imagePreview.classList.add('hidden');
        statusEl.classList.add('hidden');
        uploadBtn.disabled = false;
        statusEl.style.backgroundColor = ""; statusEl.style.color = "";
        
        await evaluateTimetableStatus(); // Will flip to the Display screen!
      }, 2500);
    } catch (error) {
      statusText.innerText = "Error: " + error.message;
      statusEl.style.backgroundColor = "rgba(231, 76, 60, 0.2)";
      statusEl.style.color = "#e74c3c";
      uploadBtn.disabled = false;
    }
  });


  /* =========================================================
     GROUPS DASHBOARD (Replaces Settings)
  ========================================================= */
  const createGroupBtn = document.getElementById('create-group-btn');
  const joinGroupBtn = document.getElementById('join-group-btn');
  const onboardError = document.getElementById('onboard-error');

  createGroupBtn.addEventListener('click', async () => {
    const name = document.getElementById('create-group-name').value;
    if (!name) return;
    onboardError.innerText = "Creating Group...";
    try {
      const g = await createGroup(name);
      activeGroupId = g.id;
      document.getElementById('create-group-name').value = ""; // clean
      await reloadAllUserGroups();
    } catch (e) { onboardError.innerText = e.message; }
  });

  joinGroupBtn.addEventListener('click', async () => {
    const code = document.getElementById('join-group-code').value;
    if (!code) return;
    onboardError.innerText = "Joining...";
    try {
      const g = await joinGroup(code);
      activeGroupId = g.id;
      document.getElementById('join-group-code').value = ""; // clean
      await reloadAllUserGroups();
    } catch (e) { onboardError.innerText = e.message; }
  });

  async function renderGroupsDashboard() {
     const grid = document.getElementById('my-groups-grid');
     grid.innerHTML = "Loading cards...";
     if (allMyGroups.length === 0) {
       grid.innerHTML = "<div class='empty-state' style='grid-column: 1/-1'>You are not in any groups.</div>";
       return;
     }

     grid.innerHTML = "";
     for (const group of allMyGroups) {
       let memberCount = "...";
       try { memberCount = await getGroupMemberCount(group.id); } catch(e){}
       const isAdmin = group.adminUid === auth.currentUser.uid;
       
       const card = document.createElement('div');
       card.className = 'group-card';

       card.innerHTML = `
         <div class="group-card-header">
           <div class="group-avatar">${group.name.substring(0,1).toUpperCase()}</div>
           <div class="group-card-meta">
             <h3>${group.name}</h3>
             <span class="role-badge ${isAdmin ? 'admin' : 'member'}">${isAdmin ? '● Admin' : 'Member'}</span>
           </div>
         </div>

         <div class="group-card-stats">
           <svg width="15" height="15" fill="currentColor" viewBox="0 0 20 20"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z"/></svg>
           ${memberCount} members
         </div>

         ${isAdmin ? `
           <div class="group-invite-code">
             <span class="code-label">Invite Code</span>
             <span class="code-value">${group.code}</span>
           </div>` : ''}

         <div class="group-card-actions">
           ${isAdmin
             ? `<button class="primary-btn btn-sm dashboard-delete-btn" data-id="${group.id}" style="background:var(--red); box-shadow:0 2px 8px rgba(239,68,68,0.25);">Delete Group</button>`
             : `<button class="secondary-btn btn-sm dashboard-leave-btn" data-id="${group.id}" style="color:var(--red); border-color:var(--red);">Leave Group</button>`
           }
         </div>
       `;
       grid.appendChild(card);
     }

     // Bind dynamic actions
     document.querySelectorAll('.dashboard-delete-btn').forEach(b => {
       b.addEventListener('click', async (e) => {
         if(confirm("DANGER! This deletes the entire group and drops all members forcefully. Are you absolutely sure?")) {
           e.target.innerText = "Deleting...";
           e.target.disabled = true;
           await deleteGroup(e.target.getAttribute('data-id'));
           await reloadAllUserGroups("Group deleted.");
         }
       });
     });

     document.querySelectorAll('.dashboard-leave-btn').forEach(b => {
       b.addEventListener('click', async (e) => {
         if(confirm("Leave this group? You will lose access to everything here.")) {
           e.target.innerText = "Leaving...";
           e.target.disabled = true;
           await leaveGroup(e.target.getAttribute('data-id'));
           if (activeGroupId === e.target.getAttribute('data-id')) activeGroupId = null;
           await reloadAllUserGroups();
         }
       });
     });
  }

  /* =========================================================
     GENERIC UI HELPERS (Calendars)
  ========================================================= */
  function renderGenericCalendar(containerDOM, scheduleMap) {
    containerDOM.innerHTML = ""; 
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const hours = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];

    containerDOM.appendChild(createCell('cal-header', 'Time'));
    days.forEach(day => containerDOM.appendChild(createCell('cal-header', day)));

    hours.forEach(hour => {
      containerDOM.appendChild(createCell('cal-time', formatTime(hour)));
      days.forEach(day => {
        let statusObj = { status: "free" };
        if (scheduleMap && scheduleMap[day] && scheduleMap[day][hour]) { statusObj = scheduleMap[day][hour]; }
        const cell = document.createElement('div');
        cell.className = `cal-cell ${statusObj.status}`;
        if (statusObj.status === 'busy') cell.innerHTML = `<div class="subject">${statusObj.subject || 'Class'}</div><div class="room">${statusObj.room || ''}</div>`;
        else cell.innerHTML = "Free";
        containerDOM.appendChild(cell);
      });
    });
  }
  function createCell(className, text) { const div = document.createElement('div'); div.className = className; div.innerText = text; return div; }
  function formatTime(t24) {
    const [h, m] = t24.split(":"); let hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM'; hour = hour % 12; if(hour === 0) hour = 12;
    return `${hour}:${m} ${ampm}`;
  }


  /* =========================================================
     PROFILE LOGIC (SCOPED)
  ========================================================= */
  const profileForm = document.getElementById('profile-form');
  const displayNameInput = document.getElementById('display-name');
  
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!activeGroupId) return;
    
    const name = displayNameInput.value;
    document.getElementById('profile-status').classList.remove('hidden');
    document.getElementById('profile-status-text').innerText = "Saving profile...";
    
    try {
      await updateGroupProfile(activeGroupId, name, []);
      currentUserProfile = await getGroupProfile(activeGroupId);
      document.getElementById('profile-status-text').innerText = "Profile saved successfully!";
      setTimeout(() => switchView('upload-view'), 1000);
    } catch (error) { document.getElementById('profile-status-text').innerText = "Failed to save profile."; }
  });

  profileTabBtn.addEventListener('click', () => {
     if (currentUserProfile) {
       displayNameInput.value = currentUserProfile.name || "";
     }
  });


  /* =========================================================
     FIND FRIEND LOGIC (SCOPED)
  ========================================================= */
  const searchBtn = document.getElementById('search-btn');
  const searchResultsDiv = document.getElementById('search-results');
  const friendScheduleContainer = document.getElementById('friend-schedule-container');
  const calendarGrid = document.getElementById('calendar-grid');

  searchBtn.addEventListener('click', async () => {
    const q = document.getElementById('search-input').value.trim();
    if (!q || !activeGroupId) return;
    searchResultsDiv.innerHTML = "Searching Group...";
    friendScheduleContainer.classList.add('hidden');

    try {
      const results = await searchGroupFriends(activeGroupId, q);
      searchResultsDiv.innerHTML = "";
      if (results.length === 0) {
        searchResultsDiv.innerHTML = "<p>No friends found matching that name in this group.</p>";
        return;
      }
      results.forEach(friend => {
        const div = document.createElement('div'); div.className = 'friend-card-preview';
        div.innerHTML = `<strong>${friend.name}</strong> <span>View Schedule &rarr;</span>`;
        div.addEventListener('click', () => {
          document.querySelector('#friend-name-display span').innerText = friend.name;
          friendScheduleContainer.classList.remove('hidden');
          renderGenericCalendar(calendarGrid, friend.schedule);
        });
        searchResultsDiv.appendChild(div);
      });
    } catch (error) { searchResultsDiv.innerHTML = `<p style="color:red">Error searching: ${error.message}</p>`; }
  });


  /* =========================================================
     SQUAD OVERVIEW LOGIC (SCOPED)
  ========================================================= */
  document.getElementById('check-squad-btn').addEventListener('click', async () => {
    if(!activeGroupId) return;
    const day = document.getElementById('day-select').value;
    const time = document.getElementById('time-select').value;
    const resDiv = document.getElementById('squad-results');
    resDiv.innerHTML = "Loading group status...";
    try {
      const results = await getGroupSquadStatus(activeGroupId, day, time);
      resDiv.innerHTML = "";
      if (results.length === 0) { resDiv.innerHTML = '<div class="empty-state">No group members found.</div>'; return; }
      results.forEach(student => {
        const isFree = student.status === "Free";
        const div = document.createElement('div'); div.className = 'squad-card';
        div.innerHTML = `
          <div class="info"><h4>${student.name}</h4><p>${isFree ? 'Ready to hang out! 😎' : (student.subject + ' | ' + student.room)}</p></div>
          <div class="status-badge ${isFree ? 'free' : 'busy'}">${student.status}</div>`;
        resDiv.appendChild(div);
      });
    } catch (error) { resDiv.innerHTML = `<div style="color:red">Error: ${error.message}</div>`; }
  });


  /* =========================================================
     CACHING & ADVANCED VIEWS (SCOPED)
  ========================================================= */
  let allStudentsCache = null;
  async function loadGroupStudents() {
    if (!allStudentsCache) allStudentsCache = await getAllGroupStudents(activeGroupId);
    return allStudentsCache;
  }

  // Free Slots
  document.querySelector('[data-target="free-slots-view"]').addEventListener('click', async () => {
    if (!activeGroupId) return;
    const cbl = document.getElementById('friend-checkbox-list');
    cbl.innerHTML = "Loading group members...";
    try {
      const students = await loadGroupStudents();
      cbl.innerHTML = "";
      students.forEach((student, index) => {
        const label = document.createElement('label'); label.className = 'friend-checkbox-card';
        label.innerHTML = `<input type="checkbox" value="${index}" class="friend-cb" /><span>${student.name}</span>`;
        label.querySelector('input').addEventListener('change', function() {
          if(this.checked) label.classList.add('selected'); else label.classList.remove('selected');
        });
        cbl.appendChild(label);
      });
    } catch (e) { cbl.innerHTML = "Error loading members."; }
  });

  document.getElementById('find-common-slots-btn').addEventListener('click', () => {
    if(!allStudentsCache) return;
    const cbs = document.querySelectorAll('.friend-cb:checked');
    const out = document.getElementById('common-slots-results');
    if (cbs.length === 0) { out.innerHTML = "<p>Please select friends.</p>"; return; }
    
    const selected = Array.from(cbs).map(cb => allStudentsCache[cb.value]);
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const hours = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
    const common = {};

    days.forEach(day => {
      hours.forEach(hour => {
        let allFree = true;
        for (let s of selected) {
          let st = { status: "free" };
          if (s.schedule && s.schedule[day] && s.schedule[day][hour]) st = s.schedule[day][hour];
          if (st.status !== "free") { allFree = false; break; }
        }
        if (allFree) { if (!common[day]) common[day] = []; common[day].push(hour); }
      });
    });

    let html = ""; let found = false;
    for (let day of days) {
      if (common[day] && common[day].length > 0) {
        found = true;
        html += `<div class="result-day-block"><div class="result-day-header">${day}</div><div class="result-slots">`;
        common[day].forEach(h => html += `<div class="free-time-tag">✓ ${formatTime(h)}</div>`);
        html += `</div></div>`;
      }
    }
    out.innerHTML = found ? html : '<div class="empty-state" style="color:red;">No common free time found</div>';
  });

  // Right Now
  function updateRightNowTime() {
    const now = new Date();
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    document.getElementById('current-time-display').innerText = `It is currently ${now.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit',hour12:true})} on ${days[now.getDay()]}`;
    return { now, currentDay: days[now.getDay()] };
  }

  async function renderLiveTracker() {
    if(!activeGroupId) return;
    const r = document.getElementById('right-now-results');
    r.innerHTML = "Loading live status...";
    const { now, currentDay } = updateRightNowTime();
    
    try {
      const students = await loadGroupStudents();
      r.innerHTML = "";
      
      let hrStr = now.getHours().toString().padStart(2, '0') + ":00";
      const isOff = (currentDay === "Sunday") || (now.getHours() < 8) || (now.getHours() > 18);

      if (students.length === 0) { r.innerHTML = '<div class="empty-state">No active members found.</div>'; return; }

      students.forEach(student => {
        let status = "off"; let sub = "Day off";
        
        if (!isOff) {
          let st = { status: "free" };
          if (student.schedule && student.schedule[currentDay] && student.schedule[currentDay][hrStr]) st = student.schedule[currentDay][hrStr];
          
          if (st.status === "busy") { status = "busy"; sub = `${st.subject} | ${st.room}`; } 
          else { status = "free"; sub = "Free right now!"; }
        }
        const card = document.createElement('div'); card.className = 'squad-card';
        card.innerHTML = `<div class="info"><h4 style="display:flex;align-items:center;gap:0.5rem;"><span class="live-dot ${status}"></span> ${student.name}</h4><p>${sub}</p></div>`;
        r.appendChild(card);
      });
    } catch (e) { r.innerHTML = "Error fetching live data."; }
  }

  document.querySelector('[data-target="right-now-view"]').addEventListener('click', renderLiveTracker);
  document.getElementById('refresh-now-btn').addEventListener('click', renderLiveTracker);

});
