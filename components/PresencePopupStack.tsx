import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { PresenceEvent } from '../types';

interface Props {
  popups: PresenceEvent[];
  onDismiss: (id: string) => void;
}

const PresencePopupStack: React.FC<Props> = ({ popups, onDismiss }) => {
  if (!popups || popups.length === 0) return null;

  return (
    <div
      className="fixed top-20 right-3 sm:right-6 z-[240] flex flex-col gap-2.5 w-[calc(100vw-1.5rem)] sm:w-96 pointer-events-none"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {popups.map((event) => {
          const isLogin = event.type === 'LOGIN';
          const displayName = event.displayName || (event.email ? event.email.split('@')[0] : 'User');
          const timeLabel = new Date(event.timestamp).toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });

          return (
            <motion.div
              key={event.id}
              layout
              initial={{ opacity: 0, x: 50, scale: 0.92 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 60, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 360, damping: 28 }}
              className={`pointer-events-auto relative overflow-hidden rounded-2xl bg-slate-900/95 backdrop-blur-xl shadow-2xl border p-3.5 text-left ${
                isLogin
                  ? 'border-emerald-500/50 shadow-emerald-950/50'
                  : 'border-rose-500/50 shadow-rose-950/50'
              }`}
            >
              {/* Top Accent Bar */}
              <div
                className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${
                  isLogin ? 'from-emerald-400 via-teal-400 to-emerald-500' : 'from-rose-500 via-orange-400 to-rose-600'
                }`}
              />

              <div className="flex items-start gap-3">
                {/* User Avatar + Login/Logout Badge */}
                <div className="relative shrink-0 mt-0.5">
                  <div
                    className={`w-11 h-11 rounded-2xl overflow-hidden flex items-center justify-center text-sm font-black text-white border shadow-md ${
                      isLogin
                        ? 'bg-gradient-to-br from-emerald-500 to-teal-600 border-emerald-300/40'
                        : 'bg-gradient-to-br from-rose-500 to-orange-600 border-rose-300/40'
                    }`}
                  >
                    {event.photoURL ? (
                      <img
                        src={event.photoURL}
                        alt={displayName}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <span>{displayName.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <span
                    className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-2 border-slate-900 flex items-center justify-center text-[9px] text-white shadow ${
                      isLogin ? 'bg-emerald-500' : 'bg-rose-500'
                    }`}
                  >
                    <i className={`fas ${isLogin ? 'fa-sign-in-alt' : 'fa-sign-out-alt'}`}></i>
                  </span>
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                        isLogin
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                          : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          isLogin ? 'bg-emerald-400 animate-ping' : 'bg-rose-400'
                        }`}
                      />
                      {isLogin ? 'USER LOG IN' : 'USER LOG OUT'}
                    </span>
                    <span className="text-[9px] font-bold text-slate-400 tabular-nums shrink-0">
                      {timeLabel}
                    </span>
                  </div>

                  <p className="text-xs font-black text-white truncate mt-1.5">
                    {displayName}
                  </p>
                  <p className="text-[11px] font-medium text-slate-300 truncate">
                    {event.email}
                  </p>

                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <span className="text-[9px] font-bold text-slate-400 truncate">
                      {isLogin ? 'Baru saja membuka aplikasi' : 'Telah keluar dari aplikasi'}
                    </span>
                    {event.outlet && (
                      <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded-md bg-white/5 text-amber-300 border border-white/10 shrink-0">
                        {event.outlet}
                      </span>
                    )}
                  </div>
                </div>

                {/* Dismiss */}
                <button
                  type="button"
                  onClick={() => onDismiss(event.id)}
                  className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/15 text-slate-400 hover:text-white flex items-center justify-center transition-colors shrink-0 cursor-pointer"
                  aria-label="Tutup notifikasi"
                >
                  <i className="fas fa-times text-[10px]"></i>
                </button>
              </div>

              {/* Auto-dismiss progress bar */}
              <motion.div
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: 6.5, ease: 'linear' }}
                style={{ transformOrigin: 'left' }}
                className={`absolute bottom-0 left-0 right-0 h-0.5 ${
                  isLogin ? 'bg-emerald-400/70' : 'bg-rose-400/70'
                }`}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};

export default PresencePopupStack;
