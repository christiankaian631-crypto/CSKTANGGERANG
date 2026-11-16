import React, { useState, useMemo } from 'react';
import { AppState, Spk3Category, Spk3Record, Staff } from '../types';
import { extractOutletStaffOptions } from '../lib/manpowerUtils';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { motion, AnimatePresence } from 'motion/react';
import FeatureSubmitSyncButton from './FeatureSubmitSyncButton';

interface Props {
  data: AppState;
  staffList?: Staff[];
  selectedOutlet?: string;
  filters?: {
    month?: string;
    year?: string;
    startDate?: string;
    endDate?: string;
  };
  onUpdate?: (updater: (prev: AppState) => AppState) => void;
  showToast?: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export const SPK3_CATEGORIES: Spk3Category[] = [
  'Temuan Inspeksi',
  'Temuan SOS',
  'Temuan Grooming'
];

const AREA_OPTIONS = [
  'Dining / Service',
  'Kitchen',
  'Bar',
  'Cashier',
  'Host / Greeter',
  'Back Area / Locker',
  'Steward / Warehouse',
  'All Area'
];

export const Spk3Module: React.FC<Props> = ({
  data,
  staffList = [],
  selectedOutlet = '',
  filters,
  onUpdate,
  showToast
}) => {
  const currentOutlet = selectedOutlet || data.outlet || 'SH THE BARN';
  const currentDate = filters?.startDate || new Date().toISOString().split('T')[0];
  const currentMonthKey = useMemo(() => {
    if (filters?.year && filters?.month !== undefined) {
      const mNum = Number(filters.month);
      if (!isNaN(mNum)) {
        return `${filters.year}-${String(mNum + 1).padStart(2, '0')}`;
      }
    }
    return currentDate.substring(0, 7);
  }, [filters?.year, filters?.month, currentDate]);

  const [activeSubTab, setActiveSubTab] = useState<'DAILY_PERFORMANCE' | 'LOG_TEMUAN' | 'RANKING_PELAKU'>('DAILY_PERFORMANCE');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<'ALL' | Spk3Category>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Spk3Record | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Form State
  const [formDate, setFormDate] = useState(currentDate);
  const [formCategory, setFormCategory] = useState<Spk3Category>('Temuan Inspeksi');
  const [formPelaku, setFormPelaku] = useState('');
  const [formArea, setFormArea] = useState(AREA_OPTIONS[0]);
  const [formDetail, setFormDetail] = useState('');
  const [formTindakLanjut, setFormTindakLanjut] = useState('');
  const [formDeduction, setFormDeduction] = useState<number>(10);

  // Manpower-linked staff options
  const manpowerOptions = useMemo(() => {
    return extractOutletStaffOptions(
      data.manpowerData,
      staffList.length > 0 ? staffList : data.staffList,
      currentOutlet,
      currentMonthKey
    );
  }, [data.manpowerData, staffList, data.staffList, currentOutlet, currentMonthKey]);

  // All SPK3 records
  const allRecords = useMemo(() => {
    const list: Spk3Record[] = [];
    const seen = new Set<string>();
    if (data.dailySpk3Records && typeof data.dailySpk3Records === 'object') {
      Object.values(data.dailySpk3Records).forEach(dayList => {
        if (Array.isArray(dayList)) {
          dayList.forEach(item => {
            if (item && item.id && !seen.has(item.id)) {
              seen.add(item.id);
              list.push(item);
            }
          });
        }
      });
    }
    if (Array.isArray(data.spk3Records)) {
      data.spk3Records.forEach(item => {
        if (item && item.id && !seen.has(item.id)) {
          seen.add(item.id);
          list.push(item);
        }
      });
    }
    return list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [data.dailySpk3Records, data.spk3Records]);

  const monthRecords = useMemo(() => {
    return allRecords.filter(r => r.date.startsWith(currentMonthKey));
  }, [allRecords, currentMonthKey]);

  const filteredRecords = useMemo(() => {
    let res = monthRecords;
    if (selectedCategoryFilter !== 'ALL') {
      res = res.filter(r => r.category === selectedCategoryFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      res = res.filter(r =>
        (r.pelaku || '').toLowerCase().includes(q) ||
        (r.category || '').toLowerCase().includes(q) ||
        (r.temuanDetail || '').toLowerCase().includes(q) ||
        (r.area || '').toLowerCase().includes(q) ||
        (r.tindakLanjut || '').toLowerCase().includes(q)
      );
    }
    return res;
  }, [monthRecords, selectedCategoryFilter, searchQuery]);

  // Daily Point Performance calculation across every day of the selected month up to today (or end of month if past month)
  const dailyPerformanceRows = useMemo(() => {
    const [yrStr, moStr] = currentMonthKey.split('-');
    const yr = parseInt(yrStr, 10) || new Date().getFullYear();
    const mo = (parseInt(moStr, 10) || 1) - 1;
    const daysInMonth = new Date(yr, mo + 1, 0).getDate();

    const todayStr = new Date().toISOString().split('T')[0];
    const isCurrentMonth = todayStr.startsWith(currentMonthKey);
    const maxDay = isCurrentMonth ? Math.min(daysInMonth, new Date().getDate()) : daysInMonth;

    // Also include any future date in current month that already has input
    const dayMap = new Map<string, Spk3Record[]>();
    monthRecords.forEach(rec => {
      const arr = dayMap.get(rec.date) || [];
      arr.push(rec);
      dayMap.set(rec.date, arr);
    });

    const rows: Array<{
      date: string;
      inspeksiCount: number;
      sosCount: number;
      groomingCount: number;
      totalFindings: number;
      totalDeduction: number;
      dailyPointPerformance: number;
      pelakuList: string[];
      status: 'PERFECT' | 'GOOD' | 'WARNING' | 'CRITICAL';
    }> = [];

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentMonthKey}-${String(d).padStart(2, '0')}`;
      const dayItems = dayMap.get(dateStr) || [];
      if (d > maxDay && dayItems.length === 0) continue;

      const inspeksiCount = dayItems.filter(i => i.category === 'Temuan Inspeksi').length;
      const sosCount = dayItems.filter(i => i.category === 'Temuan SOS').length;
      const groomingCount = dayItems.filter(i => i.category === 'Temuan Grooming').length;
      const totalFindings = dayItems.length;
      const totalDeduction = dayItems.reduce((sum, i) => sum + (Number(i.deductionPoints) || 10), 0);
      const dailyPointPerformance = Math.max(0, 100 - totalDeduction);

      const status: 'PERFECT' | 'GOOD' | 'WARNING' | 'CRITICAL' =
        dailyPointPerformance === 100
          ? 'PERFECT'
          : dailyPointPerformance >= 80
          ? 'GOOD'
          : dailyPointPerformance >= 60
          ? 'WARNING'
          : 'CRITICAL';

      const pelakuList = Array.from(new Set(dayItems.map(i => i.pelaku).filter(Boolean)));

      rows.push({
        date: dateStr,
        inspeksiCount,
        sosCount,
        groomingCount,
        totalFindings,
        totalDeduction,
        dailyPointPerformance,
        pelakuList,
        status
      });
    }

    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [currentMonthKey, monthRecords]);

  // Staff Ranking (Pelaku dengan temuan terbanyak)
  const pelakuRanking = useMemo(() => {
    const map = new Map<string, {
      pelaku: string;
      role: string;
      division: string;
      inspeksi: number;
      sos: number;
      grooming: number;
      totalTemuan: number;
      totalDeduction: number;
      lastDate: string;
    }>();

    monthRecords.forEach(rec => {
      const name = (rec.pelaku || 'Tidak Diketahui').trim();
      const key = name.toLowerCase();
      const cur = map.get(key) || {
        pelaku: name,
        role: rec.pelakuRole || '-',
        division: rec.pelakuDivision || '-',
        inspeksi: 0,
        sos: 0,
        grooming: 0,
        totalTemuan: 0,
        totalDeduction: 0,
        lastDate: rec.date
      };
      if (rec.category === 'Temuan Inspeksi') cur.inspeksi += 1;
      else if (rec.category === 'Temuan SOS') cur.sos += 1;
      else if (rec.category === 'Temuan Grooming') cur.grooming += 1;
      cur.totalTemuan += 1;
      cur.totalDeduction += Number(rec.deductionPoints) || 10;
      if (rec.date > cur.lastDate) cur.lastDate = rec.date;
      map.set(key, cur);
    });

    return Array.from(map.values()).sort((a, b) => b.totalTemuan - a.totalTemuan || b.totalDeduction - a.totalDeduction);
  }, [monthRecords]);

  // Summary Stats
  const stats = useMemo(() => {
    const inspeksi = monthRecords.filter(r => r.category === 'Temuan Inspeksi').length;
    const sos = monthRecords.filter(r => r.category === 'Temuan SOS').length;
    const grooming = monthRecords.filter(r => r.category === 'Temuan Grooming').length;

    const todayRow = dailyPerformanceRows.find(r => r.date === currentDate) || dailyPerformanceRows[0];
    const todayScore = todayRow ? todayRow.dailyPointPerformance : 100;
    const avgMonthlyScore = dailyPerformanceRows.length > 0
      ? Number((dailyPerformanceRows.reduce((acc, r) => acc + r.dailyPointPerformance, 0) / dailyPerformanceRows.length).toFixed(1))
      : 100;

    return {
      totalTemuan: monthRecords.length,
      inspeksi,
      sos,
      grooming,
      todayScore,
      avgMonthlyScore
    };
  }, [monthRecords, dailyPerformanceRows, currentDate]);

  const handleOpenAddModal = () => {
    setEditingItem(null);
    setFormDate(currentDate);
    setFormCategory('Temuan Inspeksi');
    setFormPelaku(manpowerOptions[0]?.name || '');
    setFormArea(AREA_OPTIONS[0]);
    setFormDetail('');
    setFormTindakLanjut('');
    setFormDeduction(10);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (item: Spk3Record) => {
    setEditingItem(item);
    setFormDate(item.date || currentDate);
    setFormCategory(item.category || 'Temuan Inspeksi');
    setFormPelaku(item.pelaku || '');
    setFormArea(item.area || AREA_OPTIONS[0]);
    setFormDetail(item.temuanDetail || '');
    setFormTindakLanjut(item.tindakLanjut || '');
    setFormDeduction(Number(item.deductionPoints) || 10);
    setIsModalOpen(true);
  };

  const handleSaveRecord = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formPelaku.trim() || !formDetail.trim()) {
      showToast?.('Mohon pilih Nama Pelaku (Manpower) dan isi Detail Temuan!', 'error');
      return;
    }

    const matched = manpowerOptions.find(s => s.name.toLowerCase() === formPelaku.trim().toLowerCase());

    const record: Spk3Record = {
      id: editingItem?.id || `spk3_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      outlet: currentOutlet,
      date: formDate,
      category: formCategory,
      pelaku: formPelaku.trim(),
      pelakuRole: matched?.role || '',
      pelakuDivision: matched?.division || '',
      temuanDetail: formDetail.trim(),
      area: formArea,
      tindakLanjut: formTindakLanjut.trim() || '-',
      deductionPoints: Number(formDeduction) || 10,
      createdAt: editingItem?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (onUpdate) {
      onUpdate(prev => {
        const prevDaily = { ...(prev.dailySpk3Records || {}) };
        if (editingItem && editingItem.date !== formDate && Array.isArray(prevDaily[editingItem.date])) {
          prevDaily[editingItem.date] = prevDaily[editingItem.date].filter(x => x.id !== editingItem.id);
        }
        const dayList = Array.isArray(prevDaily[formDate]) ? [...prevDaily[formDate]] : [];
        const idx = dayList.findIndex(x => x.id === record.id);
        if (idx >= 0) dayList[idx] = record;
        else dayList.push(record);
        prevDaily[formDate] = dayList;

        const prevFlat = Array.isArray(prev.spk3Records) ? [...prev.spk3Records] : [];
        const flatIdx = prevFlat.findIndex(x => x.id === record.id);
        if (flatIdx >= 0) prevFlat[flatIdx] = record;
        else prevFlat.push(record);

        return {
          ...prev,
          dailySpk3Records: prevDaily,
          spk3Records: prevFlat
        };
      });
    }

    try {
      window.dispatchEvent(new CustomEvent('appSpk3Updated', { detail: { record, outlet: currentOutlet } }));
    } catch {}

    setIsModalOpen(false);
    showToast?.(editingItem ? 'Data SPK3 berhasil diperbarui!' : 'Temuan SPK3 berhasil disimpan!', 'success');
  };

  const handleDeleteRecord = (id: string) => {
    const target = allRecords.find(r => r.id === id);
    if (!target) return;

    if (onUpdate) {
      onUpdate(prev => {
        const prevDaily = { ...(prev.dailySpk3Records || {}) };
        if (Array.isArray(prevDaily[target.date])) {
          prevDaily[target.date] = prevDaily[target.date].filter(x => x.id !== id);
        }
        const prevFlat = Array.isArray(prev.spk3Records) ? prev.spk3Records.filter(x => x.id !== id) : [];
        return {
          ...prev,
          dailySpk3Records: prevDaily,
          spk3Records: prevFlat
        };
      });
    }

    try {
      window.dispatchEvent(new CustomEvent('appSpk3Updated', { detail: { deletedId: id, outlet: currentOutlet } }));
    } catch {}

    setDeleteConfirmId(null);
    showToast?.('Temuan SPK3 berhasil dihapus.', 'info');
  };

  const handleExportExcel = async () => {
    try {
      const wb = new ExcelJS.Workbook();
      const ws1 = wb.addWorksheet('Point Performance Daily');
      ws1.addRow([`SPK3 DAILY POINT PERFORMANCE - ${currentOutlet} (${currentMonthKey})`]);
      ws1.addRow(['Tanggal', 'Temuan Inspeksi', 'Temuan SOS', 'Temuan Grooming', 'Total Temuan', 'Pengurangan Poin', 'Point Performance Daily', 'Status', 'Pelaku']);
      dailyPerformanceRows.forEach(r => {
        ws1.addRow([r.date, r.inspeksiCount, r.sosCount, r.groomingCount, r.totalFindings, r.totalDeduction, r.dailyPointPerformance, r.status, r.pelakuList.join(', ') || '-']);
      });

      const ws2 = wb.addWorksheet('Detail Temuan SPK3');
      ws2.addRow(['No', 'Tanggal', 'Kategori Temuan', 'Nama Pelaku', 'Jabatan', 'Divisi', 'Area', 'Detail Temuan', 'Tindak Lanjut', 'Poin Pengurang']);
      filteredRecords.forEach((r, idx) => {
        ws2.addRow([idx + 1, r.date, r.category, r.pelaku, r.pelakuRole || '-', r.pelakuDivision || '-', r.area || '-', r.temuanDetail, r.tindakLanjut || '-', r.deductionPoints || 10]);
      });

      const buffer = await wb.xlsx.writeBuffer();
      saveAs(new Blob([buffer]), `SPK3_Performance_${currentOutlet}_${currentMonthKey}.xlsx`);
      showToast?.('Excel SPK3 berhasil diunduh!', 'success');
    } catch {
      showToast?.('Gagal mengekspor Excel SPK3.', 'error');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in pb-16">
      {/* Header */}
      <div className="glass-card p-6 md:p-8 border border-white/10 shadow-2xl bg-gradient-to-br from-slate-900 via-slate-900 to-amber-950/30">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-4 text-left">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white shadow-xl shadow-amber-900/40 shrink-0">
              <i className="fas fa-shield-alt text-2xl"></i>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl md:text-2xl font-black text-white uppercase tracking-tight">
                  SPK3 & Daily Point Performance
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  {currentOutlet}
                </span>
              </div>
              <p className="text-xs text-slate-400 font-medium mt-1">
                Monitoring Temuan Inspeksi, SOS & Grooming dengan Nama Pelaku otomatis dari Tabel Manpower serta Point Performance harian (Skor 0–100).
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleOpenAddModal}
              className="px-5 py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-slate-950 font-black text-xs uppercase tracking-wider shadow-xl flex items-center gap-2 transition-all active:scale-95 cursor-pointer"
            >
              <i className="fas fa-plus-circle"></i>
              <span>Input Temuan SPK3</span>
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="px-4 py-3 rounded-2xl bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 font-black text-xs uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer"
            >
              <i className="fas fa-file-excel"></i>
              <span>Excel</span>
            </button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mt-6">
          <div className="p-4 rounded-2xl bg-emerald-950/30 border border-emerald-500/30 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-emerald-300">Point Daily ({currentDate})</div>
            <div className="text-2xl font-black text-white mt-1">{stats.todayScore} <span className="text-xs font-bold text-slate-400">/ 100</span></div>
            <div className="text-[10px] font-bold text-emerald-400 mt-1">Skor Hari Terpilih</div>
          </div>
          <div className="p-4 rounded-2xl bg-indigo-950/30 border border-indigo-500/30 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-indigo-300">Avg Point Bulanan</div>
            <div className="text-2xl font-black text-white mt-1">{stats.avgMonthlyScore}</div>
            <div className="text-[10px] font-bold text-indigo-300/80 mt-1">Periode {currentMonthKey}</div>
          </div>
          <div className="p-4 rounded-2xl bg-slate-950/60 border border-white/10 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Total Temuan</div>
            <div className="text-2xl font-black text-white mt-1">{stats.totalTemuan}</div>
            <div className="text-[10px] font-bold text-slate-400 mt-1">Semua Kategori</div>
          </div>
          <div className="p-4 rounded-2xl bg-amber-950/30 border border-amber-500/30 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-amber-300">Temuan Inspeksi</div>
            <div className="text-2xl font-black text-white mt-1">{stats.inspeksi}</div>
            <div className="text-[10px] font-bold text-amber-300/80 mt-1">Audit / Standar</div>
          </div>
          <div className="p-4 rounded-2xl bg-rose-950/30 border border-rose-500/30 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-rose-300">Temuan SOS</div>
            <div className="text-2xl font-black text-white mt-1">{stats.sos}</div>
            <div className="text-[10px] font-bold text-rose-300/80 mt-1">Speed of Service</div>
          </div>
          <div className="p-4 rounded-2xl bg-purple-950/30 border border-purple-500/30 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-purple-300">Temuan Grooming</div>
            <div className="text-2xl font-black text-white mt-1">{stats.grooming}</div>
            <div className="text-[10px] font-bold text-purple-300/80 mt-1">Penampilan Staff</div>
          </div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex bg-slate-900/90 p-1.5 rounded-2xl border border-white/10 gap-1">
          {[
            { id: 'DAILY_PERFORMANCE', label: 'Point Performance Daily', icon: 'fa-chart-line' },
            { id: 'LOG_TEMUAN', label: `Log Temuan (${filteredRecords.length})`, icon: 'fa-list' },
            { id: 'RANKING_PELAKU', label: `Ranking Pelaku (${pelakuRanking.length})`, icon: 'fa-users' }
          ].map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveSubTab(t.id as any)}
              className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer ${
                activeSubTab === t.id
                  ? 'bg-amber-500 text-slate-950 shadow-lg'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <i className={`fas ${t.icon}`}></i>
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {activeSubTab === 'LOG_TEMUAN' && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedCategoryFilter}
              onChange={(e) => setSelectedCategoryFilter(e.target.value as any)}
              className="bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none"
            >
              <option value="ALL">Semua Kategori Temuan</option>
              {SPK3_CATEGORIES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari pelaku / detail temuan..."
              className="bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 outline-none"
            />
          </div>
        )}
      </div>

      {/* Tab Content */}
      {activeSubTab === 'DAILY_PERFORMANCE' && (
        <div className="glass-card border border-white/10 overflow-hidden shadow-2xl">
          <div className="p-4 border-b border-white/10 bg-slate-950/50 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">
              Daily Point Performance Outlet ({currentMonthKey})
            </h3>
            <span className="text-[10px] font-bold text-slate-400">
              Rumus: Skor Awal 100 Poin/Hari − Total Poin Pengurang Temuan (Default −10 per temuan)
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-slate-950/80 border-b border-white/10 text-[10px] font-black uppercase tracking-wider text-slate-400">
                  <th className="p-3.5">Tanggal</th>
                  <th className="p-3.5 text-center">Inspeksi</th>
                  <th className="p-3.5 text-center">SOS</th>
                  <th className="p-3.5 text-center">Grooming</th>
                  <th className="p-3.5 text-center">Total Temuan</th>
                  <th className="p-3.5 text-center">Pengurangan</th>
                  <th className="p-3.5 text-center">Point Performance Daily</th>
                  <th className="p-3.5 text-center">Status</th>
                  <th className="p-3.5">Pelaku Tercatat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-xs">
                {dailyPerformanceRows.map(row => (
                  <tr key={row.date} className={`hover:bg-white/5 transition-colors ${row.date === currentDate ? 'bg-amber-500/5' : ''}`}>
                    <td className="p-3.5 font-bold text-white whitespace-nowrap">{row.date}</td>
                    <td className="p-3.5 text-center font-bold text-amber-300">{row.inspeksiCount}</td>
                    <td className="p-3.5 text-center font-bold text-rose-300">{row.sosCount}</td>
                    <td className="p-3.5 text-center font-bold text-purple-300">{row.groomingCount}</td>
                    <td className="p-3.5 text-center font-black text-white">{row.totalFindings}</td>
                    <td className="p-3.5 text-center font-bold text-rose-400">
                      {row.totalDeduction > 0 ? `-${row.totalDeduction}` : '0'}
                    </td>
                    <td className="p-3.5 text-center">
                      <span className={`inline-block px-3 py-1 rounded-xl font-black text-xs ${
                        row.dailyPointPerformance === 100
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : row.dailyPointPerformance >= 80
                          ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                          : row.dailyPointPerformance >= 60
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      }`}>
                        {row.dailyPointPerformance} / 100
                      </span>
                    </td>
                    <td className="p-3.5 text-center">
                      <span className={`text-[10px] font-black uppercase ${
                        row.status === 'PERFECT'
                          ? 'text-emerald-400'
                          : row.status === 'GOOD'
                          ? 'text-blue-400'
                          : row.status === 'WARNING'
                          ? 'text-amber-400'
                          : 'text-rose-400'
                      }`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="p-3.5 text-slate-300 text-[11px]">
                      {row.pelakuList.length > 0 ? row.pelakuList.join(', ') : <span className="text-slate-600">Zero Temuan</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeSubTab === 'LOG_TEMUAN' && (
        <div className="glass-card border border-white/10 overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[950px]">
              <thead>
                <tr className="bg-slate-950/80 border-b border-white/10 text-[10px] font-black uppercase tracking-wider text-slate-400">
                  <th className="p-3.5 w-12 text-center">No</th>
                  <th className="p-3.5">Tanggal</th>
                  <th className="p-3.5">Kategori Temuan</th>
                  <th className="p-3.5">Nama Pelaku (Manpower)</th>
                  <th className="p-3.5">Area</th>
                  <th className="p-3.5">Detail Temuan</th>
                  <th className="p-3.5">Tindak Lanjut / Coaching</th>
                  <th className="p-3.5 text-center">Pengurang Poin</th>
                  <th className="p-3.5 text-center">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-xs">
                {filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-12 text-center text-slate-500 font-bold uppercase">
                      Belum ada temuan SPK3 pada periode ini.
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map((item, idx) => (
                    <tr key={item.id} className="hover:bg-white/5 transition-colors align-top">
                      <td className="p-3.5 text-center text-slate-500 font-bold">{idx + 1}</td>
                      <td className="p-3.5 font-bold text-white whitespace-nowrap">{item.date}</td>
                      <td className="p-3.5">
                        <span className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-black border whitespace-nowrap ${
                          item.category === 'Temuan Inspeksi'
                            ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                            : item.category === 'Temuan SOS'
                            ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                            : 'bg-purple-500/15 text-purple-300 border-purple-500/30'
                        }`}>
                          {item.category}
                        </span>
                      </td>
                      <td className="p-3.5">
                        <div className="font-black text-white">{item.pelaku}</div>
                        {(item.pelakuRole || item.pelakuDivision) && (
                          <div className="text-[10px] text-slate-400 font-bold">
                            {item.pelakuRole}{item.pelakuDivision ? ` • ${item.pelakuDivision}` : ''}
                          </div>
                        )}
                      </td>
                      <td className="p-3.5 text-amber-300 font-bold">{item.area || '-'}</td>
                      <td className="p-3.5 text-slate-200 whitespace-pre-wrap">{item.temuanDetail}</td>
                      <td className="p-3.5 text-emerald-200 whitespace-pre-wrap">{item.tindakLanjut || '-'}</td>
                      <td className="p-3.5 text-center font-black text-rose-400">-{item.deductionPoints || 10}</td>
                      <td className="p-3.5 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenEditModal(item)}
                            className="w-8 h-8 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-300 flex items-center justify-center cursor-pointer"
                          >
                            <i className="fas fa-edit text-xs"></i>
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmId(item.id)}
                            className="w-8 h-8 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 flex items-center justify-center cursor-pointer"
                          >
                            <i className="fas fa-trash text-xs"></i>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeSubTab === 'RANKING_PELAKU' && (
        <div className="glass-card border border-white/10 overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[750px]">
              <thead>
                <tr className="bg-slate-950/80 border-b border-white/10 text-[10px] font-black uppercase tracking-wider text-slate-400">
                  <th className="p-3.5 w-12 text-center">No</th>
                  <th className="p-3.5">Nama Pelaku (Manpower)</th>
                  <th className="p-3.5">Jabatan / Divisi</th>
                  <th className="p-3.5 text-center">Inspeksi</th>
                  <th className="p-3.5 text-center">SOS</th>
                  <th className="p-3.5 text-center">Grooming</th>
                  <th className="p-3.5 text-center">Total Temuan</th>
                  <th className="p-3.5 text-center">Total Pengurang Poin</th>
                  <th className="p-3.5">Terakhir</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-xs">
                {pelakuRanking.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-10 text-center text-slate-500 font-bold uppercase">
                      Belum ada pelaku SPK3 tercatat bulan ini.
                    </td>
                  </tr>
                ) : (
                  pelakuRanking.map((p, idx) => (
                    <tr key={p.pelaku} className="hover:bg-white/5 transition-colors">
                      <td className="p-3.5 text-center font-black text-amber-400">{idx + 1}</td>
                      <td className="p-3.5 font-black text-white">{p.pelaku}</td>
                      <td className="p-3.5 text-slate-400 font-bold">{p.role} • {p.division}</td>
                      <td className="p-3.5 text-center font-bold text-amber-300">{p.inspeksi}</td>
                      <td className="p-3.5 text-center font-bold text-rose-300">{p.sos}</td>
                      <td className="p-3.5 text-center font-bold text-purple-300">{p.grooming}</td>
                      <td className="p-3.5 text-center font-black text-white">{p.totalTemuan}x</td>
                      <td className="p-3.5 text-center font-black text-rose-400">-{p.totalDeduction}</td>
                      <td className="p-3.5 text-slate-400">{p.lastDate}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <FeatureSubmitSyncButton featureName="SPK3 & Point Performance" />

      {/* Modal Input / Edit */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-[160] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsModalOpen(false)}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 16 }}
              className="relative z-10 w-full max-w-xl bg-slate-900 border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-5 border-b border-white/10 bg-slate-950/60 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-slate-950">
                    <i className="fas fa-shield-alt"></i>
                  </div>
                  <div className="text-left">
                    <h3 className="text-sm font-black uppercase text-white tracking-wider">
                      {editingItem ? 'Edit Temuan SPK3' : 'Input Temuan SPK3'}
                    </h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase">{currentOutlet}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer"
                >
                  <i className="fas fa-times text-xs"></i>
                </button>
              </div>

              <form onSubmit={handleSaveRecord} className="p-5 overflow-y-auto custom-scrollbar space-y-4 text-left">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">Tanggal</label>
                    <input
                      type="date"
                      value={formDate}
                      onChange={(e) => setFormDate(e.target.value)}
                      required
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                      Kategori Temuan <span className="text-rose-400">*</span>
                    </label>
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value as Spk3Category)}
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs font-bold text-white outline-none focus:border-amber-500"
                    >
                      {SPK3_CATEGORIES.map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                    Nama Pelaku (Auto dari Tabel Manpower) <span className="text-rose-400">*</span>
                  </label>
                  <select
                    value={formPelaku}
                    onChange={(e) => setFormPelaku(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs font-bold text-white outline-none focus:border-amber-500"
                  >
                    <option value="">-- Pilih Nama Pelaku dari Manpower --</option>
                    {manpowerOptions.map(st => (
                      <option key={st.id} value={st.name}>
                        {st.name} — {st.role} ({st.division})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">Area Temuan</label>
                    <select
                      value={formArea}
                      onChange={(e) => setFormArea(e.target.value)}
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs font-bold text-white outline-none focus:border-amber-500"
                    >
                      {AREA_OPTIONS.map(a => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">Pengurang Poin Harian</label>
                    <select
                      value={formDeduction}
                      onChange={(e) => setFormDeduction(Number(e.target.value))}
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs font-bold text-white outline-none focus:border-amber-500"
                    >
                      <option value={5}>-5 Poin (Ringan)</option>
                      <option value={10}>-10 Poin (Standar)</option>
                      <option value={15}>-15 Poin (Sedang)</option>
                      <option value={20}>-20 Poin (Berat)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                    Detail Temuan <span className="text-rose-400">*</span>
                  </label>
                  <textarea
                    rows={2}
                    value={formDetail}
                    onChange={(e) => setFormDetail(e.target.value)}
                    placeholder="Jelaskan temuan Inspeksi / SOS / Grooming secara spesifik..."
                    required
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-amber-500"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">Tindak Lanjut / Coaching</label>
                  <input
                    type="text"
                    value={formTindakLanjut}
                    onChange={(e) => setFormTindakLanjut(e.target.value)}
                    placeholder="Contoh: Teguran lisan, briefing ulang, perbaiki grooming..."
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-amber-500"
                  />
                </div>

                <div className="flex justify-end gap-2.5 pt-3 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold uppercase cursor-pointer"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 text-slate-950 text-xs font-black uppercase tracking-wider shadow-lg cursor-pointer"
                  >
                    {editingItem ? 'Simpan Perubahan' : 'Simpan Temuan SPK3'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirm */}
      <AnimatePresence>
        {deleteConfirmId && (
          <div className="fixed inset-0 z-[170] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-slate-900 border border-white/10 rounded-3xl p-6 max-w-sm w-full text-center space-y-5 shadow-2xl"
            >
              <div className="w-14 h-14 mx-auto rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400">
                <i className="fas fa-trash text-xl"></i>
              </div>
              <div>
                <h4 className="text-sm font-black uppercase text-white">Hapus Temuan SPK3?</h4>
                <p className="text-xs text-slate-400 mt-1">Point performance harian akan otomatis dihitung ulang.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setDeleteConfirmId(null)}
                  className="py-2.5 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold uppercase cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteRecord(deleteConfirmId)}
                  className="py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-black uppercase cursor-pointer"
                >
                  Ya, Hapus
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Spk3Module;
