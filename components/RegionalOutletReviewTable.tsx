import React, { useState, useMemo, useEffect } from 'react';
import { OperationalIssueCategory, OperationalIssueRecord, Spk3Record, VoidBillRecord } from '../types';
import {
  getActiveOutletNames,
  getAreaForOutlet,
  findOutletData,
  getOutletMonthData,
  extractAllGSIEntries,
  OT_RATE
} from '../constants';
import { resolvePattyCashBudget } from './RegionalSummaryReportRecapTable';
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

const ISSUE_CATEGORIES: OperationalIssueCategory[] = [
  'Issue Mistery Guest',
  'Guest Comment',
  'Google Review'
];

const formatIDR = (val: number) => `Rp ${(Math.round(val) || 0).toLocaleString('id-ID')}`;

const sumLedger = (records: any, filterMonthPrefix: string) => {
  if (!records || typeof records !== 'object') return 0;
  let total = 0;
  Object.entries(records).forEach(([dateStr, list]: [string, any]) => {
    if (dateStr.startsWith(filterMonthPrefix)) {
      if (Array.isArray(list)) {
        list.forEach((item: any) => {
          if (item && item.price) {
            const qty = Number(item.qty) || 1;
            total += Number(item.price) * qty;
          }
        });
      } else if (typeof list === 'number') {
        total += list;
      }
    }
  });
  return total;
};

interface DailyIssueBucket {
  mistery: number;
  comment: number;
  google: number;
  total: number;
  items: OperationalIssueRecord[];
}

export interface OutletReviewRow {
  outlet: string;
  area: string;
  // 1. Revenue Vs Budget
  mtdRevenue: number;
  budgetRevenue: number;
  revAchievement: number;
  revVariance: number;
  // 2. Achievement GSI
  gsiScorePercent: number;
  gsiTotalResponses: number;
  // 3. Achievement Google Review
  grRating: number;
  grTotalReviews: number;
  // 4. Overtime Review vs MTD Revenue
  otTotalHours: number;
  otCost: number;
  otPercentOfRev: number;
  // 5. Patty Cash Expense Review vs MTD Revenue
  pattyCashTotal: number;
  pattyCashBudget: number;
  pattyCashPercentOfRev: number;
  // 6. Operational Issue (per category + per date)
  issueMistery: number;
  issueComment: number;
  issueGoogle: number;
  issueTotalPoints: number;
  issueByDay: Record<number, DailyIssueBucket>;
  // 7. Void Bill Issue
  voidCount: number;
  voidAmount: number;
  voidPercentOfRev: number;
  // 8. SPK3 Review
  spk3Inspeksi: number;
  spk3Sos: number;
  spk3Grooming: number;
  spk3TotalFindings: number;
  spk3AvgDailyPoint: number;
  // 9. Ranking
  compositeScore: number;
  rank: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  scoreBreakdown: {
    revScore: number;
    gsiScore: number;
    grScore: number;
    otScore: number;
    pattyScore: number;
    issueScore: number;
    voidScore: number;
    spk3Score: number;
  };
}

