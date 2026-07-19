/**
 * SR Sales Monitor - Core Application Logic
 * Implements IndexedDB storage, WhatsApp DSR parser, calculations, and Chart.js UI bindings.
 */

// Application State
const state = {
    currentTab: 'overview',
    reports: [],
    settings: {
        prices: {
            bottles: 45.00,
            pouches: 8.3465,
            loose: 350.00
        },
        cartonSizes: {
            bottles: 24,
            pouches: 150,
            loose: 1
        },
        cloud: {
            supabaseUrl: '',
            supabaseKey: '',
            portalUrl: 'mobile-entry.html'
        }
    },
    phoneMappings: {}, // Matches normalized phone number to SR Name (e.g., "917777991045": "Kamini Parekh")
    salesRepsList: {
        "Kamini (Surat)": "Active",
        "Krish (Baroda)": "Active",
        "Jignesh Vadodariya (Rajkot)": "Active",
        "Bipin (AHM)": "Active",
        "Prakash (Vapi)": "Active",
        "Krunal (Vapi)": "Active"
    },
    parsedPreview: [], // Holds temporarily parsed records before confirming
    selectedRep: null, // Holds currently selected sales rep for detailed view
    selectedDistributor: null, // Holds currently selected distributor for detailed view
    charts: {
        salesTrend: null,
        repShare: null,
        repTrend: null,
        distTrend: null,
        beatComparison: null,
        momRevenue: null,
        momCategory: null
    }
};

// Database Configurations
const DB_NAME = 'SRSalesMonitorDB';
const DB_VERSION = 1;
let db = null;

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    initDatabase()
        .then(() => {
            loadSettings();
            loadPhoneMappings();
            loadSalesRepsList();
            return loadReportsFromDb();
        })
        .then(() => {
            initUI();
            updateDashboard();
        })
        .catch(err => {
            console.error('Database initialization failed:', err);
            alert('Could not initialize the database. Please reload or make sure cookies/local storage are enabled.');
        });
});

// ==========================================
// DATABASE MODULE (IndexedDB)
// ==========================================

function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = (e) => reject(e.target.error);
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve();
        };
        
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            
            // Create store for sales reports
            if (!database.objectStoreNames.contains('reports')) {
                const reportStore = database.createObjectStore('reports', { keyPath: 'id', autoIncrement: true });
                reportStore.createIndex('date', 'date', { unique: false });
                reportStore.createIndex('sender', 'sender', { unique: false });
                reportStore.createIndex('beat', 'beat', { unique: false });
            }
            
            // Create store for settings
            if (!database.objectStoreNames.contains('settings')) {
                database.createObjectStore('settings', { keyPath: 'key' });
            }
        };
    });
}

function loadSettings() {
    if (!db) return;
    const tx = db.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    
    const req = store.get('pricing_config');
    req.onsuccess = (e) => {
        if (e.target.result) {
            state.settings = e.target.result.value;
            
            // Backwards compatibility safety check
            if (!state.settings.cloud) {
                state.settings.cloud = {
                    supabaseUrl: '',
                    supabaseKey: '',
                    portalUrl: 'mobile-entry.html'
                };
            }
            
            // Update input values in DOM if they exist
            document.getElementById('price-bottles').value = state.settings.prices.bottles;
            document.getElementById('price-pouches').value = state.settings.prices.pouches;
            document.getElementById('price-loose').value = state.settings.prices.loose;
            
            document.getElementById('cloud-supabase-url').value = state.settings.cloud.supabaseUrl || '';
            document.getElementById('cloud-supabase-key').value = state.settings.cloud.supabaseKey || '';
            document.getElementById('cloud-portal-url').value = state.settings.cloud.portalUrl || 'mobile-entry.html';
            
            updateCloudSyncUI();
        }
    };
}

function saveSettingsToDb() {
    if (!db) return Promise.reject('No database connection');
    return new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        const store = tx.objectStore('settings');
        const req = store.put({ key: 'pricing_config', value: state.settings });
        
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
    });
}

function loadPhoneMappings() {
    if (!db) return;
    const tx = db.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    const req = store.get('phone_mappings');
    
    req.onsuccess = (e) => {
        if (e.target.result) {
            state.phoneMappings = e.target.result.value || {};
        } else {
            // Pre-populate default mappings requested by the user
            state.phoneMappings = {
                "9904022105": "Jignesh Vadodariya (Rajkot)",
                "8866730068": "Bipin (AHM)",
                "7777991045": "Kamini (Surat)",
                "9662666884": "Krish (Baroda)",
                "9033995424": "Krunal (Vapi)",
                "9408326006": "Prakash (Vapi)"
            };
            savePhoneMappingsToDb();
        }
        renderPhoneMappingsTable();
    };
}

function savePhoneMappingsToDb() {
    if (!db) return Promise.reject('No database connection');
    return new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        const store = tx.objectStore('settings');
        const req = store.put({ key: 'phone_mappings', value: state.phoneMappings });
        
        req.onsuccess = () => {
            renderPhoneMappingsTable();
            resolve();
        };
        req.onerror = (e) => reject(e.target.error);
    });
}

function normalizePhone(num) {
    if (num === null || num === undefined) return '';
    return String(num).replace(/[^\d]/g, '');
}

function lookupPhoneMapping(phoneStr) {
    if (!phoneStr || !state.phoneMappings) return null;
    const digits = String(phoneStr).replace(/[^\d]/g, '');
    if (digits.length < 10) return null;
    
    const last10 = digits.slice(-10);
    for (const key in state.phoneMappings) {
        const cleanKey = String(key).replace(/[^\d]/g, '');
        if (cleanKey.slice(-10) === last10) {
            return state.phoneMappings[key];
        }
    }
    return null;
}

function resolveRegisteredRepName(name) {
    if (name === null || name === undefined) return 'Unknown SR';
    const strName = String(name);
    const clean = strName.toLowerCase();
    
    // Normalize to digits for phone matching
    const digits = strName.replace(/[^\d]/g, '');
    
    if (clean.includes('jignesh') || clean.includes('vadodariya') || (digits.length >= 10 && digits.endsWith('9904022105'))) return 'Jignesh Vadodariya (Rajkot)';
    if (clean.includes('bipin') || (digits.length >= 10 && digits.endsWith('8866730068'))) return 'Bipin (AHM)';
    if (clean.includes('kamini') || (digits.length >= 10 && digits.endsWith('7777991045'))) return 'Kamini (Surat)';
    if (clean.includes('krish') || clean.includes('baroda') || (digits.length >= 10 && digits.endsWith('9662666884'))) return 'Krish (Baroda)';
    if (clean.includes('krunal') || (digits.length >= 10 && digits.endsWith('9033995424'))) return 'Krunal (Vapi)';
    if (clean.includes('prakash') || (digits.length >= 10 && digits.endsWith('9408326006'))) return 'Prakash (Vapi)';
    
    return strName;
}

function normalizeDistributorName(name) {
    if (!name) return 'Direct Retailer';
    const clean = String(name).trim();
    const lower = clean.toLowerCase();
    
    // Strip leading "Distributors . : " prefix or similar if present
    let raw = clean.replace(/^(?:distributor[s]?|distributo)[\s.:;=-]*/i, '').trim();
    const rawLower = raw.toLowerCase();
    
    if (rawLower.includes('egal') || rawLower.includes('egale')) {
        return 'Egal Marketing';
    }
    if (rawLower.includes('pooja')) {
        return 'Pooja Trading';
    }
    if (rawLower.includes('kalavati') || rawLower.includes('kalavti')) {
        return 'Kalavati Enterprises';
    }
    if (rawLower.includes('lavya')) {
        return 'Lavya Enterprises';
    }
    if (rawLower.includes('evergreen')) {
        return 'Evergreen Marketing';
    }
    if (rawLower.includes('sahkar') || rawLower.includes('shakar')) {
        return 'Sahkar Agency';
    }
    if (rawLower.includes('shifa') || rawLower.includes('seffa')) {
        return 'Shifa Agency';
    }
    if (rawLower.includes('devanshi') || rawLower.includes('divanshi') || rawLower.includes('divansi')) {
        return 'Devanshi Enterprises';
    }
    if (rawLower.includes('maa enterprise') || rawLower.includes('maa enterprises')) {
        return 'Maa Enterprises';
    }
    if (rawLower.includes('kanika')) {
        return 'Kanika Enterprises';
    }
    if (rawLower.includes('mango')) {
        return 'Mango Associates';
    }
    
    // Return capitalized title case as fallback
    return raw.replace(/\b\w/g, c => c.toUpperCase());
}

function loadReportsFromDb() {
    if (!db) return Promise.reject('No database connection');
    return new Promise((resolve, reject) => {
        const tx = db.transaction('reports', 'readonly');
        const store = tx.objectStore('reports');
        const req = store.getAll();
        
        req.onsuccess = (e) => {
            state.reports = e.target.result || [];
            // Sort reports chronologically
            state.reports.sort((a, b) => new Date(a.date) - new Date(b.date));
            populateFilterDropdowns();
            resolve();
        };
        req.onerror = (e) => reject(e.target.error);
    });
}

function saveReportsToDb(records) {
    if (!db) return Promise.reject('No database connection');
    return new Promise((resolve, reject) => {
        const tx = db.transaction('reports', 'readwrite');
        const store = tx.objectStore('reports');
        
        records.forEach(rec => {
            // Ensure fields are properly formatted
            rec.bottles = parseInt(rec.bottles) || 0;
            rec.pouches = parseInt(rec.pouches) || 0;
            rec.loose = parseInt(rec.loose) || 0;
            rec.value = parseFloat(rec.value) || 0;
            
            store.put(rec);
        });
        
        tx.oncomplete = () => {
            loadReportsFromDb().then(resolve);
        };
        tx.onerror = (e) => reject(e.target.error);
    });
}

function deleteReportFromDb(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('reports', 'readwrite');
        const store = tx.objectStore('reports');
        const req = store.delete(id);
        
        req.onsuccess = () => {
            loadReportsFromDb().then(resolve);
        };
        req.onerror = (e) => reject(e.target.error);
    });
}

function clearDatabase() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['reports', 'settings'], 'readwrite');
        tx.objectStore('reports').clear();
        tx.objectStore('settings').clear();
        
        tx.oncomplete = () => {
            state.reports = [];
            resolve();
        };
        tx.onerror = (e) => reject(e.target.error);
    });
}

// ==========================================
// WHATSAPP DSR REPORT PARSING ENGINE
// ==========================================

/**
 * Standardizes a raw line by removing formatting characters and price tags
 */
function cleanLineForParsing(line) {
    // Replace formatting characters with spaces to avoid joining words and numbers
    // e.g. "**Total Sachets*380*" -> "  Total Sachets 380 "
    let cleaned = line.replace(/[*_~]/g, ' ').trim();
    
    // Strip common price/mrp indicators that can confuse the quantity parser
    cleaned = cleaned.replace(/\bof\s+\d+\s*mrp\b/i, '');
    cleaned = cleaned.replace(/\bof\s+rs\.?\s*\d+\b/i, '');
    cleaned = cleaned.replace(/\bcount\b/i, '');
    cleaned = cleaned.replace(/\brs\.?\s*\d+\b/i, '');
    cleaned = cleaned.replace(/\b\d+\s*rs\b/i, '');
    cleaned = cleaned.replace(/\b\d+\s*mrp\b/i, '');
    cleaned = cleaned.replace(/\bof\s+\d+\b/i, ''); 
    
    return cleaned.trim();
}

/**
 * Parses date string in DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY, or formats with word months (e.g. 15-Jul-2026)
 * into ISO YYYY-MM-DD. Auto-detects 2-part dates (e.g. 25/05) and appends fallbackYear.
 */
