// Aegis AI - Attendance System Frontend Controller

const API_BASE = window.location.origin;
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

// Global variables
let modelsLoaded = false;
let registeredStudents = [];
let monitorStream = null;
let registerStream = null;
let activePeriod = null;
let attendanceMarkedThisSession = new Set(); // To prevent duplicate API requests for same class

// Helper: Standardize and validate Indian mobile numbers
function cleanIndianPhoneNumber(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0091')) {
    cleaned = cleaned.substring(2);
  }
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }
  return cleaned;
}

// Helper: Format phone number for pretty display
function formatPhoneNumberDisplay(phone) {
  const cleaned = cleanIndianPhoneNumber(phone);
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    return `+91 ${cleaned.substring(2, 7)} ${cleaned.substring(7)}`;
  }
  return phone;
}


// Faculty Authentication state
let facultyToken = localStorage.getItem('facultyToken');
let pendingTabRedirect = null; // Store tab to load after successful login

// Authentication Form elements
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginUsernameInput = document.getElementById('login-username');
const loginPasswordInput = document.getElementById('login-password');
const sidebarAuthBtn = document.getElementById('sidebar-auth-btn');

// Form registration elements
const regNameInput = document.getElementById('reg-name');
const regUsnInput = document.getElementById('reg-usn');
const regEmailInput = document.getElementById('reg-email');
const btnTakeSnapshot = document.getElementById('btn-take-snapshot');
const btnSubmitRegistration = document.getElementById('btn-submit-registration');
const captureStatusBox = document.getElementById('capture-status');
const registrationForm = document.getElementById('registration-form');

// Captured biometric descriptor
let capturedFaceDescriptor = null;

// Tab navigation setup
const navBtns = document.querySelectorAll('.nav-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');

const tabSubtitles = {
  dashboard: 'Real-time attendance intelligence & analytics',
  monitor: 'Live period-wise face recognition checkpoint',
  register: 'Enroll student biometric profiles',
  emails: 'Review and manage students falling below academic attendance limits'
};

// Authentication state checks
function isFacultyAuthenticated() {
  return !!facultyToken;
}

// Global fetch wrapper to inject auth headers on protected routes
async function facultyFetch(url, options = {}) {
  // Append cache buster parameter to prevent browser caching
  const delimiter = url.includes('?') ? '&' : '?';
  const finalUrl = `${url}${delimiter}_t=${Date.now()}`;

  if (facultyToken) {
    if (!options.headers) options.headers = {};
    options.headers['Authorization'] = `Bearer ${facultyToken}`;
  }
  const response = await fetch(finalUrl, options);
  if (response.status === 401 || response.status === 403) {
    handleLogout();
    alert('Faculty session expired. Please sign in again.');
    throw new Error('Faculty session expired.');
  }
  return response;
}

// Faculty logout cleanup
function handleLogout() {
  facultyToken = null;
  localStorage.removeItem('facultyToken');
  updateAuthUI();
  
  // Clear directories
  registeredStudents = [];
  
  // If user is currently on a protected tab, force redirect to camera monitor tab (public)
  const activeBtn = document.querySelector('.nav-btn.active');
  if (activeBtn) {
    const tabId = activeBtn.getAttribute('data-tab');
    if (tabId !== 'monitor') {
      document.querySelector('.nav-btn[data-tab="monitor"]').click();
    }
  }
}

function updateAuthUI() {
  const authText = document.getElementById('sidebar-auth-text');
  const authIcon = document.getElementById('auth-btn-icon');
  const lockedNavs = document.querySelectorAll('.nav-btn[data-tab="dashboard"], .nav-btn[data-tab="emails"]');
  
  if (isFacultyAuthenticated()) {
    authText.textContent = 'Faculty Sign Out';
    sidebarAuthBtn.classList.add('signed-in');
    // Change SVG icon to open lock
    authIcon.innerHTML = `
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
    `;
    lockedNavs.forEach(nav => nav.classList.remove('locked'));
  } else {
    authText.textContent = 'Faculty Sign In';
    sidebarAuthBtn.classList.remove('signed-in');
    // Change SVG icon to closed lock
    authIcon.innerHTML = `
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    `;
    lockedNavs.forEach(nav => nav.classList.add('locked'));
  }
}

