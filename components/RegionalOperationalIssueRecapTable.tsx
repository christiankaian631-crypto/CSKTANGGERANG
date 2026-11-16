import React, { useState, useMemo, useEffect } from 'react';
import { OperationalIssueCategory, OperationalIssueRecord } from '../types';
import { getActiveOutletNames, getAreaForOutlet } from '../constants';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

interface Props {
  data?: Record<string, any>;
  allOutletsData?: Record<string, any>;
  selectedMonth: number; // 0-11
  selectedYear: number;
  selectedArea?: string;
  selectedOutlet?: string;
  onSelectOutlet?: (outlet: string) => void;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

const CATEGORIES: OperationalIssueCategory[] = [
  'Issue Mistery Guest',
  'Guest Comment',
  'Google Review'
];

const CATEGORY_META: Record<OperationalIssueCategory, {
  shortLabel: string;
  badgeClass: string;
  barClass: string;
  cardBorder: string;
  icon: string;
}> = {
  'Issue Mistery Guest': {
    shortLabel: 'Mistery Guest',
    badgeClass: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
    barClass: 'bg-purple-500',
    cardBorder: 'border-purple-500/30 bg-purple-500/5',
    icon: 'fa-user-secret'
  },
  'Guest Comment': {
    shortLabel: 'Guest Comment',
    badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    barClass: 'bg-amber-500',
    cardBorder: 'border-amber-500/30 bg-amber-500/5',
    icon: 'fa-comments'
  },
  'Google Review': {
    shortLabel: 'Google Review',
    badgeClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    barClass: 'bg-sky-500',
    cardBorder: 'border-sky-500/30 bg-sky-500/5',
    icon: 'fa-star'
  }
};

export const RegionalOperationalIssueRecapTable: React.FC<Props> = ({
  data,
  allOutletsData,
  selectedMonth,
  selectedYear,
  selectedArea = 'ALL',
  selectedOutlet = 'ALL',
  onSelectOutlet,
  showToast
}) => {
  const [filterOutlet, setFilterOutlet] = useState<string>(selectedOutlet || 'ALL');
  const [filterCategory, setFilterCategory] = useState<'ALL' | OperationalIssueCategory>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'SUMMARY_KATEGORI' | 'MATRIKS_TANGGAL' | 'DETAIL_LOG'>('SUMMARY_KATEGORI');
  const [detailModal, setDetailModal] = useState<{ outlet: string; dateStr: string; items: OperationalIssueRecord[] } | null>(null);
  const [updateVersion, setUpdateVersion] = useState<number>(0);

  useEffect(() => {
    const handleUpdate = () => setUpdateVersion(v => v + 1);
    window.addEventListener('appOperationalIssuesUpdated', handleUpdate);
    return () => window.removeEventListener('appOperationalIssuesUpdated', handleUpdate);
  }, []);

  useEffect(() => {
    setFilterOutlet(selectedOutlet || 'ALL');
  }, [selectedOutlet]);

  const monthKey = `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}`;
  const monthName = MONTH_NAMES[selectedMonth] || 'Bulan';
  const daysInMonth = useMemo(() => {
    const d = new Date(selectedYear, selectedMonth + 1, 0).getDate();
    return (isNaN(d) || d < 28) ? 30 : d;
  }, [selectedYear, selectedMonth]);

  const activeOutletList = useMemo(() => {
    const base = getActiveOutletNames();
    if (selectedArea && selectedArea !== 'ALL') {
      return base.filter(o => getAreaForOutlet(o).toUpperCase() === selectedArea.toUpperCase());
    }
    return base;
  }, [selectedArea]);

  const sourceData = useMemo(() => allOutletsData || data || {}, [allOutletsData, data, updateVersion]);

  // Extract all period records across outlets
  const allPeriodIssues = useMemo(() => {
    const records: OperationalIssueRecord[] = [];
    const seenIds = new Set<string>();

    activeOutletList.forEach(outletName => {
      const matchedKey = Object.keys(sourceData).find(
        k => k.trim().toUpperCase() === outletName.trim().toUpperCase()
      ) || outletName;
      const outletRaw = sourceData?.[matchedKey] || {};
      const candidateStates: any[] = [];

      if (outletRaw[String(selectedMonth)]) candidateStates.push(outletRaw[String(selectedMonth)]);
      if (outletRaw[selectedMonth]) candidateStates.push(outletRaw[selectedMonth]);
      if (outletRaw[monthKey]) candidateStates.push(outletRaw[monthKey]);
      if (outletRaw.monthlyData && typeof outletRaw.monthlyData === 'object') {
        if (outletRaw.monthlyData[String(selectedMonth)]) candidateStates.push(outletRaw.monthlyData[String(selectedMonth)]);
        if (outletRaw.monthlyData[selectedMonth]) candidateStates.push(outletRaw.monthlyData[selectedMonth]);
        if (outletRaw.monthlyData[monthKey]) candidateStates.push(outletRaw.monthlyData[monthKey]);
        Object.values(outletRaw.monthlyData).forEach((mVal: any) => {
          if (mVal && !candidateStates.includes(mVal)) candidateStates.push(mVal);
        });
      }
      candidateStates.push(outletRaw);

      candidateStates.forEach(st => {
        if (!st) return;

        if (st.dailyOperationalIssues && typeof st.dailyOperationalIssues === 'object') {
          Object.entries(st.dailyOperationalIssues).forEach(([dKey, dayList]) => {
            if (Array.isArray(dayList)) {
              dayList.forEach((rec: any) => {
                if (rec && rec.id) {
                  const recDate = String(rec.date || dKey || '');
                  if (recDate.startsWith(monthKey) && !seenIds.has(rec.id)) {
                    seenIds.add(rec.id);
                    records.push({
                      ...rec,
                      date: recDate,
                      outlet: rec.outlet || outletName,
                      points: Number(rec.points) || 1
                    });
                  }
                }
              });
            }
          });
        }

        if (Array.isArray(st.operationalIssues)) {
          st.operationalIssues.forEach((rec: any) => {
            if (rec && rec.id) {
              const recDate = String(rec.date || '');
              if (recDate.startsWith(monthKey) && !seenIds.has(rec.id)) {
                seenIds.add(rec.id);
                records.push({
                  ...rec,
                  date: recDate,
                  outlet: rec.outlet || outletName,
                  points: Number(rec.points) || 1
                });
              }
            }
          });
        }
      });
    });

    return records.sort((a, b) => b.date.localeCompare(a.date));
  }, [sourceData, activeOutletList, monthKey, selectedMonth]);

  const filteredIssues = useMemo(() => {
    let res = allPeriodIssues;
    if (filterOutlet && filterOutlet !== 'ALL') {
      res = res.filter(r => (r.outlet || '').toLowerCase() === filterOutlet.toLowerCase());
    }
    if (filterCategory !== 'ALL') {
      res = res.filter(r => r.category === filterCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      res = res.filter(r =>
        (r.outlet || '').toLowerCase().includes(q) ||
        (r.category || '').toLowerCase().includes(q) ||
        (r.area || '').toLowerCase().includes(q) ||
        (r.kronologi || '').toLowerCase().includes(q) ||
        (r.findingProblem || '').toLowerCase().includes(q) ||
        (r.takenAction || '').toLowerCase().includes(q) ||
        (r.corrective || '').toLowerCase().includes(q) ||
        (r.pic || '').toLowerCase().includes(q)
      );
    }
    return res;
  }, [allPeriodIssues, filterOutlet, filterCategory, searchQuery]);

  // Summary by Category
  const categorySummary = useMemo(() => {
    const totalPointsAll = filteredIssues.reduce((sum, r) => sum + (Number(r.points) || 1), 0);
    return CATEGORIES.map(cat => {
      const catItems = filteredIssues.filter(r => r.category === cat);
      const totalPoints = catItems.reduce((sum, r) => sum + (Number(r.points) || 1), 0);
      const outletsSet = new Set(catItems.map(r => r.outlet));
      const areaFreq = new Map<string, number>();
      catItems.forEach(r => {
        const ar = (r.area || 'Lainnya').trim();
        areaFreq.set(ar, (areaFreq.get(ar) || 0) + 1);
      });
      const topAreaEntry = Array.from(areaFreq.entries()).sort((a, b) => b[1] - a[1])[0];
      const openCount = catItems.filter(r => (r.status || 'OPEN') === 'OPEN').length;
      const inProgressCount = catItems.filter(r => r.status === 'IN_PROGRESS').length;
      const resolvedCount = catItems.filter(r => r.status === 'RESOLVED').length;

      return {
        category: cat,
        count: catItems.length,
        points: totalPoints,
        sharePercent: totalPointsAll > 0 ? (totalPoints / totalPointsAll) * 100 : 0,
        affectedOutlets: outletsSet.size,
        topArea: topAreaEntry ? `${topAreaEntry[0]} (${topAreaEntry[1]}x)` : '-',
        openCount,
        inProgressCount,
        resolvedCount
      };
    });
  }, [filteredIssues]);

  // Summary per Outlet x Category
  const outletBreakdown = useMemo(() => {
    const targetList = filterOutlet && filterOutlet !== 'ALL'
      ? activeOutletList.filter(o => o.toLowerCase() === filterOutlet.toLowerCase())
      : activeOutletList;

    return targetList.map((outletName, idx) => {
      const items = filteredIssues.filter(r => (r.outlet || '').toUpperCase() === outletName.toUpperCase());
      const mistery = items.filter(r => r.category === 'Issue Mistery Guest').reduce((s, r) => s + (Number(r.points) || 1), 0);
      const comment = items.filter(r => r.category === 'Guest Comment').reduce((s, r) => s + (Number(r.points) || 1), 0);
      const google = items.filter(r => r.category === 'Google Review').reduce((s, r) => s + (Number(r.points) || 1), 0);
      const totalPoints = mistery + comment + google;
      const openCount = items.filter(r => (r.status || 'OPEN') !== 'RESOLVED').length;
      const resolvedCount = items.filter(r => r.status === 'RESOLVED').length;
      const pics = Array.from(new Set(items.map(r => r.pic).filter(Boolean)));
      const areaMap = new Map<string, number>();
      items.forEach(r => {
        if (r.area) areaMap.set(r.area, (areaMap.get(r.area) || 0) + 1);
      });
      const topArea = Array.from(areaMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '-';

      return {
        no: idx + 1,
        outlet: outletName,
        regionalArea: getAreaForOutlet(outletName),
        mistery,
        comment,
        google,
        totalPoints,
        openCount,
        resolvedCount,
        topArea,
        picsStr: pics.slice(0, 3).join(', ') + (pics.length > 3 ? ` +${pics.length - 3}` : '')
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints || a.outlet.localeCompare(b.outlet));
  }, [activeOutletList, filterOutlet, filteredIssues]);

  // Matrix by date (1..daysInMonth) x outlet
  const dateMatrix = useMemo(() => {
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    const targetOutlets = filterOutlet && filterOutlet !== 'ALL'
      ? activeOutletList.filter(o => o.toLowerCase() === filterOutlet.toLowerCase())
      : activeOutletList;

    const rows = targetOutlets.map(outletName => {
      const outletItems = filteredIssues.filter(r => (r.outlet || '').toUpperCase() === outletName.toUpperCase());
      const byDay: Record<number, {
        total: number;
        mistery: number;
        comment: number;
        google: number;
        items: OperationalIssueRecord[];
      }> = {};

      days.forEach(d => {
        const dStr = `${monthKey}-${String(d).padStart(2, '0')}`;
        const dayItems = outletItems.filter(r => r.date === dStr);
        byDay[d] = {
          total: dayItems.reduce((s, r) => s + (Number(r.points) || 1), 0),
          mistery: dayItems.filter(r => r.category === 'Issue Mistery Guest').reduce((s, r) => s + (Number(r.points) || 1), 0),
          comment: dayItems.filter(r => r.category === 'Guest Comment').reduce((s, r) => s + (Number(r.points) || 1), 0),
          google: dayItems.filter(r => r.category === 'Google Review').reduce((s, r) => s + (Number(r.points) || 1), 0),
          items: dayItems
        };
      });

      const outletTotal = outletItems.reduce((s, r) => s + (Number(r.points) || 1), 0);
      return { outlet: outletName, regionalArea: getAreaForOutlet(outletName), byDay, outletTotal };
    });

    const dailyTotals: Record<number, number> = {};
    days.forEach(d => {
      dailyTotals[d] = rows.reduce((sum, r) => sum + (r.byDay[d]?.total || 0), 0);
    });

    return { days, rows, dailyTotals };
  }, [daysInMonth, activeOutletList, filterOutlet, filteredIssues, monthKey]);

  const handleCopyWa = () => {
    const totalAll = filteredIssues.reduce((s, r) => s + (Number(r.points) || 1), 0);
    const lines = [
      `*REKAPAN REGIONAL OPERATIONAL ISSUE*`,
      `Periode: ${monthName} ${selectedYear}`,
      `Total Point Temuan: ${totalAll} Point`,
      ``,
      `*Summary Per Kategori:*`,
      ...categorySummary.map(c => `- ${c.category}: ${c.points} Point (${c.sharePercent.toFixed(1)}%) | Open: ${c.openCount} | Resolved: ${c.resolvedCount}`),
      ``,
      `*Rekap Per Outlet (Top Issues):*`,
      ...outletBreakdown
        .filter(o => o.totalPoints > 0)
        .map((o, idx) => `${idx + 1}. ${o.outlet}: ${o.totalPoints} pt (MG: ${o.mistery}, GC: ${o.comment}, GR: ${o.google})`)
    ];
    if (outletBreakdown.every(o => o.totalPoints === 0)) {
      lines.push(`- Zero Issue tercatat di periode ini.`);
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      showToast?.('Rekapan Operational Issue berhasil disalin ke WhatsApp!', 'success');
    }).catch(() => {
      showToast?.('Gagal menyalin teks.', 'error');
    });
  };

  const handleExportExcel = async () => {
    try {
      const wb = new ExcelJS.Workbook();

      // Sheet 1: Summary Kategori
      const wsCat = wb.addWorksheet('Summary Kategori');
      wsCat.columns = [
        { header: 'Kategori Issue', key: 'category', width: 26 },
        { header: 'Total Point Temuan', key: 'points', width: 20 },
        { header: 'Share (%)', key: 'share', width: 14 },
        { header: 'Outlet Terdampak', key: 'outlets', width: 18 },
        { header: 'Area Dominan', key: 'topArea', width: 24 },
        { header: 'Open', key: 'open', width: 12 },
        { header: 'In Progress', key: 'prog', width: 14 },
        { header: 'Resolved', key: 'res', width: 12 }
      ];
      categorySummary.forEach(c => {
        wsCat.addRow({
          category: c.category,
          points: c.points,
          share: `${c.sharePercent.toFixed(1)}%`,
          outlets: c.affectedOutlets,
          topArea: c.topArea,
          open: c.openCount,
          prog: c.inProgressCount,
          res: c.resolvedCount
        });
      });

      // Sheet 2: Rekap Per Outlet
      const wsOutlet = wb.addWorksheet('Rekap Per Outlet');
      wsOutlet.columns = [
        { header: 'No', key: 'no', width: 6 },
        { header: 'Outlet', key: 'outlet', width: 22 },
        { header: 'Regional Area', key: 'reg', width: 18 },
        { header: 'Issue Mistery Guest', key: 'mg', width: 20 },
        { header: 'Guest Comment', key: 'gc', width: 18 },
        { header: 'Google Review', key: 'gr', width: 18 },
        { header: 'Total Point', key: 'tot', width: 14 },
        { header: 'Belum Resolved', key: 'open', width: 16 },
        { header: 'Resolved', key: 'res', width: 12 },
        { header: 'PIC Manpower', key: 'pic', width: 30 }
      ];
      outletBreakdown.forEach((o, i) => {
        wsOutlet.addRow({
          no: i + 1,
          outlet: o.outlet,
          reg: o.regionalArea,
          mg: o.mistery,
          gc: o.comment,
          gr: o.google,
          tot: o.totalPoints,
          open: o.openCount,
          res: o.resolvedCount,
          pic: o.picsStr
        });
      });

      // Sheet 3: Matriks Tanggal
      const wsMat = wb.addWorksheet('Matriks Tanggal');
      wsMat.columns = [
        { header: 'Outlet', key: 'outlet', width: 22 },
        ...dateMatrix.days.map(d => ({ header: `Tgl ${d}`, key: `d${d}`, width: 9 })),
        { header: 'Total', key: 'tot', width: 12 }
      ];
      dateMatrix.rows.forEach(row => {
        const rowObj: any = { outlet: row.outlet, tot: row.outletTotal };
        dateMatrix.days.forEach(d => {
          rowObj[`d${d}`] = row.byDay[d]?.total || 0;
        });
        wsMat.addRow(rowObj);
      });

      // Sheet 4: Log Detail
      const wsLog = wb.addWorksheet('Log Detail Issue');
      wsLog.columns = [
        { header: 'Tanggal', key: 'date', width: 14 },
        { header: 'Outlet', key: 'outlet', width: 20 },
        { header: 'Kategori', key: 'category', width: 22 },
        { header: 'Area', key: 'area', width: 20 },
        { header: 'Kronologi', key: 'kronologi', width: 34 },
        { header: 'Finding Problem', key: 'finding', width: 34 },
        { header: 'Taken Action', key: 'action', width: 30 },
        { header: 'Corrective', key: 'corrective', width: 30 },
        { header: 'PIC', key: 'pic', width: 20 },
        { header: 'Status', key: 'status', width: 14 }
      ];
      filteredIssues.forEach(r => {
        wsLog.addRow({
          date: r.date,
          outlet: r.outlet,
          category: r.category,
          area: r.area,
          kronologi: r.kronologi,
          finding: r.findingProblem,
          action: r.takenAction,
          corrective: r.corrective,
          pic: r.pic,
          status: r.status || 'OPEN'
        });
      });

      [wsCat, wsOutlet, wsMat, wsLog].forEach(ws => {
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      });

      const buf = await wb.xlsx.writeBuffer();
      saveAs(new Blob([buf]), `Rekapan_Operational_Issue_${monthName}_${selectedYear}.xlsx`);
      showToast?.('Excel Operational Issue berhasil diunduh!', 'success');
    } catch (err) {
      console.error(err);
      showToast?.('Gagal mengekspor Excel Operational Issue.', 'error');
    }
  };

  const totalAllPoints = filteredIssues.reduce((s, r) => s + (Number(r.points) || 1), 0);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header Banner */}
      <div className="glass-card p-6 rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900/95 via-rose-950/15 to-slate-900/95">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-500 to-amber-600 flex items-center justify-center text-white shadow-lg">
              <i className="fas fa-clipboard-list text-xl"></i>
            </div>
            <div>
              <h3 className="text-lg md:text-xl font-black uppercase tracking-tight text-white">
                Summary Rekapan Operational Issue Regional
              </h3>
              <p className="text-xs text-slate-400">
                Periode <span className="text-amber-300 font-bold">{monthName} {selectedYear}</span> • Rekapitulasi Per Kategori (Issue Mistery Guest, Guest Comment, Google Review)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyWa}
              className="px-4 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-xs font-black uppercase tracking-wider flex items-center gap-2 cursor-pointer"
            >
              <i className="fab fa-whatsapp"></i>
              Copy WA
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="px-4 py-2 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 text-xs font-black uppercase tracking-wider flex items-center gap-2 cursor-pointer"
            >
              <i className="fas fa-file-excel"></i>
              Export Excel
            </button>
          </div>
        </div>

        {/* Category Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
          <div className="p-4 rounded-2xl bg-slate-950/70 border border-white/10">
            <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-slate-400">
              <span>Total Semua Issue</span>
              <i className="fas fa-layer-group text-rose-400"></i>
            </div>
            <div className="text-2xl font-black text-white mt-1.5">
              {totalAllPoints} <span className="text-xs font-bold text-slate-400">Point</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              {filteredIssues.length} Kasus • {new Set(filteredIssues.map(r => r.outlet)).size} Outlet Terdampak
            </div>
          </div>

          {categorySummary.map(cat => {
            const meta = CATEGORY_META[cat.category];
            return (
              <div
                key={cat.category}
                onClick={() => setFilterCategory(prev => prev === cat.category ? 'ALL' : cat.category)}
                className={`p-4 rounded-2xl border cursor-pointer transition-all hover:scale-[1.01] ${meta.cardBorder} ${filterCategory === cat.category ? 'ring-2 ring-white/40' : ''}`}
              >
                <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-slate-300">
                  <span>{cat.category}</span>
                  <i className={`fas ${meta.icon}`}></i>
                </div>
                <div className="flex items-baseline justify-between mt-1.5">
                  <div className="text-2xl font-black text-white">
                    {cat.points} <span className="text-xs font-bold text-slate-400">Pt</span>
                  </div>
                  <span className="text-xs font-black text-slate-300">{cat.sharePercent.toFixed(1)}%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-slate-900/90 mt-2 overflow-hidden">
                  <div className={`h-full rounded-full ${meta.barClass}`} style={{ width: `${Math.min(100, cat.sharePercent)}%` }}></div>
                </div>
                <div className="text-[10px] text-slate-400 mt-1.5 flex justify-between">
                  <span>Open: <b className="text-rose-300">{cat.openCount + cat.inProgressCount}</b></span>
                  <span>Resolved: <b className="text-emerald-300">{cat.resolvedCount}</b></span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filters & Sub-tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-900/60 p-4 rounded-2xl border border-white/10">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'SUMMARY_KATEGORI', label: 'Summary Kategori & Outlet', icon: 'fa-chart-pie' },
            { id: 'MATRIKS_TANGGAL', label: 'Matriks Tanggal (1-31)', icon: 'fa-calendar-alt' },
            { id: 'DETAIL_LOG', label: `Log Detail (${filteredIssues.length})`, icon: 'fa-list' }
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-3.5 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-amber-500 text-slate-950 shadow-lg'
                  : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <i className={`fas ${tab.icon}`}></i>
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as any)}
            className="bg-slate-950 border border-white/15 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none"
          >
            <option value="ALL">Semua Kategori Issue</option>
            {CATEGORIES.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select
            value={filterOutlet}
            onChange={(e) => {
              setFilterOutlet(e.target.value);
              onSelectOutlet?.(e.target.value === 'ALL' ? '' : e.target.value);
            }}
            className="bg-slate-950 border border-white/15 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none"
          >
            <option value="ALL">Semua Outlet ({activeOutletList.length})</option>
            {activeOutletList.map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>

          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari temuan / area / PIC..."
            className="bg-slate-950 border border-white/15 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 outline-none w-48"
          />
        </div>
      </div>

      {/* TAB 1: SUMMARY KATEGORI & OUTLET */}
      {activeTab === 'SUMMARY_KATEGORI' && (
        <div className="space-y-6">
          {/* Summary Table Per Kategori */}
          <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/70">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <h4 className="text-xs font-black uppercase tracking-widest text-amber-300 flex items-center gap-2">
                <i className="fas fa-tags"></i>
                Summary Rekapan Per Kategori Operational Issue
              </h4>
              <span className="text-[11px] text-slate-400 font-bold">{monthName} {selectedYear}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-950/90 text-slate-400 text-[10px] uppercase font-black">
                  <tr>
                    <th className="px-4 py-3">Kategori Issue</th>
                    <th className="px-4 py-3 text-center">Jumlah Kasus</th>
                    <th className="px-4 py-3 text-center">Total Point</th>
                    <th className="px-4 py-3 text-center">Persentase</th>
                    <th className="px-4 py-3 text-center">Outlet Terdampak</th>
                    <th className="px-4 py-3">Area Temuan Terbanyak</th>
                    <th className="px-4 py-3 text-center">Open</th>
                    <th className="px-4 py-3 text-center">In Progress</th>
                    <th className="px-4 py-3 text-center">Resolved</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {categorySummary.map(c => (
                    <tr key={c.category} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase border ${CATEGORY_META[c.category].badgeClass}`}>
                          <i className={`fas ${CATEGORY_META[c.category].icon}`}></i>
                          {c.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center font-bold text-white">{c.count}</td>
                      <td className="px-4 py-3 text-center font-black text-amber-300">{c.points} Pt</td>
                      <td className="px-4 py-3 text-center font-bold text-slate-300">{c.sharePercent.toFixed(1)}%</td>
                      <td className="px-4 py-3 text-center font-bold text-slate-200">{c.affectedOutlets} Outlet</td>
                      <td className="px-4 py-3 text-slate-300">{c.topArea}</td>
                      <td className="px-4 py-3 text-center font-bold text-rose-400">{c.openCount}</td>
                      <td className="px-4 py-3 text-center font-bold text-amber-400">{c.inProgressCount}</td>
                      <td className="px-4 py-3 text-center font-bold text-emerald-400">{c.resolvedCount}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-950/80 font-black text-white">
                    <td className="px-4 py-3 uppercase">TOTAL REGIONAL</td>
                    <td className="px-4 py-3 text-center">{filteredIssues.length}</td>
                    <td className="px-4 py-3 text-center text-amber-300">{totalAllPoints} Pt</td>
                    <td className="px-4 py-3 text-center">100%</td>
                    <td className="px-4 py-3 text-center">{new Set(filteredIssues.map(r => r.outlet)).size} Outlet</td>
                    <td className="px-4 py-3">-</td>
                    <td className="px-4 py-3 text-center text-rose-400">{categorySummary.reduce((s, c) => s + c.openCount, 0)}</td>
                    <td className="px-4 py-3 text-center text-amber-400">{categorySummary.reduce((s, c) => s + c.inProgressCount, 0)}</td>
                    <td className="px-4 py-3 text-center text-emerald-400">{categorySummary.reduce((s, c) => s + c.resolvedCount, 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Breakdown Per Outlet */}
          <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/70">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <h4 className="text-xs font-black uppercase tracking-widest text-indigo-300 flex items-center gap-2">
                <i className="fas fa-store"></i>
                Rekap Kategori Operational Issue Per Outlet
              </h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-950/90 text-slate-400 text-[10px] uppercase font-black">
                  <tr>
                    <th className="px-4 py-3">No</th>
                    <th className="px-4 py-3">Outlet</th>
                    <th className="px-4 py-3">Regional</th>
                    <th className="px-4 py-3 text-center text-purple-300">Issue Mistery Guest</th>
                    <th className="px-4 py-3 text-center text-amber-300">Guest Comment</th>
                    <th className="px-4 py-3 text-center text-sky-300">Google Review</th>
                    <th className="px-4 py-3 text-center text-white">Total Point</th>
                    <th className="px-4 py-3 text-center">Open / Progress</th>
                    <th className="px-4 py-3 text-center">Resolved</th>
                    <th className="px-4 py-3">Top Area</th>
                    <th className="px-4 py-3">PIC (Manpower)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {outletBreakdown.map((row, idx) => (
                    <tr
                      key={row.outlet}
                      onClick={() => setFilterOutlet(prev => prev === row.outlet ? 'ALL' : row.outlet)}
                      className="hover:bg-white/[0.04] cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 text-slate-400 font-bold">{idx + 1}</td>
                      <td className="px-4 py-3 font-black text-white">{row.outlet}</td>
                      <td className="px-4 py-3 text-[11px] text-slate-400">{row.regionalArea}</td>
                      <td className="px-4 py-3 text-center font-black text-purple-300">{row.mistery}</td>
                      <td className="px-4 py-3 text-center font-black text-amber-300">{row.comment}</td>
                      <td className="px-4 py-3 text-center font-black text-sky-300">{row.google}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2.5 py-1 rounded-lg font-black text-xs ${
                          row.totalPoints === 0
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : row.totalPoints <= 3
                            ? 'bg-amber-500/15 text-amber-300'
                            : 'bg-rose-500/20 text-rose-300'
                        }`}>
                          {row.totalPoints}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center font-bold text-rose-300">{row.openCount}</td>
                      <td className="px-4 py-3 text-center font-bold text-emerald-300">{row.resolvedCount}</td>
                      <td className="px-4 py-3 text-slate-300">{row.topArea}</td>
                      <td className="px-4 py-3 text-slate-300">{row.picsStr || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: MATRIKS TANGGAL 1-31 */}
      {activeTab === 'MATRIKS_TANGGAL' && (
        <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/70">
          <div className="px-5 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-black uppercase tracking-widest text-amber-300 flex items-center gap-2">
              <i className="fas fa-calendar-day"></i>
              Point Operational Issue Per Tanggal ({monthName} {selectedYear})
            </h4>
            <span className="text-[11px] text-slate-400">Klik sel tanggal ber-poin untuk melihat detail kronologi & temuan</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead className="bg-slate-950/90 text-slate-400 font-black uppercase">
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-950 px-3 py-2.5 text-left min-w-[155px] border-b border-r border-white/10">
                    Outlet
                  </th>
                  {dateMatrix.days.map(d => (
                    <th key={d} className="px-1.5 py-2.5 text-center min-w-[36px] border-b border-white/10">
                      {d}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-center border-b border-l border-white/10 text-amber-300 min-w-[65px]">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {dateMatrix.rows.map(row => (
                  <tr key={row.outlet} className="hover:bg-white/[0.02]">
                    <td className="sticky left-0 z-10 bg-slate-900 px-3 py-2 font-black text-white border-r border-white/10 whitespace-nowrap">
                      {row.outlet}
                    </td>
                    {dateMatrix.days.map(d => {
                      const cell = row.byDay[d];
                      const val = cell?.total || 0;
                      const dStr = `${monthKey}-${String(d).padStart(2, '0')}`;
                      return (
                        <td
                          key={d}
                          onClick={() => {
                            if (val > 0) {
                              setDetailModal({ outlet: row.outlet, dateStr: dStr, items: cell.items });
                            }
                          }}
                          title={val > 0 ? `MG: ${cell.mistery}, GC: ${cell.comment}, GR: ${cell.google}` : ''}
                          className={`px-1 py-2 text-center border-r border-white/5 ${
                            val > 0
                              ? 'bg-rose-500/20 text-rose-200 font-black cursor-pointer hover:bg-rose-500/35'
                              : 'text-slate-600'
                          }`}
                        >
                          {val > 0 ? val : '-'}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center font-black text-amber-300 border-l border-white/10 bg-slate-950/60">
                      {row.outletTotal}
                    </td>
                  </tr>
                ))}
                <tr className="bg-slate-950 font-black text-white">
                  <td className="sticky left-0 z-10 bg-slate-950 px-3 py-2.5 border-r border-white/10">TOTAL / HARI</td>
                  {dateMatrix.days.map(d => (
                    <td key={d} className="px-1 py-2.5 text-center text-amber-300">
                      {dateMatrix.dailyTotals[d] || 0}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-center text-rose-300 border-l border-white/10">
                    {totalAllPoints}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: DETAIL LOG */}
      {activeTab === 'DETAIL_LOG' && (
        <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/70">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-950/90 text-slate-400 text-[10px] uppercase font-black">
                <tr>
                  <th className="px-4 py-3 whitespace-nowrap">Tanggal</th>
                  <th className="px-4 py-3 whitespace-nowrap">Outlet</th>
                  <th className="px-4 py-3 whitespace-nowrap">Kategori</th>
                  <th className="px-4 py-3 whitespace-nowrap">Area</th>
                  <th className="px-4 py-3 min-w-[180px]">Kronologi</th>
                  <th className="px-4 py-3 min-w-[180px]">Finding Problem</th>
                  <th className="px-4 py-3 min-w-[160px]">Taken Action</th>
                  <th className="px-4 py-3 min-w-[160px]">Corrective</th>
                  <th className="px-4 py-3 whitespace-nowrap">PIC (Manpower)</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredIssues.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-12 text-center text-slate-500 font-bold">
                      Belum ada Operational Issue tercatat pada filter ini.
                    </td>
                  </tr>
                ) : (
                  filteredIssues.map(rec => (
                    <tr key={rec.id} className="hover:bg-white/[0.03] align-top">
                      <td className="px-4 py-3 font-bold text-slate-300 whitespace-nowrap">{rec.date}</td>
                      <td className="px-4 py-3 font-black text-white whitespace-nowrap">{rec.outlet}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-black border ${CATEGORY_META[rec.category]?.badgeClass || ''}`}>
                          {rec.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{rec.area}</td>
                      <td className="px-4 py-3 text-slate-300">{rec.kronologi}</td>
                      <td className="px-4 py-3 text-rose-200 font-semibold">{rec.findingProblem}</td>
                      <td className="px-4 py-3 text-emerald-200">{rec.takenAction}</td>
                      <td className="px-4 py-3 text-sky-200">{rec.corrective}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-bold text-white">{rec.pic}</div>
                        {rec.picRole && <div className="text-[10px] text-slate-400">{rec.picRole}</div>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase ${
                          rec.status === 'RESOLVED'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : rec.status === 'IN_PROGRESS'
                            ? 'bg-amber-500/20 text-amber-300'
                            : 'bg-rose-500/20 text-rose-300'
                        }`}>
                          {rec.status || 'OPEN'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detail Modal for clicked matrix cell */}
      {detailModal && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-white/15 rounded-3xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div>
                <h4 className="text-sm font-black uppercase text-white">
                  Detail Operational Issue — {detailModal.outlet}
                </h4>
                <p className="text-xs text-amber-300 font-bold">Tanggal {detailModal.dateStr} ({detailModal.items.length} Temuan)</p>
              </div>
              <button
                type="button"
                onClick={() => setDetailModal(null)}
                className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 flex items-center justify-center cursor-pointer"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="space-y-3">
              {detailModal.items.map(it => (
                <div key={it.id} className="p-4 rounded-2xl bg-slate-950/80 border border-white/10 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black border ${CATEGORY_META[it.category]?.badgeClass || ''}`}>
                      {it.category}
                    </span>
                    <span className="text-slate-400 font-bold">Area: {it.area} • PIC: <b className="text-white">{it.pic}</b></span>
                  </div>
                  <div><b className="text-slate-400">Kronologi:</b> <span className="text-slate-200">{it.kronologi}</span></div>
                  <div><b className="text-rose-300">Finding Problem:</b> <span className="text-white">{it.findingProblem}</span></div>
                  <div><b className="text-emerald-300">Taken Action:</b> <span className="text-slate-200">{it.takenAction}</span></div>
                  <div><b className="text-sky-300">Corrective:</b> <span className="text-slate-200">{it.corrective}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RegionalOperationalIssueRecapTable;