function parseDateString(dateStr, fallbackYear = null) {
    if (!dateStr) return null;
    
    let cleaned = dateStr.replace(/[*_~]/g, '').trim();
    
    // Convert written month names (e.g. Jul, June, May) to numeric values
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const lower = cleaned.toLowerCase();
    for (let i = 0; i < months.length; i++) {
        if (lower.includes(months[i])) {
            cleaned = cleaned.replace(new RegExp('(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*', 'i'), i + 1);
            break;
        }
    }
    
    // Normalize delimiters (dots, spaces, slashes) to hyphens
    cleaned = cleaned.replace(/[\s./]+/g, '-');
    
    // Parse parts
    const parts = cleaned.split('-');
    if (parts.length === 3) {
        let p1 = parts[0];
        let p2 = parts[1];
        let p3 = parts[2];
        
        // YYYY-MM-DD
        if (p1.length === 4) {
            return `${p1}-${p2.padStart(2, '0')}-${p3.padStart(2, '0')}`;
        }
        
        // Assume DD-MM-YYYY or DD-MM-YY
        let year = p3;
        if (year.length === 2) year = '20' + year;
        return `${year}-${p2.padStart(2, '0')}-${p1.padStart(2, '0')}`;
    } else if (parts.length === 2) {
        // DD-MM (2-part date)
        let day = parts[0];
        let month = parts[1];
        let year = fallbackYear || new Date().getFullYear();
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    
    // Fallback native parse
    const p = Date.parse(dateStr);
    if (!isNaN(p)) {
        const d = new Date(p);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
    
    return null;
}

/**
 * Extracts a numeric quantity from a line if it contains the keyword
 */
function extractQtyFromLine(cleanLine, productCategory) {
    let keyRegex;
    let cartonRegex = /\b(?:pati|patis|box|boxes|carton|cartons|case|cases|ctn|ctns|patiya)\b/i;
    
    if (productCategory === 'bottles') {
        keyRegex = /\b(?:bottles?|btls?|bt|bot|jar|jars)\b/i;
    } else if (productCategory === 'pouches') {
        keyRegex = /\b(?:pouches?|pch|sachets?|sch|sac|pkt|pkts|packets?)\b/i;
    } else if (productCategory === 'loose') {
        keyRegex = /\b(?:loose|lse|ls|units?|items?|horeca)\b/i;
    } else {
        return 0;
    }
    
    const isCarton = cartonRegex.test(cleanLine);
    const hasCategory = keyRegex.test(cleanLine);
    
    // The line MUST contain the category keyword to match (avoids matching generic summary lines like "Total sales in cartons")
    if (!hasCategory) return 0;
    
    // Find all numbers in the line
    const numRegex = /\b\d[\d,]*\b/g;
    const matches = cleanLine.match(numRegex) || [];
    const numbers = matches.map(n => parseInt(n.replace(/,/g, ''))).filter(n => n > 0);
    
    if (numbers.length === 0) return 0;
    
    let qty = numbers[numbers.length - 1];
    
    // Handle carton conversion
    if (isCarton) {
        const multiplier = state.settings.cartonSizes[productCategory] || 1;
        qty = qty * multiplier;
    }
    
    return qty;
}

/**
 * Parses full exported WhatsApp chat txt. Extremely robust splitter.
 */
function parseDailyReportsText(text) {
    // Splits messages with dates in DD/MM/YYYY, M/D/YY, word months, etc.
    const messageSplitRegex = /\r?\n(?=\[?(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}[,\s]\s*\d{2,4})[, ]+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm)?\]?(?:\s*-\s*|\s*\]\s*))/i;
    const rawMessages = text.split(messageSplitRegex);
    const results = [];
    
    const metaRegex = /^\[?((?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}[,\s]\s*\d{2,4}))[, ]+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm)?)\]?(?:\s*-\s*|\s*\]\s*)([^:]+):\s*([\s\S]*)$/i;
    
    rawMessages.forEach(msg => {
        const trimMsg = msg.trim();
        if (!trimMsg) return;
        
        const match = trimMsg.match(metaRegex);
        if (!match) {
            // Check if it's an isolated single DSR text block
            if (trimMsg.toUpperCase().includes('DSR') || trimMsg.includes('Route') || trimMsg.includes('Bottles')) {
                parseSingleDsrBlock(trimMsg, null, null, results);
            }
            return;
        }
        
        const msgDateStr = match[1];
        const msgSender = match[3].trim();
        const msgBody = match[4].trim();
        
        // Extract year from message date string to use as fallbackYear
        let fallbackYear = new Date().getFullYear();
        const yearMatch = msgDateStr.match(/\b\d{2,4}$/);
        if (yearMatch) {
            let y = yearMatch[0];
            fallbackYear = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
        }
        
        // Filter out non-sales chat messages
        const isReport = msgBody.toUpperCase().includes('DSR') || 
                         msgBody.toLowerCase().includes('bottle') || 
                         msgBody.toLowerCase().includes('sachet') ||
                         msgBody.toLowerCase().includes('pouch') ||
                         msgBody.toLowerCase().includes('loose') ||
                         msgBody.toLowerCase().includes('route') ||
                         msgBody.toLowerCase().includes('beat');
                         
        if (isReport) {
            parseSingleDsrBlock(msgBody, msgDateStr, msgSender, results, fallbackYear);
        }
    });
    
    return results;
}

function parseSingleDsrBlock(bodyText, fallbackDateStr, fallbackSender, resultsArray, fallbackYear = null) {
    const lines = bodyText.split('\n');
    
    let date = parseDateString(fallbackDateStr, fallbackYear);
    
    // Resolve fallback sender if it maps to a name
    let sender = fallbackSender || 'Unknown SR';
    const mappedSender = lookupPhoneMapping(sender);
    if (mappedSender) {
        sender = mappedSender;
    }
    
    let beat = 'General Route';
    let distributor = '';
    let bottles = 0;
    let pouches = 0;
    let loose = 0;
    let reportedValue = 0;
    let hasSalesData = false;
    
    lines.forEach(line => {
        const cleanLine = cleanLineForParsing(line);
        if (!cleanLine) return;
        
        const lowerLine = cleanLine.toLowerCase();
        
        // Parse metadata inside DSR (avoid removing delimiters inside date/name/beat)
        if (lowerLine.includes('date')) {
            const dateVal = cleanLine.replace(/date/i, '').replace(/^[\s.:=-]+/g, '').trim();
            const parsed = parseDateString(dateVal, fallbackYear);
            if (parsed) date = parsed;
        }
        else if (lowerLine.includes('distributor')) {
            const distVal = cleanLine.replace(/distributor[s]?/i, '').replace(/name/i, '').replace(/^[\s.:=-]+/g, '').trim();
            if (distVal) distributor = distVal.replace(/\b\w/g, c => c.toUpperCase());
        }
        else if (lowerLine.includes('name')) {
            const nameVal = cleanLine.replace(/name/i, '').replace(/^[\s.:=-]+/g, '').trim();
            if (nameVal && nameVal.length > 1) {
                const mappedName = lookupPhoneMapping(nameVal);
                if (mappedName) {
                    sender = mappedName;
                } else {
                    sender = nameVal.replace(/\b\w/g, c => c.toUpperCase());
                }
            }
        }
        else if (lowerLine.includes('route') || lowerLine.includes('area') || lowerLine.includes('beat')) {
            const beatVal = cleanLine.replace(/(route|area|beat)/gi, '').replace(/or/i, '').replace(/^[\s.:=-]+/g, '').trim();
            if (beatVal) beat = beatVal.replace(/\b\w/g, c => c.toUpperCase());
        }
        else if (lowerLine.includes('value') || lowerLine.includes('amount')) {
            const valMatch = cleanLine.match(/\b\d[\d,]*(?:\.\d+)?\b/);
            if (valMatch) {
                reportedValue = parseFloat(valMatch[0].replace(/,/g, '')) || 0;
            }
        }
        
        // Parse Product Quantities
        const lineBottles = extractQtyFromLine(cleanLine, 'bottles');
        const linePouches = extractQtyFromLine(cleanLine, 'pouches');
        const lineLoose = extractQtyFromLine(cleanLine, 'loose');
        
        if (lineBottles > 0) { bottles += lineBottles; hasSalesData = true; }
        if (linePouches > 0) { pouches += linePouches; hasSalesData = true; }
        if (lineLoose > 0) { loose += lineLoose; hasSalesData = true; }
    });
    
    // Ensure we have a valid date
    if (!date) {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        date = `${y}-${m}-${day}`;
    }
    
    // Calculate total value based on current price config
    const value = (bottles * state.settings.prices.bottles) + 
                  (pouches * state.settings.prices.pouches) + 
                  (loose * state.settings.prices.loose);
                  
    // Resolve sender to registered SR name format if applicable
    sender = resolveRegisteredRepName(sender);
    
    if (hasSalesData || (bottles === 0 && pouches === 0 && loose === 0 && beat !== 'General Route')) {
        resultsArray.push({
            date,
            sender,
            beat,
            distributor: normalizeDistributorName(distributor) || 'Direct Retailer',
            bottles,
            pouches,
            loose,
            value,
            reportedValue,
            isValid: !!(date && sender && beat)
        });
    }
}

// ==========================================
// CALCULATIONS & STATISTICS ENGINE
// ==========================================

function filterReports(reports, dateRange, startDate, endDate) {
    if (dateRange === 'all') return reports;
    
    const now = new Date();
    let startLimit = null;
    let endLimit = null;
    
    if (dateRange === 'month') {
        startLimit = new Date(now.getFullYear(), now.getMonth(), 1);
        endLimit = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    } else if (dateRange === 'week') {
        // Start of current week (Monday)
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1);
        startLimit = new Date(now.setDate(diff));
        startLimit.setHours(0,0,0,0);
        endLimit = new Date(startLimit);
        endLimit.setDate(endLimit.getDate() + 6);
        endLimit.setHours(23,59,59,999);
    } else if (dateRange === 'custom') {
        if (startDate) {
            startLimit = new Date(startDate);
            startLimit.setHours(0,0,0,0);
        }
        if (endDate) {
            endLimit = new Date(endDate);
            endLimit.setHours(23,59,59,999);
        }
    }
    
    return reports.filter(r => {
        const d = new Date(r.date);
        if (startLimit && d < startLimit) return false;
        if (endLimit && d > endLimit) return false;
        return true;
    });
}

function calculateWoWChange(reportsList = state.reports) {
    if (reportsList.length === 0) return { bottles: 0, pouches: 0, loose: 0, value: 0 };
    
    // Group reports into Monday-to-Sunday weeks
    const getWeekBoundaries = (dateStr) => {
        const d = new Date(dateStr);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const start = new Date(d.setDate(diff));
        start.setHours(0,0,0,0);
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        end.setHours(23,59,59,999);
        return { start, end };
    };
    
    // Find latest date in reports
    let latestDate = new Date(0);
    reportsList.forEach(r => {
        const d = new Date(r.date);
        if (d > latestDate) latestDate = d;
    });
    
    if (latestDate.getTime() === 0) return { bottles: 0, pouches: 0, loose: 0, value: 0 };
    
    const curWeek = getWeekBoundaries(latestDate);
    const prevWeekStart = new Date(curWeek.start);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    const prevWeekEnd = new Date(curWeek.end);
    prevWeekEnd.setDate(prevWeekEnd.getDate() - 7);
    
    let curWeekSales = { bottles: 0, pouches: 0, loose: 0, value: 0, reportedValue: 0 };
    let prevWeekSales = { bottles: 0, pouches: 0, loose: 0, value: 0, reportedValue: 0 };
    
    reportsList.forEach(r => {
        const d = new Date(r.date);
        if (d >= curWeek.start && d <= curWeek.end) {
            curWeekSales.bottles += r.bottles;
            curWeekSales.pouches += r.pouches;
            curWeekSales.loose += r.loose;
            curWeekSales.value += r.value;
            curWeekSales.reportedValue += r.reportedValue || 0;
        } else if (d >= prevWeekStart && d <= prevWeekEnd) {
            prevWeekSales.bottles += r.bottles;
            prevWeekSales.pouches += r.pouches;
            prevWeekSales.loose += r.loose;
            prevWeekSales.value += r.value;
            prevWeekSales.reportedValue += r.reportedValue || 0;
        }
    });
    
    const calculatePct = (curr, prev) => {
        if (prev === 0) return curr > 0 ? 100 : 0;
        return ((curr - prev) / prev) * 100;
    };
    
    return {
        bottles: calculatePct(curWeekSales.bottles, prevWeekSales.bottles),
        pouches: calculatePct(curWeekSales.pouches, prevWeekSales.pouches),
        loose: calculatePct(curWeekSales.loose, prevWeekSales.loose),
        value: calculatePct(curWeekSales.value, prevWeekSales.value),
        reportedValue: calculatePct(curWeekSales.reportedValue, prevWeekSales.reportedValue)
    };
}

