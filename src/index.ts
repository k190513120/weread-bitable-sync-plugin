import $ from 'jquery';
import { bitable } from '@lark-base-open/js-sdk';
import QRCode from 'qrcode';
import './index.scss';
import {
  getWereadSyncResult,
  normalizeWereadBooks,
  normalizeWereadHighlights,
  startWereadSync
} from './weread-api';
import {
  prepareWereadBookTable,
  prepareWereadNoteTable,
  prepareWereadTable,
  WereadBookRecord,
  WereadNoteRecord,
  writeWereadBookRecords,
  writeWereadNoteRecords,
  writeWereadHighlights
} from './weread-table-operations';

const LOCAL_SYNC_BASE_URL = (import.meta.env.VITE_SYNC_BASE_URL as string) || 'http://localhost:8787';

$(function () {
  initializeApp();
});

function initializeApp() {
  setDefaultConfig();
  bindEvents();
}

function setDefaultConfig() {
  $('#maxRecords').val('200');
  $('#tableName').val('微信读书笔记');
}

function bindEvents() {
  $('#startSync').on('click', handleStartSync);
  $('#alipayQRClose').on('click', () => {
    alipayPollingActive = false;
    $('#alipayQRModal').hide();
  });
}

function getPaymentMethod(): string {
  const lang = (navigator.language || '').toLowerCase();
  if (lang.startsWith('zh')) return 'alipay';
  return 'stripe';
}

let alipayPollingActive = false;

function getTableName(): string {
  return String($('#tableName').val() || '').trim();
}

function getWereadCookie(): string {
  return String($('#wereadCookie').val() || '').trim();
}

async function getCurrentUserId(): Promise<string> {
  try {
    const userId = await bitable.bridge.getBaseUserId();
    if (userId) return String(userId);
  } catch (_) {}
  try {
    const userId = await bitable.bridge.getUserId();
    if (userId) return String(userId);
  } catch (_) {}
  const host = String(window.location.hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
    return 'local_debug_user';
  }
  throw new Error('无法获取当前登录用户信息，请在多维表格内打开插件后重试');
}

function getMaxRecords(): number {
  const raw = Number($('#maxRecords').val());
  if (!Number.isFinite(raw)) return 200;
  return Math.max(1, Math.min(2000, Math.floor(raw)));
}

function toBookRecords(
  highlights: ReturnType<typeof normalizeWereadHighlights>,
  books: ReturnType<typeof normalizeWereadBooks>
): WereadBookRecord[] {
  const map = new Map<string, WereadBookRecord>();
  for (const book of books) {
    const key = book.bookId || book.bookTitle;
    if (!key) continue;
    map.set(key, {
      bookId: book.bookId,
      bookTitle: book.bookTitle,
      author: book.author,
      cover: book.cover,
      price: book.price,
      publishTime: book.publishTime,
      tags: book.tags || book.categoryTitles,
      chapter: '',
      latestHighlightText: '',
      latestNoteText: '',
      latestHighlightId: '',
      highlightCount: 0,
      noteCount: 0,
      earliestHighlightedAt: undefined,
      earliestUpdatedAt: book.publishTime,
      latestHighlightedAt: undefined,
      latestUpdatedAt: book.updateTime,
      rawMetaJson: book.rawMetaJson
    });
  }
  for (const item of highlights) {
    const key = item.bookId || item.bookTitle;
    if (!key) continue;
    const existing = map.get(key);
    const noteIncrement = item.noteText ? 1 : 0;
    const eventTime = item.updatedAt || item.highlightedAt || 0;
    if (!existing) {
      map.set(key, {
        bookId: item.bookId,
        bookTitle: item.bookTitle,
        author: item.author,
        cover: '',
        price: undefined,
        publishTime: undefined,
        tags: item.tags,
        chapter: item.chapter,
        latestHighlightText: item.highlightText,
        latestNoteText: item.noteText,
        latestHighlightId: item.highlightId,
        highlightCount: 1,
        noteCount: noteIncrement,
        earliestHighlightedAt: item.highlightedAt,
        earliestUpdatedAt: item.updatedAt,
        latestHighlightedAt: item.highlightedAt,
        latestUpdatedAt: item.updatedAt,
        rawMetaJson: ''
      });
      continue;
    }
    existing.highlightCount += 1;
    existing.noteCount += noteIncrement;
    if (!existing.bookTitle && item.bookTitle) existing.bookTitle = item.bookTitle;
    if (!existing.author && item.author) existing.author = item.author;
    if (!existing.tags && item.tags) existing.tags = item.tags;
    if ((item.highlightedAt || Number.MAX_SAFE_INTEGER) < (existing.earliestHighlightedAt || Number.MAX_SAFE_INTEGER)) {
      existing.earliestHighlightedAt = item.highlightedAt;
    }
    if ((item.updatedAt || Number.MAX_SAFE_INTEGER) < (existing.earliestUpdatedAt || Number.MAX_SAFE_INTEGER)) {
      existing.earliestUpdatedAt = item.updatedAt;
    }
    if ((item.highlightedAt || 0) > (existing.latestHighlightedAt || 0)) {
      existing.latestHighlightedAt = item.highlightedAt;
    }
    if ((item.updatedAt || 0) > (existing.latestUpdatedAt || 0)) {
      existing.latestUpdatedAt = item.updatedAt;
    }
    const existingEventTime = existing.latestUpdatedAt || existing.latestHighlightedAt || 0;
    if (eventTime >= existingEventTime) {
      existing.chapter = item.chapter;
      existing.latestHighlightText = item.highlightText;
      existing.latestNoteText = item.noteText;
      existing.latestHighlightId = item.highlightId;
    }
    if (!existing.rawMetaJson) {
      existing.rawMetaJson = '';
    }
  }
  return [...map.values()].sort((a, b) => b.highlightCount - a.highlightCount);
}