// Handle Faculty Log In form submission
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = loginUsernameInput.value.trim();
  const password = loginPasswordInput.value.trim();

  try {
    const response = await fetch(`${API_BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (data.success) {
      facultyToken = data.token;
      localStorage.setItem('facultyToken', data.token);
      updateAuthUI();
      loginForm.reset();
      
      // Hide login overlay
      loginOverlay.classList.add('hidden');
      
      // Redirect to pending tab or Dashboard
      const targetTab = pendingTabRedirect || 'dashboard';
      pendingTabRedirect = null;
      
      const navBtn = document.querySelector(`.nav-btn[data-tab="${targetTab}"]`);
      if (navBtn) {
        navBtn.click();
      }
    } else {
      alert(data.error || 'Authentication failed. Please verify credentials.');
    }
  } catch (error) {
    console.error('Login error:', error);
    alert('Failed to connect to authentication server.');
  }
});

// Sidebar Sign In / Out button click handler
sidebarAuthBtn.addEventListener('click', () => {
  if (isFacultyAuthenticated()) {
    if (confirm('Are you sure you want to log out of the Faculty Portal?')) {
      handleLogout();
    }
  } else {
    // Show login overlay on Dashboard
    pendingTabRedirect = 'dashboard';
    hideAllTabPanels();
    loginOverlay.classList.remove('hidden');
    pageTitle.textContent = 'Faculty Authentication';
    pageSubtitle.textContent = 'Faculty administrative portal sign in';
  }
});

// Navigation handlers with auth gate
navBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');
    const isProtected = ['dashboard', 'emails'].includes(tabId);

    // Stop streams
    if (tabId !== 'monitor') stopMonitorCamera();
    if (tabId !== 'register') stopRegisterCamera();

    // Visual resets
    navBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (isProtected && !isFacultyAuthenticated()) {
      // Store redirect target
      pendingTabRedirect = tabId;
      hideAllTabPanels();
      
      // Show login card
      loginOverlay.classList.remove('hidden');
      pageTitle.textContent = 'Faculty Authentication';
      pageSubtitle.textContent = 'Faculty administrative portal sign in';
      return;
    }

    // Hide login overlay & load normal content
    loginOverlay.classList.add('hidden');
    hideAllTabPanels();
    document.getElementById(`tab-${tabId}`).classList.add('active');
    
    // Set Header titles
    pageTitle.textContent = btn.textContent.trim().replace('🔒', '').trim();
    pageSubtitle.textContent = tabSubtitles[tabId];

    // Load data
    if (tabId === 'dashboard') {
      loadDashboardData();
    } else if (tabId === 'monitor') {
      initMonitorTab();
    } else if (tabId === 'emails') {
      refreshDefaultersPanel();
    }
  });
});

function hideAllTabPanels() {
  tabPanels.forEach(p => p.classList.remove('active'));
}

// ----------------------------------------------------
// 1. Initial Load & Setup
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  // Check auth cookie/token
  updateAuthUI();

  // Set default dates in inputs
  const todayStr = new Date().toISOString().split('T')[0];
  document.getElementById('sim-date').value = todayStr;

  // Load Neural Network models
  await loadFaceApiModels();
  
  // Set up Monitor Tab parameters
  initMonitorTab();
  
  // Period ticker loop (updates current period visual widgets every 30 seconds)
  updatePeriodWidget();
  setInterval(updatePeriodWidget, 30000);
});

async function loadFaceApiModels() {
  const loader = document.getElementById('model-loader');
  const loaderText = document.getElementById('model-loader-text');
  
  try {
    console.log('Loading face-api.js models from CDN...');
    loaderText.textContent = 'Loading SSD Mobilenet v1 Face Detector (High Accuracy)...';
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    
    loaderText.textContent = 'Loading Face Landmark model...';
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    
    loaderText.textContent = 'Loading Face Recognition model...';
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
    console.log('Models loaded successfully.');
    modelsLoaded = true;
    loader.style.opacity = '0';
    setTimeout(() => loader.style.display = 'none', 400);
  } catch (error) {
    console.error('Failed to load face-api models:', error);
    loaderText.innerHTML = '<span style="color: #f43f5e;">Error loading models. Please verify internet connection.</span>';
  }
}

// ----------------------------------------------------
// 2. Period Scheduler & System Time Override Logic
// ----------------------------------------------------
const simModeToggle = document.getElementById('simulation-mode-toggle');
const simControlsPanel = document.getElementById('sim-controls-panel');
const simDateInput = document.getElementById('sim-date');
const simPeriodSelect = document.getElementById('sim-period');

simModeToggle.addEventListener('change', () => {
  if (simModeToggle.checked) {
    simControlsPanel.classList.remove('hidden');
    addLog('System', 'Time Override Mode activated. Custom date/period enabled.', 'info');
  } else {
    simControlsPanel.classList.add('hidden');
    addLog('System', 'Automatic Time Mode restored.', 'info');
  }
  updatePeriodWidget();
});

simDateInput.addEventListener('change', updatePeriodWidget);
simPeriodSelect.addEventListener('change', updatePeriodWidget);
document.getElementById('sim-elapsed').addEventListener('change', updatePeriodWidget);

const PERIOD_TIMES = {
  1: { name: 'Period 1', start: '09:00 AM', end: '09:55 AM' },
  2: { name: 'Period 2', start: '09:55 AM', end: '10:50 AM' },
  3: { name: 'Period 3', start: '11:10 AM', end: '12:05 PM' },
  4: { name: 'Period 4', start: '12:05 PM', end: '01:00 PM' },
  5: { name: 'Period 5', start: '02:00 PM', end: '02:55 PM' },
  6: { name: 'Period 6', start: '02:55 PM', end: '03:50 PM' }
};

// Returns { type, name, number, start, end, date, attendanceClosed, minutesElapsed }
function getActiveSchedule() {
  const isSim = simModeToggle.checked;
  const simDate = simDateInput.value;

  if (isSim) {
    const periodNum = parseInt(simPeriodSelect.value);
    const pInfo = PERIOD_TIMES[periodNum];
    const simElapsed = document.getElementById('sim-elapsed').value;
    const attendanceClosed = simElapsed === 'closed';
    return {
      type: 'period',
      name: pInfo.name,
      number: periodNum,
      start: pInfo.start,
      end: pInfo.end,
      date: simDate,
      attendanceClosed,
      minutesElapsed: attendanceClosed ? 15 : 5
    };
  }

  // Automatic Mode (Real clock, local date)
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const localDateStr = `${year}-${month}-${day}`;
  const minutes = now.getHours() * 60 + now.getMinutes();

  const periods = [
    { number: 1, name: 'Period 1', start: '09:00 AM', end: '09:55 AM', minStart: 540, minEnd: 595 },
    { number: 2, name: 'Period 2', start: '09:55 AM', end: '10:50 AM', minStart: 595, minEnd: 650 },
    { number: 3, name: 'Period 3', start: '11:10 AM', end: '12:05 PM', minStart: 670, minEnd: 725 },
    { number: 4, name: 'Period 4', start: '12:05 PM', end: '01:00 PM', minStart: 725, minEnd: 780 },
    { number: 5, name: 'Period 5', start: '02:00 PM', end: '02:55 PM', minStart: 840, minEnd: 895 },
    { number: 6, name: 'Period 6', start: '02:55 PM', end: '03:50 PM', minStart: 895, minEnd: 950 }
  ];

  const breaks = [
    { name: 'Leisure Break', start: '10:50 AM', end: '11:10 AM', minStart: 650, minEnd: 670 },
    { name: 'Lunch Break', start: '01:00 PM', end: '02:00 PM', minStart: 780, minEnd: 840 }
  ];

  // Check periods
  for (const p of periods) {
    if (minutes >= p.minStart && minutes < p.minEnd) {
      const attendanceClosed = (minutes - p.minStart) >= 10;
      return {
        type: 'period',
        name: p.name,
        number: p.number,
        start: p.start,
        end: p.end,
        date: localDateStr,
        attendanceClosed,
        minutesElapsed: minutes - p.minStart
      };
    }
  }

  // Check breaks
  for (const b of breaks) {
    if (minutes >= b.minStart && minutes < b.minEnd) {
      return { type: 'break', name: b.name, start: b.start, end: b.end, date: localDateStr };
    }
  }

  return {
    type: 'off',
    name: 'College Closed',
    start: '03:50 PM',
    end: '09:00 AM',
    date: localDateStr
  };
}

function updatePeriodWidget() {
  const schedule = getActiveSchedule();
  activePeriod = schedule;

  // Header updates
  const headerPeriodVal = document.getElementById('header-period-val');
  const headerPeriodTime = document.getElementById('header-period-time');
  const sidebarPeriodName = document.getElementById('sidebar-period-name');
  const statusBanner = document.getElementById('attendance-status-banner');
  
  if (schedule.type === 'period') {
    headerPeriodVal.textContent = schedule.name;
    headerPeriodTime.textContent = `${schedule.start} - ${schedule.end} (${schedule.date})`;
    
    if (statusBanner) {
      statusBanner.style.display = 'flex';
      if (schedule.attendanceClosed) {
        statusBanner.className = 'attendance-banner-overlay closed';
        statusBanner.innerHTML = `<span>🔒 Attendance Closed for ${schedule.name}</span>`;
        sidebarPeriodName.textContent = `${schedule.name} Closed`;
        document.getElementById('sidebar-period-badge').querySelector('.dot').style.backgroundColor = 'var(--color-danger)';
      } else {
        const minsLeft = 10 - schedule.minutesElapsed;
        statusBanner.className = 'attendance-banner-overlay open';
        statusBanner.innerHTML = `<span>⚡ Attendance Open (Closes in ${minsLeft} mins)</span>`;
        sidebarPeriodName.textContent = `${schedule.name} Active`;
        document.getElementById('sidebar-period-badge').querySelector('.dot').style.backgroundColor = 'var(--color-success)';
      }
    }
  } else {
    if (statusBanner) {
      statusBanner.style.display = 'none';
    }
    
    if (schedule.type === 'break') {
      headerPeriodVal.textContent = schedule.name;
      headerPeriodTime.textContent = `${schedule.start} - ${schedule.end}`;
      sidebarPeriodName.textContent = schedule.name;
      document.getElementById('sidebar-period-badge').querySelector('.dot').style.backgroundColor = 'var(--color-warning)';
    } else {
      headerPeriodVal.textContent = 'Closed';
      headerPeriodTime.textContent = 'After College Hours';
      sidebarPeriodName.textContent = 'Closed';
      document.getElementById('sidebar-period-badge').querySelector('.dot').style.backgroundColor = 'var(--text-muted)';
    }
  }

  // Monitor tab status summary updater
  const periodStatusVal = document.getElementById('period-status-val');
  const periodDateVal = document.getElementById('period-date-val');
  const periodLimitVal = document.getElementById('period-limit-val');

  if (periodStatusVal) {
    if (schedule.type === 'period') {
      periodStatusVal.textContent = schedule.attendanceClosed ? `${schedule.name} (Closed)` : `${schedule.name} (Open)`;
      periodStatusVal.style.color = schedule.attendanceClosed ? 'var(--color-danger)' : 'var(--color-success)';
    } else {
      periodStatusVal.textContent = schedule.name;
      periodStatusVal.style.color = schedule.type === 'break' ? 'var(--color-warning)' : 'var(--text-muted)';
    }
    periodDateVal.textContent = schedule.date;
    periodLimitVal.textContent = `${schedule.start} to ${schedule.end}`;
  }
}

// ----------------------------------------------------
// 3. Tab 1: Dashboard API Loading & Display (Protected)
// ----------------------------------------------------
async function loadDashboardData() {
  const tableBody = document.getElementById('student-table-body');
  
  try {
    // Load student records and calculation analytics using auth tokens
    const [studentsRes, analyticsRes] = await Promise.all([
      facultyFetch(`${API_BASE}/api/students`),
      facultyFetch(`${API_BASE}/api/analytics`)
    ]);

    const students = await studentsRes.json();
    const analytics = await analyticsRes.json();

    // Fill counts
    document.getElementById('stat-total-students').textContent = students.length;
    
    // Calculate aggregate average
    let sumPercentage = 0;
    let defaulterCount = 0;

    if (analytics.students && analytics.students.length > 0) {
      analytics.students.forEach(s => {
        sumPercentage += s.attendancePercentage;
        if (s.attendancePercentage < 75.0) {
          defaulterCount++;
        }
      });
      const avgPercentage = Math.round((sumPercentage / analytics.students.length) * 10) / 10;
      document.getElementById('stat-avg-attendance').textContent = `${avgPercentage}%`;
    } else {
      document.getElementById('stat-avg-attendance').textContent = '100%';
    }

    document.getElementById('stat-defaulter-count').textContent = defaulterCount;

    // Render Table
    if (students.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted">No students enrolled yet. Go to the "Register Student" tab to add.</td>
        </tr>
      `;
      return;
    }

    let rowsHtml = '';
    
    students.forEach(student => {
      const studentStat = analytics.students.find(s => s.usn === student.usn) || {
        attendancePercentage: 100.0,
        attendedCount: 0,
        totalEvaluatedCount: 0
      };

      const percent = studentStat.attendancePercentage;
      
      // Select indicator color thresholds
      let barClass = 'high';
      let textClass = 'high';
      if (percent < 50.0) {
        barClass = 'critical';
        textClass = 'critical';
      } else if (percent < 75.0) {
        barClass = 'warn';
        textClass = 'warn';
      }

      const formattedPhone = cleanIndianPhoneNumber(student.phone);
      const displayPhone = formatPhoneNumberDisplay(student.phone);
      const whatsappText = `Hello ${student.name}, this is the College Attendance Desk. Your current cumulative attendance is ${percent}%. Please ensure regular attendance.`;
      const whatsappLink = formattedPhone 
        ? `<a href="https://wa.me/${formattedPhone}?text=${encodeURIComponent(whatsappText)}" target="_blank" style="display: inline-flex; align-items: center; justify-content: center; background: rgba(37, 211, 102, 0.1); border: 1px solid rgba(37, 211, 102, 0.3); border-radius: 4px; padding: 1.5px 5px; font-size: 10.5px; color: #25d366; text-decoration: none; font-weight: 600; margin-left: 8px; vertical-align: middle;" title="Send WhatsApp Check-in">🟢 WA</a>` 
        : '';

      rowsHtml += `
        <tr>
          <td><span class="badge usn">${student.usn}</span></td>
          <td><strong>${student.name}</strong></td>
          <td>
            <span class="text-secondary">${student.email}</span><br>
            <span class="text-secondary" style="font-size: 11.5px; font-weight: 600; display: inline-block; margin-top: 4px; vertical-align: middle;">📞 ${displayPhone || 'N/A'}</span>${whatsappLink}
          </td>
          <td>
            <span class="badge">${studentStat.attendedCount} / ${studentStat.totalEvaluatedCount} classes</span>
          </td>
          <td>
            <div class="attendance-progress-container">
              <div class="progress-bar-bg">
                <div class="progress-bar-fill ${barClass}" style="width: ${percent}%;"></div>
              </div>
              <span class="progress-text ${textClass}">${percent}%</span>
            </div>
          </td>
          <td style="text-align: right;">
            <button class="btn secondary input-sm" onclick="showAttendanceGrid('${student.usn}')">
              History
            </button>
            <button class="btn danger input-sm ml-8" onclick="deleteStudent('${student.usn}', '${student.name}')" title="Delete Student Record">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline-block; vertical-align:middle;">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </td>
        </tr>
      `;
    });

    tableBody.innerHTML = rowsHtml;
    populateDefaultersPanel(analytics);
  } catch (error) {
    console.error('Failed to load dashboard data:', error);
    tableBody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center text-red">Failed to communicate with the registry database.</td>
      </tr>
    `;
  }
}

function populateDefaultersPanel(analytics) {
  const countBadge = document.getElementById('defaulter-list-count');
  const tableBody = document.getElementById('defaulter-table-body');
  const warnBtn = document.getElementById('btn-warn-all-defaulters');
  const warnWaBtn = document.getElementById('btn-warn-all-defaulters-whatsapp');
  
  if (!tableBody || !countBadge) return;

  const defaulters = (analytics.students || []).filter(s => s.attendancePercentage < 75.0);
  countBadge.textContent = defaulters.length;

  if (defaulters.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center text-muted p-20">No attendance defaulters detected. All students satisfy the 75% threshold.</td>
      </tr>
    `;
    if (warnBtn) warnBtn.style.display = 'none';
    if (warnWaBtn) warnWaBtn.style.display = 'none';
    return;
  }

  if (warnBtn) warnBtn.style.display = 'inline-flex';
  if (warnWaBtn) warnWaBtn.style.display = 'inline-flex';

  let rowsHtml = '';
  defaulters.forEach(student => {
    const missedCount = student.totalEvaluatedCount - student.attendedCount;
    const formattedPhone = cleanIndianPhoneNumber(student.phone);
    const whatsappText = `URGENT WARNING: Dear ${student.name} (${student.usn}), your cumulative academic attendance is currently ${student.attendancePercentage}%, falling below the VTU mandatory 75% limit. Classes Attended: ${student.attendedCount}/${student.totalEvaluatedCount}. Please meet your mentor immediately to avoid examination restrictions.`;
    
    const whatsappLink = formattedPhone 
      ? `<a href="https://wa.me/${formattedPhone}?text=${encodeURIComponent(whatsappText)}" target="_blank" style="display: inline-flex; align-items: center; justify-content: center; background: rgba(37, 211, 102, 0.1); border: 1px solid rgba(37, 211, 102, 0.3); border-radius: 4px; padding: 3px 8px; font-size: 11px; color: #25d366; text-decoration: none; font-weight: 600;" title="Send WhatsApp Warning">🟢 WhatsApp</a>` 
      : '<span class="text-muted">No Phone</span>';

    rowsHtml += `
      <tr class="defaulter-row">
        <td><span class="badge usn critical" style="background: rgba(244,63,94,0.06); color: #f43f5e; border-color: rgba(244,63,94,0.2);">${student.usn}</span></td>
        <td><strong>${student.name}</strong></td>
        <td><span style="color: var(--color-danger); font-weight: 700;">${student.attendancePercentage}%</span></td>
        <td><span class="badge" style="background:rgba(16,185,129,0.03); color:#10b981;">${student.attendedCount} classes</span></td>
        <td><span class="badge" style="background:rgba(244,63,94,0.03); color:#f43f5e;">${missedCount} missed</span></td>
        <td style="text-align: right;">
          ${whatsappLink}
        </td>
      </tr>
    `;
  });

  tableBody.innerHTML = rowsHtml;
}