// Group sales by calendars weeks for Wow Comparison selectors
function getAvailableWeeks() {
    const weeksMap = new Map();
    
    state.reports.forEach(r => {
        const d = new Date(r.date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const start = new Date(d.setDate(diff));
        start.setHours(0,0,0,0);
        
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        
        const label = `${formatMinDate(start)} to ${formatMinDate(end)}`;
        const key = start.toISOString().substring(0, 10);
        
        weeksMap.set(key, { key, label, start, end });
    });
    
    // Sort reverse chronological
    return Array.from(weeksMap.values()).sort((a, b) => b.start - a.start);
}

function formatMinDate(d) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getDate()} ${months[d.getMonth()]}`;
}

// ==========================================
// UI & CONTROLLER HUB
// ==========================================

function initUI() {
    // 1. Tab Routing Event Listeners
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tab = item.getAttribute('data-tab');
            switchTab(tab);
        });
    });
    
    // 2. Global Filters Listeners
    const filterRange = document.getElementById('filter-date-range');
    const customDateCtrls = document.getElementById('custom-date-ctrls');
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    
    filterRange.addEventListener('change', () => {
        if (filterRange.value === 'custom') {
            customDateCtrls.classList.remove('hidden');
        } else {
            customDateCtrls.classList.add('hidden');
            updateDashboard();
        }
    });
    
    startDateInput.addEventListener('change', updateDashboard);
    endDateInput.addEventListener('change', updateDashboard);
    
    // Global filter listeners for Sales Rep and Month
    document.getElementById('filter-sales-rep').addEventListener('change', updateDashboard);
    document.getElementById('filter-month').addEventListener('change', updateDashboard);
    
    // Metric Selector in Dashboard Chart
    document.getElementById('overview-chart-metric').addEventListener('change', () => {
        updateDashboard();
    });
    
    // 3. File Dropzone & Uploader Setup
    const dropzone = document.getElementById('report-dropzone');
    const fileUploader = document.getElementById('file-uploader');
    const btnBrowse = document.getElementById('btn-browse-file');
    
    btnBrowse.addEventListener('click', () => fileUploader.click());
    
    fileUploader.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileUpload(e.target.files[0]);
        }
    });
    
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    
    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });
    
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleFileUpload(e.dataTransfer.files[0]);
        }
    });
    
    // Save/Discard parsed previews buttons
    document.getElementById('btn-clear-preview').addEventListener('click', discardPreview);
    document.getElementById('btn-save-all-parsed').addEventListener('click', savePreviewToDb);
    
    // Modal actions
    document.getElementById('btn-modal-close').addEventListener('click', closeModal);
    document.getElementById('btn-edit-cancel').addEventListener('click', closeModal);
    document.getElementById('btn-edit-save').addEventListener('click', saveRecordEdits);
    
    // Rep Search
    document.getElementById('rep-search-input').addEventListener('input', renderRepsLeaderboard);
    
    // Distributor Search
    document.getElementById('dist-search-input').addEventListener('input', renderDistributorsLeaderboard);
    
    // WoW selectors
    document.getElementById('wow-week-a').addEventListener('change', updateWoWBeatComparison);
    document.getElementById('wow-week-b').addEventListener('change', updateWoWBeatComparison);
    
    // Settings pricing config
    document.getElementById('btn-save-prices').addEventListener('click', savePricesSetting);
    
    // Cloud configuration and sync listeners
    document.getElementById('btn-save-cloud-config').addEventListener('click', saveCloudConfigSetting);
    document.getElementById('btn-sync-cloud').addEventListener('click', syncCloudSubmissions);
    
    // Settings DB Tools
    document.getElementById('btn-generate-mock').addEventListener('click', generateMockData);
    document.getElementById('btn-export-json').addEventListener('click', exportDatabaseToJson);
    document.getElementById('btn-reset-db').addEventListener('click', resetApplicationDatabase);
    
    // Settings Phone Mappings Master Form
    document.getElementById('phone-mapping-form').addEventListener('submit', handlePhoneMappingSubmit);
    
    // Settings Sales Reps Registry Management
    document.getElementById('add-rep-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('reg-rep-name');
        const name = input.value.trim();
        if (!name) return;
        
        if (state.salesRepsList[name]) {
            alert('This representative is already in the registry!');
            return;
        }
        
        state.salesRepsList[name] = 'Active';
        saveSalesRepsListToDb().then(() => {
            syncSingleRepToSupabase(name, 'Active');
            input.value = '';
        });
    });
    
    document.getElementById('btn-sync-reps-cloud').addEventListener('click', syncAllRepsToSupabase);
    
    // Refresh Insights button
    const btnRefresh = document.getElementById('btn-refresh-insights');
    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => generateSmartInsights());
    }
    
    // Initialize Lucide Icons
    lucide.createIcons();
}

function switchTab(tabName) {
    state.currentTab = tabName;
    
    // Update navigation UI
    document.querySelectorAll('.nav-item').forEach(item => {
        if (item.getAttribute('data-tab') === tabName) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    // Update panes UI
    document.querySelectorAll('.tab-pane').forEach(pane => {
        if (pane.id === `pane-${tabName}`) {
            pane.classList.add('active');
        } else {
            pane.classList.remove('active');
        }
    });
    
    // Update Tab Header text
    const titleText = {
        overview: 'Overview Dashboard',
        upload: 'Extract & Upload Hub',
        reps: 'Sales Representative Performance',
        distributors: 'Distributors Supply Hub',
        beats: 'Beat Week-on-Week Analysis',
        trends: 'Month-on-Month trends',
        insights: 'Sales Intelligence & Smart Insights',
        settings: 'Settings & Configurations'
    };
    
    document.getElementById('main-title').textContent = titleText[tabName] || 'Workspace';
    document.getElementById('tab-indicator').textContent = tabName.toUpperCase();
    
    // Hide global filters in tabs where it doesn't make sense (like upload, settings, insights)
    const filters = document.getElementById('global-filters');
    if (tabName === 'upload' || tabName === 'settings' || tabName === 'insights') {
        filters.classList.add('hidden');
    } else {
        filters.classList.remove('hidden');
    }
    
    // Perform tab-specific refreshes
    if (tabName === 'overview') {
        updateDashboard();
    } else if (tabName === 'reps') {
        renderRepsLeaderboard();
    } else if (tabName === 'distributors') {
        renderDistributorsLeaderboard();
    } else if (tabName === 'beats') {
        renderBeatsWoWFilters();
    } else if (tabName === 'trends') {
        renderMoMTrends();
    } else if (tabName === 'insights') {
        generateSmartInsights();
    }
}

// ==========================================
// FILE HANDLER & PREVIEW RENDER
// ==========================================

function handleFileUpload(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        const parsed = parseDailyReportsText(text);
        
        if (parsed.length === 0) {
            alert('No sales reports could be extracted from this text file. Please ensure the file has daily sales report format details.');
            return;
        }
        
        state.parsedPreview = parsed;
        renderParsedPreviewTable();
    };
    reader.readAsText(file);
}

function renderParsedPreviewTable() {
    const container = document.getElementById('parsed-records-container');
    const previewSection = document.getElementById('preview-section');
    const countSpan = document.getElementById('parsed-count');
    
    countSpan.textContent = state.parsedPreview.length;
    container.innerHTML = '';
    
    state.parsedPreview.forEach((rec, idx) => {
        const div = document.createElement('div');
        div.className = `preview-record-item ${rec.isValid ? '' : 'invalid'}`;
        
        // Compute individual valuation
        const recVal = (rec.bottles * state.settings.prices.bottles) + 
                       (rec.pouches * state.settings.prices.pouches) + 
                       (rec.loose * state.settings.prices.loose);
        
        div.innerHTML = `
            <div class="preview-record-header">
                <span class="preview-record-title">${rec.sender} (${rec.date})</span>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <span class="preview-record-badge ${rec.isValid ? 'badge-success' : 'btn-danger'}" style="padding: 0.15rem 0.4rem;">
                        ${rec.isValid ? 'Valid' : 'Incomplete'}
                    </span>
                    <button class="btn btn-secondary btn-sm" onclick="openEditRecordModal(${idx})" style="padding: 0.15rem 0.4rem;">
                        <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i> Edit
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteParsedPreviewItem(${idx})" style="padding: 0.15rem 0.4rem;">
                        <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
                    </button>
                </div>
            </div>
            <div class="preview-record-grid">
                <div><span style="color: var(--text-muted); font-size: 0.75rem;">Beat:</span> <strong style="font-size: 0.85rem;">${rec.beat}</strong></div>
                <div><span style="color: var(--text-muted); font-size: 0.75rem;">Bottles:</span> <strong>${rec.bottles}</strong></div>
                <div><span style="color: var(--text-muted); font-size: 0.75rem;">Pouches:</span> <strong>${rec.pouches}</strong></div>
                <div><span style="color: var(--text-muted); font-size: 0.75rem;">Loose:</span> <strong>${rec.loose}</strong></div>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">
                Distributor: <strong>${rec.distributor || 'Direct'}</strong> | Estimated Value: <strong class="text-emerald">₹${recVal.toFixed(2)}</strong>
            </div>
        `;
        container.appendChild(div);
    });
    
    previewSection.classList.remove('hidden');
    
    // Set warning banner if there are invalid records
    const alertBox = document.getElementById('preview-alert-container');
    const invalidCount = state.parsedPreview.filter(r => !r.isValid).length;
    
    if (invalidCount > 0) {
        alertBox.innerHTML = `
            <div class="alert-banner alert-banner-warning">
                <i data-lucide="alert-triangle" style="flex-shrink:0;"></i>
                <div>
                    <strong>Attention:</strong> There are <strong>${invalidCount}</strong> records missing critical fields (like Date, Beat, or Rep Name). We have set fallback defaults. Please click the <strong>Edit</strong> button on those items to fix details before saving.
                </div>
            </div>
        `;
    } else {
        alertBox.innerHTML = '';
    }
    
    lucide.createIcons();
    // Show badge next to upload tab
    document.getElementById('pending-badge').classList.remove('hidden');
}

window.deleteParsedPreviewItem = function(idx) {
    state.parsedPreview.splice(idx, 1);
    if (state.parsedPreview.length === 0) {
        discardPreview();
    } else {
        renderParsedPreviewTable();
    }
};

function discardPreview() {
    state.parsedPreview = [];
    document.getElementById('preview-section').classList.add('hidden');
    document.getElementById('pending-badge').classList.add('hidden');
    document.getElementById('file-uploader').value = '';
}

function savePreviewToDb() {
    if (state.parsedPreview.length === 0) return;
    
    saveReportsToDb(state.parsedPreview)
        .then(() => {
            const count = state.parsedPreview.length;
            discardPreview();
            alert(`Successfully saved ${count} reports to database!`);
            switchTab('overview');
        })
        .catch(err => {
            alert('Failed to save records: ' + err);
        });
}

// Modal handling
window.openEditRecordModal = function(idx) {
    const rec = state.parsedPreview[idx];
    document.getElementById('edit-rec-index').value = idx;
    document.getElementById('edit-rec-date').value = rec.date;
    document.getElementById('edit-rec-sender').value = rec.sender;
    document.getElementById('edit-rec-beat').value = rec.beat;
    document.getElementById('edit-rec-distributor').value = rec.distributor;
    document.getElementById('edit-rec-bottles').value = rec.bottles;
    document.getElementById('edit-rec-pouches').value = rec.pouches;
    document.getElementById('edit-rec-loose').value = rec.loose;
    document.getElementById('edit-rec-reported-value').value = rec.reportedValue || 0;
    
    document.getElementById('edit-record-modal').classList.add('active');
};

function closeModal() {
    document.getElementById('edit-record-modal').classList.remove('active');
}

function saveRecordEdits(e) {
    e.preventDefault();
    const idx = parseInt(document.getElementById('edit-rec-index').value);
    if (isNaN(idx)) return;
    
    const edited = {
        date: document.getElementById('edit-rec-date').value,
        sender: document.getElementById('edit-rec-sender').value.trim(),
        beat: document.getElementById('edit-rec-beat').value.trim(),
        distributor: document.getElementById('edit-rec-distributor').value.trim(),
        bottles: parseInt(document.getElementById('edit-rec-bottles').value) || 0,
        pouches: parseInt(document.getElementById('edit-rec-pouches').value) || 0,
        loose: parseInt(document.getElementById('edit-rec-loose').value) || 0,
        reportedValue: parseFloat(document.getElementById('edit-rec-reported-value').value) || 0
    };
    
    // Validate
    edited.isValid = !!(edited.date && edited.sender && edited.beat);
    edited.value = (edited.bottles * state.settings.prices.bottles) + 
                   (edited.pouches * state.settings.prices.pouches) + 
                   (edited.loose * state.settings.prices.loose);
                   
    state.parsedPreview[idx] = edited;
    
    closeModal();
    renderParsedPreviewTable();
}

// ==========================================
// RENDER TAB: OVERVIEW DASHBOARD
// ==========================================

function updateDashboard() {
    const range = document.getElementById('filter-date-range').value;
    const start = document.getElementById('start-date').value;
    const end = document.getElementById('end-date').value;
    const selectedRep = document.getElementById('filter-sales-rep').value;
    const selectedMonth = document.getElementById('filter-month').value;
    
    let filtered = filterReports(state.reports, range, start, end);
    
    // Apply sales rep filter (with defensive name resolution)
    if (selectedRep !== 'all') {
        filtered = filtered.filter(r => resolveRegisteredRepName(r.sender) === selectedRep);
    }
    // Apply Month filter
    if (selectedMonth !== 'all') {
        filtered = filtered.filter(r => r.date && r.date.startsWith(selectedMonth));
    }
    
    // Sum stats
    let totalBottles = 0;
    let totalPouches = 0;
    let totalLoose = 0;
    let totalValue = 0;
    let totalReportedValue = 0;
    
    filtered.forEach(r => {
        totalBottles += r.bottles;
        totalPouches += r.pouches;
        totalLoose += r.loose;
        totalValue += r.value;
        totalReportedValue += r.reportedValue || 0;
    });
    
    // Update counters in UI
    document.getElementById('stat-total-value').textContent = `₹${totalValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    const reportedEl = document.getElementById('stat-reported-value');
    if (reportedEl) {
        reportedEl.textContent = `₹${totalReportedValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    
    const diff = totalValue - totalReportedValue;
    const diffLabel = document.getElementById('stat-discrepancy-label');
    if (diffLabel) {
        if (Math.abs(diff) > 0.01) {
            diffLabel.textContent = `Discrepancy: ₹${diff.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            diffLabel.style.color = '#ef4444'; // Red color for discrepancy
        } else {
            diffLabel.textContent = `Match: No Discrepancy`;
            diffLabel.style.color = '#10b981'; // Green color for matching
        }
    }
    
    document.getElementById('stat-total-bottles').textContent = totalBottles.toLocaleString('en-IN');
    document.getElementById('stat-total-pouches').textContent = totalPouches.toLocaleString('en-IN');
    document.getElementById('stat-total-loose').textContent = totalLoose.toLocaleString('en-IN');
    
    // Filter WoW reports by sales rep
    let wowReports = state.reports;
    if (selectedRep !== 'all') {
        wowReports = wowReports.filter(r => resolveRegisteredRepName(r.sender) === selectedRep);
    }
    
    // Calculate WoW indicators
    const wow = calculateWoWChange(wowReports);
    updateWoWIndicator(document.getElementById('value-trend'), wow.value);
    
    const reportedTrendEl = document.getElementById('reported-value-trend');
    if (reportedTrendEl) {
        updateWoWIndicator(reportedTrendEl, wow.reportedValue);
    }
    
    updateWoWIndicator(document.getElementById('bottles-trend'), wow.bottles);
    updateWoWIndicator(document.getElementById('pouches-trend'), wow.pouches);
    updateWoWIndicator(document.getElementById('loose-trend'), wow.loose);
    
    // Render charts (Sales Rep Leaderboard doughnut chart is removed)
    renderSalesTrendChart(filtered);
    
    // Render recent reports table (safely guarded)
    renderRecentReportsTable(filtered);
}

