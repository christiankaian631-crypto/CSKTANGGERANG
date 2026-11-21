import { 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc,
  getDocs,
  Timestamp,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
  deleteField
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { safeStorage, safeSessionStorage } from "../lib/safeStorage";

import { Notification, Outlet } from "../types";
import { OUTLETS, normalizeOutletKey } from "../constants";

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
  LISTEN = 'listen'
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

const COLLECTION_NAME = "dashboards";
const GLOBAL_COLLECTION = "system_data";
const GLOBAL_DOC_ID = "global_data";
const GLOBAL_REPORTS_ID = "global_reports";
const NOTIFICATIONS_COLLECTION = "notifications";

// Helper to remove undefined values recursively
function cleanData(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(v => cleanData(v));
  } else if (obj !== null && typeof obj === 'object') {
    // Skip cleaning for Firestore special objects or common sentinel values
    if (obj instanceof Timestamp) return obj;
    
    // Check for FieldValue (serverTimestamp, arrayUnion, etc)
    // FieldValue instances in JS SDK v9+ often have a specific internal structure 
    // or constructor name. 'FieldValueImpl' is common in some builds.
    // Also check for _methodName which is used by sentinels.
    const constructorName = obj.constructor ? obj.constructor.name : '';
    if (
      constructorName.includes('FieldValue') || 
      obj._methodName || 
      obj.type === 'serverTimestamp' ||
      (obj._delegate && typeof obj._delegate === 'object')
    ) {
      return obj;
    }

    // Only clean plain objects to avoid breaking custom class instances
    const isPlain = obj.constructor === Object || Object.getPrototypeOf(obj) === null;
    if (!isPlain) return obj;

    return Object.fromEntries(
      Object.entries(obj)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => [k, cleanData(v)])
    );
  }
  return obj;
}

export function mergeDeep(local: any, cloud: any): any {
  if (local === undefined) return cloud;
  if (cloud === undefined) return local;
  if (local === null || cloud === null) return cloud !== undefined ? cloud : local;
  if (typeof local !== 'object' || typeof cloud !== 'object') return cloud !== undefined ? cloud : local;
  // If local is an array, local array takes precedence over cloud array so local deletions are respected
  if (Array.isArray(local) || Array.isArray(cloud)) {
    return Array.isArray(local) ? local : cloud;
  }
  
  const merged: any = { ...local };
  Object.keys(cloud).forEach(key => {
    if (local[key] !== undefined) {
      merged[key] = mergeDeep(local[key], cloud[key]);
    } else {
      merged[key] = cloud[key];
    }
  });
  return merged;
}

// Restore persisted quota circuit-breaker state so reloads respect cooldowns instead of hammering an exhausted project
let quotaExceeded = false;
let lastQuotaErrorTime = 0;
const QUOTA_RETRY_INTERVAL = 30 * 60 * 1000; // 30 minutes cooldown when Firestore reports resource-exhausted
const OUTLET_FIRESTORE_READ_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per-outlet read cooldown when server sync is available
const ALL_OUTLETS_FIRESTORE_READ_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown for full collection reads

const lastOutletFirestoreRead: Record<string, number> = {};
let lastAllOutletsFirestoreRead = 0;

try {
  const savedExceeded = safeStorage.getItem('FIRESTORE_QUOTA_EXCEEDED');
  const savedTime = parseInt(safeStorage.getItem('FIRESTORE_QUOTA_ERROR_TIME') || '0', 10);
  if (savedExceeded === 'true' && savedTime > 0) {
    if (Date.now() - savedTime < QUOTA_RETRY_INTERVAL) {
      quotaExceeded = true;
      lastQuotaErrorTime = savedTime;
    } else {
      safeStorage.removeItem('FIRESTORE_QUOTA_EXCEEDED');
      safeStorage.removeItem('FIRESTORE_QUOTA_ERROR_TIME');
    }
  }
} catch (e) {
  // Ignore safeStorage access errors
}

function markQuotaExceeded() {
  quotaExceeded = true;
  lastQuotaErrorTime = Date.now();
  try {
    safeStorage.setItem('FIRESTORE_QUOTA_EXCEEDED', 'true');
    safeStorage.setItem('FIRESTORE_QUOTA_ERROR_TIME', String(lastQuotaErrorTime));
  } catch (e) {
    // Ignore safeStorage access errors
  }
}

export function isOfflineError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return (
    errorMessage.includes('client is offline') || 
    errorMessage.includes('Failed to get document because the client is offline') ||
    errorMessage.includes('offline') ||
    errorMessage.includes('Could not reach Cloud Firestore')
  );
}

function checkQuota(): boolean {
  if (!quotaExceeded) return true;
  if (lastQuotaErrorTime > 0 && Date.now() - lastQuotaErrorTime >= QUOTA_RETRY_INTERVAL) {
    resetQuotaExceeded();
    return true;
  }
  return false;
}

// Shared ETag + TTL cache for /api/sync/system-config to prevent duplicate reads across modules
let cachedSystemConfig: any = null;
let lastSystemConfigFetch = 0;
let systemConfigETag = '';
let inFlightSystemConfigPromise: Promise<any> | null = null;
const SYSTEM_CONFIG_CACHE_TTL_MS = 30 * 1000;

export async function getSystemConfigShared(forceRefresh = false): Promise<any> {
  const now = Date.now();
  if (!forceRefresh && cachedSystemConfig && (now - lastSystemConfigFetch) < SYSTEM_CONFIG_CACHE_TTL_MS) {
    return cachedSystemConfig;
  }
  if (inFlightSystemConfigPromise) {
    return inFlightSystemConfigPromise;
  }
  inFlightSystemConfigPromise = (async () => {
    try {
      const headers: Record<string, string> = {};
      if (systemConfigETag && cachedSystemConfig) {
        headers['If-None-Match'] = systemConfigETag;
      }
      const res = await fetch('/api/sync/system-config', { headers });
      if (res.status === 304 && cachedSystemConfig) {
        lastSystemConfigFetch = Date.now();
        return cachedSystemConfig;
      }
      if (res.ok) {
        const etag = res.headers.get('ETag');
        if (etag) systemConfigETag = etag;
        const json = await res.json();
        if (json?.config) {
          cachedSystemConfig = json.config;
          lastSystemConfigFetch = Date.now();
          return cachedSystemConfig;
        }
      }
    } catch {
      // Ignore network errors
    } finally {
      inFlightSystemConfigPromise = null;
    }
    return cachedSystemConfig;
  })();
  return inFlightSystemConfigPromise;
}

