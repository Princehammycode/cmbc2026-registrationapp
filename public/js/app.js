(function () {
  'use strict';

  const form = document.getElementById('registrationForm');
  const submitBtn = document.getElementById('submitBtn');
  const liveCount = document.getElementById('liveCount');

  const errorModal = document.getElementById('errorModal');
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  const toastIcon = toast ? toast.querySelector('.toast-icon') : null;

  const errorMessage = document.getElementById('errorMessage');

  // Top floating success banner elements (Tablet / Kiosk stand mode)
  const topSuccessBanner = document.getElementById('topSuccessBanner');
  const topBannerTicketCode = document.getElementById('topBannerTicketCode');
  const topBannerDesc = document.getElementById('topBannerDesc');
  const topBannerCloseBtn = document.getElementById('topBannerCloseBtn');
  const topBannerProgressBar = document.getElementById('topBannerProgressBar');

  let bannerTimer = null;
  let errorModalTimer = null;
  let currentMode = 'new'; // 'new' | 'returning'
  let verifiedAttendee = null;
  let pendingDuplicatePhone = '';
  let pendingRetryAction = null;

  const modeNewBtn = document.getElementById('modeNewBtn');
  const modeReturningBtn = document.getElementById('modeReturningBtn');
  const verifyPhoneBtn = document.getElementById('verifyPhoneBtn');
  const returningDayBadges = document.getElementById('returningDayBadges');
  const verifiedTicketTag = document.getElementById('verifiedTicketTag');
  const verifiedDayPills = document.getElementById('verifiedDayPills');
  const switchToCheckInBtn = document.getElementById('switchToCheckInBtn');
  const errorRetryBtn = document.getElementById('errorRetryBtn');

  async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const offlineErr = new Error('OFFLINE');
      offlineErr.code = 'OFFLINE';
      throw offlineErr;
    }
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const timeoutErr = new Error('TIMEOUT');
        timeoutErr.code = 'TIMEOUT';
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timerId);
    }
  }

  function classifyNetworkError(err) {
    if (err && err.code === 'OFFLINE') {
      return {
        title: 'No Internet Connection',
        msg: 'You appear to be offline. Your form details are safe — reconnect to the internet and tap Retry.'
      };
    }
    if (err && err.code === 'TIMEOUT') {
      return {
        title: 'Server Timeout',
        msg: 'The server took too long to respond. Your form details are still intact — please tap Retry.'
      };
    }
    return {
      title: 'Connection Interrupted',
      msg: 'We couldn\u2019t reach the server right now. Your form details have been preserved — please tap Retry.'
    };
  }

  window.addEventListener('offline', () => {
    showToast('Internet connection lost — your entered details are safe.', 'warn');
  });
  window.addEventListener('online', () => {
    showToast('Back online! You can submit or retry now.', 'ok');
  });

  function getActiveDay() {
    return (window._APP_CONFIG && window._APP_CONFIG.activeDay) || 1;
  }

  window.addEventListener('cmbc:configLoaded', () => {
    updateSubmitButtonLabel();
  });

  if (topBannerCloseBtn && topSuccessBanner) {
    topBannerCloseBtn.addEventListener('click', hideTopSuccess);
  }

  if (switchToCheckInBtn) {
    switchToCheckInBtn.addEventListener('click', () => {
      const savedPhone = pendingDuplicatePhone;
      if (errorModalTimer) {
        clearTimeout(errorModalTimer);
        errorModalTimer = null;
      }
      closeModal(errorModal);
      setMode('returning');
      if (savedPhone) {
        const contactEl = document.getElementById('contact');
        if (contactEl) {
          contactEl.value = savedPhone;
          contactEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        verifyReturningPhone();
      }
    });
  }

  if (errorRetryBtn) {
    errorRetryBtn.addEventListener('click', () => {
      const action = pendingRetryAction;
      pendingRetryAction = null;
      if (errorModalTimer) {
        clearTimeout(errorModalTimer);
        errorModalTimer = null;
      }
      closeModal(errorModal);
      if (typeof action === 'function') {
        action();
      }
    });
  }

  document.getElementById('errorCloseBtn')?.addEventListener('click', () => {
    pendingRetryAction = null;
    if (errorModalTimer) {
      clearTimeout(errorModalTimer);
      errorModalTimer = null;
    }
    closeModal(errorModal);
  });
  document.querySelectorAll('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('click', () => {
      pendingRetryAction = null;
      if (errorModalTimer) {
        clearTimeout(errorModalTimer);
        errorModalTimer = null;
      }
      closeModal(errorModal);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      pendingRetryAction = null;
      if (errorModalTimer) {
        clearTimeout(errorModalTimer);
        errorModalTimer = null;
      }
      closeModal(errorModal);
      hideTopSuccess();
    }
  });

  loadLiveCount();
  initValidators();
  initCustomDropdown();
  initCountryPicker();
  initReturningMode();

  form.addEventListener('submit', onSubmit);

  function initReturningMode() {
    if (modeNewBtn) {
      modeNewBtn.addEventListener('click', () => setMode('new'));
    }
    if (modeReturningBtn) {
      modeReturningBtn.addEventListener('click', () => setMode('returning'));
    }
    if (verifyPhoneBtn) {
      verifyPhoneBtn.addEventListener('click', verifyReturningPhone);
    }

    const contactEl = document.getElementById('contact');
    if (contactEl) {
      contactEl.addEventListener('input', () => {
        if (currentMode === 'returning' && verifiedAttendee) {
          clearVerifiedProfile();
        }
      });
    }
  }

  function setMode(mode) {
    currentMode = mode === 'returning' ? 'returning' : 'new';
    verifiedAttendee = null;

    if (modeNewBtn) {
      modeNewBtn.classList.toggle('active', currentMode === 'new');
      modeNewBtn.setAttribute('aria-selected', String(currentMode === 'new'));
    }
    if (modeReturningBtn) {
      modeReturningBtn.classList.toggle('active', currentMode === 'returning');
      modeReturningBtn.setAttribute('aria-selected', String(currentMode === 'returning'));
    }

    resetForm();

    const nameEl = document.getElementById('name');
    const locEl = document.getElementById('location');
    const selectWrap = document.getElementById('customSelectWrap');
    const isRet = currentMode === 'returning';

    if (form) {
      form.classList.toggle('is-returning-mode', isRet);
      form.classList.remove('is-verified');
    }
    if (verifyPhoneBtn) {
      verifyPhoneBtn.style.display = isRet ? 'inline-flex' : 'none';
    }
    if (nameEl) {
      nameEl.readOnly = isRet;
      nameEl.tabIndex = isRet ? -1 : 0;
    }
    if (locEl) {
      locEl.readOnly = isRet;
      locEl.tabIndex = isRet ? -1 : 0;
    }
    if (selectWrap) {
      selectWrap.tabIndex = isRet ? -1 : 0;
    }

    updateSubmitButtonLabel();

    setTimeout(() => {
      const target = isRet ? document.getElementById('contact') : document.getElementById('name');
      if (target) target.focus();
    }, 60);
  }

  function clearVerifiedProfile() {
    verifiedAttendee = null;
    if (form) form.classList.remove('is-verified');
    if (returningDayBadges) returningDayBadges.style.display = 'none';

    const nameEl = document.getElementById('name');
    const locEl = document.getElementById('location');
    const hiddenInput = document.getElementById('memberStatus');
    const valueDisplay = document.getElementById('selectValue');
    const wrap = document.getElementById('customSelectWrap');

    if (nameEl) nameEl.value = '';
    if (locEl) locEl.value = '';
    if (hiddenInput) hiddenInput.value = '';
    if (valueDisplay) valueDisplay.textContent = '';
    if (wrap) wrap.classList.remove('has-value', 'is-open');

    updateSubmitButtonLabel();
  }

  function updateSubmitButtonLabel() {
    if (!submitBtn) return;
    const defSpan = submitBtn.querySelector('.btn-default');
    const day = getActiveDay();

    if (currentMode === 'new') {
      submitBtn.disabled = false;
      if (defSpan) defSpan.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Secure My Seat';
      return;
    }

    if (!verifiedAttendee) {
      submitBtn.disabled = true;
      if (defSpan) defSpan.innerHTML = `<i class="fa-solid fa-user-check"></i> Verify Phone to Check In (Day ${day})`;
    } else if (verifiedAttendee.alreadyCheckedInToday) {
      submitBtn.disabled = true;
      if (defSpan) defSpan.innerHTML = `<i class="fa-solid fa-circle-check"></i> Already Checked In for Day ${day}`;
    } else {
      submitBtn.disabled = false;
      if (defSpan) defSpan.innerHTML = `<i class="fa-solid fa-check-double"></i> Confirm Check-In for Day ${day}`;
    }
  }

  function renderVerifiedDayPills(att, activeDay) {
    if (!returningDayBadges || !verifiedDayPills) return;
    if (verifiedTicketTag) verifiedTicketTag.textContent = att.ticketId || '';

    const days = [
      { num: 1, label: 'Day 1', ok: !!att.day1 },
      { num: 2, label: 'Day 2', ok: !!att.day2 },
      { num: 3, label: 'Day 3', ok: !!att.day3 },
      { num: 4, label: 'Day 4', ok: !!att.day4 }
    ];

    verifiedDayPills.innerHTML = days.map((d) => {
      const cls = ['day-pill', d.ok ? 'attended' : '', d.num === activeDay ? 'is-today' : ''].filter(Boolean).join(' ');
      const icon = d.ok ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-regular fa-circle"></i>';
      return `<span class="${cls}">${icon} ${d.label}</span>`;
    }).join('');

    returningDayBadges.style.display = 'flex';
  }

  async function verifyReturningPhone() {
    const contactEl = document.getElementById('contact');
    if (!contactEl) return;

    if (typeof contactEl.__validate === 'function' && !contactEl.__validate()) {
      showToast('Please enter a valid phone number first.', 'warn');
      contactEl.focus();
      return;
    }

    const country = getSelectedCountry();
    const rawContact = contactEl.value.trim();
    const arrangedContact = formatArrangedPhone(rawContact, country);
    const API_URL = (window._APP_CONFIG && window._APP_CONFIG.apiUrl) || window.API_BASE_URL || (window.location.origin + '/api');

    if (verifyPhoneBtn) {
      verifyPhoneBtn.classList.add('loading');
      verifyPhoneBtn.disabled = true;
    }

    try {
      const res = await fetchWithTimeout(API_URL + '/verify-attendee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: arrangedContact })
      }, 20000);
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success || !data.attendee) {
        if (res.status >= 500) {
          showErrorModal(
            'The server is temporarily busy while verifying your number. Tap Retry to try again.',
            'Server Temporarily Busy',
            { retryAction: () => verifyReturningPhone() }
          );
          return;
        }
        clearVerifiedProfile();
        showToast(data.message || 'Phone number not found. Please register under New Registration.', 'err');
        return;
      }

      const att = data.attendee;
      const activeDay = data.activeDay || getActiveDay();
      if (window._APP_CONFIG) window._APP_CONFIG.activeDay = activeDay;

      verifiedAttendee = att;
      if (form) form.classList.add('is-verified');

      // Populate locked profile fields
      const hiddenInput = document.getElementById('memberStatus');
      const valueDisplay = document.getElementById('selectValue');
      const wrap = document.getElementById('customSelectWrap');
      const nameEl = document.getElementById('name');
      const locEl = document.getElementById('location');

      if (hiddenInput) hiddenInput.value = att.title || '';
      if (valueDisplay) valueDisplay.textContent = att.title || '—';
      if (wrap) wrap.classList.add('has-value');
      if (nameEl) nameEl.value = att.name || '';
      if (locEl) locEl.value = att.church && att.church !== 'N/A' ? att.church : 'N/A';

      renderVerifiedDayPills(att, activeDay);
      updateSubmitButtonLabel();

      if (att.alreadyCheckedInToday) {
        showToast(`${att.name} is already checked in for Day\u00A0${activeDay}.`, 'ok');
      } else {
        showToast(`Verified: ${att.title ? att.title + ' ' : ''}${att.name}. Tap Confirm Check-In!`, 'ok');
      }
    } catch (err) {
      console.error(err);
      const info = classifyNetworkError(err);
      showErrorModal(info.msg, info.title, { retryAction: () => verifyReturningPhone() });
    } finally {
      if (verifyPhoneBtn) {
        verifyPhoneBtn.classList.remove('loading');
        verifyPhoneBtn.disabled = false;
      }
    }
  }

  function showTopSuccess(name, ticketId, customDesc) {
    if (!topSuccessBanner) return;

    if (topBannerTicketCode) {
      topBannerTicketCode.textContent = ticketId || 'CMBC26-SUCCESS';
    }
    if (topBannerDesc) {
      const firstName = extractFirst(name);
      topBannerDesc.textContent = customDesc || `Thank you, ${firstName}! Your confirmation was sent via SMS.`;
    }

    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }

    // Reset progress bar animation
    topSuccessBanner.classList.remove('show', 'animate-progress');
    if (topBannerProgressBar) {
      void topBannerProgressBar.offsetWidth; // force DOM reflow
    }

    requestAnimationFrame(() => {
      topSuccessBanner.classList.add('show', 'animate-progress');
    });

    // Auto-dismiss after 4.5 seconds
    bannerTimer = setTimeout(() => {
      hideTopSuccess();
    }, 4500);
  }

  function hideTopSuccess() {
    if (!topSuccessBanner) return;
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
    topSuccessBanner.classList.remove('show', 'animate-progress');
  }

  function resetForm() {
    if (!form) return;
    form.reset();
    verifiedAttendee = null;
    if (form) form.classList.remove('is-verified');
    if (returningDayBadges) returningDayBadges.style.display = 'none';
    updateSubmitButtonLabel();

    // Reset custom dropdown
    const hiddenInput = document.getElementById('memberStatus');
    const valueDisplay = document.getElementById('selectValue');
    const wrap = document.getElementById('customSelectWrap');
    const menu = document.getElementById('customDropdownMenu');

    if (hiddenInput) {
      hiddenInput.value = '';
      delete hiddenInput.dataset.touched;
    }
    if (valueDisplay) {
      valueDisplay.textContent = '';
    }
    if (wrap) {
      wrap.classList.remove('has-value', 'is-open');
    }
    if (menu) {
      menu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('selected'));
    }

    // Reset country selector back to Ghana default
    const countryPicker = document.getElementById('countryPicker');
    if (countryPicker) countryPicker.classList.remove('is-open');
    const countrySelect = document.getElementById('countrySelect');
    if (countrySelect) {
      countrySelect.value = 'GH';
      countrySelect.dispatchEvent(new Event('change'));
    }

    // Reset validation states & helper texts
    const defaultHelpers = {
      name: 'Enter your full name',
      contact: 'e.g. 0244123456 (10 digits)',
      memberStatus: 'Select your title',
      location: 'Your church, ministry, or organization'
    };
    const fields = ['name', 'contact', 'memberStatus', 'location'];
    fields.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        delete el.dataset.touched;
        const grp = el.closest('.form-group');
        if (grp) grp.classList.remove('valid', 'invalid');
        const helper = document.getElementById(id + 'Helper');
        if (helper) {
          const icon = helper.querySelector('i')?.outerHTML || '<i class="fa-solid fa-circle-info"></i>';
          const defaultMsg = helper.getAttribute('data-default') || defaultHelpers[id] || '';
          if (defaultMsg) {
            helper.innerHTML = icon + ' ' + defaultMsg;
          }
        }
      }
    });

    // Focus Phone Number in Returning mode, or Full Name in New Registration mode
    setTimeout(() => {
      const targetEl = currentMode === 'returning'
        ? document.getElementById('contact')
        : document.getElementById('name');
      if (targetEl) {
        targetEl.focus();
      }
    }, 80);
  }

  function initCustomDropdown() {
    const wrap = document.getElementById('customSelectWrap');
    const hiddenInput = document.getElementById('memberStatus');
    const valueDisplay = document.getElementById('selectValue');
    const menu = document.getElementById('customDropdownMenu');
    if (!wrap || !hiddenInput || !valueDisplay || !menu) return;

    const parentGroup = wrap.closest('.form-group');
    const parentRow = wrap.closest('.form-grid-row');

    function openDropdown() {
      wrap.classList.add('is-open');
      if (parentGroup) parentGroup.classList.add('is-active-field');
      if (parentRow) parentRow.classList.add('is-active-row');
    }

    function closeDropdown() {
      wrap.classList.remove('is-open');
      if (parentGroup) parentGroup.classList.remove('is-active-field');
      if (parentRow) parentRow.classList.remove('is-active-row');
    }

    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      if (wrap.classList.contains('is-open')) {
        closeDropdown();
      } else {
        openDropdown();
      }
    });

    menu.querySelectorAll('.dropdown-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = item.getAttribute('data-value');
        hiddenInput.value = val;
        valueDisplay.textContent = val;
        wrap.classList.add('has-value');
        closeDropdown();

        menu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');

        hiddenInput.dataset.touched = '1';
        hiddenInput.dispatchEvent(new Event('change'));
      });
    });

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) {
        closeDropdown();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDropdown();
      }
    });
  }

  function openModal(modal) {
    if (!modal) return;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      const close = modal.querySelector('button, a');
      if (close) close.focus({ preventScroll: true });
    }, 120);
  }
  function closeModal(modal) {
    if (!modal || !modal.classList.contains('open')) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  function showToast(message, kind) {
    if (!toast || !toastText) return;
    toast.className = 'toast' + (kind ? ' ' + kind : '');
    toastText.textContent = message;
    if (toastIcon) {
      toastIcon.className = 'toast-icon ' + iconClassFor(kind);
    }
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 4200);
  }
  function iconClassFor(kind) {
    if (kind === 'ok') return 'fa-solid fa-circle-check';
    if (kind === 'err') return 'fa-solid fa-triangle-exclamation';
    if (kind === 'warn') return 'fa-solid fa-circle-exclamation';
    return 'fa-solid fa-circle-info';
  }

  function getSelectedCountry() {
    const countrySelect = document.getElementById('countrySelect');
    if (!countrySelect) {
      return { code: 'GH', dial: '+233', digits: 10, omitZero: true };
    }
    const opt = countrySelect.selectedOptions[0] || countrySelect.options[0];
    return {
      code: opt.value,
      dial: opt.getAttribute('data-dial') || '+233',
      digits: parseInt(opt.getAttribute('data-digits'), 10) || 15,
      omitZero: opt.getAttribute('data-omit-zero') === 'true'
    };
  }

  function initCountryPicker() {
    const countryPicker = document.getElementById('countryPicker');
    const countrySelect = document.getElementById('countrySelect');
    const countryIso = document.getElementById('countryIso');
    const countryDialCode = document.getElementById('countryDialCode');
    const countrySearchInput = document.getElementById('countrySearchInput');
    const countryList = document.getElementById('countryList');
    const contactInput = document.getElementById('contact');
    const phoneHelper = document.getElementById('phoneHelper');
    const parentRow = countryPicker?.closest('.form-grid-row');
    const parentGroup = countryPicker?.closest('.form-group');
    if (!countryPicker || !countrySelect || !countryList) return;

    // Populate custom country items from select options
    const countries = Array.from(countrySelect.options).map((opt) => {
      const code = opt.value;
      const dial = opt.getAttribute('data-dial') || '';
      const digits = opt.getAttribute('data-digits') || '15';
      const omitZero = opt.getAttribute('data-omit-zero') || 'false';
      const name = opt.textContent.replace(/\s*\(\+[^)]+\)\s*$/, '').trim();
      return { code, dial, digits, omitZero, name };
    });

    countryList.innerHTML = countries.map((c) => {
      const isSel = c.code === countrySelect.value ? ' selected' : '';
      return `
        <div class="country-item${isSel}" data-code="${c.code}" data-dial="${c.dial}" data-name="${c.name.toLowerCase()}" role="option">
          <span class="country-item-iso">${c.code}</span>
          <span class="country-item-name">${c.name}</span>
          <span class="country-item-dial">${c.dial}</span>
          <i class="fa-solid fa-check country-item-check"></i>
        </div>
      `;
    }).join('');

    function openPicker() {
      // Close attendee status dropdown if open
      const customSelectWrap = document.getElementById('customSelectWrap');
      if (customSelectWrap && customSelectWrap.classList.contains('is-open')) {
        customSelectWrap.classList.remove('is-open');
      }

      countryPicker.classList.add('is-open');
      countryPicker.setAttribute('aria-expanded', 'true');
      if (parentGroup) parentGroup.classList.add('is-active-field');
      if (parentRow) parentRow.classList.add('is-active-row');

      if (countrySearchInput) {
        countrySearchInput.value = '';
        filterCountries('');
        setTimeout(() => countrySearchInput.focus(), 60);
      }

      const selectedItem = countryList.querySelector('.country-item.selected');
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest' });
      }
    }

    function closePicker() {
      countryPicker.classList.remove('is-open');
      countryPicker.setAttribute('aria-expanded', 'false');
      if (parentGroup) parentGroup.classList.remove('is-active-field');
      if (parentRow) parentRow.classList.remove('is-active-row');
    }

    // Toggle dropdown on badge click
    countryPicker.addEventListener('click', (e) => {
      if (e.target.closest('.country-dropdown-menu')) return;
      e.stopPropagation();
      if (countryPicker.classList.contains('is-open')) {
        closePicker();
      } else {
        openPicker();
      }
    });

    // Select country item
    countryList.addEventListener('click', (e) => {
      const item = e.target.closest('.country-item');
      if (!item) return;
      e.stopPropagation();

      const code = item.getAttribute('data-code');
      countrySelect.value = code;
      countrySelect.dispatchEvent(new Event('change'));

      countryList.querySelectorAll('.country-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');

      closePicker();
      if (contactInput) contactInput.focus();
    });

    // Instant real-time search filtering
    function filterCountries(q) {
      const term = q.trim().toLowerCase();
      let matches = 0;
      countryList.querySelectorAll('.country-item').forEach((item) => {
        const name = item.getAttribute('data-name') || '';
        const code = (item.getAttribute('data-code') || '').toLowerCase();
        const dial = (item.getAttribute('data-dial') || '').toLowerCase();
        const ok = !term || name.includes(term) || code.includes(term) || dial.includes(term);
        item.style.display = ok ? 'flex' : 'none';
        if (ok) matches++;
      });

      let noRes = countryList.querySelector('.country-no-results');
      if (matches === 0) {
        if (!noRes) {
          noRes = document.createElement('div');
          noRes.className = 'country-no-results';
          noRes.textContent = 'No matching country found';
          countryList.appendChild(noRes);
        }
        noRes.style.display = 'block';
      } else if (noRes) {
        noRes.style.display = 'none';
      }
    }

    if (countrySearchInput) {
      countrySearchInput.addEventListener('input', (e) => {
        filterCountries(e.target.value);
      });
      countrySearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const firstVisible = countryList.querySelector('.country-item[style*="display: flex"], .country-item:not([style*="display: none"])');
          if (firstVisible) {
            firstVisible.click();
          }
        }
      });
    }

    // Outside click closes dropdown
    document.addEventListener('click', (e) => {
      if (!countryPicker.contains(e.target)) {
        closePicker();
      }
    });

    // Escape key closes dropdown
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && countryPicker.classList.contains('is-open')) {
        closePicker();
      }
    });

    function syncCountry() {
      const c = getSelectedCountry();
      if (countryIso) countryIso.textContent = c.code;
      if (countryDialCode) countryDialCode.textContent = c.dial;

      if (countryList) {
        countryList.querySelectorAll('.country-item').forEach((item) => {
          if (item.getAttribute('data-code') === c.code) {
            item.classList.add('selected');
          } else {
            item.classList.remove('selected');
          }
        });
      }

      if (contactInput) {
        contactInput.setAttribute('maxlength', c.digits);
        const cleaned = contactInput.value.replace(/\D/g, '').slice(0, c.digits);
        if (contactInput.value !== cleaned) {
          contactInput.value = cleaned;
        }

        const helperDefault = c.code === 'GH'
          ? 'e.g. 0244123456 (10 digits)'
          : `e.g. up to ${c.digits} digits for ${c.code} (${c.dial})`;
        if (phoneHelper) {
          phoneHelper.setAttribute('data-default', helperDefault);
          if (!contactInput.value) {
            phoneHelper.innerHTML = `<i class="fa-solid fa-circle-info"></i> ${helperDefault}`;
          }
        }

        if (contactInput.dataset.touched === '1' && typeof contactInput.__validate === 'function') {
          contactInput.__validate();
        }
      }
    }

    countrySelect.addEventListener('change', syncCountry);
    syncCountry();
  }

  function initValidators() {
    const nameInput = document.getElementById('name');
    const contactInput = document.getElementById('contact');
    const memberStatusInput = document.getElementById('memberStatus');
    const locationInput = document.getElementById('location');

    // Dynamic numeric constraint (respects country's max digits)
    enforceDigitsOnly(contactInput);

    bindField(nameInput, validateName);
    bindField(contactInput, validatePhone);
    bindField(memberStatusInput, validateMemberStatus);
    bindField(locationInput, validateLocation);
  }

  function bindField(input, fn) {
    if (!input) return;
    const group = input.closest('.form-group');
    const helper = document.getElementById(input.id + 'Helper');
    const run = () => {
      const res = fn(input.value);
      applyState(group, helper, res);
      return res.valid;
    };
    input.addEventListener('blur', run);
    input.addEventListener('input', () => {
      if (input.dataset.touched === '1') run();
    });
    input.addEventListener('change', () => {
      if (input.dataset.touched === '1') run();
    });
    input.__validate = () => {
      input.dataset.touched = '1';
      return run();
    };
  }

  function applyState(group, helper, result) {
    if (!group) return;
    group.classList.remove('valid', 'invalid');
    if (!result.touched) return;
    if (result.valid) group.classList.add('valid');
    else if (result.showError) group.classList.add('invalid');
    if (helper && result.message) {
      const prefix = helper.querySelector('i')?.outerHTML || '';
      helper.innerHTML = prefix + ' ' + result.message;
    }
  }

  function validateName(raw) {
    const v = (raw || '').trim();
    if (!v) return { valid: false, showError: false, touched: false, message: 'Please enter your full legal name.' };
    if (/\d/.test(v)) {
      return { valid: false, showError: true, touched: true, message: 'Name cannot contain numbers. Use letters only.' };
    }
    if (v.length < 2) return { valid: false, showError: true, touched: true, message: 'Name must be at least 2 characters long.' };
    if (!/^[A-Za-z\u00C0-\u024F\s'.-]+$/.test(v)) {
      return { valid: false, showError: true, touched: true, message: 'Name can only contain letters, spaces, hyphens, and apostrophes.' };
    }
    return { valid: true, touched: true, message: 'Name looks great.' };
  }

  function enforceDigitsOnly(input) {
    if (!input) return;

    function getMaxLen() {
      const attr = parseInt(input.getAttribute('maxlength'), 10);
      return !isNaN(attr) && attr > 0 ? attr : 15;
    }

    input.addEventListener('keydown', (e) => {
      // Allow navigation and shortcut keys
      if (
        e.key === 'Backspace' ||
        e.key === 'Delete' ||
        e.key === 'Tab' ||
        e.key === 'Escape' ||
        e.key === 'Enter' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'Home' ||
        e.key === 'End' ||
        e.ctrlKey ||
        e.metaKey
      ) {
        return;
      }
      // Block non-digit keys
      if (!/^[0-9]$/.test(e.key)) {
        e.preventDefault();
      }
    });

    input.addEventListener('input', () => {
      const maxLen = getMaxLen();
      const cleaned = input.value.replace(/\D/g, '').slice(0, maxLen);
      if (input.value !== cleaned) {
        input.value = cleaned;
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const maxLen = getMaxLen();
      const pasteText = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      const digitsOnly = pasteText.replace(/\D/g, '').slice(0, maxLen);
      input.value = digitsOnly;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function formatArrangedPhone(rawDigits, country) {
    let clean = (rawDigits || '').replace(/\D/g, '');
    if (country.omitZero && clean.startsWith('0')) {
      clean = clean.replace(/^0+/, '');
    }
    const dial = country.dial || '+';
    return `${dial}${clean}`;
  }

  function validatePhone(raw) {
    const v = raw || '';
    const digits = v.replace(/\D/g, '');
    const country = getSelectedCountry();

    if (!digits) {
      return { valid: false, showError: false, touched: !!v, message: `Please enter phone number (${country.digits} digits max).` };
    }

    if (country.code === 'GH') {
      if (digits.startsWith('0')) {
        if (digits.length < 10) {
          return {
            valid: false, showError: true, touched: true,
            message: `Ghana phone number starting with 0 must be 10 digits (${digits.length}/10 entered).`
          };
        }
        if (digits.length > 10) {
          return {
            valid: false, showError: true, touched: true,
            message: 'Ghana phone number starting with 0 cannot exceed 10 digits.'
          };
        }
      } else {
        if (digits.length < 9) {
          return {
            valid: false, showError: true, touched: true,
            message: `Ghana phone number must be 9 digits without 0, or 10 digits with 0 (${digits.length}/9 entered).`
          };
        }
        if (digits.length > 9) {
          return {
            valid: false, showError: true, touched: true,
            message: 'Ghana phone number without leading 0 must be 9 digits (e.g. 244123456).'
          };
        }
      }

      const ghLocal = digits.startsWith('0') ? digits : '0' + digits;
      const validPrefixes = ['020', '023', '024', '025', '026', '027', '028', '029', '050', '053', '054', '055', '056', '057', '058', '059'];
      const pre = ghLocal.substring(0, 3);
      if (!validPrefixes.includes(pre)) {
        return {
          valid: false, showError: true, touched: true,
          message: 'Unrecognized Ghana network prefix (024, 054, 020, etc.). Please verify.'
        };
      }
      return {
        valid: true, touched: true,
        message: `Valid Ghana number (${ghLocal}) → +233 ${ghLocal.substring(1)}`
      };
    }

    // Other country validation (e.g. USA, UK, Canada, Nigeria, etc.)
    const minDigits = (country.code === 'US' || country.code === 'CA') ? 10 : 7;
    const maxDigits = country.digits || 15;

    if (digits.length < minDigits) {
      return {
        valid: false, showError: true, touched: true,
        message: `Phone number is too short (${digits.length}/${minDigits} min digits).`
      };
    }
    if (digits.length > maxDigits) {
      return {
        valid: false, showError: true, touched: true,
        message: `Phone number cannot exceed ${maxDigits} digits.`
      };
    }

    const arranged = formatArrangedPhone(digits, country);
    return {
      valid: true, touched: true,
      message: `Valid phone number → ${arranged}`
    };
  }

  function validateEmail(raw) {
    const v = (raw || '').trim();
    if (!v) return { valid: true, touched: !!raw, message: 'Optional — leave blank if you don\u2019t have an email.' };
    if (v.length > 254) return { valid: false, showError: true, touched: true, message: 'Email address is too long.' };

    // Strict RFC 5322 compliant regex for standard email validation
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!emailRegex.test(v)) {
      return { valid: false, showError: true, touched: true, message: 'Please enter a valid email address (e.g. name@example.com).' };
    }
    const [localPart, domain] = v.split('@');
    if (localPart.length > 64) return { valid: false, showError: true, touched: true, message: 'The username part of your email is too long.' };
    if (!domain || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
      return { valid: false, showError: true, touched: true, message: 'Email domain is invalid (e.g. gmail.com).' };
    }
    return { valid: true, touched: true, message: 'Valid email address. We will send a copy of your e-ticket here.' };
  }

  function validateMemberStatus(raw) {
    const v = (raw || '').trim();
    if (!v) return { valid: false, showError: false, touched: !!v, message: 'Please select your title.' };
    return { valid: true, touched: true, message: 'Title selected.' };
  }

  function validateLocation(raw) {
    const v = (raw || '').trim();
    if (!v) return { valid: true, touched: !!raw, message: 'Optional — your church, ministry, or organization.' };
    if (v.length > 100) return { valid: false, showError: true, touched: true, message: 'Name is too long (max 100 characters).' };
    if (!/^[A-Za-z0-9\u00C0-\u024F\s,.'&()-]+$/.test(v)) {
      return { valid: false, showError: true, touched: true, message: 'Only letters, digits, spaces and common punctuation allowed.' };
    }
    return { valid: true, touched: true, message: 'Church / Organization recorded.' };
  }

  async function loadLiveCount() {
    if (!liveCount) return;
    try {
      const API_URL = window._APP_CONFIG && window._APP_CONFIG.apiUrl;
      if (!API_URL) return;
      const res = await fetch(API_URL + '/health', { cache: 'no-store' });
      if (res.ok) {
        liveCount.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#35d39a"></i> Online';
      }
    } catch (_) {
      liveCount.textContent = 'Accepting';
    }
  }

  function setLoading(loading) {
    if (loading) {
      submitBtn.classList.add('loading');
      submitBtn.disabled = true;
    } else {
      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;
    }
  }

  async function onSubmit(e) {
    e.preventDefault();

    // Returning Attendee 2-step Check-In submission
    if (currentMode === 'returning') {
      if (!verifiedAttendee) {
        await verifyReturningPhone();
        return;
      }
      if (verifiedAttendee.alreadyCheckedInToday) {
        showToast(`Already checked in for Day\u00A0${getActiveDay()}.`, 'ok');
        return;
      }

      setLoading(true);
      try {
        const API_URL = (window._APP_CONFIG && window._APP_CONFIG.apiUrl) || window.API_BASE_URL || (window.location.origin + '/api');
        const country = getSelectedCountry();
        const rawContact = document.getElementById('contact').value.trim();
        const arrangedContact = formatArrangedPhone(rawContact, country);

        const response = await fetchWithTimeout(API_URL + '/checkin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact: arrangedContact })
        }, 20000);
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.success) {
          const isRetryable = response.status >= 500 || response.status === 408 || response.status === 429;
          showErrorModal(
            data.message || 'Check-in failed. Your details are preserved — please try again.',
            isRetryable ? 'Server Temporarily Busy' : 'Check-In Error',
            { retryAction: isRetryable ? () => form.requestSubmit() : null }
          );
          return;
        }

        const att = data.attendee || verifiedAttendee;
        const activeDay = data.activeDay || getActiveDay();
        const desc = data.alreadyCheckedIn
          ? `${att.name} was already checked in for Day\u00A0${activeDay}.`
          : `Welcome back, ${extractFirst(att.name)}! Checked in for Day\u00A0${activeDay} & SMS sent.`;
        showTopSuccess(att.name, att.ticketId || `DAY ${activeDay}`, desc);
        resetForm();
      } catch (err) {
        console.error(err);
        const info = classifyNetworkError(err);
        showErrorModal(info.msg, info.title, { retryAction: () => form.requestSubmit() });
      } finally {
        setLoading(false);
        updateSubmitButtonLabel();
      }
      return;
    }

    const fields = ['name', 'contact', 'memberStatus', 'location'];
    let firstInvalid = null;
    for (const id of fields) {
      const el = document.getElementById(id);
      if (el && typeof el.__validate === 'function') {
        const ok = el.__validate();
        if (!ok && !firstInvalid) firstInvalid = el;
      }
    }
    if (firstInvalid) {
      showToast('Please fix the highlighted fields before submitting.', 'warn');
      firstInvalid.focus({ preventScroll: false });
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    setLoading(true);
    try {
      const API_URL = (window._APP_CONFIG && window._APP_CONFIG.apiUrl) || window.API_BASE_URL || (window.location.origin + '/api');

      const country = getSelectedCountry();
      const rawContact = document.getElementById('contact').value.trim();
      const arrangedContact = formatArrangedPhone(rawContact, country);

      const payload = {
        name: document.getElementById('name').value.trim(),
        contact: arrangedContact,
        rawContact: rawContact,
        countryCode: country.code,
        memberStatus: (document.getElementById('memberStatus')?.value || '').trim(),
        location: document.getElementById('location').value.trim()
      };

      const response = await fetchWithTimeout(API_URL + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, 20000);

      let data;
      try { data = await response.json(); } catch (_) { data = {}; }

      if (!response.ok || !data || data.success === false) {
        const code = data && data.code;
        let msg = (data && data.message) || 'Something went wrong. Your details are still safe — please try again.';
        let title = 'We hit a snag';
        let isDuplicate = false;
        let retryAction = null;

        if (code === 'DUPLICATE_REGISTRATION' || code === 'DUPLICATE_CONTACT' || /already exists|already registered/i.test(msg)) {
          title = "Phone Number Already Registered";
          msg = 'This phone number is already registered! Click "Switch to Check-In" below to check in for today.';
          isDuplicate = true;
          pendingDuplicatePhone = rawContact;
        } else if (response.status === 400) {
          title = 'Please Check Your Details';
          msg = (data && data.message) || 'Some fields need your attention — please review and try again.';
        } else if (response.status >= 500 || response.status === 408 || response.status === 429) {
          title = 'Server Temporarily Busy';
          msg = 'The server is temporarily busy. Your form details are still intact — please tap Retry.';
          retryAction = () => form.requestSubmit();
        }
        showErrorModal(msg, title, { isDuplicate, retryAction });
        setLoading(false);
        return;
      }

      const name = data.name || payload.name;
      const ticketId = data.ticketId;

      // Tablet / Kiosk Mode:
      // 1. Show sleek top banner with timer/loading countdown
      showTopSuccess(name, ticketId);

      // 2. Immediately clear form for the next user in line & focus first field
      resetForm();

    } catch (err) {
      console.error(err);
      const info = classifyNetworkError(err);
      showErrorModal(info.msg, info.title, { retryAction: () => form.requestSubmit() });
    } finally {
      setLoading(false);
    }
  }

  function extractFirst(full) {
    if (!full) return 'friend';
    const parts = full.trim().split(/\s+/);
    return parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase() : 'friend';
  }

  function showErrorModal(msg, title = 'We hit a snag', optionsOrDup = false) {
    const opts = typeof optionsOrDup === 'object' && optionsOrDup !== null
      ? optionsOrDup
      : { isDuplicate: Boolean(optionsOrDup), retryAction: null };
    const isDuplicate = Boolean(opts.isDuplicate);
    const retryAction = typeof opts.retryAction === 'function' ? opts.retryAction : null;

    const errorTitle = document.getElementById('errorTitle');
    const errorIconCircle = document.querySelector('.error-icon-circle');
    const errorIcon = errorIconCircle ? errorIconCircle.querySelector('i') : null;
    const errorCloseBtn = document.getElementById('errorCloseBtn');

    pendingRetryAction = retryAction;

    if (errorTitle) errorTitle.textContent = title;
    if (errorMessage) errorMessage.textContent = msg;

    if (errorRetryBtn) {
      errorRetryBtn.style.display = retryAction ? 'inline-flex' : 'none';
    }

    if (errorCloseBtn) {
      if (retryAction) {
        errorCloseBtn.classList.remove('btn-primary');
        errorCloseBtn.classList.add('btn-ghost');
        errorCloseBtn.innerHTML = '<i class="fa-solid fa-pen"></i> Keep Editing';
      } else {
        errorCloseBtn.classList.remove('btn-ghost');
        errorCloseBtn.classList.add('btn-primary');
        errorCloseBtn.innerHTML = '<i class="fa-solid fa-xmark"></i> Close';
      }
    }

    if (errorModalTimer) {
      clearTimeout(errorModalTimer);
      errorModalTimer = null;
    }

    if (errorIconCircle) {
      if (isDuplicate) {
        errorIconCircle.classList.add('is-info');
        if (errorIcon) errorIcon.className = 'fa-solid fa-circle-check';
        if (switchToCheckInBtn) switchToCheckInBtn.style.display = 'inline-flex';
      } else {
        errorIconCircle.classList.remove('is-info');
        if (errorIcon) errorIcon.className = retryAction ? 'fa-solid fa-wifi' : 'fa-solid fa-xmark';
        if (switchToCheckInBtn) switchToCheckInBtn.style.display = 'none';
        pendingDuplicatePhone = '';
      }
    }

    openModal(errorModal);
  }
})();
