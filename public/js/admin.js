/* eslint-disable no-unused-vars */
(function () {
  'use strict';

  function getApiUrl() {
    return (window._APP_CONFIG && window._APP_CONFIG.apiUrl) ||
      window.API_BASE_URL ||
      (window.location.origin + '/api');
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const err = new Error('OFFLINE');
      err.code = 'OFFLINE';
      throw err;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const tErr = new Error('TIMEOUT');
        tErr.code = 'TIMEOUT';
        throw tErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function getFriendlyNetworkError(err, fallback = 'Connection error. Your inputs are still here — please try again.') {
    if (err && err.code === 'OFFLINE') return 'No internet connection. Your inputs are saved — reconnect and click Retry.';
    if (err && err.code === 'TIMEOUT') return 'Server timed out. Your inputs are preserved — please click the button to retry.';
    return fallback;
  }

  function getActiveDay() {
    return (window._APP_CONFIG && window._APP_CONFIG.activeDay) || regStats.activeDay || 1;
  }

  let selectedTitle = 'all';
  let selectedChurches = new Set(); // empty = All Churches / Orgs
  let selectedDay = 'all'; // 'all' | '1' | '2' | '3' | '4'
  let selectedAttendance = 'all'; // 'all' | 'yes' | 'no' | 'all4'

  let allRegistrations = [];
  let filteredRegistrations = [];
  let regStats = { total: 0, distinctChurches: 0, todayAttendance: 0, smsSent: 0, activeDay: 1 };

  let currentPage = 1;
  let itemsPerPage = 25;
  let autoRefreshTimer = null;
  let isFetching = false;
  let pendingDeleteId = null;

  let currentUser = { username: 'admin', fullName: 'Super Admin', role: 'super_admin', isSuperAdmin: true, permissions: [] };
  let allAdminUsers = [];
  let pendingDeleteUserId = null;
  let activeDashboardTab = 'registrations';

  const PERM_LABELS = {
    view_registrations: { label: 'View Records', cls: '' },
    add_registrations: { label: 'Add Attendees', cls: '' },
    edit_registrations: { label: 'Edit Records', cls: '' },
    delete_registrations: { label: 'Delete Records', cls: 'perm-danger' },
    export_data: { label: 'Export CSV', cls: '' },
    manage_users: { label: 'Manage Users', cls: 'perm-admin' }
  };

  function hasPermission(perm) {
    if (!currentUser) return false;
    if (currentUser.isSuperAdmin === true || currentUser.role === 'super_admin') return true;
    return Array.isArray(currentUser.permissions) && currentUser.permissions.includes(perm);
  }

  const DAY_LABELS = {
    1: 'Tue Nov 24th - Day 1',
    2: 'Wed Nov 25th - Day 2',
    3: 'Thu Nov 26th - Day 3',
    4: 'Fri Nov 27th - Day 4'
  };

  const state = {
    get el() {
      return {
        tabRegCount: document.getElementById('tabRegCount'),
        statVal1: document.getElementById('statVal1'),
        statLabel1: document.getElementById('statLabel1'),
        statHint1: document.getElementById('statHint1'),
        statIcon1: document.getElementById('statIcon1'),

        statVal2: document.getElementById('statVal2'),
        statLabel2: document.getElementById('statLabel2'),
        statHint2: document.getElementById('statHint2'),
        statIcon2: document.getElementById('statIcon2'),

        statVal3: document.getElementById('statVal3'),
        statLabel3: document.getElementById('statLabel3'),
        statHint3: document.getElementById('statHint3'),
        statIcon3: document.getElementById('statIcon3'),

        statVal4: document.getElementById('statVal4'),
        statLabel4: document.getElementById('statLabel4'),
        statHint4: document.getElementById('statHint4'),
        statIcon4: document.getElementById('statIcon4'),

        searchInput: document.getElementById('searchInput'),
        searchClearBtn: document.getElementById('searchClearBtn'),
        clearAllFiltersBtn: document.getElementById('clearAllFiltersBtn'),
        dayDropdownBtn: document.getElementById('dayDropdownBtn'),
        dayDropdownLabel: document.getElementById('dayDropdownLabel'),
        dayDropdownMenu: document.getElementById('dayDropdownMenu'),
        attendanceDropdownBtn: document.getElementById('attendanceDropdownBtn'),
        attendanceDropdownLabel: document.getElementById('attendanceDropdownLabel'),
        attendanceDropdownMenu: document.getElementById('attendanceDropdownMenu'),
        lastRefreshTime: document.getElementById('lastRefreshTime'),
        autoRefresh: document.getElementById('autoRefresh'),
        refreshIcon: document.getElementById('refreshIcon'),

        // Title Filter Dropdown
        titleDropdownBtn: document.getElementById('titleDropdownBtn'),
        titleDropdownLabel: document.getElementById('titleDropdownLabel'),
        titleDropdownCount: document.getElementById('titleDropdownCount'),
        titleDropdownMenu: document.getElementById('titleDropdownMenu'),

        // Church / Org Filter Dropdown
        locationDropdownBtn: document.getElementById('locationDropdownBtn'),
        locationDropdownLabel: document.getElementById('locationDropdownLabel'),
        locationDropdownCount: document.getElementById('locationDropdownCount'),
        locationDropdownMenu: document.getElementById('locationDropdownMenu'),

        // Export Dropdown
        exportDropdownBtn: document.getElementById('exportDropdownBtn'),
        exportDropdownMenu: document.getElementById('exportDropdownMenu'),
        exportCurrentViewBtn: document.getElementById('exportCurrentViewBtn'),
        exportUniqueSmsBtn: document.getElementById('exportUniqueSmsBtn'),
        exportMasterListBtn: document.getElementById('exportMasterListBtn'),

        // Table & Pagination
        tableCardTitle: document.getElementById('tableCardTitle'),
        tableCardSubtitle: document.getElementById('tableCardSubtitle'),
        totalEntriesLabel: document.getElementById('totalEntriesLabel'),
        tableHead: document.getElementById('tableHead'),
        tableBody: document.getElementById('tableBody'),
        emptyState: document.getElementById('emptyState'),
        emptyTitle: document.getElementById('emptyTitle'),
        emptyDesc: document.getElementById('emptyDesc'),

        paginationInfo: document.getElementById('paginationInfo'),
        pageSizeDropdownBtn: document.getElementById('pageSizeDropdownBtn'),
        pageSizeLabel: document.getElementById('pageSizeLabel'),
        pageSizeDropdownMenu: document.getElementById('pageSizeDropdownMenu'),
        pageNumbers: document.getElementById('pageNumbers'),
        firstPageBtn: document.getElementById('firstPageBtn'),
        prevPageBtn: document.getElementById('prevPageBtn'),
        nextPageBtn: document.getElementById('nextPageBtn'),
        lastPageBtn: document.getElementById('lastPageBtn'),

        logoutBtn: document.getElementById('logoutBtn'),
        toast: document.getElementById('toast')
      };
    }
  };

  function getAuthHeaders() {
    const token = localStorage.getItem('adminToken');
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeKey(raw) {
    const trimmed = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!trimmed || trimmed.toLowerCase() === 'n/a' || trimmed === '—') return 'n/a';
    return trimmed.toLowerCase();
  }

  function formatChurchLabel(raw) {
    const trimmed = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!trimmed || trimmed.toLowerCase() === 'n/a' || trimmed === '—') return 'N/A (Not Specified)';
    return trimmed;
  }

  function formatPhoneDisplay(raw) {
    if (!raw || !String(raw).trim() || String(raw).trim().toLowerCase() === 'n/a') return '';
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) return '';
    let local = digits;
    if (digits.startsWith('233') && digits.length === 12) {
      local = '0' + digits.substring(3);
    } else if (digits.length === 9 && !digits.startsWith('0')) {
      local = '0' + digits;
    } else if (!local.startsWith('0') && local.length === 10) {
      local = '0' + local.substring(1);
    } else if (!local.startsWith('0')) {
      local = '0' + local;
    }
    return local;
  }

  function formatPhoneForCsvFormula(raw) {
    const p = formatPhoneDisplay(raw);
    return p ? `="${p}"` : '""';
  }

  function formatDate(dateString) {
    if (!dateString) return '—';
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return String(dateString).slice(0, 22);
      return date.toLocaleString('en-US', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch (_) {
      return String(dateString).slice(0, 22);
    }
  }

  function formatCount(n) {
    try { return (n || 0).toLocaleString('en-US'); } catch (_) { return n || 0; }
  }

  function showToast(message, type = 'ok') {
    const toast = state.el.toast;
    if (!toast) return;
    const msgEl = toast.querySelector('.toast-message');
    const iconEl = toast.querySelector('.toast-icon');
    if (msgEl) msgEl.textContent = message;
    toast.className = 'toast show ' + type;
    if (iconEl) {
      iconEl.className = 'toast-icon fa-solid ' + (
        type === 'err' ? 'fa-circle-exclamation' :
        type === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-check'
      );
    }
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function closeAllDropdowns(exceptMenu) {
    const {
      titleDropdownBtn, titleDropdownMenu,
      locationDropdownBtn, locationDropdownMenu,
      dayDropdownBtn, dayDropdownMenu,
      attendanceDropdownBtn, attendanceDropdownMenu,
      exportDropdownBtn, exportDropdownMenu,
      pageSizeDropdownBtn, pageSizeDropdownMenu
    } = state.el;

    [
      [titleDropdownBtn, titleDropdownMenu],
      [locationDropdownBtn, locationDropdownMenu],
      [dayDropdownBtn, dayDropdownMenu],
      [attendanceDropdownBtn, attendanceDropdownMenu],
      [exportDropdownBtn, exportDropdownMenu],
      [pageSizeDropdownBtn, pageSizeDropdownMenu]
    ].forEach(([btn, menu]) => {
      if (menu && menu !== exceptMenu) {
        menu.classList.remove('open');
        if (btn) {
          btn.classList.remove('open');
          btn.setAttribute('aria-expanded', 'false');
        }
      }
    });

    document.querySelectorAll('.row-action-menu.open').forEach((menu) => {
      if (menu !== exceptMenu) {
        menu.classList.remove('open');
        const btn = menu.previousElementSibling;
        if (btn) btn.classList.remove('open');
      }
    });
  }

  function hasActiveFilters() {
    const hasSearch = !!(state.el.searchInput && state.el.searchInput.value.trim());
    const hasTitle = selectedTitle !== 'all';
    const hasChurch = selectedChurches.size > 0;
    const hasDay = selectedDay !== 'all';
    const hasAttendance = selectedAttendance !== 'all';
    return hasSearch || hasTitle || hasChurch || hasDay || hasAttendance;
  }

  function updateClearFiltersButtonVisibility() {
    if (state.el.clearAllFiltersBtn) {
      state.el.clearAllFiltersBtn.style.display = hasActiveFilters() ? 'inline-flex' : 'none';
    }
  }

  function setupFiltersAndMenus() {
    const {
      searchInput, searchClearBtn, clearAllFiltersBtn,
      titleDropdownBtn, titleDropdownMenu,
      locationDropdownBtn, locationDropdownMenu,
      dayDropdownBtn, dayDropdownLabel, dayDropdownMenu,
      attendanceDropdownBtn, attendanceDropdownLabel, attendanceDropdownMenu,
      exportDropdownBtn, exportDropdownMenu,
      exportCurrentViewBtn, exportUniqueSmsBtn, exportMasterListBtn
    } = state.el;

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        if (searchClearBtn) searchClearBtn.style.display = searchInput.value ? 'flex' : 'none';
        filterTable();
        updateClearFiltersButtonVisibility();
      });
    }
    if (searchClearBtn && searchInput) {
      searchClearBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchClearBtn.style.display = 'none';
        filterTable();
        updateClearFiltersButtonVisibility();
      });
    }

    if (titleDropdownBtn && titleDropdownMenu) {
      titleDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns(titleDropdownMenu);
        const isOpen = titleDropdownMenu.classList.toggle('open');
        titleDropdownBtn.classList.toggle('open', isOpen);
        titleDropdownBtn.setAttribute('aria-expanded', String(isOpen));
      });
      titleDropdownMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.dropdown-item[data-title]');
        if (!item) return;
        e.stopPropagation();
        selectedTitle = item.getAttribute('data-title') || 'all';
        closeAllDropdowns();
        populateTitleFilterOptions();
        filterTable();
        updateClearFiltersButtonVisibility();
      });
    }

    if (locationDropdownBtn && locationDropdownMenu) {
      locationDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns(locationDropdownMenu);
        const isOpen = locationDropdownMenu.classList.toggle('open');
        locationDropdownBtn.classList.toggle('open', isOpen);
        locationDropdownBtn.setAttribute('aria-expanded', String(isOpen));
      });
      locationDropdownMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.dropdown-item[data-church]');
        if (!item) return;
        e.stopPropagation();
        const key = item.getAttribute('data-church') || 'all';
        if (key === 'all') {
          selectedChurches.clear();
        } else if (selectedChurches.has(key)) {
          selectedChurches.delete(key);
        } else {
          selectedChurches.add(key);
        }
        populateChurchFilterOptions();
        filterTable();
        updateClearFiltersButtonVisibility();
      });
    }

    if (dayDropdownBtn && dayDropdownMenu) {
      dayDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns(dayDropdownMenu);
        const isOpen = dayDropdownMenu.classList.toggle('open');
        dayDropdownBtn.classList.toggle('open', isOpen);
        dayDropdownBtn.setAttribute('aria-expanded', String(isOpen));
      });
      dayDropdownMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.dropdown-item[data-day]');
        if (!item) return;
        e.stopPropagation();
        selectedDay = item.getAttribute('data-day') || 'all';
        const label = item.getAttribute('data-label') || 'All Days';
        if (dayDropdownLabel) dayDropdownLabel.textContent = label;
        dayDropdownMenu.querySelectorAll('.dropdown-item[data-day]').forEach((el) => {
          el.classList.toggle('active', el === item);
        });
        closeAllDropdowns();
        filterTable();
        updateClearFiltersButtonVisibility();
      });
    }

    if (attendanceDropdownBtn && attendanceDropdownMenu) {
      attendanceDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns(attendanceDropdownMenu);
        const isOpen = attendanceDropdownMenu.classList.toggle('open');
        attendanceDropdownBtn.classList.toggle('open', isOpen);
        attendanceDropdownBtn.setAttribute('aria-expanded', String(isOpen));
      });
      attendanceDropdownMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.dropdown-item[data-att]');
        if (!item) return;
        e.stopPropagation();
        selectedAttendance = item.getAttribute('data-att') || 'all';
        const label = item.getAttribute('data-label') || 'All Attendance';
        if (attendanceDropdownLabel) attendanceDropdownLabel.textContent = label;
        attendanceDropdownMenu.querySelectorAll('.dropdown-item[data-att]').forEach((el) => {
          el.classList.toggle('active', el === item);
        });
        closeAllDropdowns();
        filterTable();
        updateClearFiltersButtonVisibility();
      });
    }

    if (clearAllFiltersBtn) {
      clearAllFiltersBtn.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        if (searchClearBtn) searchClearBtn.style.display = 'none';
        selectedTitle = 'all';
        selectedChurches.clear();
        selectedDay = 'all';
        selectedAttendance = 'all';
        if (dayDropdownLabel) dayDropdownLabel.textContent = 'All Days';
        if (dayDropdownMenu) {
          dayDropdownMenu.querySelectorAll('.dropdown-item[data-day]').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-day') === 'all');
          });
        }
        if (attendanceDropdownLabel) attendanceDropdownLabel.textContent = 'All Attendance';
        if (attendanceDropdownMenu) {
          attendanceDropdownMenu.querySelectorAll('.dropdown-item[data-att]').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-att') === 'all');
          });
        }
        populateTitleFilterOptions();
        populateChurchFilterOptions();
        filterTable();
        updateClearFiltersButtonVisibility();
        showToast('All filters cleared', 'ok');
      });
    }

    if (exportDropdownBtn && exportDropdownMenu) {
      exportDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns(exportDropdownMenu);
        const isOpen = exportDropdownMenu.classList.toggle('open');
        exportDropdownBtn.classList.toggle('open', isOpen);
        exportDropdownBtn.setAttribute('aria-expanded', String(isOpen));
      });
    }
    if (exportCurrentViewBtn) {
      exportCurrentViewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns();
        exportRegistrationsCSV(false);
      });
    }
    if (exportUniqueSmsBtn) {
      exportUniqueSmsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns();
        exportRegistrationsCSV(false, 'cmbc2026-sms-contacts');
      });
    }
    if (exportMasterListBtn) {
      exportMasterListBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns();
        exportRegistrationsCSV(true, 'cmbc2026-registrations-master');
      });
    }

    const { pageSizeDropdownBtn, pageSizeLabel, pageSizeDropdownMenu } = state.el;
    if (pageSizeDropdownBtn && pageSizeDropdownMenu) {
      pageSizeDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns(pageSizeDropdownMenu);
        const isOpen = pageSizeDropdownMenu.classList.toggle('open');
        pageSizeDropdownBtn.classList.toggle('open', isOpen);
        pageSizeDropdownBtn.setAttribute('aria-expanded', String(isOpen));
      });
      pageSizeDropdownMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.dropdown-item[data-size]');
        if (!item) return;
        e.stopPropagation();
        const newSize = parseInt(item.getAttribute('data-size'), 10) || 25;
        itemsPerPage = newSize;
        currentPage = 1;
        if (pageSizeLabel) pageSizeLabel.textContent = String(newSize);
        pageSizeDropdownMenu.querySelectorAll('.dropdown-item[data-size]').forEach((el) => {
          el.classList.toggle('active', el === item);
        });
        closeAllDropdowns();
        renderTable();
      });
    }

    document.addEventListener('click', () => closeAllDropdowns());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllDropdowns();
        closeAdminModal('viewRecordModal');
        closeAdminModal('editRecordModal');
        closeAdminModal('deleteRecordModal');
        closeAdminModal('userFormModal');
        closeAdminModal('deleteUserModal');
      }
    });
  }

  function populateTitleFilterOptions() {
    const { titleDropdownMenu, titleDropdownLabel, titleDropdownCount } = state.el;
    if (!titleDropdownMenu) return;

    const map = new Map();
    allRegistrations.forEach((reg) => {
      const raw = String(reg.member_status || reg.memberStatus || '').trim();
      const key = raw ? raw.toLowerCase() : 'none';
      const label = raw || 'No Title';
      if (!map.has(key)) map.set(key, { key, label, count: 0 });
      map.get(key).count += 1;
    });

    if (selectedTitle !== 'all' && !map.has(selectedTitle)) selectedTitle = 'all';

    const entries = Array.from(map.values()).sort((a, b) => {
      if (a.key === 'none') return 1;
      if (b.key === 'none') return -1;
      return a.label.localeCompare(b.label);
    });

    let html = `
      <button type="button" class="dropdown-item${selectedTitle === 'all' ? ' active' : ''}" data-title="all" role="menuitem">
        <div class="dropdown-item-info"><i class="fa-solid fa-users"></i><span>All Titles</span></div>
        <span class="pill-count">${allRegistrations.length}</span>
      </button>
    `;

    entries.forEach((entry) => {
      const active = selectedTitle === entry.key ? ' active' : '';
      html += `
        <button type="button" class="dropdown-item${active}" data-title="${escapeHtml(entry.key)}" role="menuitem">
          <div class="dropdown-item-info"><i class="fa-solid fa-user-tag"></i><span>${escapeHtml(entry.label)}</span></div>
          <span class="pill-count">${entry.count}</span>
        </button>
      `;
    });

    titleDropdownMenu.innerHTML = html;

    if (selectedTitle === 'all') {
      if (titleDropdownLabel) titleDropdownLabel.textContent = 'All Titles';
      if (titleDropdownCount) titleDropdownCount.textContent = allRegistrations.length;
    } else {
      const entry = map.get(selectedTitle);
      if (titleDropdownLabel) titleDropdownLabel.textContent = entry ? entry.label : 'All Titles';
      if (titleDropdownCount) titleDropdownCount.textContent = entry ? entry.count : allRegistrations.length;
    }
  }

  function populateChurchFilterOptions() {
    const { locationDropdownMenu, locationDropdownLabel, locationDropdownCount } = state.el;
    if (!locationDropdownMenu) return;

    const map = new Map();
    allRegistrations.forEach((reg) => {
      const raw = reg.location || reg.Location || '';
      const key = normalizeKey(raw);
      const label = formatChurchLabel(raw);
      if (!map.has(key)) map.set(key, { key, label, count: 0 });
      map.get(key).count += 1;
    });

    Array.from(selectedChurches).forEach((k) => {
      if (!map.has(k)) selectedChurches.delete(k);
    });

    const entries = Array.from(map.values()).sort((a, b) => {
      if (a.key === 'n/a') return 1;
      if (b.key === 'n/a') return -1;
      return a.label.localeCompare(b.label);
    });

    const isAll = selectedChurches.size === 0;
    let html = `
      <button type="button" class="dropdown-item${isAll ? ' active' : ''}" data-church="all" role="menuitemcheckbox" aria-checked="${isAll}">
        <div class="dropdown-item-info"><span class="location-check"><i class="fa-solid fa-check"></i></span><span>All Churches / Orgs</span></div>
        <span class="pill-count">${allRegistrations.length}</span>
      </button>
    `;

    entries.forEach((entry) => {
      const active = selectedChurches.has(entry.key);
      html += `
        <button type="button" class="dropdown-item${active ? ' active' : ''}" data-church="${escapeHtml(entry.key)}" role="menuitemcheckbox" aria-checked="${active}">
          <div class="dropdown-item-info"><span class="location-check"><i class="fa-solid fa-check"></i></span><span>${escapeHtml(entry.label)}</span></div>
          <span class="pill-count">${entry.count}</span>
        </button>
      `;
    });

    locationDropdownMenu.innerHTML = html;

    if (isAll) {
      if (locationDropdownLabel) locationDropdownLabel.textContent = 'All Churches / Orgs';
      if (locationDropdownCount) locationDropdownCount.textContent = allRegistrations.length;
    } else {
      let total = 0;
      const labels = [];
      selectedChurches.forEach((k) => {
        const e = map.get(k);
        if (e) { total += e.count; labels.push(e.label); }
      });
      if (locationDropdownLabel) {
        locationDropdownLabel.textContent = selectedChurches.size === 1 && labels.length === 1
          ? labels[0]
          : `${selectedChurches.size} Churches/Orgs`;
      }
      if (locationDropdownCount) locationDropdownCount.textContent = total;
    }
  }

  function filterRegistrations(q) {
    const s = String(q || '').trim().toLowerCase();
    let list = allRegistrations;

    if (s) {
      list = list.filter((reg) => {
        const name = String(reg.name || '').toLowerCase();
        const contact = String(reg.contact || '').toLowerCase();
        const church = String(reg.location || '').toLowerCase();
        const title = String(reg.member_status || '').toLowerCase();
        const ticketId = String(reg.ticket_id || '').toLowerCase();
        return name.includes(s) || contact.includes(s) || church.includes(s) || title.includes(s) || ticketId.includes(s);
      });
    }

    if (selectedTitle !== 'all') {
      list = list.filter((reg) => {
        const raw = String(reg.member_status || '').trim();
        const key = raw ? raw.toLowerCase() : 'none';
        return key === selectedTitle;
      });
    }

    if (selectedChurches.size > 0) {
      list = list.filter((reg) => selectedChurches.has(normalizeKey(reg.location || '')));
    }

    if (selectedAttendance === 'all4') {
      list = list.filter((reg) => reg.day1_attended && reg.day2_attended && reg.day3_attended && reg.day4_attended);
    } else if (selectedDay !== 'all') {
      const col = `day${selectedDay}_attended`;
      if (selectedAttendance === 'no') {
        list = list.filter((reg) => !reg[col]);
      } else {
        // Default when a specific day is picked: show attended (Yes) unless 'no' is chosen
        list = list.filter((reg) => Boolean(reg[col]));
      }
    } else if (selectedAttendance === 'yes') {
      list = list.filter((reg) => reg.day1_attended || reg.day2_attended || reg.day3_attended || reg.day4_attended);
    } else if (selectedAttendance === 'no') {
      list = list.filter((reg) => !reg.day1_attended && !reg.day2_attended && !reg.day3_attended && !reg.day4_attended);
    }

    return list;
  }

  function filterTable() {
    const q = state.el.searchInput ? state.el.searchInput.value : '';
    currentPage = 1;
    filteredRegistrations = filterRegistrations(q);
    renderCurrentData();
  }

  function renderStats() {
    const {
      tabRegCount,
      statVal1, statLabel1, statHint1,
      statVal2, statLabel2, statHint2, statIcon2,
      statVal3, statLabel3, statHint3, statIcon3,
      statVal4, statLabel4, statHint4, statIcon4
    } = state.el;

    const total = allRegistrations.length;
    const distinctChurchSet = new Set();
    let smsCount = 0;
    const activeDay = selectedDay !== 'all' ? parseInt(selectedDay, 10) : getActiveDay();
    let dayAttendedCount = 0;

    allRegistrations.forEach((r) => {
      const k = normalizeKey(r.location || '');
      if (k !== 'n/a') distinctChurchSet.add(k);
      if (r.sms_sent === true) smsCount += 1;
      if (r[`day${activeDay}_attended`] === true) dayAttendedCount += 1;
    });

    if (tabRegCount) tabRegCount.textContent = formatCount(total);

    if (statLabel1) statLabel1.textContent = 'Total Registered';
    if (statVal1) statVal1.textContent = formatCount(total);
    if (statHint1) statHint1.innerHTML = '<i class="fa-solid fa-users"></i> Unique attendees';

    if (statLabel2) statLabel2.textContent = 'Churches / Orgs';
    if (statIcon2) statIcon2.className = 'fa-solid fa-church';
    if (statVal2) statVal2.textContent = formatCount(distinctChurchSet.size);
    if (statHint2) statHint2.innerHTML = '<i class="fa-solid fa-building-columns"></i> Distinct organizations';

    if (statLabel3) statLabel3.textContent = `Day ${activeDay} Attendance`;
    if (statIcon3) statIcon3.className = 'fa-solid fa-calendar-check';
    if (statVal3) statVal3.textContent = formatCount(dayAttendedCount);
    if (statHint3) statHint3.innerHTML = `<i class="fa-solid fa-clock"></i> ${DAY_LABELS[activeDay] || 'Active Day'}`;

    if (statLabel4) statLabel4.textContent = 'SMS Sent';
    if (statIcon4) statIcon4.className = 'fa-solid fa-comment-sms';
    if (statVal4) statVal4.textContent = formatCount(smsCount);
    if (statHint4) statHint4.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Confirmations delivered';
  }

  function renderDayCell(val) {
    return val === true
      ? '<span class="day-badge yes">Yes</span>'
      : '<span class="day-badge no">No</span>';
  }

  function renderTable() {
    const { tableHead, tableBody, emptyState, totalEntriesLabel, tableCardSubtitle } = state.el;
    if (!tableHead || !tableBody) return;

    if (tableCardSubtitle) {
      tableCardSubtitle.textContent = 'Track attendees, churches/organizations, Day 1–4 attendance, and export summary reports.';
    }

    tableHead.innerHTML = `
      <tr>
        <th style="width:48px">#</th>
        <th><span>Ticket ID</span></th>
        <th><span>Title</span></th>
        <th><span>Full Name</span></th>
        <th><span>Phone Number</span></th>
        <th><span>Church / Organization</span></th>
        <th><span>Day 1</span></th>
        <th><span>Day 2</span></th>
        <th><span>Day 3</span></th>
        <th><span>Day 4</span></th>
        <th><span>SMS</span></th>
        <th><span>Registered At</span></th>
        <th style="width:64px;text-align:center;"><span>Actions</span></th>
      </tr>
    `;

    const totalFiltered = filteredRegistrations.length;
    if (totalEntriesLabel) {
      totalEntriesLabel.textContent = `${formatCount(totalFiltered)} ${totalFiltered === 1 ? 'record' : 'records'}`;
    }

    if (totalFiltered === 0) {
      tableBody.innerHTML = '';
      if (emptyState) {
        emptyState.classList.remove('hidden');
        emptyState.style.display = '';
      }
      if (state.el.emptyTitle) {
        state.el.emptyTitle.textContent = hasActiveFilters()
          ? 'No matching records found'
          : 'No registrations yet';
      }
      if (state.el.emptyDesc) {
        state.el.emptyDesc.textContent = hasActiveFilters()
          ? 'No attendees match your selected filters. Try adjusting or clearing your filters.'
          : 'Registrations will appear here as attendees register for CMBC 2026.';
      }
      renderPagination(0);
      return;
    }

    if (emptyState) {
      emptyState.classList.add('hidden');
      emptyState.style.display = '';
    }

    const startIdx = (currentPage - 1) * itemsPerPage;
    const pageItems = filteredRegistrations.slice(startIdx, startIdx + itemsPerPage);

    tableBody.innerHTML = pageItems.map((reg, i) => {
      const num = startIdx + i + 1;
      const id = reg.id;
      const ticketId = escapeHtml(reg.ticket_id || '—');
      const title = escapeHtml(reg.member_status || '—');
      const name = escapeHtml(reg.name || '—');
      const rawPhone = String(reg.contact || '').trim();
      const hasPhone = Boolean(rawPhone && rawPhone.toLowerCase() !== 'n/a' && rawPhone !== '-');
      const phone = hasPhone ? escapeHtml(formatPhoneDisplay(rawPhone) || rawPhone) : 'N/A';
      const phoneCellHtml = hasPhone
        ? `<a class="contact-link" href="tel:${phone}"><i class="fa-solid fa-phone"></i> ${phone}</a>`
        : `<span class="muted">N/A</span>`;
      const church = escapeHtml(reg.location || 'N/A');
      const smsBadge = reg.sms_sent === true
        ? '<span class="status-badge sent"><i class="fa-solid fa-check"></i> Sent</span>'
        : '<span class="status-badge pending"><i class="fa-regular fa-clock"></i> Pending</span>';
      const regAt = escapeHtml(formatDate(reg.registration_date || reg.created_at));

        const canEdit = hasPermission('edit_registrations');
        const canDelete = hasPermission('delete_registrations');

        return `
        <tr>
          <td class="row-num">${num}</td>
          <td class="ticket-pill"><code>${ticketId}</code></td>
          <td><span class="member-pill status-member">${title}</span></td>
          <td><span class="attendee-name">${name}</span></td>
          <td>${phoneCellHtml}</td>
          <td><span class="loc-text"><i class="fa-solid fa-church"></i> ${church}</span></td>
          <td>${renderDayCell(reg.day1_attended)}</td>
          <td>${renderDayCell(reg.day2_attended)}</td>
          <td>${renderDayCell(reg.day3_attended)}</td>
          <td>${renderDayCell(reg.day4_attended)}</td>
          <td>${smsBadge}</td>
          <td><span class="date-text">${regAt}</span></td>
          <td style="text-align:center;">
            <div class="row-action-wrap">
              <button type="button" class="hamburger-action-btn" data-row-menu-btn="${id}" title="Record actions" aria-label="Actions">
                <i class="fa-solid fa-bars"></i>
              </button>
              <div class="row-action-menu" id="rowMenu-${id}" role="menu">
                <button type="button" class="row-action-item" data-action="view" data-id="${id}">
                  <i class="fa-solid fa-eye"></i><span>View Full Details</span>
                </button>
                ${canEdit ? `<button type="button" class="row-action-item" data-action="edit" data-id="${id}">
                  <i class="fa-solid fa-pen-to-square"></i><span>Edit Record</span>
                </button>` : ''}
                ${canDelete ? `<button type="button" class="row-action-item danger" data-action="delete" data-id="${id}">
                  <i class="fa-solid fa-trash-can"></i><span>Delete Record</span>
                </button>` : ''}
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    renderPagination(totalFiltered);
  }

  function renderCurrentData() {
    renderStats();
    renderTable();
    if (state.el.lastRefreshTime) {
      state.el.lastRefreshTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  }

  function renderPagination(totalItems) {
    const { paginationInfo, pageNumbers, firstPageBtn, prevPageBtn, nextPageBtn, lastPageBtn } = state.el;
    const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = totalItems === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1;
    const end = Math.min(currentPage * itemsPerPage, totalItems);
    if (paginationInfo) {
      paginationInfo.textContent = `Showing ${formatCount(start)} – ${formatCount(end)} of ${formatCount(totalItems)} entries`;
    }
    if (firstPageBtn) firstPageBtn.disabled = currentPage <= 1;
    if (prevPageBtn) prevPageBtn.disabled = currentPage <= 1;
    if (nextPageBtn) nextPageBtn.disabled = currentPage >= totalPages;
    if (lastPageBtn) lastPageBtn.disabled = currentPage >= totalPages;

    if (pageNumbers) {
      const maxVisible = 5;
      let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
      let endPage = Math.min(totalPages, startPage + maxVisible - 1);
      if (endPage - startPage + 1 < maxVisible) startPage = Math.max(1, endPage - maxVisible + 1);
      let html = '';
      for (let p = startPage; p <= endPage; p++) {
        html += `<button type="button" class="page-num-btn${p === currentPage ? ' active' : ''}" data-page="${p}" aria-label="Page ${p}"${p === currentPage ? ' aria-current="page"' : ''}>${p}</button>`;
      }
      pageNumbers.innerHTML = html;
    }
  }

  // Row Hamburger Actions & Modals
  function openAdminModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.add('open');
  }

  function closeAdminModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.remove('open');
  }

  function findRecordById(id) {
    return allRegistrations.find((r) => String(r.id) === String(id)) || null;
  }

  function openViewModal(id) {
    const reg = findRecordById(id);
    if (!reg) return;
    const body = document.getElementById('viewRecordBody');
    if (!body) return;
    const totalDays = [reg.day1_attended, reg.day2_attended, reg.day3_attended, reg.day4_attended].filter(Boolean).length;
    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-label">Ticket ID</div><div class="detail-val">${escapeHtml(reg.ticket_id || '—')}</div></div>
        <div class="detail-item"><div class="detail-label">Title</div><div class="detail-val">${escapeHtml(reg.member_status || '—')}</div></div>
        <div class="detail-item"><div class="detail-label">Full Name</div><div class="detail-val">${escapeHtml(reg.name || '—')}</div></div>
        <div class="detail-item"><div class="detail-label">Phone Number</div><div class="detail-val">${escapeHtml(formatPhoneDisplay(reg.contact) || '—')}</div></div>
        <div class="detail-item"><div class="detail-label">Church / Organization</div><div class="detail-val">${escapeHtml(reg.location || 'N/A')}</div></div>
        <div class="detail-item"><div class="detail-label">Days Attended</div><div class="detail-val">${totalDays} / 4 Days</div></div>
        <div class="detail-item"><div class="detail-label">SMS Status</div><div class="detail-val">${reg.sms_sent ? 'Sent' : 'Pending'}</div></div>
        <div class="detail-item"><div class="detail-label">Registered At</div><div class="detail-val">${escapeHtml(formatDate(reg.registration_date || reg.created_at))}</div></div>
      </div>
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-label">Day 1 (Tue Nov 24)</div><div class="detail-val">${renderDayCell(reg.day1_attended)} ${reg.day1_checkin_at ? '<small style="color:var(--ash-500);margin-left:6px;">' + escapeHtml(formatDate(reg.day1_checkin_at)) + '</small>' : ''}</div></div>
        <div class="detail-item"><div class="detail-label">Day 2 (Wed Nov 25)</div><div class="detail-val">${renderDayCell(reg.day2_attended)} ${reg.day2_checkin_at ? '<small style="color:var(--ash-500);margin-left:6px;">' + escapeHtml(formatDate(reg.day2_checkin_at)) + '</small>' : ''}</div></div>
        <div class="detail-item"><div class="detail-label">Day 3 (Thu Nov 26)</div><div class="detail-val">${renderDayCell(reg.day3_attended)} ${reg.day3_checkin_at ? '<small style="color:var(--ash-500);margin-left:6px;">' + escapeHtml(formatDate(reg.day3_checkin_at)) + '</small>' : ''}</div></div>
        <div class="detail-item"><div class="detail-label">Day 4 (Fri Nov 27)</div><div class="detail-val">${renderDayCell(reg.day4_attended)} ${reg.day4_checkin_at ? '<small style="color:var(--ash-500);margin-left:6px;">' + escapeHtml(formatDate(reg.day4_checkin_at)) + '</small>' : ''}</div></div>
      </div>
    `;
    openAdminModal('viewRecordModal');
  }

  function openEditModal(id) {
    const reg = findRecordById(id);
    if (!reg) return;
    document.getElementById('editRecordId').value = reg.id;
    document.getElementById('editTitle').value = reg.member_status || '';
    document.getElementById('editName').value = reg.name || '';
    const rawContact = String(reg.contact || '').trim();
    const hasContact = Boolean(rawContact && rawContact.toLowerCase() !== 'n/a' && rawContact !== '-');
    document.getElementById('editContact').value = hasContact ? (formatPhoneDisplay(rawContact) || rawContact) : '';
    document.getElementById('editChurch').value = (reg.location && reg.location !== 'N/A') ? reg.location : '';
    document.getElementById('editDay1').checked = Boolean(reg.day1_attended);
    document.getElementById('editDay2').checked = Boolean(reg.day2_attended);
    document.getElementById('editDay3').checked = Boolean(reg.day3_attended);
    document.getElementById('editDay4').checked = Boolean(reg.day4_attended);
    openAdminModal('editRecordModal');
  }

  function openDeleteModal(id) {
    const reg = findRecordById(id);
    if (!reg) return;
    pendingDeleteId = reg.id;
    const textEl = document.getElementById('deleteConfirmText');
    if (textEl) {
      textEl.textContent = `Are you sure you want to permanently delete ${reg.member_status ? reg.member_status + ' ' : ''}${reg.name} (${reg.ticket_id})?`;
    }
    openAdminModal('deleteRecordModal');
  }

  function setupTableAndModalListeners() {
    const tbody = state.el.tableBody;
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const menuBtn = e.target.closest('[data-row-menu-btn]');
        if (menuBtn) {
          e.stopPropagation();
          const id = menuBtn.getAttribute('data-row-menu-btn');
          const menu = document.getElementById(`rowMenu-${id}`);
          closeAllDropdowns(menu);
          if (menu) {
            const willOpen = !menu.classList.contains('open');
            if (willOpen) {
              menu.classList.add('open');
              menuBtn.classList.add('open');
              const btnRect = menuBtn.getBoundingClientRect();
              const menuHeight = menu.offsetHeight || 136;
              const menuWidth = menu.offsetWidth || 180;
              const spaceBelow = window.innerHeight - btnRect.bottom;
              const topPos = spaceBelow < menuHeight + 16
                ? Math.max(12, btnRect.top - menuHeight - 6)
                : btnRect.bottom + 6;
              const leftPos = Math.max(12, Math.min(window.innerWidth - menuWidth - 12, btnRect.right - menuWidth));
              menu.style.top = `${topPos}px`;
              menu.style.left = `${leftPos}px`;
              menu.style.right = 'auto';
            } else {
              menu.classList.remove('open');
              menuBtn.classList.remove('open');
            }
          }
          return;
        }
        const actionBtn = e.target.closest('.row-action-item[data-action]');
        if (actionBtn) {
          e.stopPropagation();
          const action = actionBtn.getAttribute('data-action');
          const id = actionBtn.getAttribute('data-id');
          closeAllDropdowns();
          if (action === 'view') openViewModal(id);
          else if (action === 'edit') openEditModal(id);
          else if (action === 'delete') openDeleteModal(id);
        }
      });
    }

    document.querySelectorAll('[data-close-admin-modal]').forEach((el) => {
      el.addEventListener('click', () => {
        closeAdminModal(el.getAttribute('data-close-admin-modal'));
      });
    });

    const addContactInput = document.getElementById('addContact');
    const syncAddSmsCheckbox = (isReset = false) => {
      const smsCb = document.getElementById('addSendSms');
      const smsWrap = document.getElementById('addSendSmsWrap');
      if (!smsCb) return;
      const val = addContactInput ? addContactInput.value.trim() : '';
      const hasPhone = Boolean(val && val.toLowerCase() !== 'n/a' && val !== '-');
      if (!hasPhone) {
        smsCb.checked = false;
        smsCb.disabled = true;
        if (smsWrap) smsWrap.classList.add('is-disabled');
      } else {
        const wasDisabled = smsCb.disabled;
        smsCb.disabled = false;
        if (smsWrap) smsWrap.classList.remove('is-disabled');
        if (wasDisabled || isReset) {
          smsCb.checked = true;
        }
      }
    };

    if (addContactInput) {
      addContactInput.addEventListener('input', () => syncAddSmsCheckbox(false));
    }

    const openAddRecordBtn = document.getElementById('openAddRecordBtn');
    if (openAddRecordBtn) {
      openAddRecordBtn.addEventListener('click', () => {
        const form = document.getElementById('addRecordForm');
        if (form) form.reset();
        const activeDay = getActiveDay();
        for (let d = 1; d <= 4; d++) {
          const cb = document.getElementById(`addDay${d}`);
          if (cb) cb.checked = d === activeDay;
        }
        syncAddSmsCheckbox(true);
        openAdminModal('addRecordModal');
      });
    }

    const addForm = document.getElementById('addRecordForm');
    if (addForm) {
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const saveBtn = document.getElementById('saveAddBtn');
        if (saveBtn) saveBtn.disabled = true;
        try {
          const res = await fetchWithTimeout(`${getApiUrl()}/registrations`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
              memberStatus: document.getElementById('addTitle').value,
              name: document.getElementById('addName').value.trim(),
              contact: document.getElementById('addContact').value.trim(),
              location: document.getElementById('addChurch').value.trim() || 'N/A',
              day1_attended: document.getElementById('addDay1').checked,
              day2_attended: document.getElementById('addDay2').checked,
              day3_attended: document.getElementById('addDay3').checked,
              day4_attended: document.getElementById('addDay4').checked,
              sendSms: document.getElementById('addSendSms').checked
            })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) {
            showToast(data.message || 'Failed to register attendee. Your inputs are still here — please retry.', 'err');
            return;
          }
          closeAdminModal('addRecordModal');
          showToast(data.message || 'Attendee registered successfully.', 'ok');
          await loadRegistrationsData();
        } catch (err) {
          console.error(err);
          showToast(getFriendlyNetworkError(err, 'Could not reach server. Your inputs are preserved — click Register Attendee to retry.'), 'err');
        } finally {
          if (saveBtn) saveBtn.disabled = false;
        }
      });
    }

    const editForm = document.getElementById('editRecordForm');
    if (editForm) {
      editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editRecordId').value;
        const saveBtn = document.getElementById('saveEditBtn');
        if (saveBtn) saveBtn.disabled = true;
        try {
          const res = await fetchWithTimeout(`${getApiUrl()}/registrations/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({
              memberStatus: document.getElementById('editTitle').value,
              name: document.getElementById('editName').value.trim(),
              contact: document.getElementById('editContact').value.trim(),
              location: document.getElementById('editChurch').value.trim() || 'N/A',
              day1_attended: document.getElementById('editDay1').checked,
              day2_attended: document.getElementById('editDay2').checked,
              day3_attended: document.getElementById('editDay3').checked,
              day4_attended: document.getElementById('editDay4').checked
            })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) {
            showToast(data.message || 'Failed to update record. Your edits are still here — please retry.', 'err');
            return;
          }
          closeAdminModal('editRecordModal');
          showToast('Registration updated successfully.', 'ok');
          await loadRegistrationsData();
        } catch (err) {
          console.error(err);
          showToast(getFriendlyNetworkError(err, 'Could not reach server. Your edits are preserved — click Save Changes to retry.'), 'err');
        } finally {
          if (saveBtn) saveBtn.disabled = false;
        }
      });
    }

    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    if (confirmDeleteBtn) {
      confirmDeleteBtn.addEventListener('click', async () => {
        if (!pendingDeleteId) return;
        confirmDeleteBtn.disabled = true;
        try {
          const res = await fetch(`${getApiUrl()}/registrations/${pendingDeleteId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) {
            showToast(data.message || 'Failed to delete record.', 'err');
            return;
          }
          pendingDeleteId = null;
          closeAdminModal('deleteRecordModal');
          showToast('Registration deleted.', 'ok');
          await loadRegistrationsData();
        } catch (err) {
          console.error(err);
          showToast('Network error deleting record.', 'err');
        } finally {
          confirmDeleteBtn.disabled = false;
        }
      });
    }
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadCsvFile(headers, rows, filenameBase) {
    const csv = '\uFEFF' + [headers.map(csvEscape).join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenameBase}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportRegistrationsCSV(forceMaster = false, customBase = '') {
    const isFiltered = !forceMaster && hasActiveFilters();
    const dataToExport = isFiltered ? filteredRegistrations : allRegistrations;
    if (!dataToExport || dataToExport.length === 0) {
      showToast(isFiltered ? 'No matching filtered records to export.' : 'No registrations available to export.', 'warn');
      return;
    }

    const headers = [
      '#',
      'Ticket ID',
      'Title',
      'Full Name',
      'Phone Number',
      'Church / Organization',
      'Day 1 (Tue 24)',
      'Day 2 (Wed 25)',
      'Day 3 (Thu 26)',
      'Day 4 (Fri 27)',
      'Days Attended',
      'SMS Sent',
      'Registered At'
    ];

    const rows = dataToExport.map((reg, idx) => {
      const d1 = reg.day1_attended === true ? 'Yes' : 'No';
      const d2 = reg.day2_attended === true ? 'Yes' : 'No';
      const d3 = reg.day3_attended === true ? 'Yes' : 'No';
      const d4 = reg.day4_attended === true ? 'Yes' : 'No';
      const totalDays = [reg.day1_attended, reg.day2_attended, reg.day3_attended, reg.day4_attended].filter(Boolean).length;
      return [
        idx + 1,
        csvEscape(reg.ticket_id || ''),
        csvEscape(reg.member_status || ''),
        csvEscape(reg.name || ''),
        formatPhoneForCsvFormula(reg.contact),
        csvEscape(reg.location || 'N/A'),
        d1,
        d2,
        d3,
        d4,
        totalDays,
        reg.sms_sent === true ? 'Yes' : 'No',
        csvEscape(formatDate(reg.registration_date || reg.created_at))
      ].join(',');
    });

    let base = customBase || 'cmbc2026-attendance-report';
    if (!forceMaster && selectedDay !== 'all') base += `-day${selectedDay}`;
    if (!forceMaster && selectedChurches.size === 1) {
      const slug = Array.from(selectedChurches)[0].replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
      if (slug) base += `-${slug}`;
    } else if (!forceMaster && selectedChurches.size > 1) {
      base += `-${selectedChurches.size}-churches`;
    }

    downloadCsvFile(headers, rows, base);
    showToast(`Exported ${dataToExport.length} records to CSV`, 'ok');
  }

  async function loadRegistrationsData() {
    if (isFetching) return;
    isFetching = true;
    const { refreshIcon } = state.el;
    if (refreshIcon) refreshIcon.classList.add('fa-spin');

    try {
      const apiUrl = getApiUrl();
      const headers = getAuthHeaders();
      const [regRes, statsRes] = await Promise.all([
        fetch(`${apiUrl}/registrations`, { headers, cache: 'no-store' }),
        fetch(`${apiUrl}/stats`, { headers, cache: 'no-store' })
      ]);

      if (regRes.status === 401 || regRes.status === 403) {
        localStorage.removeItem('adminToken');
        window.location.replace('/login');
        return;
      }

      if (regRes.ok) {
        const data = await regRes.json();
        allRegistrations = Array.isArray(data.data) ? data.data : [];
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        if (data && data.success && data.data) regStats = data.data;
      }

      populateTitleFilterOptions();
      populateChurchFilterOptions();
      filteredRegistrations = filterRegistrations(state.el.searchInput ? state.el.searchInput.value : '');
      renderCurrentData();
    } catch (err) {
      console.error('Error loading registrations:', err);
    } finally {
      isFetching = false;
      if (refreshIcon) refreshIcon.classList.remove('fa-spin');
    }
  }

  function setupAutoRefresh() {
    const toggle = state.el.autoRefresh;
    const start = () => {
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      autoRefreshTimer = setInterval(() => {
        if (!document.hidden && !document.querySelector('.admin-modal.open')) {
          loadRegistrationsData();
        }
      }, 15000);
    };
    if (toggle) {
      if (toggle.checked) start();
      toggle.addEventListener('change', () => {
        if (toggle.checked) start();
        else if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
      });
    }
  }

  // =========================================================================
  // USER MANAGEMENT (SUPER ADMIN / manage_users PERMISSION)
  // =========================================================================
  async function loadCurrentUserProfile() {
    try {
      const cached = localStorage.getItem('adminUser');
      if (cached) {
        currentUser = JSON.parse(cached);
        applyUserPermissionsUI();
      }
    } catch (_) {}

    try {
      const res = await fetch(`${getApiUrl()}/admin/me`, {
        headers: getAuthHeaders(),
        cache: 'no-store'
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminUser');
        window.location.replace('/login');
        return false;
      }
      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.user) {
          currentUser = data.user;
          localStorage.setItem('adminUser', JSON.stringify(currentUser));
          applyUserPermissionsUI();
        }
      }
      return true;
    } catch (err) {
      console.error('Failed to load admin profile:', err);
      return true;
    }
  }

  function applyUserPermissionsUI() {
    const avatarEl = document.getElementById('currentUserAvatar');
    const nameEl = document.getElementById('currentUserName');
    const roleEl = document.getElementById('currentUserRole');
    const tabUsers = document.getElementById('tabUsers');
    const exportWrap = document.getElementById('exportDropdownWrap');

    const displayName = currentUser.fullName || currentUser.username || 'Admin';
    if (avatarEl) avatarEl.textContent = displayName.charAt(0).toUpperCase();
    if (nameEl) nameEl.textContent = displayName;
    if (roleEl) roleEl.textContent = (currentUser.isSuperAdmin || currentUser.role === 'super_admin') ? 'Super Admin' : 'Admin User';

    if (tabUsers) {
      tabUsers.style.display = hasPermission('manage_users') ? 'inline-flex' : 'none';
    }
    if (exportWrap) {
      exportWrap.style.display = hasPermission('export_data') ? '' : 'none';
    }
    const openAddRecordBtn = document.getElementById('openAddRecordBtn');
    if (openAddRecordBtn) {
      openAddRecordBtn.style.display = hasPermission('add_registrations') ? 'inline-flex' : 'none';
    }
  }

  function switchDashboardTab(tab) {
    activeDashboardTab = tab === 'users' && hasPermission('manage_users') ? 'users' : 'registrations';
    const tabReg = document.getElementById('tabRegistrations');
    const tabUsers = document.getElementById('tabUsers');
    const regView = document.getElementById('registrationsView');
    const usersView = document.getElementById('usersView');

    if (tabReg) {
      tabReg.classList.toggle('active', activeDashboardTab === 'registrations');
      tabReg.setAttribute('aria-selected', String(activeDashboardTab === 'registrations'));
    }
    if (tabUsers) {
      tabUsers.classList.toggle('active', activeDashboardTab === 'users');
      tabUsers.setAttribute('aria-selected', String(activeDashboardTab === 'users'));
    }
    if (regView) regView.style.display = activeDashboardTab === 'registrations' ? '' : 'none';
    if (usersView) usersView.style.display = activeDashboardTab === 'users' ? '' : 'none';

    if (activeDashboardTab === 'users') {
      loadAdminUsers();
    }
  }

  async function loadAdminUsers() {
    if (!hasPermission('manage_users')) return;
    try {
      const res = await fetch(`${getApiUrl()}/admin/users`, {
        headers: getAuthHeaders(),
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        allAdminUsers = Array.isArray(data.data) ? data.data : [];
        const badge = document.getElementById('tabUsersCount');
        if (badge) badge.textContent = formatCount(allAdminUsers.length);
        renderAdminUsersTable();
      }
    } catch (err) {
      console.error('Error loading admin users:', err);
    }
  }

  function renderAdminUsersTable() {
    const tbody = document.getElementById('usersTableBody');
    const emptyState = document.getElementById('usersEmptyState');
    if (!tbody) return;

    if (allAdminUsers.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }
    if (emptyState) emptyState.classList.add('hidden');

    tbody.innerHTML = allAdminUsers.map((u, idx) => {
      const perms = Array.isArray(u.permissions) ? u.permissions : [];
      const permHtml = perms.map((p) => {
        const meta = PERM_LABELS[p] || { label: p, cls: '' };
        return `<span class="perm-badge ${meta.cls}">${escapeHtml(meta.label)}</span>`;
      }).join('');
      const statusBadge = u.is_active
        ? '<span class="status-badge sent"><i class="fa-solid fa-check"></i> Active</span>'
        : '<span class="status-badge pending"><i class="fa-solid fa-ban"></i> Disabled</span>';
      const lastLogin = u.last_login_at ? escapeHtml(formatDate(u.last_login_at)) : '<span class="muted">Never</span>';

      return `
        <tr>
          <td class="row-num">${idx + 1}</td>
          <td class="ticket-pill"><code>${escapeHtml(u.username)}</code></td>
          <td><span class="attendee-name">${escapeHtml(u.full_name)}</span></td>
          <td><div class="perm-badges">${permHtml || '<span class="muted">None</span>'}</div></td>
          <td>${statusBadge}</td>
          <td><span class="date-text">${lastLogin}</span></td>
          <td style="text-align:center;">
            <div class="user-action-btns">
              <button type="button" class="user-icon-btn" data-user-action="edit" data-user-id="${u.id}" title="Edit User & Permissions">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
              <button type="button" class="user-icon-btn danger" data-user-action="delete" data-user-id="${u.id}" title="Delete User">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function resetUserPasswordVisibility() {
    const pwdEl = document.getElementById('userPassword');
    const toggleBtn = document.getElementById('toggleUserPassword');
    const iconEl = document.getElementById('toggleUserPasswordIcon');
    if (pwdEl) pwdEl.type = 'password';
    if (iconEl) {
      iconEl.classList.remove('fa-eye-slash');
      iconEl.classList.add('fa-eye');
    }
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-pressed', 'false');
      toggleBtn.setAttribute('aria-label', 'Show password');
      toggleBtn.setAttribute('title', 'Show password');
    }
  }

  function openAddUserModal() {
    document.getElementById('editUserId').value = '';
    document.getElementById('userFormModalTitle').innerHTML = '<i class="fa-solid fa-user-plus"></i> Add Admin User';
    document.getElementById('userUsername').value = '';
    document.getElementById('userFullName').value = '';
    const pwdEl = document.getElementById('userPassword');
    const pwdLabel = document.getElementById('userPasswordLabel');
    if (pwdEl) { pwdEl.value = ''; pwdEl.required = true; pwdEl.placeholder = 'Min 6 characters'; }
    if (pwdLabel) pwdLabel.textContent = 'Password *';
    resetUserPasswordVisibility();
    document.getElementById('userIsActive').checked = true;
    document.querySelectorAll('input[name="userPerm"]').forEach((cb) => {
      cb.checked = cb.value === 'view_registrations';
    });
    openAdminModal('userFormModal');
  }

  function openEditUserModal(id) {
    const u = allAdminUsers.find((item) => String(item.id) === String(id));
    if (!u) return;
    document.getElementById('editUserId').value = u.id;
    document.getElementById('userFormModalTitle').innerHTML = '<i class="fa-solid fa-user-pen"></i> Edit Admin User';
    document.getElementById('userUsername').value = u.username || '';
    document.getElementById('userFullName').value = u.full_name || '';
    const pwdEl = document.getElementById('userPassword');
    const pwdLabel = document.getElementById('userPasswordLabel');
    if (pwdEl) { pwdEl.value = ''; pwdEl.required = false; pwdEl.placeholder = 'Leave blank to keep current'; }
    if (pwdLabel) pwdLabel.textContent = 'Reset Password (optional)';
    resetUserPasswordVisibility();
    document.getElementById('userIsActive').checked = Boolean(u.is_active);
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    document.querySelectorAll('input[name="userPerm"]').forEach((cb) => {
      cb.checked = perms.includes(cb.value);
    });
    openAdminModal('userFormModal');
  }

  function openDeleteUserModal(id) {
    const u = allAdminUsers.find((item) => String(item.id) === String(id));
    if (!u) return;
    pendingDeleteUserId = u.id;
    const textEl = document.getElementById('deleteUserConfirmText');
    if (textEl) {
      textEl.textContent = `Are you sure you want to permanently delete admin user "${u.full_name}" (@${u.username})?`;
    }
    openAdminModal('deleteUserModal');
  }

  function setupUserManagementListeners() {
    document.getElementById('tabRegistrations')?.addEventListener('click', () => switchDashboardTab('registrations'));
    document.getElementById('tabUsers')?.addEventListener('click', () => switchDashboardTab('users'));
    document.getElementById('openAddUserBtn')?.addEventListener('click', openAddUserModal);

    document.getElementById('toggleUserPassword')?.addEventListener('click', () => {
      const pwdEl = document.getElementById('userPassword');
      const toggleBtn = document.getElementById('toggleUserPassword');
      const iconEl = document.getElementById('toggleUserPasswordIcon');
      if (!pwdEl) return;
      const isHidden = pwdEl.type === 'password';
      pwdEl.type = isHidden ? 'text' : 'password';
      if (iconEl) {
        iconEl.classList.toggle('fa-eye', !isHidden);
        iconEl.classList.toggle('fa-eye-slash', isHidden);
      }
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', String(isHidden));
        toggleBtn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        toggleBtn.setAttribute('title', isHidden ? 'Hide password' : 'Show password');
      }
    });

    document.getElementById('usersTableBody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-user-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-user-action');
      const id = btn.getAttribute('data-user-id');
      if (action === 'edit') openEditUserModal(id);
      else if (action === 'delete') openDeleteUserModal(id);
    });

    document.getElementById('adminUserForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('editUserId').value;
      const saveBtn = document.getElementById('saveUserBtn');
      const perms = Array.from(document.querySelectorAll('input[name="userPerm"]:checked')).map((cb) => cb.value);
      if (perms.length === 0) {
        showToast('Please select at least one permission.', 'warn');
        return;
      }

      const payload = {
        username: document.getElementById('userUsername').value.trim(),
        fullName: document.getElementById('userFullName').value.trim(),
        isActive: document.getElementById('userIsActive').checked,
        permissions: perms
      };
      const pwd = document.getElementById('userPassword').value;
      if (pwd) payload.password = pwd;

      if (saveBtn) saveBtn.disabled = true;
      try {
        const url = id ? `${getApiUrl()}/admin/users/${id}` : `${getApiUrl()}/admin/users`;
        const method = id ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          showToast(data.message || 'Failed to save admin user.', 'err');
          return;
        }
        closeAdminModal('userFormModal');
        showToast(id ? 'Admin user updated.' : 'Admin user created successfully.', 'ok');
        await loadAdminUsers();
      } catch (err) {
        console.error(err);
        showToast('Network error saving user.', 'err');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    });

    document.getElementById('confirmDeleteUserBtn')?.addEventListener('click', async () => {
      if (!pendingDeleteUserId) return;
      const btn = document.getElementById('confirmDeleteUserBtn');
      if (btn) btn.disabled = true;
      try {
        const res = await fetch(`${getApiUrl()}/admin/users/${pendingDeleteUserId}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          showToast(data.message || 'Failed to delete admin user.', 'err');
          return;
        }
        pendingDeleteUserId = null;
        closeAdminModal('deleteUserModal');
        showToast('Admin user deleted.', 'ok');
        await loadAdminUsers();
      } catch (err) {
        console.error(err);
        showToast('Network error deleting user.', 'err');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  async function init() {
    const token = localStorage.getItem('adminToken');
    if (!token) {
      window.location.replace('/login');
      return;
    }

    if (state.el.logoutBtn) {
      state.el.logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminUser');
        window.location.replace('/login');
      });
    }

    const { firstPageBtn, prevPageBtn, nextPageBtn, lastPageBtn, pageNumbers } = state.el;
    if (firstPageBtn) firstPageBtn.addEventListener('click', () => window.goToFirstPage());
    if (prevPageBtn) prevPageBtn.addEventListener('click', () => window.previousPage());
    if (nextPageBtn) nextPageBtn.addEventListener('click', () => window.nextPage());
    if (lastPageBtn) lastPageBtn.addEventListener('click', () => window.goToLastPage());
    if (pageNumbers) {
      pageNumbers.addEventListener('click', (e) => {
        const btn = e.target.closest('.page-num-btn[data-page]');
        if (!btn) return;
        const pageNum = parseInt(btn.getAttribute('data-page'), 10);
        if (!Number.isNaN(pageNum)) window.goToPage(pageNum);
      });
    }

    document.getElementById('manualRefreshBtn')?.addEventListener('click', () => window.refreshData());
    document.getElementById('emptyRefreshBtn')?.addEventListener('click', () => window.refreshData());

    setupFiltersAndMenus();
    setupTableAndModalListeners();
    setupUserManagementListeners();
    setupAutoRefresh();

    const ok = await loadCurrentUserProfile();
    if (!ok) return;

    await loadRegistrationsData();
    if (hasPermission('manage_users')) {
      loadAdminUsers();
    }
  }

  window.refreshData = function () {
    loadRegistrationsData().then(() => showToast('Dashboard records refreshed', 'ok'));
  };
  window.goToFirstPage = function () { currentPage = 1; renderTable(); };
  window.previousPage = function () { if (currentPage > 1) { currentPage--; renderTable(); } };
  window.nextPage = function () {
    const totalPages = Math.max(1, Math.ceil(filteredRegistrations.length / itemsPerPage));
    if (currentPage < totalPages) { currentPage++; renderTable(); }
  };
  window.goToLastPage = function () {
    currentPage = Math.max(1, Math.ceil(filteredRegistrations.length / itemsPerPage));
    renderTable();
  };
  window.lastPage = window.goToLastPage;
  window.goToPage = function (p) { currentPage = p; renderTable(); };

  window.addEventListener('scroll', (e) => {
    if (e.target && e.target.closest && e.target.closest('.toolbar-dropdown-menu')) return;
    closeAllDropdowns();
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
