import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const rootDir = process.cwd();

const BACKUPS_DIR = path.join(rootDir, "backups");
const DATA_DIR = path.join(rootDir, "data_store");
const OUTLETS_FILE = path.join(DATA_DIR, "outlets.json");
const SYSTEM_CONFIG_FILE = path.join(DATA_DIR, "system_config.json");
const PRESENCE_FILE = path.join(DATA_DIR, "presence_users.json");

// Ensure directories exist
try {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  console.warn("Could not create storage directories:", e);
}

const DEFAULT_SYNC_OUTLETS = [
  { id: 'SH CIPETE', name: 'SH CIPETE', area: 'JAKARTA', type: 'REGULAR OUTLET' },
  { id: 'SH KEMANG', name: 'SH KEMANG', area: 'JAKARTA', type: 'REGULAR OUTLET' },
  { id: 'SH LEBAK BULUS', name: 'SH LEBAK BULUS', area: 'JAKARTA', type: 'REGULAR OUTLET' },
  { id: 'SH ALAM SUTERA', name: 'SH ALAM SUTERA', area: 'TANGGERANG', type: 'PRIME OUTLET' },
  { id: 'SH BINTARO', name: 'SH BINTARO', area: 'TANGGERANG', type: 'REGULAR OUTLET' },
  { id: 'SH THE BARN', name: 'SH THE BARN', area: 'TANGGERANG', type: 'PRIME OUTLET' },
  { id: 'SH BEKASI', name: 'SH BEKASI', area: 'BEKASI', type: 'REGULAR OUTLET' },
  { id: 'SH CIBUBUR', name: 'SH CIBUBUR', area: 'BEKASI', type: 'REGULAR OUTLET' }
];

let outletsMemoryCache: Record<string, any> | null = null;
let outletsVersion = Date.now();
let outletsETag = `"${outletsVersion.toString(36)}"`;

function normalizeServerOutletId(rawId: string): string {
  const raw = (rawId || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!raw) return '';
  if (raw === 'SH ALSUT' || raw === 'ALSUT' || raw === 'ALAM SUTERA' || raw === 'SH ALAM SUTERA') return 'SH ALAM SUTERA';
  if (raw === 'BARN' || raw === 'THE BARN' || raw === 'SH BARN' || raw === 'SH THE BARN') return 'SH THE BARN';
  if (raw === 'CIPETE' || raw === 'SH CIPETE') return 'SH CIPETE';
  if (raw === 'KEMANG' || raw === 'SH KEMANG') return 'SH KEMANG';
  if (raw === 'LEBAK BULUS' || raw === 'SH LEBAK BULUS') return 'SH LEBAK BULUS';
  if (raw === 'BINTARO' || raw === 'SH BINTARO') return 'SH BINTARO';
  if (raw === 'BEKASI' || raw === 'SH BEKASI') return 'SH BEKASI';
  if (raw === 'CIBUBUR' || raw === 'SH CIBUBUR') return 'SH CIBUBUR';

  const rawWithoutSH = raw.replace(/^SH\s+/, '').trim();
  const knownDefault = DEFAULT_SYNC_OUTLETS.find(o =>
    o.name.toUpperCase() === raw ||
    (rawWithoutSH && o.name.toUpperCase().replace(/^SH\s+/, '').trim() === rawWithoutSH)
  );
  if (knownDefault) return knownDefault.name;
  return raw;
}

function canonicalizeOutletsMap(rawData: Record<string, any>): Record<string, any> {
  const cleanMap: Record<string, any> = {};
  if (!rawData || typeof rawData !== 'object') return cleanMap;

  Object.entries(rawData).forEach(([key, val]) => {
    if (!val || typeof val !== 'object') return;
    const canonKey = normalizeServerOutletId(key);
    if (!canonKey) return;

    const existing = cleanMap[canonKey];
    const existingTs = existing?.updatedAt ? Date.parse(existing.updatedAt) || 0 : 0;
    const incomingTs = val?.updatedAt ? Date.parse(val.updatedAt) || 0 : 0;

    if (!existing || incomingTs >= existingTs) {
      cleanMap[canonKey] = JSON.parse(JSON.stringify(val));
    }
  });

  return cleanMap;
}