export const RegionalOutletReviewTable: React.FC<Props> = ({
  data,
  allOutletsData,
  selectedMonth,
  selectedYear,
  selectedArea = 'ALL',
  selectedOutlet = 'ALL',
  onSelectOutlet,
  showToast
}) => {
  const [viewMode, setViewMode] = useState<'OUTLET_REVIEW_TABLE' | 'ISSUE_DAILY_MATRIX' | 'RANKING_WEIGHTS'>('OUTLET_REVIEW_TABLE');
  const [sortBy, setSortBy] = useState<'RANK' | 'REVENUE' | 'GSI' | 'OUTLET'>('RANK');
  const [matrixCategoryFilter, setMatrixCategoryFilter] = useState<'ALL' | 'BREAKDOWN' | OperationalIssueCategory>('BREAKDOWN');
  const [searchOutlet, setSearchOutlet] = useState('');
  const [cellDetailModal, setCellDetailModal] = useState<{
    outlet: string;
    dateStr: string;
    bucket: DailyIssueBucket;
  } | null>(null);
  const [updateVersion, setUpdateVersion] = useState(0);

  useEffect(() => {
    const bump = () => setUpdateVersion(v => v + 1);
    window.addEventListener('appOperationalIssuesUpdated', bump);
    window.addEventListener('appSpk3Updated', bump);
    window.addEventListener('appVoidBillsUpdated', bump);
    window.addEventListener('voidBillsUpdated', bump);
    return () => {
      window.removeEventListener('appOperationalIssuesUpdated', bump);
      window.removeEventListener('appSpk3Updated', bump);
      window.removeEventListener('appVoidBillsUpdated', bump);
      window.removeEventListener('voidBillsUpdated', bump);
    };
  }, []);

  const sourceData = useMemo(() => allOutletsData || data || {}, [allOutletsData, data, updateVersion]);
  const monthKey = `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}`;
  const monthName = MONTH_NAMES[selectedMonth] || 'Bulan';

  const daysInMonth = useMemo(() => {
    const d = new Date(selectedYear, selectedMonth + 1, 0).getDate();
    return (isNaN(d) || d < 28) ? 30 : d;
  }, [selectedYear, selectedMonth]);

  const lastMonthIdx = selectedMonth === 0 ? 11 : selectedMonth - 1;
  const lastMonthYear = selectedMonth === 0 ? selectedYear - 1 : selectedYear;
  const lastMonthKey = `${lastMonthYear}-${String(lastMonthIdx + 1).padStart(2, '0')}`;

  const todayStr = new Date().toISOString().split('T')[0];
  const isCurrentMonth = todayStr.startsWith(monthKey);
  const effectiveMaxDay = isCurrentMonth ? Math.min(daysInMonth, new Date().getDate()) : daysInMonth;

  const targetOutlets = useMemo(() => {
    let list = getActiveOutletNames().filter(o => {
      const d = sourceData?.[o];
      return !d || !d.isDeleted;
    });
    if (selectedOutlet && selectedOutlet !== 'ALL' && selectedOutlet !== '') {
      list = list.filter(o => o.toLowerCase() === selectedOutlet.toLowerCase());
    } else if (selectedArea && selectedArea !== 'ALL') {
      list = list.filter(o => getAreaForOutlet(o).toUpperCase() === selectedArea.toUpperCase());
    }
    if (searchOutlet.trim()) {
      const q = searchOutlet.toLowerCase();
      list = list.filter(o => o.toLowerCase().includes(q) || getAreaForOutlet(o).toLowerCase().includes(q));
    }
    return list;
  }, [sourceData, selectedOutlet, selectedArea, searchOutlet]);

  const collectCandidateStates = (outletMonths: any, mData: any) => {
    const candidates: any[] = [];
    if (mData) candidates.push(mData);
    if (outletMonths?.[String(selectedMonth)]) candidates.push(outletMonths[String(selectedMonth)]);
    if (outletMonths?.[selectedMonth]) candidates.push(outletMonths[selectedMonth]);
    if (outletMonths?.[monthKey]) candidates.push(outletMonths[monthKey]);
    if (outletMonths?.monthlyData && typeof outletMonths.monthlyData === 'object') {
      if (outletMonths.monthlyData[String(selectedMonth)]) candidates.push(outletMonths.monthlyData[String(selectedMonth)]);
      if (outletMonths.monthlyData[selectedMonth]) candidates.push(outletMonths.monthlyData[selectedMonth]);
      if (outletMonths.monthlyData[monthKey]) candidates.push(outletMonths.monthlyData[monthKey]);
      Object.values(outletMonths.monthlyData).forEach((mVal: any) => {
        if (mVal && !candidates.includes(mVal)) candidates.push(mVal);
      });
    }
    if (outletMonths) candidates.push(outletMonths);
    return candidates;
  };

  const reviewRows = useMemo<OutletReviewRow[]>(() => {
    const rawRows = targetOutlets.map(outletName => {
      const outletMonths = findOutletData(sourceData, outletName) || {};
      const mData = getOutletMonthData(outletMonths, selectedMonth, selectedYear) || {};
      const lastMData = getOutletMonthData(outletMonths, lastMonthIdx, lastMonthYear) || {};
      const candidates = collectCandidateStates(outletMonths, mData);

      // 1. REVENUE VS BUDGET
      const sales = mData.sales || outletMonths.sales || { dailyRecording: {} };
      const budgetRevenue = Number((sales.monthlyBudgets || {})[monthKey] || sales.budgetRevenue || 0);
      const combinedDailyRecording = {
        ...(outletMonths.dailyRecording || {}),
        ...((outletMonths.sales && outletMonths.sales.dailyRecording) || {}),
        ...(mData.dailyRecording || {}),
        ...(sales.dailyRecording || {})
      };
      let mtdRevenue = 0;
      Object.entries(combinedDailyRecording).forEach(([dStr, dVal]: [string, any]) => {
        if (dStr.startsWith(monthKey)) {
          const rev = Number(dVal?.revenue) ||
            ((Number(dVal?.dineInRevenue) || 0) + (Number(dVal?.takeAwayRevenue) || 0) + (Number(dVal?.goFoodRevenue) || 0) + (Number(dVal?.grabFoodRevenue) || 0));
          mtdRevenue += rev;
        }
      });
      if (mtdRevenue === 0 && sales.revenue) {
        mtdRevenue = Number(sales.revenue) || 0;
      }
      const revAchievement = budgetRevenue > 0 ? (mtdRevenue / budgetRevenue) * 100 : 0;
      const revVariance = mtdRevenue - budgetRevenue;

      // 2. ACHIEVEMENT GSI
      const extractedGsi = extractAllGSIEntries(outletMonths);
      const combinedDailyGSI: Record<string, any> = {
        ...extractedGsi,
        ...(outletMonths.dailyGSI || {}),
        ...(mData.dailyGSI || {})
      };
      let qosPos = 0, qosTot = 0, qofPos = 0, qofTot = 0, qobPos = 0, qobTot = 0, aosPos = 0, aosTot = 0, vfmPos = 0, vfmTot = 0;
      let gsiTotalResponses = 0;
      Object.entries(combinedDailyGSI).forEach(([dateStr, rawRows]: [string, any]) => {
        const rows = Array.isArray(rawRows) ? rawRows : (rawRows && typeof rawRows === 'object' ? Object.values(rawRows) : []);
        if (dateStr.startsWith(monthKey) && rows.length > 0) {
          rows.forEach((r: any) => {
            const exc = Number(r.excellent) || 0;
            const gd = Number(r.good) || 0;
            const avg = Number(r.average) || 0;
            const pr = Number(r.poor) || 0;
            const abs = Number(r.abstain) || 0;
            const pos = exc + gd;
            const tot = exc + gd + avg + pr;
            gsiTotalResponses += pos + avg + pr + abs;
            const sub = String(r.subject || r.label || '').toLowerCase();
            if (sub.includes('service') && !sub.includes('attentive')) {
              qosPos += pos; qosTot += tot;
            } else if (sub.includes('food')) {
              qofPos += pos; qofTot += tot;
            } else if (sub.includes('beverage') || sub.includes('drink')) {
              qobPos += pos; qobTot += tot;
            } else if (sub.includes('attentive') || sub.includes('staff') || sub.includes('ambiance') || sub.includes('cleanliness')) {
              aosPos += pos; aosTot += tot;
            } else if (sub.includes('value') || sub.includes('money') || sub.includes('price')) {
              vfmPos += pos; vfmTot += tot;
            }
          });
        }
      });
      const validGsiCats = [
        qosTot > 0 ? (qosPos / qosTot) * 100 : 0,
        qofTot > 0 ? (qofPos / qofTot) * 100 : 0,
        qobTot > 0 ? (qobPos / qobTot) * 100 : 0,
        aosTot > 0 ? (aosPos / aosTot) * 100 : 0,
        vfmTot > 0 ? (vfmPos / vfmTot) * 100 : 0
      ].filter(v => v > 0);
      const gsiScorePercent = validGsiCats.length > 0
        ? validGsiCats.reduce((a, b) => a + b, 0) / validGsiCats.length
        : 0;

      // 3. ACHIEVEMENT GOOGLE REVIEW
      let grRating = 0;
      let grTotalReviews = 0;
      const grData = mData.googleReviews?.[monthKey] || outletMonths.googleReviews?.[monthKey] || mData.googleReview || outletMonths.googleReview;
      if (grData) {
        grRating = Number(grData.rating || grData.currentRating) || 0;
        grTotalReviews = Number(grData.totalReviews || grData.totalReview) || 0;
      }
      if (grTotalReviews === 0) {
        const dailyGR: Record<string, any> = {
          ...(outletMonths.dailyGoogleReview || {}),
          ...(mData.dailyGoogleReview || {})
        };
        let sCount = 0;
        let sPoints = 0;
        Object.entries(dailyGR).forEach(([dStr, val]: [string, any]) => {
          if (dStr.startsWith(monthKey) && val) {
            const s1 = Number(val.stars1) || 0;
            const s2 = Number(val.stars2) || 0;
            const s3 = Number(val.stars3) || 0;
            const s4 = Number(val.stars4) || 0;
            const s5 = Number(val.stars5) || 0;
            const tot = s1 + s2 + s3 + s4 + s5;
            sCount += tot;
            sPoints += (s1 * 1 + s2 * 2 + s3 * 3 + s4 * 4 + s5 * 5);
          }
        });
        if (sCount > 0) {
          grTotalReviews = sCount;
          grRating = Number((sPoints / sCount).toFixed(2));
        }
      }

      // 4. OVERTIME REVIEW VS MTD REVENUE (Cutoff 26 prev month - 25 curr month)
      const cutoffStart = `${lastMonthKey}-26`;
      const cutoffEnd = `${monthKey}-25`;
      let otTotalHours = 0;
      if (mData.weeklyOvertime) {
        Object.entries(mData.weeklyOvertime).forEach(([k, entry]: [string, any]) => {
          if (Array.isArray(entry)) {
            entry.forEach((wItem: any) => {
              otTotalHours += Number(wItem.totalOvertime) || Number(wItem.totalOvertimeHours) || 0;
            });
          } else if (k.startsWith(monthKey) || entry?.monthKey === monthKey || (entry?.startDate >= cutoffStart && entry?.endDate <= cutoffEnd)) {
            otTotalHours += Number(entry.totalOvertime) || Number(entry.totalOvertimeHours) || 0;
          }
        });
      }
      if (otTotalHours === 0) {
        const combinedDailyOT: Record<string, any[]> = {
          ...(outletMonths.dailyOvertime || {}),
          ...(lastMData.dailyOvertime || {}),
          ...(mData.dailyOvertime || {})
        };
        Object.entries(combinedDailyOT).forEach(([dateStr, entries]) => {
          const rowArr = Array.isArray(entries) ? entries : (entries && typeof entries === 'object' ? Object.values(entries) : []);
          if (dateStr >= cutoffStart && dateStr <= cutoffEnd && rowArr.length > 0) {
            rowArr.forEach((e: any) => {
              otTotalHours += Number(e.hours) || Number(e.overtimeHours) || 0;
            });
          }
        });
      }
      const otRate = Number(mData.overtimeHourlyRate || outletMonths.overtimeHourlyRate) || OT_RATE;
      const otCost = otTotalHours * otRate;
      const otPercentOfRev = mtdRevenue > 0 ? (otCost / mtdRevenue) * 100 : 0;

      // 5. PATTY CASH EXPENSE REVIEW VS MTD REVENUE
      let opexNonCommodity = sumLedger(mData.dailyNonCommodityLedger, monthKey);
      let opexCommodity = sumLedger(mData.dailyCommodityLedger, monthKey);
      let opexAtk = sumLedger(mData.dailyAtkLedger, monthKey);
      let opexMaintenance = sumLedger(mData.dailyMaintenanceLedger, monthKey);
      let opexAsset = sumLedger(mData.dailyAssetLedger, monthKey);
      let opexCasual = sumLedger(mData.dailyCasualLedger, monthKey);
      if (mData.expenses) {
        Object.entries(mData.expenses).forEach(([dateStr, exp]: [string, any]) => {
          if (dateStr.startsWith(monthKey)) {
            if (opexNonCommodity === 0) opexNonCommodity += Number(exp?.nonCommodity) || 0;
            if (opexCommodity === 0) opexCommodity += Number(exp?.commodity) || 0;
            if (opexAtk === 0) opexAtk += Number(exp?.atk) || 0;
            if (opexMaintenance === 0) opexMaintenance += Number(exp?.maintenance) || 0;
            if (opexAsset === 0) opexAsset += Number(exp?.asset) || 0;
            if (opexCasual === 0) opexCasual += Number(exp?.casual) || 0;
          }
        });
      }
      const opexTotal = opexNonCommodity + opexCommodity + opexAtk + opexMaintenance + opexAsset + opexCasual;
      let pattyCashTotal = opexTotal + sumLedger(mData.dailyThirdPartyLedger, monthKey) + sumLedger(mData.dailyCashLedger, monthKey);
      if (pattyCashTotal === 0 && mData.expenses) {
        Object.entries(mData.expenses).forEach(([dateStr, exp]: [string, any]) => {
          if (dateStr.startsWith(monthKey)) {
            pattyCashTotal += (Number(exp?.thirdParty) || 0) + (Number(exp?.cash) || 0);
          }
        });
      }
      if (pattyCashTotal === 0) pattyCashTotal = opexTotal;
      const pattyCashBudget = resolvePattyCashBudget(mData, monthKey, mtdRevenue, outletName);
      const pattyCashPercentOfRev = mtdRevenue > 0 ? (pattyCashTotal / mtdRevenue) * 100 : 0;

      // 6. OPERATIONAL ISSUE (Per Kategori & Per Tanggal)
      const issueRecords: OperationalIssueRecord[] = [];
      const seenIssueIds = new Set<string>();
      candidates.forEach(st => {
        if (!st) return;
        if (st.dailyOperationalIssues && typeof st.dailyOperationalIssues === 'object') {
          Object.entries(st.dailyOperationalIssues).forEach(([dKey, dArr]) => {
            if (Array.isArray(dArr)) {
              dArr.forEach((rec: any) => {
                if (rec && rec.id) {
                  const rDate = String(rec.date || dKey || '');
                  if (rDate.startsWith(monthKey) && !seenIssueIds.has(rec.id)) {
                    seenIssueIds.add(rec.id);
                    issueRecords.push({ ...rec, date: rDate, outlet: rec.outlet || outletName, points: Number(rec.points) || 1 });
                  }
                }
              });
            }
          });
        }
        if (Array.isArray(st.operationalIssues)) {
          st.operationalIssues.forEach((rec: any) => {
            if (rec && rec.id) {
              const rDate = String(rec.date || '');
              if (rDate.startsWith(monthKey) && !seenIssueIds.has(rec.id)) {
                seenIssueIds.add(rec.id);
                issueRecords.push({ ...rec, date: rDate, outlet: rec.outlet || outletName, points: Number(rec.points) || 1 });
              }
            }
          });
        }
      });

      const issueByDay: Record<number, DailyIssueBucket> = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const dStr = `${monthKey}-${String(d).padStart(2, '0')}`;
        const dayItems = issueRecords.filter(r => r.date === dStr);
        const mistery = dayItems.filter(r => r.category === 'Issue Mistery Guest').reduce((s, r) => s + (Number(r.points) || 1), 0);
        const comment = dayItems.filter(r => r.category === 'Guest Comment').reduce((s, r) => s + (Number(r.points) || 1), 0);
        const google = dayItems.filter(r => r.category === 'Google Review').reduce((s, r) => s + (Number(r.points) || 1), 0);
        issueByDay[d] = {
          mistery,
          comment,
          google,
          total: mistery + comment + google,
          items: dayItems
        };
      }
      const issueMistery = issueRecords.filter(r => r.category === 'Issue Mistery Guest').reduce((s, r) => s + (Number(r.points) || 1), 0);
      const issueComment = issueRecords.filter(r => r.category === 'Guest Comment').reduce((s, r) => s + (Number(r.points) || 1), 0);
      const issueGoogle = issueRecords.filter(r => r.category === 'Google Review').reduce((s, r) => s + (Number(r.points) || 1), 0);
      const issueTotalPoints = issueMistery + issueComment + issueGoogle;

      // 7. VOID BILL ISSUE
      const voidRecords: VoidBillRecord[] = [];
      const seenVoidIds = new Set<string>();
      candidates.forEach(st => {
        if (!st) return;
        if (st.dailyVoidBills && typeof st.dailyVoidBills === 'object') {
          Object.entries(st.dailyVoidBills).forEach(([dKey, dArr]) => {
            if (Array.isArray(dArr)) {
              dArr.forEach((rec: any) => {
                if (rec && rec.id) {
                  const rDate = String(rec.date || dKey || '');
                  if (rDate.startsWith(monthKey) && !seenVoidIds.has(rec.id)) {
                    seenVoidIds.add(rec.id);
                    voidRecords.push({ ...rec, date: rDate });
                  }
                }
              });
            }
          });
        }
        if (Array.isArray(st.voidBills)) {
          st.voidBills.forEach((rec: any) => {
            if (rec && rec.id) {
              const rDate = String(rec.date || '');
              if (rDate.startsWith(monthKey) && !seenVoidIds.has(rec.id)) {
                seenVoidIds.add(rec.id);
                voidRecords.push({ ...rec, date: rDate });
              }
            }
          });
        }
      });
      const voidCount = voidRecords.length;
      const voidAmount = voidRecords.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const voidPercentOfRev = mtdRevenue > 0 ? (voidAmount / mtdRevenue) * 100 : 0;

      // 8. SPK3 REVIEW
      const spk3Records: Spk3Record[] = [];
      const seenSpk3Ids = new Set<string>();
      candidates.forEach(st => {
        if (!st) return;
        if (st.dailySpk3Records && typeof st.dailySpk3Records === 'object') {
          Object.entries(st.dailySpk3Records).forEach(([dKey, dArr]) => {
            if (Array.isArray(dArr)) {
              dArr.forEach((rec: any) => {
                if (rec && rec.id) {
                  const rDate = String(rec.date || dKey || '');
                  if (rDate.startsWith(monthKey) && !seenSpk3Ids.has(rec.id)) {
                    seenSpk3Ids.add(rec.id);
                    spk3Records.push({ ...rec, date: rDate });
                  }
                }
              });
            }
          });
        }
        if (Array.isArray(st.spk3Records)) {
          st.spk3Records.forEach((rec: any) => {
            if (rec && rec.id) {
              const rDate = String(rec.date || '');
              if (rDate.startsWith(monthKey) && !seenSpk3Ids.has(rec.id)) {
                seenSpk3Ids.add(rec.id);
                spk3Records.push({ ...rec, date: rDate });
              }
            }
          });
        }
      });
      const spk3Inspeksi = spk3Records.filter(r => r.category === 'Temuan Inspeksi').length;
      const spk3Sos = spk3Records.filter(r => r.category === 'Temuan SOS').length;
      const spk3Grooming = spk3Records.filter(r => r.category === 'Temuan Grooming').length;
      const spk3TotalFindings = spk3Records.length;
      let sumSpk3Daily = 0;
      for (let d = 1; d <= effectiveMaxDay; d++) {
        const dStr = `${monthKey}-${String(d).padStart(2, '0')}`;
        const dItems = spk3Records.filter(r => r.date === dStr);
        const ded = dItems.reduce((s, r) => s + (Number(r.deductionPoints) || 10), 0);
        sumSpk3Daily += Math.max(0, 100 - ded);
      }
      const spk3AvgDailyPoint = effectiveMaxDay > 0 ? Number((sumSpk3Daily / effectiveMaxDay).toFixed(1)) : 100;

      // 9. COMPOSITE SCORE FOR OUTLET RANKING (Max 100 Pts)
      // - Revenue vs Budget (25 pts)
      const revScore = Math.min(25, (Math.max(0, revAchievement) / 100) * 25);
      // - Achievement GSI (15 pts)
      const gsiScore = Math.min(15, (Math.max(0, gsiScorePercent) / 100) * 15);
      // - Achievement Google Review (15 pts)
      const grScore = Math.min(15, (Math.max(0, grRating) / 5) * 15);
      // - Overtime vs MTD Revenue (10 pts): <=1% = 10 pts, linear penalty up to 5% = 0 pts (neutral 5 pts if no rev input yet)
      const otScore = mtdRevenue > 0
        ? Math.max(0, Math.min(10, 10 - Math.max(0, otPercentOfRev - 1) * 2.5))
        : (otTotalHours === 0 ? 5 : 2);
      // - Patty Cash Expense vs MTD Revenue (10 pts): <=0.3% = 10 pts, linear penalty up to 1.5% = 0 pts
      const pattyScore = mtdRevenue > 0
        ? Math.max(0, Math.min(10, 10 - Math.max(0, pattyCashPercentOfRev - 0.3) * 8))
        : (pattyCashTotal === 0 ? 5 : 2);
      // - Operational Issue (10 pts): 0 issue = 10 pts, -1.25 pts per issue point
      const issueScore = Math.max(0, 10 - issueTotalPoints * 1.25);
      // - Void Bill Issue (5 pts): 0 void = 5 pts, -0.5 pt per void count
      const voidScore = Math.max(0, 5 - voidCount * 0.5);
      // - SPK3 Review (10 pts): avg daily point / 10
      const spk3Score = Math.min(10, (spk3AvgDailyPoint / 100) * 10);

      const compositeScore = Number((revScore + gsiScore + grScore + otScore + pattyScore + issueScore + voidScore + spk3Score).toFixed(1));
      const grade: 'S' | 'A' | 'B' | 'C' | 'D' =
        compositeScore >= 85 ? 'S' :
        compositeScore >= 75 ? 'A' :
        compositeScore >= 65 ? 'B' :
        compositeScore >= 50 ? 'C' : 'D';

      return {
        outlet: outletName,
        area: getAreaForOutlet(outletName),
        mtdRevenue,
        budgetRevenue,
        revAchievement,
        revVariance,
        gsiScorePercent,
        gsiTotalResponses,
        grRating,
        grTotalReviews,
        otTotalHours,
        otCost,
        otPercentOfRev,
        pattyCashTotal,
        pattyCashBudget,
        pattyCashPercentOfRev,
        issueMistery,
        issueComment,
        issueGoogle,
        issueTotalPoints,
        issueByDay,
        voidCount,
        voidAmount,
        voidPercentOfRev,
        spk3Inspeksi,
        spk3Sos,
        spk3Grooming,
        spk3TotalFindings,
        spk3AvgDailyPoint,
        compositeScore,
        rank: 0,
        grade,
        scoreBreakdown: {
          revScore: Number(revScore.toFixed(1)),
          gsiScore: Number(gsiScore.toFixed(1)),
          grScore: Number(grScore.toFixed(1)),
          otScore: Number(otScore.toFixed(1)),
          pattyScore: Number(pattyScore.toFixed(1)),
          issueScore: Number(issueScore.toFixed(1)),
          voidScore: Number(voidScore.toFixed(1)),
          spk3Score: Number(spk3Score.toFixed(1))
        }
      };
    });

    // Assign ranking strictly sorted by compositeScore descending, then revAchievement descending
    const ranked = [...rawRows].sort(
      (a, b) => b.compositeScore - a.compositeScore || b.revAchievement - a.revAchievement || b.mtdRevenue - a.mtdRevenue
    );
    ranked.forEach((row, i) => {
      row.rank = i + 1;
    });

    return ranked;
  }, [targetOutlets, sourceData, selectedMonth, selectedYear, lastMonthIdx, lastMonthYear, monthKey, lastMonthKey, daysInMonth, effectiveMaxDay]);

  const sortedRows = useMemo(() => {
    const arr = [...reviewRows];
    if (sortBy === 'REVENUE') return arr.sort((a, b) => b.revAchievement - a.revAchievement || b.mtdRevenue - a.mtdRevenue);
    if (sortBy === 'GSI') return arr.sort((a, b) => b.gsiScorePercent - a.gsiScorePercent);
    if (sortBy === 'OUTLET') return arr.sort((a, b) => a.outlet.localeCompare(b.outlet));
    return arr.sort((a, b) => a.rank - b.rank);
  }, [reviewRows, sortBy]);

  const topThree = useMemo(() => [...reviewRows].sort((a, b) => a.rank - b.rank).slice(0, 3), [reviewRows]);

  const handleCopyWa = () => {
    const lines = [
      `*OUTLET REVIEW & RANKING TERBAIK REGIONAL*`,
      `Periode: ${monthName} ${selectedYear}`,
      ``,
      ...reviewRows.map(r => (
        `#${r.rank} *${r.outlet}* (Skor: ${r.compositeScore}/100 • Grade ${r.grade})\n` +
        `  • Rev vs Budget: ${r.revAchievement.toFixed(1)}% (${formatIDR(r.mtdRevenue)})\n` +
        `  • GSI: ${r.gsiScorePercent.toFixed(1)}% | Google Review: ${r.grRating.toFixed(2)}★ (${r.grTotalReviews})\n` +
        `  • OT vs Rev: ${r.otPercentOfRev.toFixed(2)}% | Patty Cash vs Rev: ${r.pattyCashPercentOfRev.toFixed(2)}%\n` +
        `  • Ops Issue: ${r.issueTotalPoints} pt (MG:${r.issueMistery}, GC:${r.issueComment}, GR:${r.issueGoogle}) | Void: ${r.voidCount}x\n` +
        `  • SPK3 Avg Point: ${r.spk3AvgDailyPoint}/100 (${r.spk3TotalFindings} temuan)`
      ))
    ];
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      showToast?.('Outlet Review & Ranking berhasil disalin ke WhatsApp!', 'success');
    }).catch(() => {
      showToast?.('Gagal menyalin ke clipboard.', 'error');
    });
  };

  const handleExportExcel = async () => {
    try {
      const wb = new ExcelJS.Workbook();

      // Sheet 1: Outlet Review & Ranking
      const ws1 = wb.addWorksheet('Outlet Review & Ranking');
      ws1.columns = [
        { header: 'Rank', key: 'rank', width: 8 },
        { header: 'Grade', key: 'grade', width: 8 },
        { header: 'Skor Total (0-100)', key: 'score', width: 18 },
        { header: 'Outlet', key: 'outlet', width: 22 },
        { header: 'Area', key: 'area', width: 18 },
        { header: 'MTD Revenue', key: 'mtdRev', width: 18 },
        { header: 'Budget Revenue', key: 'budgetRev', width: 18 },
        { header: 'Rev Ach (%)', key: 'revAch', width: 14 },
        { header: 'GSI (%)', key: 'gsi', width: 12 },
        { header: 'Google Rating', key: 'grRating', width: 14 },
        { header: 'Google Reviews', key: 'grCount', width: 14 },
        { header: 'Overtime Jam', key: 'otHours', width: 14 },
        { header: 'Overtime Cost', key: 'otCost', width: 16 },
        { header: 'OT vs Rev (%)', key: 'otPct', width: 14 },
        { header: 'Patty Cash Expense', key: 'patty', width: 18 },
        { header: 'Patty Cash vs Rev (%)', key: 'pattyPct', width: 18 },
        { header: 'Ops Issue Mistery Guest', key: 'iMg', width: 18 },
        { header: 'Ops Issue Guest Comment', key: 'iGc', width: 18 },
        { header: 'Ops Issue Google Review', key: 'iGr', width: 18 },
        { header: 'Total Ops Issue (Pt)', key: 'iTot', width: 18 },
        { header: 'Void Bill (Qty)', key: 'vCnt', width: 14 },
        { header: 'Void Bill (Rp)', key: 'vAmt', width: 16 },
        { header: 'SPK3 Inspeksi', key: 'sIns', width: 14 },
        { header: 'SPK3 SOS', key: 'sSos', width: 12 },
        { header: 'SPK3 Grooming', key: 'sGrm', width: 14 },
        { header: 'SPK3 Avg Daily Point', key: 'sAvg', width: 18 }
      ];
      reviewRows.forEach(r => {
        ws1.addRow({
          rank: r.rank,
          grade: r.grade,
          score: r.compositeScore,
          outlet: r.outlet,
          area: r.area,
          mtdRev: r.mtdRevenue,
          budgetRev: r.budgetRevenue,
          revAch: Number(r.revAchievement.toFixed(1)),
          gsi: Number(r.gsiScorePercent.toFixed(1)),
          grRating: Number(r.grRating.toFixed(2)),
          grCount: r.grTotalReviews,
          otHours: r.otTotalHours,
          otCost: r.otCost,
          otPct: Number(r.otPercentOfRev.toFixed(2)),
          patty: r.pattyCashTotal,
          pattyPct: Number(r.pattyCashPercentOfRev.toFixed(2)),
          iMg: r.issueMistery,
          iGc: r.issueComment,
          iGr: r.issueGoogle,
          iTot: r.issueTotalPoints,
          vCnt: r.voidCount,
          vAmt: r.voidAmount,
          sIns: r.spk3Inspeksi,
          sSos: r.spk3Sos,
          sGrm: r.spk3Grooming,
          sAvg: r.spk3AvgDailyPoint
        });
      });

      // Sheet 2: Operational Issue Daily Matrix (per kategori per tanggal)
      const ws2 = wb.addWorksheet('Ops Issue Per Tanggal');
      const dayCols = Array.from({ length: daysInMonth }, (_, i) => ({
        header: `Tgl ${i + 1} (MG/GC/GR)`,
        key: `d${i + 1}`,
        width: 15
      }));
      ws2.columns = [
        { header: 'Outlet', key: 'outlet', width: 22 },
        ...dayCols,
        { header: 'Total MG', key: 'tMg', width: 12 },
        { header: 'Total GC', key: 'tGc', width: 12 },
        { header: 'Total GR', key: 'tGr', width: 12 },
        { header: 'Grand Total Pt', key: 'tAll', width: 14 }
      ];
      reviewRows.forEach(r => {
        const obj: any = {
          outlet: r.outlet,
          tMg: r.issueMistery,
          tGc: r.issueComment,
          tGr: r.issueGoogle,
          tAll: r.issueTotalPoints
        };
        for (let d = 1; d <= daysInMonth; d++) {
          const b = r.issueByDay[d];
          obj[`d${d}`] = b && b.total > 0 ? `${b.mistery}/${b.comment}/${b.google}` : '-';
        }
        ws2.addRow(obj);
      });

      [ws1, ws2].forEach(ws => {
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
      });

      const buf = await wb.xlsx.writeBuffer();
      saveAs(new Blob([buf]), `Outlet_Review_Regional_${monthName}_${selectedYear}.xlsx`);
      showToast?.('Excel Outlet Review & Ranking berhasil diunduh!', 'success');
    } catch (err) {
      console.error(err);
      showToast?.('Gagal mengekspor Excel Outlet Review.', 'error');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header & Top 3 Outlet Ranking Podium */}
      <div className="glass-card p-6 rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900/95 via-indigo-950/25 to-slate-900/95">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500 flex items-center justify-center text-slate-950 shadow-xl">
              <i className="fas fa-trophy text-xl"></i>
            </div>
            <div>
              <h3 className="text-lg md:text-xl font-black uppercase tracking-tight text-white">
                Outlet Review & Ranking Outlet Terbaik Regional
              </h3>
              <p className="text-xs text-slate-400">
                Periode <span className="text-amber-300 font-bold">{monthName} {selectedYear}</span> • Evaluasi Terpadu Revenue, GSI, Google Review, Overtime, Patty Cash, Operational Issue, Void Bill & SPK3
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

        {/* Top 3 Best Outlets Podium */}
        {topThree.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            {topThree.map((item, idx) => {
              const styles = idx === 0
                ? 'from-amber-500/25 via-yellow-500/10 to-slate-900 border-amber-400/50 shadow-amber-500/10'
                : idx === 1
                ? 'from-slate-400/20 via-slate-500/10 to-slate-900 border-slate-300/40'
                : 'from-orange-700/25 via-amber-800/10 to-slate-900 border-orange-500/40';
              const medalColor = idx === 0 ? 'text-amber-300' : idx === 1 ? 'text-slate-200' : 'text-orange-400';

              return (
                <div
                  key={item.outlet}
                  onClick={() => onSelectOutlet?.(item.outlet)}
                  className={`p-4 rounded-2xl border bg-gradient-to-br ${styles} shadow-lg cursor-pointer hover:scale-[1.01] transition-all`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className={`w-9 h-9 rounded-xl bg-slate-950/80 border border-white/15 flex items-center justify-center font-black ${medalColor}`}>
                        <i className="fas fa-medal text-sm"></i>
                      </div>
                      <div>
                        <div className={`text-[10px] font-black uppercase tracking-widest ${medalColor}`}>
                          Rank #{item.rank} • Outlet Terbaik
                        </div>
                        <div className="text-sm font-black text-white">{item.outlet}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-black text-white">{item.compositeScore}</div>
                      <div className="text-[10px] font-black uppercase text-emerald-300">Grade {item.grade}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 mt-3 pt-3 border-t border-white/10 text-[10px]">
                    <div>
                      <div className="text-slate-400">Rev Ach</div>
                      <div className="font-black text-emerald-300">{item.revAchievement.toFixed(1)}%</div>
                    </div>
                    <div>
                      <div className="text-slate-400">GSI / GR</div>
                      <div className="font-black text-sky-300">{item.gsiScorePercent.toFixed(0)}% / {item.grRating.toFixed(1)}★</div>
                    </div>
                    <div>
                      <div className="text-slate-400">Ops Issue</div>
                      <div className="font-black text-amber-300">{item.issueTotalPoints} Pt</div>
                    </div>
                    <div>
                      <div className="text-slate-400">SPK3 Avg</div>
                      <div className="font-black text-purple-300">{item.spk3AvgDailyPoint}/100</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Controls Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-slate-900/60 p-4 rounded-2xl border border-white/10">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'OUTLET_REVIEW_TABLE', label: 'Tabel Outlet Review & Ranking', icon: 'fa-table' },
            { id: 'ISSUE_DAILY_MATRIX', label: 'Operational Issue Per Tanggal (1-31)', icon: 'fa-calendar-days' },
            { id: 'RANKING_WEIGHTS', label: 'Rincian Skor & Bobot Ranking', icon: 'fa-calculator' }
          ].map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setViewMode(t.id as any)}
              className={`px-3.5 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider flex items-center gap-2 cursor-pointer transition-all ${
                viewMode === t.id
                  ? 'bg-amber-500 text-slate-950 shadow-lg'
                  : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <i className={`fas ${t.icon}`}></i>
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-slate-950 border border-white/15 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none"
          >
            <option value="RANK">Urutkan: Ranking Terbaik</option>
            <option value="REVENUE">Urutkan: Revenue vs Budget</option>
            <option value="GSI">Urutkan: Achievement GSI</option>
            <option value="OUTLET">Urutkan: Nama Outlet (A-Z)</option>
          </select>

          <input
            type="text"
            value={searchOutlet}
            onChange={(e) => setSearchOutlet(e.target.value)}
            placeholder="Filter outlet / area..."
            className="bg-slate-950 border border-white/15 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 outline-none w-44"
          />
        </div>
      </div>

      {/* VIEW 1: COMPREHENSIVE OUTLET REVIEW TABLE */}
      {viewMode === 'OUTLET_REVIEW_TABLE' && (
        <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/75 shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-left border-collapse">
              <thead className="bg-slate-950 text-slate-300 text-[10px] uppercase font-black">
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-950 px-3 py-3 border-b border-r border-white/10 text-center">Rank</th>
                  <th className="sticky left-[52px] z-20 bg-slate-950 px-4 py-3 border-b border-r border-white/10 min-w-[150px]">Outlet</th>
                  <th className="px-3 py-3 border-b border-white/10 text-right min-w-[160px] text-emerald-300">Revenue Vs Budget</th>
                  <th className="px-3 py-3 border-b border-white/10 text-center min-w-[110px] text-sky-300">Achievement GSI</th>
                  <th className="px-3 py-3 border-b border-white/10 text-center min-w-[125px] text-amber-300">Achievement Google Review</th>
                  <th className="px-3 py-3 border-b border-white/10 text-right min-w-[140px] text-indigo-300">Overtime vs MTD Rev</th>
                  <th className="px-3 py-3 border-b border-white/10 text-right min-w-[145px] text-orange-300">Patty Cash vs MTD Rev</th>
                  <th className="px-3 py-3 border-b border-white/10 text-center min-w-[180px] text-rose-300">Operational Issue (MG / GC / GR)</th>
                  <th className="px-3 py-3 border-b border-white/10 text-right min-w-[125px] text-pink-300">Void Bill Issue</th>
                  <th className="px-3 py-3 border-b border-white/10 text-center min-w-[165px] text-purple-300">SPK3 Review</th>
                  <th className="px-3 py-3 border-b border-white/10 text-center min-w-[105px] text-amber-300">Total Skor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {sortedRows.map(r => (
                  <tr key={r.outlet} className="hover:bg-white/[0.03] transition-colors">
                    <td className="sticky left-0 z-10 bg-slate-900 px-3 py-3 border-r border-white/10 text-center">
                      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-xl font-black text-xs ${
                        r.rank === 1
                          ? 'bg-amber-400 text-slate-950'
                          : r.rank === 2
                          ? 'bg-slate-200 text-slate-950'
                          : r.rank === 3
                          ? 'bg-orange-500 text-white'
                          : 'bg-slate-800 text-slate-300'
                      }`}>
                        #{r.rank}
                      </span>
                    </td>
                    <td
                      onClick={() => onSelectOutlet?.(r.outlet)}
                      className="sticky left-[52px] z-10 bg-slate-900 px-4 py-3 border-r border-white/10 cursor-pointer hover:text-amber-300"
                    >
                      <div className="font-black text-white text-xs">{r.outlet}</div>
                      <div className="text-[10px] text-slate-400">{r.area}</div>
                    </td>

                    {/* 1. Revenue vs Budget */}
                    <td className="px-3 py-3 text-right">
                      <div className="font-black text-white">{formatIDR(r.mtdRevenue)}</div>
                      <div className="text-[10px] text-slate-400">Bgt: {formatIDR(r.budgetRevenue)}</div>
                      <div className={`text-[10px] font-black ${r.revAchievement >= 100 ? 'text-emerald-400' : r.revAchievement >= 85 ? 'text-amber-300' : 'text-rose-400'}`}>
                        Ach: {r.revAchievement.toFixed(1)}%
                      </div>
                    </td>

                    {/* 2. Achievement GSI */}
                    <td className="px-3 py-3 text-center">
                      <div className={`text-sm font-black ${r.gsiScorePercent >= 85 ? 'text-emerald-300' : r.gsiScorePercent >= 70 ? 'text-amber-300' : 'text-rose-300'}`}>
                        {r.gsiScorePercent.toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-slate-400">{r.gsiTotalResponses} Respon</div>
                    </td>

                    {/* 3. Achievement Google Review */}
                    <td className="px-3 py-3 text-center">
                      <div className="text-sm font-black text-amber-300">
                        {r.grRating > 0 ? `${r.grRating.toFixed(2)} ★` : '-'}
                      </div>
                      <div className="text-[10px] text-slate-400">{r.grTotalReviews} Review</div>
                    </td>

                    {/* 4. Overtime Review vs MTD Revenue */}
                    <td className="px-3 py-3 text-right">
                      <div className="font-black text-white">{formatIDR(r.otCost)}</div>
                      <div className="text-[10px] text-slate-400">{r.otTotalHours.toFixed(1)} Jam</div>
                      <div className={`text-[10px] font-black ${r.otPercentOfRev <= 1.5 ? 'text-emerald-400' : r.otPercentOfRev <= 3 ? 'text-amber-300' : 'text-rose-400'}`}>
                        {r.otPercentOfRev.toFixed(2)}% vs Rev
                      </div>
                    </td>

                    {/* 5. Patty Cash Expense vs MTD Revenue */}
                    <td className="px-3 py-3 text-right">
                      <div className="font-black text-white">{formatIDR(r.pattyCashTotal)}</div>
                      <div className="text-[10px] text-slate-400">Bgt: {formatIDR(r.pattyCashBudget)}</div>
                      <div className={`text-[10px] font-black ${r.pattyCashPercentOfRev <= 0.3 ? 'text-emerald-400' : r.pattyCashPercentOfRev <= 0.6 ? 'text-amber-300' : 'text-rose-400'}`}>
                        {r.pattyCashPercentOfRev.toFixed(2)}% vs Rev
                      </div>
                    </td>

                    {/* 6. Operational Issue (Point tiap kategori + link ke matriks harian) */}
                    <td
                      onClick={() => setViewMode('ISSUE_DAILY_MATRIX')}
                      title="Klik untuk lihat point per tanggal bulan ini"
                      className="px-3 py-3 text-center cursor-pointer hover:bg-white/[0.04]"
                    >
                      <div className="flex items-center justify-center gap-1 flex-wrap">
                        <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-200 font-black text-[10px]" title="Issue Mistery Guest">
                          MG: {r.issueMistery}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 font-black text-[10px]" title="Guest Comment">
                          GC: {r.issueComment}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-200 font-black text-[10px]" title="Google Review">
                          GR: {r.issueGoogle}
                        </span>
                      </div>
                      <div className="text-[10px] font-bold text-slate-300 mt-1">
                        Total: <b className={r.issueTotalPoints > 0 ? 'text-rose-300' : 'text-emerald-300'}>{r.issueTotalPoints} Pt</b>
                      </div>
                    </td>

                    {/* 7. Void Bill Issue */}
                    <td className="px-3 py-3 text-right">
                      <div className={`font-black ${r.voidCount > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                        {r.voidCount} Kali
                      </div>
                      <div className="text-[10px] text-slate-300">{formatIDR(r.voidAmount)}</div>
                      <div className="text-[10px] text-slate-400">{r.voidPercentOfRev.toFixed(2)}% vs Rev</div>
                    </td>

                    {/* 8. SPK3 Review */}
                    <td className="px-3 py-3 text-center">
                      <div className={`text-sm font-black ${r.spk3AvgDailyPoint >= 90 ? 'text-emerald-300' : r.spk3AvgDailyPoint >= 75 ? 'text-amber-300' : 'text-rose-400'}`}>
                        {r.spk3AvgDailyPoint} / 100
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Ins:{r.spk3Inspeksi} • SOS:{r.spk3Sos} • Grm:{r.spk3Grooming}
                      </div>
                    </td>

                    {/* 9. Composite Score & Grade */}
                    <td className="px-3 py-3 text-center">
                      <div className="text-sm font-black text-white">{r.compositeScore}</div>
                      <span className={`inline-block px-2 py-0.5 rounded-lg text-[10px] font-black mt-0.5 ${
                        r.grade === 'S'
                          ? 'bg-emerald-500/25 text-emerald-300'
                          : r.grade === 'A'
                          ? 'bg-sky-500/25 text-sky-300'
                          : r.grade === 'B'
                          ? 'bg-amber-500/25 text-amber-300'
                          : 'bg-rose-500/25 text-rose-300'
                      }`}>
                        Grade {r.grade}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 2: OPERATIONAL ISSUE PER TANGGAL DI PERIODE BULAN TERSEBUT */}
      {viewMode === 'ISSUE_DAILY_MATRIX' && (
        <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/75 shadow-2xl">
          <div className="px-5 py-4 border-b border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-black uppercase tracking-widest text-rose-300 flex items-center gap-2">
                <i className="fas fa-calendar-check"></i>
                Operational Issue — Point Setiap Kategori & Tanggal ({monthName} {selectedYear})
              </h4>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Menampilkan rincian point Issue Mistery Guest (MG), Guest Comment (GC), & Google Review (GR) per tanggal 1–{daysInMonth}. Klik sel tanggal untuk detail temuan.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={matrixCategoryFilter}
                onChange={(e) => setMatrixCategoryFilter(e.target.value as any)}
                className="bg-slate-950 border border-white/15 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none"
              >
                <option value="BREAKDOWN">Tampilkan Rincian 3 Kategori (MG / GC / GR)</option>
                <option value="ALL">Total Gabungan Semua Kategori</option>
                {ISSUE_CATEGORIES.map(c => (
                  <option key={c} value={c}>Khusus: {c}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead className="bg-slate-950 text-slate-400 font-black uppercase">
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-950 px-3 py-3 text-left min-w-[155px] border-b border-r border-white/10">
                    Outlet (Rank)
                  </th>
                  {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => (
                    <th key={d} className="px-2 py-3 text-center min-w-[54px] border-b border-white/10">
                      {d}
                    </th>
                  ))}
                  <th className="px-3 py-3 text-center border-b border-l border-white/10 text-purple-300">MG</th>
                  <th className="px-3 py-3 text-center border-b border-white/10 text-amber-300">GC</th>
                  <th className="px-3 py-3 text-center border-b border-white/10 text-sky-300">GR</th>
                  <th className="px-3 py-3 text-center border-b border-white/10 text-rose-300">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {sortedRows.map(row => (
                  <tr key={row.outlet} className="hover:bg-white/[0.02]">
                    <td className="sticky left-0 z-10 bg-slate-900 px-3 py-2.5 font-black text-white border-r border-white/10 whitespace-nowrap">
                      <span className="text-amber-300 mr-1.5">#{row.rank}</span>
                      {row.outlet}
                    </td>
                    {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => {
                      const b = row.issueByDay[d] || { mistery: 0, comment: 0, google: 0, total: 0, items: [] };
                      let displayVal = 0;
                      if (matrixCategoryFilter === 'Issue Mistery Guest') displayVal = b.mistery;
                      else if (matrixCategoryFilter === 'Guest Comment') displayVal = b.comment;
                      else if (matrixCategoryFilter === 'Google Review') displayVal = b.google;
                      else displayVal = b.total;

                      const dStr = `${monthKey}-${String(d).padStart(2, '0')}`;
                      return (
                        <td
                          key={d}
                          onClick={() => {
                            if (b.total > 0) {
                              setCellDetailModal({ outlet: row.outlet, dateStr: dStr, bucket: b });
                            }
                          }}
                          title={`Tgl ${d}: Mistery Guest=${b.mistery}, Guest Comment=${b.comment}, Google Review=${b.google}`}
                          className={`px-1.5 py-2 text-center border-r border-white/5 ${
                            displayVal > 0
                              ? 'bg-rose-500/15 hover:bg-rose-500/30 cursor-pointer'
                              : 'text-slate-700'
                          }`}
                        >
                          {matrixCategoryFilter === 'BREAKDOWN' ? (
                            b.total > 0 ? (
                              <div className="flex flex-col items-center leading-tight gap-0.5">
                                {b.mistery > 0 && <span className="text-[9px] font-black text-purple-300">MG:{b.mistery}</span>}
                                {b.comment > 0 && <span className="text-[9px] font-black text-amber-300">GC:{b.comment}</span>}
                                {b.google > 0 && <span className="text-[9px] font-black text-sky-300">GR:{b.google}</span>}
                              </div>
                            ) : '-'
                          ) : (
                            displayVal > 0 ? <span className="font-black text-rose-200">{displayVal}</span> : '-'
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2.5 text-center font-black text-purple-300 border-l border-white/10 bg-slate-950/50">{row.issueMistery}</td>
                    <td className="px-3 py-2.5 text-center font-black text-amber-300 bg-slate-950/50">{row.issueComment}</td>
                    <td className="px-3 py-2.5 text-center font-black text-sky-300 bg-slate-950/50">{row.issueGoogle}</td>
                    <td className="px-3 py-2.5 text-center font-black text-rose-300 bg-slate-950/70">{row.issueTotalPoints}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 3: RANKING SCORE BREAKDOWN */}
      {viewMode === 'RANKING_WEIGHTS' && (
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-slate-900/70 border border-white/10 text-xs text-slate-300">
            <div className="font-black uppercase text-amber-300 mb-2">Formula Bobot Ranking Outlet Terbaik (Maksimal 100 Poin):</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div className="p-2.5 rounded-xl bg-slate-950/70 border border-white/5"><b className="text-emerald-300">25 Pt</b> — Revenue vs Budget</div>
              <div className="p-2.5 rounded-xl bg-slate-950/70 border border-white/5"><b className="text-sky-300">15 Pt</b> — Achievement GSI</div>
              <div className="p-2.5 rounded-xl bg-slate-950/70 border border-white/5"><b className="text-amber-300">15 Pt</b> — Google Review</div>
              <div className="p-2.5 rounded-xl bg-slate-950/70 border border-white/5"><b className="text-indigo-300">10 Pt</b> — Overtime vs Rev</div>
              <div className="p-2.5 rounded-xl bg-slate-950/70 border border-white/5"><b className="text-orange-300">10 Pt</b> — Patty Cash vs Rev</div>
              <div className="p-2.5 rounded-xl bg-slate-950/70 border border-white/5"><b className="text-rose-300">10 Pt</b> — Operational Issue</div>
              <div className="p-2.5 rounded-xl bg-slate-950/70 border border-white/5"><b className="text-purple-300">10 Pt</b> — SPK3 Review</div>
              <div className="p-2.5 rounded-xl bg-slate-950/70 border border-white/5"><b className="text-pink-300">5 Pt</b> — Void Bill Issue</div>
            </div>
          </div>

          <div className="glass-card rounded-3xl border border-white/10 overflow-hidden bg-slate-900/75">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-950 text-slate-400 text-[10px] uppercase font-black">
                  <tr>
                    <th className="px-4 py-3 text-center">Rank</th>
                    <th className="px-4 py-3">Outlet</th>
                    <th className="px-3 py-3 text-center">Rev (25)</th>
                    <th className="px-3 py-3 text-center">GSI (15)</th>
                    <th className="px-3 py-3 text-center">GR (15)</th>
                    <th className="px-3 py-3 text-center">OT (10)</th>
                    <th className="px-3 py-3 text-center">Patty (10)</th>
                    <th className="px-3 py-3 text-center">Issue (10)</th>
                    <th className="px-3 py-3 text-center">SPK3 (10)</th>
                    <th className="px-3 py-3 text-center">Void (5)</th>
                    <th className="px-4 py-3 text-center text-amber-300">Total Skor</th>
                    <th className="px-4 py-3 text-center">Grade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {sortedRows.map(r => (
                    <tr key={r.outlet} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-3 text-center font-black text-amber-300">#{r.rank}</td>
                      <td className="px-4 py-3 font-black text-white">{r.outlet}</td>
                      <td className="px-3 py-3 text-center text-emerald-300 font-bold">{r.scoreBreakdown.revScore}</td>
                      <td className="px-3 py-3 text-center text-sky-300 font-bold">{r.scoreBreakdown.gsiScore}</td>
                      <td className="px-3 py-3 text-center text-amber-300 font-bold">{r.scoreBreakdown.grScore}</td>
                      <td className="px-3 py-3 text-center text-indigo-300 font-bold">{r.scoreBreakdown.otScore}</td>
                      <td className="px-3 py-3 text-center text-orange-300 font-bold">{r.scoreBreakdown.pattyScore}</td>
                      <td className="px-3 py-3 text-center text-rose-300 font-bold">{r.scoreBreakdown.issueScore}</td>
                      <td className="px-3 py-3 text-center text-purple-300 font-bold">{r.scoreBreakdown.spk3Score}</td>
                      <td className="px-3 py-3 text-center text-pink-300 font-bold">{r.scoreBreakdown.voidScore}</td>
                      <td className="px-4 py-3 text-center font-black text-white text-sm">{r.compositeScore}</td>
                      <td className="px-4 py-3 text-center font-black text-emerald-300">{r.grade}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Cell Detail Modal */}
      {cellDetailModal && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-white/15 rounded-3xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div>
                <h4 className="text-sm font-black uppercase text-white">
                  Operational Issue — {cellDetailModal.outlet}
                </h4>
                <p className="text-xs text-amber-300 font-bold">
                  Tanggal {cellDetailModal.dateStr} • MG: {cellDetailModal.bucket.mistery} | GC: {cellDetailModal.bucket.comment} | GR: {cellDetailModal.bucket.google}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCellDetailModal(null)}
                className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 flex items-center justify-center cursor-pointer"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="space-y-3">
              {cellDetailModal.bucket.items.map(it => (
                <div key={it.id} className="p-4 rounded-2xl bg-slate-950/80 border border-white/10 space-y-1.5 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="font-black text-amber-300 uppercase">{it.category}</span>
                    <span className="text-slate-400">Area: <b className="text-white">{it.area}</b> • PIC: <b className="text-white">{it.pic}</b></span>
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

export default RegionalOutletReviewTable;