function populateFilterDropdowns() {
    const repSelect = document.getElementById('filter-sales-rep');
    const monthSelect = document.getElementById('filter-month');
    if (!repSelect || !monthSelect) return;
    
    const currentRep = repSelect.value;
    const currentMonth = monthSelect.value;
    
    // 1. Populate Sales Reps (Strictly only the 6 registered ones)
    const REGISTERED_REPS = [
        'Jignesh Vadodariya (Rajkot)',
        'Bipin (AHM)',
        'Kamini (Surat)',
        'Krish (Baroda)',
        'Krunal (Vapi)',
        'Prakash (Vapi)'
    ];
    
    repSelect.innerHTML = '<option value="all">All Sales Reps</option>';
    REGISTERED_REPS.forEach(rep => {
        const opt = document.createElement('option');
        opt.value = rep;
        opt.textContent = rep;
        if (rep === currentRep) opt.selected = true;
        repSelect.appendChild(opt);
    });
    
    // 2. Populate Months dynamically based on reports dates
    const monthsSet = new Set();
    state.reports.forEach(r => {
        if (r.date && r.date.length >= 7) {
            const monthKey = r.date.substring(0, 7); // e.g. "2026-07"
            monthsSet.add(monthKey);
        }
    });
    
    const sortedMonths = Array.from(monthsSet).sort().reverse();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    monthSelect.innerHTML = '<option value="all">All Months</option>';
    sortedMonths.forEach(m => {
        const parts = m.split('-');
        const year = parts[0];
        const monthIdx = parseInt(parts[1]) - 1;
        const label = `${monthNames[monthIdx]} ${year}`;
        
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = label;
        if (m === currentMonth) opt.selected = true;
        monthSelect.appendChild(opt);
    });
}

function updateWoWIndicator(element, change) {
    if (change === 0) {
        element.className = 'stat-indicator trend-neutral';
        element.innerHTML = `<i data-lucide="minus"></i> <span>0% WoW change</span>`;
    } else if (change > 0) {
        element.className = 'stat-indicator trend-up';
        element.innerHTML = `<i data-lucide="trending-up"></i> <span>+${change.toFixed(1)}% WoW vs last week</span>`;
    } else {
        element.className = 'stat-indicator trend-down';
        element.innerHTML = `<i data-lucide="trending-down"></i> <span>${change.toFixed(1)}% WoW vs last week</span>`;
    }
    lucide.createIcons();
}

function renderSalesTrendChart(filteredData = state.reports) {
    const ctx = document.getElementById('chart-sales-trend').getContext('2d');
    const metric = document.getElementById('overview-chart-metric').value;
    
    if (state.charts.salesTrend) state.charts.salesTrend.destroy();
    
    // Group reports by date
    const dateMap = new Map();
    filteredData.forEach(r => {
        const dateKey = r.date;
        if (!dateMap.has(dateKey)) {
            dateMap.set(dateKey, { bottles: 0, pouches: 0, loose: 0, value: 0 });
        }
        const counts = dateMap.get(dateKey);
        counts.bottles += r.bottles;
        counts.pouches += r.pouches;
        counts.loose += r.loose;
        counts.value += r.value;
    });
    
    const dates = Array.from(dateMap.keys()).sort((a, b) => new Date(a) - new Date(b));
    
    const datasets = [];
    const colorBottles = '#06b6d4';
    const colorPouches = '#10b981';
    const colorLoose = '#8b5cf6';
    
    if (metric === 'volume') {
        const bottlesData = [];
        const pouchesData = [];
        const looseData = [];
        dates.forEach(d => {
            const counts = dateMap.get(d);
            bottlesData.push(counts.bottles);
            pouchesData.push(counts.pouches);
            looseData.push(counts.loose);
        });
        datasets.push(
            { label: 'Bottles', data: bottlesData, borderColor: colorBottles, backgroundColor: 'rgba(6, 182, 212, 0.1)', borderWidth: 2, tension: 0.3, fill: true },
            { label: 'Pouches', data: pouchesData, borderColor: colorPouches, backgroundColor: 'rgba(16, 185, 129, 0.1)', borderWidth: 2, tension: 0.3, fill: true },
            { label: 'Loose', data: looseData, borderColor: colorLoose, backgroundColor: 'rgba(139, 92, 246, 0.1)', borderWidth: 2, tension: 0.3, fill: true }
        );
    } else if (metric === 'value') {
        const bottlesRev = [];
        const pouchesRev = [];
        const looseRev = [];
        dates.forEach(d => {
            const counts = dateMap.get(d);
            bottlesRev.push(counts.bottles * state.settings.prices.bottles);
            pouchesRev.push(counts.pouches * state.settings.prices.pouches);
            looseRev.push(counts.loose * state.settings.prices.loose);
        });
        datasets.push(
            { label: 'Bottles Revenue', data: bottlesRev, borderColor: colorBottles, backgroundColor: 'rgba(6, 182, 212, 0.1)', borderWidth: 2, tension: 0.3, fill: true },
            { label: 'Pouches Revenue', data: pouchesRev, borderColor: colorPouches, backgroundColor: 'rgba(16, 185, 129, 0.1)', borderWidth: 2, tension: 0.3, fill: true },
            { label: 'Loose Revenue', data: looseRev, borderColor: colorLoose, backgroundColor: 'rgba(139, 92, 246, 0.1)', borderWidth: 2, tension: 0.3, fill: true }
        );
    } else if (metric === 'bottles') {
        const data = [];
        dates.forEach(d => data.push(dateMap.get(d).bottles));
        datasets.push({ label: 'Bottles Qty', data: data, borderColor: colorBottles, backgroundColor: 'rgba(6, 182, 212, 0.1)', borderWidth: 2, tension: 0.3, fill: true });
    } else if (metric === 'pouches') {
        const data = [];
        dates.forEach(d => data.push(dateMap.get(d).pouches));
        datasets.push({ label: 'Pouches Qty', data: data, borderColor: colorPouches, backgroundColor: 'rgba(16, 185, 129, 0.1)', borderWidth: 2, tension: 0.3, fill: true });
    } else if (metric === 'loose') {
        const data = [];
        dates.forEach(d => data.push(dateMap.get(d).loose));
        datasets.push({ label: 'Loose Qty', data: data, borderColor: colorLoose, backgroundColor: 'rgba(139, 92, 246, 0.1)', borderWidth: 2, tension: 0.3, fill: true });
    }
    
    // Format dates for line labels
    const formattedLabels = dates.map(d => {
        const parts = d.split('-');
        if (parts.length === 3) return `${parts[2]}/${parts[1]}`;
        return d;
    });
    
    state.charts.salesTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: formattedLabels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#94a3b8', font: { family: 'Inter' } }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#64748b' }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#64748b' }
                }
            }
        }
    });
}

function renderRepLeaderboardChart(filteredData = state.reports) {
    const ctx = document.getElementById('chart-rep-share').getContext('2d');
    if (state.charts.repShare) state.charts.repShare.destroy();
    
    const REGISTERED_REPS = [
        'Jignesh Vadodariya (Rajkot)',
        'Bipin (AHM)',
        'Kamini (Surat)',
        'Krish (Baroda)',
        'Krunal (Vapi)',
        'Prakash (Vapi)'
    ];
    
    // Calculate rep sales value strictly for the 6 registered reps
    const repMap = new Map();
    REGISTERED_REPS.forEach(rep => {
        repMap.set(rep, 0);
    });
    
    filteredData.forEach(r => {
        if (repMap.has(r.sender)) {
            repMap.set(r.sender, repMap.get(r.sender) + r.value);
        }
    });
    
    // Only show reps that have non-zero sales, or keep all of them. Keeping non-zero sales is cleaner for a share doughnut chart!
    const sortedReps = Array.from(repMap.entries())
        .filter(r => r[1] > 0)
        .sort((a,b) => b[1] - a[1]);
    
    const labels = sortedReps.map(r => r[0]);
    const data = sortedReps.map(r => r[1]);
    
    const colors = [
        '#6366f1', '#06b6d4', '#10b981', '#8b5cf6', '#f59e0b', '#f43f5e', '#ec4899', '#14b8a6'
    ];
    
    state.charts.repShare = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: colors.slice(0, labels.length),
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: { color: '#94a3b8', boxWidth: 12, font: { family: 'Inter' } }
                }
            }
        }
    });
}