export async function updateSystemConfigShared(updates: Record<string, any>): Promise<boolean> {
  try {
    const res = await fetch('/api/sync/system-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (res.ok) {
      const json = await res.json();
      if (json?.config) {
        cachedSystemConfig = json.config;
        lastSystemConfigFetch = Date.now();
        systemConfigETag = '';
      }
      return true;
    }
  } catch {
    // Ignore network errors
  }
  return false;
}

export async function pushNotification(user: string, outlet: Outlet, message: string): Promise<boolean> {
  const entry = {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    user,
    outlet,
    message,
    timestamp: new Date().toISOString()
  };

  let serverOk = false;
  try {
    const res = await fetch('/api/sync/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
    serverOk = res.ok;
  } catch {
    // Ignore server notice
  }

  if (!checkQuota() || !auth.currentUser) return serverOk;
  try {
    const notifRef = collection(db, NOTIFICATIONS_COLLECTION);
    await addDoc(notifRef, {
      user,
      outlet,
      message,
      timestamp: serverTimestamp()
    });
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, NOTIFICATIONS_COLLECTION);
    return serverOk;
  }
}

let activeListeners: (() => void)[] = [];

export function handleFirestoreError(error: unknown, operationType: OperationType | string, path: string | null) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isQuotaError = errorMessage.includes('resource-exhausted') || errorMessage.includes('Quota exceeded');
  
  if (isQuotaError) {
    markQuotaExceeded();
    console.warn('[CloudSync] Firestore quota exceeded. Pausing Firestore reads/writes for 30 minutes and relying on server sync.');
    return;
  }

  if (isOfflineError(error) || errorMessage.includes('INTERNAL ASSERTION FAILED') || errorMessage.includes('Unexpected state')) {
    console.warn(`[CloudSync] Firestore operation (${operationType}) noted offline or internal assertion at path (${path}):`, errorMessage);
    return;
  }

  const errInfo: FirestoreErrorInfo = {
    error: errorMessage,
    operationType: operationType as OperationType,
    path,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: (auth.currentUser as any)?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    }
  };
  
  const jsonError = JSON.stringify(errInfo);
  console.error('Firestore Error: ', jsonError);
  if (operationType === 'listen' || operationType === 'get' || operationType === 'list' || operationType === 'write') {
    console.warn(`[CloudSync] Non-fatal ${operationType} failure at path: ${path}`);
    return;
  }
  throw new Error(jsonError);
}

// Lightweight connection check: runs at most once per browser session via cache-aware getDoc (zero getDocFromServer waste)
export async function testConnection() {
  if (!checkQuota()) return;
  try {
    if (safeSessionStorage.getItem('FIRESTORE_CONN_TESTED') === 'true') {
      return;
    }
    safeSessionStorage.setItem('FIRESTORE_CONN_TESTED', 'true');
  } catch {}

  try {
    await getDoc(doc(db, 'test', 'connection'));
    console.info('[CloudSync] Firebase connection check completed.');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isQuotaError = errorMessage.includes('resource-exhausted') || errorMessage.includes('Quota exceeded');
    if (isQuotaError) {
      markQuotaExceeded();
    } else if (isOfflineError(error) || errorMessage.includes('INTERNAL ASSERTION FAILED') || errorMessage.includes('Unexpected state')) {
      console.warn("[CloudSync] Client is offline or assertion:", errorMessage);
    } else {
      console.warn("[CloudSync] Connection test warning:", errorMessage);
    }
  }
}

// Global console filter to suppress persistent Firestore quota messages
const originalError = console.error;
const originalWarn = console.warn;

console.error = (...args) => {
  const msg = args.join(' ');
  if (
    msg.includes('resource-exhausted') || 
    msg.includes('Quota exceeded') ||
    msg.includes('client is offline') ||
    msg.includes('Client is offline') ||
    msg.includes('Failed to get document because the client is offline')
  ) return;
  if (msg.includes('Could not reach Cloud Firestore')) {
    originalWarn.apply(console, args);
    return;
  }
  originalError.apply(console, args);
};

console.warn = (...args) => {
  const msg = args.join(' ');
  if (msg.includes('maximum backoff delay')) return;
  originalWarn.apply(console, args);
};

export function startNotificationListener(onUpdate: (notifications: Notification[]) => void) {
  let isSubscribed = true;
  let lastKnownEtag = '';
  let lastKnownHash = '';
  let lastFetchTime = 0;

  const pollNotifications = async () => {
    if (!isSubscribed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    lastFetchTime = Date.now();

    let serverList: Notification[] = [];
    try {
      const headers: Record<string, string> = {};
      if (lastKnownEtag) headers['If-None-Match'] = lastKnownEtag;
      const res = await fetch('/api/sync/notifications', { headers });
      if (res.status === 304) return;
      if (res.ok) {
        const etag = res.headers.get('ETag');
        if (etag) lastKnownEtag = etag;
        const json = await res.json();
        if (Array.isArray(json?.notifications)) {
          serverList = json.notifications;
        }
      }
    } catch {
      // Ignore transient network errors
    }

    // One-time per session Firestore seed ONLY if server has no notifications yet and quota allows
    if (serverList.length === 0 && checkQuota() && auth.currentUser) {
      let alreadySeeded = false;
      try {
        alreadySeeded = safeSessionStorage.getItem('FIRESTORE_NOTIF_SEEDED') === 'true';
      } catch {}
      if (!alreadySeeded) {
        try {
          safeSessionStorage.setItem('FIRESTORE_NOTIF_SEEDED', 'true');
          const notifRef = collection(db, NOTIFICATIONS_COLLECTION);
          const q = query(notifRef, orderBy("timestamp", "desc"), limit(10));
          const snap = await getDocs(q);
          const cloudNotifs: Notification[] = [];
          snap.forEach((docSnap) => {
            const data = docSnap.data();
            cloudNotifs.push({
              id: docSnap.id,
              user: data.user,
              outlet: data.outlet,
              message: data.message,
              timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : (typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString())
            });
          });
          if (cloudNotifs.length > 0) {
            serverList = cloudNotifs;
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.LIST, NOTIFICATIONS_COLLECTION);
        }
      }
    }

    const nextHash = JSON.stringify(serverList);
    if (nextHash !== lastKnownHash && isSubscribed) {
      lastKnownHash = nextHash;
      onUpdate(serverList);
    }
  };

  pollNotifications();
  const interval = setInterval(pollNotifications, 30000);

  const handleVisibility = () => {
    if (document.visibilityState === 'visible' && isSubscribed && (Date.now() - lastFetchTime >= 15000)) {
      pollNotifications();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility);
  }

  const unsub = () => {
    isSubscribed = false;
    clearInterval(interval);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibility);
    }
  };

  activeListeners.push(unsub);
  return () => {
    unsub();
    activeListeners = activeListeners.filter(u => u !== unsub);
  };
}