// Warn all defaulters button listener
document.addEventListener('DOMContentLoaded', () => {
  const warnBtn = document.getElementById('btn-warn-all-defaulters');
  if (warnBtn) {
    warnBtn.addEventListener('click', async () => {
      const confirmMsg = "CAUTION: This will send official critical academic warning emails to all students currently marked as defaulters (below 75% attendance). Do you want to proceed?";
      if (!confirm(confirmMsg)) return;

      warnBtn.setAttribute('disabled', 'true');
      warnBtn.textContent = 'Sending Warnings...';

      try {
        const res = await facultyFetch(`${API_BASE}/api/warn-defaulters`, {
          method: 'POST'
        });
        const result = await res.json();
        if (result.success) {
          alert(`Successfully sent warning notifications to ${result.warnedCount} defaulter students.`);
          loadDashboardData();
        } else {
          alert(`Warning Job Failed: ${result.error}`);
        }
      } catch (error) {
        console.error('Warn defaulters error:', error);
        alert('Mentoring desk connection error.');
      } finally {
        warnBtn.removeAttribute('disabled');
        warnBtn.textContent = '⚠️ Warn All Defaulters via Email';
      }
    });
  }

  const warnWaBtn = document.getElementById('btn-warn-all-defaulters-whatsapp');
  if (warnWaBtn) {
    warnWaBtn.addEventListener('click', async () => {
      try {
        const res = await facultyFetch(`${API_BASE}/api/analytics`);
        const analytics = await res.json();
        openWaDispatcher(analytics);
      } catch (error) {
        console.error('Failed to open WhatsApp warning dispatcher:', error);
        alert('Could not fetch analytics.');
      }
    });
  }
});

