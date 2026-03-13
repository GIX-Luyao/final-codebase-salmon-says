/**
 * Integration Logic for Salmon Say Platform
 * Connects Frontend UI with Validation Lambda and Prediction API
 */

// API base: localhost -> local backend; production -> relative path (same origin, CloudFront routes /api/* to backend).
// Override: window.SALMON_API_BASE / window.SALMON_AUTH_BASE in HTML if needed.
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const AUTH_BASE = (typeof window !== 'undefined' && window.SALMON_AUTH_BASE) != null
  ? window.SALMON_AUTH_BASE
  : isLocal ? 'http://' + window.location.hostname + ':4000' : '';
const API_BASE = (typeof window !== 'undefined' && window.SALMON_API_BASE) != null
  ? window.SALMON_API_BASE
  : isLocal ? 'http://' + window.location.hostname + ':4000' : '';

// API Configuration
const CONFIG = {
    VALIDATION_API_URL: 'https://wi8os2zguk.execute-api.us-west-2.amazonaws.com/validate-upload',
    // Full prediction: persists to S3 + DynamoDB
    PREDICTION_API_URL: `${API_BASE}/api/predict`,
    // Preview-only prediction for Quick Check (no database writes)
    PREDICTION_PREVIEW_API_URL: `${API_BASE}/api/predict_preview`,
    HISTORY_API_URL: `${API_BASE}/api/history`,
    IMAGE_URL_API: `${API_BASE}/api/image-url`,
    PRESIGN_UPLOAD_API_URL: `${API_BASE}/api/presign-upload`
};

// Expose CONFIG to window for use in index.html
window.CONFIG = CONFIG;

// Confidence threshold: results >= this value are "High-Confidence"
const HIGH_CONFIDENCE_THRESHOLD = 90; // compare against rounded integer % to avoid float precision issues

// Auth gate
const TOKEN_KEY = 'salmon_token';
let integrationStarted = false;

function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
}

function setToken(token) {
    if (!token) return;
    sessionStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
}

function showLoginGate(show) {
    const gate = document.getElementById('loginGate');
    const appRoot = document.getElementById('appRoot');
    if (gate) gate.style.display = show ? 'flex' : 'none';
    if (appRoot) appRoot.style.display = show ? 'none' : 'block';
}

function setLoginError(msg) {
    const errorEl = document.getElementById('loginError');
    if (!errorEl) return;
    errorEl.textContent = msg || '';
    errorEl.style.display = msg ? 'block' : 'none';
}

function setSignupError(msg) {
    const errorEl = document.getElementById('signupError');
    if (!errorEl) return;
    errorEl.textContent = msg || '';
    errorEl.style.display = msg ? 'block' : 'none';
}

function setWelcomeUser(username) {
    window.currentUsername = username || '';
    const titleEl = document.getElementById('welcomeTitle');
    if (!titleEl) return;
    titleEl.textContent = username ? `Welcome, ${username}!` : 'Welcome!';
}

function formatManualReviewDate(isoString) {
    if (!isoString) return '';
    try {
        // If no timezone indicator, the server stored UTC but forgot the 'Z'.
        // Append 'Z' so JS parses it as UTC and converts to local time correctly.
        const normalized = isoString.endsWith('Z') || isoString.includes('+') ? isoString : isoString + 'Z';
        const d = new Date(normalized);
        if (Number.isNaN(d.getTime())) return isoString;
        return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    } catch (_) {
        return isoString;
    }
}

function toCardNumber(imageId) {
    if (!imageId) return '';
    const base = String(imageId).replace(/\.[^.]+$/, '');
    return base.slice(0, 8);
}

function toBackendImageIdString(value) {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    const baseName = raw.split('/').pop() || raw;
    // Match backend cleaning in predict_api.py (filename -> image_id)
    return Array.from(baseName).filter(ch => /[A-Za-z0-9_.-]/.test(ch)).join('');
}

function imageIdSortKey(value) {
    return toBackendImageIdString(value).toLowerCase();
}

function sortRowsByImageIdForDisplay(rows) {
    if (!Array.isArray(rows)) return [];

    return rows
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
            const aImageId = a.item && a.item.image_id ? a.item.image_id : '';
            const bImageId = b.item && b.item.image_id ? b.item.image_id : '';
            const aKey = imageIdSortKey(aImageId);
            const bKey = imageIdSortKey(bImageId);

            if (aKey !== bKey) return aKey.localeCompare(bKey);

            const aCreated = Date.parse((a.item && a.item.created_at) || '') || 0;
            const bCreated = Date.parse((b.item && b.item.created_at) || '') || 0;
            if (aCreated !== bCreated) return bCreated - aCreated;

            return a.index - b.index;
        })
        .map(entry => entry.item);
}

function showDuplicateImageIdConfirmModal(duplicates) {
    return new Promise(resolve => {
        if (!Array.isArray(duplicates) || duplicates.length === 0) {
            resolve(true);
            return;
        }

        const existingModal = document.getElementById('duplicateImageIdConfirmModal');
        if (existingModal) existingModal.remove();

        const overlay = document.createElement('div');
        overlay.id = 'duplicateImageIdConfirmModal';
        overlay.className = 'unsaved-modal-overlay';
        overlay.style.display = 'flex';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'duplicateImageIdConfirmTitle');

        const modal = document.createElement('div');
        modal.className = 'unsaved-modal';
        modal.style.maxWidth = '560px';
        modal.style.width = 'min(560px, calc(100vw - 32px))';

        const title = document.createElement('h2');
        title.id = 'duplicateImageIdConfirmTitle';
        title.className = 'unsaved-modal-title';
        title.textContent = 'Duplicate Image IDs Found';

        const text = document.createElement('p');
        text.className = 'unsaved-modal-text';
        text.textContent = 'Some image IDs already exist in the database. Do you still want to continue uploading?';

        const listWrap = document.createElement('div');
        listWrap.style.maxHeight = '220px';
        listWrap.style.overflowY = 'auto';
        listWrap.style.padding = '10px 12px';
        listWrap.style.border = '1px solid rgba(0,0,0,0.08)';
        listWrap.style.borderRadius = '10px';
        listWrap.style.background = '#fafafa';
        listWrap.style.marginTop = '6px';

        const listTitle = document.createElement('div');
        listTitle.style.fontSize = '12px';
        listTitle.style.fontWeight = '700';
        listTitle.style.letterSpacing = '0.02em';
        listTitle.style.color = '#555';
        listTitle.style.marginBottom = '8px';
        listTitle.textContent = `Detected duplicates (${duplicates.length})`;
        listWrap.appendChild(listTitle);

        const ul = document.createElement('ul');
        ul.style.margin = '0';
        ul.style.paddingLeft = '18px';
        ul.style.fontSize = '13px';
        ul.style.lineHeight = '1.45';
        ul.style.color = '#333';
        duplicates.slice(0, 10).forEach(d => {
            const li = document.createElement('li');
            li.textContent = d.count > 1
                ? `${d.imageId} (already exists ${d.count} times)`
                : `${d.imageId} (already exists)`;
            ul.appendChild(li);
        });
        listWrap.appendChild(ul);

        if (duplicates.length > 10) {
            const more = document.createElement('div');
            more.style.marginTop = '8px';
            more.style.fontSize = '12px';
            more.style.color = '#666';
            more.textContent = `...and ${duplicates.length - 10} more duplicate image IDs.`;
            listWrap.appendChild(more);
        }

        const btnRow = document.createElement('div');
        btnRow.className = 'unsaved-modal-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'unsaved-modal-btn unsaved-cancel-btn';
        cancelBtn.textContent = 'Cancel Upload';

        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'unsaved-modal-btn unsaved-discard-btn';
        continueBtn.textContent = 'Continue Upload';

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(continueBtn);
        modal.appendChild(title);
        modal.appendChild(text);
        modal.appendChild(listWrap);
        modal.appendChild(btnRow);
        overlay.appendChild(modal);

        let resolved = false;
        let previousActive = null;

        const cleanup = (result) => {
            if (resolved) return;
            resolved = true;
            document.removeEventListener('keydown', onKeyDown);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            if (previousActive && typeof previousActive.focus === 'function') {
                previousActive.focus();
            }
            resolve(result);
        };

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cleanup(false);
            }
        };

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) cleanup(false);
        });
        cancelBtn.addEventListener('click', () => cleanup(false));
        continueBtn.addEventListener('click', () => cleanup(true));
        document.addEventListener('keydown', onKeyDown);

        previousActive = document.activeElement;
        document.body.appendChild(overlay);
        continueBtn.focus();
    });
}

async function confirmDuplicateImageIdsBeforeUpload(images) {
    if (!Array.isArray(images) || images.length === 0) return true;

    let response;
    try {
        response = await apiFetch(CONFIG.HISTORY_API_URL, { method: 'GET' });
    } catch (err) {
        console.warn('Duplicate image_id check skipped (history request failed):', err);
        return true;
    }

    if (!response.ok) {
        console.warn('Duplicate image_id check skipped (history response not ok):', response.status);
        return true;
    }

    let rows;
    try {
        rows = await response.json();
    } catch (err) {
        console.warn('Duplicate image_id check skipped (invalid history response):', err);
        return true;
    }

    if (!Array.isArray(rows) || rows.length === 0) return true;

    const existingIds = new Map();
    rows.forEach(item => {
        const imageId = toBackendImageIdString(item && item.image_id);
        if (!imageId) return;
        existingIds.set(imageId, (existingIds.get(imageId) || 0) + 1);
    });

    const duplicates = [];
    const seen = new Set();
    images.forEach(img => {
        const uploadName = (img && (img.filename || (img.file && img.file.name) || img.image_id)) || '';
        const candidateId = toBackendImageIdString(uploadName);
        if (!candidateId || seen.has(candidateId)) return;
        const count = existingIds.get(candidateId) || 0;
        if (count <= 0) return;
        seen.add(candidateId);
        duplicates.push({ imageId: candidateId, count });
    });

    if (duplicates.length === 0) return true;

    duplicates.sort((a, b) => imageIdSortKey(a.imageId).localeCompare(imageIdSortKey(b.imageId)));
    if (typeof document === 'undefined' || !document.body) {
        if (typeof window.confirm !== 'function') return true;
        const fallbackMessage = `Detected ${duplicates.length} duplicate image IDs in the database. Continue upload?`;
        return window.confirm(fallbackMessage);
    }

    return await showDuplicateImageIdConfirmModal(duplicates);
}

async function loadManualReviewDataFromBackend() {
    try {
        const response = await apiFetch('/api/history', { method: 'GET' });
        if (!response.ok) throw new Error(`History API failed: ${response.status}`);
        const rows = await response.json();
        const list = Array.isArray(rows) ? rows : [];

        // Show items committed for lab review (submitted_to_lab truthy; allow string "true" from API).
        const submitted = (v) => v === true || v === 'true';
        const mapped = list
            .filter(item => item && submitted(item.submitted_to_lab) && item.review_status !== 'approved')
            .map(item => ({
                cardNumber: toCardNumber(item.image_id),
                scaleId: item.scale_id || '—',
                imageId: item.image_id || '—',
                location: 'Kalama',
                uploadDate: formatManualReviewDate(item.created_at),
                operatorName: item.user_id || '',
                reviewerName: item.reader_name || '',
                manualReadOrigin: item.manual_read_origin || '',
                originalData: item
            }));

        const existing = window.committedResults || [];
        // Don't overwrite with fewer items: keep existing (e.g. from localStorage) when backend returns less.
        let toShow;
        if (mapped.length >= existing.length) {
            toShow = mapped.length > 0 ? mapped : existing;
            if (mapped.length > 0) window.committedResults = mapped;
        } else {
            // Backend has fewer: merge backend items with existing so we don't lose local/committed data
            const key = (m) => (m.originalData && (m.originalData.job_id + '|' + m.originalData.image_id)) || ((m.cardNumber || '') + '|' + (m.uploadDate || ''));
            const seen = new Set(mapped.map(key));
            toShow = [...mapped];
            existing.forEach(item => {
                if (!seen.has(key(item))) { toShow.push(item); seen.add(key(item)); }
            });
            window.committedResults = toShow;
        }
        sortManualReviewByMostRecent(toShow);
        populateManualReviewTable(toShow);
        return toShow;
    } catch (err) {
        console.error('Failed to load Manual Review data from backend:', err);
        const fallback = window.committedResults || [];
        sortManualReviewByMostRecent(fallback);
        populateManualReviewTable(fallback);
        return fallback;
    }
}

function sortManualReviewByMostRecent(items) {
    if (!items || items.length <= 1) return;
    const toTime = (val) => {
        if (val == null || val === '') return NaN;
        if (typeof val === 'number' && !isNaN(val)) return val > 1e12 ? val : val * 1000;
        const s = String(val).trim();
        if (!s) return NaN;
        let parsed = Date.parse(s);
        if (!isNaN(parsed)) return parsed;
        if (!/Z|[+-]\d{2}:?\d{2}$/.test(s)) parsed = Date.parse(s + 'Z');
        return isNaN(parsed) ? NaN : parsed;
    };
    // Sort by most recent commit: _committedAtMs (client commit time) > updated_at > created_at
    const commitTime = (item) => {
        const o = item.originalData;
        if (o && typeof o._committedAtMs === 'number' && !isNaN(o._committedAtMs)) return o._committedAtMs;
        if (o) {
            const t = toTime(o.updated_at) || toTime(o.created_at);
            if (!isNaN(t)) return t;
        }
        if (item.uploadDate) {
            const t = toTime(item.uploadDate);
            if (!isNaN(t)) return t;
        }
        return 0;
    };
    items.sort((a, b) => commitTime(b) - commitTime(a));
}