function renderRecentReportsTable(filteredData) {
    const tbody = document.querySelector('#dashboard-recent-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const recent = [...filteredData].reverse().slice(0, 10);
    
    if (recent.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align: center; color: var(--text-muted);">No reports match the selected filters.</td>
            </tr>
        `;
        return;
    }
    
    recent.forEach(r => {
        const tr = document.createElement('tr');
        const repVal = r.reportedValue || 0;
        const diff = repVal - r.value;
        const absDiff = Math.abs(diff);
        
        let discrepancyHtml = '';
        if (absDiff < 0.01) {
            discrepancyHtml = `<span class="text-emerald" style="display: inline-flex; align-items: center; gap: 0.25rem;"><i data-lucide="check" style="width: 14px; height: 14px;"></i> Match</span>`;
        } else {
            discrepancyHtml = `<span class="text-rose" style="display: inline-flex; align-items: center; gap: 0.25rem; font-weight: 600;"><i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i> ₹${diff.toFixed(2)}</span>`;
        }
        
        tr.innerHTML = `
            <td>${r.date}</td>
            <td><span class="sr-link" onclick="viewRepFromLink('${r.sender}')">${r.sender}</span></td>
            <td>${r.beat}</td>
            <td>${r.bottles}</td>
            <td>${r.pouches}</td>
            <td>${r.loose}</td>
            <td class="text-indigo">₹${r.value.toFixed(2)}</td>
            <td class="text-cyan">₹${repVal.toFixed(2)}</td>
            <td>${discrepancyHtml}</td>
        `;
        tbody.appendChild(tr);
    });
    
    lucide.createIcons();
}

window.viewRepFromLink = function(name) {
    state.selectedRep = resolveRegisteredRepName(name);
    switchTab('reps');
};

// ==========================================
// RENDER TAB: SALES REP PERFORMANCE HUB
// ==========================================

function renderRepsLeaderboard() {
    const query = document.getElementById('rep-search-input').value.toLowerCase();
    const tbody = document.querySelector('#rep-leaderboard-table tbody');
    tbody.innerHTML = '';
    
    // Group records strictly for the 6 registered reps
    const REGISTERED_REPS = [
        'Jignesh Vadodariya (Rajkot)',
        'Bipin (AHM)',
        'Kamini (Surat)',
        'Krish (Baroda)',
        'Krunal (Vapi)',
        'Prakash (Vapi)'
    ];
    
    const repMap = new Map();
    REGISTERED_REPS.forEach(rep => {
        repMap.set(rep, { bottles: 0, pouches: 0, loose: 0, value: 0, count: 0 });
    });
    
    state.reports.forEach(r => {
        const resolvedSender = resolveRegisteredRepName(r.sender);
        if (repMap.has(resolvedSender)) {
            const data = repMap.get(resolvedSender);
            data.bottles += r.bottles;
            data.pouches += r.pouches;
            data.loose += r.loose;
            data.value += r.value;
            data.count++;
        }
    });
    
    let sortedReps = Array.from(repMap.entries()).sort((a,b) => b[1].value - a[1].value);
    
    if (query) {
        sortedReps = sortedReps.filter(entry => entry[0].toLowerCase().includes(query));
    }
    
    if (sortedReps.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" style="text-align: center; color: var(--text-muted);">No reps found.</td></tr>`;
        return;
    }
    
    sortedReps.forEach(entry => {
        const name = entry[0];
        const val = entry[1].value;
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        if (state.selectedRep === name) tr.style.backgroundColor = 'rgba(99,102,241,0.06)';
        
        tr.innerHTML = `
            <td><strong style="color: ${state.selectedRep === name ? 'var(--accent-indigo)' : 'var(--text-primary)'}">${name}</strong></td>
            <td style="text-align: right;" class="text-emerald">₹${val.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
        `;
        
        tr.addEventListener('click', () => {
            selectRep(name);
            // Highlight row
            document.querySelectorAll('#rep-leaderboard-table tbody tr').forEach(r => r.style.backgroundColor = '');
            tr.style.backgroundColor = 'rgba(99,102,241,0.06)';
        });
        
        tbody.appendChild(tr);
    });
    
    // If a rep was previously selected (or is first time), render detail view safely
    const resolvedSelected = state.selectedRep ? resolveRegisteredRepName(state.selectedRep) : null;
    if (resolvedSelected && repMap.has(resolvedSelected)) {
        renderRepDetail(resolvedSelected, repMap.get(resolvedSelected));
    } else if (sortedReps.length > 0) {
        // Auto select first rep
        selectRep(sortedReps[0][0]);
    }
}

function selectRep(name) {
    state.selectedRep = name;
    // Highlight list
    renderRepsLeaderboard();
}

function renderRepDetail(name, summary) {
    document.getElementById('rep-detail-placeholder').classList.add('hidden');
    const content = document.getElementById('rep-detail-content');
    content.classList.remove('hidden');
    
    document.getElementById('detail-rep-name').textContent = name;
    document.getElementById('detail-rep-status').classList.remove('hidden');
    
    document.getElementById('detail-rep-revenue').textContent = `₹${summary.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('detail-rep-bottles').textContent = summary.bottles.toLocaleString('en-IN');
    document.getElementById('detail-rep-pouches').textContent = summary.pouches.toLocaleString('en-IN');
    document.getElementById('detail-rep-loose').textContent = summary.loose.toLocaleString('en-IN');
    
    // History table
    const repReports = state.reports.filter(r => resolveRegisteredRepName(r.sender) === name).reverse();
    const tbody = document.querySelector('#rep-history-table tbody');
    tbody.innerHTML = '';
    
    repReports.forEach(r => {
        const tr = document.createElement('tr');
        const repVal = r.reportedValue || 0;
        const diff = repVal - r.value;
        const absDiff = Math.abs(diff);
        
        let discrepancyHtml = '';
        if (absDiff < 0.01) {
            discrepancyHtml = `<span class="text-emerald" style="font-weight: 500;">Match</span>`;
        } else {
            discrepancyHtml = `<span class="text-rose" style="font-weight: 600;">₹${diff.toFixed(2)}</span>`;
        }
        
        tr.innerHTML = `
            <td>${r.date}</td>
            <td><strong>${r.beat}</strong></td>
            <td>${r.distributor || 'Direct'}</td>
            <td>${r.bottles}</td>
            <td>${r.pouches}</td>
            <td>${r.loose}</td>
            <td class="text-indigo">₹${r.value.toFixed(2)}</td>
            <td class="text-cyan">₹${repVal.toFixed(2)}</td>
            <td>${discrepancyHtml}</td>
        `;
        tbody.appendChild(tr);
    });
    
    // Rep Sales Trend Chart
    const ctx = document.getElementById('chart-rep-trend').getContext('2d');
    if (state.charts.repTrend) state.charts.repTrend.destroy();
    
    // Group reports chronologically
    const sortedReports = [...repReports].reverse();
    const dates = sortedReports.map(r => r.date);
    const revs = sortedReports.map(r => r.value);
    
    const formattedDates = dates.map(d => {
        const parts = d.split('-');
        return parts.length === 3 ? `${parts[2]}/${parts[1]}` : d;
    });
    
    state.charts.repTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: formattedDates,
            datasets: [{
                label: 'Revenue (₹)',
                data: revs,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.05)',
                borderWidth: 2,
                tension: 0.2,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 9 } } },
                y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', font: { size: 9 } } }
            }
        }
    });
}

// ==========================================
// RENDER TAB: BEAT WEEK-ON-WEEK ANALYSIS
// ==========================================

function renderBeatsWoWFilters() {
    const weeks = getAvailableWeeks();
    const weekASelect = document.getElementById('wow-week-a');
    const weekBSelect = document.getElementById('wow-week-b');
    
    weekASelect.innerHTML = '';
    weekBSelect.innerHTML = '';
    
    if (weeks.length < 2) {
        const option = document.createElement('option');
        option.text = 'Not enough weekly data';
        weekASelect.appendChild(option);
        weekBSelect.appendChild(option.cloneNode(true));
        return;
    }
    
    weeks.forEach((w, idx) => {
        const optA = document.createElement('option');
        optA.value = w.key;
        optA.text = w.label;
        // Default select Week A as 2nd latest week
        if (idx === 1) optA.selected = true;
        weekASelect.appendChild(optA);
        
        const optB = document.createElement('option');
        optB.value = w.key;
        optB.text = w.label;
        // Default select Week B as latest week
        if (idx === 0) optB.selected = true;
        weekBSelect.appendChild(optB);
    });
    
    updateWoWBeatComparison();
}

function updateWoWBeatComparison() {
    const weekAKey = document.getElementById('wow-week-a').value;
    const weekBKey = document.getElementById('wow-week-b').value;
    
    const weeks = getAvailableWeeks();
    const weekAObj = weeks.find(w => w.key === weekAKey);
    const weekBObj = weeks.find(w => w.key === weekBKey);
    
    if (!weekAObj || !weekBObj) return;
    
    // Update headers in table
    document.getElementById('col-week-a-header').textContent = `Week A (${formatMinDate(weekAObj.start)})`;
    document.getElementById('col-week-b-header').textContent = `Week B (${formatMinDate(weekBObj.start)})`;
    
    // Calculate Beat statistics for Week A and Week B
    const beatMap = new Map(); // beatName -> { srsA: Set, salesA: 0, srsB: Set, salesB: 0 }
    
    // Get unique beats in both weeks
    state.reports.forEach(r => {
        const d = new Date(r.date);
        
        if (!beatMap.has(r.beat)) {
            beatMap.set(r.beat, { srsA: new Set(), salesA: 0, srsB: new Set(), salesB: 0 });
        }
        
        const data = beatMap.get(r.beat);
        
        if (d >= weekAObj.start && d <= weekAObj.end) {
            data.srsA.add(r.sender);
            data.salesA += r.value;
        } else if (d >= weekBObj.start && d <= weekBObj.end) {
            data.srsB.add(r.sender);
            data.salesB += r.value;
        }
    });
    
    // Render WoW Table
    const tbody = document.querySelector('#beat-wow-table tbody');
    tbody.innerHTML = '';
    
    const beatsList = Array.from(beatMap.entries())
        .filter(b => b[1].salesA > 0 || b[1].salesB > 0)
        .sort((a,b) => b[1].salesB - a[1].salesB);
        
    if (beatsList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No sales recorded in the selected weeks.</td></tr>`;
        return;
    }
    
    const chartLabels = [];
    const chartDataA = [];
    const chartDataB = [];
    
    beatsList.forEach(entry => {
        const name = entry[0];
        const stats = entry[1];
        
        const activeSrs = new Set([...stats.srsA, ...stats.srsB]).size;
        const diff = stats.salesB - stats.salesA;
        const pct = stats.salesA > 0 ? (diff / stats.salesA) * 100 : (stats.salesB > 0 ? 100 : 0);
        
        let trendHtml = '';
        if (diff === 0) trendHtml = '<span class="text-secondary"><i data-lucide="minus"></i> Flat</span>';
        else if (diff > 0) trendHtml = '<span class="text-emerald"><i data-lucide="trending-up"></i> Up</span>';
        else trendHtml = '<span class="text-rose"><i data-lucide="trending-down"></i> Down</span>';
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${name}</strong></td>
            <td>${activeSrs} SRs</td>
            <td style="text-align: right;">₹${stats.salesA.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
            <td style="text-align: right;">₹${stats.salesB.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
            <td style="text-align: right;" class="${diff >= 0 ? 'text-emerald' : 'text-rose'}">
                ${diff >= 0 ? '+' : ''}₹${diff.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </td>
            <td style="text-align: right;" class="${pct >= 0 ? 'text-emerald' : 'text-rose'}">
                ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%
            </td>
            <td>${trendHtml}</td>
        `;
        tbody.appendChild(tr);
        
        // Chart datasets
        chartLabels.push(name);
        chartDataA.push(stats.salesA);
        chartDataB.push(stats.salesB);
    });
    
    lucide.createIcons();
    
    // Render WoW Beat Comparison Chart
    const ctx = document.getElementById('chart-beat-comparison').getContext('2d');
    if (state.charts.beatComparison) state.charts.beatComparison.destroy();
    
    state.charts.beatComparison = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartLabels,
            datasets: [
                {
                    label: `Week A (${formatMinDate(weekAObj.start)})`,
                    data: chartDataA,
                    backgroundColor: 'rgba(99, 102, 241, 0.45)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 1
                },
                {
                    label: `Week B (${formatMinDate(weekBObj.start)})`,
                    data: chartDataB,
                    backgroundColor: 'rgba(139, 92, 246, 0.45)',
                    borderColor: 'rgba(139, 92, 246, 1)',
                    borderWidth: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#94a3b8' } }
            },
            scales: {
                x: { ticks: { color: '#64748b' }, grid: { display: false } },
                y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.03)' } }
            }
        }
    });
}

// ==========================================
// RENDER TAB: MONTH-ON-MONTH TRENDS
// ==========================================

function renderMoMTrends() {
    const monthlyMap = new Map(); // "YYYY-MM" -> { bottles: 0, pouches: 0, loose: 0, value: 0 }
    
    state.reports.forEach(r => {
        const date = new Date(r.date);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        if (!monthlyMap.has(key)) {
            monthlyMap.set(key, { bottles: 0, pouches: 0, loose: 0, value: 0 });
        }
        
        const data = monthlyMap.get(key);
        data.bottles += r.bottles;
        data.pouches += r.pouches;
        data.loose += r.loose;
        data.value += r.value;
    });
    
    const months = Array.from(monthlyMap.keys()).sort();
    
    const getMonthLabel = (key) => {
        const parts = key.split('-');
        const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${names[parseInt(parts[1]) - 1]} ${parts[0]}`;
    };
    
    const labels = months.map(getMonthLabel);
    
    // MoM Summary Table
    const tbody = document.querySelector('#mom-summary-table tbody');
    tbody.innerHTML = '';
    
    if (months.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No reports uploaded yet.</td></tr>`;
        return;
    }
    
    let chartRev = [];
    let chartBottles = [];
    let chartPouches = [];
    let chartLoose = [];
    
    months.forEach((mKey, idx) => {
        const data = monthlyMap.get(mKey);
        
        // Growth calc
        let growthPct = 0;
        if (idx > 0) {
            const prev = monthlyMap.get(months[idx - 1]).value;
            growthPct = prev > 0 ? ((data.value - prev) / prev) * 100 : 0;
        }
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${getMonthLabel(mKey)}</strong></td>
            <td style="text-align: right;">${data.bottles.toLocaleString('en-IN')}</td>
            <td style="text-align: right;">${data.pouches.toLocaleString('en-IN')}</td>
            <td style="text-align: right;">${data.loose.toLocaleString('en-IN')}</td>
            <td style="text-align: right;" class="text-emerald">₹${data.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
            <td style="text-align: right;" class="${growthPct >= 0 ? 'text-emerald' : 'text-rose'}">
                ${idx === 0 ? '-' : `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}%`}
            </td>
        `;
        tbody.appendChild(tr);
        
        // Populate chart lists
        chartRev.push(data.value);
        chartBottles.push(data.bottles);
        chartPouches.push(data.pouches);
        chartLoose.push(data.loose);
    });
    
    // Render Revenue Trend Chart
    const ctxRev = document.getElementById('chart-mom-revenue').getContext('2d');
    if (state.charts.momRevenue) state.charts.momRevenue.destroy();
    
    state.charts.momRevenue = new Chart(ctxRev, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Monthly Revenue (₹)',
                data: chartRev,
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.05)',
                borderWidth: 3,
                tension: 0.2,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#64748b' }, grid: { display: false } },
                y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.03)' } }
            }
        }
    });
    
    // Render Category mix Stacked bar chart
    const ctxCat = document.getElementById('chart-mom-category').getContext('2d');
    if (state.charts.momCategory) state.charts.momCategory.destroy();
    
    state.charts.momCategory = new Chart(ctxCat, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Bottles',
                    data: chartBottles,
                    backgroundColor: '#06b6d4'
                },
                {
                    label: 'Pouches',
                    data: chartPouches,
                    backgroundColor: '#10b981'
                },
                {
                    label: 'Loose',
                    data: chartLoose,
                    backgroundColor: '#8b5cf6'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#94a3b8' } }
            },
            scales: {
                x: { stacked: true, ticks: { color: '#64748b' }, grid: { display: false } },
                y: { stacked: true, ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.03)' } }
            }
        }
    });
}

// ==========================================
// RENDER TAB: SETTINGS & TOOLS
// ==========================================