// Delete student callback
window.deleteStudent = async (usn, name) => {
  if (!confirm(`CAUTION: Are you sure you want to delete the student ${name} (${usn})? This will permanently wipe their profile and all attendance records!`)) {
    return;
  }

  try {
    const res = await facultyFetch(`${API_BASE}/api/students/${usn}`, {
      method: 'DELETE'
    });
    
    const result = await res.json();
    if (result.success) {
      alert(result.message);
      // Reload dashboard list
      loadDashboardData();
    } else {
      alert(`Deletion Failed: ${result.error}`);
    }
  } catch (error) {
    console.error('Delete API error:', error);
    alert('Failed to connect to backend server.');
  }
};

// Search filtering on table
document.getElementById('search-student').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  const rows = document.querySelectorAll('#student-table-body tr');
  
  rows.forEach(row => {
    if (row.cells.length < 2) return;
    
    const usn = row.cells[0].textContent.toLowerCase();
    const name = row.cells[1].textContent.toLowerCase();
    const email = row.cells[2].textContent.toLowerCase();

    if (usn.includes(query) || name.includes(query) || email.includes(query)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
});

// ----------------------------------------------------
// 4. Student Detailed History Grid Modal (Protected)
// ----------------------------------------------------
const attendanceModal = document.getElementById('attendance-modal');
const modalStudentName = document.getElementById('modal-student-name');
const modalStudentUsn = document.getElementById('modal-student-usn');
const modalMetricPresent = document.getElementById('modal-metric-present');
const modalMetricTotal = document.getElementById('modal-metric-total');
const modalMetricPercentage = document.getElementById('modal-metric-percentage');
const modalGridBody = document.getElementById('modal-attendance-grid-body');

window.showAttendanceGrid = async (usn) => {
  try {
    const [analyticsRes, attendanceRes] = await Promise.all([
      facultyFetch(`${API_BASE}/api/analytics`),
      facultyFetch(`${API_BASE}/api/attendance`)
    ]);

    const analytics = await analyticsRes.json();
    const rawAttendance = await attendanceRes.json();

    const studentStat = analytics.students.find(s => s.usn === usn);
    if (!studentStat) return;

    // Fill Header
    modalStudentName.textContent = studentStat.name;
    modalStudentUsn.textContent = studentStat.usn;
    modalMetricPresent.textContent = studentStat.attendedCount;
    modalMetricTotal.textContent = studentStat.totalEvaluatedCount;
    modalMetricPercentage.textContent = `${studentStat.attendancePercentage}%`;

    const studentLogs = rawAttendance.filter(log => log.usn === usn);

    // Inception Date Configuration
    const INCEPTION_DATE = '2026-06-01';
    
    // Find the earliest date in rawAttendance
    let startDateStr = INCEPTION_DATE;
    rawAttendance.forEach(log => {
      if (log.date < startDateStr) {
        startDateStr = log.date;
      }
    });

    // Generate list of dates from startDateStr to today
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    
    const datesList = [];
    const start = new Date(startDateStr);
    const end = new Date(todayStr);
    
    let current = new Date(start);
    while (current <= end) {
      datesList.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }
    datesList.reverse(); // Newest first

    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const hasPeriodStarted = (periodNum, dateStr) => {
      if (dateStr < todayStr) return true;
      if (dateStr > todayStr) return false;
      
      const PERIOD_STARTS = {
        1: 540,
        2: 595,
        3: 670,
        4: 725,
        5: 840,
        6: 895
      };
      return currentMinutes >= PERIOD_STARTS[periodNum];
    };

    if (datesList.length === 0) {
      modalGridBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No attendance logs available.</td></tr>`;
    } else {
      let gridRows = '';
      
      datesList.forEach(date => {
        let periodsCols = '';
        
        for (let p = 1; p <= 6; p++) {
          const attended = studentLogs.some(log => log.date === date && log.period === p && log.status === 'present');
          
          if (attended) {
            periodsCols += `<td style="text-align: center;"><button class="grid-status-btn present" onclick="toggleCellAttendance('${usn}', '${date}', ${p}, 'absent')" title="Faculty Correction: Toggle to Absent">✓</button></td>`;
          } else {
            const started = hasPeriodStarted(p, date);
            if (started) {
              periodsCols += `<td style="text-align: center;"><button class="grid-status-btn absent" onclick="toggleCellAttendance('${usn}', '${date}', ${p}, 'present')" title="Faculty Correction: Toggle to Present">✗</button></td>`;
            } else {
              periodsCols += `<td style="text-align: center;"><button class="grid-status-btn unevaluated" disabled title="Upcoming class">-</button></td>`;
            }
          }
        }

        gridRows += `
          <tr>
            <td>${date}</td>
            ${periodsCols}
          </tr>
        `;
      });

      modalGridBody.innerHTML = gridRows;
    }

    // Open Modal
    attendanceModal.classList.add('active');
  } catch (error) {
    console.error('Failed to open attendance details:', error);
  }
};

window.toggleCellAttendance = async (usn, date, period, targetStatus) => {
  if (!isFacultyAuthenticated()) {
    alert('Faculty portal credentials required to update records.');
    return;
  }
  
  try {
    const response = await facultyFetch(`${API_BASE}/api/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usn,
        period,
        date,
        status: targetStatus
      })
    });
    
    const result = await response.json();
    if (result.success) {
      await showAttendanceGrid(usn);
      loadDashboardData();
    } else {
      alert(`Update Failed: ${result.error}`);
    }
  } catch (error) {
    console.error('Manual correction error:', error);
    alert('Registry connection timeout.');
  }
};