async function syncManualReviewNotificationFromBackend() {
    try {
        const response = await apiFetch('/api/history', { method: 'GET' });
        if (!response.ok) return;
        const rows = await response.json();
        // Only notify when operator has explicitly committed records for lab review
        const hasPending = Array.isArray(rows) && rows.some(
            item => item && item.submitted_to_lab === true && item.review_status === 'pending'
        );

        if (hasPending) {
            localStorage.setItem('manualReviewHasNewData', 'true');
        } else {
            localStorage.removeItem('manualReviewHasNewData');
            sessionStorage.removeItem('manualReviewHasNewData');
        }
        if (typeof window.updateManualReviewNotification === 'function') {
            window.updateManualReviewNotification();
        }
    } catch (err) {
        console.warn('Failed to sync Manual Review notification from backend:', err);
    }
}

function showHomepageView() {
    if (typeof window.switchView === 'function') {
        window.switchView('homepage');
        return;
    }

    const myAppsSection = document.querySelector('.my-apps-section');
    const uploadPage = document.querySelector('.upload-page');
    const manualReviewPage = document.querySelector('.manual-review-page');
    const adminPanel = document.getElementById('adminRegistrationPanel');

    if (myAppsSection) myAppsSection.style.display = 'block';
    if (uploadPage) uploadPage.style.display = 'none';
    if (manualReviewPage) manualReviewPage.style.display = 'none';
    if (adminPanel) adminPanel.style.display = 'none';
}