function savePricesSetting() {
    const bottlePrice = parseFloat(document.getElementById('price-bottles').value) || 0;
    const pouchPrice = parseFloat(document.getElementById('price-pouches').value) || 0;
    const loosePrice = parseFloat(document.getElementById('price-loose').value) || 0;
    
    state.settings.prices.bottles = bottlePrice;
    state.settings.prices.pouches = pouchPrice;
    state.settings.prices.loose = loosePrice;
    
    saveSettingsToDb()
        .then(() => {
            // Re-calculate values of all existing database reports
            state.reports.forEach(r => {
                r.value = (r.bottles * bottlePrice) + 
                          (r.pouches * pouchPrice) + 
                          (r.loose * loosePrice);
            });
            return saveReportsToDb(state.reports);
        })
        .then(() => {
            alert('Settings saved and all report values re-calculated!');
            updateDashboard();
        })
        .catch(err => {
            alert('Failed to save prices: ' + err);
        });
}

function exportDatabaseToJson() {
    if (state.reports.length === 0) {
        alert('There is no data to export!');
        return;
    }
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.reports, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", `sr_sales_export_${new Date().toISOString().substring(0,10)}.json`);
    dlAnchorElem.click();
}

function resetApplicationDatabase() {
    if (!confirm('Are you absolutely sure you want to delete all local sales reports and configuration? This cannot be undone.')) {
        return;
    }
    
    clearDatabase()
        .then(() => {
            alert('Database erased successfully.');
            location.reload();
        })
        .catch(err => {
            alert('Reset failed: ' + err);
        });
}

function generateMockData() {
    if (state.reports.length > 0) {
        if (!confirm('Generating mock data will add records to your existing database. Continue?')) return;
    }
    
    const mockReps = ['Jignesh Vadodariya (Rajkot)', 'Bipin (AHM)', 'Kamini (Surat)', 'Krish (Baroda)', 'Krunal (Vapi)', 'Prakash (Vapi)'];
    const mockBeats = ['VIP Road', 'Bajring Vadi', 'Vesu Road', 'Katargam', 'Adajan', 'Varachha'];
    const mockDists = ['Egal Marketing', 'Jay Bhavani', 'Krishna Enterprises', 'TF Distributors'];
    
    const records = [];
    
    // Generate records for last 60 days
    const now = new Date();
    for (let i = 60; i >= 0; i--) {
        const currentDate = new Date();
        currentDate.setDate(now.getDate() - i);
        const dateStr = currentDate.toISOString().substring(0, 10);
        
        // Skip Sundays (standard sales day-off)
        if (currentDate.getDay() === 0) continue;
        
        // Every day, 2-3 reps post reports
        const repsTodayCount = Math.floor(Math.random() * 2) + 2; 
        const selectedReps = [...mockReps].sort(() => 0.5 - Math.random()).slice(0, repsTodayCount);
        
        selectedReps.forEach((rep, repIdx) => {
            const beat = mockBeats[(mockReps.indexOf(rep) + repIdx) % mockBeats.length];
            const dist = mockDists[mockReps.indexOf(rep) % mockDists.length];
            
            // Random volumes
            const bottles = Math.floor(Math.random() * 30) + 5; // 5 to 35 bottles
            // 60% chance of pouch sales
            const pouches = Math.random() > 0.4 ? (Math.floor(Math.random() * 10) + 1) * 150 : 0; // pati-sized units e.g. 150 to 1500
            // 20% chance of loose sales
            const loose = Math.random() > 0.8 ? Math.floor(Math.random() * 5) + 1 : 0;
            
            const value = (bottles * state.settings.prices.bottles) + 
                          (pouches * state.settings.prices.pouches) + 
                          (loose * state.settings.prices.loose);
            
            // 92% chance reported matches calculated, 8% chance of slight math discrepancy
            let reportedValue = value;
            if (Math.random() > 0.92) {
                const discrepancies = [-45, 90, -150, 350, -5];
                reportedValue = Math.max(0, value + discrepancies[Math.floor(Math.random() * discrepancies.length)]);
            }
            
            records.push({
                date: dateStr,
                sender: rep,
                beat: beat,
                distributor: dist,
                bottles,
                pouches,
                loose,
                value,
                reportedValue,
                isValid: true
            });
        });
    }
    
    saveReportsToDb(records)
        .then(() => {
            alert(`Generated and saved ${records.length} mock daily records across 2 months!`);
            location.reload();
        })
        .catch(err => {
            alert('Failed to generate mock data: ' + err);
        });
}

function handlePhoneMappingSubmit(e) {
    e.preventDefault();
    const phoneInput = document.getElementById('map-phone-number');
    const srInput = document.getElementById('map-sr-name');
    
    const phone = phoneInput.value.trim();
    const srName = srInput.value.trim();
    
    if (!phone || !srName) return;
    
    const normalized = normalizePhone(phone);
    if (!normalized) {
        alert('Invalid phone number. It must contain numeric digits.');
        return;
    }
    
    state.phoneMappings[normalized] = srName;
    
    savePhoneMappingsToDb()
        .then(() => {
            phoneInput.value = '';
            srInput.value = '';
            alert('Phone mapping saved successfully!');
        })
        .catch(err => {
            alert('Failed to save mapping: ' + err);
        });
}

function renderPhoneMappingsTable() {
    const tbody = document.querySelector('#phone-mappings-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const keys = Object.keys(state.phoneMappings).sort();
    
    if (keys.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" style="text-align: center; color: var(--text-muted);">No phone mappings configured. Add one above!</td>
            </tr>
        `;
        return;
    }
    
    keys.forEach(k => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><code>${k}</code></td>
            <td><strong>${state.phoneMappings[k]}</strong></td>
            <td style="text-align: right;">
                <button class="btn btn-danger btn-sm" onclick="deletePhoneMapping('${k}')" style="padding: 0.15rem 0.4rem;">
                    <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Delete
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    lucide.createIcons();
}

window.deletePhoneMapping = function(phoneKey) {
    if (!confirm(`Are you sure you want to delete the mapping for ${phoneKey}?`)) return;
    
    delete state.phoneMappings[phoneKey];
    
    savePhoneMappingsToDb()
        .then(() => {
            alert('Mapping deleted successfully.');
        })
        .catch(err => {
            alert('Failed to delete mapping: ' + err);
        });
};

function renderDistributorsLeaderboard() {
    const query = document.getElementById('dist-search-input').value.toLowerCase();
    const tbody = document.querySelector('#dist-leaderboard-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    // Group records by distributor
    const distMap = new Map();
    state.reports.forEach(r => {
        const distName = normalizeDistributorName(r.distributor || 'Direct Retailer');
        if (!distMap.has(distName)) {
            distMap.set(distName, { bottles: 0, pouches: 0, loose: 0, value: 0, count: 0 });
        }
        const data = distMap.get(distName);
        data.bottles += r.bottles;
        data.pouches += r.pouches;
        data.loose += r.loose;
        data.value += r.value;
        data.count++;
    });
    
    let sortedDists = Array.from(distMap.entries()).sort((a,b) => b[1].value - a[1].value);
    
    if (query) {
        sortedDists = sortedDists.filter(entry => entry[0].toLowerCase().includes(query));
    }
    
    if (sortedDists.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" style="text-align: center; color: var(--text-muted);">No distributors found.</td></tr>`;
        return;
    }
    
    sortedDists.forEach(entry => {
        const name = entry[0];
        const val = entry[1].value;
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        if (state.selectedDistributor === name) tr.style.backgroundColor = 'rgba(99,102,241,0.06)';
        
        tr.innerHTML = `
            <td><strong style="color: ${state.selectedDistributor === name ? 'var(--accent-indigo)' : 'var(--text-primary)'}">${name}</strong></td>
            <td style="text-align: right;" class="text-emerald">₹${val.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
        `;
        
        tr.addEventListener('click', () => {
            selectDistributor(name);
            // Highlight row
            document.querySelectorAll('#dist-leaderboard-table tbody tr').forEach(r => r.style.backgroundColor = '');
            tr.style.backgroundColor = 'rgba(99,102,241,0.06)';
        });
        
        tbody.appendChild(tr);
    });
    
    // If a distributor was selected or we auto-select the first one
    if (state.selectedDistributor && distMap.has(state.selectedDistributor)) {
        renderDistributorDetail(state.selectedDistributor, distMap.get(state.selectedDistributor));
    } else if (sortedDists.length > 0) {
        selectDistributor(sortedDists[0][0]);
    }
}

function selectDistributor(name) {
    state.selectedDistributor = name;
    renderDistributorsLeaderboard();
}

function renderDistributorDetail(name, summary) {
    document.getElementById('dist-detail-placeholder').classList.add('hidden');
    const content = document.getElementById('dist-detail-content');
    content.classList.remove('hidden');
    
    document.getElementById('detail-dist-name').textContent = name;
    document.getElementById('detail-dist-status').classList.remove('hidden');
    
    document.getElementById('detail-dist-revenue').textContent = `₹${summary.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('detail-dist-bottles').textContent = summary.bottles.toLocaleString('en-IN');
    document.getElementById('detail-dist-pouches').textContent = summary.pouches.toLocaleString('en-IN');
    document.getElementById('detail-dist-loose').textContent = summary.loose.toLocaleString('en-IN');
    
    // History table
    const distReports = state.reports.filter(r => normalizeDistributorName(r.distributor || 'Direct Retailer') === name).reverse();
    const tbody = document.querySelector('#dist-history-table tbody');
    tbody.innerHTML = '';
    
    distReports.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${r.date}</td>
            <td><strong>${r.sender}</strong></td>
            <td>${r.beat}</td>
            <td>${r.bottles}</td>
            <td>${r.pouches}</td>
            <td>${r.loose}</td>
            <td class="text-emerald">₹${r.value.toFixed(2)}</td>
        `;
        tbody.appendChild(tr);
    });
    
    // Distributor Purchases Trend Chart
    const ctx = document.getElementById('chart-dist-trend').getContext('2d');
    if (state.charts.distTrend) state.charts.distTrend.destroy();
    
    // Group reports chronologically
    const sortedReports = [...distReports].reverse();
    const dates = sortedReports.map(r => r.date);
    const revs = sortedReports.map(r => r.value);
    
    const formattedDates = dates.map(d => {
        const parts = d.split('-');
        return parts.length === 3 ? `${parts[2]}/${parts[1]}` : d;
    });
    
    state.charts.distTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: formattedDates,
            datasets: [{
                label: 'Purchases (₹)',
                data: revs,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                borderWidth: 2,
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.02)' },
                    ticks: { color: '#64748b', font: { family: 'Inter', size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.02)' },
                    ticks: { color: '#64748b', font: { family: 'Inter', size: 10 } }
                }
            }
        }
    });
}