function readOutletsData(): Record<string, any> {
  if (outletsMemoryCache) {
    return outletsMemoryCache;
  }
  try {
    if (fs.existsSync(OUTLETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(OUTLETS_FILE, "utf-8"));
      outletsMemoryCache = canonicalizeOutletsMap(parsed);
      return outletsMemoryCache!;
    }
  } catch (err) {
    console.warn("Failed reading outlets.json:", err);
  }
  outletsMemoryCache = {};
  return outletsMemoryCache;
}

function writeOutletsData(data: Record<string, any>) {
  const canonicalData = canonicalizeOutletsMap(data);
  outletsMemoryCache = canonicalData;
  outletsVersion = Date.now();
  outletsETag = `"${outletsVersion.toString(36)}"`;
  try {
    const tempFile = `${OUTLETS_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(canonicalData, null, 2), "utf-8");
    fs.renameSync(tempFile, OUTLETS_FILE);
  } catch (err) {
    console.error("Failed writing outlets.json:", err);
  }
}

function mergeOutletMonth(existingMonth: any, incomingMonth: any): any {
  if (!existingMonth || typeof existingMonth !== 'object') return incomingMonth;
  if (!incomingMonth || typeof incomingMonth !== 'object') return existingMonth;

  const result = { ...existingMonth };

  Object.entries(incomingMonth).forEach(([key, incomingVal]) => {
    if (incomingVal === undefined) return;

    const existingVal = existingMonth[key];

    if (existingVal === undefined || existingVal === null) {
      result[key] = incomingVal;
      return;
    }

    if (Array.isArray(incomingVal)) {
      if (incomingVal.length > 0 || !Array.isArray(existingVal) || existingVal.length === 0) {
        result[key] = incomingVal;
      } else {
        result[key] = existingVal;
      }
      return;
    }

    if (
      typeof incomingVal === 'object' && !Array.isArray(incomingVal) &&
      typeof existingVal === 'object' && !Array.isArray(existingVal)
    ) {
      const mergedSub: Record<string, any> = { ...existingVal };
      Object.entries(incomingVal).forEach(([subKey, subVal]) => {
        if (subVal !== undefined) {
          if (
            subVal && typeof subVal === 'object' && !Array.isArray(subVal) &&
            mergedSub[subKey] && typeof mergedSub[subKey] === 'object' && !Array.isArray(mergedSub[subKey])
          ) {
            mergedSub[subKey] = { ...mergedSub[subKey], ...subVal };
          } else {
            mergedSub[subKey] = subVal;
          }
        }
      });
      result[key] = mergedSub;
      return;
    }

    result[key] = incomingVal;
  });

  return result;
}

function readSystemConfig(): any {
  try {
    if (fs.existsSync(SYSTEM_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(SYSTEM_CONFIG_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("Failed reading system_config.json:", err);
  }
  return {
    outlets: DEFAULT_SYNC_OUTLETS,
    maxDailyInputs: 2500,
    onlineTimeLimit: 1440,
    maxOnlineUsers: 10,
    updatedAt: new Date().toISOString()
  };
}

function writeSystemConfig(data: any) {
  try {
    const tempFile = `${SYSTEM_CONFIG_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tempFile, SYSTEM_CONFIG_FILE);
  } catch (err) {
    console.error("Failed writing system_config.json:", err);
  }
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);

  // In the development sandbox, DEFAULT_APP_PORT is 3000 behind nginx reverse proxy.
  // When deployed live to Cloud Run, Cloud Run sets PORT (usually 8080) and checks health on that port.
  const PORT = process.env.DEFAULT_APP_PORT
    ? parseInt(process.env.DEFAULT_APP_PORT, 10)
    : (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);

  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({ type: ['text/*', 'application/json'], limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Health checks for Cloud Run & monitoring probes
  app.get(["/api/health", "/health", "/healthz", "/_health"], (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // In-memory & persisted presence tracker (tanpa snapshot, zero Firestore read/write quota!)
  interface ServerPresenceEntry {
    uid: string;
    email: string;
    outlet: string;
    lastSeen: string;
    lastOfflineAt?: string;
    status?: 'ONLINE' | 'OFFLINE';
    timestamp: number;
    photoURL?: string;
    displayName?: string;
  }

  interface ServerPresenceEvent {
    id: string;
    type: 'LOGIN' | 'LOGOUT';
    email: string;
    displayName: string;
    outlet: string;
    photoURL?: string;
    timestamp: number;
  }

  const activePresenceUsers = new Map<string, ServerPresenceEntry>();
  const knownPresenceDirectory = new Map<string, ServerPresenceEntry>();
  const presenceEvents: ServerPresenceEvent[] = [];
  let presenceEventSeq = 0;

  // Load previously known users (mark all as OFFLINE on server boot until heartbeat arrives)
  try {
    if (fs.existsSync(PRESENCE_FILE)) {
      const savedList = JSON.parse(fs.readFileSync(PRESENCE_FILE, "utf-8"));
      if (Array.isArray(savedList)) {
        savedList.forEach((item: any) => {
          const cleanEmail = (item?.email || '').toLowerCase().trim();
          if (cleanEmail) {
            knownPresenceDirectory.set(cleanEmail, {
              uid: item.uid || cleanEmail,
              email: cleanEmail,
              outlet: item.outlet || 'SEMUA OUTLET',
              photoURL: item.photoURL || '',
              displayName: item.displayName || cleanEmail.split('@')[0],
              lastSeen: item.lastSeen || new Date().toISOString(),
              lastOfflineAt: item.lastOfflineAt || item.lastSeen || new Date().toISOString(),
              status: 'OFFLINE',
              timestamp: Number(item.timestamp) || Date.now()
            });
          }
        });
      }
    }
  } catch (err) {
    console.warn("Failed loading presence_users.json:", err);
  }

  let presenceWriteTimer: ReturnType<typeof setTimeout> | null = null;
  const schedulePresenceSave = () => {
    if (presenceWriteTimer) return;
    presenceWriteTimer = setTimeout(() => {
      presenceWriteTimer = null;
      try {
        const list = Array.from(knownPresenceDirectory.values())
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 100);
        const tmp = `${PRESENCE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf-8");
        fs.renameSync(tmp, PRESENCE_FILE);
      } catch (err) {
        console.warn("Failed saving presence_users.json:", err);
      }
    }, 1000);
  };

  const pushPresenceEvent = (
    type: 'LOGIN' | 'LOGOUT',
    entry: { email: string; displayName?: string; outlet?: string; photoURL?: string },
    now: number
  ) => {
    const cleanEmail = (entry.email || '').toLowerCase().trim();
    if (!cleanEmail) return;
    presenceEventSeq += 1;
    presenceEvents.push({
      id: `${type}_${cleanEmail}_${now}_${presenceEventSeq}`,
      type,
      email: cleanEmail,
      displayName: entry.displayName || cleanEmail.split('@')[0],
      outlet: entry.outlet || 'SEMUA OUTLET',
      photoURL: entry.photoURL || '',
      timestamp: now
    });
    const eventCutoff = now - 3 * 60 * 1000;
    while (presenceEvents.length > 60 || (presenceEvents.length > 0 && presenceEvents[0].timestamp < eventCutoff)) {
      presenceEvents.shift();
    }
  };

  const hasActiveEmailSession = (cleanEmail: string): boolean => {
    let found = false;
    activePresenceUsers.forEach((u) => {
      if ((u.email || '').toLowerCase().trim() === cleanEmail) {
        found = true;
      }
    });
    return found;
  };

  const markDirectoryOffline = (entry: ServerPresenceEntry, now: number) => {
    const cleanEmail = (entry.email || '').toLowerCase().trim();
    if (!cleanEmail) return;
    const prev = knownPresenceDirectory.get(cleanEmail);
    knownPresenceDirectory.set(cleanEmail, {
      ...(prev || entry),
      uid: entry.uid || prev?.uid || cleanEmail,
      email: cleanEmail,
      displayName: entry.displayName || prev?.displayName || cleanEmail.split('@')[0],
      outlet: entry.outlet || prev?.outlet || 'SEMUA OUTLET',
      photoURL: entry.photoURL || prev?.photoURL || '',
      lastSeen: entry.lastSeen || prev?.lastSeen || new Date(now).toISOString(),
      lastOfflineAt: new Date(now).toISOString(),
      status: 'OFFLINE',
      timestamp: now
    });
    schedulePresenceSave();
  };

  const pruneExpiredPresence = (now: number) => {
    const cutoff = now - 20 * 1000;
    const expiredByEmail = new Map<string, ServerPresenceEntry>();

    activePresenceUsers.forEach((user, key) => {
      if (user.timestamp <= cutoff) {
        const cleanEmail = (user.email || '').toLowerCase().trim();
        if (cleanEmail) {
          expiredByEmail.set(cleanEmail, user);
        }
        activePresenceUsers.delete(key);
      }
    });

    expiredByEmail.forEach((lastEntry, cleanEmail) => {
      if (!hasActiveEmailSession(cleanEmail)) {
        markDirectoryOffline(lastEntry, now);
        pushPresenceEvent('LOGOUT', lastEntry, now);
      }
    });
  };

  app.post("/api/presence", (req, res) => {
    try {
      let body = req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }
      const now = Date.now();
      pruneExpiredPresence(now);

      const { uid, email, outlet, photoURL, displayName } = body;
      const cleanEmail = (email || '').toLowerCase().trim();
      const key = uid || cleanEmail || 'anonymous';
      if (key && cleanEmail) {
        const alreadyOnline = hasActiveEmailSession(cleanEmail);
        const existingDir = knownPresenceDirectory.get(cleanEmail);
        const entry: ServerPresenceEntry = {
          uid: key,
          email: cleanEmail,
          outlet: outlet || existingDir?.outlet || 'SEMUA OUTLET',
          photoURL: photoURL || existingDir?.photoURL || '',
          displayName: displayName || existingDir?.displayName || (cleanEmail ? cleanEmail.split('@')[0] : 'User'),
          lastSeen: new Date(now).toISOString(),
          status: 'ONLINE',
          timestamp: now
        };
        activePresenceUsers.set(key, entry);
        knownPresenceDirectory.set(cleanEmail, entry);
        schedulePresenceSave();
        if (!alreadyOnline) {
          pushPresenceEvent('LOGIN', entry, now);
        }
      }
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to update presence" });
    }
  });

  // Logout / Keluar: Langsung pindahkan user dari Online menjadi Offline saat itu juga
  const removeUserPresence = (req: any, res: any) => {
    try {
      let body = req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }
      const now = Date.now();
      pruneExpiredPresence(now);

      const query = req.query || {};
      const targetEmail = (body.email || query.email || '').toLowerCase().trim();
      const targetUid = (body.uid || query.uid || '').trim();
      const logoutAll = body.logoutAll === true || query.logoutAll === 'true';

      const keysToDelete: string[] = [];
      const removedByEmail = new Map<string, ServerPresenceEntry>();

      activePresenceUsers.forEach((user, key) => {
        const uEmail = (user.email || '').toLowerCase().trim();
        const uUid = (user.uid || '').trim();
        const matchesUid = Boolean(targetUid && (key === targetUid || uUid === targetUid || key.startsWith(targetUid)));
        const matchesEmail = Boolean(targetEmail && (uEmail === targetEmail || key.includes(targetEmail)));

        if ((!targetUid || logoutAll) ? (matchesUid || matchesEmail) : matchesUid) {
          keysToDelete.push(key);
          if (uEmail) {
            removedByEmail.set(uEmail, user);
          }
        }
      });

      keysToDelete.forEach(k => activePresenceUsers.delete(k));

      removedByEmail.forEach((removedEntry, cleanEmail) => {
        if (!hasActiveEmailSession(cleanEmail)) {
          markDirectoryOffline(removedEntry, now);
          pushPresenceEvent('LOGOUT', removedEntry, now);
        }
      });

      res.json({ success: true, removedCount: keysToDelete.length, remaining: activePresenceUsers.size });
    } catch {
      res.status(500).json({ error: "Failed to clear presence" });
    }
  };

  app.post("/api/presence/logout", removeUserPresence);
  app.get("/api/presence/logout", removeUserPresence);
  app.delete("/api/presence", removeUserPresence);

  app.get("/api/presence", (_req, res) => {
    try {
      const now = Date.now();
      pruneExpiredPresence(now);

      const activeList: ServerPresenceEntry[] = [];
      const onlineEmails = new Set<string>();

      activePresenceUsers.forEach((user, key) => {
        const emailKey = (user.email || key).toLowerCase().trim();
        if (!onlineEmails.has(emailKey)) {
          onlineEmails.add(emailKey);
          activeList.push({ ...user, status: 'ONLINE' });
        }
      });

      const offlineList: ServerPresenceEntry[] = [];
      knownPresenceDirectory.forEach((dirUser, emailKey) => {
        if (!onlineEmails.has(emailKey)) {
          offlineList.push({ ...dirUser, status: 'OFFLINE' });
        }
      });

      activeList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      offlineList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      const eventCutoff = now - 2 * 60 * 1000;
      const recentEvents = presenceEvents.filter(ev => ev.timestamp >= eventCutoff);

      res.json({
        success: true,
        users: activeList,
        offlineUsers: offlineList,
        events: recentEvents
      });
    } catch {
      res.status(500).json({ error: "Failed to get presence" });
    }
  });

  // --- Real-time High-Availability Cross-Device Sync API ---
  // Guarantees all devices (PC, mobile, tablet, Firefox, Chrome) and Regional Page stay in sync with zero latency
  app.get("/api/sync/all-outlets", (req, res) => {
    try {
      const clientETag = req.headers['if-none-match'];
      if (clientETag && clientETag === outletsETag) {
        return res.status(304).end();
      }
      res.setHeader('ETag', outletsETag);
      res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
      const outlets = readOutletsData();
      const activeOutlets: Record<string, any> = {};
      Object.entries(outlets).forEach(([key, val]) => {
        if (val && !val.isDeleted) {
          activeOutlets[key] = val;
        }
      });
      res.json({ success: true, outlets: activeOutlets });
    } catch (error) {
      console.error("Error reading all outlets:", error);
      res.status(500).json({ error: "Failed to read outlets" });
    }
  });

  app.get("/api/sync/outlet/:outletId", (req, res) => {
    try {
      const canonicalId = normalizeServerOutletId(req.params.outletId);
      const outlets = readOutletsData();
      const found = canonicalId ? outlets[canonicalId] : null;
      const currentOutlet = (found && !found.isDeleted) ? JSON.parse(JSON.stringify(found)) : null;
      const outletTag = currentOutlet?.updatedAt ? `"${new Date(currentOutlet.updatedAt).getTime().toString(36)}"` : outletsETag;

      const clientETag = req.headers['if-none-match'];
      if (clientETag && clientETag === outletTag) {
        return res.status(304).end();
      }

      res.setHeader('ETag', outletTag);
      res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
      res.json({ success: true, outlet: currentOutlet });
    } catch (error) {
      console.error(`Error reading outlet ${req.params.outletId}:`, error);
      res.status(500).json({ error: "Failed to read outlet" });
    }
  });

  app.post("/api/sync/outlet/:outletId", (req, res) => {
    try {
      const canonicalId = normalizeServerOutletId(req.params.outletId);
      if (!canonicalId || canonicalId === 'ALL' || canonicalId === 'SEMUA OUTLET') {
        return res.status(400).json({ error: "Invalid outletId" });
      }
      const { data, email, extraGlobal } = req.body;
      const outlets = readOutletsData();
      const existing = outlets[canonicalId]
        ? JSON.parse(JSON.stringify(outlets[canonicalId]))
        : { monthlyData: {} };
      const existingMonthly = { ...(existing.monthlyData || {}) };

      if (data && typeof data === 'object') {
        Object.entries(data).forEach(([mKey, mVal]) => {
          // Only store clean numeric month keys 0..11 in monthlyData!
          const mNum = parseInt(mKey, 10);
          if (!isNaN(mNum) && mNum >= 0 && mNum <= 11 && mVal && typeof mVal === 'object') {
            // Strip any nested monthlyData or invalid keys
            const { monthlyData: _ignored, ...cleanMonth } = mVal as any;
            if (Array.isArray(cleanMonth.staffList)) {
              cleanMonth.staffList = cleanMonth.staffList.filter(
                (s: any) => s && (!s.outlet || normalizeServerOutletId(s.outlet) === canonicalId)
              );
            }
            // DEEP MERGE with existing month so user edits and other divisions never clobber each other!
            existingMonthly[mKey] = mergeOutletMonth(existingMonthly[mKey], cleanMonth);
          }
        });
      }

      // Propagate top-level global fields across all outlet features
      if (extraGlobal && typeof extraGlobal === 'object') {
        const allowedGlobals = [
          'staffList', 'leaveRecords', 'dailyOvertime', 'weeklyOvertime', 'dailyAttendance',
          'dailyExternalAudit', 'dailyCPA', 'dailyGSI', 'guestComplaints', 'affiliateHistory',
          'manpowerData', 'logisticItems', 'logisticBeginningStocks', 'dailyLogisticRecords',
          'peminjamanRecords', 'logisticPeriodPrices', 'monthlyCogsData', 'customSuppliers',
          'promoSettings', 'bankingPromos', 'dailyStrategy', 'dailyVoidBills',
          'dailyOperationalIssues', 'operationalIssues', 'dailySpk3Records', 'spk3Records',
          'dailyComplimentaryLedger', 'dailyGuestSatisfaction', 'dailyCityLedger',
          'dailyGasLedger', 'dailyChemicalLedger', 'dailyCommodityLedger',
          'dailyMainStoreLedger', 'dailyMainKitchenLedger', 'dailyCashLedger',
          'dailySukandaLedger', 'dailyTgifLedger', 'dailySaungKubilLedger',
          'dailyEverestLedger', 'dailyIkigaiLedger', 'dailyPanfilaLedger',
          'dailyKebunkuLedger', 'dailyTargets', 'dailySales', 'dailyRecording',
          'googleReview', 'dailyGoogleReview', 'dailyQA', 'energyCost'
        ];
        allowedGlobals.forEach(gKey => {
          if (extraGlobal[gKey] !== undefined) {
            let incomingGVal = extraGlobal[gKey];
            if (gKey === 'staffList' && Array.isArray(incomingGVal)) {
              incomingGVal = incomingGVal.filter(
                (s: any) => s && (!s.outlet || normalizeServerOutletId(s.outlet) === canonicalId)
              );
            }
            if (
              incomingGVal && typeof incomingGVal === 'object' && !Array.isArray(incomingGVal) &&
              existing[gKey] && typeof existing[gKey] === 'object' && !Array.isArray(existing[gKey])
            ) {
              existing[gKey] = { ...existing[gKey], ...incomingGVal };
            } else {
              existing[gKey] = incomingGVal;
            }
          }
        });
      }

      // Consolidate dailyGSI across all months and root
      const consolidatedGSI: Record<string, any> = {
        ...(existing.dailyGSI && typeof existing.dailyGSI === 'object' ? existing.dailyGSI : {})
      };
      if (extraGlobal?.dailyGSI && typeof extraGlobal.dailyGSI === 'object') {
        Object.assign(consolidatedGSI, extraGlobal.dailyGSI);
      }
      Object.values(existingMonthly).forEach((mObj: any) => {
        if (mObj?.dailyGSI && typeof mObj.dailyGSI === 'object') {
          Object.assign(consolidatedGSI, mObj.dailyGSI);
        }
      });
      existing.dailyGSI = consolidatedGSI;

      // Also ensure each month has the consolidated dailyGSI for its dates
      Object.entries(existingMonthly).forEach(([mKey, mObj]: [string, any]) => {
        if (mObj && typeof mObj === 'object') {
          existingMonthly[mKey] = {
            ...mObj,
            dailyGSI: {
              ...consolidatedGSI,
              ...(mObj.dailyGSI || {})
            }
          };
        }
      });

      // Consolidate & replicate manpowerData across all months (scoped strictly to this outlet)
      if (existing.manpowerData && typeof existing.manpowerData === 'object') {
        Object.entries(existingMonthly).forEach(([mKey, mObj]: [string, any]) => {
          if (mObj && typeof mObj === 'object') {
            existingMonthly[mKey] = {
              ...mObj,
              manpowerData: {
                ...(existing.manpowerData || {}),
                ...(mObj.manpowerData || {})
              }
            };
          }
        });
      }

      existing.outlet = canonicalId;
      existing.monthlyData = existingMonthly;
      existing.isDeleted = false;
      existing.updatedAt = new Date().toISOString();
      existing.lastUpdatedBy = (email || 'outlet-sync').toLowerCase();

      // Clean up any legacy alias keys and store ONLY under the single canonical key
      Object.keys(outlets).forEach(k => {
        if (k !== canonicalId && normalizeServerOutletId(k) === canonicalId) {
          delete outlets[k];
        }
      });
      outlets[canonicalId] = existing;

      writeOutletsData(outlets);

      res.json({ 
        success: true, 
        updatedAt: existing.updatedAt,
        outletId: canonicalId
      });
    } catch (error) {
      console.error(`Error saving outlet ${req.params.outletId}:`, error);
      res.status(500).json({ error: "Failed to save outlet data" });
    }
  });

  app.get("/api/sync/system-config", (_req, res) => {
    try {
      const config = readSystemConfig();
      res.json({ success: true, config });
    } catch (error) {
      res.status(500).json({ error: "Failed to read system config" });
    }
  });

  app.post("/api/sync/system-config", (req, res) => {
    try {
      const updates = req.body;
      const current = readSystemConfig();
      const next = { ...current, ...updates, updatedAt: new Date().toISOString() };
      writeSystemConfig(next);
      res.json({ success: true, config: next });
    } catch (error) {
      res.status(500).json({ error: "Failed to update system config" });
    }
  });

  // Get list of backups
  app.get("/api/backups", (req, res) => {
    try {
      const files = fs.readdirSync(BACKUPS_DIR);
      const backups = files
        .filter(f => f.endsWith(".json"))
        .map(f => {
          const stats = fs.statSync(path.join(BACKUPS_DIR, f));
          return {
            id: f.replace(".json", ""),
            name: `Backup ${f.replace(".json", "").replace(/_/g, " ")}`,
            timestamp: stats.mtime.toISOString()
          };
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      
      res.json({ backups });
    } catch (error) {
      res.status(500).json({ error: "Failed to list backups" });
    }
  });

  // Create a backup
  app.post("/api/backups", (req, res) => {
    try {
      const { data, outletId } = req.body;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${outletId || "global"}_${timestamp}.json`;
      fs.writeFileSync(path.join(BACKUPS_DIR, filename), JSON.stringify(data, null, 2));
      
      // Keep only last 30 backups
      const files = fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.endsWith(".json"))
        .map(f => ({ name: f, time: fs.statSync(path.join(BACKUPS_DIR, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);
      
      if (files.length > 30) {
        files.slice(30).forEach(f => fs.unlinkSync(path.join(BACKUPS_DIR, f.name)));
      }

      res.json({ success: true, id: filename.replace(".json", "") });
    } catch (error) {
      res.status(500).json({ error: "Failed to create backup" });
    }
  });

  // Restore a backup
  app.post("/api/backups/restore/:backupId", (req, res) => {
    try {
      const { backupId } = req.params;
      const filePath = path.join(BACKUPS_DIR, `${backupId}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Backup not found" });
      }
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ error: "Failed to restore backup" });
    }
  });

  // Determine whether to run in dev mode with Vite or serve production static build
  const distDir = path.join(process.cwd(), 'dist');
  const hasDist = fs.existsSync(path.join(distDir, 'index.html'));
  const isDev = process.env.npm_lifecycle_event === 'dev' || 
                (!hasDist && process.env.NODE_ENV !== 'production');

  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production: serve built static files directly with caching
    app.use(express.static(distDir, {
      maxAge: '1h'
    }));

    // SPA fallback route for any client-side navigation
    app.get("*all", (_req, res) => {
      const indexPath = path.join(distDir, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send("Not Found");
      }
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT} (${isDev ? 'development' : 'production'})`);
  });

  const shutdown = () => {
    httpServer.close(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception in server:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection in server:", reason);
  });
}

startServer();