document.getElementById('btn-close-modal').addEventListener('click', () => {
  attendanceModal.classList.remove('active');
});

// Close on outside click
attendanceModal.addEventListener('click', (e) => {
  if (e.target === attendanceModal) {
    attendanceModal.classList.remove('active');
  }
});

// ----------------------------------------------------
// 5. Tab 2: Live Webcam Monitor & High-Accuracy Recognition
// ----------------------------------------------------
const monitorVideo = document.getElementById('webcam');
const monitorCanvas = document.getElementById('webcam-canvas');
const btnToggleCamera = document.getElementById('btn-toggle-camera');
const cameraIndicator = document.getElementById('camera-indicator');
const cameraStatusText = document.getElementById('camera-status-text');
const logsViewport = document.getElementById('recognition-logs');

let faceMatcherLoop = null;

// Query public descriptors endpoint which doesn't require admin log-in
async function initMonitorTab() {
  try {
    const res = await fetch(`${API_BASE}/api/public-descriptors?_t=${Date.now()}`);
    registeredStudents = await res.json();
    console.log(`Webcam Monitor: Loaded ${registeredStudents.length} face reference profiles.`);
  } catch (err) {
    console.error('Failed to load descriptors:', err);
  }
}

btnToggleCamera.addEventListener('click', async () => {
  if (monitorStream) {
    stopMonitorCamera();
  } else {
    await startMonitorCamera();
  }
});