window.runDatabaseDiagnostics = function() {
    const tbody = document.querySelector('#db-diagnostics-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (!state.reports || state.reports.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No records found in database.</td></tr>';
        return;
    }
    
    const senderMap = new Map();
    state.reports.forEach(r => {
        const sender = r.sender || 'Unknown';
        if (!senderMap.has(sender)) {
            senderMap.set(sender, { count: 0, bottles: 0, pouches: 0, value: 0 });
        }
        const data = senderMap.get(sender);
        data.count++;
        data.bottles += r.bottles || 0;
        data.pouches += r.pouches || 0;
        data.value += r.value || 0;
    });
    
    const sortedSenders = Array.from(senderMap.entries()).sort((a, b) => b[1].value - a[1].value);
    
    sortedSenders.forEach(entry => {
        const sender = entry[0];
        const resolved = resolveRegisteredRepName(sender);
        const data = entry[1];
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${sender}</strong></td>
            <td class="text-indigo"><strong>${resolved}</strong></td>
            <td style="text-align: right;">${data.count}</td>
            <td style="text-align: right;">${data.bottles.toLocaleString()}</td>
            <td style="text-align: right;">${data.pouches.toLocaleString()}</td>
            <td style="text-align: right;" class="text-emerald">₹${data.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
        `;
        tbody.appendChild(tr);
    });
};

window.generateSmartInsights = function() {
    const repsContainer = document.getElementById('insights-reps-container');
    const beatsContainer = document.getElementById('insights-beats-container');
    const productsContainer = document.getElementById('insights-products-container');
    const auditContainer = document.getElementById('insights-audit-container');
    
    if (!repsContainer || !beatsContainer || !productsContainer || !auditContainer) return;
    
    // Clear containers
    repsContainer.innerHTML = '';
    beatsContainer.innerHTML = '';
    productsContainer.innerHTML = '';
    auditContainer.innerHTML = '';
    
    const reports = state.reports;
    if (!reports || reports.length === 0) {
        const noDataHtml = `<div style="grid-column: span 3; text-align: center; padding: 2rem; color: var(--text-muted);">
            <i data-lucide="info" style="width: 32px; height: 32px; margin-bottom: 0.5rem;"></i>
            <p>No sales data available. Please upload records to generate insights.</p>
        </div>`;
        repsContainer.innerHTML = noDataHtml;
        beatsContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1rem;">No data available.</div>`;
        productsContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1rem;">No data available.</div>`;
        auditContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1rem; grid-column: span 2;">No data available.</div>`;
        lucide.createIcons();
        return;
    }
    
    // 1. SALES REPRESENTATIVES ANALYSIS
    const repsData = {};
    reports.forEach(r => {
        const name = resolveRegisteredRepName(r.sender);
        if (!repsData[name]) {
            repsData[name] = { name, bottles: 0, pouches: 0, loose: 0, value: 0, count: 0, discrepancy: 0 };
        }
        repsData[name].bottles += r.bottles;
        repsData[name].pouches += r.pouches;
        repsData[name].loose += r.loose;
        repsData[name].value += r.value;
        repsData[name].count++;
        repsData[name].discrepancy += Math.abs((r.reportedValue || 0) - r.value);
    });
    
    const repsList = Object.values(repsData).sort((a, b) => b.value - a.value);
    
    repsList.forEach(rep => {
        let suggestion = "";
        let statusClass = "trend-neutral";
        let statusIcon = "sparkles";
        
        if (rep.value > 150000) {
            suggestion = `<strong>Top Performer</strong>: Dominates the sales pipeline. Recommend sharing their route techniques (e.g. Adajan/City Light) with other representatives. Focus on upselling Bottles.`;
            statusClass = "trend-up";
            statusIcon = "award";
        } else if (rep.pouches > 10000 && rep.bottles < 100) {
            suggestion = `<strong>Pouch Specialist</strong>: High volume in sachets, but Bottles represent less than 2% of sales. Suggest presenting Bottle bundles/deals to current retailers.`;
            statusClass = "trend-neutral";
            statusIcon = "trending-up";
        } else if (rep.value < 50000) {
            suggestion = `<strong>Growth Opportunity</strong>: Low overall value. Check coverage frequency. Recommending scheduling visits during high-volume weekdays (Wed/Fri) to capture more retail outlets.`;
            statusClass = "trend-down";
            statusIcon = "trending-down";
        } else {
            suggestion = `<strong>Steady Sales</strong>: Balanced portfolio. Recommend focusing on expanding distributor partnerships in Rajkot or Baroda to transition to the next sales tier.`;
            statusClass = "trend-neutral";
            statusIcon = "lightbulb";
        }
        
        if (rep.discrepancy > 1000) {
            suggestion += ` <span style="display: block; margin-top: 0.5rem; color: #f43f5e; font-size: 0.75rem; font-weight: 500;"><i data-lucide="alert-triangle" style="width:12px;height:12px;vertical-align:middle;margin-right:2px;"></i> Audit Needed: High variance of ₹${Math.round(rep.discrepancy).toLocaleString('en-IN')} detected in reported bills.</span>`;
        }
        
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.style.border = '1px solid rgba(255,255,255,0.03)';
        card.style.backgroundColor = 'rgba(255,255,255,0.01)';
        card.style.padding = '1rem';
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
                <h4 style="font-size: 0.95rem; font-weight: 600; color: var(--text-primary);">${rep.name}</h4>
                <span class="stat-indicator ${statusClass}" style="padding: 2px 6px; font-size: 0.75rem;"><i data-lucide="${statusIcon}"></i> ${rep.count} Days</span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;">
                Total Sales: <strong style="color: var(--accent-emerald);">₹${Math.round(rep.value).toLocaleString('en-IN')}</strong> | 
                B: ${rep.bottles.toLocaleString()} | 
                P: ${rep.pouches.toLocaleString()}
            </div>
            <p style="font-size: 0.825rem; line-height: 1.4; color: var(--text-secondary);">${suggestion}</p>
        `;
        repsContainer.appendChild(card);
    });
    
    // 2. BEATS & ROUTE OPTIMIZATION
    const beatsData = {};
    reports.forEach(r => {
        const beat = r.beat || 'General Route';
        if (!beatsData[beat]) {
            beatsData[beat] = { name: beat, value: 0, bottles: 0, pouches: 0, reps: new Set() };
        }
        beatsData[beat].value += r.value;
        beatsData[beat].bottles += r.bottles;
        beatsData[beat].pouches += r.pouches;
        beatsData[beat].reps.add(resolveRegisteredRepName(r.sender));
    });
    
    const beatsList = Object.values(beatsData).sort((a, b) => b.value - a.value);
    
    if (beatsList.length > 0) {
        const topBeat = beatsList[0];
        const repsString = Array.from(topBeat.reps).join(', ');
        const totalCompanyVal = reports.reduce((acc, r)=>acc+r.value, 0);
        const ratio = totalCompanyVal > 0 ? Math.round((topBeat.value / totalCompanyVal) * 100) : 0;
        const topBeatHtml = `
            <div class="stat-card" style="border-left: 4px solid var(--accent-indigo); background: rgba(99,102,241,0.03); margin-bottom: 0.5rem; padding: 0.75rem;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
                    <span style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-indigo); font-weight: 600;">Top Performing Route</span>
                    <span style="font-weight: 700; color: var(--text-primary);">₹${Math.round(topBeat.value).toLocaleString('en-IN')}</span>
                </div>
                <strong style="color: var(--text-primary); font-size: 0.95rem;">${topBeat.name}</strong>
                <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
                    Active Sales Reps: <strong>${repsString}</strong>. High volume channel representing ${ratio}% of total company sales. Expand retailer count here.
                </p>
            </div>
        `;
        beatsContainer.innerHTML += topBeatHtml;
    }
    
    if (beatsList.length > 1) {
        const lowBeat = beatsList[beatsList.length - 1];
        const lowBeatHtml = `
            <div class="stat-card" style="border-left: 4px solid var(--accent-orange); background: rgba(245,158,11,0.03); margin-bottom: 0.5rem; padding: 0.75rem;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
                    <span style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-orange); font-weight: 600;">Underperforming Route</span>
                    <span style="font-weight: 700; color: var(--text-primary);">₹${Math.round(lowBeat.value).toLocaleString('en-IN')}</span>
                </div>
                <strong style="color: var(--text-primary); font-size: 0.95rem;">${lowBeat.name}</strong>
                <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
                    Lowest sales generated. Suggest audit: Is this beat covered regularly? Schedule direct retail incentives or assign an experienced rep to re-engage shopkeepers.
                </p>
            </div>
        `;
        beatsContainer.innerHTML += lowBeatHtml;
    }
    
    const bottleHeavyBeat = beatsList.find(b => b.bottles > b.pouches * 0.1);
    if (bottleHeavyBeat) {
        beatsContainer.innerHTML += `
            <div class="stat-card" style="border-left: 4px solid var(--accent-cyan); background: rgba(6,182,212,0.03); padding: 0.75rem;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
                    <span style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-cyan); font-weight: 600;">Product Mix Recommendation</span>
                    <i data-lucide="lightbulb" class="text-cyan" style="width: 16px; height: 16px;"></i>
                </div>
                <strong style="color: var(--text-primary); font-size: 0.95rem;">${bottleHeavyBeat.name}</strong>
                <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
                    This beat shows high acceptance for premium **Bottles** (${bottleHeavyBeat.bottles} sold). Recommend pitching the 1-Litre bottles to local restaurant/hotel outlets here to maximize order size.
                </p>
            </div>
        `;
    }
    
    // 3. PRODUCT TYPE PERFORMANCE
    let totalB = 0, totalP = 0, totalL = 0, totalVal = 0;
    reports.forEach(r => {
        totalB += r.bottles;
        totalP += r.pouches;
        totalL += r.loose;
        totalVal += r.value;
    });
    
    const revB = totalB * state.settings.prices.bottles;
    const revP = totalP * state.settings.prices.pouches;
    const revL = totalL * state.settings.prices.loose;
    
    const shareB = totalVal > 0 ? (revB / totalVal) * 100 : 0;
    const shareP = totalVal > 0 ? (revP / totalVal) * 100 : 0;
    const shareL = totalVal > 0 ? (revL / totalVal) * 100 : 0;
    
    const prodList = [
        { name: 'Bottles (Bottle Price)', qty: totalB, rev: revB, share: shareB, color: 'var(--accent-cyan)' },
        { name: 'Pouches (Pouch Price)', qty: totalP, rev: revP, share: shareP, color: 'var(--accent-emerald)' },
        { name: 'Loose Sales (Loose Price)', qty: totalL, rev: revL, share: shareL, color: 'var(--accent-violet)' }
    ].sort((a,b) => b.rev - a.rev);
    
    prodList.forEach((prod, idx) => {
        let recText = "";
        if (prod.share > 60) {
            recText = `Critical product pillar representing ${prod.share.toFixed(1)}% of total company turnover. Secure distributor stocks in Egal Marketing and Pooja Trading to prevent stockouts.`;
        } else if (prod.share < 5) {
            recText = `Low revenue share (${prod.share.toFixed(1)}%). Consider introducing lower pricing thresholds for bulk distributors or doing product sampling runs in Surat.`;
        } else {
            recText = `Steady contributor (${prod.share.toFixed(1)}% share). Push for higher penetration in Rajkot and Baroda where demand matches average tiers.`;
        }
        
        const prodCard = `
            <div style="background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.03); border-radius: 6px; padding: 0.75rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: ${prod.color};"></span>
                        <strong style="color: var(--text-primary); font-size: 0.875rem;">${prod.name}</strong>
                    </div>
                    <span style="font-size: 0.8rem; font-weight: 600; color: ${prod.color};">${prod.share.toFixed(1)}% Share</span>
                </div>
                <div style="font-size: 0.775rem; color: var(--text-muted); margin-bottom: 0.5rem;">
                    Qty Sold: <strong>${prod.qty.toLocaleString()} units</strong> | Revenue: <strong>₹${Math.round(prod.rev).toLocaleString('en-IN')}</strong>
                </div>
                <p style="font-size: 0.8rem; line-height: 1.4; color: var(--text-secondary); margin: 0;">${recText}</p>
            </div>
        `;
        productsContainer.innerHTML += prodCard;
    });
    
    // 4. DISCREPANCY & AUDIT WARNING CENTER
    const audits = [];
    reports.forEach((r, idx) => {
        const repVal = r.reportedValue || 0;
        const diff = repVal - r.value;
        const absDiff = Math.abs(diff);
        
        if (absDiff > 10.00) {
            audits.push({
                idx,
                date: r.date,
                sender: resolveRegisteredRepName(r.sender),
                beat: r.beat,
                distributor: r.distributor,
                calc: r.value,
                rep: repVal,
                diff: diff
            });
        }
    });
    
    const repAudits = {};
    audits.forEach(a => {
        if (!repAudits[a.sender]) {
            repAudits[a.sender] = { name: a.sender, count: 0, totalDiff: 0, routes: new Set() };
        }
        repAudits[a.sender].count++;
        repAudits[a.sender].totalDiff += a.diff;
        repAudits[a.sender].routes.add(a.beat);
    });
    
    const repAuditList = Object.values(repAudits).sort((a,b) => Math.abs(b.totalDiff) - Math.abs(a.totalDiff));
    
    if (repAuditList.length === 0) {
        auditContainer.innerHTML = `
            <div style="grid-column: span 2; text-align: center; padding: 1.5rem; color: var(--accent-emerald); background: rgba(16,185,129,0.02); border: 1px solid rgba(16,185,129,0.1); border-radius: 8px;">
                <i data-lucide="check-circle" style="width: 24px; height: 24px; vertical-align: middle; margin-right: 0.5rem;"></i>
                <span style="font-weight: 500;">Perfect Audit Health! All representative reported values match calculated system values.</span>
            </div>
        `;
    } else {
        repAuditList.forEach(audit => {
            const statusColor = audit.totalDiff > 0 ? 'var(--accent-cyan)' : 'var(--accent-orange)';
            const diffLabel = audit.totalDiff > 0 ? `Over-reported by +₹${Math.round(audit.totalDiff).toLocaleString('en-IN')}` : `Under-reported by -₹${Math.round(Math.abs(audit.totalDiff)).toLocaleString('en-IN')}`;
            const routesString = Array.from(audit.routes).join(', ');
            
            const auditCard = `
                <div class="stat-card" style="border: 1px solid rgba(239,68,68,0.15); background: rgba(239,68,68,0.02); padding: 0.75rem; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                        <strong style="color: var(--text-primary); font-size: 0.9rem;">${audit.name}</strong>
                        <span style="font-size: 0.75rem; font-weight: 600; color: #f43f5e; background: rgba(244,63,94,0.1); padding: 2px 8px; border-radius: 12px;">${audit.count} Discrepancies</span>
                    </div>
                    <div style="font-size: 0.85rem; font-weight: 600; color: ${statusColor}; margin-bottom: 0.25rem;">
                        ${diffLabel}
                    </div>
                    <p style="font-size: 0.775rem; color: var(--text-secondary); margin: 0; line-height: 1.4;">
                        Discrepancies found on route(s): <strong>${routesString}</strong>. Check if the representative is using correct product pricing (Bottle: ₹70, Pouch: ₹7/₹8.34, Loose: ₹400) or if orders were calculated with manual discounts.
                    </p>
                </div>
            `;
            auditContainer.innerHTML += auditCard;
        });
    }
    
    lucide.createIcons();
};

function updateCloudSyncUI() {
    const url = state.settings.cloud ? state.settings.cloud.supabaseUrl : '';
    const key = state.settings.cloud ? state.settings.cloud.supabaseKey : '';
    const portal = state.settings.cloud ? state.settings.cloud.portalUrl : 'mobile-entry.html';
    
    const badge = document.getElementById('cloud-connection-status');
    const btnSync = document.getElementById('btn-sync-cloud');
    const syncDesc = document.getElementById('cloud-sync-desc');
    const qrContainer = document.getElementById('cloud-qrcode-container');
    const linkContainer = document.getElementById('cloud-qrcode-link-container');
    
    if (!badge || !btnSync) return;
    
    if (url && key) {
        badge.textContent = 'Connected';
        badge.style.background = 'rgba(16, 185, 129, 0.1)';
        badge.style.color = 'var(--accent-emerald)';
        badge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
        
        btnSync.removeAttribute('disabled');
        if (syncDesc) syncDesc.textContent = 'Cloud database configured. Ready to sync submissions.';
        
        if (qrContainer) {
            qrContainer.innerHTML = '';
            
            const absolutePortalUrl = portal.startsWith('http') 
                ? portal 
                : new URL(portal, window.location.href).href;
                
            const qrText = `${absolutePortalUrl}?url=${encodeURIComponent(url)}&key=${encodeURIComponent(key)}&b=${state.settings.prices.bottles}&p=${state.settings.prices.pouches}&l=${state.settings.prices.loose}`;
            
            qrContainer.setAttribute('title', 'Click to open mobile portal in new tab for testing');
            
            // Remove previous event listener by cloning node
            const newQrContainer = qrContainer.cloneNode(true);
            qrContainer.parentNode.replaceChild(newQrContainer, qrContainer);
            
            newQrContainer.addEventListener('click', () => {
                window.open(qrText, '_blank');
            });
            
            try {
                new QRCode(newQrContainer, {
                    text: qrText,
                    width: 120,
                    height: 120,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.L
                });
            } catch (err) {
                console.error('Failed to generate QR Code:', err);
                newQrContainer.innerHTML = '<div style="color:red;font-size:0.7rem;">QR Code Error</div>';
            }
            
            if (linkContainer) {
                linkContainer.innerHTML = `<a href="${qrText}" target="_blank" style="color: var(--accent-indigo); font-size: 0.725rem; font-weight: 600; text-decoration: underline; margin-top: 0.5rem; display: block;">Open Mobile Portal (Click to Test)</a>`;
            }
            
            // Setup Copy Config Link button
            const btnCopy = document.getElementById('btn-copy-config-link');
            if (btnCopy) {
                btnCopy.style.display = 'flex';
                const newBtnCopy = btnCopy.cloneNode(true);
                btnCopy.parentNode.replaceChild(newBtnCopy, btnCopy);
                
                newBtnCopy.addEventListener('click', () => {
                    navigator.clipboard.writeText(qrText)
                        .then(() => {
                            newBtnCopy.innerHTML = `<i data-lucide="check"></i> Copied!`;
                            lucide.createIcons();
                            setTimeout(() => {
                                newBtnCopy.innerHTML = `<i data-lucide="copy"></i> Copy Config Link`;
                                lucide.createIcons();
                            }, 2000);
                        })
                        .catch(err => {
                            alert('Failed to copy link: ' + err);
                        });
                });
            }
        }
    } else {
        badge.textContent = 'Disconnected';
        badge.style.background = 'rgba(239, 68, 68, 0.1)';
        badge.style.color = 'var(--accent-rose)';
        badge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
        
        btnSync.setAttribute('disabled', 'true');
        if (syncDesc) syncDesc.textContent = 'Configure cloud database settings to fetch sales rep submissions.';
        
        if (qrContainer) {
            qrContainer.innerHTML = '<div id="qrcode-placeholder" style="color: #64748b; font-size: 0.7rem; font-weight: 500; text-align: center;">Save configuration to generate QR Code</div>';
        }
        if (linkContainer) {
            linkContainer.innerHTML = '';
        }
        const btnCopy = document.getElementById('btn-copy-config-link');
        if (btnCopy) btnCopy.style.display = 'none';
    }
}

function saveCloudConfigSetting() {
    let supabaseUrl = document.getElementById('cloud-supabase-url').value.trim();
    const supabaseKey = document.getElementById('cloud-supabase-key').value.trim();
    const portalUrl = document.getElementById('cloud-portal-url').value.trim() || 'mobile-entry.html';
    
    if (supabaseUrl && !supabaseUrl.startsWith('http://') && !supabaseUrl.startsWith('https://')) {
        supabaseUrl = 'https://' + supabaseUrl;
        document.getElementById('cloud-supabase-url').value = supabaseUrl;
    }
    
    if (!state.settings.cloud) {
        state.settings.cloud = {};
    }
    
    state.settings.cloud.supabaseUrl = supabaseUrl;
    state.settings.cloud.supabaseKey = supabaseKey;
    state.settings.cloud.portalUrl = portalUrl;
    
    saveSettingsToDb()
        .then(() => {
            alert('Cloud Sync configuration saved successfully!');
            updateCloudSyncUI();
        })
        .catch(err => {
            alert('Failed to save cloud config: ' + err);
        });
}

function syncCloudSubmissions() {
    const url = state.settings.cloud ? state.settings.cloud.supabaseUrl : '';
    const key = state.settings.cloud ? state.settings.cloud.supabaseKey : '';
    
    if (!url || !key) {
        alert('Please configure Supabase API URL and Key in the Settings tab first!');
        return;
    }
    
    const btnSync = document.getElementById('btn-sync-cloud');
    const syncIcon = document.getElementById('icon-cloud-sync');
    const syncTitle = document.getElementById('cloud-sync-title');
    
    btnSync.setAttribute('disabled', 'true');
    syncTitle.textContent = 'Syncing Cloud...';
    if (syncIcon) {
        syncIcon.classList.add('spinner');
        syncIcon.setAttribute('data-lucide', 'loader-2');
    }
    lucide.createIcons();
    
    const endpoint = `${url}/rest/v1/dsr_submissions?select=*`;
    
    fetch(endpoint, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'apikey': key,
            'Authorization': `Bearer ${key}`
        }
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => {
                throw new Error(text || 'Failed to fetch from cloud database');
            });
        }
        return response.json();
    })
    .then(submissions => {
        if (!submissions || submissions.length === 0) {
            alert('No new submissions found in the cloud.');
            resetSyncButton();
            return;
        }
        
        const newReports = [];
        submissions.forEach(sub => {
            const val = (sub.bottles * state.settings.prices.bottles) + 
                        (sub.pouches * state.settings.prices.pouches) + 
                        (sub.loose * state.settings.prices.loose);
                        
            const repVal = sub.reportedValue || val;
            const normalizedDist = normalizeDistributorName(sub.distributor) || 'Direct Retailer';
            const resolvedSender = resolveRegisteredRepName(sub.sender);
            
            newReports.push({
                date: sub.date,
                sender: resolvedSender,
                beat: sub.beat || 'General Route',
                distributor: normalizedDist,
                bottles: parseInt(sub.bottles) || 0,
                pouches: parseInt(sub.pouches) || 0,
                loose: parseInt(sub.loose) || 0,
                value: val,
                reportedValue: parseFloat(repVal) || 0,
                isValid: !!(sub.date && resolvedSender && sub.beat)
            });
        });
        
        let addedCount = 0;
        const promises = newReports.map(newRep => {
            const isDup = state.reports.some(oldRep => 
                oldRep.date === newRep.date &&
                resolveRegisteredRepName(oldRep.sender) === resolveRegisteredRepName(newRep.sender) &&
                oldRep.beat === newRep.beat &&
                oldRep.distributor === newRep.distributor &&
                oldRep.bottles === newRep.bottles &&
                oldRep.pouches === newRep.pouches &&
                oldRep.loose === newRep.loose
            );
            
            if (!isDup) {
                addedCount++;
                return saveReportsToDb([newRep]);
            }
            return Promise.resolve();
        });
        
        return Promise.all(promises).then(() => {
            return fetch(`${url}/rest/v1/dsr_submissions`, {
                method: 'DELETE',
                headers: {
                    'apikey': key,
                    'Authorization': `Bearer ${key}`
                }
            })
            .then(delResp => {
                if (!delResp.ok) {
                    console.error('Failed to clear submissions from cloud: ', delResp.statusText);
                }
                alert(`Sync Complete! Fetched ${submissions.length} reports, successfully imported ${addedCount} new reports (skipped ${submissions.length - addedCount} duplicates).`);
                
                loadReportsFromDb().then(() => {
                    updateDashboard();
                });
                resetSyncButton();
            });
        });
    })
    .catch(err => {
        alert('Sync failed: ' + err.message);
        resetSyncButton();
    });
    
    function resetSyncButton() {
        btnSync.removeAttribute('disabled');
        syncTitle.textContent = 'Fetch Mobile Submissions';
        if (syncIcon) {
            syncIcon.classList.remove('spinner');
            syncIcon.setAttribute('data-lucide', 'refresh-cw');
        }
        lucide.createIcons();
    }
}

function loadSalesRepsList() {
    if (!db) return;
    const tx = db.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    const req = store.get('sales_reps_list');
    
    req.onsuccess = (e) => {
        if (e.target.result) {
            state.salesRepsList = e.target.result.value || {};
        } else {
            saveSalesRepsListToDb();
        }
        renderSalesRepsRegistryTable();
    };
}

function saveSalesRepsListToDb() {
    if (!db) return Promise.reject('No database connection');
    return new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        const store = tx.objectStore('settings');
        const req = store.put({ key: 'sales_reps_list', value: state.salesRepsList });
        
        req.onsuccess = () => {
            renderSalesRepsRegistryTable();
            resolve();
        };
        req.onerror = (e) => reject(e.target.error);
    });
}

function renderSalesRepsRegistryTable() {
    const tbody = document.querySelector('#reps-registry-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const reps = Object.keys(state.salesRepsList).sort();
    
    if (reps.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No sales reps registered.</td></tr>`;
        return;
    }
    
    reps.forEach(rep => {
        const status = state.salesRepsList[rep] || 'Active';
        const isActive = status === 'Active';
        const badgeColor = isActive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
        const textColor = isActive ? 'var(--accent-emerald)' : 'var(--accent-rose)';
        const btnText = isActive ? 'Deactivate (Quit)' : 'Activate';
        const btnClass = isActive ? 'btn-danger' : 'btn-primary';
        
        const row = `
            <tr>
                <td style="font-weight: 500; color: var(--text-primary);">${rep}</td>
                <td>
                    <span class="badge" style="background: ${badgeColor}; color: ${textColor}; border: 1px solid ${textColor}40; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem;">${status}</span>
                </td>
                <td style="text-align: right;">
                    <button class="btn ${btnClass} btn-sm btn-toggle-rep" data-rep="${rep}" style="font-size: 0.75rem; padding: 2px 8px;">${btnText}</button>
                </td>
            </tr>
        `;
        tbody.innerHTML += row;
    });
    
    // Bind toggle buttons
    document.querySelectorAll('.btn-toggle-rep').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const repName = e.target.getAttribute('data-rep');
            const currentStatus = state.salesRepsList[repName] || 'Active';
            const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';
            state.salesRepsList[repName] = newStatus;
            
            saveSalesRepsListToDb().then(() => {
                syncSingleRepToSupabase(repName, newStatus);
            });
        });
    });
    
    lucide.createIcons();
}