export async function saveNotification(notification: any): Promise<boolean> {
  const entry = {
    id: notification?.id || `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    user: notification?.user || 'System',
    outlet: notification?.outlet || 'SEMUA OUTLET',
    message: notification?.message || '',
    timestamp: typeof notification?.timestamp === 'string' && notification.timestamp ? notification.timestamp : new Date().toISOString()
  };

  let serverOk = false;
  try {
    const res = await fetch('/api/sync/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
    serverOk = res.ok;
  } catch {
    // Ignore server notice
  }

  if (!checkQuota() || !auth.currentUser) return serverOk;
  try {
    const notifRef = collection(db, NOTIFICATIONS_COLLECTION);
    const payload = {
      ...notification,
      timestamp: typeof notification.timestamp === 'string' ? serverTimestamp() : notification.timestamp
    };
    await addDoc(notifRef, payload);
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, NOTIFICATIONS_COLLECTION);
    return serverOk;
  }
}

export function getFlatUpdates(newValue: any, oldValue: any, prefix = "", depth = 0): Record<string, any> {
  const updates: Record<string, any> = {};

  if (!newValue || typeof newValue !== 'object' || Array.isArray(newValue)) {
    updates[prefix] = newValue;
    return updates;
  }

  // To prevent invalid Firestore field paths when keys contain special characters or dots,
  // and to avoid excessive fragmentation, stop flattening after depth 3.
  if (depth >= 3) {
    updates[prefix] = newValue;
    return updates;
  }

  Object.keys(newValue).forEach(key => {
    // If the key itself contains dots or special characters, don't flatten inside it to prevent FieldPath errors
    const hasDot = key.includes('.');
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const newVal = newValue[key];
    const oldVal = oldValue ? oldValue[key] : undefined;

    if (newVal === undefined) return;

    if (hasDot || depth >= 2) {
      if (oldVal === undefined || JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
        updates[fullKey] = newVal;
      }
      return;
    }

    if (oldVal === undefined) {
      updates[fullKey] = newVal;
    } else if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
      if (newVal && typeof newVal === 'object' && !Array.isArray(newVal)) {
        if (oldVal && typeof oldVal === 'object' && !Array.isArray(oldVal)) {
          const subUpdates = getFlatUpdates(newVal, oldVal, fullKey, depth + 1);
          Object.assign(updates, subUpdates);
        } else {
          updates[fullKey] = newVal;
        }
      } else {
        updates[fullKey] = newVal;
      }
    }
  });

  return updates;
}

export function unpackOutletDocument(docData: any): any {
  if (!docData) return {};
  const rawMonthlyData = docData.monthlyData || {};
  const monthlyData: Record<string, any> = {};
  
  // Strictly only process valid numeric month keys 0..11 to avoid key pollution and data explosion
  for (let m = 0; m < 12; m++) {
    const k = m.toString();
    if (rawMonthlyData[k] && typeof rawMonthlyData[k] === 'object') {
      const { monthlyData: _ignored, ...cleanMonth } = rawMonthlyData[k];
      monthlyData[k] = cleanMonth;
    }
  }

  // Global authoritative fields from root document
  let rootStaffList: any[] = Array.isArray(docData.staffList) ? docData.staffList : [];
  if (docData.staffList === undefined) {
    for (let m = 11; m >= 0; m--) {
      const mStaff = monthlyData[m.toString()]?.staffList;
      if (Array.isArray(mStaff) && mStaff.length > 0) {
        rootStaffList = mStaff;
        break;
      }
    }
  }

  let rootLeaveRecords: any[] = Array.isArray(docData.leaveRecords) ? docData.leaveRecords : [];
  if (docData.leaveRecords === undefined) {
    for (let m = 11; m >= 0; m--) {
      const mLeave = monthlyData[m.toString()]?.leaveRecords;
      if (Array.isArray(mLeave) && mLeave.length > 0) {
        rootLeaveRecords = mLeave;
        break;
      }
    }
  }

  let rootManpowerData: Record<string, any> = (docData.manpowerData && typeof docData.manpowerData === 'object') ? docData.manpowerData : {};
  if (docData.manpowerData === undefined || Object.keys(rootManpowerData).length === 0) {
    for (let m = 11; m >= 0; m--) {
      const mMan = monthlyData[m.toString()]?.manpowerData;
      if (mMan && typeof mMan === 'object' && Object.keys(mMan).length > 0) {
        rootManpowerData = mMan;
        break;
      }
    }
  }

  let rootDailyOvertime: Record<string, any[]> = (docData.dailyOvertime && typeof docData.dailyOvertime === 'object') ? docData.dailyOvertime : {};
  if (docData.dailyOvertime === undefined || Object.keys(rootDailyOvertime).length === 0) {
    for (let m = 11; m >= 0; m--) {
      const mOT = monthlyData[m.toString()]?.dailyOvertime;
      if (mOT && typeof mOT === 'object' && Object.keys(mOT).length > 0) {
        rootDailyOvertime = mOT;
        break;
      }
    }
  }

  const rootDailyAttendance: Record<string, any[]> = (docData.dailyAttendance && typeof docData.dailyAttendance === 'object') ? docData.dailyAttendance : {};
  const rootDailyExternalAudit: Record<string, any[]> = (docData.dailyExternalAudit && typeof docData.dailyExternalAudit === 'object') ? docData.dailyExternalAudit : {};
  
  // Consolidate dailyCPA across root and all 12 months
  const combinedDailyCPA: Record<string, any[]> = {
    ...(docData.dailyCPA && typeof docData.dailyCPA === 'object' ? docData.dailyCPA : {})
  };
  for (let m = 0; m < 12; m++) {
    const mCpa = monthlyData[m.toString()]?.dailyCPA;
    if (mCpa && typeof mCpa === 'object') {
      Object.assign(combinedDailyCPA, mCpa);
    }
  }

  // Consolidate dailyGSI across root and all 12 months
  const combinedDailyGSI: Record<string, any[]> = {
    ...(docData.dailyGSI && typeof docData.dailyGSI === 'object' ? docData.dailyGSI : {})
  };
  for (let m = 0; m < 12; m++) {
    const mGsi = monthlyData[m.toString()]?.dailyGSI;
    if (mGsi && typeof mGsi === 'object') {
      Object.entries(mGsi).forEach(([dKey, rows]) => {
        if (!combinedDailyGSI[dKey] || (Array.isArray(rows) && rows.length > 0)) {
          combinedDailyGSI[dKey] = rows as any[];
        }
      });
    }
  }

  // Consolidate dailyQA across root and all 12 months
  const combinedDailyQA: Record<string, any> = {
    ...(docData.dailyQA && typeof docData.dailyQA === 'object' ? docData.dailyQA : {})
  };
  for (let m = 0; m < 12; m++) {
    const mQa = monthlyData[m.toString()]?.dailyQA;
    if (mQa && typeof mQa === 'object') {
      Object.assign(combinedDailyQA, mQa);
    }
  }

  // Consolidate dailyGoogleReview across root and all 12 months
  const combinedDailyGoogleReview: Record<string, any> = {
    ...(docData.dailyGoogleReview && typeof docData.dailyGoogleReview === 'object' ? docData.dailyGoogleReview : {})
  };
  for (let m = 0; m < 12; m++) {
    const mGr = monthlyData[m.toString()]?.dailyGoogleReview;
    if (mGr && typeof mGr === 'object') {
      Object.assign(combinedDailyGoogleReview, mGr);
    }
  }

  const rootGuestComplaints: any[] = Array.isArray(docData.guestComplaints) ? docData.guestComplaints : [];
  const rootAffiliateHistory: any[] = Array.isArray(docData.affiliateHistory) ? docData.affiliateHistory : [];

  const rootLogisticItems: any[] = Array.isArray(docData.logisticItems) ? docData.logisticItems : [];
  const rootDailyLogisticRecords: Record<string, any> = (docData.dailyLogisticRecords && typeof docData.dailyLogisticRecords === 'object') ? docData.dailyLogisticRecords : {};
  const rootPeminjamanRecords: any[] = Array.isArray(docData.peminjamanRecords) ? docData.peminjamanRecords : [];
  const rootLogisticBeginningStocks: Record<string, any> = (docData.logisticBeginningStocks && typeof docData.logisticBeginningStocks === 'object') ? docData.logisticBeginningStocks : {};
  const rootLogisticPeriodPrices: Record<string, any> = (docData.logisticPeriodPrices && typeof docData.logisticPeriodPrices === 'object') ? docData.logisticPeriodPrices : {};

  const filledMonthlyData: any = {};
  for (let m = 0; m < 12; m++) {
    const mKey = m.toString();
    const mData = monthlyData[mKey] || {};

    filledMonthlyData[mKey] = {
      ...mData,
      staffList: rootStaffList,
      leaveRecords: rootLeaveRecords,
      manpowerData: rootManpowerData,
      dailyOvertime: {
        ...rootDailyOvertime,
        ...(mData.dailyOvertime || {})
      },
      dailyAttendance: rootDailyAttendance,
      dailyExternalAudit: rootDailyExternalAudit,
      dailyCPA: {
        ...combinedDailyCPA,
        ...(mData.dailyCPA || {})
      },
      dailyGSI: {
        ...combinedDailyGSI,
        ...(mData.dailyGSI || {})
      },
      dailyQA: {
        ...combinedDailyQA,
        ...(mData.dailyQA || {})
      },
      dailyGoogleReview: {
        ...combinedDailyGoogleReview,
        ...(mData.dailyGoogleReview || {})
      },
      guestComplaints: rootGuestComplaints,
      affiliateHistory: rootAffiliateHistory,
      logisticItems: rootLogisticItems,
      dailyLogisticRecords: rootDailyLogisticRecords,
      peminjamanRecords: rootPeminjamanRecords,
      logisticBeginningStocks: rootLogisticBeginningStocks,
      logisticPeriodPrices: rootLogisticPeriodPrices
    };
  }

  // Attach authoritative references
  filledMonthlyData.monthlyData = monthlyData;
  filledMonthlyData.staffList = rootStaffList;
  filledMonthlyData.leaveRecords = rootLeaveRecords;
  filledMonthlyData.manpowerData = rootManpowerData;
  filledMonthlyData.dailyOvertime = rootDailyOvertime;
  filledMonthlyData.dailyAttendance = rootDailyAttendance;
  filledMonthlyData.dailyExternalAudit = rootDailyExternalAudit;
  filledMonthlyData.dailyCPA = combinedDailyCPA;
  filledMonthlyData.dailyGSI = combinedDailyGSI;
  filledMonthlyData.dailyQA = combinedDailyQA;
  filledMonthlyData.dailyGoogleReview = combinedDailyGoogleReview;
  filledMonthlyData.guestComplaints = rootGuestComplaints;
  filledMonthlyData.affiliateHistory = rootAffiliateHistory;
  filledMonthlyData.logisticItems = rootLogisticItems;
  filledMonthlyData.dailyLogisticRecords = rootDailyLogisticRecords;
  filledMonthlyData.peminjamanRecords = rootPeminjamanRecords;
  filledMonthlyData.logisticBeginningStocks = rootLogisticBeginningStocks;
  filledMonthlyData.logisticPeriodPrices = rootLogisticPeriodPrices;

  if (docData.sales) filledMonthlyData.sales = docData.sales;
  if (docData.expenses) filledMonthlyData.expenses = docData.expenses;
  if (docData.monthlyCogsData) filledMonthlyData.monthlyCogsData = docData.monthlyCogsData;
  if (docData.dailyTargets) filledMonthlyData.dailyTargets = docData.dailyTargets;
  if (docData.dailyQA) filledMonthlyData.dailyQA = docData.dailyQA;
  if (docData.dailyMainKitchenLedger) filledMonthlyData.dailyMainKitchenLedger = docData.dailyMainKitchenLedger;
  if (docData.dailyMainStoreLedger) filledMonthlyData.dailyMainStoreLedger = docData.dailyMainStoreLedger;
  if (docData.dailyChemicalLedger) filledMonthlyData.dailyChemicalLedger = docData.dailyChemicalLedger;
  if (docData.dailyCashLedger) filledMonthlyData.dailyCashLedger = docData.dailyCashLedger;
  if (docData.dailyCommodityLedger) filledMonthlyData.dailyCommodityLedger = docData.dailyCommodityLedger;
  if (docData.dailyGuestSuppliesLedger) filledMonthlyData.dailyGuestSuppliesLedger = docData.dailyGuestSuppliesLedger;
  if (docData.dailyCityLedger) filledMonthlyData.dailyCityLedger = docData.dailyCityLedger;
  if (docData.dailyTgifLedger) filledMonthlyData.dailyTgifLedger = docData.dailyTgifLedger;
  if (docData.dailySukandaLedger) filledMonthlyData.dailySukandaLedger = docData.dailySukandaLedger;
  if (docData.dailyEverestLedger) filledMonthlyData.dailyEverestLedger = docData.dailyEverestLedger;
  if (docData.dailyPanfilaLedger) filledMonthlyData.dailyPanfilaLedger = docData.dailyPanfilaLedger;
  if (docData.dailyIkigaiLedger) filledMonthlyData.dailyIkigaiLedger = docData.dailyIkigaiLedger;
  if (docData.dailyKebunkuLedger) filledMonthlyData.dailyKebunkuLedger = docData.dailyKebunkuLedger;
  if (docData.dailySaungKubilLedger) filledMonthlyData.dailySaungKubilLedger = docData.dailySaungKubilLedger;
  if (docData.dailyGasLedger) filledMonthlyData.dailyGasLedger = docData.dailyGasLedger;
  if (docData.dailyThirdPartyLedger) filledMonthlyData.dailyThirdPartyLedger = docData.dailyThirdPartyLedger;
  if (docData.energyCost) filledMonthlyData.energyCost = docData.energyCost;
  if (docData.weeklyOvertime) filledMonthlyData.weeklyOvertime = docData.weeklyOvertime;
  if (docData.dailyBreakTime) filledMonthlyData.dailyBreakTime = docData.dailyBreakTime;
  if (docData.googleReview) filledMonthlyData.googleReview = docData.googleReview;
  if (docData.dailyGoogleReview) filledMonthlyData.dailyGoogleReview = docData.dailyGoogleReview;
  if (docData.promoSettings) filledMonthlyData.promoSettings = docData.promoSettings;
  if (docData.bankingPromos) filledMonthlyData.bankingPromos = docData.bankingPromos;
  if (docData.dailyStrategy) filledMonthlyData.dailyStrategy = docData.dailyStrategy;
  if (docData.dailyVoidBills) filledMonthlyData.dailyVoidBills = docData.dailyVoidBills;
  if (docData.voidBills) filledMonthlyData.voidBills = docData.voidBills;
  if (docData.dailyOperationalIssues) filledMonthlyData.dailyOperationalIssues = docData.dailyOperationalIssues;
  if (docData.operationalIssues) filledMonthlyData.operationalIssues = docData.operationalIssues;
  if (docData.dailySpk3Records) filledMonthlyData.dailySpk3Records = docData.dailySpk3Records;
  if (docData.spk3Records) filledMonthlyData.spk3Records = docData.spk3Records;

  return filledMonthlyData;
}

export async function saveGlobalData(email: string, data: Partial<any>, oldData?: Partial<any>, outletId?: string): Promise<boolean> {
  if (outletId) {
    return saveOutletData(email, outletId, {}, undefined, data);
  }
  return true;
}

let lastBackupTimeByOutlet: Record<string, number> = {};

// Throttling and batching Firestore writes per outlet to protect Firestore daily quota limits
const lastFirestoreWriteByOutlet: Record<string, number> = {};
const pendingFirestoreTimerByOutlet: Record<string, any> = {};
const pendingFirestorePayloadByOutlet: Record<string, { email: string; data: Record<string, any>; extraGlobal?: Record<string, any> }> = {};
const FIRESTORE_MIN_WRITE_INTERVAL_MS = 60000; // at most 1 write per minute per outlet for autosaves to preserve daily Firestore quota

async function executeFirestoreWrite(
  email: string,
  outletId: string,
  dataToSave: Record<string, any>,
  extraGlobalToSave?: Record<string, any>
): Promise<boolean> {
  const canonicalOutletId = normalizeOutletKey(outletId);
  if (!canonicalOutletId || canonicalOutletId === 'ALL' || canonicalOutletId === 'SEMUA OUTLET') {
    return false;
  }
  if (!checkQuota() || !auth.currentUser) return false;
  try {
    const outletRef = doc(db, COLLECTION_NAME, canonicalOutletId);
    const completeMonthsToMerge: Record<string, any> = {};
    const payloadToMerge: Record<string, any> = {
      outlet: canonicalOutletId,
      updatedAt: serverTimestamp(),
      lastUpdatedBy: (email || 'outlet-sync').toLowerCase(),
      isDeleted: false
    };

    let hasData = false;
    Object.entries(dataToSave).forEach(([monthIdx, monthData]) => {
      const mNum = parseInt(monthIdx, 10);
      if (isNaN(mNum) || mNum < 0 || mNum > 11 || !monthData) return;
      const { monthlyData: _ignored, ...cleanMonth } = cleanData(monthData);
      completeMonthsToMerge[monthIdx] = {
        ...cleanMonth,
        outlet: canonicalOutletId
      };
      hasData = true;
    });

    if (Object.keys(completeMonthsToMerge).length > 0) {
      payloadToMerge.monthlyData = completeMonthsToMerge;
    }

    if (extraGlobalToSave && typeof extraGlobalToSave === 'object') {
      const allowedGlobals = [
        'staffList', 'leaveRecords', 'dailyOvertime', 'weeklyOvertime', 'dailyAttendance',
        'dailyExternalAudit', 'dailyCPA', 'dailyGSI', 'guestComplaints',
        'affiliateHistory', 'manpowerData', 'logisticItems', 'peminjamanRecords',
        'logisticBeginningStocks', 'logisticPeriodPrices'
      ];
      allowedGlobals.forEach(gKey => {
        if (extraGlobalToSave[gKey] !== undefined) {
          if (gKey === 'staffList' && Array.isArray(extraGlobalToSave[gKey])) {
            payloadToMerge[gKey] = extraGlobalToSave[gKey]
              .filter((s: any) => s && (!s.outlet || normalizeOutletKey(s.outlet) === canonicalOutletId))
              .map((s: any) => ({ ...s, outlet: canonicalOutletId }));
          } else {
            payloadToMerge[gKey] = extraGlobalToSave[gKey];
          }
          hasData = true;
        }
      });
    }

    if (!hasData) return true;

    // Direct atomic setDoc with merge: true - NO redundant getDoc read, saves 50% quota!
    await setDoc(outletRef, cleanData(payloadToMerge), { merge: true });
    lastFirestoreWriteByOutlet[canonicalOutletId] = Date.now();
    console.log(`[CloudSync] Outlet data (${canonicalOutletId}) successfully synced to Firestore.`);
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `${COLLECTION_NAME}/${canonicalOutletId}`);
    return false;
  }
}

export async function saveOutletData(
  email: string, 
  outletId: string, 
  data: Record<string, any>, 
  oldData?: Record<string, any>,
  extraGlobal?: Record<string, any>,
  isPriority: boolean = false
): Promise<boolean> {
  const canonicalOutletId = normalizeOutletKey(outletId);
  if (!canonicalOutletId || canonicalOutletId === 'ALL' || canonicalOutletId === 'SEMUA OUTLET') {
    console.warn('[ServerSync] Blocked saveOutletData for invalid outletId:', outletId);
    return false;
  }

  const sanitizedExtraGlobal = extraGlobal && typeof extraGlobal === 'object'
    ? {
        ...extraGlobal,
        ...(Array.isArray(extraGlobal.staffList)
          ? {
              staffList: extraGlobal.staffList
                .filter((s: any) => s && (!s.outlet || normalizeOutletKey(s.outlet) === canonicalOutletId))
                .map((s: any) => ({ ...s, outlet: canonicalOutletId }))
            }
          : {})
      }
    : extraGlobal;

  // 1. Immediately save & synchronize to High-Availability Cloud Server API (instant cross-device sync)
  let serverSyncSuccess = false;
  try {
    const res = await fetch(`/api/sync/outlet/${encodeURIComponent(canonicalOutletId)}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data, email, extraGlobal: sanitizedExtraGlobal })
    });
    if (res.ok) {
      serverSyncSuccess = true;
      console.log(`[ServerSync] Outlet data (${canonicalOutletId}) saved to cloud server for instant cross-device sync.`);
    }
  } catch (err) {
    console.warn('[ServerSync] Server endpoint notice:', err);
  }

  // 2. Throttle and batch Firestore writes to protect daily token/quota
  const now = Date.now();
  const lastWrite = lastFirestoreWriteByOutlet[canonicalOutletId] || 0;
  const timeSinceLast = now - lastWrite;

  // Accumulate pending payload
  if (!pendingFirestorePayloadByOutlet[canonicalOutletId]) {
    pendingFirestorePayloadByOutlet[canonicalOutletId] = { email, data: {}, extraGlobal: {} };
  }
  pendingFirestorePayloadByOutlet[canonicalOutletId].email = email;
  pendingFirestorePayloadByOutlet[canonicalOutletId].data = {
    ...pendingFirestorePayloadByOutlet[canonicalOutletId].data,
    ...data
  };
  if (sanitizedExtraGlobal) {
    pendingFirestorePayloadByOutlet[canonicalOutletId].extraGlobal = {
      ...pendingFirestorePayloadByOutlet[canonicalOutletId].extraGlobal,
      ...sanitizedExtraGlobal
    };
  }

  let firestoreSuccess = false;
  // If high priority (e.g. deletion action) or throttle window elapsed, execute immediately
  if (isPriority || timeSinceLast >= FIRESTORE_MIN_WRITE_INTERVAL_MS) {
    if (pendingFirestoreTimerByOutlet[canonicalOutletId]) {
      clearTimeout(pendingFirestoreTimerByOutlet[canonicalOutletId]);
      delete pendingFirestoreTimerByOutlet[canonicalOutletId];
    }
    const payloadToExecute = pendingFirestorePayloadByOutlet[canonicalOutletId];
    delete pendingFirestorePayloadByOutlet[canonicalOutletId];
    firestoreSuccess = await executeFirestoreWrite(
      payloadToExecute.email,
      canonicalOutletId,
      payloadToExecute.data,
      payloadToExecute.extraGlobal
    );
  } else {
    // Within throttle window: schedule trailing write to execute once window expires
    if (!pendingFirestoreTimerByOutlet[canonicalOutletId]) {
      const delay = FIRESTORE_MIN_WRITE_INTERVAL_MS - timeSinceLast;
      pendingFirestoreTimerByOutlet[canonicalOutletId] = setTimeout(async () => {
        delete pendingFirestoreTimerByOutlet[canonicalOutletId];
        const pending = pendingFirestorePayloadByOutlet[canonicalOutletId];
        if (pending) {
          delete pendingFirestorePayloadByOutlet[canonicalOutletId];
          await executeFirestoreWrite(pending.email, canonicalOutletId, pending.data, pending.extraGlobal);
        }
      }, delay);
    }
    // Server sync already succeeded, so return true
    firestoreSuccess = true;
  }

  // Return true if either server sync or firestore succeeded so user edits are confirmed
  return serverSyncSuccess || firestoreSuccess;
}