async function startMonitorCamera() {
  if (!modelsLoaded) {
    alert('Neural Networks are loading, please wait.');
    return;
  }

  // Always fetch updated student lists before start
  await initMonitorTab();

  try {
    monitorStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    
    monitorVideo.srcObject = monitorStream;
    monitorVideo.addEventListener('play', onMonitorVideoPlay);
    
    btnToggleCamera.textContent = 'Stop Webcam';
    btnToggleCamera.classList.remove('primary');
    btnToggleCamera.classList.add('secondary');
    
    cameraIndicator.className = 'status-indicator online';
    cameraStatusText.textContent = 'Webcam Scanner Active';
    
    addLog('System', 'Camera monitor feed activated.', 'info');
  } catch (error) {
    console.error('Failed to access webcam:', error);
    alert('Webcam access was denied. Grant web permissions.');
  }
}

function stopMonitorCamera() {
  if (faceMatcherLoop) {
    cancelAnimationFrame(faceMatcherLoop);
    faceMatcherLoop = null;
  }
  
  if (monitorStream) {
    monitorStream.getTracks().forEach(track => track.stop());
    monitorStream = null;
  }
  
  monitorVideo.srcObject = null;
  
  const ctx = monitorCanvas.getContext('2d');
  ctx.clearRect(0, 0, monitorCanvas.width, monitorCanvas.height);
  
  btnToggleCamera.textContent = 'Start Webcam';
  btnToggleCamera.classList.remove('secondary');
  btnToggleCamera.classList.add('primary');
  
  cameraIndicator.className = 'status-indicator offline';
  cameraStatusText.textContent = 'Webcam Inactive';
}

function onMonitorVideoPlay() {
  const displaySize = { width: monitorVideo.offsetWidth, height: monitorVideo.offsetHeight };
  faceapi.matchDimensions(monitorCanvas, displaySize);

  async function detectionFrame() {
    if (!monitorStream || monitorVideo.paused || monitorVideo.ended) return;

    // Skip scanning completely if the attendance window is closed
    if (activePeriod && activePeriod.type === 'period' && activePeriod.attendanceClosed) {
      const ctx = monitorCanvas.getContext('2d');
      ctx.clearRect(0, 0, monitorCanvas.width, monitorCanvas.height);
      faceMatcherLoop = requestAnimationFrame(detectionFrame);
      return;
    }

    try {
      // 1. Run SSD Mobilenet Face Detector (High Accuracy)
      const detections = await faceapi.detectAllFaces(
        monitorVideo, 
        new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
      ).withFaceLandmarks().withFaceDescriptors();

      const resizedDetections = faceapi.resizeResults(detections, displaySize);
      
      const ctx = monitorCanvas.getContext('2d');
      ctx.clearRect(0, 0, monitorCanvas.width, monitorCanvas.height);

      if (registeredStudents.length === 0) {
        resizedDetections.forEach(d => {
          drawCustomBox(ctx, d.detection.box, 'Registry Empty');
        });
      } else {
        resizedDetections.forEach(d => {
          const descriptor = d.descriptor;
          let bestMatch = { student: null, distance: 1.0 };

          // Check descriptors
          registeredStudents.forEach(student => {
            const distance = calculateEuclideanDistance(descriptor, student.descriptor);
            if (distance < bestMatch.distance) {
              bestMatch = { student, distance };
            }
          });

          // SSD Mobilenet Descriptor matching threshold (standard: 0.58-0.6)
          const MATCH_THRESHOLD = 0.58;
          let boxLabel = 'Unknown Face';
          
          if (bestMatch.distance < MATCH_THRESHOLD) {
            const student = bestMatch.student;
            boxLabel = `${student.name} (${Math.round((1 - bestMatch.distance) * 100)}% Match)`;
            attemptMarkPresent(student);
          }

          drawCustomBox(ctx, d.detection.box, boxLabel, bestMatch.distance < MATCH_THRESHOLD);
        });
      }

    } catch (err) {
      console.error('Frame loop matching error:', err);
    }

    faceMatcherLoop = requestAnimationFrame(detectionFrame);
  }

  faceMatcherLoop = requestAnimationFrame(detectionFrame);
}

