// ==UserScript==
// @name         PhonePe Business - Live Transaction Detector & Details Auto-Sync
// @namespace    https://business.phonepe.com/
// @version      10.0
// @description  Detects live transactions, navigates to history, opens new transaction drawer/details, extracts genuine notes for all UPI apps, saves to MySQL DB, pushes to interface, and limits retries to < 5 refreshes (marking as FAIL if not fetched).
// @author       Assistant
// @match        https://business.phonepe.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const HISTORY_URL = 'https://business.phonepe.com/dashboard/transactions/history';
    const LIVE_URL = 'https://business.phonepe.com/dashboard/transactions/live';
    const BACKEND_BASE = 'http://127.0.0.1:8000';
    const MAX_REFRESH_ATTEMPTS = 4;

    // Cross-tab Communication Channel
    const liveSyncChannel = new BroadcastChannel('phonepe_live_sync_bridge');

    let pendingDBSaves = 0;
    const currentlyOpeningTxns = new Set();
    let isTableProcessing = false;
    let isNavigating = false;

    // Fast Persistent Caching in localStorage
    let cachedDBList = [];
    try {
        cachedDBList = JSON.parse(localStorage.getItem('phonepe_known_db_txns') || '[]');
    } catch(e) {}
    const knownDBTxnIds = new Set(cachedDBList);

    let storedNotes = {};
    try {
        storedNotes = JSON.parse(localStorage.getItem('phonepe_notes_cache') || '{}');
    } catch(e) {}
    const notesCache = Object.assign({}, storedNotes);

    function persistDBCache() {
        try {
            const arr = Array.from(knownDBTxnIds);
            localStorage.setItem('phonepe_known_db_txns', JSON.stringify(arr.slice(-1000)));
            localStorage.setItem('phonepe_notes_cache', JSON.stringify(notesCache));
        } catch(e) {}
    }

    // =========================================================================
    // 0. NETWORK INTERCEPTOR (CAPTURES PHONEPE API RESPONSES AT RUNTIME)
    // =========================================================================
    function cleanNoteCandidate(val) {
        if (!val || typeof val !== 'string') return '';
        const v = val.trim();
        const upper = v.toUpperCase();
        if (
            v &&
            !upper.startsWith('TXSCAN') &&
            !upper.startsWith('AC2') &&
            !upper.startsWith('AC0') &&
            !upper.startsWith('T26') &&
            !upper.startsWith('T25') &&
            !upper.startsWith('M22') &&
            !upper.startsWith('HTTP') &&
            upper !== 'SUCCESS' &&
            upper !== 'COMPLETED' &&
            upper !== 'PAYMENT_SUCCESS' &&
            upper !== 'N/A' &&
            upper !== 'NA' &&
            !/^\d{12,24}$/.test(v)
        ) {
            return v;
        }
        return '';
    }

    function extractNoteFromApiData(d) {
        if (!d || typeof d !== 'object') return '';
        const candidates = [
            d.transactionNote,
            d.note,
            d.message,
            d.customerMessage,
            d.paymentMessage,
            d.remark,
            d.remarks,
            d.description,
            d.userDescription,
            d.narration,
            d.payerDetails?.remarks,
            d.payerDetails?.note,
            d.payerDetails?.message,
            d.upiDetails?.remarks,
            d.upiDetails?.note,
            d.upiDetails?.transactionNote,
            d.paymentDetails?.note,
            d.paymentDetails?.remarks,
            d.paymentDetails?.message,
            d.additionalData?.note,
            d.additionalData?.transactionNote,
            d.additionalData?.message,
            d.additionalData?.remarks,
            d.additionalData?.customerNote,
            d.additionalData?.narration,
        ];

        if (Array.isArray(d.instrumentDetails)) {
            for (let inst of d.instrumentDetails) {
                if (inst) {
                    candidates.push(
                        inst.remarks,
                        inst.note,
                        inst.transactionNote,
                        inst.message,
                        inst.userDescription,
                        inst.paymentModeDetails?.remarks,
                        inst.paymentModeDetails?.note,
                        inst.instrumentData?.remarks,
                        inst.instrumentData?.note
                    );
                }
            }
        }

        candidates.push(d.merchantOrderId);

        for (let c of candidates) {
            const clean = cleanNoteCandidate(c);
            if (clean) return clean;
        }
        return '';
    }

    function extractPayerNameFromApiData(d) {
        if (!d || typeof d !== 'object') return 'Customer';
        const candidates = [
            d.customerDetails?.userName,
            d.customerDetails?.name,
            d.payerDetails?.name,
            d.payerDetails?.userName,
            d.payer?.name,
            d.payer?.userName,
            d.customer?.name,
            d.customerDetails?.userId,
        ];
        if (Array.isArray(d.instrumentDetails)) {
            for (let inst of d.instrumentDetails) {
                if (inst) {
                    candidates.push(
                        inst.accountHolderName,
                        inst.payerName,
                        inst.name,
                        inst.vpa,
                        inst.payerVpa,
                        inst.upiId
                    );
                }
            }
        }
        for (let c of candidates) {
            if (c && typeof c === 'string' && c.trim()) {
                const s = c.trim();
                if (s.toLowerCase() !== 'customer' && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined') {
                    return s;
                }
            }
        }
        return 'Customer';
    }

    function handleInterceptedApiData(url, data) {
        try {
            if (!data) return;
            // Case 1: Unit details response
            if (data.data && (url.includes('/details') || url.includes('/unit/'))) {
                const d = data.data;
                const note = extractNoteFromApiData(d);
                const name = extractPayerNameFromApiData(d);
                const txnId = d.transactionId || d.providerReferenceId || d.unitId;
                const unitId = d.unitId;
                const utr = d.instrumentDetails?.[0]?.utr;

                if (note) {
                    if (txnId) notesCache[txnId] = note;
                    if (unitId) notesCache[unitId] = note;
                    if (utr) notesCache[utr] = note;
                    persistDBCache();
                    console.log(`🎯 [Intercepted API Note]: ${note} for ID: ${txnId || unitId}`);
                }
            }

            // Case 2: Transaction list response
            if (data.data?.transactions || Array.isArray(data.data)) {
                const list = data.data.transactions || data.data;
                for (let item of list) {
                    const note = extractNoteFromApiData(item);
                    const tid = item.transactionId || item.providerReferenceId || item.unitId;
                    const uid = item.unitId;
                    const utr = item.instrumentDetails?.[0]?.utr;
                    if (note) {
                        if (tid) notesCache[tid] = note;
                        if (uid) notesCache[uid] = note;
                        if (utr) notesCache[utr] = note;
                    }
                }
                persistDBCache();
            }
        } catch(e) {}
    }

    // Intercept window.fetch
    try {
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
            const resp = await origFetch.apply(this, args);
            try {
                const url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
                if (url.includes('/transactions') || url.includes('/unit/') || url.includes('/details') || url.includes('/apis/mi-web/')) {
                    const clone = resp.clone();
                    clone.json().then(j => handleInterceptedApiData(url, j)).catch(() => {});
                }
            } catch(e) {}
            return resp;
        };
    } catch(e) {}

    // Intercept XMLHttpRequest
    try {
        const origXhrOpen = XMLHttpRequest.prototype.open;
        const origXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._interceptUrl = url;
            return origXhrOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(...args) {
            this.addEventListener('load', function() {
                try {
                    const url = this._interceptUrl || '';
                    if (url.includes('/transactions') || url.includes('/unit/') || url.includes('/details') || url.includes('/apis/mi-web/')) {
                        const j = JSON.parse(this.responseText);
                        handleInterceptedApiData(url, j);
                    }
                } catch(e) {}
            });
            return origXhrSend.apply(this, args);
        };
    } catch(e) {}

    // =========================================================================
    // 1. UNIVERSAL BACKEND REQUEST (GM_xmlhttpRequest or fetch)
    // =========================================================================
    function backendRequest(path, method = 'GET', data = null) {
        return new Promise((resolve, reject) => {
            const url = `${BACKEND_BASE}${path}`;
            const headers = { 'Accept': 'application/json' };
            let body = undefined;
            if (data) {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(data);
            }

            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: method,
                    url: url,
                    headers: headers,
                    data: body,
                    timeout: 8000,
                    onload: function(res) {
                        try {
                            const j = JSON.parse(res.responseText);
                            resolve(j);
                        } catch(e) {
                            resolve({ success: res.status >= 200 && res.status < 300, raw: res.responseText });
                        }
                    },
                    onerror: function(err) {
                        reject(err);
                    },
                    ontimeout: function() {
                        reject(new Error('Backend request timeout'));
                    }
                });
            } else {
                fetch(url, {
                    method: method,
                    headers: headers,
                    body: body
                })
                .then(r => r.json())
                .then(resolve)
                .catch(reject);
            }
        });
    }

    // =========================================================================
    // 2. DYNAMIC PAGE DETECTION
    // =========================================================================
    function getPageType() {
        const href = window.location.href.toLowerCase();
        if (href.includes('/transactions/live')) return 'LIVE';
        if (href.includes('/transactions/history')) return 'HISTORY';
        if (href.includes('/dashboard/transactions')) {
            const activeTab = document.querySelector('.ant-tabs-tab-active, [class*="tab-active"]')?.innerText || '';
            if (activeTab.includes('Live')) return 'LIVE';
            if (activeTab.includes('History')) return 'HISTORY';
        }
        return 'OTHER';
    }

    // =========================================================================
    // 3. IN-PAGE TOAST NOTIFICATION
    // =========================================================================
    function showInPageToast(message, isSuccess = true) {
        let toast = document.getElementById('phonepe-live-sync-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'phonepe-live-sync-toast';
            toast.style.cssText = `
                position: fixed;
                top: 24px;
                right: 24px;
                z-index: 99999999;
                background: linear-gradient(135deg, #1e1b4b, #4338ca);
                color: #ffffff;
                padding: 12px 22px;
                border-radius: 12px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13.5px;
                font-weight: 600;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.2);
                display: flex;
                align-items: center;
                gap: 10px;
                pointer-events: none;
                transition: opacity 0.3s ease, transform 0.3s ease;
                opacity: 0;
                transform: translateY(-20px);
            `;
            document.body.appendChild(toast);
        }
        toast.innerHTML = `<span style="font-size:16px;">${isSuccess ? '⚡' : '⚠️'}</span><span>${message}</span>`;
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
        setTimeout(() => {
            if (toast) {
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(-20px)';
            }
        }, 4000);
    }

    // =========================================================================
    // 4. PRELOAD NOTES & TRANSACTIONS FROM LOCAL MYSQL DATABASE
    // =========================================================================
    async function preloadNotesFromDB() {
        try {
            const resp = await backendRequest('/api/v1/db/transactions?limit=500');
            if (resp && resp.data) {
                resp.data.forEach(t => {
                    const tid = (t.transaction_id || '').trim();
                    const note = (t.transaction_note || '').trim();
                    if (note && !note.startsWith('TXSCAN') && !note.startsWith('AC2') && note !== '—' && !note.includes('FAIL')) {
                        if (tid) notesCache[tid] = note;
                        if (tid) knownDBTxnIds.add(tid);
                    } else if (tid && t.status && t.status.includes('FAIL')) {
                        knownDBTxnIds.add(tid);
                    }
                });
                persistDBCache();
                console.log(`⚡ [PhonePe Auto-Sync] Loaded ${knownDBTxnIds.size} transactions and ${Object.keys(notesCache).length} notes from MySQL`);
                processTransactionsTable();
            }
        } catch (e) {
            console.warn('⚠️ [PhonePe Auto-Sync] Local backend connection notice:', e.message || e);
        }
    }

    // =========================================================================
    // 5. EXTRACT DETAILS FROM TABLE ROW
    // =========================================================================
    function extractRowDetails(row) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        let txnId = '';
        let unitId = '';
        let amount = 0.0;
        let dateText = '';
        let status = 'PAYMENT_SUCCESS';
        let payerName = 'Customer';

        const rowText = row.innerText;
        const txnMatch = rowText.match(/\b(T2\d{16,}|\d{12})\b/);
        if (txnMatch) {
            txnId = txnMatch[1];
        } else if (cells[1] && cells[1].trim().length >= 6) {
            const candidate = cells[1].trim().split('\n')[0].replace(/[^\w-]/g, '');
            if (candidate && !candidate.includes('₹')) txnId = candidate;
        }

        const link = row.querySelector('a[href*="details/"]');
        if (link && link.href) {
            const m = link.href.match(/details\/([A-Za-z0-9_-]+)/);
            if (m) unitId = m[1];
        }
        if (!unitId && row.dataset?.rowKey) unitId = row.dataset.rowKey;
        if (!unitId && row.getAttribute('data-row-key')) unitId = row.getAttribute('data-row-key');
        if (!unitId) {
            const acMatch = rowText.match(/\b(AC\d{16,})\b/);
            if (acMatch) unitId = acMatch[1];
        }

        // React fiber inspection for exact IDs
        try {
            const propNames = Object.getOwnPropertyNames(row).concat(Object.keys(row));
            const reactKey = propNames.find(p => p.startsWith('__reactFiber') || p.startsWith('__reactInternalInstance'));
            if (reactKey) {
                let curr = row[reactKey];
                let depth = 0;
                while (curr && depth < 20) {
                    const props = curr.memoizedProps;
                    if (props) {
                        const rec = props.row?.original || props.children?.props?.row?.original || props.record || props.data || props.row;
                        if (rec) {
                            if (rec.unitId && !unitId) unitId = rec.unitId;
                            if (rec.id && !unitId) unitId = rec.id;
                            if (rec.transactionId && !txnId) txnId = rec.transactionId;
                            if (rec.providerReferenceId && !txnId) txnId = rec.providerReferenceId;
                            if (rec.utr && !txnId) txnId = rec.utr;
                            if (rec.amount && amount === 0.0) amount = parseFloat(rec.amount) / 100.0;
                            if (rec.customerDetails?.userName && payerName === 'Customer') payerName = rec.customerDetails.userName;
                            if (rec.payerName && payerName === 'Customer') payerName = rec.payerName;
                        }
                    }
                    if (unitId && txnId && amount > 0.0) break;
                    curr = curr.return;
                    depth++;
                }
            }
        } catch(e) {}

        // Amount and status from cells
        for (let c of cells) {
            if (c.includes('₹') || /^[\d,]+(\.\d{2})?$/.test(c)) {
                const cleaned = c.replace(/[^\d.]/g, '');
                if (cleaned) {
                    const parsed = parseFloat(cleaned);
                    if (parsed > 0) amount = parsed;
                }
            }
            if (/^(COMPLETED|SUCCESS|PAID|FAILED|PENDING|FAIL)$/i.test(c)) {
                status = c.toUpperCase();
            }
        }

        if (cells.length > 0) {
            dateText = cells[0].replace('\n', ' ').trim();
        }

        return { txnId, unitId, amount, dateText, status, payerName };
    }

    // =========================================================================
    // 6. DOM NOTE EXTRACTOR FROM OPENED DRAWER / MODAL / DETAILS PAGE
    // =========================================================================
    function extractNoteFromContainerDom(container) {
        if (!container) container = document;
        const allElements = container.querySelectorAll('*');
        for (let el of allElements) {
            const txt = (el.innerText || '').trim();
            // Check for explicit label elements
            if (/^(Transaction Note|Customer Note|Note|Remarks|Narration|Customer Message|Remarks\/Note)[:\s]*$/i.test(txt)) {
                const sibling = el.nextElementSibling || el.parentElement?.querySelector(':nth-child(2)');
                if (sibling) {
                    const candidate = cleanNoteCandidate(sibling.innerText || '');
                    if (candidate) return candidate;
                }
            }
            // Check for inline format: "Note: SomeNote"
            const match = txt.match(/(?:Transaction Note|Customer Note|Note|Remarks|Narration|Message)[\s:]+([^\n\r]+)/i);
            if (match && match[1]) {
                const candidate = cleanNoteCandidate(match[1]);
                if (candidate) return candidate;
            }
        }
        return '';
    }

    function extractPayerNameFromContainerDom(container) {
        if (!container) container = document;
        const allElements = container.querySelectorAll('*');
        for (let el of allElements) {
            const txt = (el.innerText || '').trim();
            if (/^(Paid By|Sender|Customer|Payer Name|From)[:\s]*$/i.test(txt)) {
                const sibling = el.nextElementSibling || el.parentElement?.querySelector(':nth-child(2)');
                if (sibling && sibling.innerText.trim()) {
                    const s = sibling.innerText.trim();
                    if (s.toLowerCase() !== 'customer' && s.length > 1) return s;
                }
            }
        }
        return 'Customer';
    }

    // =========================================================================
    // 7. OPEN NEW TRANSACTION & EXTRACT NOTE (REQUIREMENT 3)
    // =========================================================================
    async function openAndProcessTransaction(row, details) {
        const tid = details.txnId || details.unitId;
        if (!tid || currentlyOpeningTxns.has(tid)) return;
        currentlyOpeningTxns.add(tid);

        console.log(`🔓 [OPEN TRANSACTION] Opening details for new transaction: ${tid}...`);
        let note = ''; // Do NOT copy from cache; directly extract from opened transaction
        let payerName = details.payerName || 'Customer';
        let amount = details.amount || 0.0;
        let status = details.status || 'COMPLETED';
        let dateText = details.dateText || new Date().toLocaleString();

        // 1. Try to open transaction drawer/modal/page by clicking row or link
        let openedDrawer = null;
        try {
            const link = row.querySelector('a[href*="details/"]');
            const actionBtn = row.querySelector('[class*="arrow"], [class*="chevron"], [data-icon="right"], button, [class*="action"]');
            const cell1 = row.querySelectorAll('td')?.[1];

            if (link) {
                link.click();
            } else if (actionBtn) {
                actionBtn.click();
            } else if (cell1) {
                cell1.click();
            } else {
                row.click();
            }

            // Wait up to 1.8 seconds for drawer or modal to appear
            for (let i = 0; i < 9; i++) {
                await new Promise(r => setTimeout(r, 200));
                openedDrawer = document.querySelector('.ant-drawer.ant-drawer-open, .ant-drawer-content, .ant-modal, [role="dialog"], [class*="drawer-content"]');
                if (openedDrawer) break;
            }

            // If drawer opened, inspect its DOM for note and details
            if (openedDrawer) {
                console.log('✅ Drawer/Modal opened successfully! Extracting details from DOM...');
                const domNote = extractNoteFromContainerDom(openedDrawer);
                if (domNote) note = domNote;

                const domName = extractPayerNameFromContainerDom(openedDrawer);
                if (domName && domName !== 'Customer') payerName = domName;

                // Close the drawer so the UI remains clean
                const closeBtn = openedDrawer.querySelector('.ant-drawer-close, button[aria-label="Close"], .ant-modal-close, [data-icon="close"]');
                if (closeBtn) {
                    closeBtn.click();
                } else {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                }
            }
        } catch(e) {
            console.warn('⚠️ Error during open transaction click:', e);
        }

        // 2. Fallback: If note still not found, try internal API if unitId is available
        const fetchId = details.unitId || (details.txnId?.startsWith('AC') ? details.txnId : null);
        if (!note && fetchId) {
            try {
                const resp = await fetch(`https://web-api.phonepe.com/apis/mi-web/v3/transactions/unit/${fetchId}/details`, {
                    headers: { 'Accept': 'application/json' },
                    credentials: 'include'
                });
                if (resp.ok) {
                    const j = await resp.json();
                    if (j && j.data) {
                        const apiNote = extractNoteFromApiData(j.data);
                        if (apiNote) note = apiNote;
                        const apiName = extractPayerNameFromApiData(j.data);
                        if (apiName && apiName !== 'Customer') payerName = apiName;
                        if (j.data.amount) amount = j.data.amount / 100.0;
                        if (j.data.paymentState) status = j.data.paymentState;
                        if (j.data.transactionDate) dateText = String(j.data.transactionDate);
                    }
                }
            } catch(e) {}
        }

        // 3. Cache the note if found
        if (note) {
            if (details.txnId) notesCache[details.txnId] = note;
            if (details.unitId) notesCache[details.unitId] = note;
            persistDBCache();
            console.log(`📝 [NOTE EXTRACTED]: "${note}" for transaction ${tid}`);
        } else {
            console.log(`ℹ️ [NOTE CHECK]: Transaction ${tid} checked, note is empty.`);
        }

        // 4. Save to MySQL DB & Push to Interface
        if (details.txnId) knownDBTxnIds.add(details.txnId);
        if (details.unitId) knownDBTxnIds.add(details.unitId);
        persistDBCache();

        const payload = {
            event: "NEW_TRANSACTION",
            transaction_id: details.txnId || details.unitId,
            unit_id: details.unitId || details.txnId,
            operator_id: note || null,
            transaction_note: note || null,
            name: payerName,
            amount: amount,
            status: status,
            transaction_date: dateText,
            merchant_id: "M22EWXR72SBI3",
            details_url: `https://business.phonepe.com/dashboard/transactions/details/${details.unitId || details.txnId}`
        };

        pendingDBSaves++;
        try {
            await backendRequest('/api/v1/db/transaction/live', 'POST', payload);
            console.log(`💾 [DB & Interface Sync]: Saved ${tid} | Note: "${note || '—'}" | ₹${amount}`);
            showInPageToast(`✅ Saved to DB & Interface: ₹${amount} | Note: "${note || '—'}" (${payerName})`);
        } catch(err) {
            console.warn('⚠️ [DB Sync Error]:', err);
        } finally {
            pendingDBSaves = Math.max(0, pendingDBSaves - 1);
            currentlyOpeningTxns.delete(tid);
        }

        // Update the cell in PhonePe table
        if (row) {
            const noteCell = row.querySelector('.phonepe-txn-note-cell');
            if (noteCell) {
                if (note) {
                    noteCell.innerHTML = `
                        <div style="display:inline-flex; align-items:center; gap:6px; background:#f4edfc; border:1px solid #c084fc; padding:4px 10px; border-radius:6px; font-family:monospace; font-size:12px; font-weight:600; color:#5f259f; box-shadow:0 1px 3px rgba(95,37,159,0.1);">
                            <span>${note}</span>
                        </div>
                    `;
                } else {
                    noteCell.innerHTML = '<span style="color:#9ca3af; font-size:12px; font-style:italic;">—</span>';
                }
            }
        }
    }

    // =========================================================================
    // 8. LIVE TAB MONITOR: DETECT NEW TRANSACTION & NAVIGATE TO HISTORY
    // =========================================================================
    function scanLiveTabForNewTransactions() {
        if (getPageType() !== 'LIVE' || isNavigating) return;

        let foundNewTxnId = null;
        let foundLiveTime = '';
        const rows = document.querySelectorAll('tbody tr');
        for (let r of rows) {
            if (r.classList.contains('ant-table-placeholder') || r.querySelector('.ant-empty')) continue;
            const text = r.innerText.trim();
            if (/no data|no transactions|nothing to show/i.test(text)) continue;

            const link = r.querySelector('a[href*="details/"]');
            let id = '';
            if (link) {
                const m = link.href.match(/details\/([A-Za-z0-9_-]+)/);
                if (m) id = m[1];
            }
            if (!id) {
                const m2 = text.match(/\b(T2\d{16,}|AC\d{16,}|\d{12})\b/);
                if (m2) id = m2[1];
            }
            const tm = text.match(/\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)\b/);
            if (tm) foundLiveTime = tm[1];

            if (id && !knownDBTxnIds.has(id)) {
                foundNewTxnId = id;
                break;
            }
        }

        if (!foundNewTxnId) {
            const links = document.querySelectorAll('a[href*="details/"]');
            for (let l of links) {
                const m = l.href.match(/details\/([A-Za-z0-9_-]+)/);
                if (m && !knownDBTxnIds.has(m[1])) {
                    foundNewTxnId = m[1];
                    break;
                }
            }
        }

        if (foundNewTxnId) {
            isNavigating = true;
            console.log(`🚨 [Live Tab] Transaction detected on Live page: ${foundNewTxnId} | Time: ${foundLiveTime}! Navigating to History page to compare time & extract note...`);

            liveSyncChannel.postMessage({
                type: 'NEW_LIVE_TRANSACTION',
                txnId: foundNewTxnId,
                liveTime: foundLiveTime,
                timestamp: Date.now()
            });
            localStorage.setItem('phonepe_live_trigger_key', Date.now().toString());

            sessionStorage.setItem('phonepe_sync_after_live', 'true');
            sessionStorage.setItem('phonepe_live_detected_txn', foundNewTxnId);
            sessionStorage.setItem('phonepe_live_detected_time', foundLiveTime);
            sessionStorage.setItem('phonepe_refresh_attempts', '0'); // Start retry counter at 0

            showInPageToast(`⚡ Payment detected (${foundNewTxnId} at ${foundLiveTime || 'Live'})! Checking History page to open & get note...`);

            setTimeout(() => {
                window.location.href = HISTORY_URL;
            }, 400);
        }
    }

    // =========================================================================
    // 9. HISTORY PAGE: REFRESH RETRY (< 5 TIMES) OR MARK AS FAIL (REQUIREMENT 2)
    // =========================================================================
    function checkHistoryPageArrival() {
        if (getPageType() !== 'HISTORY') return;

        const justFromLive = sessionStorage.getItem('phonepe_sync_after_live');
        if (justFromLive !== 'true') return;

        const detectedTxn = sessionStorage.getItem('phonepe_live_detected_txn') || '';
        const detectedTime = sessionStorage.getItem('phonepe_live_detected_time') || '';
        let refreshAttempts = parseInt(sessionStorage.getItem('phonepe_refresh_attempts') || '0', 10);

        console.log(`📥 [History Page] Verifying detected payment: "${detectedTxn}" at time: "${detectedTime}" (Refresh attempt: ${refreshAttempts}/${MAX_REFRESH_ATTEMPTS})`);

        setTimeout(() => {
            const tableText = document.body.innerText;
            const table = document.querySelector('table');
            const hasTxnInTable = detectedTxn ? tableText.includes(detectedTxn) : (detectedTime ? tableText.includes(detectedTime) : (table && table.querySelectorAll('tbody tr').length > 0));

            if (!hasTxnInTable) {
                // Not found in table yet!
                if (refreshAttempts < MAX_REFRESH_ATTEMPTS) {
                    refreshAttempts++;
                    sessionStorage.setItem('phonepe_refresh_attempts', refreshAttempts.toString());
                    console.log(`🔄 [Refresh Retry] Attempt ${refreshAttempts} of ${MAX_REFRESH_ATTEMPTS}: Refreshing History page...`);
                    showInPageToast(`🔄 [${refreshAttempts}/${MAX_REFRESH_ATTEMPTS}] Refreshing to fetch new transaction...`);
                    setTimeout(() => {
                        window.location.reload();
                    }, 1200);
                    return;
                } else {
                    // REACHED MAX 4 REFRESHES WITHOUT FETCHING -> STOP AND MENTION AS FAIL!
                    console.warn(`❌ [FAIL] Transaction ${detectedTxn} could not be fetched after ${MAX_REFRESH_ATTEMPTS} refreshes. Mentioning as FAIL!`);
                    sessionStorage.removeItem('phonepe_sync_after_live');
                    sessionStorage.removeItem('phonepe_live_detected_txn');
                    sessionStorage.removeItem('phonepe_refresh_attempts');

                    const failTxnId = detectedTxn || `FAIL_${Date.now()}`;
                    knownDBTxnIds.add(failTxnId);
                    persistDBCache();

                    const failPayload = {
                        event: "NEW_TRANSACTION",
                        transaction_id: failTxnId,
                        unit_id: failTxnId,
                        operator_id: "FAIL (Could not fetch after 4 refreshes)",
                        transaction_note: "FAIL (Could not fetch after 4 refreshes)",
                        name: "Customer",
                        amount: 0.0,
                        status: "FAIL",
                        transaction_date: new Date().toLocaleString(),
                        merchant_id: "M22EWXR72SBI3",
                        details_url: ""
                    };

                    backendRequest('/api/v1/db/transaction/live', 'POST', failPayload);
                    showInPageToast(`❌ Transaction not fetched after 4 refreshes. Mentioned as FAIL in DB & Interface!`, false);

                    // Return to live tab after marking as fail
                    setTimeout(() => {
                        window.location.href = LIVE_URL;
                    }, 2500);
                    return;
                }
            }

            // Transaction is present! Reset refresh attempts and process table
            sessionStorage.removeItem('phonepe_refresh_attempts');
            showInPageToast(`✅ Transaction found in History! Opening to extract note...`);
            processTransactionsTable();

            // After opening & saving, cleanly return to Live tab to continue monitoring
            setTimeout(() => {
                sessionStorage.removeItem('phonepe_sync_after_live');
                sessionStorage.removeItem('phonepe_live_detected_txn');
                showInPageToast('✅ Synced to DB & Interface! Returning to Live tab...', true);
                setTimeout(() => {
                    window.location.href = LIVE_URL;
                }, 1500);
            }, 3000);

        }, 800);
    }

    // =========================================================================
    // 10. MAIN TABLE PROCESSOR & TRANSACTION NOTE COLUMN INJECTOR
    // =========================================================================
    function processTransactionsTable() {
        if (isTableProcessing) return;
        isTableProcessing = true;

        try {
            const page = getPageType();
            if (page === 'LIVE') {
                scanLiveTabForNewTransactions();
                return;
            }

            const table = document.querySelector('table');
            if (!table) return;

            // 1. Add "Transaction Note" Header Column if on History page and not present
            if (page === 'HISTORY') {
                const theadRow = table.querySelector('thead tr') || table.querySelector('tr');
                if (theadRow && !theadRow.querySelector('.phonepe-txn-note-header')) {
                    const th = document.createElement('th');
                    th.className = 'phonepe-txn-note-header';
                    th.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><span style="color:#ffd700;">📝</span><span>Transaction Note</span></div>';
                    th.style.cssText = 'background:#5f259f !important; color:#ffffff !important; font-weight:700 !important; font-size:13px !important; padding:12px 14px !important; text-align:left !important; border:1px solid #7c3aed !important; border-radius:6px !important; letter-spacing:0.5px; min-width:180px !important;';

                    const ths = theadRow.children;
                    if (ths.length >= 3) {
                        theadRow.insertBefore(th, ths[2]);
                    } else {
                        theadRow.appendChild(th);
                    }
                }
            }

            // 2. Iterate each row
            const rows = table.querySelectorAll('tbody tr');
            for (let r of rows) {
                if (r.children.length < 3) continue;

                const details = extractRowDetails(r);
                const txnId = details.txnId;
                const unitId = details.unitId;
                if (!txnId && !unitId) continue;

                const cachedNote = (txnId && notesCache[txnId]) || (unitId && notesCache[unitId]);
                const isFullySavedWithNote = cachedNote && ((txnId && knownDBTxnIds.has(txnId)) || (unitId && knownDBTxnIds.has(unitId)));

                // Inject or update Note cell in History table
                if (page === 'HISTORY') {
                    let noteCell = r.querySelector('.phonepe-txn-note-cell');
                    if (!noteCell) {
                        noteCell = document.createElement('td');
                        noteCell.className = 'phonepe-txn-note-cell';
                        noteCell.style.cssText = 'padding:10px 14px !important; vertical-align:middle !important;';

                        if (cachedNote) {
                            noteCell.innerHTML = `
                                <div style="display:inline-flex; align-items:center; gap:6px; background:#f4edfc; border:1px solid #c084fc; padding:4px 10px; border-radius:6px; font-family:monospace; font-size:12px; font-weight:600; color:#5f259f; box-shadow:0 1px 3px rgba(95,37,159,0.1);">
                                    <span>${cachedNote}</span>
                                </div>
                            `;
                        } else {
                            noteCell.innerHTML = '<span style="color:#9ca3af; font-size:12px; font-style:italic;">⏳ Checking...</span>';
                        }

                        const tds = r.children;
                        if (tds.length >= 3) {
                            r.insertBefore(noteCell, tds[2]);
                        } else {
                            r.appendChild(noteCell);
                        }
                    } else if (cachedNote && noteCell.innerText.includes('Checking')) {
                        noteCell.innerHTML = `
                            <div style="display:inline-flex; align-items:center; gap:6px; background:#f4edfc; border:1px solid #c084fc; padding:4px 10px; border-radius:6px; font-family:monospace; font-size:12px; font-weight:600; color:#5f259f; box-shadow:0 1px 3px rgba(95,37,159,0.1);">
                                <span>${cachedNote}</span>
                            </div>
                        `;
                    }
                }

                // If this transaction is NEW or MISSING ITS NOTE -> OPEN IT AND GET NOTE!
                if (!isFullySavedWithNote) {
                    openAndProcessTransaction(r, details);
                }
            }
        } finally {
            isTableProcessing = false;
        }
    }

    // =========================================================================
    // 11. FLOATING STATUS BADGE
    // =========================================================================
    function updateFloatingBadge() {
        let badge = document.getElementById('phonepe-auto-sync-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'phonepe-auto-sync-badge';
            badge.style.cssText = `
                position: fixed;
                bottom: 24px;
                left: 24px;
                z-index: 9999999;
                background: linear-gradient(135deg, #0f172a, #1e1b4b);
                color: #ffffff;
                padding: 10px 18px;
                border-radius: 30px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                font-weight: 600;
                box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.15);
                display: flex;
                align-items: center;
                gap: 12px;
                user-select: none;
            `;
            document.body.appendChild(badge);
        }

        const page = getPageType();
        if (page === 'LIVE') {
            badge.style.display = 'flex';
            badge.innerHTML = `
                <span style="display:inline-block; width:9px; height:9px; border-radius:50%; background:#ef4444; box-shadow:0 0 8px #ef4444;"></span>
                <span>🔴 Live Tab: <b style="color:#38bdf8;">MONITORING</b> (Waiting for payments)</span>
                <span style="background:rgba(255,255,255,0.18); padding:3px 8px; border-radius:12px; font-size:11px; cursor:pointer;" onclick="window.location.href='${HISTORY_URL}'">Go to History ➔</span>
            `;
        } else if (page === 'HISTORY') {
            badge.style.display = 'flex';
            const savingBadge = pendingDBSaves > 0 ? `<span style="background:#8b5cf6; padding:2px 6px; border-radius:8px; font-size:10px;">💾 Saving (${pendingDBSaves})...</span>` : '';
            badge.innerHTML = `
                <span style="display:inline-block; width:9px; height:9px; border-radius:50%; background:#22c55e; box-shadow:0 0 8px #22c55e;"></span>
                <span>📋 History Tab: <b style="color:#38bdf8;">ACTIVE</b></span>
                ${savingBadge}
                <button type="button" style="background:rgba(56,189,248,0.25); border:1px solid #38bdf8; color:#ffffff; padding:4px 9px; border-radius:12px; font-size:11px; font-weight:700; cursor:pointer;" onclick="window.location.reload()">↻ Refresh</button>
                <button type="button" style="background:#5f259f; border:1px solid #a855f7; color:#ffffff; padding:4px 10px; border-radius:12px; font-size:11px; font-weight:700; cursor:pointer;" onclick="window.location.href='${LIVE_URL}'">Go to Live Tab ➔</button>
            `;
        } else {
            badge.style.display = 'none';
        }
    }

    // Cross-tab events
    liveSyncChannel.onmessage = (event) => {
        if (event.data && event.data.type === 'NEW_LIVE_TRANSACTION') {
            if (getPageType() === 'HISTORY') {
                showInPageToast(`⚡ Payment detected on Live! Checking History table...`);
                setTimeout(() => window.location.reload(), 400);
            }
        }
    };

    window.addEventListener('storage', (e) => {
        if (e.key === 'phonepe_live_trigger_key' && getPageType() === 'HISTORY') {
            showInPageToast(`⚡ Payment detected! Checking History table...`);
            setTimeout(() => window.location.reload(), 400);
        }
    });

    // =========================================================================
    // 12. ROUTE & DOM OBSERVER
    // =========================================================================
    let debounceTimer = null;
    const observer = new MutationObserver((mutations) => {
        const hasRelevantChange = mutations.some(m => {
            return Array.from(m.addedNodes).some(node => {
                return node.nodeType === 1 && (node.tagName === 'TR' || node.tagName === 'TBODY' || node.querySelector?.('tr') || getPageType() === 'LIVE');
            });
        });

        if (hasRelevantChange) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (getPageType() === 'LIVE') {
                    scanLiveTabForNewTransactions();
                } else {
                    processTransactionsTable();
                }
            }, 300);
        }
    });

    function onRouteChanged() {
        console.log('🌐 [PhonePe Route]:', getPageType(), window.location.href);
        updateFloatingBadge();
        if (getPageType() === 'LIVE') {
            scanLiveTabForNewTransactions();
        } else if (getPageType() === 'HISTORY') {
            checkHistoryPageArrival();
            processTransactionsTable();
        }
    }

    const _pushState = history.pushState;
    history.pushState = function() {
        _pushState.apply(this, arguments);
        setTimeout(onRouteChanged, 200);
    };
    const _replaceState = history.replaceState;
    history.replaceState = function() {
        _replaceState.apply(this, arguments);
        setTimeout(onRouteChanged, 200);
    };
    window.addEventListener('popstate', onRouteChanged);

    // =========================================================================
    // 13. INITIALIZATION
    // =========================================================================
    function init() {
        preloadNotesFromDB();
        onRouteChanged();

        setInterval(() => {
            updateFloatingBadge();
            if (getPageType() === 'LIVE') {
                scanLiveTabForNewTransactions();
            }
        }, 1200);

        const target = document.querySelector('table') || document.body;
        observer.observe(target, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