export async function saveUserData(email: string, data: any, outletId?: string): Promise<boolean> {
  try {
    const globalSuccess = await saveGlobalData(email, data);
    let outletSuccess = true;
    const canonicalOutletId = normalizeOutletKey(outletId);
    if (canonicalOutletId && canonicalOutletId !== 'ALL' && canonicalOutletId !== 'SEMUA OUTLET') {
      const { staffList, leaveRecords, dailyOvertime, dailyMeetings, ...outletData } = data;
      outletSuccess = await saveOutletData(email, canonicalOutletId, outletData);
    }
    return globalSuccess && outletSuccess;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, outletId ? `${COLLECTION_NAME}/${outletId}` : COLLECTION_NAME);
    return false;
  }
}

export async function fetchUserData(
  email: string,
  outletId?: string,
  options?: { forceCloud?: boolean; skipFirestore?: boolean }
): Promise<any | null> {
  const canonicalOutletId = normalizeOutletKey(outletId);
  if (!canonicalOutletId || canonicalOutletId === 'ALL' || canonicalOutletId === 'SEMUA OUTLET') {
    return {};
  }

  const cacheKey = `BARN_OFFLINE_CACHE_${email.toLowerCase()}_${canonicalOutletId}`;
  let combinedData: any = {};

  // 1. Fetch from high-speed Server Sync API (instant across devices, 0 Firestore quota)
  try {
    const sRes = await fetch(`/api/sync/outlet/${encodeURIComponent(canonicalOutletId)}`);
    if (sRes.ok) {
      const sJson = await sRes.json();
      if (sJson.outlet && !sJson.outlet.isDeleted) {
        combinedData = unpackOutletDocument(sJson.outlet);
      }
    }
  } catch (e) {
    console.warn('[ServerSync] Server fetchUserData notice:', e);
  }

  // 2. Fetch from Firestore ONLY if server returned empty, forceCloud requested, or read cooldown elapsed
  const now = Date.now();
  const lastRead = lastOutletFirestoreRead[canonicalOutletId] || 0;
  const shouldHitFirestore =
    !options?.skipFirestore &&
    checkQuota() &&
    Boolean(auth.currentUser) &&
    (options?.forceCloud || Object.keys(combinedData).length === 0 || (now - lastRead) >= OUTLET_FIRESTORE_READ_COOLDOWN_MS);

  if (shouldHitFirestore) {
    lastOutletFirestoreRead[canonicalOutletId] = now;
    try {
      const outletRef = doc(db, COLLECTION_NAME, canonicalOutletId);
      const outletSnap = await getDoc(outletRef);
      if (outletSnap && outletSnap.exists()) {
        const rawDoc = outletSnap.data();
        if (!rawDoc?.isDeleted) {
          const cloudData = unpackOutletDocument(rawDoc);
          combinedData = mergeDeep(combinedData, cloudData);
        }
      }
    } catch (e) {
      if (!isOfflineError(e)) {
        handleFirestoreError(e, OperationType.GET, `${COLLECTION_NAME}/${canonicalOutletId}`);
      }
    }
  }

  if (Object.keys(combinedData).length === 0) {
    const cached = safeStorage.getItem(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {}
    }
    return {};
  }

  // Save to local storage for future offline access
  try {
    safeStorage.setItem(cacheKey, JSON.stringify(combinedData));
  } catch (cacheErr) {}

  return combinedData;
}