function calculateEuclideanDistance(arr1, arr2) {
  if (arr1.length !== arr2.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < arr1.length; i++) {
    const diff = arr1[i] - arr2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function drawCustomBox(ctx, box, label, isMatched = false) {
  const { x, y, width, height } = box;
  const strokeColor = isMatched ? '#10b981' : '#f43f5e';
  const overlayColor = isMatched ? 'rgba(16, 185, 129, 0.18)' : 'rgba(244, 63, 94, 0.12)';
  
  ctx.fillStyle = overlayColor;
  ctx.fillRect(x, y, width, height);

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, width, height);

  ctx.fillStyle = strokeColor;
  ctx.fillRect(x - 1, y - 24, width + 2, 24);

  ctx.fillStyle = '#ffffff';
  ctx.font = "bold 11.5px 'Plus Jakarta Sans', sans-serif";
  ctx.fillText(label, x + 8, y - 8);
}

async function attemptMarkPresent(student) {
  if (!activePeriod || activePeriod.type !== 'period') {
    return;
  }

  if (activePeriod.attendanceClosed) {
    return; // Block checking in if the 10-minute window limit has expired
  }

  const sessionKey = `${student.usn}_${activePeriod.date}_${activePeriod.number}`;
  if (attendanceMarkedThisSession.has(sessionKey)) {
    return;
  }

  attendanceMarkedThisSession.add(sessionKey);

  try {
    const isSim = simModeToggle.checked;
    const simElapsed = isSim ? document.getElementById('sim-elapsed').value : null;

    const response = await fetch(`${API_BASE}/api/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usn: student.usn,
        period: activePeriod.number,
        date: activePeriod.date,
        status: 'present',
        simulated: isSim,
        simElapsed: simElapsed
      })
    });

    const result = await response.json();
    if (result.success) {
      addLog(
        'Present', 
        `Marked PRESENT for ${student.name} (${student.usn}) in ${activePeriod.name}`, 
        'success'
      );
    } else {
      attendanceMarkedThisSession.delete(sessionKey);
    }
  } catch (error) {
    console.error('Attendance endpoint connection failed:', error);
    attendanceMarkedThisSession.delete(sessionKey);
  }
}

// ----------------------------------------------------
// 6. Monitor Event Log Controller
// ----------------------------------------------------
function addLog(badge, message, type = 'info') {
  if (logsViewport.querySelector('.log-placeholder')) {
    logsViewport.innerHTML = '';
  }

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const logItem = document.createElement('div');
  logItem.className = 'log-item';
  logItem.innerHTML = `
    <span class="log-time">[${timeStr}]</span>
    <span class="badge ${type}">${badge}</span>
    <span class="log-msg ${type}">${message}</span>
  `;

  logsViewport.appendChild(logItem);
  logsViewport.scrollTop = logsViewport.scrollHeight;
}

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  logsViewport.innerHTML = '<div class="log-placeholder">Log logs will print when camera matches face boundaries.</div>';
});

// ----------------------------------------------------
// 7. Tab 3: Student Registration snapshot (Protected)
// ----------------------------------------------------
const regVideo = document.getElementById('register-webcam');
const regCanvas = document.getElementById('register-canvas');
const btnToggleRegCam = document.getElementById('btn-toggle-reg-cam');

let regFaceDetectorInterval = null;

btnToggleRegCam.addEventListener('click', async () => {
  if (registerStream) {
    stopRegisterCamera();
  } else {
    await startRegisterCamera();
  }
});

async function startRegisterCamera() {
  if (!modelsLoaded) {
    alert('Models are currently loading, please wait.');
    return;
  }

  try {
    registerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    
    regVideo.srcObject = registerStream;
    
    btnToggleRegCam.textContent = 'Deactivate Camera';
    btnToggleRegCam.classList.remove('secondary');
    btnToggleRegCam.classList.add('btn');
    
    btnTakeSnapshot.removeAttribute('disabled');
    
    startGuidelineDetection();
  } catch (error) {
    console.error('Failed to start enrollment feed:', error);
    alert('Could not start enrollment feed. Grant web permissions.');
  }
}

function stopRegisterCamera() {
  if (regFaceDetectorInterval) {
    clearInterval(regFaceDetectorInterval);
    regFaceDetectorInterval = null;
  }

  if (registerStream) {
    registerStream.getTracks().forEach(track => track.stop());
    registerStream = null;
  }

  regVideo.srcObject = null;
  
  const ctx = regCanvas.getContext('2d');
  ctx.clearRect(0, 0, regCanvas.width, regCanvas.height);

  btnToggleRegCam.textContent = 'Activate Enrollment Camera';
  btnToggleRegCam.classList.remove('btn');
  btnToggleRegCam.classList.add('secondary');

  btnTakeSnapshot.setAttribute('disabled', 'true');
  document.querySelector('.face-oval').classList.remove('active');
}

function startGuidelineDetection() {
  const oval = document.querySelector('.face-oval');
  
  regFaceDetectorInterval = setInterval(async () => {
    if (!registerStream || regVideo.paused || regVideo.ended) return;

    try {
      // Analyze with high accuracy detector for validation
      const detection = await faceapi.detectSingleFace(regVideo, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }));
      if (detection) {
        oval.classList.add('active');
      } else {
        oval.classList.remove('active');
      }
    } catch (err) {
      // Fail silently
    }
  }, 500);
}

// Capture and compute biometrics
btnTakeSnapshot.addEventListener('click', async () => {
  captureStatusBox.className = 'capture-status-box';
  captureStatusBox.innerHTML = `
    <div class="spinner" style="width:16px; height:16px; border-width:2px; display:inline-block; vertical-align:middle; margin-right:8px;"></div>
    Extracting SSD Face descriptor, please hold still...
  `;
  btnTakeSnapshot.setAttribute('disabled', 'true');

  try {
    const detection = await faceapi.detectSingleFace(
      regVideo, 
      new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
    ).withFaceLandmarks().withFaceDescriptor();

    if (!detection) {
      captureStatusBox.className = 'capture-status-box error';
      captureStatusBox.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>Extraction failed: Centering face or lighting correction required.</span>
      `;
      btnTakeSnapshot.removeAttribute('disabled');
      capturedFaceDescriptor = null;
      btnSubmitRegistration.setAttribute('disabled', 'true');
      return;
    }

    capturedFaceDescriptor = Array.from(detection.descriptor);
    
    // Draw confirmation
    const ctx = regCanvas.getContext('2d');
    ctx.clearRect(0, 0, regCanvas.width, regCanvas.height);
    faceapi.matchDimensions(regCanvas, { width: regVideo.offsetWidth, height: regVideo.offsetHeight });
    
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 3;
    ctx.strokeRect(
      detection.detection.box.x, 
      detection.detection.box.y, 
      detection.detection.box.width, 
      detection.detection.box.height
    );

    captureStatusBox.className = 'capture-status-box success';
    captureStatusBox.innerHTML = `
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <span>Face biometric descriptor successfully computed. Complete registration details.</span>
    `;

    btnSubmitRegistration.removeAttribute('disabled');
  } catch (error) {
    console.error(error);
    captureStatusBox.className = 'capture-status-box error';
    captureStatusBox.innerHTML = `<span>Error: ${error.message}</span>`;
    btnTakeSnapshot.removeAttribute('disabled');
    capturedFaceDescriptor = null;
  }
});