function applyRoleHomeAccess(role, isAdmin) {
    const uploadCard = document.getElementById('uploadScalesCard');
    const reviewCard = document.getElementById('reviewScalesCard');
    const uploadListItem = document.getElementById('uploadScalesListItem');
    const reviewListItem = document.getElementById('reviewScalesListItem');
    const adminPanel = document.getElementById('adminRegistrationPanel');
    const registrationBtnWrap = document.getElementById('adminRegistrationBtnWrap');
    const registrationBtn = document.getElementById('adminRegistrationBtn');

    const isAdminUser = !!isAdmin || (role && String(role).toLowerCase() === 'admin');

    showHomepageView();
    if (uploadCard) uploadCard.style.display = '';
    if (uploadListItem) uploadListItem.style.display = '';
    if (reviewCard) reviewCard.style.display = '';
    if (reviewListItem) reviewListItem.style.display = '';

    if (isAdminUser) {
        if (registrationBtnWrap) {
            registrationBtnWrap.style.display = 'inline-flex';
            registrationBtnWrap.style.visibility = 'visible';
        }
        if (adminPanel) adminPanel.style.display = 'none';
        if (registrationBtn && !registrationBtn._bound) {
            registrationBtn._bound = true;
            registrationBtn.addEventListener('click', function () {
                if (!adminPanel) return;
                var myApps = document.querySelector('.my-apps-section');
                var uploadPage = document.querySelector('.upload-page');
                var manualReviewPage = document.querySelector('.manual-review-page');
                if (myApps) myApps.style.display = 'none';
                if (uploadPage) uploadPage.style.display = 'none';
                if (manualReviewPage) manualReviewPage.style.display = 'none';
                ensureAdminRegistrationPanelContent(adminPanel);
                adminPanel.style.display = 'block';
                loadAdminRequests();
                adminPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    } else {
        if (registrationBtnWrap) registrationBtnWrap.style.display = 'none';
        if (adminPanel) adminPanel.style.display = 'none';
    }
}

function ensureAdminRegistrationPanelContent(panel) {
    if (!panel || panel.querySelector('#adminRequestsList')) return;
    panel.innerHTML = [
        '<div class="my-apps-banner admin-registration-banner">',
        '  <button type="button" class="list-view-btn admin-back-btn" id="adminRegistrationBackBtn" aria-label="Back to home">',
        '    <span style="margin-right: 6px;">←</span> Back',
        '  </button>',
        '  <h2 class="my-apps-title">Registration Requests</h2>',
        '  <button type="button" class="list-view-btn" id="adminRefreshRequestsBtn">Refresh</button>',
        '</div>',
        '<p id="adminRequestsEmpty" class="admin-requests-empty">No pending requests.</p>',
        '<div id="adminRequestsList" class="admin-requests-list"></div>'
    ].join('');
    const backBtn = document.getElementById('adminRegistrationBackBtn');
    if (backBtn && !backBtn._bound) {
        backBtn._bound = true;
        backBtn.addEventListener('click', function () {
            var p = document.getElementById('adminRegistrationPanel');
            if (p) p.style.display = 'none';
            var myApps = document.querySelector('.my-apps-section');
            var uploadPage = document.querySelector('.upload-page');
            var manualReviewPage = document.querySelector('.manual-review-page');
            if (myApps) myApps.style.display = 'block';
            if (uploadPage) uploadPage.style.display = 'none';
            if (manualReviewPage) manualReviewPage.style.display = 'none';
            try {
                sessionStorage.setItem('salmon_last_view', 'homepage');
            } catch (e) {}
        });
    }
    const refreshBtn = document.getElementById('adminRefreshRequestsBtn');
    if (refreshBtn && !refreshBtn._bound) {
        refreshBtn._bound = true;
        refreshBtn.addEventListener('click', loadAdminRequests);
    }
}

async function loadAdminRequests() {
    const listEl = document.getElementById('adminRequestsList');
    const emptyEl = document.getElementById('adminRequestsEmpty');
    if (!listEl || !emptyEl) return;
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    try {
        const res = await apiFetch('/api/admin/requests', { method: 'GET' });
        const data = await res.json();
        if (!res.ok || !data || !data.success) {
            emptyEl.textContent = 'Failed to load requests.';
            return;
        }
        const requests = data.requests || [];
        if (requests.length === 0) {
            emptyEl.textContent = 'No pending requests.';
            return;
        }
        emptyEl.style.display = 'none';
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Reason</th><th>Created</th><th>Actions</th></tr></thead><tbody></tbody>';
        const tbody = table.querySelector('tbody');
        requests.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${r.username || ''}</td><td>${r.email || ''}</td><td>${r.role || ''}</td><td>${r.reason || ''}</td><td>${r.createdAt || ''}</td><td><button type="button" class="btn-approve" data-request-id="${r.id}">Approve</button> <button type="button" class="btn-reject" data-request-id="${r.id}">Reject</button></td>`;
            const approveBtn = tr.querySelector('.btn-approve');
            const rejectBtn = tr.querySelector('.btn-reject');
            if (approveBtn) {
                approveBtn.addEventListener('click', function () {
                    approveRequest(this.dataset.requestId);
                });
            }
            if (rejectBtn) {
                rejectBtn.addEventListener('click', function () {
                    rejectRequest(this.dataset.requestId);
                });
            }
            tbody.appendChild(tr);
        });
        listEl.appendChild(table);
    } catch (err) {
        emptyEl.textContent = 'Error loading requests.';
    }
}

async function approveRequest(id) {
    if (!id) return;
    try {
        const res = await apiFetch(`/api/admin/approve/${id}`, { method: 'POST' });
        const data = await res.json();
        if (res.ok && data && data.success) {
            loadAdminRequests();
        } else {
            alert((data && data.error) || 'Approve failed');
        }
    } catch (err) {
        alert('Approve failed');
    }
}

async function rejectRequest(id) {
    if (!id) return;
    try {
        const res = await apiFetch(`/api/admin/reject/${id}`, { method: 'POST' });
        const data = await res.json();
        if (res.ok && data && data.success) {
            loadAdminRequests();
        } else {
            alert((data && data.error) || 'Reject failed');
        }
    } catch (err) {
        alert('Reject failed');
    }
}

function getBaseUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    const authPaths = ['/api/login', '/api/logout', '/api/register', '/api/signup', '/api/me', '/api/admin'];
    const useAuth = authPaths.some(p => path.startsWith(p));
    return (useAuth ? AUTH_BASE : API_BASE) + path;
}

async function apiFetch(path, options = {}) {
    const url = getBaseUrl(path);
    const headers = new Headers(options.headers || {});
    const token = getToken();

    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
    }
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
        // Only clear session when our auth endpoints reject (e.g. token invalid). Do NOT clear when proxy/upstream returns 401 (e.g. /api/predict).
        var authOnlyPaths = ['/api/me', '/api/login', '/api/logout', '/api/register', '/api/signup', '/api/admin'];
        var isAuthEndpoint = authOnlyPaths.some(function (p) { return url.indexOf(p) !== -1; });
        if (isAuthEndpoint) {
            clearToken();
            showLoginGate(true);
        }
        throw new Error('Unauthorized');
    }
    return response;
}

window.apiFetch = apiFetch;

async function checkSession() {
    const token = getToken();
    if (!token) {
        showLoginGate(true);
        return;
    }
    try {
        const response = await apiFetch('/api/me', { method: 'GET' });
        if (!response.ok) throw new Error('Session invalid');
        const me = await response.json();
        const meUser = (me && me.user) || {};
        setWelcomeUser(meUser.username || '');
        const isAdmin = !!(meUser.isAdmin || (meUser.username && String(meUser.username).toLowerCase() === 'admin'));
        applyRoleHomeAccess(meUser.role || '', isAdmin);
        await syncManualReviewNotificationFromBackend();
        showLoginGate(false);
        if (isAdmin) {
            requestAnimationFrame(function() {
                var wrap = document.getElementById('adminRegistrationBtnWrap');
                if (wrap) { wrap.style.display = 'inline-flex'; wrap.style.visibility = 'visible'; }
            });
        }
    } catch (err) {
        clearToken();
        showLoginGate(true);
    }
}

function bindLoginGate() {
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    const authCardOptions = document.getElementById('authCardOptions');
    const authTitle = document.getElementById('authTitle');
    const authSubtitle = document.getElementById('authSubtitle');
    const btnShowSignIn = document.getElementById('btnShowSignIn');
    const showSignupBtn = document.getElementById('showSignupBtn');
    const showLoginBtn = document.getElementById('showLoginBtn');
    const authBackToLoginHome = document.getElementById('authBackToLoginHome');
    const logoutBtn = document.getElementById('logoutBtn');

    const showOptionsView = () => {
        if (authCardOptions) authCardOptions.style.display = '';
        if (loginForm) loginForm.style.display = 'none';
        if (signupForm) signupForm.style.display = 'none';
        if (authTitle) authTitle.textContent = 'Welcome';
        if (authSubtitle) authSubtitle.textContent = "Choose how you'd like to sign in below:";
        setLoginError('');
        setSignupError('');
    };

    const showLoginFormView = () => {
        if (authCardOptions) authCardOptions.style.display = 'none';
        if (loginForm) loginForm.style.display = 'block';
        if (signupForm) signupForm.style.display = 'none';
        if (authTitle) authTitle.textContent = 'Welcome';
        if (authSubtitle) authSubtitle.textContent = 'Sign in with your account.';
        setLoginError('');
        setSignupError('');
    };

    const showSignupFormView = () => {
        if (authCardOptions) authCardOptions.style.display = 'none';
        if (loginForm) loginForm.style.display = 'none';
        if (signupForm) signupForm.style.display = 'block';
        if (authTitle) authTitle.textContent = 'Create account';
        if (authSubtitle) authSubtitle.textContent = 'Create a new account to access the app.';
        setLoginError('');
        setSignupError('');
    };

    if (btnShowSignIn) btnShowSignIn.addEventListener('click', showLoginFormView);
    if (showSignupBtn) showSignupBtn.addEventListener('click', showSignupFormView);
    if (showLoginBtn) showLoginBtn.addEventListener('click', showLoginFormView);
    if (authBackToLoginHome) {
        authBackToLoginHome.addEventListener('click', function(e) {
            e.preventDefault();
            showOptionsView();
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async function() {
            try {
                await apiFetch('/api/logout', { method: 'POST' });
            } catch (_) {
                // Ignore logout network errors; we clear local session regardless.
            } finally {
                clearToken();
                showLoginGate(true);
                showOptionsView();
            }
        });
    }

    const usernameEl = document.getElementById('loginUsername');
    const passwordEl = document.getElementById('loginPassword');
    if (!usernameEl || !passwordEl) return;

    const submitLogin = async () => {
        const username = (usernameEl.value || '').trim();
        const password = passwordEl.value || '';
        if (!username || !password) {
            setLoginError('Please enter username and password.');
            return;
        }
        setLoginError('');

        try {
            const response = await apiFetch('/api/login', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });
            let data;
            try {
                data = await response.json();
            } catch (_) {
                setLoginError('Invalid response from server.');
                return;
            }
            const token = (data && (data.token || data.accessToken || data.access_token)) || '';
            if (!response.ok || !data || !data.success || !token) {
                setLoginError((data && data.error) || 'Login failed');
                return;
            }
            setToken(token);
            const loginUser = (data && data.user) || {};
            setWelcomeUser(loginUser.username || username);
            // Treat username 'admin' as admin even if backend omits isAdmin
            const isAdmin = !!(loginUser.isAdmin || (loginUser.username && String(loginUser.username).toLowerCase() === 'admin'));
            applyRoleHomeAccess(loginUser.role || '', isAdmin);
            await syncManualReviewNotificationFromBackend();
            showLoginGate(false);
            if (isAdmin) {
                requestAnimationFrame(function() {
                    var wrap = document.getElementById('adminRegistrationBtnWrap');
                    if (wrap) {
                        wrap.style.display = 'inline-flex';
                        wrap.style.visibility = 'visible';
                    }
                });
            }
            if (!integrationStarted) {
                initIntegration();
                integrationStarted = true;
            }
        } catch (err) {
            const msg = err && err.message;
            if (msg === 'Unauthorized') setLoginError('Invalid username or password.');
            else if (/failed to fetch|network|load/i.test(msg || '')) setLoginError(isLocal ? 'Cannot reach server. Check that backend is running on port 4000 and CORS is enabled.' : 'Cannot reach server. Please check your connection.');
            else setLoginError(msg || 'Login failed');
        }
    };

    if (loginForm) {
        loginForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            await submitLogin();
        });
    }

    if (signupForm) {
        signupForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const signupEmail = document.getElementById('signupEmail');
            const signupUsername = document.getElementById('signupUsername');
            const signupPassword = document.getElementById('signupPassword');
            const signupConfirmPassword = document.getElementById('signupConfirmPassword');
            const signupRole = document.getElementById('signupRole');
            const signupReason = document.getElementById('signupReason');

            const email = signupEmail ? (signupEmail.value || '').trim() : '';
            const username = signupUsername ? (signupUsername.value || '').trim() : '';
            const password = signupPassword ? signupPassword.value || '' : '';
            const confirmPassword = signupConfirmPassword ? signupConfirmPassword.value || '' : '';
            const role = signupRole ? signupRole.value || 'technician' : 'technician';
            const reason = signupReason ? (signupReason.value || '').trim() : '';

            if (!email || !username || !password) {
                setSignupError('Please complete all required fields.');
                return;
            }
            if (password !== confirmPassword) {
                setSignupError('Passwords do not match.');
                return;
            }
            setSignupError('');
            try {
                const response = await apiFetch('/api/signup', {
                    method: 'POST',
                    body: JSON.stringify({ email, username, password, role, reason })
                });
                const data = await response.json();
                if (!response.ok || !data || !data.success) {
                    setSignupError((data && data.error) || 'Create account failed');
                    return;
                }
                setSignupError('');
                showLoginFormView();
                setLoginError((data && data.message) || 'Registration submitted. Awaiting admin approval. You can sign in after an administrator approves your account.');
            } catch (err) {
                setSignupError(err.message === 'Unauthorized' ? 'Unauthorized' : 'Create account failed');
            }
        });
    }

    showOptionsView();
}

// State management
let currentFiles = [];
let isBackendEnabled = false;
let validatedZipFile = null; // Store validated ZIP file for analysis
const API_GATEWAY_SAFE_BYTES = 100 * 1024 * 1024; // 100MB - matches local validation limit

// Expose to window for cache clearing (will be set when files are selected/validated)
window.validatedZipFile = null;
window.currentFiles = [];

function setUploadStatus(message, variant = 'error') {
    const status = document.getElementById('uploadStatus');
    if (!status) return;
    status.textContent = message;
    status.className = `upload-status upload-status--${variant}`;
    status.style.display = 'block';
}

function clearUploadStatus() {
    const status = document.getElementById('uploadStatus');
    if (!status) return;
    status.textContent = '';
    status.style.display = 'none';
}

/**
 * Initialize integration
 */
function initIntegration() {
    console.log('Initializing Salmon Say Integration...');
    
    // 1. Provide handleFiles for batch validation
    window.handleFiles = function(files) {
        const list = Array.from(files);
        clearUploadStatus();
        if (list.length > 1) {
            setUploadStatus('Please upload only one ZIP file at a time.', 'error');
        }
        currentFiles = list.slice(0, 1);
        window.currentFiles = currentFiles;
        console.log('Selected file size (bytes):', currentFiles[0]?.size);
        
        // Only check API Gateway limit if backend is enabled
        // For local validation, the limit is checked in validateLocally function (100MB)
        if (isBackendEnabled) {
            const oversized = currentFiles.filter(file => file.size > API_GATEWAY_SAFE_BYTES);
            if (oversized.length > 0) {
                setUploadStatus(
                    'File is too large for API Gateway upload (maximum size: 100MB). ' +
                    'Please use a smaller ZIP file or switch to local validation mode.',
                    'error'
                );
                return;
            }
        }
        console.log('Files intercepted:', currentFiles);
        
        // Show file info in the UI if needed
        const fileInfo = document.getElementById('fileInfo');
        if (fileInfo) {
            fileInfo.textContent = `Selected: ${currentFiles.map(f => f.name).join(', ')}`;
            fileInfo.style.display = 'block';
        }
        
        // If it's a single image, we might want to offer Quick Check
        const firstFile = currentFiles[0];
        if (firstFile && firstFile.type.startsWith('image/')) {
            console.log('Single image detected, ready for Quick Check');
        }
        
        // Continue with upload flow
        if (window.uploadFiles) {
            window.uploadFiles(currentFiles);
        }
    };

    // 2. Provide uploadFiles for Lambda validation
    window.uploadFiles = async function(files) {
        console.log('Uploading to Validation Lambda...', files);
        
        const uploadPanel = document.getElementById('uploadPanel');
        const progressPanel = document.getElementById('uploadProgressPanel');
        const progressFill = document.getElementById('uploadProgressFill');
        const progressPercent = document.getElementById('uploadProgressPercent');
        const progressFilename = document.getElementById('uploadProgressFilename');
        const progressSize = document.getElementById('uploadProgressSize');
        
        if (uploadPanel) uploadPanel.style.display = 'none';
        if (progressPanel) progressPanel.style.display = 'flex';

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                // Show real file info
                if (progressFilename) progressFilename.textContent = file.name;
                if (progressSize) progressSize.textContent = (file.size / 1024 / 1024).toFixed(1) + ' MB';
                if (progressFill) progressFill.style.width = '0%';
                if (progressPercent) progressPercent.textContent = '0%';
                setUploadStatus('Validating file. Please wait...', 'success');
                clearUploadStatus();

                // Progress callback — updates bar in real time as JSZip parses the file
                const onProgress = (pct) => {
                    const rounded = Math.round(pct);
                    if (progressFill) progressFill.style.width = rounded + '%';
                    if (progressPercent) progressPercent.textContent = rounded + '%';
                };

                const report = isBackendEnabled
                    ? await validateWithLambda(file)
                    : await validateLocally(file, onProgress);

                // Jump to 100% on completion
                if (progressFill) progressFill.style.width = '100%';
                if (progressPercent) progressPercent.textContent = '100%';
                console.log('Validation Report:', report);
                
                if (report.status === 'PASS') {
                    // Store validated file for analysis
                    validatedZipFile = file;
                    window.validatedZipFile = file;
                    showSuccess(report);
                    setUploadStatus('Validation passed. Click "Start Analysis" to send images to the AI model.', 'success');
                } else {
                    validatedZipFile = null;
                    window.validatedZipFile = null;
                    showFailure(report);
                }
            } catch (error) {
                console.error('Upload error:', error);
                setUploadStatus(`Validation error: ${error.message}`, 'error');
            }
        }
    };

    // 3. Add Quick Check Logic
    setupQuickCheckUI('quickCheckPanel');
    setupQuickCheckUI('manualQuickCheckPanel');

    // 4. Inference button (placeholder until model API is connected)
    setupInferenceButton();

    // 5. Toggle between Batch Upload and Quick Check
    setupModeToggle();

    // 6. Start Analysis button in success panel
    setupStartAnalysisButton();

    // 7. History Result functionality (only on Upload Scale; Review Scales uses this same view via menu)
    setupHistoryResult();
}

/**
 * Call Validation Lambda
 */
async function validateWithLambda(file) {
    const formData = new FormData();
    formData.append('zipFile', file);
    formData.append('userId', window.currentUsername || ''); // From logged-in user

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
        const response = await fetch(CONFIG.VALIDATION_API_URL, {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Validation request timed out after 60s.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function validateLocally(file, onProgress) {
    const issues = [];
    const maxSize = 500 * 1024 * 1024; // 500MB — matches Nginx client_max_body_size
    const warnSize = 200 * 1024 * 1024; // 200MB soft warning
    const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);

    if (!file.name.toLowerCase().endsWith('.zip')) {
        issues.push({ severity: 'error', message: 'File must be in ZIP format', code: 'INVALID_FORMAT' });
    }
    if (file.size > maxSize) {
        issues.push({ severity: 'error', message: `File size ${fileSizeMB} MB exceeds the 500 MB limit`, code: 'FILE_TOO_LARGE' });
    }
    if (issues.length > 0) {
        return { status: 'FAIL', issues };
    }

    if (!window.JSZip) {
        throw new Error('JSZip not loaded. Please refresh the page.');
    }

    // Phase 1 (0–70%): Read file bytes off disk — real FileReader progress
    const arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress((e.loaded / e.total) * 70);
            }
        };
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('File read error'));
        reader.readAsArrayBuffer(file);
    });
    if (onProgress) onProgress(75);

    // Phase 2 (75–90%): Parse ZIP structure
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    if (onProgress) onProgress(90);
    const fileNames = Object.keys(zip.files);
    const actualFiles = fileNames.filter(name => {
        const f = zip.files[name];
        if (f.dir || name.endsWith('/')) return false;
        if (name.includes('__MACOSX') || name.includes('.DS_Store')) return false;
        return true;
    });

    const csvFiles = actualFiles.filter(name => name.toLowerCase().endsWith('.csv'));
    const tiffFiles = actualFiles.filter(name => {
        const lower = name.toLowerCase();
        return lower.endsWith('.tiff') || lower.endsWith('.tif');
    });

    if (csvFiles.length === 0) {
        issues.push({ severity: 'error', message: 'No CSV file found in ZIP', code: 'NO_CSV_FILE' });
    } else if (csvFiles.length > 1) {
        issues.push({ severity: 'error', message: `Multiple CSV files found (${csvFiles.length})`, code: 'MULTIPLE_CSV_FILES' });
    }
    if (tiffFiles.length === 0) {
        issues.push({ severity: 'error', message: 'No TIFF files found in ZIP', code: 'NO_TIFF_FILES' });
    }
    if (issues.length > 0) {
        return { status: 'FAIL', issues };
    }

    const csvFileName = csvFiles[0];
    const csvFile = zip.files[csvFileName];
    const csvContent = await csvFile.async('string');
    if (!csvContent.trim()) {
        return { status: 'FAIL', issues: [{ severity: 'error', message: 'CSV file is empty', code: 'EMPTY_CSV' }] };
    }

    const lines = csvContent.split(/\r?\n/).filter(line => line.trim().length > 0);
    const dataLines = lines.slice(1);
    const csvSecondColumnNames = new Set();
    for (const line of dataLines) {
        if (!line.trim()) continue;
        let secondColumn = '';
        if (line.trim().startsWith('"')) {
            const columns = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char === '"' && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (!inQuotes && char === ',') {
                    columns.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            columns.push(current.trim());
            secondColumn = (columns[1] || '').trim();
        } else {
            const separator = line.includes(',') ? ',' : (line.includes('\t') ? '\t' : ',');
            const columns = line.split(separator).map(value => value.trim());
            secondColumn = (columns[1] || '').trim();
        }
        if (secondColumn) csvSecondColumnNames.add(secondColumn);
    }

    const tiffNames = new Set();
    for (const tiffPath of tiffFiles) {
        const fileName = tiffPath.split('/').pop() || tiffPath;
        const nameWithoutExt = fileName.replace(/\.(tiff|tif)$/i, '');
        tiffNames.add(nameWithoutExt);
    }

    const csvNamesNotInTiff = [];
    const tiffNamesNotInCsv = [];
    for (const csvName of csvSecondColumnNames) {
        if (!tiffNames.has(csvName)) {
            csvNamesNotInTiff.push(csvName);
        }
    }
    for (const tiffName of tiffNames) {
        if (!csvSecondColumnNames.has(tiffName)) {
            tiffNamesNotInCsv.push(tiffName);
        }
    }

    if (csvNamesNotInTiff.length > 0) {
        issues.push({
            severity: 'error',
            message: `CSV second column names not found in TIFF files: ${csvNamesNotInTiff.slice(0, 10).join(', ')}${csvNamesNotInTiff.length > 10 ? '...' : ''}`,
            code: 'CSV_NAMES_NOT_IN_TIFF'
        });
    }
    if (tiffNamesNotInCsv.length > 0) {
        issues.push({
            severity: 'error',
            message: `TIFF names not found in CSV second column: ${tiffNamesNotInCsv.slice(0, 10).join(', ')}${tiffNamesNotInCsv.length > 10 ? '...' : ''}`,
            code: 'TIFF_NAMES_NOT_IN_CSV'
        });
    }

    const warnings = [];
    if (tiffFiles.length > 30) {
        const estMinutes = Math.ceil(tiffFiles.length * 10 / 60);
        warnings.push(`Large batch: ${tiffFiles.length} images detected. Analysis may take ~${estMinutes} minutes.`);
    }
    if (file.size > warnSize) {
        warnings.push(`Large file: ${fileSizeMB} MB. Validation may be slow.`);
    }

    return {
        status: issues.length === 0 ? 'PASS' : 'FAIL',
        issues,
        warnings,
        imageCount: tiffFiles.length,
        fileSizeMB
    };
}

/**
 * Call Prediction API (Flask)
 */
async function predictFish(imageFile, sex = 2, fl = 60, options = {}) {
    const { preview = false } = options || {};
    // Convert image to base64
    const base64Image = await fileToBase64(imageFile);
    const apiUrl = preview ? CONFIG.PREDICTION_PREVIEW_API_URL : CONFIG.PREDICTION_API_URL;
    
    const response = await apiFetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            image: base64Image,
            sex: sex,
            fl: fl,
            filename: imageFile.name || null  // Pass filename so backend uses it as image_id
        })
    });

    if (!response.ok) {
        throw new Error(`Prediction failed: ${response.status}`);
    }

    return await response.json();
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const base64String = reader.result.split(',')[1];
            resolve(base64String);
        };
        reader.onerror = error => reject(error);
    });
}

function showSuccess(report) {
    const progressPanel = document.getElementById('uploadProgressPanel');
    const successPanel = document.getElementById('uploadSuccessPanel');
    const analysisStatus = document.getElementById('analysisStatus');
    if (progressPanel) progressPanel.style.display = 'none';
    if (successPanel) successPanel.style.display = 'flex';
    if (analysisStatus) analysisStatus.style.display = 'none';

    // Reset panel to upload-success state
    const titleEl = document.getElementById('successPanelTitle');
    const messageEl = document.getElementById('successPanelMessage');
    const progressFill = document.getElementById('successProgressFill');
    const progressPercent = document.getElementById('successProgressPercent');
    const startBtn = document.getElementById('startAnalysisBtn');
    if (titleEl) titleEl.innerHTML = 'File validated successfully!';

    // Build info line: image count + file size + estimated time
    const imageCount = report.imageCount || 0;
    const fileSizeMB = report.fileSizeMB || '?';
    const estSeconds = imageCount * 10;
    const estStr = estSeconds >= 60
        ? `~${Math.ceil(estSeconds / 60)} min`
        : `~${estSeconds} sec`;
    let infoText = imageCount > 0
        ? `${imageCount} image${imageCount > 1 ? 's' : ''} · ${fileSizeMB} MB · Estimated analysis time: ${estStr}`
        : `${fileSizeMB} MB · Validation complete.`;

    // Append any warnings
    if (report.warnings && report.warnings.length > 0) {
        infoText += '\n⚠ ' + report.warnings.join('\n⚠ ');
    }

    if (messageEl) messageEl.textContent = infoText;
    if (progressFill) { progressFill.style.width = '100%'; progressFill.style.background = ''; }
    if (progressPercent) progressPercent.textContent = '100%';
    if (startBtn) startBtn.disabled = false;

    console.log('Success! S3 Path:', report.metadata?.s3Path);
}

function showFailure(report) {
    const msg = report.issues.map(is => is.message).join('\n');
    setUploadStatus(`Validation failed: ${msg}`, 'error');
    // Reset UI
    const progressPanel = document.getElementById('uploadProgressPanel');
    const uploadPanel = document.getElementById('uploadPanel');
    if (progressPanel) progressPanel.style.display = 'none';
    if (uploadPanel) uploadPanel.style.display = 'flex';
}

// Function to clear quick check cache (form data and results)
function clearQuickCheckCache(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    const quickGroups = panel.querySelector('[data-quick-groups]');
    const quickCheckResultList = panel.querySelector('[data-quick-result]');
    const quickCheckResultWrap = panel.querySelector('[data-quick-result-wrap]');
    const quickCheckResultError = panel.querySelector('[data-quick-result-error]');
    const quickCheckBtn = panel.querySelector('[data-quick-run]');

    if (panel._quickCheckPayloads) panel._quickCheckPayloads = [];
    if (panel._quickCheckResults) panel._quickCheckResults = [];

    if (quickCheckResultList) quickCheckResultList.innerHTML = '';
    if (quickCheckResultWrap) quickCheckResultWrap.style.display = 'none';
    if (quickCheckResultError) { quickCheckResultError.textContent = ''; quickCheckResultError.style.display = 'none'; }

    // Reset button state
    if (quickCheckBtn) {
        quickCheckBtn.disabled = false;
        quickCheckBtn.textContent = 'RUN QUICK CHECK';
    }

    // Clear all groups except the first one
    if (quickGroups) {
        const groups = quickGroups.querySelectorAll('.quick-check-group');
        // Remove all groups except the first
        for (let i = groups.length - 1; i > 0; i--) {
            groups[i].remove();
        }
        
        // Reset the first group's inputs
        const firstGroup = quickGroups.querySelector('.quick-check-group');
        if (firstGroup) {
            const sexEl = firstGroup.querySelector('.quick-sex');
            const flEl = firstGroup.querySelector('.quick-fork-length');
            const fileEl = firstGroup.querySelector('.quick-image');
            
            if (sexEl) sexEl.value = '';
            if (flEl) flEl.value = '';
            if (fileEl) fileEl.value = ''; // Clear file input
        }
    }
}

function setupQuickCheckUI(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    const quickCheckBtn = panel.querySelector('[data-quick-run]');
    const quickAddBtn = panel.querySelector('[data-quick-add]');
    const quickGroups = panel.querySelector('[data-quick-groups]');
    const quickCheckResultWrap = panel.querySelector('[data-quick-result-wrap]');
    const quickCheckResultList = panel.querySelector('[data-quick-result]');
    const quickCheckResultError = panel.querySelector('[data-quick-result-error]');
    const quickResultSelectAll = panel.querySelector('[data-quick-select-all]');
    const quickCommitSelectedBtn = panel.querySelector('[data-quick-commit-selected]');

    if (!quickCheckBtn || !quickAddBtn || !quickGroups || !quickCheckResultList) {
        console.warn('Quick Check UI not found in DOM');
        return;
    }

    quickAddBtn.addEventListener('click', () => {
        const group = document.createElement('div');
        group.className = 'quick-check-group';
        group.innerHTML = `
            <div class="quick-check-field">
                <label>Sex</label>
                <select class="quick-sex">
                    <option value="">Select</option>
                    <option value="2">Unknown</option>
                    <option value="0">Male</option>
                    <option value="1">Female</option>
                </select>
            </div>
            <div class="quick-check-field">
                <label>Fork Length (cm)</label>
                <input type="number" class="quick-fork-length" placeholder="e.g. 60" />
            </div>
            <div class="quick-check-field">
                <label>TIFF Image</label>
                <input type="file" class="quick-image" accept=".tif,.tiff,image/tiff" />
            </div>
            <label class="quick-group-commit-wrap"><input type="checkbox" class="quick-group-commit-cb"> Select</label>
            <button type="button" class="quick-remove-btn" title="Remove this row">&times;</button>
        `;
        quickGroups.appendChild(group);
        updateQuickCheckRemoveButtons();
        updateQuickCheckCommitBar();
    });

    function updateQuickCheckRemoveButtons() {
        const groups = quickGroups.querySelectorAll('.quick-check-group');
        const onlyOne = groups.length <= 1;
        groups.forEach(g => {
            const btn = g.querySelector('.quick-remove-btn');
            if (btn) btn.disabled = onlyOne;
        });
    }

    function showQuickCheckError(msg) {
        if (quickCheckResultWrap) quickCheckResultWrap.style.display = 'none';
        if (quickCheckResultError) {
            quickCheckResultError.textContent = msg;
            quickCheckResultError.style.display = 'block';
        }
    }

    function hideQuickCheckError() {
        if (quickCheckResultError) quickCheckResultError.style.display = 'none';
    }

    function buildQuickCheckPayloads() {
        const groups = Array.from(quickGroups.querySelectorAll('.quick-check-group'));
        if (groups.length === 0) {
            showQuickCheckError('Please add a quick check group.');
            return null;
        }

        const payloads = [];
        for (const group of groups) {
            const sexEl = group.querySelector('.quick-sex');
            const flEl = group.querySelector('.quick-fork-length');
            const fileEl = group.querySelector('.quick-image');
            const file = fileEl && fileEl.files && fileEl.files[0];

            if (!sexEl || !sexEl.value) {
                showQuickCheckError('Please select Sex for all quick check groups.');
                return null;
            }
            if (!flEl || !flEl.value) {
                showQuickCheckError('Please enter Fork Length for all quick check groups.');
                return null;
            }
            if (!file) {
                showQuickCheckError('Please upload a TIFF image for each quick check group.');
                return null;
            }
            const nameLower = file.name.toLowerCase();
            if (!(nameLower.endsWith('.tif') || nameLower.endsWith('.tiff'))) {
                showQuickCheckError('Only TIFF images are allowed for Quick Check.');
                return null;
            }

            payloads.push({
                file,
                sex: parseInt(sexEl.value, 10),
                fl: parseFloat(flEl.value)
            });
        }

        return payloads;
    }

    function updateQuickCheckCommitBar() {
        if (!quickCommitSelectedBtn) return;
        const countSpan = panel.querySelector('.quick-commit-count');
        const checkboxes = panel.querySelectorAll('.quick-group-commit-cb');
        const checked = panel.querySelectorAll('.quick-group-commit-cb:checked');
        const n = checkboxes.length;
        const count = checked.length;
        if (countSpan) countSpan.textContent = count;
        quickCommitSelectedBtn.disabled = count === 0;
        if (quickResultSelectAll) {
            quickResultSelectAll.checked = n > 0 && count === n;
            quickResultSelectAll.indeterminate = count > 0 && count < n;
        }
    }

    function buildPayloadsFromCheckedGroups() {
        const groups = Array.from(quickGroups.querySelectorAll('.quick-check-group'));
        const payloads = [];
        for (const group of groups) {
            const cb = group.querySelector('.quick-group-commit-cb');
            if (!cb || !cb.checked) continue;
            const sexEl = group.querySelector('.quick-sex');
            const flEl = group.querySelector('.quick-fork-length');
            const fileEl = group.querySelector('.quick-image');
            const file = fileEl && fileEl.files && fileEl.files[0];
            if (!sexEl || !sexEl.value) {
                showQuickCheckError('Please select Sex for all selected rows.');
                return null;
            }
            if (!flEl || !flEl.value) {
                showQuickCheckError('Please enter Fork Length for all selected rows.');
                return null;
            }
            if (!file) {
                showQuickCheckError('Please upload a TIFF image for all selected rows.');
                return null;
            }
            const nameLower = file.name.toLowerCase();
            if (!(nameLower.endsWith('.tif') || nameLower.endsWith('.tiff'))) {
                showQuickCheckError('Only TIFF images are allowed.');
                return null;
            }
            payloads.push({ file, sex: parseInt(sexEl.value, 10), fl: parseFloat(flEl.value) });
        }
        return payloads;
    }

    quickCheckBtn.addEventListener('click', async function () {
        const payloads = buildQuickCheckPayloads();
        if (!payloads) {
            return;
        }

        const shouldContinue = await confirmDuplicateImageIdsBeforeUpload(
            payloads.map(p => ({ filename: p.file && p.file.name ? p.file.name : '' }))
        );
        if (!shouldContinue) {
            showQuickCheckError('Quick Check cancelled because duplicate image IDs were detected.');
            return;
        }

        quickCheckBtn.disabled = true;
        quickCheckBtn.textContent = 'RUNNING...';
        hideQuickCheckError();
        if (quickCheckResultWrap) quickCheckResultWrap.style.display = 'none';

        try {
            const results = [];
            for (const payload of payloads) {
                const result = await predictFish(payload.file, payload.sex, payload.fl, { preview: false });
                results.push(result);
            }
            if (quickCheckResultList && quickCheckResultWrap) {
                quickCheckResultList.innerHTML = results.map((result, idx) => {
                    const confidence = (result.confidence * 100).toFixed(1);
                    return `<div class="quick-check-result-item"><strong>Result ${idx + 1}:</strong> ${result.class_name} (${confidence}%)</div>`;
                }).join('');
                quickCheckResultWrap.style.display = 'block';
            }
        } catch (err) {
            console.error('Quick Check failed:', err);
            let msg = 'Quick Check failed. ';
            if (err && err.message) {
                if (err.message.includes('401')) msg += 'Please log in first.';
                else if (err.message.includes('500') || err.message.includes('502')) msg += 'Server error. Check backend logs.';
                else if (err.message.includes('fetch') || err.message.includes('Network')) msg += 'Cannot reach backend or CORS error.';
                else msg += err.message;
            } else msg += 'Prediction API not connected or invalid input.';
            showQuickCheckError(msg);
        } finally {
            quickCheckBtn.disabled = false;
            quickCheckBtn.textContent = 'RUN QUICK CHECK';
        }
    });

    if (quickResultSelectAll) {
        quickResultSelectAll.addEventListener('change', function () {
            panel.querySelectorAll('.quick-group-commit-cb').forEach(cb => { cb.checked = quickResultSelectAll.checked; });
            updateQuickCheckCommitBar();
        });
    }
    quickGroups.addEventListener('change', function (e) {
        if (e.target.classList.contains('quick-group-commit-cb')) updateQuickCheckCommitBar();
    });
    if (quickCommitSelectedBtn) {
        quickCommitSelectedBtn.addEventListener('click', async function () {
            const payloads = buildPayloadsFromCheckedGroups();
            if (!payloads || payloads.length === 0) {
                showQuickCheckError('Select at least one row and fill Sex, Fork Length, and TIFF.');
                return;
            }
            const shouldContinue = await confirmDuplicateImageIdsBeforeUpload(
                payloads.map(p => ({ filename: p.file && p.file.name ? p.file.name : '' }))
            );
            if (!shouldContinue) {
                showQuickCheckError('Commit cancelled: duplicate image IDs detected.');
                return;
            }
            quickCommitSelectedBtn.disabled = true;
            quickCommitSelectedBtn.innerHTML = 'Committing...';
            hideQuickCheckError();

            try {
                const imagesToSubmit = [];
                const newItems = [];
                for (const p of payloads) {
                    const result = await predictFish(p.file, p.sex, p.fl, { preview: false });
                    if (result && result.job_id && result.image_id) {
                        imagesToSubmit.push({ job_id: result.job_id, image_id: result.image_id });
                        const now = new Date().toISOString();
                        const nowMs = Date.now();
                        newItems.push({
                            cardNumber: toCardNumber(result.image_id),
                            scaleId: result.scale_id || '—',
                            imageId: result.image_id || '—',
                            location: 'Kalama',
                            uploadDate: formatManualReviewDate(now),
                            operatorName: window.currentUsername || '',
                            reviewerName: '',
                            manualReadOrigin: '',
                            originalData: { job_id: result.job_id, image_id: result.image_id, created_at: now, updated_at: now, _committedAtMs: nowMs, user_id: window.currentUsername }
                        });
                    }
                }
                if (imagesToSubmit.length > 0 && typeof apiFetch === 'function') {
                    try {
                        await apiFetch('/api/submit-to-lab', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ images: imagesToSubmit })
                        });
                    } catch (submitErr) {
                        console.warn('submit-to-lab failed (items still saved):', submitErr);
                    }
                }
                if (newItems.length > 0) {
                    // Prepend so newest commit is at front, then sort by commit time
                    window.committedResults = newItems.concat(window.committedResults || []);
                    sortManualReviewByMostRecent(window.committedResults);
                    try {
                        const toSave = (window.committedResults || []).map(item => {
                            const copy = Object.assign({}, item);
                            if (copy.originalData) {
                                copy.originalData = Object.assign({}, copy.originalData);
                                delete copy.originalData.original_image;
                                delete copy.originalData.heatmap_image;
                            }
                            return copy;
                        });
                        localStorage.setItem('manualReviewCommittedResults', JSON.stringify(toSave));
                    } catch (e) { /* ignore */ }
                    if (typeof window.updateManualReviewNotification === 'function') window.updateManualReviewNotification();
                    if (typeof window.populateManualReviewTable === 'function') {
                        window.populateManualReviewTable(window.committedResults);
                    }
                    var manualReviewPanel = document.getElementById('manualReviewPanel');
                    if (manualReviewPanel && typeof window.filterManualReviewRows === 'function') {
                        var activeBtn = manualReviewPanel.querySelector('.result-filter-btn.result-filter-btn--active');
                        var filter = (activeBtn && activeBtn.getAttribute('data-filter')) || 'not-reviewed';
                        window.filterManualReviewRows(filter);
                    }
                }
                const committedCount = payloads.length;
                if (quickCheckResultList) {
                    quickCheckResultList.innerHTML = '<p class="quick-check-commit-msg">Committed ' + committedCount + ' to manual review.</p>';
                    if (quickCheckResultWrap) quickCheckResultWrap.style.display = 'block';
                    setTimeout(function () {
                        if (quickCheckResultList) quickCheckResultList.innerHTML = '';
                        if (quickCheckResultWrap) quickCheckResultWrap.style.display = 'none';
                    }, 4000);
                }
                panel.querySelectorAll('.quick-group-commit-cb:checked').forEach(cb => { cb.checked = false; });
                updateQuickCheckCommitBar();
            } catch (err) {
                console.error('Quick Check commit failed:', err);
                let msg = 'Commit failed. ';
                if (err && err.message) {
                    if (err.message.includes('404')) msg += 'Backend route not found.';
                    else if (err.message.includes('401')) msg += 'Please log in first.';
                    else msg += err.message;
                } else msg += 'Prediction API not connected or invalid input.';
                showQuickCheckError(msg);
            } finally {
                quickCommitSelectedBtn.innerHTML = 'Commit (<span class="quick-commit-count">0</span>)';
                updateQuickCheckCommitBar();
            }
        });
    }

    updateQuickCheckCommitBar();

    quickGroups.addEventListener('click', (event) => {
        const target = event.target;
        if (!target.classList.contains('quick-remove-btn') || target.disabled) return;
        const group = target.closest('.quick-check-group');
        if (!group) return;
        if (quickGroups.querySelectorAll('.quick-check-group').length <= 1) return;
        group.remove();
        updateQuickCheckRemoveButtons();
        updateQuickCheckCommitBar();
    });

    updateQuickCheckRemoveButtons();
}

// Expose clearQuickCheckCache to global scope
window.clearQuickCheckCache = clearQuickCheckCache;

function setupInferenceButton() {
    const runInferenceBtn = document.getElementById('runInferenceBtn');
    const inferenceStatus = document.getElementById('inferenceStatus');

    if (!runInferenceBtn || !inferenceStatus) {
        return;
    }

    runInferenceBtn.addEventListener('click', async function () {
        runInferenceBtn.disabled = true;
        inferenceStatus.style.display = 'block';
        inferenceStatus.textContent = 'Checking model API...';

        try {
            const response = await apiFetch(CONFIG.PREDICTION_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });

            if (!response.ok) {
                inferenceStatus.textContent = 'Model API is reachable, but inference data is not wired yet.';
                return;
            }

            inferenceStatus.textContent = 'Inference API is available. Wiring will be the next step.';
        } catch (err) {
            inferenceStatus.textContent = 'Inference API not connected. Please start predict_api.py.';
        } finally {
            runInferenceBtn.disabled = false;
        }
    });
}

function setupModeToggle() {
    const batchBtn = document.getElementById('batchModeBtn');
    const quickBtn = document.getElementById('quickModeBtn');
    const uploadPanel = document.getElementById('uploadPanel');
    const quickPanel = document.getElementById('quickCheckPanel');

    if (!batchBtn || !quickBtn || !uploadPanel || !quickPanel) return;

    const setActive = (mode) => {
        const progressPanel = document.getElementById('uploadProgressPanel');
        const successPanel = document.getElementById('uploadSuccessPanel');

        if (mode === 'batch') {
            // Clear Quick Check cache when switching to batch mode
            if (window.clearQuickCheckCache) {
                window.clearQuickCheckCache('quickCheckPanel');
            }
            // Reset progress/success panels so they don't bleed into batch view
            if (progressPanel) progressPanel.style.display = 'none';
            if (successPanel) successPanel.style.display = 'none';
            uploadPanel.style.display = 'flex';
            quickPanel.style.display = 'none';
            batchBtn.classList.add('upload-mode-btn--active');
            quickBtn.classList.remove('upload-mode-btn--active');
            isBackendEnabled = false;
        } else {
            // Hide all batch sub-panels when switching to Quick Check
            if (progressPanel) progressPanel.style.display = 'none';
            if (successPanel) successPanel.style.display = 'none';
            uploadPanel.style.display = 'none';
            quickPanel.style.display = 'flex';
            quickBtn.classList.add('upload-mode-btn--active');
            batchBtn.classList.remove('upload-mode-btn--active');
        }
    };

    batchBtn.addEventListener('click', () => setActive('batch'));
    quickBtn.addEventListener('click', () => setActive('quick'));

    // Default to batch/local mode
    setActive('batch');
}

function setupStartAnalysisButton() {
    const startBtn = document.getElementById('startAnalysisBtn');
    const status = document.getElementById('analysisStatus');

    if (!startBtn || !status) return;

    startBtn.addEventListener('click', async () => {
        if (!validatedZipFile) {
            status.style.display = 'block';
            status.textContent = 'No validated file found. Please upload and validate a file first.';
            return;
        }

        startBtn.disabled = true;

        // Grab progress UI elements
        const titleEl = document.getElementById('successPanelTitle');
        const messageEl = document.getElementById('successPanelMessage');
        const progressFill = document.getElementById('successProgressFill');
        const progressPercent = document.getElementById('successProgressPercent');

        const setProgress = (pct, msg) => {
            const rounded = Math.round(pct);
            if (progressFill) progressFill.style.width = rounded + '%';
            if (progressPercent) progressPercent.textContent = rounded + '%';
            if (msg && messageEl) messageEl.textContent = msg;
        };

        if (titleEl) titleEl.innerHTML = 'Running AI Analysis...';
        setProgress(0, 'Extracting images from ZIP file...');

        let analysisInterval = null;

        try {
            // Phase 1: Extract ZIP
            const zipData = await extractZipData(validatedZipFile);
            
            if (!zipData || zipData.images.length === 0) {
                throw new Error('No valid images found in ZIP file');
            }

            const shouldContinue = await confirmDuplicateImageIdsBeforeUpload(zipData.images);
            if (!shouldContinue) {
                if (titleEl) titleEl.innerHTML = 'Upload Cancelled';
                setProgress(0, 'Upload cancelled because duplicate image IDs were detected.');
                return;
            }

            const totalImages = zipData.images.length;

            // Phase 2 (0–40%): Convert each image to base64 — real per-image progress
            const imagesData = [];
            for (let i = 0; i < zipData.images.length; i++) {
                const img = zipData.images[i];
                const pct = (i / totalImages) * 40;
                setProgress(pct, `Preparing image ${i + 1} of ${totalImages}: ${img.filename}`);
                const base64Image = await fileToBase64(img.file);
                imagesData.push({
                    image: base64Image,
                    sex: img.sex,
                    fl: img.forkLength,
                    filename: img.filename,
                    scale_id: img.scaleId || ''
                });
            }

            // Phase 3 (40–95%): Send images one-by-one — real per-image progress
            setProgress(40, `Sending image 1 of ${totalImages} to AI model...`);

            let batchJobId = null;
            const allResults = [];

            for (let i = 0; i < imagesData.length; i++) {
                const pct = 40 + ((i / totalImages) * 55);
                setProgress(pct, `AI analyzing image ${i + 1} of ${totalImages}: ${imagesData[i].filename || ''}`);

                const payload = {
                    images: [imagesData[i]],
                    user_id: window.currentUsername || ''
                };
                // Reuse same job_id so all images belong to one batch job
                if (batchJobId) payload.job_id = batchJobId;

                const resp = await apiFetch(CONFIG.PREDICTION_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!resp.ok) {
                    const errorText = await resp.text();
                    throw new Error(`Analysis failed on image ${i + 1}: ${resp.status} - ${errorText}`);
                }

                const imgResult = await resp.json();
                // Capture job_id from the first response for subsequent images
                if (!batchJobId && imgResult.job_id) batchJobId = imgResult.job_id;

                // Collect individual results (imgResult.results is an array of 1)
                const imgResultItems = imgResult.results || [imgResult];
                imgResultItems.forEach(r => {
                    if (r && !r.error) allResults.push(Object.assign({}, r, { job_id: imgResult.job_id || batchJobId }));
                    else if (r) allResults.push(r);
                });
            }

            setProgress(100, 'Analysis complete!');

            // Build a result object matching the original batch format
            const result = {
                job_id: batchJobId,
                user_id: window.currentUsername || '',
                num_images: allResults.length,
                successful_count: allResults.filter(r => !r.error).length,
                failed_count: allResults.filter(r => !!r.error).length,
                results: allResults
            };
            console.log('Analysis result:', result);

            // Verify storage status for all images
            const results = result.results || [];
            let savedCount = 0;
            let failedCount = 0;
            
            results.forEach((imgResult, idx) => {
                if (imgResult.error) {
                    failedCount++;
                    console.error(`Image ${idx + 1} processing error:`, imgResult.error);
                } else {
                    const storage = imgResult.storage_status || {};
                    const s3Ok = storage.s3_uploaded === true;
                    const dbOk = storage.dynamodb_saved === true;
                    
                    if (s3Ok && dbOk) {
                        savedCount++;
                        console.log(`Image ${idx + 1} saved successfully:`, {
                            image_id: imgResult.image_id,
                            s3: s3Ok,
                            dynamodb: dbOk
                        });
                    } else {
                        failedCount++;
                        console.error(`Image ${idx + 1} storage failed:`, {
                            image_id: imgResult.image_id,
                            s3: s3Ok,
                            dynamodb: dbOk,
                            errors: storage.errors
                        });
                    }
                }
            });

            // Update title and message to reflect completion
            if (titleEl) titleEl.innerHTML = 'Analysis Complete!';
            if (failedCount === 0) {
                setProgress(100, `Successfully analyzed ${savedCount} images.`);
            } else {
                setProgress(100, `Done: ${savedCount} saved, ${failedCount} failed.`);
            }
            
            // Store results for display
            window.lastAnalysisResult = result;
            
            // Populate result table (only show successfully saved images)
            populateResultTable(result);
            
            // Clear upload cache after analysis completes
            validatedZipFile = null;
            window.validatedZipFile = null;
            currentFiles = [];
            window.currentFiles = [];
            
            // Clear file info display
            const fileInfo = document.getElementById('fileInfo');
            if (fileInfo) {
                fileInfo.textContent = '';
                fileInfo.style.display = 'none';
            }
            
            // Clear upload status
            clearUploadStatus();
            
            // Navigate to result page after a delay
        setTimeout(() => {
                // Hide upload-mode-toggle before showing result page
                const uploadModeToggle = document.querySelector('.upload-mode-toggle');
                if (uploadModeToggle) uploadModeToggle.style.display = 'none';
                
                // Trigger result page view
                const resultAction = document.querySelector('[data-action="result"]');
                if (resultAction) {
                    resultAction.click();
                } else {
                    // Fallback: manually show result page
                    const resultTab = document.getElementById('resultTab');
                    if (resultTab) {
                        resultTab.click();
                    }
                }
            }, 1500);

        } catch (error) {
            if (analysisInterval) { clearInterval(analysisInterval); analysisInterval = null; }
            console.error('Analysis error:', error);
            if (titleEl) titleEl.innerHTML = 'Analysis Failed';
            if (messageEl) messageEl.textContent = `Error: ${error.message}`;
            if (progressFill) progressFill.style.background = '#ff6b6b';
        } finally {
            startBtn.disabled = false;
        }
    });
}

/**
 * Extract CSV and image data from ZIP file
 */
async function extractZipData(zipFile) {
    if (!window.JSZip) {
        throw new Error('JSZip not loaded. Please refresh the page.');
    }

    const zip = await window.JSZip.loadAsync(zipFile);
    const fileNames = Object.keys(zip.files);
    const actualFiles = fileNames.filter(name => {
        const f = zip.files[name];
        if (f.dir || name.endsWith('/')) return false;
        if (name.includes('__MACOSX') || name.includes('.DS_Store')) return false;
        return true;
    });

    const csvFiles = actualFiles.filter(name => name.toLowerCase().endsWith('.csv'));
    const tiffFiles = actualFiles.filter(name => {
        const lower = name.toLowerCase();
        return lower.endsWith('.tiff') || lower.endsWith('.tif');
    });

    if (csvFiles.length === 0 || tiffFiles.length === 0) {
        throw new Error('ZIP file must contain CSV and TIFF files');
    }

    // Read CSV file
    const csvFileName = csvFiles[0];
    const csvFile = zip.files[csvFileName];
    const csvContent = await csvFile.async('string');
    const lines = csvContent.split(/\r?\n/).filter(line => line.trim().length > 0);
    const headerLine = lines[0];
    const dataLines = lines.slice(1);

    // Parse header to find column indices
    let headerColumns = [];
    if (headerLine.trim().startsWith('"')) {
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < headerLine.length; i++) {
            const char = headerLine[i];
            if (char === '"' && headerLine[i + 1] === '"') {
                current += '"';
                i++;
            } else if (char === '"') {
                inQuotes = !inQuotes;
            } else if (!inQuotes && char === ',') {
                headerColumns.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        headerColumns.push(current.trim());
    } else {
        const separator = headerLine.includes(',') ? ',' : (headerLine.includes('\t') ? '\t' : ',');
        headerColumns = headerLine.split(separator).map(value => value.trim());
    }

    // Find column indices
    const filenameColIndex = 1; // Usually second column
    let sexColIndex = -1;
    let forkLengthColIndex = -1;
    let scaleIdColIndex = -1;

    for (let i = 0; i < headerColumns.length; i++) {
        const col = headerColumns[i].toLowerCase().trim();
        if ((col.includes('sex') || col.includes('gender')) && sexColIndex === -1) {
            sexColIndex = i;
        }
        if ((col.includes('fork') || col.includes('length') || col === 'fl') && forkLengthColIndex === -1) {
            forkLengthColIndex = i;
        }
        if ((col.includes('scale') || col === 'scale_id' || col === 'scaleid' || col === 'id') && scaleIdColIndex === -1) {
            scaleIdColIndex = i;
        }
    }

    // Parse CSV to get image metadata
    const imageMetadata = new Map();
    for (const line of dataLines) {
        if (!line.trim()) continue;
        
        let columns = [];
        if (line.trim().startsWith('"')) {
            // Handle quoted CSV
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char === '"' && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (!inQuotes && char === ',') {
                    columns.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            columns.push(current.trim());
        } else {
            const separator = line.includes(',') ? ',' : (line.includes('\t') ? '\t' : ',');
            columns = line.split(separator).map(value => value.trim());
        }

        // Get filename (second column, without extension)
        const filename = (columns[filenameColIndex] || '').trim();
        if (!filename) continue;

        // Parse sex
        let sex = 2; // Default: Unknown
        if (sexColIndex >= 0 && columns[sexColIndex]) {
            const sexValue = columns[sexColIndex].trim();
            if (sexValue === '0' || sexValue.toLowerCase() === 'female' || sexValue.toLowerCase() === 'f') {
                sex = 0;
            } else if (sexValue === '1' || sexValue.toLowerCase() === 'male' || sexValue.toLowerCase() === 'm') {
                sex = 1;
            }
        }

        // Parse fork length
        let forkLength = 60.0; // Default: 60.0
        if (forkLengthColIndex >= 0 && columns[forkLengthColIndex]) {
            const flValue = parseFloat(columns[forkLengthColIndex]);
            if (!isNaN(flValue) && flValue > 0) {
                forkLength = flValue;
            }
        }

        // Parse scale ID
        let scaleId = '';
        if (scaleIdColIndex >= 0 && columns[scaleIdColIndex]) {
            scaleId = columns[scaleIdColIndex].trim();
        }

        imageMetadata.set(filename, { sex, forkLength, scaleId });
    }

    // Match TIFF files with CSV data
    const images = [];
    for (const tiffPath of tiffFiles) {
        const fileName = tiffPath.split('/').pop() || tiffPath;
        const nameWithoutExt = fileName.replace(/\.(tiff|tif)$/i, '');
        
        const metadata = imageMetadata.get(nameWithoutExt) || { sex: 2, forkLength: 60.0, scaleId: '' };
        const tiffFile = zip.files[tiffPath];
        
        // Convert ZIP file entry to Blob
        const blob = await tiffFile.async('blob');
        const file = new File([blob], fileName, { type: 'image/tiff' });

        images.push({
            filename: fileName,
            file: file,
            sex: metadata.sex,
            forkLength: metadata.forkLength,
            scaleId: metadata.scaleId || ''
        });
    }

    return { images, csvData: csvContent };
}

/**
 * Populate Result Page table with analysis results
 */
function populateResultTable(result) {
    const resultTableBody = document.getElementById('resultTableBody');
    if (!resultTableBody) {
        console.error('Result table body not found');
        return;
    }

    // Clear existing rows
    resultTableBody.innerHTML = '';

    // Get results array (could be result.results or result itself)
    const results = result.results || (Array.isArray(result) ? result : [result]);
    
    // If no results provided, show empty message
    if (!results || results.length === 0) {
        resultTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px; color: #666; font-size: 14px;">No results to display. Please run analysis first.</td></tr>';
        // Clear stored results
        window.allResultImages = [];
        return;
    }

    // Get current date for display
    const currentDate = new Date().toLocaleDateString('en-US', { 
        month: '2-digit', 
        day: '2-digit', 
        year: 'numeric' 
    });

    // Get operator name (from result or default)
    const operatorName = result.user_id || window.currentUsername || '';

    // First, filter valid results and store them
    const validResults = [];
    results.forEach((item, originalIndex) => {
        // Skip items with errors or failed storage
        if (item.error) {
            console.warn(`Skipping item ${originalIndex + 1} due to error:`, item.error);
            return;
        }
        
        const storage = item.storage_status || {};
        if (storage.s3_uploaded !== true || storage.dynamodb_saved !== true) {
            console.warn(`Skipping item ${originalIndex + 1} due to storage failure:`, {
                s3: storage.s3_uploaded,
                dynamodb: storage.dynamodb_saved,
                errors: storage.errors
            });
            return;
        }
        
        validResults.push(item);
    });

    // Populate table rows with valid results
    validResults.forEach((item, validIndex) => {
        const row = document.createElement('tr');
        
        // Extract data from result item
        const scaleId = item.scale_id || '—';
        const imageId = item.image_id || item.filename || `Image ${validIndex + 1}`;
        const confidence = item.confidence || item.probabilities?.[0] || 0;
        const probability = Math.round(confidence * 100);
        const predLabel = item.prediction !== undefined ? item.prediction : (item.pred_label !== undefined ? item.pred_label : 0);
        const predictedOrigin = predLabel === 1 ? 'Wild' : 'Hatchery';

        // Create row HTML
        row.innerHTML = `
            <td><input type="checkbox" class="result-checkbox" checked></td>
            <td>${scaleId}</td>
            <td>${imageId}</td>
            <td>${operatorName}</td>
            <td>${probability}%</td>
            <td>${predictedOrigin}</td>
            <td></td>
        `;
        
        // Store the valid result index in the row for later retrieval
        row.dataset.resultIndex = validIndex;

        resultTableBody.appendChild(row);
    });

    // Check if no valid rows were added
    if (resultTableBody.children.length === 0) {
        resultTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px; color: #666; font-size: 14px;">No results to display. All images failed to save or no valid data available.</td></tr>';
        // Clear stored results
        window.allResultImages = [];
    } else {
        // Store valid results for filtering and commit functionality
        window.allResultImages = validResults;
    }
    
    // Setup filter buttons for result page
    setupResultPageFilters();
    
    // Apply default filter (View all results)
    const filterAllBtn = document.querySelector('#resultPagePanel .result-filter-btn[data-filter="all"]');
    if (filterAllBtn) {
        filterAllBtn.click();
    }
}

// Expose populateResultTable to global scope so it can be called from result tab click
window.populateResultTable = populateResultTable;

/**
 * Setup filter buttons for Result Page
 */
function setupResultPageFilters() {
    const resultPagePanel = document.getElementById('resultPagePanel');
    if (!resultPagePanel) return;

    const filterButtons = resultPagePanel.querySelectorAll('.result-filter-btn[data-filter]');
    filterButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            // Remove active class from all buttons
            filterButtons.forEach(b => b.classList.remove('result-filter-btn--active'));
            // Add active class to clicked button
            btn.classList.add('result-filter-btn--active');
            
            const filter = btn.getAttribute('data-filter');
            applyResultPageFilter(filter);
        });
    });
}

/**
 * Apply filter to Result Page table
 */
function applyResultPageFilter(filter) {
    const resultTableBody = document.getElementById('resultTableBody');
    if (!resultTableBody) return;

    // Check if there are any results stored
    if (!window.allResultImages || window.allResultImages.length === 0) {
        resultTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px; color: #666; font-size: 14px;">No results to display. Please run analysis first.</td></tr>';
        return;
    }

    const rows = resultTableBody.querySelectorAll('tr');
    let visibleCount = 0;
    
    rows.forEach((row) => {
        // Skip if this is a message row (no-data message)
        if (row.cells.length === 1 && row.cells[0].colSpan > 1) {
            row.style.display = 'none';
            return;
        }

        // Use the stored resultIndex attribute (set during row creation) for correct lookup
        const resultIndex = parseInt(row.dataset.resultIndex);
        const result = !isNaN(resultIndex) ? window.allResultImages[resultIndex] : null;
        if (!result) {
            row.style.display = 'none';
            return;
        }

        const confidence = result.confidence || result.probabilities?.[0] || 0;
        let shouldShow = true;

        if (filter === 'high') {
            shouldShow = Math.round(confidence * 100) >= HIGH_CONFIDENCE_THRESHOLD;
        } else if (filter === 'low') {
            shouldShow = Math.round(confidence * 100) < HIGH_CONFIDENCE_THRESHOLD;
        } else if (filter === 'all') {
            shouldShow = true;
        }

        if (shouldShow) {
            row.style.display = '';
            visibleCount++;
        } else {
            row.style.display = 'none';
        }
    });

    // If no rows are visible after filtering, show appropriate message
    if (visibleCount === 0) {
        let message = '';
        if (filter === 'high') {
            message = `No high-confidence results found. All results have confidence below ${HIGH_CONFIDENCE_THRESHOLD}%.`;
        } else if (filter === 'low') {
            message = `No low-confidence results found. All results have confidence ${HIGH_CONFIDENCE_THRESHOLD}% or higher.`;
        } else {
            message = 'No results to display.';
        }
        
        // Remove existing message row if any
        const existingMessage = resultTableBody.querySelector('tr[data-empty-message]');
        if (existingMessage) {
            existingMessage.remove();
        }
        
        // Add new message row
        const messageRow = document.createElement('tr');
        messageRow.setAttribute('data-empty-message', 'true');
        messageRow.innerHTML = `<td colspan="7" style="text-align: center; padding: 20px; color: #666; font-size: 14px;">${message}</td>`;
        resultTableBody.appendChild(messageRow);
    } else {
        // Remove message row if data is visible
        const existingMessage = resultTableBody.querySelector('tr[data-empty-message]');
        if (existingMessage) {
            existingMessage.remove();
        }
    }

    // Show/hide right side buttons based on filter
    const rightButtons = document.getElementById('resultFiltersRight');
    if (rightButtons) {
        rightButtons.style.display = filter === 'all' ? 'flex' : 'none';
    }
}

/**
 * Setup History Result functionality
 */
function setupHistoryResult() {
    const historyTab = document.getElementById('historyTab');
    const historyPanel = document.getElementById('historyPanel');
    const historyTableBody = document.getElementById('historyTableBody');
    const historyLoading = document.getElementById('historyLoading');
    const filterHighBtn = document.getElementById('historyFilterHigh');
    const filterLowBtn = document.getElementById('historyFilterLow');
    const filterAllBtn = document.getElementById('historyFilterAll');
    const filterNewConfirmedBtn = document.getElementById('historyFilterNewConfirmed');

    if (!historyTab || !historyPanel) return;

    // Store all images data for filtering
    let allHistoryImages = [];

    /**
     * Load history data from API
     */
    async function loadHistoryData() {
        if (!historyTableBody || !historyLoading) return;

        try {
            // Show loading indicator
            historyLoading.style.display = 'block';
            
            const response = await apiFetch(CONFIG.HISTORY_API_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const images = await response.json(); // Direct array response

            if (!Array.isArray(images)) {
                throw new Error('Invalid response format: expected array');
            }

            // Store all images for filtering (backend already returns newest-first by created_at)
            allHistoryImages = images;
            console.log('Loaded history images:', images.length);
            if (images.length > 0) {
                console.log('[DEBUG] First history record sample:', JSON.stringify(images[0]));
                console.log('[DEBUG] user_id field value:', images[0].user_id, '| type:', typeof images[0].user_id);
            }
            
            // Now clear table body after data is loaded to prevent layout shift
            if (historyTableBody) historyTableBody.innerHTML = '';

            // Check which filter button is currently active
            let activeFilter = 'all';
            if (filterHighBtn && filterHighBtn.classList.contains('result-filter-btn--active')) {
                activeFilter = 'high';
            } else if (filterLowBtn && filterLowBtn.classList.contains('result-filter-btn--active')) {
                activeFilter = 'low';
            } else if (filterNewConfirmedBtn && filterNewConfirmedBtn.classList.contains('result-filter-btn--active')) {
                activeFilter = 'new-confirmed';
            } else if (filterAllBtn && filterAllBtn.classList.contains('result-filter-btn--active')) {
                activeFilter = 'all';
            } else {
                activeFilter = 'all';
                if (filterAllBtn) {
                    filterAllBtn.classList.add('result-filter-btn--active');
                    if (filterHighBtn) filterHighBtn.classList.remove('result-filter-btn--active');
                    if (filterLowBtn) filterLowBtn.classList.remove('result-filter-btn--active');
                    if (filterNewConfirmedBtn) filterNewConfirmedBtn.classList.remove('result-filter-btn--active');
                }
            }
            console.log('Applying filter:', activeFilter);
            applyHistoryFilter(activeFilter);
        } catch (error) {
            console.error('Failed to load history:', error);
            if (historyTableBody) {
                historyTableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px; color: red;">Failed to load history data. Please check if the backend server is running.</td></tr>';
            }
            
        } finally {
            if (historyLoading) historyLoading.style.display = 'none';
        }
    }

// Expose loadHistoryData to global scope so it can be called from menu actions
window.loadHistoryData = loadHistoryData;

/**
 * Populate Manual Review table with committed data
 */
function populateManualReviewTable(data) {
    console.log('populateManualReviewTable called with data:', data);
    
    // Try to find the table body, with retry logic
    let manualReviewTableBody = document.getElementById('manualReviewTableBody');
    
    if (!manualReviewTableBody) {
        console.error('Manual Review table body not found, trying again...');
        // Try again after a short delay
        setTimeout(function() {
            manualReviewTableBody = document.getElementById('manualReviewTableBody');
            if (!manualReviewTableBody) {
                console.error('Manual Review table body still not found after retry');
                return;
            }
            populateTableRows(manualReviewTableBody, data);
        }, 100);
        return;
    }

    populateTableRows(manualReviewTableBody, data);
}

function populateTableRows(manualReviewTableBody, data) {
    console.log('Found manualReviewTableBody, populating rows');

    // If no data provided
    if (!data || data.length === 0) {
        console.log('No data provided to populateManualReviewTable');
        if (!window.manualReviewLastHadRows) {
            manualReviewTableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px; color: #666; font-size: 14px;">No data to review.</td></tr>';
        } else {
            manualReviewTableBody.innerHTML = '';
        }
        return;
    }

    console.log('Populating', data.length, 'rows');
    const fragment = document.createDocumentFragment();

    // Load reviewed items from localStorage
    let reviewedItems = [];
    try {
        reviewedItems = JSON.parse(localStorage.getItem('manualReviewReviewedItems') || '[]');
        console.log('=== populateManualReviewTable: Loaded reviewedItems from localStorage ===', reviewedItems);
        console.log('Total reviewed items:', reviewedItems.length);
    } catch (err) {
        console.error('Error loading reviewed items:', err);
    }
    
    // Create a unique identifier for each row: cardNumber + index (to handle duplicates)
    // But for reviewed status, we check by cardNumber only (if same cardNumber was reviewed, all instances are reviewed)
    // Actually, let's use a combination: cardNumber + uploadDate to make it more unique
    // But the simplest: use cardNumber for reviewed check, but track each row separately
    
    let reviewedCount = 0;
    let notReviewedCount = 0;
    // 记录我们已经加载过非空数据，避免后续临时空结果导致闪烁
    window.manualReviewLastHadRows = true;
    
    // Populate table rows
    data.forEach((item, index) => {
        const row = document.createElement('tr');
        
        // Store the original data in the row for later retrieval
        row.dataset.committedIndex = index;
        // Store the actual backend review_status for tab filtering
        const backendReviewStatus = (item.originalData && item.originalData.review_status) || 'pending';
        row.dataset.reviewStatus = backendReviewStatus;
        
        const cardNumber = item.cardNumber || '';

        // Build a globally unique key using job_id + image_id from backend.
        // This ensures re-uploads of the same filename get a fresh key (new job_id)
        // and never inherit the reviewed state of a previous upload.
        const backendJobId = (item.originalData && item.originalData.job_id) || '';
        const backendImageId = (item.originalData && item.originalData.image_id) || '';
        const uniqueKey = backendJobId && backendImageId
            ? `${backendJobId}__${backendImageId}`
            : `${cardNumber}_${item.uploadDate || ''}_${item.operatorName || ''}_${index}`;

        // Store uniqueKey in row for later use when saving reviewed status
        row.dataset.uniqueKey = uniqueKey;

        // Check if this specific row has been reviewed (by its unique job+image key)
        const isReviewedByUniqueKey = uniqueKey && reviewedItems.indexOf(uniqueKey) !== -1;

        // Legacy fallback: cardNumber-only match, for old localStorage entries without job_id
        // Only applies when there is no backend key (old local-only data)
        let isReviewedByCardNumber = false;
        if (!backendJobId && cardNumber && reviewedItems.indexOf(cardNumber) !== -1 && !isReviewedByUniqueKey) {
            let firstOccurrenceIndex = -1;
            for (let i = 0; i < data.length; i++) {
                if (data[i].cardNumber === cardNumber) { firstOccurrenceIndex = i; break; }
            }
            isReviewedByCardNumber = (firstOccurrenceIndex === index);
        }

        const isReviewed = isReviewedByUniqueKey || isReviewedByCardNumber;
        
        // Debug logging
        if (index < 3) { // Log first 3 rows for debugging
            console.log(`Row ${index}: cardNumber=${cardNumber}, uniqueKey=${uniqueKey}, isReviewedByUniqueKey=${isReviewedByUniqueKey}, isReviewedByCardNumber=${isReviewedByCardNumber}, isReviewed=${isReviewed}`);
        }
        
        // IMPORTANT: Only set data-reviewed if it was actually reviewed (clicked before)
        // New items should NOT have data-reviewed attribute
        if (isReviewed) {
            row.setAttribute('data-reviewed', 'true');
            reviewedCount++;
            console.log('✓ Row marked as reviewed:', cardNumber, isReviewedByCardNumber ? '(by cardNumber)' : '(by uniqueKey)');
        } else {
            // Ensure new items don't have data-reviewed attribute
            // Explicitly remove it to prevent any leftover state
            if (row.hasAttribute('data-reviewed')) {
                row.removeAttribute('data-reviewed');
            }
            notReviewedCount++;
            console.log('✗ Row marked as NOT reviewed:', cardNumber, 'uniqueKey:', uniqueKey);
        }
        
        const orig = item.originalData || {};
        const mrProbability = orig.confidence !== undefined ? Math.round(orig.confidence * 100) + '%' : '—';
        const mrPredicted = orig.pred_label === 1 ? 'Wild' : (orig.pred_label === 0 ? 'Hatchery' : '—');
        const mrFinalOrigin = orig.manual_read_origin || '—';
        const mrReviewer = orig.reader_name || orig.reviewer_id || '';
        const mrRawDate = orig.updated_at || orig.created_at || '';
        const mrReviewDate = mrRawDate ? (() => {
            try {
                const d = new Date(mrRawDate);
                return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
            } catch(e) { return ''; }
        })() : '';
        let mrReviewStatus = 'Not Reviewed';
        if (orig.review_status === 'confirmed') {
            mrReviewStatus = `Confirmed${mrReviewer ? ' · by ' + mrReviewer : ''}${mrReviewDate ? ' · ' + mrReviewDate : ''}`;
        } else if (orig.review_status === 'overridden') {
            mrReviewStatus = `Overridden${mrReviewer ? ' · by ' + mrReviewer : ''}${mrReviewDate ? ' · ' + mrReviewDate : ''}`;
        } else if (orig.review_status === 'reviewed') {
            mrReviewStatus = `Reviewed${mrReviewer ? ' · by ' + mrReviewer : ''}${mrReviewDate ? ' · ' + mrReviewDate : ''}`;
        } else if (isReviewed) {
            mrReviewStatus = 'Reviewed';
        }

        row.innerHTML = `
            <td><input type="checkbox" class="result-checkbox"></td>
            <td style="white-space:nowrap">${item.scaleId || '—'}</td>
            <td style="white-space:nowrap">${item.imageId || '—'}</td>
            <td style="white-space:nowrap">${item.operatorName || '—'}</td>
            <td style="white-space:nowrap">${mrProbability}</td>
            <td style="white-space:nowrap">${mrPredicted}</td>
            <td style="white-space:nowrap">${mrFinalOrigin}</td>
            <td style="white-space:nowrap">${mrReviewStatus}</td>
        `;

        fragment.appendChild(row);
    });

    manualReviewTableBody.replaceChildren(fragment);
    
    console.log('=== populateManualReviewTable Summary ===');
    console.log('Total rows:', data.length);
    console.log('Reviewed:', reviewedCount);
    console.log('Not reviewed:', notReviewedCount);
    
    console.log('Finished populating table, total rows:', manualReviewTableBody.children.length);
    
    // Apply current filter immediately (no setTimeout) to avoid flashing "All" then "Not reviewed"
    const activeFilterBtn = document.querySelector('#manualReviewPanel .result-filter-btn.result-filter-btn--active');
    const filter = (activeFilterBtn && activeFilterBtn.getAttribute('data-filter')) || 'not-reviewed';
    if (typeof window.filterManualReviewRows === 'function') {
        window.filterManualReviewRows(filter);
    }
}

// Expose populateManualReviewTable to global scope
window.populateManualReviewTable = populateManualReviewTable;
window.loadManualReviewDataFromBackend = loadManualReviewDataFromBackend;
console.log('populateManualReviewTable function exposed to window');

    // Handle history tab click
    historyTab.addEventListener('click', async () => {
        
        // Hide other panels
        const uploadPanel = document.getElementById('uploadPanel');
        const quickCheckPanel = document.getElementById('quickCheckPanel');
        const resultPanel = document.getElementById('resultPagePanel');
        const uploadTab = document.getElementById('uploadTab');
        const resultTab = document.getElementById('resultTab');
        const uploadModeToggle = document.querySelector('.upload-mode-toggle');

        if (uploadPanel) uploadPanel.style.display = 'none';
        if (quickCheckPanel) quickCheckPanel.style.display = 'none';
        if (resultPanel) resultPanel.style.display = 'none';
        if (historyPanel) historyPanel.style.display = 'block';
        
        // Hide batch validation and quick check toggle when showing history
        if (uploadModeToggle) uploadModeToggle.style.display = 'none';

        // Update tab active state
        if (uploadTab) uploadTab.classList.remove('upload-tab--active');
        if (resultTab) resultTab.classList.remove('upload-tab--active');
        historyTab.classList.add('upload-tab--active');

        // Clear "new confirmed" notification when user opens History Result
        try {
            sessionStorage.removeItem('historyResultHasNewConfirmed');
            if (typeof window.updateHistoryResultNotification === 'function') {
                window.updateHistoryResultNotification();
            }
        } catch (e) {}

        // Load history data
        await loadHistoryData();
    });

    // Setup filter buttons (including New Confirmed)
    const historyFilterBtns = [filterHighBtn, filterLowBtn, filterAllBtn, filterNewConfirmedBtn].filter(Boolean);
    if (historyFilterBtns.length) {
        historyFilterBtns.forEach(btn => {
            btn.addEventListener('click', function() {
                historyFilterBtns.forEach(b => { b.classList.remove('result-filter-btn--active'); });
                this.classList.add('result-filter-btn--active');
                const filter = this.getAttribute('data-filter');
                applyHistoryFilter(filter);
                // When user explicitly opens New Confirmed, clear outer red dot
                if (filter === 'new-confirmed') {
                    try {
                        sessionStorage.removeItem('historyResultHasNewConfirmed');
                        if (typeof window.updateHistoryResultNotification === 'function') {
                            window.updateHistoryResultNotification();
                        }
                    } catch (e) {}
                }
            });
        });
    }

    // Setup refresh button
    const refreshBtn = document.getElementById('refreshHistoryBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            if (historyLoading) historyLoading.style.display = 'block';
            if (historyTableBody) historyTableBody.innerHTML = '';
            allHistoryImages = [];
            await loadHistoryData();
        });
    }

    // ── Select-all checkbox ──────────────────────────────────────────────────
    const selectAllCheckbox = document.getElementById('historySelectAll');
    const deleteBtn = document.getElementById('historyDeleteBtn');
    const selectedCountSpan = document.getElementById('historySelectedCount');
    const exportCsvBtn = document.getElementById('historyExportCsvBtn');
    const exportCountSpan = document.getElementById('historyExportCount');
    const historyActionBar = historyPanel ? historyPanel.querySelector('.result-filters-right') : null;

    function updateDeleteBar() {
        const checked = historyTableBody ? historyTableBody.querySelectorAll('.history-row-checkbox:checked') : [];
        const count = checked.length;
        if (historyActionBar) {
            historyActionBar.style.display = 'flex';
        }
        if (deleteBtn) {
            deleteBtn.style.display = 'flex';
            deleteBtn.disabled = count === 0;
            deleteBtn.style.opacity = count === 0 ? '0.6' : '1';
            deleteBtn.style.cursor = count === 0 ? 'not-allowed' : 'pointer';
        }
        if (exportCsvBtn) {
            exportCsvBtn.style.display = 'flex';
            exportCsvBtn.disabled = count === 0;
            exportCsvBtn.style.opacity = count === 0 ? '0.6' : '1';
            exportCsvBtn.style.cursor = count === 0 ? 'not-allowed' : 'pointer';
        }
        if (selectedCountSpan) selectedCountSpan.textContent = count;
        if (exportCountSpan) exportCountSpan.textContent = count;
        if (selectAllCheckbox) {
            const all = historyTableBody ? historyTableBody.querySelectorAll('.history-row-checkbox') : [];
            selectAllCheckbox.indeterminate = count > 0 && count < all.length;
            selectAllCheckbox.checked = all.length > 0 && count === all.length;
        }
    }

    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', () => {
            const checkboxes = historyTableBody ? historyTableBody.querySelectorAll('.history-row-checkbox') : [];
            checkboxes.forEach(cb => { cb.checked = selectAllCheckbox.checked; });
            updateDeleteBar();
        });
    }

    updateDeleteBar();

    // Delegate individual checkbox clicks
    if (historyTableBody) {
        historyTableBody.addEventListener('change', (e) => {
            if (e.target.classList.contains('history-row-checkbox')) {
                updateDeleteBar();
            }
        });
    }

    // ── Delete Selected button: double confirm (same as Manual Review) ────────
    const historyDeleteConfirmModal = document.getElementById('historyDeleteConfirmModal');
    const historyDeleteConfirmText = document.getElementById('historyDeleteConfirmText');
    const historyDeleteConfirmCancelBtn = document.getElementById('historyDeleteConfirmCancelBtn');
    const historyDeleteConfirmBtn = document.getElementById('historyDeleteConfirmBtn');

    let pendingHistoryDeleteRows = [];
    let pendingHistoryDeleteItems = [];

    if (deleteBtn) {
        deleteBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const checkedRows = historyTableBody ? [...historyTableBody.querySelectorAll('tr')].filter(r => {
                const cb = r.querySelector('.history-row-checkbox');
                return cb && cb.checked;
            }) : [];
            if (checkedRows.length === 0) return;
            const items = checkedRows.map(r => ({ job_id: r.dataset.jobId || '', image_id: r.dataset.imageId || '' }));
            if (items.some(i => !i.job_id || !i.image_id)) {
                console.warn('[History Delete] Some rows missing job_id/image_id');
            }
            pendingHistoryDeleteRows = checkedRows;
            pendingHistoryDeleteItems = items;
            if (historyDeleteConfirmText) {
                historyDeleteConfirmText.textContent = items.length === 1
                    ? 'Remove the selected record from history? This cannot be undone.'
                    : `Remove ${items.length} selected records from history? This cannot be undone.`;
            }
            if (historyDeleteConfirmModal) historyDeleteConfirmModal.style.display = 'flex';
        });
    }

    async function doHistoryBatchDelete() {
        if (pendingHistoryDeleteItems.length === 0) return;
        const items = pendingHistoryDeleteItems;
        const rowsToRemove = pendingHistoryDeleteRows;
        pendingHistoryDeleteItems = [];
        pendingHistoryDeleteRows = [];
        if (historyDeleteConfirmModal) historyDeleteConfirmModal.style.display = 'none';

        try {
            const resp = await apiFetch('/api/delete-history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items })
            });
            let result;
            try {
                result = await resp.json();
            } catch (e) {
                console.error('[DELETE] Response not JSON:', e);
                alert('Delete failed: server returned invalid response.');
                return;
            }
            console.log('[DELETE]', result);

            if (!resp.ok) {
                const msg = result && result.error ? result.error : resp.statusText || 'Delete failed';
                alert('Delete failed: ' + msg);
                return;
            }

            const deletedCount = (result.deleted != null ? result.deleted : 0);
            const failedCount = (result.failed != null ? result.failed : 0);
            if (failedCount === items.length) {
                const errMsg = result.results && result.results[0] ? result.results[0].error : 'Backend could not delete.';
                alert('Delete failed: ' + errMsg);
                return;
            }

            const deletedKeys = new Set(items.map(i => `${i.job_id}__${i.image_id}`));
            rowsToRemove.forEach(r => { if (r.parentNode) r.remove(); });
            for (let i = allHistoryImages.length - 1; i >= 0; i--) {
                if (deletedKeys.has(`${allHistoryImages[i].job_id}__${allHistoryImages[i].image_id}`)) {
                    allHistoryImages.splice(i, 1);
                }
            }

            if (failedCount > 0) {
                alert(`Deleted ${deletedCount}, failed ${failedCount}. Check console for details.`);
            }
            if (selectAllCheckbox) selectAllCheckbox.checked = false;
            updateDeleteBar();
        } catch (err) {
            console.error('[DELETE] Error:', err);
            alert('Delete failed: ' + (err.message || 'Please try again.'));
        }
    }

    if (historyDeleteConfirmCancelBtn && historyDeleteConfirmModal) {
        historyDeleteConfirmCancelBtn.addEventListener('click', function () {
            pendingHistoryDeleteRows = [];
            pendingHistoryDeleteItems = [];
            historyDeleteConfirmModal.style.display = 'none';
        });
    }
    if (historyDeleteConfirmBtn && historyDeleteConfirmModal) {
        historyDeleteConfirmBtn.addEventListener('click', function () {
            doHistoryBatchDelete();
        });
    }
    if (historyDeleteConfirmModal) {
        historyDeleteConfirmModal.addEventListener('click', function (e) {
            if (e.target === historyDeleteConfirmModal) {
                pendingHistoryDeleteRows = [];
                pendingHistoryDeleteItems = [];
                historyDeleteConfirmModal.style.display = 'none';
            }
        });
    }

    // ── Export CSV button (only exports selected rows; button shown with Delete when selection exists)
    function escapeCsvCell(str) {
        if (str == null) return '';
        const s = String(str).trim();
        if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }
    if (exportCsvBtn && historyTableBody) {
        exportCsvBtn.addEventListener('click', function () {
            const rows = historyTableBody.querySelectorAll('tr');
            const dataRows = [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const checkbox = row.querySelector('.history-row-checkbox');
                if (!checkbox) continue;
                const cells = row.querySelectorAll('td');
                if (cells.length < 8) continue;
                const scaleId = (cells[1] && cells[1].textContent) ? cells[1].textContent.trim() : '';
                const imageId = (cells[2] && cells[2].textContent) ? cells[2].textContent.trim() : '';
                const uploadedBy = (cells[3] && cells[3].textContent) ? cells[3].textContent.trim() : '';
                const probability = (cells[4] && cells[4].textContent) ? cells[4].textContent.trim() : '';
                const predictedOrigin = (cells[5] && cells[5].textContent) ? cells[5].textContent.trim() : '';
                const finalOrigin = (cells[6] && cells[6].textContent) ? cells[6].textContent.trim() : '';
                const reviewStatus = (cells[7] && cells[7].textContent) ? cells[7].textContent.trim() : '';
                const checked = checkbox.checked;
                dataRows.push({ scaleId, imageId, uploadedBy, probability, predictedOrigin, finalOrigin, reviewStatus, checked });
            }
            const toExport = dataRows.filter(r => r.checked);
            if (toExport.length === 0) {
                alert('No rows selected. Select one or more rows to export.');
                return;
            }
            const header = ['Scale ID', 'Image ID', 'Uploaded By', 'Probability', 'Predicted Origin', 'Final Origin', 'Review Status'];
            const lines = [header.map(escapeCsvCell).join(',')];
            toExport.forEach(r => {
                lines.push([r.scaleId, r.imageId, r.uploadedBy, r.probability, r.predictedOrigin, r.finalOrigin, r.reviewStatus].map(escapeCsvCell).join(','));
            });
            const csv = lines.join('\r\n');
            const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'history-export-' + new Date().toISOString().slice(0, 10) + '.csv';
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    // Expose updateDeleteBar so applyHistoryFilter can reset it after re-render
    window._historyUpdateDeleteBar = updateDeleteBar;

    /**
     * Apply filter to history data
     */
    function applyHistoryFilter(filter) {
        if (!historyTableBody) return;

        console.log('applyHistoryFilter called with filter:', filter);
        console.log('allHistoryImages length:', allHistoryImages.length);

        // Filter images based on confidence or new-confirmed
        let filteredImages = [];
        if (filter === 'high') {
            filteredImages = allHistoryImages.filter(img => Math.round(img.confidence * 100) >= HIGH_CONFIDENCE_THRESHOLD);
        } else if (filter === 'low') {
            filteredImages = allHistoryImages.filter(img => Math.round(img.confidence * 100) < HIGH_CONFIDENCE_THRESHOLD);
        } else if (filter === 'new-confirmed') {
            const isConfirmed = (img) => img.review_status && ['confirmed', 'overridden', 'reviewed'].includes(String(img.review_status).toLowerCase());
            const isUnacknowledged = (img) => !img.field_acknowledged_at;
            filteredImages = allHistoryImages.filter(img => isConfirmed(img) && isUnacknowledged(img));
            filteredImages.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
        } else {
            filteredImages = allHistoryImages;
        }

        console.log('Filtered images length:', filteredImages.length);

        // Clear table
        historyTableBody.innerHTML = '';

        if (filteredImages.length === 0) {
            historyTableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">No history data found</td></tr>';
        } else {
            // Helper functions
            const getOriginLabel = (predLabel) => {
                return predLabel === 1 ? 'Wild' : 'Hatchery';
            };

            const formatDate = (isoString) => {
                if (!isoString) return 'N/A';
                // If no timezone indicator, server stored UTC without 'Z'.
                // Append 'Z' so JS converts UTC → local time correctly.
                const normalized = isoString.endsWith('Z') || isoString.includes('+') ? isoString : isoString + 'Z';
                const date = new Date(normalized);
                if (isNaN(date.getTime())) return 'N/A';
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const year = date.getFullYear();
                return `${month}/${day}/${year}`;
            };

            const getConfidenceLevel = (confidence) => {
                return Math.round(confidence * 100) >= HIGH_CONFIDENCE_THRESHOLD ? 'High- Confidence' : 'Low- Confidence';
            };

            filteredImages.forEach((image, index) => {
                const row = document.createElement('tr');
                // Store identifiers for batch delete
                row.dataset.jobId = image.job_id || '';
                row.dataset.imageId = image.image_id || '';
                const scaleId = image.scale_id || '—';
                const imageId = image.image_id || '—';
                const uploadedBy = image.user_id || '—';
                const probability = Math.round(image.confidence * 100) + '%';
                const predictedOrigin = getOriginLabel(image.pred_label);
                const finalOrigin = image.manual_read_origin || '—';

                // Reviewer display: prefer reader_name, fall back to reviewer_id
                const reviewer = image.reader_name || image.reviewer_id || '';
                const reviewDate = formatDate(image.updated_at || image.created_at);

                const isConfirmed = image.review_status && ['confirmed', 'overridden', 'reviewed'].includes(String(image.review_status).toLowerCase());
                // Review Status: show Confirmed/Overridden when confirmed (so New Confirmed tab never shows "Not Reviewed")
                let reviewStatus = 'Not Reviewed';
                if (isConfirmed) {
                    const aiOrigin = getOriginLabel(image.pred_label);
                    const labOrigin = image.manual_read_origin || '';
                    const verb = (labOrigin && labOrigin !== aiOrigin) ? 'Overridden' : 'Confirmed';
                    reviewStatus = reviewer && reviewDate ? `${verb} · by ${reviewer} · ${reviewDate}` : (reviewDate ? `${verb} · ${reviewDate}` : verb);
                }
                row.innerHTML = `
                    <td><input type="checkbox" class="history-row-checkbox" style="width:16px;height:16px;cursor:pointer;accent-color:#017b54;"></td>
                    <td>${scaleId}</td>
                    <td>${imageId}</td>
                    <td>${uploadedBy}</td>
                    <td>${probability}</td>
                    <td>${predictedOrigin}</td>
                    <td>${finalOrigin}</td>
                    <td>${reviewStatus}</td>
                `;
                historyTableBody.appendChild(row);
            });
        }

        // Reset select-all checkbox and delete bar after re-render
        const selAll = document.getElementById('historySelectAll');
        if (selAll) selAll.checked = false;
        if (window._historyUpdateDeleteBar) window._historyUpdateDeleteBar();
    }
}

// Start when ready (Auth gate first)
async function bootstrapWithAuth() {
    bindLoginGate();
    await checkSession();
    if (getToken() && !integrationStarted) {
        initIntegration();
        integrationStarted = true;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapWithAuth);
} else {
    bootstrapWithAuth();
}
