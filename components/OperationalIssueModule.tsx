import React, { useState, useMemo } from 'react';
import { AppState, OperationalIssueCategory, OperationalIssueRecord, Staff } from '../types';
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

export const OPERATIONAL_ISSUE_CATEGORIES: OperationalIssueCategory[] = [
  'Issue Mistery Guest',
  'Guest Comment',
  'Google Review'
];

const AREA_PRESETS = [
  'Dining / Service Area',
  'Kitchen',
  'Bar',
  'Cashier',
  'Host / Reception',
  'VIP Room',
  'Toilet / Restroom',
  'Exterior / Parking',
  'Delivery / Takeaway',
  'All Area'
];

export const OperationalIssueModule: React.FC<Props> = ({
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

  // Filters
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<'ALL' | OperationalIssueCategory>('ALL');
  const [dateFilterMode, setDateFilterMode] = useState<'MONTH' | 'DATE'>('MONTH');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<OperationalIssueRecord | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Form State
  const [formDate, setFormDate] = useState(currentDate);
  const [formCategory, setFormCategory] = useState<OperationalIssueCategory>('Issue Mistery Guest');
  const [formKronologi, setFormKronologi] = useState('');
  const [formFindingProblem, setFormFindingProblem] = useState('');
  const [formArea, setFormArea] = useState(AREA_PRESETS[0]);
  const [formCustomArea, setFormCustomArea] = useState('');
  const [formTakenAction, setFormTakenAction] = useState('');
  const [formCorrective, setFormCorrective] = useState('');
  const [formPic, setFormPic] = useState('');
  const [formStatus, setFormStatus] = useState<'OPEN' | 'IN_PROGRESS' | 'RESOLVED'>('OPEN');

  // Extract all operational issues
  const allRecords = useMemo(() => {
    const list: OperationalIssueRecord[] = [];
    const seen = new Set<string>();
    if (data.dailyOperationalIssues && typeof data.dailyOperationalIssues === 'object') {
      Object.values(data.dailyOperationalIssues).forEach(dayList => {
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
    if (Array.isArray(data.operationalIssues)) {
      data.operationalIssues.forEach(item => {
        if (item && item.id && !seen.has(item.id)) {
          seen.add(item.id);
          list.push(item);
        }
      });
    }
    return list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [data.dailyOperationalIssues, data.operationalIssues]);

  const monthRecords = useMemo(() => {
    return allRecords.filter(r => r.date.startsWith(currentMonthKey));
  }, [allRecords, currentMonthKey]);

  const activeRecords = useMemo(() => {
    let res = dateFilterMode === 'DATE'
      ? allRecords.filter(r => r.date === currentDate)
      : monthRecords;

    if (selectedCategoryFilter !== 'ALL') {
      res = res.filter(r => r.category === selectedCategoryFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      res = res.filter(r =>
        (r.kronologi || '').toLowerCase().includes(q) ||
        (r.findingProblem || '').toLowerCase().includes(q) ||
        (r.area || '').toLowerCase().includes(q) ||
        (r.takenAction || '').toLowerCase().includes(q) ||
        (r.corrective || '').toLowerCase().includes(q) ||
        (r.pic || '').toLowerCase().includes(q) ||
        (r.category || '').toLowerCase().includes(q)
      );
    }

    return res;
  }, [allRecords, monthRecords, dateFilterMode, currentDate, selectedCategoryFilter, searchQuery]);

  // Manpower-linked PIC list
  const manpowerOptions = useMemo(() => {
    return extractOutletStaffOptions(
      data.manpowerData,
      staffList.length > 0 ? staffList : data.staffList,
      currentOutlet,
      currentMonthKey
    );
  }, [data.manpowerData, staffList, data.staffList, currentOutlet, currentMonthKey]);

  // Stats per category
  const stats = useMemo(() => {
    const mysteryGuestCount = monthRecords.filter(r => r.category === 'Issue Mistery Guest').length;
    const guestCommentCount = monthRecords.filter(r => r.category === 'Guest Comment').length;
    const googleReviewCount = monthRecords.filter(r => r.category === 'Google Review').length;
    const resolvedCount = monthRecords.filter(r => r.status === 'RESOLVED').length;

    const areaMap = new Map<string, number>();
    monthRecords.forEach(r => {
      const a = (r.area || 'Lainnya').trim();
      areaMap.set(a, (areaMap.get(a) || 0) + 1);
    });
    const topArea = Array.from(areaMap.entries()).sort((a, b) => b[1] - a[1])[0] || null;

    return {
      total: monthRecords.length,
      mysteryGuestCount,
      guestCommentCount,
      googleReviewCount,
      resolvedCount,
      topArea
    };
  }, [monthRecords]);

  const handleOpenAddModal = () => {
    setEditingItem(null);
    setFormDate(currentDate);
    setFormCategory(selectedCategoryFilter !== 'ALL' ? selectedCategoryFilter : 'Issue Mistery Guest');
    setFormKronologi('');
    setFormFindingProblem('');
    setFormArea(AREA_PRESETS[0]);
    setFormCustomArea('');
    setFormTakenAction('');
    setFormCorrective('');
    const defaultPic = manpowerOptions.find(s => s.isLeader)?.name || manpowerOptions[0]?.name || '';
    setFormPic(defaultPic);
    setFormStatus('OPEN');
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (item: OperationalIssueRecord) => {
    setEditingItem(item);
    setFormDate(item.date || currentDate);
    setFormCategory(item.category || 'Issue Mistery Guest');
    setFormKronologi(item.kronologi || '');
    setFormFindingProblem(item.findingProblem || '');
    if (AREA_PRESETS.includes(item.area)) {
      setFormArea(item.area);
      setFormCustomArea('');
    } else {
      setFormArea('LAINNYA');
      setFormCustomArea(item.area || '');
    }
    setFormTakenAction(item.takenAction || '');
    setFormCorrective(item.corrective || '');
    setFormPic(item.pic || '');
    setFormStatus(item.status || 'OPEN');
    setIsModalOpen(true);
  };

  const handleSaveRecord = (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedArea = formArea === 'LAINNYA' ? formCustomArea.trim() : formArea;

    if (!formKronologi.trim() || !formFindingProblem.trim() || !resolvedArea || !formPic.trim()) {
      showToast?.('Mohon lengkapi Kronologi, Finding Problem, Area, dan PIC (Manpower)!', 'error');
      return;
    }

    const matchedPic = manpowerOptions.find(s => s.name.toLowerCase() === formPic.trim().toLowerCase());

    const record: OperationalIssueRecord = {
      id: editingItem?.id || `opissue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      outlet: currentOutlet,
      date: formDate,
      category: formCategory,
      kronologi: formKronologi.trim(),
      findingProblem: formFindingProblem.trim(),
      area: resolvedArea,
      takenAction: formTakenAction.trim() || '-',
      corrective: formCorrective.trim() || '-',
      pic: formPic.trim(),
      picRole: matchedPic?.role || '',
      picDivision: matchedPic?.division || '',
      points: 1,
      status: formStatus,
      createdAt: editingItem?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (onUpdate) {
      onUpdate(prev => {
        const prevDaily = { ...(prev.dailyOperationalIssues || {}) };
        if (editingItem && editingItem.date !== formDate) {
          const oldDayList = Array.isArray(prevDaily[editingItem.date]) ? prevDaily[editingItem.date] : [];
          prevDaily[editingItem.date] = oldDayList.filter(x => x.id !== editingItem.id);
        }
        const dayList = Array.isArray(prevDaily[formDate]) ? [...prevDaily[formDate]] : [];
        const existingIdx = dayList.findIndex(x => x.id === record.id);
        if (existingIdx >= 0) {
          dayList[existingIdx] = record;
        } else {
          dayList.push(record);
        }
        prevDaily[formDate] = dayList;

        const prevFlat = Array.isArray(prev.operationalIssues) ? [...prev.operationalIssues] : [];
        const flatIdx = prevFlat.findIndex(x => x.id === record.id);
        if (flatIdx >= 0) {
          prevFlat[flatIdx] = record;
        } else {
          prevFlat.push(record);
        }

        return {
          ...prev,
          dailyOperationalIssues: prevDaily,
          operationalIssues: prevFlat
        };
      });
    }

    try {
      window.dispatchEvent(new CustomEvent('appOperationalIssuesUpdated', { detail: { record, outlet: currentOutlet } }));
    } catch {}

    setIsModalOpen(false);
    showToast?.(editingItem ? 'Data Operational Issue berhasil diperbarui!' : 'Operational Issue baru berhasil disimpan!', 'success');
  };

  const handleDeleteRecord = (id: string) => {
    const target = allRecords.find(r => r.id === id);
    if (!target) return;

    if (onUpdate) {
      onUpdate(prev => {
        const prevDaily = { ...(prev.dailyOperationalIssues || {}) };
        if (Array.isArray(prevDaily[target.date])) {
          prevDaily[target.date] = prevDaily[target.date].filter(x => x.id !== id);
        }
        const prevFlat = Array.isArray(prev.operationalIssues)
          ? prev.operationalIssues.filter(x => x.id !== id)
          : [];
        return {
          ...prev,
          dailyOperationalIssues: prevDaily,
          operationalIssues: prevFlat
        };
      });
    }

    try {
      window.dispatchEvent(new CustomEvent('appOperationalIssuesUpdated', { detail: { deletedId: id, outlet: currentOutlet } }));
    } catch {}

    setDeleteConfirmId(null);
    showToast?.('Operational Issue berhasil dihapus.', 'info');
  };

  const handleExportExcel = async () => {
    try {
      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Operational Issue');

      ws.addRow([`LAPORAN OPERATIONAL ISSUE - ${currentOutlet} (${currentMonthKey})`]);
      ws.addRow(['No', 'Tanggal', 'Kategori', 'Area', 'Kronologi', 'Finding Problem', 'Taken Action', 'Corrective', 'PIC (Manpower)', 'Jabatan', 'Status']);

      activeRecords.forEach((rec, idx) => {
        ws.addRow([
          idx + 1,
          rec.date,
          rec.category,
          rec.area,
          rec.kronologi,
          rec.findingProblem,
          rec.takenAction,
          rec.corrective,
          rec.pic,
          rec.picRole || '-',
          rec.status || 'OPEN'
        ]);
      });

      ws.getRow(1).font = { bold: true, size: 13 };
      ws.getRow(2).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };

      const buffer = await workbook.xlsx.writeBuffer();
      saveAs(new Blob([buffer]), `Operational_Issue_${currentOutlet}_${currentMonthKey}.xlsx`);
      showToast?.('Laporan Excel Operational Issue berhasil diunduh!', 'success');
    } catch (err) {
      console.error(err);
      showToast?.('Gagal mengekspor Excel Operational Issue.', 'error');
    }
  };

  const handleCopyWa = () => {
    const lines = [
      `*LAPORAN OPERATIONAL ISSUE - ${currentOutlet}*`,
      `Periode: ${currentMonthKey}`,
      `Total Issue: ${stats.total} Temuan`,
      `- Issue Mistery Guest: ${stats.mysteryGuestCount}`,
      `- Guest Comment: ${stats.guestCommentCount}`,
      `- Google Review: ${stats.googleReviewCount}`,
      ``,
      `*Rincian Issue:*`
    ];
    activeRecords.slice(0, 15).forEach((rec, i) => {
      lines.push(
        `${i + 1}. [${rec.date}] *${rec.category}* (${rec.area})`,
        `   Problem: ${rec.findingProblem}`,
        `   Kronologi: ${rec.kronologi}`,
        `   Action: ${rec.takenAction} | Corrective: ${rec.corrective}`,
        `   PIC: ${rec.pic} (${rec.status || 'OPEN'})`
      );
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      showToast?.('Ringkasan Operational Issue disalin ke WhatsApp!', 'success');
    });
  };

  const getCategoryBadgeStyle = (category: OperationalIssueCategory) => {
    switch (category) {
      case 'Issue Mistery Guest':
        return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
      case 'Guest Comment':
        return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
      case 'Google Review':
        return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
      default:
        return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
    }
  };

  return (
    <div className="space-y-6 animate-fade-in pb-16">
      {/* Header Card */}
      <div className="glass-card p-6 md:p-8 border border-white/10 shadow-2xl bg-gradient-to-br from-slate-900 via-slate-900 to-rose-950/30">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-4 text-left">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-600 flex items-center justify-center text-white shadow-xl shadow-rose-900/40 shrink-0">
              <i className="fas fa-exclamation-triangle text-2xl"></i>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl md:text-2xl font-black text-white uppercase tracking-tight">
                  Operational Issue
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  {currentOutlet}
                </span>
              </div>
              <p className="text-xs text-slate-400 font-medium mt-1">
                Pencatatan Issue Mistery Guest, Guest Comment & Google Review lengkap dengan Kronologi, Finding Problem, Area, Taken Action, Corrective & PIC Manpower.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleOpenAddModal}
              className="px-5 py-3 rounded-2xl bg-gradient-to-r from-rose-600 to-orange-600 hover:from-rose-500 hover:to-orange-500 text-white font-black text-xs uppercase tracking-wider shadow-xl shadow-rose-900/40 flex items-center gap-2 transition-all active:scale-95 cursor-pointer"
            >
              <i className="fas fa-plus-circle"></i>
              <span>Input Operational Issue</span>
            </button>
            <button
              type="button"
              onClick={handleCopyWa}
              className="px-4 py-3 rounded-2xl bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-black text-xs uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer"
            >
              <i className="fab fa-whatsapp"></i>
              <span>Copy WA</span>
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

        {/* Category KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-6">
          <div className="p-4 rounded-2xl bg-slate-950/60 border border-white/10 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Total Issue Bulan Ini</div>
            <div className="text-2xl font-black text-white mt-1">{stats.total}</div>
            <div className="text-[10px] font-bold text-emerald-400 mt-1">{stats.resolvedCount} Resolved</div>
          </div>
          <div className="p-4 rounded-2xl bg-purple-950/30 border border-purple-500/30 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-purple-300">Issue Mistery Guest</div>
            <div className="text-2xl font-black text-white mt-1">{stats.mysteryGuestCount}</div>
            <div className="text-[10px] font-bold text-purple-300/80 mt-1">Poin Temuan</div>
          </div>
          <div className="p-4 rounded-2xl bg-amber-950/30 border border-amber-500/30 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-amber-300">Guest Comment</div>
            <div className="text-2xl font-black text-white mt-1">{stats.guestCommentCount}</div>
            <div className="text-[10px] font-bold text-amber-300/80 mt-1">Poin Temuan</div>
          </div>
          <div className="p-4 rounded-2xl bg-cyan-950/30 border border-cyan-500/30 text-left">
            <div className="text-[9px] font-black uppercase tracking-widest text-cyan-300">Google Review</div>
            <div className="text-2xl font-black text-white mt-1">{stats.googleReviewCount}</div>
            <div className="text-[10px] font-bold text-cyan-300/80 mt-1">Poin Temuan</div>
          </div>
          <div className="p-4 rounded-2xl bg-slate-950/60 border border-white/10 text-left col-span-2 lg:col-span-1">
            <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Area Terbanyak</div>
            <div className="text-sm font-black text-rose-300 truncate mt-1.5">
              {stats.topArea ? stats.topArea[0] : '-'}
            </div>
            <div className="text-[10px] font-bold text-slate-400 mt-1">
              {stats.topArea ? `${stats.topArea[1]} temuan` : 'Belum ada data'}
            </div>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="glass-card p-4 border border-white/10 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Category Dropdown */}
          <div className="flex items-center gap-2 bg-slate-950/70 px-3 py-2 rounded-xl border border-white/10">
            <i className="fas fa-tags text-rose-400 text-xs"></i>
            <span className="text-[10px] font-black uppercase text-slate-400">Kategori:</span>
            <select
              value={selectedCategoryFilter}
              onChange={(e) => setSelectedCategoryFilter(e.target.value as any)}
              className="bg-transparent text-xs font-bold text-white outline-none cursor-pointer"
            >
              <option value="ALL" className="bg-slate-900">Semua Kategori</option>
              {OPERATIONAL_ISSUE_CATEGORIES.map(cat => (
                <option key={cat} value={cat} className="bg-slate-900">{cat}</option>
              ))}
            </select>
          </div>

          {/* Date Mode */}
          <div className="flex bg-slate-950/70 p-1 rounded-xl border border-white/10">
            <button
              type="button"
              onClick={() => setDateFilterMode('MONTH')}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all cursor-pointer ${
                dateFilterMode === 'MONTH' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Bulan ({currentMonthKey})
            </button>
            <button
              type="button"
              onClick={() => setDateFilterMode('DATE')}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all cursor-pointer ${
                dateFilterMode === 'DATE' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Tanggal ({currentDate})
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari kronologi, finding problem, area, corrective, PIC..."
            className="w-full bg-slate-950/70 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-rose-500"
          />
        </div>
      </div>

      {/* Main Table */}
      <div className="glass-card border border-white/10 overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-white/10 bg-slate-950/50 flex items-center justify-between">
          <h3 className="text-xs font-black uppercase tracking-widest text-white flex items-center gap-2">
            <i className="fas fa-table text-rose-400"></i>
            Tabel Data Operational Issue ({activeRecords.length})
          </h3>
          <span className="text-[10px] font-bold text-slate-400">
            PIC terhubung ke Tabel Manpower ({manpowerOptions.length} personil)
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[1150px]">
            <thead>
              <tr className="bg-slate-950/80 border-b border-white/10 text-[10px] font-black uppercase tracking-wider text-slate-400">
                <th className="p-3.5 w-12 text-center">No</th>
                <th className="p-3.5 w-28">Tanggal</th>
                <th className="p-3.5 w-40">Kategori</th>
                <th className="p-3.5 w-36">Area</th>
                <th className="p-3.5 min-w-[180px]">Kronologi</th>
                <th className="p-3.5 min-w-[180px]">Finding Problem</th>
                <th className="p-3.5 min-w-[170px]">Taken Action</th>
                <th className="p-3.5 min-w-[170px]">Corrective</th>
                <th className="p-3.5 w-44">PIC (Manpower)</th>
                <th className="p-3.5 w-28 text-center">Status</th>
                <th className="p-3.5 w-24 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs">
              {activeRecords.length === 0 ? (
                <tr>
                  <td colSpan={11} className="p-12 text-center text-slate-500">
                    <i className="fas fa-clipboard-check text-3xl mb-2 block opacity-40"></i>
                    <p className="font-black uppercase text-xs">Belum ada Operational Issue tercatat pada periode ini</p>
                    <p className="text-[11px] mt-1">Klik tombol &ldquo;Input Operational Issue&rdquo; untuk menambahkan temuan baru.</p>
                  </td>
                </tr>
              ) : (
                activeRecords.map((item, idx) => (
                  <tr key={item.id} className="hover:bg-white/5 transition-colors align-top">
                    <td className="p-3.5 text-center font-bold text-slate-500">{idx + 1}</td>
                    <td className="p-3.5 font-bold text-slate-200 whitespace-nowrap">{item.date}</td>
                    <td className="p-3.5">
                      <span className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-black border whitespace-nowrap ${getCategoryBadgeStyle(item.category)}`}>
                        {item.category}
                      </span>
                    </td>
                    <td className="p-3.5 font-bold text-amber-300">{item.area}</td>
                    <td className="p-3.5 text-slate-200 leading-relaxed whitespace-pre-wrap">{item.kronologi}</td>
                    <td className="p-3.5 text-rose-200 font-semibold leading-relaxed whitespace-pre-wrap">{item.findingProblem}</td>
                    <td className="p-3.5 text-emerald-200 leading-relaxed whitespace-pre-wrap">{item.takenAction}</td>
                    <td className="p-3.5 text-indigo-200 leading-relaxed whitespace-pre-wrap">{item.corrective}</td>
                    <td className="p-3.5">
                      <div className="font-black text-white">{item.pic}</div>
                      {item.picRole && (
                        <div className="text-[10px] font-bold text-slate-400">
                          {item.picRole}{item.picDivision ? ` • ${item.picDivision}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="p-3.5 text-center">
                      <span className={`inline-block px-2 py-1 rounded-lg text-[9px] font-black uppercase border ${
                        item.status === 'RESOLVED'
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                          : item.status === 'IN_PROGRESS'
                          ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                          : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                      }`}>
                        {item.status || 'OPEN'}
                      </span>
                    </td>
                    <td className="p-3.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleOpenEditModal(item)}
                          className="w-8 h-8 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-300 flex items-center justify-center cursor-pointer"
                          title="Edit"
                        >
                          <i className="fas fa-edit text-xs"></i>
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmId(item.id)}
                          className="w-8 h-8 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 flex items-center justify-center cursor-pointer"
                          title="Hapus"
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

      <FeatureSubmitSyncButton featureName="Operational Issue" />

      {/* Input / Edit Modal */}
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
              className="relative z-10 w-full max-w-2xl bg-slate-900 border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-5 border-b border-white/10 bg-slate-950/60 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-600 flex items-center justify-center text-white">
                    <i className="fas fa-exclamation-triangle"></i>
                  </div>
                  <div className="text-left">
                    <h3 className="text-sm font-black uppercase text-white tracking-wider">
                      {editingItem ? 'Edit Operational Issue' : 'Input Operational Issue'}
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
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">Tanggal</label>
                    <input
                      type="date"
                      value={formDate}
                      onChange={(e) => setFormDate(e.target.value)}
                      required
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-rose-500"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                      Kategori Issue <span className="text-rose-400">*</span>
                    </label>
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value as OperationalIssueCategory)}
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs font-bold text-white outline-none focus:border-rose-500"
                    >
                      {OPERATIONAL_ISSUE_CATEGORIES.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                      Area <span className="text-rose-400">*</span>
                    </label>
                    <select
                      value={formArea}
                      onChange={(e) => setFormArea(e.target.value)}
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs font-bold text-white outline-none focus:border-rose-500"
                    >
                      {AREA_PRESETS.map(a => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                      <option value="LAINNYA">Lainnya (Tulis Manual)</option>
                    </select>
                    {formArea === 'LAINNYA' && (
                      <input
                        type="text"
                        value={formCustomArea}
                        onChange={(e) => setFormCustomArea(e.target.value)}
                        placeholder="Ketik nama area..."
                        className="mt-2 w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-rose-500"
                      />
                    )}
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                      PIC (Tabel Manpower) <span className="text-rose-400">*</span>
                    </label>
                    <select
                      value={formPic}
                      onChange={(e) => setFormPic(e.target.value)}
                      required
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs font-bold text-white outline-none focus:border-rose-500"
                    >
                      <option value="">-- Pilih PIC dari Manpower --</option>
                      {manpowerOptions.map(st => (
                        <option key={st.id} value={st.name}>
                          {st.name} — {st.role} ({st.division})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                    Kronologi <span className="text-rose-400">*</span>
                  </label>
                  <textarea
                    rows={2}
                    value={formKronologi}
                    onChange={(e) => setFormKronologi(e.target.value)}
                    placeholder="Jelaskan urutan kejadian / kronologi issue..."
                    required
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-rose-500"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                    Finding Problem <span className="text-rose-400">*</span>
                  </label>
                  <textarea
                    rows={2}
                    value={formFindingProblem}
                    onChange={(e) => setFormFindingProblem(e.target.value)}
                    placeholder="Tuliskan inti temuan / akar masalah (finding problem)..."
                    required
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-rose-500"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                      Taken Action
                    </label>
                    <textarea
                      rows={2}
                      value={formTakenAction}
                      onChange={(e) => setFormTakenAction(e.target.value)}
                      placeholder="Tindakan langsung yang sudah dilakukan..."
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-rose-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">
                      Corrective
                    </label>
                    <textarea
                      rows={2}
                      value={formCorrective}
                      onChange={(e) => setFormCorrective(e.target.value)}
                      placeholder="Langkah perbaikan / pencegahan agar tidak terulang..."
                      className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-rose-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-400 mb-1.5">Status Penanganan</label>
                  <div className="flex gap-2">
                    {(['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const).map(st => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setFormStatus(st)}
                        className={`px-3.5 py-2 rounded-xl text-[10px] font-black uppercase border transition-all cursor-pointer ${
                          formStatus === st
                            ? st === 'RESOLVED'
                              ? 'bg-emerald-600 text-white border-emerald-400'
                              : st === 'IN_PROGRESS'
                              ? 'bg-amber-600 text-white border-amber-400'
                              : 'bg-rose-600 text-white border-rose-400'
                            : 'bg-slate-950 text-slate-400 border-white/10 hover:text-white'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end gap-2.5 pt-3 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold uppercase cursor-pointer"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-rose-600 to-orange-600 hover:from-rose-500 hover:to-orange-500 text-white text-xs font-black uppercase tracking-wider shadow-lg cursor-pointer"
                  >
                    {editingItem ? 'Simpan Perubahan' : 'Simpan Operational Issue'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation */}
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
                <h4 className="text-sm font-black uppercase text-white">Hapus Operational Issue?</h4>
                <p className="text-xs text-slate-400 mt-1">Data temuan ini akan dihapus permanen dari laporan.</p>
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

export default OperationalIssueModule;