// Save registration
registrationForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  if (!capturedFaceDescriptor) {
    alert('Biometric capture is required.');
    return;
  }

  const name = regNameInput.value.trim();
  const usn = regUsnInput.value.trim().toUpperCase();
  const email = regEmailInput.value.trim();
  const phone = document.getElementById('reg-phone').value.trim();

  const cleanedPhone = cleanIndianPhoneNumber(phone);
  if (cleanedPhone.length !== 12) {
    alert('Invalid Phone Number: Please enter a valid 10-digit Indian mobile number (e.g. +919876543210 or 9876543210).');
    return;
  }

  btnSubmitRegistration.setAttribute('disabled', 'true');
  btnSubmitRegistration.textContent = 'Saving Profile...';

  try {
    const res = await fetch(`${API_BASE}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        usn,
        email,
        phone: cleanedPhone,
        descriptor: capturedFaceDescriptor
      })
    });

    const result = await res.json();

    if (result.success) {
      alert(`Registration Successful: Student ${name} (${usn}) has been saved.`);
      
      // Resets
      registrationForm.reset();
      capturedFaceDescriptor = null;
      btnSubmitRegistration.textContent = 'Register & Save Student';
      captureStatusBox.className = 'capture-status-box';
      captureStatusBox.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <span>Capture biometric landmarks to verify recognition boundaries.</span>
      `;
      
      stopRegisterCamera();
      
      // Go to Monitor View
      document.querySelector('.nav-btn[data-tab="monitor"]').click();
    } else {
      alert(`Registration Failed: ${result.error}`);
      btnSubmitRegistration.removeAttribute('disabled');
      btnSubmitRegistration.textContent = 'Register & Save Student';
    }
  } catch (error) {
    console.error('Registration API error:', error);
    alert(`Server Connection Error: ${error.message}`);
    btnSubmitRegistration.removeAttribute('disabled');
    btnSubmitRegistration.textContent = 'Register & Save Student';
  }
});

// Section 8: Removed (Daily Absentee Outbox Log is not needed)

// ----------------------------------------------------
// 9. CSV and Print PDF Exporters
// ----------------------------------------------------
document.getElementById('btn-export-csv').addEventListener('click', async () => {
  try {
    const res = await facultyFetch(`${API_BASE}/api/analytics`);
    const analytics = await res.json();
    const students = analytics.students || [];

    if (students.length === 0) {
      alert('No student records available to export.');
      return;
    }

    // Build CSV Content
    let csvContent = 'USN,Student Name,Email,Phone,Attended Classes,Total Classes,Attendance Percentage\n';
    students.forEach(s => {
      csvContent += `"${s.usn}","${s.name}","${s.email}","${s.phone || 'N/A'}",${s.attendedCount},${s.totalEvaluatedCount},${s.attendancePercentage}%\n`;
    });

    // Download CSV
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `attendance_report_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (error) {
    console.error('Export CSV error:', error);
    alert('Failed to retrieve analytics data for export.');
  }
});

document.getElementById('btn-print-report').addEventListener('click', () => {
  window.print();
});

// ----------------------------------------------------
// 10. WhatsApp Batch Dispatcher Queue System
// ----------------------------------------------------
let waQueue = [];
let waQueueIndex = 0;

window.openWaDispatcher = (analytics) => {
  const defaulters = (analytics.students || []).filter(s => s.attendancePercentage < 75.0);
  if (defaulters.length === 0) {
    alert('No defaulters detected to warn on WhatsApp.');
    return;
  }
  waQueue = defaulters;
  waQueueIndex = 0;
  
  document.getElementById('wa-dispatcher-modal').classList.add('active');
  showWaQueueItem();
};

function showWaQueueItem() {
  const activeDiv = document.getElementById('wa-dispatcher-active');
  const finishedDiv = document.getElementById('wa-dispatcher-finished');
  const progressBadge = document.getElementById('wa-queue-progress');
  
  if (waQueueIndex >= waQueue.length) {
    activeDiv.style.display = 'none';
    finishedDiv.style.display = 'block';
    progressBadge.textContent = `${waQueue.length} / ${waQueue.length} Done`;
    return;
  }
  
  activeDiv.style.display = 'block';
  finishedDiv.style.display = 'none';
  progressBadge.textContent = `${waQueueIndex + 1} / ${waQueue.length} Students`;
  
  const student = waQueue[waQueueIndex];
  const missedCount = student.totalEvaluatedCount - student.attendedCount;
  
  const phone = cleanIndianPhoneNumber(student.phone);
  
  const message = `URGENT WARNING: Dear ${student.name} (${student.usn}), your cumulative academic attendance is currently ${student.attendancePercentage}%, falling below the VTU mandatory 75% limit. Classes Attended: ${student.attendedCount}/${student.totalEvaluatedCount}. Please meet your mentor immediately to avoid examination restrictions.`;
  
  document.getElementById('wa-disp-student-name').textContent = student.name;
  document.getElementById('wa-disp-student-usn').textContent = student.usn;
  document.getElementById('wa-disp-student-phone').textContent = formatPhoneNumberDisplay(student.phone) || 'No Phone';
  document.getElementById('wa-disp-student-rate').textContent = `${student.attendancePercentage}%`;
  document.getElementById('wa-disp-message').value = message;
  
  const sendBtn = document.getElementById('btn-wa-send');
  if (phone) {
    sendBtn.style.pointerEvents = 'auto';
    sendBtn.style.opacity = '1';
    sendBtn.href = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  } else {
    sendBtn.style.pointerEvents = 'none';
    sendBtn.style.opacity = '0.5';
    sendBtn.href = '#';
  }
}

document.getElementById('btn-wa-send').addEventListener('click', () => {
  setTimeout(() => {
    waQueueIndex++;
    showWaQueueItem();
  }, 100);
});

document.getElementById('btn-wa-skip').addEventListener('click', () => {
  waQueueIndex++;
  showWaQueueItem();
});

document.getElementById('btn-wa-finish').addEventListener('click', () => {
  document.getElementById('wa-dispatcher-modal').classList.remove('active');
});

document.getElementById('btn-close-wa-modal').addEventListener('click', () => {
  document.getElementById('wa-dispatcher-modal').classList.remove('active');
});

async function refreshDefaultersPanel() {
  try {
    const res = await facultyFetch(`${API_BASE}/api/analytics`);
    const analytics = await res.json();
    populateDefaultersPanel(analytics);
  } catch (error) {
    console.error('Failed to refresh defaulters panel:', error);
  }
}


