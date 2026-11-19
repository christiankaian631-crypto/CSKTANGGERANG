import React, { useState, useMemo, useEffect } from 'react';
import { Spk3Category, Spk3Record } from '../types';
import { getActiveOutletNames, getAreaForOutlet, findOutletData, normalizeOutletKey } from '../constants';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

interface Props {
  data?: Record<string, any>;
  allOutletsData?: Record<string, any>;
  selectedMonth: number;
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

const SPK3_CATEGORIES: Spk3Category[] = [
  'Temuan Inspeksi',
  'Temuan SOS',
  'Temuan Grooming'
];

const getScoreStatus = (score: number) => {
  if (score === 100) return { label: 'PERFECT', badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' };
  if (score >= 85) return { label: 'GOOD', badge: 'bg-sky-500/20 text-sky-300 border-sky-500/30' };
  if (score >= 70) return { label: 'WARNING', badge: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
  return { label: 'CRITICAL', badge: 'bg-rose-500/20 text-rose-300 border-rose-500/30' };
};

export const RegionalSpk3RecapTable: React.FC<Props> = ({
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
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'OUTLET_SUMMARY' | 'RANKING_PELAKU' | 'MATRIKS_HARIAN'>('OUTLET_SUMMARY');
  const [updateVersion, setUpdateVersion] = useState(0);

  useEffect(() => {
    const handleUpdate = () => setUpdateVersion(v => v + 1);
    window.addEventListener('appSpk3Updated', handleUpdate);
    return () => window.removeEventListener('appSpk3Updated', handleUpdate);
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

  const todayStr = new Date().toISOString().split('T')[0];
  const isCurrentMonth = todayStr.startsWith(monthKey);
  const effectiveMaxDay = isCurrentMonth ? Math.min(daysInMonth, new Date().getDate()) : daysInMonth;

  const activeOutletList = useMemo(() => {
    const base = getActiveOutletNames();
    if (selectedArea && selectedArea !== 'ALL') {
      return base.filter(o => getAreaForOutlet(o).toUpperCase() === selectedArea.toUpperCase());
    }
    return base;
  }, [selectedArea]);

  const sourceData = useMemo(() => allOutletsData || data || {}, [allOutletsData, data, updateVersion]);

  const allPeriodRecords = useMemo(() => {
    const records: Spk3Record[] = [];
    const seenIds = new Set<string>();

    activeOutletList.forEach(outletName => {
      const canonOutlet = normalizeOutletKey(outletName);
      const outletRaw = findOutletData(sourceData, outletName) || {};
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
        if (st.dailySpk3Records && typeof st.dailySpk3Records === 'object') {
          Object.entries(st.dailySpk3Records).forEach(([dKey, dayList]) => {
            if (Array.isArray(dayList)) {
              dayList.forEach((rec: any) => {
                if (rec && rec.id) {
                  const recDate = String(rec.date || dKey || '');
                  const belongsToOutlet = !rec.outlet || normalizeOutletKey(rec.outlet) === canonOutlet;
                  if (belongsToOutlet && recDate.startsWith(monthKey) && !seenIds.has(rec.id)) {
                    seenIds.add(rec.id);
                    records.push({ ...rec, date: recDate, outlet: rec.outlet || outletName });
                  }
                }
              });
            }
          });
        }
        if (Array.isArray(st.spk3Records)) {
          st.spk3Records.forEach((rec: any) => {
            if (rec && rec.id) {
              const recDate = String(rec.date || '');
              const belongsToOutlet = !rec.outlet || normalizeOutletKey(rec.outlet) === canonOutlet;
              if (belongsToOutlet && recDate.startsWith(monthKey) && !seenIds.has(rec.id)) {
                seenIds.add(rec.id);
                records.push({ ...rec, date: recDate, outlet: rec.outlet || outletName });
              }
            }
          });
        }
      });
    });

    return records.sort((a, b) => b.date.localeCompare(a.date));
  }, [sourceData, activeOutletList, monthKey, selectedMonth]);

  const filteredRecords = useMemo(() => {
    let res = allPeriodRecords;
    if (filterOutlet && filterOutlet !== 'ALL') {
      res = res.filter(r => (r.outlet || '').toLowerCase() === filterOutlet.toLowerCase());
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      res = res.filter(r =>
        (r.pelaku || '').toLowerCase().includes(q) ||
        (r.outlet || '').toLowerCase().includes(q) ||
        (r.category || '').toLowerCase().includes(q) ||
        (r.temuanDetail || '').toLowerCase().includes(q) ||
        (r.area || '').toLowerCase().includes(q)
      );
    }
    return res;
  }, [allPeriodRecords, filterOutlet, searchQuery]);

  // Outlet Summary + Avg Daily Point Performance
  const outletSummary = useMemo(() => {
    const targetOutlets = filterOutlet && filterOutlet !== 'ALL'
      ? activeOutletList.filter(o => o.toLowerCase() === filterOutlet.toLowerCase())
      : activeOutletList;

    return targetOutlets.map(outletName => {
      const items = allPeriodRecords.filter(r => (r.outlet || '').toUpperCase() === outletName.toUpperCase());
      const inspeksi = items.filter(r => r.category === 'Temuan Inspeksi').length;
      const sos = items.filter(r => r.category === 'Temuan SOS').length;
      const grooming = items.filter(r => r.category === 'Temuan Grooming').length;
      const totalDeduction = items.reduce((s, r) => s + (Number(r.deductionPoints) || 10), 0);

      // Compute daily point performance across 1..effectiveMaxDay
      let sumDailyScores = 0;
      const dailyScores: Record<number, { score: number; findings: number }> = {};
      for (let d = 1; d <= effectiveMaxDay; d++) {
        const dStr = `${monthKey}-${String(d).padStart(2, '0')}`;
        const dayItems = items.filter(r => r.date === dStr);
        const dayDed = dayItems.reduce((s, r) => s + (Number(r.deductionPoints) || 10), 0);
        const score = Math.max(0, 100 - dayDed);
        dailyScores[d] = { score, findings: dayItems.length };
        sumDailyScores += score;
      }
      const avgDailyScore = effectiveMaxDay > 0 ? Number((sumDailyScores / effectiveMaxDay).toFixed(1)) : 100;
      const uniquePelaku = new Set(items.map(r => r.pelaku).filter(Boolean)).size;

      return {
        outlet: outletName,
        regionalArea: getAreaForOutlet(outletName),
        inspeksi,
        sos,
        grooming,
        totalFindings: items.length,
        totalDeduction,
        avgDailyScore,
        uniquePelaku,
        dailyScores
      };
    }).sort((a, b) => b.avgDailyScore - a.avgDailyScore || a.totalFindings - b.totalFindings);
  }, [activeOutletList, filterOutlet, allPeriodRecords, effectiveMaxDay, monthKey]);

  // Pelaku ranking lintas outlet
  const pelakuRanking = useMemo(() => {
    const map = new Map<string, {
      pelaku: string;
      outlet: string;
      role: string;
      division: string;
      inspeksi: number;
      sos: number;
      grooming: number;
      totalTemuan: number;
      totalDeduction: number;
      lastDate: string;
    }>();

    filteredRecords.forEach(rec => {
      const key = `${rec.outlet}___${(rec.pelaku || 'Tanpa Nama').trim().toUpperCase()}`;
      const cur = map.get(key) || {
        pelaku: rec.pelaku || 'Tanpa Nama',
        outlet: rec.outlet,
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
  }, [filteredRecords]);

  const totals = useMemo(() => {
    const inspeksi = filteredRecords.filter(r => r.category === 'Temuan Inspeksi').length;
    const sos = filteredRecords.filter(r => r.category === 'Temuan SOS').length;
    const grooming = filteredRecords.filter(r => r.category === 'Temuan Grooming').length;
    const avgRegionalScore = outletSummary.length > 0
      ? Number((outletSummary.reduce((s, o) => s + o.avgDailyScore, 0) / outletSummary.length).toFixed(1))
      : 100;
    return { total: filteredRecords.length, inspeksi, sos, grooming, avgRegionalScore };
  }, [filteredRecords, outletSummary]);

  const handleExportExcel = async () => {
    try {
      const wb = new ExcelJS.Workbook();
      const wsOut = wb.addWorksheet('Summary SPK3 Outlet');
      wsOut.columns = [
        { header: 'No', key: 'no', width: 6 },
        { header: 'Outlet', key: 'outlet', width: 22 },
        { header: 'Area', key: 'area', width: 18 },
        { header: 'Temuan Inspeksi', key: 'inspeksi', width: 16 },
        { header: 'Temuan SOS', key: 'sos', width: 14 },
        { header: 'Temuan Grooming', key: 'grooming', width: 18 },
        { header: 'Total Temuan', key: 'total', width: 14 },
        { header: 'Total Poin Pengurang', key: 'ded', width: 20 },
        { header: 'Avg Daily Point Performance', key: 'avg', width: 24 }
      ];
      outletSummary.forEach((o, i) => {
        wsOut.addRow({
          no: i + 1,
          outlet: o.outlet,
          area: o.regionalArea,
          inspeksi: o.inspeksi,
          sos: o.sos,
          grooming: o.grooming,
          total: o.totalFindings,
          ded: o.totalDeduction,
          avg: o.avgDailyScore
        });
      });

      const wsPelaku = wb.addWorksheet('Ranking Pelaku SPK3');
      wsPelaku.columns = [
        { header: 'Nama Pelaku', key: 'pelaku', width: 24 },
        { header: 'Outlet', key: 'outlet', width: 20 },
        { header: 'Jabatan', key: 'role', width: 18 },
        { header: 'Inspeksi', key: 'ins', width: 12 },
        { header: 'SOS', key: 'sos', width: 12 },
        { header: 'Grooming', key: 'grm', width: 12 },
        { header: 'Total Temuan', key: 'tot', width: 14 },
        { header: 'Total Pengurang', key: 'ded', width: 16 }
      ];
      pelakuRanking.forEach(p => {
        wsPelaku.addRow({
          pelaku: p.pelaku,
          outlet: p.outlet,
          role: p.role,
          ins: p.inspeksi,
          sos: p.sos,
          grm: p.grooming,
          tot: p.totalTemuan,
          ded: p.totalDeduction
        });
      });

      const wsLog = wb.addWorksheet('Log Temuan SPK3');
      wsLog.columns = [
        { header: 'Tanggal', key: 'date', width: 14 },
        { header: 'Outlet', key: 'outlet', width: 20 },
        { header: 'Kategori', key: 'cat', width: 18 },
        { header: 'Nama Pelaku', key: 'pelaku', width: 22 },
        { header: 'Area', key: 'area', width: 18 },
        { header: 'Detail Temuan', key: 'detail', width: 36 },
        { header: 'Tindak Lanjut', key: 'tl', width: 28 },
        { header: 'Pengurang Poin', key: 'ded', width: 14 }
      ];
      filteredRecords.forEach(r => {
        wsLog.addRow({
          date: r.date,
          outlet: r.outlet,
          cat: r.category,
          pelaku: r.pelaku,
          area: r.area || '-',
          detail: r.temuanDetail,
          tl: r.tindakLanjut || '-',
          ded: Number(r.deductionPoints) || 10
        });
      });

      [wsOut, wsPelaku, wsLog].forEach(ws => {
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      });

      const buf = await wb.xlsx.writeBuffer();
      saveAs(new Blob([buf]), `Rekapan_SPK3_${monthName}_${selectedYear}.xlsx`);
      showToast?.('Excel SPK3 berhasil diunduh!', 'success');
    } catch (err) {
      console.error(err);
      showToast?.('Gagal mengekspor Excel SPK3.', 'error');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="glass-card p-6 rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900/95 via-amber-950/15 to-slate-900/95">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-slate-950 shadow-lg">
              <i className="fas fa-shield-alt text-xl"></i>
            </div>
            <div>
              <h3 className="text-lg md:text-xl font-black uppercase tracking-tight text-white">
                Rekapan SPK3 Regional
              </h3>
              <p className="text-xs text-slate-400">
                Periode <span className="text-amber-300 font-bold">{monthName} {selectedYear}</span> • Temuan Inspeksi, SOS, Grooming & Daily Point Performance
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleExportExcel}
            className="px-4 py-2 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 text-xs font-black uppercase tracking-wider flex items-center gap-2 cursor-pointer self-start lg:self-auto"
          >
            <i className="fas fa-file-excel"></i>
            Export Excel SPK3
          </button>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-5">
          <div className="p-4 rounded-2xl bg-slate-950/70 border border-emerald-500/30">
            <div className="text-[10px] font-black uppercase text-emerald-300">Avg Point Performance</div>
            <div className="text-2xl font-black text-white mt-1">{totals.avgRegionalScore} <span className="text-xs text-slate-400">/100</span></div>
            <div className="text-[10px] text-slate-400 mt-1">Rata-rata harian s/d Tgl {effectiveMaxDay}</div>
          </div>
          <div className="p-4 rounded-2xl bg-slate-950/70 border border-white/10">
            <div className="text-[10px] font-black uppercase text-slate-400">Total Temuan SPK3</div>
            <div className="text-2xl font-black text-white mt-1">{totals.total}</div>
            <div className="text-[10px] text-slate-400 mt-1">{pelakuRanking.length} Staff Terlibat</div>
          </div>
          <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30">
            <div className="text-[10px] font-black uppercase text-rose-300">Temuan Inspeksi</div>
            <div className="text-2xl font-black text-white mt-1">{totals.inspeksi}</div>
            <div className="text-[10px] text-slate-400 mt-1">Standar Inspeksi Outlet</div>
          </div>
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30">
            <div className="text-[10px] font-black uppercase text-amber-300">Temuan SOS</div>
            <div className="text-2xl font-black text-white mt-1">{totals.sos}</div>
            <div className="text-[10px] text-slate-400 mt-1">Speed of Service</div>
          </div>
          <div className="p-4 rounded-2xl bg-sky-500/10 border border-sky-500/30">
            <div className="text-[10px] font-black uppercase text-sky-300">Temuan Grooming</div>
            <div className="text-2xl font-black text-white mt-1">{totals.grooming}</div>
            <div className="text-[10px] text-slate-400 mt-1">Penampilan & Hygiene</div>
          </div>
        </div>
      </div>

      {/* Filters & Sub-tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-900/60 p-4 rounded-2xl border border-white/10">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'OUTLET_SUMMARY', label: 'Performa SPK3 Outlet', icon: 'fa-store' },
            { id: 'RANKING_PELAKU', label: `Ranking Pelaku (${pelakuRanking.length})`, icon: 'fa-users' },
            { id: 'MATRIKS_HARIAN', label: 'Matriks Point Harian (1-31)', icon: 'fa-calendar-check' }
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-3.5 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider flex items-center gap-2 cursor-pointer ${
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
            value={filterOutlet}
            onChange={(e) => {
              setFilterOutlet(e.target.value);
              onSelectOutlet?.(e.target.value === 'ALL' ? '' : e.target.value);
            }}
            className="bg-slate-950 border border-white/15 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none"
          >
            <option value="ALL">Semua Outlet ({activeOutletList.length})</option>
            {activeOutletList.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari pelaku / temuan..."
            className="bg-slate-950 border border-white/15 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 outline-none w-48"
          />
        </div>
      </div>

      {/* TAB 1: OUTLET SUMMARY */}
      {activeTab === 'OUTLET_SUMMARY' && (
        <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/70">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-950/90 text-slate-400 text-[10px] uppercase font-black">
                <tr>
                  <th className="px-4 py-3">Rank</th>
                  <th className="px-4 py-3">Outlet</th>
                  <th className="px-4 py-3">Regional</th>
                  <th className="px-4 py-3 text-center text-rose-300">Temuan Inspeksi</th>
                  <th className="px-4 py-3 text-center text-amber-300">Temuan SOS</th>
                  <th className="px-4 py-3 text-center text-sky-300">Temuan Grooming</th>
                  <th className="px-4 py-3 text-center">Total Temuan</th>
                  <th className="px-4 py-3 text-center">Poin Pengurang</th>
                  <th className="px-4 py-3 text-center">Avg Daily Point</th>
                  <th className="px-4 py-3 text-center">Grade</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {outletSummary.map((o, idx) => {
                  const st = getScoreStatus(o.avgDailyScore);
                  return (
                    <tr key={o.outlet} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3 font-black text-slate-300">#{idx + 1}</td>
                      <td className="px-4 py-3 font-black text-white">{o.outlet}</td>
                      <td className="px-4 py-3 text-slate-400">{o.regionalArea}</td>
                      <td className="px-4 py-3 text-center font-bold text-rose-300">{o.inspeksi}</td>
                      <td className="px-4 py-3 text-center font-bold text-amber-300">{o.sos}</td>
                      <td className="px-4 py-3 text-center font-bold text-sky-300">{o.grooming}</td>
                      <td className="px-4 py-3 text-center font-black text-white">{o.totalFindings}</td>
                      <td className="px-4 py-3 text-center font-bold text-rose-400">-{o.totalDeduction}</td>
                      <td className="px-4 py-3 text-center font-black text-emerald-300 text-sm">{o.avgDailyScore}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black border ${st.badge}`}>
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: RANKING PELAKU */}
      {activeTab === 'RANKING_PELAKU' && (
        <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/70">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-950/90 text-slate-400 text-[10px] uppercase font-black">
                <tr>
                  <th className="px-4 py-3">No</th>
                  <th className="px-4 py-3">Nama Pelaku (Manpower)</th>
                  <th className="px-4 py-3">Outlet</th>
                  <th className="px-4 py-3">Jabatan / Divisi</th>
                  <th className="px-4 py-3 text-center text-rose-300">Inspeksi</th>
                  <th className="px-4 py-3 text-center text-amber-300">SOS</th>
                  <th className="px-4 py-3 text-center text-sky-300">Grooming</th>
                  <th className="px-4 py-3 text-center">Total Temuan</th>
                  <th className="px-4 py-3 text-center">Pengurang Poin</th>
                  <th className="px-4 py-3">Tanggal Terakhir</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {pelakuRanking.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-12 text-center text-slate-500 font-bold">
                      Tidak ada temuan SPK3 pada periode ini.
                    </td>
                  </tr>
                ) : (
                  pelakuRanking.map((p, idx) => (
                    <tr key={`${p.outlet}-${p.pelaku}-${idx}`} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3 font-bold text-slate-400">{idx + 1}</td>
                      <td className="px-4 py-3 font-black text-white">{p.pelaku}</td>
                      <td className="px-4 py-3 font-bold text-amber-200">{p.outlet}</td>
                      <td className="px-4 py-3 text-slate-300">{p.role} {p.division !== '-' ? `(${p.division})` : ''}</td>
                      <td className="px-4 py-3 text-center font-bold text-rose-300">{p.inspeksi}</td>
                      <td className="px-4 py-3 text-center font-bold text-amber-300">{p.sos}</td>
                      <td className="px-4 py-3 text-center font-bold text-sky-300">{p.grooming}</td>
                      <td className="px-4 py-3 text-center font-black text-white">{p.totalTemuan}</td>
                      <td className="px-4 py-3 text-center font-black text-rose-400">-{p.totalDeduction}</td>
                      <td className="px-4 py-3 text-slate-400">{p.lastDate}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: MATRIKS HARIAN POINT PERFORMANCE */}
      {activeTab === 'MATRIKS_HARIAN' && (
        <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/70">
          <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
            <h4 className="text-xs font-black uppercase tracking-widest text-emerald-300">
              Daily Point Performance SPK3 (Basis 100 Poin/Hari)
            </h4>
            <span className="text-[11px] text-slate-400">Periode s/d Tanggal {effectiveMaxDay} {monthName}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead className="bg-slate-950/90 text-slate-400 font-black uppercase">
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-950 px-3 py-2.5 text-left min-w-[155px] border-b border-r border-white/10">Outlet</th>
                  {Array.from({ length: effectiveMaxDay }, (_, i) => i + 1).map(d => (
                    <th key={d} className="px-1.5 py-2.5 text-center min-w-[38px] border-b border-white/10">{d}</th>
                  ))}
                  <th className="px-3 py-2.5 text-center border-b border-l border-white/10 text-emerald-300">Avg</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {outletSummary.map(row => (
                  <tr key={row.outlet} className="hover:bg-white/[0.02]">
                    <td className="sticky left-0 z-10 bg-slate-900 px-3 py-2 font-black text-white border-r border-white/10 whitespace-nowrap">
                      {row.outlet}
                    </td>
                    {Array.from({ length: effectiveMaxDay }, (_, i) => i + 1).map(d => {
                      const cell = row.dailyScores[d];
                      const sc = cell?.score ?? 100;
                      const find = cell?.findings ?? 0;
                      return (
                        <td
                          key={d}
                          title={`Tanggal ${d}: Skor ${sc}/100 (${find} temuan)`}
                          className={`px-1 py-2 text-center font-bold border-r border-white/5 ${
                            sc === 100
                              ? 'text-emerald-400/80'
                              : sc >= 80
                              ? 'bg-amber-500/15 text-amber-300 font-black'
                              : 'bg-rose-500/20 text-rose-300 font-black'
                          }`}
                        >
                          {sc}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center font-black text-emerald-300 border-l border-white/10 bg-slate-950/60">
                      {row.avgDailyScore}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default RegionalSpk3RecapTable;