function syncSingleRepToSupabase(name, status) {
    const url = state.settings.cloud ? state.settings.cloud.supabaseUrl : '';
    const key = state.settings.cloud ? state.settings.cloud.supabaseKey : '';
    
    if (!url || !key) return; // No cloud config saved
    
    const endpoint = `${url}/rest/v1/sales_reps?on_conflict=name`;
    
    fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
            name: name,
            status: status
        })
    })
    .then(resp => {
        if (!resp.ok) {
            console.error('Failed to sync representative to Supabase:', resp.statusText);
        } else {
            console.log(`Successfully synced ${name} (${status}) to Supabase.`);
        }
    })
    .catch(err => {
        console.error('Network error syncing representative to Supabase:', err);
    });
}

function syncAllRepsToSupabase() {
    const url = state.settings.cloud ? state.settings.cloud.supabaseUrl : '';
    const key = state.settings.cloud ? state.settings.cloud.supabaseKey : '';
    
    if (!url || !key) {
        alert('Please configure Supabase API URL and Key in the Settings tab first!');
        return;
    }
    
    const btn = document.getElementById('btn-sync-reps-cloud');
    if (btn) btn.disabled = true;
    
    const reps = Object.keys(state.salesRepsList);
    const payloads = reps.map(name => ({
        name: name,
        status: state.salesRepsList[name] || 'Active'
    }));
    
    const endpoint = `${url}/rest/v1/sales_reps?on_conflict=name`;
    
    fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(payloads)
    })
    .then(resp => {
        if (btn) btn.disabled = false;
        if (!resp.ok) {
            return resp.text().then(text => {
                throw new Error(text || 'Failed to sync reps to Supabase');
            });
        }
        alert('Successfully synchronized all Sales Representatives to your Supabase cloud database!');
    })
    .catch(err => {
        if (btn) btn.disabled = false;
        alert('Failed to sync reps: ' + err.message);
    });
}
