import { initializeApp, getApps, getApp } from "firebase/app";
import { 
  getFirestore, 
  initializeFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager, 
  CACHE_SIZE_UNLIMITED,
  memoryLocalCache 
} from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAGUJvf45McqcpNSrBuHrnim-RgB7njGy4",
  authDomain: "csktanggerang.firebaseapp.com",
  projectId: "csktanggerang",
  storageBucket: "csktanggerang.firebasestorage.app",
  messagingSenderId: "849370150169",
  appId: "1:849370150169:web:8451062977038a41798188"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// VERSI IRIT 1000 BROWSER - ANTI LELET
// Gunakan experimentalForceLongPolling agar koneksi Firestore stabil di iframe/proxy tanpa timeout WebChannel 10 detik
let firestoreDb: any;
try {
  firestoreDb = initializeFirestore(app, {
    experimentalForceLongPolling: true,
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
      cacheSizeBytes: CACHE_SIZE_UNLIMITED
    })
  });
} catch {
  try {
    firestoreDb = initializeFirestore(app, {
      experimentalForceLongPolling: true,
      localCache: memoryLocalCache()
    });
  } catch {
    firestoreDb = getFirestore(app);
  }
}

export const db = firestoreDb;
export const auth = getAuth(app);
export { app };