function toNoteRecords(highlights: ReturnType<typeof normalizeWereadHighlights>): WereadNoteRecord[] {
  return highlights
    .filter((item) => Boolean(item.noteText))
    .map((item) => ({
      noteId: item.highlightId || `${item.bookId}-${item.updatedAt || item.highlightedAt || Date.now()}`,
      bookId: item.bookId,
      bookTitle: item.bookTitle,
      author: item.author,
      chapter: item.chapter,
      highlightId: item.highlightId,
      highlightText: item.highlightText,
      noteText: item.noteText,
      tags: item.tags,
      highlightedAt: item.highlightedAt,
      updatedAt: item.updatedAt
    }));
}

async function handleStartSync() {
  const tableName = getTableName();
  const wereadCookie = getWereadCookie();
  const maxRecords = getMaxRecords();

  if (!wereadCookie) {
    showResult('请先粘贴微信读书 Cookie', 'error');
    return;
  }

  try {
    const userId = await getCurrentUserId();
    const paymentMethod = getPaymentMethod();
    setSyncLoading(true);
    updateProgress(10, '正在提交同步任务');
    const startResult = await startWereadSync(LOCAL_SYNC_BASE_URL, undefined, undefined, wereadCookie, maxRecords, userId, paymentMethod);
    if (startResult.status === 'payment_required') {
      if (paymentMethod === 'alipay' && startResult.qrCode && startResult.outTradeNo) {
        setSyncLoading(false);
        await showAlipayQRModal(startResult.qrCode, startResult.outTradeNo);
        return;
      }
      const checkoutUrl = String(startResult.checkoutUrl || '');
      if (checkoutUrl) {
        const opened = openCheckoutInNewTab(checkoutUrl);
        if (!opened) {
          const safeUrl = escapeHtml(checkoutUrl);
          showResult(`免费 3 本书额度已用完，请点击前往支付：<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">打开支付页面</a>`, 'info', true);
          return;
        }
        showResult('免费 3 本书额度已用完，已在新窗口打开支付页面', 'info');
        return;
      }
      throw new Error(startResult.message || '免费 3 本书额度已用完，请先支付后继续');
    }
    const syncData = await waitForSyncData(LOCAL_SYNC_BASE_URL, startResult);
    const highlights = normalizeWereadHighlights(syncData.highlights);
    const booksMeta = normalizeWereadBooks(syncData.books);

    if (!highlights.length) {
      throw new Error('未获取到可写入的划线或笔记');
    }
    const books = toBookRecords(highlights, booksMeta);
    const notes = toNoteRecords(highlights);

    updateProgress(60, '正在准备划线数据表');
    const highlightTable = await prepareWereadTable(tableName, (progress, message) => {
      updateProgress(60 + progress * 0.08, message);
    });

    updateProgress(68, '正在准备书籍数据表');
    const bookTableName = `${tableName || '微信读书笔记'}-书籍`;
    const bookTable = await prepareWereadBookTable(bookTableName, (progress, message) => {
      updateProgress(68 + progress * 0.08, message);
    });

    updateProgress(76, '正在准备笔记数据表');
    const noteTableName = `${tableName || '微信读书笔记'}-笔记`;
    const noteTable = await prepareWereadNoteTable(noteTableName, (progress, message) => {
      updateProgress(76 + progress * 0.08, message);
    });

    updateProgress(84, '正在写入划线记录');
    await writeWereadHighlights(highlightTable, highlights, (progress, message) => {
      updateProgress(84 + progress * 0.08, message);
    });

    updateProgress(92, '正在写入书籍记录');
    await writeWereadBookRecords(bookTable, books, (progress, message) => {
      updateProgress(92 + progress * 0.04, message);
    });

    updateProgress(96, '正在写入笔记记录');
    await writeWereadNoteRecords(noteTable, notes, (progress, message) => {
      updateProgress(96 + progress * 0.04, message);
    });

    updateProgress(100, '同步完成');
    const syncMsg = `同步完成，已写入 ${highlights.length} 条划线记录、${notes.length} 条笔记记录和 ${books.length} 条书籍记录。`;
    const freeQuota = (startResult as Record<string, unknown>).freeQuota as { total: number; used: number; remaining: number } | undefined;
    const isPaid = (startResult as Record<string, unknown>).paid === true;
    if (!isPaid && freeQuota) {
      if (freeQuota.remaining > 0) {
        showResult(
          `${syncMsg}<br><br>` +
          `<span style="color:var(--text-secondary)">当前为免费版，已用 ${freeQuota.used}/${freeQuota.total} 本书额度（剩余 ${freeQuota.remaining} 本）。` +
          `升级付费版可解锁无限同步，仅需 <b>99 元/年</b>。</span>`,
          'success', true
        );
      } else {
        showResult(
          `${syncMsg}<br><br>` +
          `<span style="color:var(--orange)">免费额度已用完，下次同步需付费。升级仅需 <b>99 元/年</b>，可同步无限量书籍。</span>`,
          'success', true
        );
      }
    } else {
      showResult(syncMsg, 'success');
    }
  } catch (error) {
    showResult(`同步失败：${(error as Error).message}`, 'error');
  } finally {
    setSyncLoading(false);
  }
}