export async function fetchAllOutletsData(
  options?: { forceCloud?: boolean; skipFirestore?: boolean }
): Promise<Record<string, any> | null> {
  const cacheKey = "BARN_OFFLINE_CACHE_ALL_OUTLETS";
  const results: Record<string, any> = {};

  const upsertCanonicalOutlet = (rawId: string, rawData: any, lastUpdatedVal: string | null) => {
    if (!rawData || rawData.isDeleted) return;
    const canonId = normalizeOutletKey(rawId);
    if (!canonId || canonId === 'ALL' || canonId === 'SEMUA OUTLET') return;
    const filled = unpackOutletDocument(rawData);
    const existing = results[canonId];
    if (!existing || (lastUpdatedVal && (!existing._lastUpdated || lastUpdatedVal >= existing._lastUpdated))) {
      results[canonId] = {
        ...filled,
        outlet: canonId,
        isDeleted: false,
        _googleReview: rawData.googleReview || null,
        _lastUpdated: lastUpdatedVal || existing?._lastUpdated || null
      };
    }
  };

  // 1. Fetch from server-side sync API (primary, 0 Firestore quota)
  try {
    const sRes = await fetch('/api/sync/all-outlets');
    if (sRes.ok) {
      const sJson = await sRes.json();
      if (sJson.outlets && typeof sJson.outlets === 'object') {
        Object.entries(sJson.outlets).forEach(([id, data]: [string, any]) => {
          upsertCanonicalOutlet(id, data, data?.updatedAt || null);
        });
      }
    }
  } catch (err) {
    console.warn('[ServerSync] Fetch all outlets notice:', err);
  }

  // 2. Fallback to Firestore ONLY if server had no outlets or forceCloud is explicitly requested (with cooldown)
  const now = Date.now();
  const serverHasOutlets = Object.keys(results).length > 0;
  const shouldHitFirestore =
    !options?.skipFirestore &&
    checkQuota() &&
    Boolean(auth.currentUser) &&
    (options?.forceCloud || !serverHasOutlets) &&
    (options?.forceCloud || (now - lastAllOutletsFirestoreRead) >= ALL_OUTLETS_FIRESTORE_READ_COOLDOWN_MS);

  if (shouldHitFirestore) {
    lastAllOutletsFirestoreRead = now;
    try {
      const colRef = collection(db, COLLECTION_NAME);
      const snap = await getDocs(colRef);
      snap.forEach(docSnap => {
        const data = docSnap.data();
        const cloudUpdated = data?.updatedAt?.toDate?.()?.toISOString() || null;
        upsertCanonicalOutlet(docSnap.id, data, cloudUpdated);
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, COLLECTION_NAME);
    }
  }

  if (Object.keys(results).length > 0) {
    try {
      safeStorage.setItem(cacheKey, JSON.stringify(results));
    } catch {}
    return results;
  }

  const cached = safeStorage.getItem(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }
  return results;
}

export function startAllOutletsListener(onUpdate: (data: Record<string, any>) => void) {
  let isSubscribed = true;
  let lastKnownHash = '';
  let lastKnownEtag = '';
  let lastPollTime = 0;

  const upsertIntoMap = (target: Record<string, any>, rawId: string, rawData: any, lastUpdatedVal: string | null) => {
    if (!rawData || rawData.isDeleted) return;
    const canonId = normalizeOutletKey(rawId);
    if (!canonId || canonId === 'ALL' || canonId === 'SEMUA OUTLET') return;
    const filled = unpackOutletDocument(rawData);
    const existing = target[canonId];
    if (!existing || (lastUpdatedVal && (!existing._lastUpdated || lastUpdatedVal >= existing._lastUpdated))) {
      target[canonId] = {
        ...filled,
        outlet: canonId,
        isDeleted: false,
        _googleReview: rawData.googleReview || null,
        _lastUpdated: lastUpdatedVal || existing?._lastUpdated || null
      };
    }
  };

  // Zero-snapshot ETag polling from Server API (paused when tab hidden)
  const pollServerSync = async () => {
    if (!isSubscribed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    lastPollTime = Date.now();
    try {
      const headers: Record<string, string> = {};
      if (lastKnownEtag) {
        headers['If-None-Match'] = lastKnownEtag;
      }
      const res = await fetch('/api/sync/all-outlets', { headers });
      
      if (res.status === 304) {
        return;
      }

      if (res.ok) {
        const etag = res.headers.get('ETag');
        if (etag) lastKnownEtag = etag;

        const json = await res.json();
        if (json.outlets && typeof json.outlets === 'object') {
          const processed: Record<string, any> = {};
          Object.entries(json.outlets).forEach(([id, data]: [string, any]) => {
            upsertIntoMap(processed, id, data, data?.updatedAt || null);
          });
          const newHash = JSON.stringify(processed);
          if (newHash !== lastKnownHash) {
            lastKnownHash = newHash;
            onUpdate(processed);
          }
        }
      }
    } catch {
      // Ignore background poll errors
    }
  };

  pollServerSync();
  const pollInterval = setInterval(pollServerSync, 20000);

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible' && isSubscribed && (Date.now() - lastPollTime >= 5000)) {
      pollServerSync();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  const cleanup = () => {
    isSubscribed = false;
    clearInterval(pollInterval);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };

  activeListeners.push(cleanup);
  return () => {
    cleanup();
    activeListeners = activeListeners.filter(u => u !== cleanup);
  };
}

export function startRealtimeListener(
  email: string, 
  outletId: string,
  onUpdate: (data: any) => void,
  onStatusChange?: (status: 'connected' | 'disconnected' | 'reconnecting') => void
) {
  let isSubscribed = true;
  const canonicalOutletId = normalizeOutletKey(outletId);

  // Hanya mengambil data 1 kali saat halaman dibuka atau outletId berubah agar tidak menimpa ketikan
  const fetchData = async () => {
    if (!isSubscribed || !canonicalOutletId || canonicalOutletId === 'ALL' || canonicalOutletId === 'SEMUA OUTLET') return;
    try {
      const res = await fetch(`/api/sync/outlet/${encodeURIComponent(canonicalOutletId)}`);
      if (res.ok) {
        const json = await res.json();
        if (json.outlet && !json.outlet.isDeleted && isSubscribed) {
          const filled = unpackOutletDocument(json.outlet);
          onUpdate(filled);
          onStatusChange?.('connected');
          return;
        }
      }
    } catch (e) {}

    // Fallback: ambil 1 kali dari Firestore via getDoc hanya jika cooldown terpenuhi dan server kosong
    const now = Date.now();
    const lastRead = lastOutletFirestoreRead[canonicalOutletId] || 0;
    if (checkQuota() && auth.currentUser && (now - lastRead) >= OUTLET_FIRESTORE_READ_COOLDOWN_MS) {
      lastOutletFirestoreRead[canonicalOutletId] = now;
      try {
        const outletRef = doc(db, COLLECTION_NAME, canonicalOutletId);
        const snap = await getDoc(outletRef);
        if (snap.exists() && isSubscribed) {
          const docData = snap.data();
          if (docData && !docData.isDeleted) {
            const filledMonthlyData = unpackOutletDocument(docData);
            onUpdate(filledMonthlyData);
          }
        }
        onStatusChange?.('connected');
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `${COLLECTION_NAME}/${canonicalOutletId}`);
      }
    }
  };

  fetchData();
  onStatusChange?.('connected');

  const cleanup = () => {
    isSubscribed = false;
  };

  activeListeners.push(cleanup);
  return () => {
    cleanup();
    activeListeners = activeListeners.filter(u => u !== cleanup);
  };
}

// Note: testConnection and quota check logic is now managed by explicit calls rather than top-level side effects
// to prevent "The operation is insecure" errors on module load.

export function resetQuotaExceeded() {
  quotaExceeded = false;
  lastQuotaErrorTime = 0;
  try {
    safeStorage.removeItem('FIRESTORE_QUOTA_EXCEEDED');
    safeStorage.removeItem('FIRESTORE_QUOTA_ERROR_TIME');
  } catch (e) {
    // Ignore safeStorage access errors
  }
  console.info('[CloudSync] Quota state reset. Sync resumed.');
}

export function isQuotaExceeded(): boolean {
  return !checkQuota();
}
