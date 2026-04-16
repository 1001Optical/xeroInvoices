import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {string} */
const STATE_PATH =
  process.env.GMAIL_HISTORY_STATE_PATH ||
  path.join(__dirname, '../../data/gmail-history-state.json');

const MAX_MESSAGE_IDS = Number(process.env.GMAIL_MAX_STORED_MESSAGE_IDS || 3000);
const MAX_INVOICE_KEYS = Number(process.env.GMAIL_MAX_STORED_INVOICE_KEYS || 10000);

/**
 * @typedef {{
 *   lastHistoryId?: string,
 *   processedMessageIds?: string[],
 *   processedInvoiceKeys?: string[]
 * }} MailboxState
 */

/**
 * @returns {Promise<Record<string, MailboxState>>}
 */
export async function loadHistoryState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveHistoryState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export async function getLastHistoryId(userEmail) {
  const s = await loadHistoryState();
  return s[userEmail]?.lastHistoryId ?? null;
}

/**
 * historyId 는 이번 배치의 모든 메일 처리가 성공한 뒤에만 호출할 것
 */
export async function setLastHistoryId(userEmail, historyId) {
  const s = await loadHistoryState();
  s[userEmail] = { ...(s[userEmail] || {}), lastHistoryId: String(historyId) };
  await saveHistoryState(s);
}

export async function hasProcessedMessageId(userEmail, messageId) {
  const s = await loadHistoryState();
  const list = s[userEmail]?.processedMessageIds || [];
  return list.includes(String(messageId));
}

function trimIdList(arr, max) {
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

/** 메일 단위 처리 완전 성공 후에만 호출 */
export async function addProcessedMessageId(userEmail, messageId) {
  const s = await loadHistoryState();
  const cur = s[userEmail] || {};
  const list = [...(cur.processedMessageIds || [])];
  const id = String(messageId);
  if (!list.includes(id)) list.push(id);
  cur.processedMessageIds = trimIdList(list, MAX_MESSAGE_IDS);
  s[userEmail] = cur;
  await saveHistoryState(s);
}

/** IN12345|15/04/2026 형태 — 날짜는 normalizeInvoiceDate 로 정규화 */
export function makeInvoiceKey(referenceNumber, invoiceDate) {
  const ref = String(referenceNumber || '').trim().toUpperCase();
  const d = normalizeInvoiceDate(invoiceDate);
  return `${ref}|${d}`;
}

export function normalizeInvoiceDate(dateStr) {
  if (dateStr == null) return '';
  return String(dateStr)
    .trim()
    .replace(/\s+/g, '')
    .replace(/\\/g, '/')
    .replace(/-/g, '/')
    .toLowerCase();
}

export async function hasProcessedInvoiceKey(userEmail, key) {
  const s = await loadHistoryState();
  const list = s[userEmail]?.processedInvoiceKeys || [];
  return list.includes(key);
}

/** 인보이스(페이지) 단위로 최초 처리 확정 시 호출 */
export async function addProcessedInvoiceKey(userEmail, key) {
  const s = await loadHistoryState();
  const cur = s[userEmail] || {};
  const list = [...(cur.processedInvoiceKeys || [])];
  if (!list.includes(key)) list.push(key);
  cur.processedInvoiceKeys = trimIdList(list, MAX_INVOICE_KEYS);
  s[userEmail] = cur;
  await saveHistoryState(s);
}