async function waitForSyncData(
  serviceUrl: string,
  startResult: { status?: string; jobId?: string; highlights?: unknown[]; books?: unknown[] }
): Promise<{ highlights: unknown[]; books: unknown[] }> {
  if (Array.isArray(startResult.highlights)) {
    return {
      highlights: startResult.highlights,
      books: Array.isArray(startResult.books) ? startResult.books : []
    };
  }
  if (!startResult.jobId) {
    throw new Error('同步服务未返回可用数据或任务 ID');
  }

  const maxRetry = 45;
  for (let i = 0; i < maxRetry; i += 1) {
    const pollProgress = 15 + ((i + 1) / maxRetry) * 40;
    updateProgress(pollProgress, `服务端同步中（${i + 1}/${maxRetry}）`);
    await wait(2000);
    const result = await getWereadSyncResult(serviceUrl, startResult.jobId);
    if (result.status === 'completed' && Array.isArray(result.highlights)) {
      return {
        highlights: result.highlights,
        books: Array.isArray(result.books) ? result.books : []
      };
    }
  }
  throw new Error('同步超时，请稍后重试');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(), ms);
  });
}

async function showAlipayQRModal(qrCodeUrl: string, outTradeNo: string): Promise<void> {
  const dataUrl = await QRCode.toDataURL(qrCodeUrl, { width: 256, margin: 2 });
  const modal = $('#alipayQRModal');
  $('#alipayQRImage').attr('src', dataUrl);
  modal.show();
  alipayPollingActive = true;

  let paid = false;
  const maxPolls = 120;
  for (let i = 0; i < maxPolls && alipayPollingActive; i++) {
    await wait(3000);
    if (!alipayPollingActive) break;
    try {
      const resp = await fetch(
        `${LOCAL_SYNC_BASE_URL}/api/alipay/trade/query?outTradeNo=${encodeURIComponent(outTradeNo)}`
      );
      const data = await resp.json() as { paid?: boolean };
      if (data.paid) {
        paid = true;
        break;
      }
    } catch (_) {}
  }

  alipayPollingActive = false;
  modal.hide();

  if (paid) {
    showResult('支付成功！请重新点击「确认并同步」按钮开始同步。', 'success');
  } else {
    showResult('支付已取消或超时，请重试。', 'info');
  }
}

function openCheckoutInNewTab(checkoutUrl: string): boolean {
  try {
    const nextWindow = window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
    return Boolean(nextWindow);
  } catch (_) {
    return false;
  }
}

function setSyncLoading(loading: boolean) {
  const button = $('#startSync');
  const text = $('#syncBtnText');
  const spinner = $('#syncLoadingSpinner');
  button.prop('disabled', loading);
  text.text(loading ? '同步中...' : '确认并同步');
  if (loading) spinner.show();
  else spinner.hide();
}

function updateProgress(progress: number, message: string) {
  const safeProgress = Math.max(0, Math.min(100, progress));
  $('#syncProgressContainer').show();
  $('#syncProgressBar').css('width', `${safeProgress}%`);
  $('#syncProgressText').text(message);
  $('#syncProgressValue').text(`${Math.round(safeProgress)}%`);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showResult(message: string, type: 'success' | 'error' | 'info', rawHtml = false) {
  const messageEl = $('#resultMessage');
  const content = rawHtml ? message : escapeHtml(message).replace(/\n/g, '<br>');
  messageEl.removeClass('success error info').addClass(type).html(content);
  $('#resultContainer').show();
}
