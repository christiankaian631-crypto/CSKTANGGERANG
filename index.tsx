
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { safeStorage, safeSessionStorage } from './lib/safeStorage';

// Prevent unhandled Firestore SDK assertions and Firebase Installations/Analytics errors from breaking the UI
const isIgnorableFirebaseError = (err: any) => {
  const str = String(err?.message || err?.reason?.message || err?.code || err || '');
  return (
    str.includes('INTERNAL ASSERTION FAILED') ||
    str.includes('Unexpected state') ||
    str.includes('(ID: ca9)') ||
    str.includes('(ID: b815)') ||
    str.includes('installations/request-failed') ||
    str.includes('installations') ||
    str.includes('Create Installation request failed')
  );
};

window.addEventListener('error', (event) => {
  if (isIgnorableFirebaseError(event.error) || isIgnorableFirebaseError(event.message)) {
    console.warn('[Firebase SDK Error Suppressed]:', event.message || event.error);
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }
}, true);

window.addEventListener('unhandledrejection', (event) => {
  if (isIgnorableFirebaseError(event.reason)) {
    console.warn('[Firebase SDK Rejection Suppressed]:', event.reason);
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  declare props: { children: React.ReactNode };
  declare state: ErrorBoundaryState;

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'Terjadi kesalahan pada tampilan aplikasi.'
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[AppErrorBoundary] Uncaught render error:', error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleResetAndReload = () => {
    try {
      safeStorage.removeItem('BARN_ACTIVE_MODULE');
      safeStorage.removeItem('BARN_ACTIVE_RM_TAB');
      safeStorage.removeItem('BARN_SELECTED_OUTLET');
      safeStorage.removeItem('BARN_FILTERS');
      safeSessionStorage.removeItem('SH_TAB_SESSION_ID');
    } catch {
      // Ignore storage errors
    }
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full bg-slate-900 text-white flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-slate-950/90 border border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl text-center space-y-5">
            <div className="w-16 h-16 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center mx-auto text-rose-400">
              <i className="fas fa-exclamation-triangle text-2xl"></i>
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-black uppercase tracking-tight text-white">
                Aplikasi Perlu Dimuat Ulang
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                Terjadi kendala sementara saat merender halaman web. Data lokal Anda tetap aman.
              </p>
              {this.state.errorMessage && (
                <p className="text-[11px] text-rose-300/80 bg-rose-950/30 border border-rose-500/20 rounded-xl px-3 py-2 break-words">
                  {this.state.errorMessage}
                </p>
              )}
            </div>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <button
                type="button"
                onClick={this.handleReload}
                className="flex-1 py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black uppercase tracking-wider transition-all cursor-pointer"
              >
                Muat Ulang Halaman
              </button>
              <button
                type="button"
                onClick={this.handleResetAndReload}
                className="flex-1 py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold uppercase tracking-wider border border-white/10 transition-all cursor-pointer"
              >
                Reset Sesi &amp; Muat Ulang
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
