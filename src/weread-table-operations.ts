import { bitable, FieldType, ITable } from '@lark-base-open/js-sdk';
import { WereadHighlight } from './weread-api';

type ProgressHandler = (progress: number, message: string) => void;

const DEFAULT_HIGHLIGHT_TABLE_NAME = '微信读书划线同步';
const DEFAULT_BOOK_TABLE_NAME = '微信读书书籍';
const DEFAULT_NOTE_TABLE_NAME = '微信读书笔记';

const HIGHLIGHT_FIELDS: Array<{ name: string; type: FieldType }> = [
  { name: '书名', type: FieldType.Text },
  { name: '作者', type: FieldType.Text },
  { name: '章节', type: FieldType.Text },
  { name: '划线内容', type: FieldType.Text },
  { name: '笔记内容', type: FieldType.Text },
  { name: '标签', type: FieldType.Text },
  { name: '书籍ID', type: FieldType.Text },
  { name: '划线ID', type: FieldType.Text },
  { name: '划线时间', type: FieldType.DateTime },
  { name: '更新时间', type: FieldType.DateTime },
  { name: '同步时间', type: FieldType.DateTime },
  { name: '来源', type: FieldType.Text }
];

const BOOK_FIELDS: Array<{ name: string; type: FieldType }> = [
  { name: '书籍ID', type: FieldType.Text },
  { name: '书名', type: FieldType.Text },
  { name: '作者', type: FieldType.Text },
  { name: '封面', type: FieldType.Text },
  { name: '价格', type: FieldType.Number },
  { name: '发布时间', type: FieldType.DateTime },
  { name: '标签', type: FieldType.Text },
  { name: '最近章节', type: FieldType.Text },
  { name: '最近划线内容', type: FieldType.Text },
  { name: '最近笔记内容', type: FieldType.Text },
  { name: '最近划线ID', type: FieldType.Text },
  { name: '划线数量', type: FieldType.Number },
  { name: '笔记数量', type: FieldType.Number },
  { name: '最早划线时间', type: FieldType.DateTime },
  { name: '最早更新时间', type: FieldType.DateTime },
  { name: '最近划线时间', type: FieldType.DateTime },
  { name: '最近更新时间', type: FieldType.DateTime },
  { name: '原始元数据', type: FieldType.Text },
  { name: '同步时间', type: FieldType.DateTime },
  { name: '来源', type: FieldType.Text }
];

const NOTE_FIELDS: Array<{ name: string; type: FieldType }> = [
  { name: '笔记ID', type: FieldType.Text },
  { name: '书籍ID', type: FieldType.Text },
  { name: '书名', type: FieldType.Text },
  { name: '作者', type: FieldType.Text },
  { name: '章节', type: FieldType.Text },
  { name: '关联划线ID', type: FieldType.Text },
  { name: '关联划线内容', type: FieldType.Text },
  { name: '笔记内容', type: FieldType.Text },
  { name: '标签', type: FieldType.Text },
  { name: '划线时间', type: FieldType.DateTime },
  { name: '更新时间', type: FieldType.DateTime },
  { name: '同步时间', type: FieldType.DateTime },
  { name: '来源', type: FieldType.Text }
];

export interface WereadBookRecord {
  bookId: string;
  bookTitle: string;
  author: string;
  cover: string;
  price?: number;
  publishTime?: number;
  tags: string;
  chapter: string;
  latestHighlightText: string;
  latestNoteText: string;
  latestHighlightId: string;
  highlightCount: number;
  noteCount: number;
  earliestHighlightedAt?: number;
  earliestUpdatedAt?: number;
  latestHighlightedAt?: number;
  latestUpdatedAt?: number;
  rawMetaJson: string;
}

export interface WereadNoteRecord {
  noteId: string;
  bookId: string;
  bookTitle: string;
  author: string;
  chapter: string;
  highlightId: string;
  highlightText: string;
  noteText: string;
  tags: string;
  highlightedAt?: number;
  updatedAt?: number;
}

async function ensureFields(table: ITable, requiredFields: Array<{ name: string; type: FieldType }>): Promise<void> {
  const existing = await table.getFieldMetaList();
  const existingNames = new Set(existing.map((f) => f.name));
  for (const field of requiredFields) {
    if (!existingNames.has(field.name)) {
      await table.addField({
        type: field.type as FieldType.Text | FieldType.DateTime | FieldType.Number,
        name: field.name
      });
    }
  }
}

async function clearTableRecords(table: ITable): Promise<void> {
  const recordIds = await table.getRecordIdList();
  const batchSize = 5000;
  for (let i = 0; i < recordIds.length; i += batchSize) {
    await table.deleteRecords(recordIds.slice(i, i + batchSize));
  }
}

async function getFieldMap(table: ITable, requiredFields: Array<{ name: string; type: FieldType }>): Promise<Record<string, string>> {
  const fields = await table.getFieldMetaList();
  const map: Record<string, string> = {};
  for (const name of requiredFields.map((f) => f.name)) {
    const field = fields.find((item) => item.name === name);
    if (field) {
      map[name] = field.id;
    }
  }
  return map;
}

function requireFieldId(fieldMap: Record<string, string>, name: string): string {
  const id = fieldMap[name];
  if (!id) {
    throw new Error(`字段缺失: ${name}`);
  }
  return id;
}

export async function prepareWereadTable(tableName?: string, onProgress?: ProgressHandler): Promise<ITable> {
  const finalTableName = tableName?.trim() || DEFAULT_HIGHLIGHT_TABLE_NAME;
  onProgress?.(15, '正在检查目标数据表');
  const tables = await bitable.base.getTableMetaList();
  const existing = tables.find((table) => table.name === finalTableName);
  let table: ITable;

  if (existing) {
    table = await bitable.base.getTableById(existing.id);
    onProgress?.(25, '已找到历史数据表，正在清理旧数据');
    await clearTableRecords(table);
  } else {
    onProgress?.(25, '正在创建微信读书划线数据表');
    const created = await bitable.base.addTable({
      name: finalTableName,
      fields: [{ name: '书名', type: FieldType.Text }]
    });
    table = await bitable.base.getTableById(created.tableId);
  }

  onProgress?.(35, '正在校验并补齐字段');
  await ensureFields(table, HIGHLIGHT_FIELDS);
  return table;
}

export async function prepareWereadBookTable(tableName?: string, onProgress?: ProgressHandler): Promise<ITable> {
  const finalTableName = tableName?.trim() || DEFAULT_BOOK_TABLE_NAME;
  onProgress?.(15, '正在检查书籍数据表');
  const tables = await bitable.base.getTableMetaList();
  const existing = tables.find((table) => table.name === finalTableName);
  let table: ITable;

  if (existing) {
    table = await bitable.base.getTableById(existing.id);
    onProgress?.(25, '已找到书籍数据表，正在清理旧数据');
    await clearTableRecords(table);
  } else {
    onProgress?.(25, '正在创建微信读书书籍数据表');
    const created = await bitable.base.addTable({
      name: finalTableName,
      fields: [{ name: '书名', type: FieldType.Text }]
    });
    table = await bitable.base.getTableById(created.tableId);
  }

  onProgress?.(35, '正在校验并补齐书籍字段');
  await ensureFields(table, BOOK_FIELDS);
  return table;
}

export async function prepareWereadNoteTable(tableName?: string, onProgress?: ProgressHandler): Promise<ITable> {
  const finalTableName = tableName?.trim() || DEFAULT_NOTE_TABLE_NAME;
  onProgress?.(15, '正在检查笔记数据表');
  const tables = await bitable.base.getTableMetaList();
  const existing = tables.find((table) => table.name === finalTableName);
  let table: ITable;

  if (existing) {
    table = await bitable.base.getTableById(existing.id);
    onProgress?.(25, '已找到笔记数据表，正在清理旧数据');
    await clearTableRecords(table);
  } else {
    onProgress?.(25, '正在创建微信读书笔记数据表');
    const created = await bitable.base.addTable({
      name: finalTableName,
      fields: [{ name: '笔记内容', type: FieldType.Text }]
    });
    table = await bitable.base.getTableById(created.tableId);
  }

  onProgress?.(35, '正在校验并补齐笔记字段');
  await ensureFields(table, NOTE_FIELDS);
  return table;
}

export async function writeWereadHighlights(
  table: ITable,
  highlights: WereadHighlight[],
  onProgress?: ProgressHandler
): Promise<void> {
  if (!highlights.length) {
    return;
  }

  const fieldMap = await getFieldMap(table, HIGHLIGHT_FIELDS);
  const bookTitleFieldId = requireFieldId(fieldMap, '书名');
  const authorFieldId = requireFieldId(fieldMap, '作者');
  const chapterFieldId = requireFieldId(fieldMap, '章节');
  const highlightTextFieldId = requireFieldId(fieldMap, '划线内容');
  const noteTextFieldId = requireFieldId(fieldMap, '笔记内容');
  const tagsFieldId = requireFieldId(fieldMap, '标签');
  const bookIdFieldId = requireFieldId(fieldMap, '书籍ID');
  const highlightIdFieldId = requireFieldId(fieldMap, '划线ID');
  const highlightedAtFieldId = requireFieldId(fieldMap, '划线时间');
  const updatedAtFieldId = requireFieldId(fieldMap, '更新时间');
  const syncTimeFieldId = requireFieldId(fieldMap, '同步时间');
  const sourceFieldId = requireFieldId(fieldMap, '来源');
  const syncTime = Date.now();
  const batchSize = 500;
  const totalBatches = Math.ceil(highlights.length / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * batchSize;
    const end = Math.min(start + batchSize, highlights.length);
    const batch = highlights.slice(start, end);

    const records = batch.map((item) => ({
      fields: {
        [bookTitleFieldId]: item.bookTitle,
        [authorFieldId]: item.author,
        [chapterFieldId]: item.chapter,
        [highlightTextFieldId]: item.highlightText,
        [noteTextFieldId]: item.noteText,
        [tagsFieldId]: item.tags,
        [bookIdFieldId]: item.bookId,
        [highlightIdFieldId]: item.highlightId,
        [highlightedAtFieldId]: item.highlightedAt ?? syncTime,
        [updatedAtFieldId]: item.updatedAt ?? syncTime,
        [syncTimeFieldId]: syncTime,
        [sourceFieldId]: '微信读书'
      }
    }));

    await table.addRecords(records);
    const progress = ((batchIndex + 1) / totalBatches) * 100;
    onProgress?.(progress, `已写入 ${end}/${highlights.length} 条划线`);
  }
}

export async function writeWereadBookRecords(
  table: ITable,
  books: WereadBookRecord[],
  onProgress?: ProgressHandler
): Promise<void> {
  if (!books.length) {
    return;
  }

  const fieldMap = await getFieldMap(table, BOOK_FIELDS);
  const bookIdFieldId = requireFieldId(fieldMap, '书籍ID');
  const bookTitleFieldId = requireFieldId(fieldMap, '书名');
  const authorFieldId = requireFieldId(fieldMap, '作者');
  const coverFieldId = requireFieldId(fieldMap, '封面');
  const priceFieldId = requireFieldId(fieldMap, '价格');
  const publishTimeFieldId = requireFieldId(fieldMap, '发布时间');
  const tagsFieldId = requireFieldId(fieldMap, '标签');
  const chapterFieldId = requireFieldId(fieldMap, '最近章节');
  const latestHighlightTextFieldId = requireFieldId(fieldMap, '最近划线内容');
  const latestNoteTextFieldId = requireFieldId(fieldMap, '最近笔记内容');
  const latestHighlightIdFieldId = requireFieldId(fieldMap, '最近划线ID');
  const highlightCountFieldId = requireFieldId(fieldMap, '划线数量');
  const noteCountFieldId = requireFieldId(fieldMap, '笔记数量');
  const earliestHighlightedAtFieldId = requireFieldId(fieldMap, '最早划线时间');
  const earliestUpdatedAtFieldId = requireFieldId(fieldMap, '最早更新时间');
  const latestHighlightedAtFieldId = requireFieldId(fieldMap, '最近划线时间');
  const latestUpdatedAtFieldId = requireFieldId(fieldMap, '最近更新时间');
  const rawMetaFieldId = requireFieldId(fieldMap, '原始元数据');
  const syncTimeFieldId = requireFieldId(fieldMap, '同步时间');
  const sourceFieldId = requireFieldId(fieldMap, '来源');
  const syncTime = Date.now();
  const batchSize = 500;
  const totalBatches = Math.ceil(books.length / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * batchSize;
    const end = Math.min(start + batchSize, books.length);
    const batch = books.slice(start, end);
    const records = batch.map((item) => ({
      fields: {
        [bookIdFieldId]: item.bookId,
        [bookTitleFieldId]: item.bookTitle,
        [authorFieldId]: item.author,
        [coverFieldId]: item.cover,
        [priceFieldId]: item.price ?? 0,
        [publishTimeFieldId]: item.publishTime ?? syncTime,
        [tagsFieldId]: item.tags,
        [chapterFieldId]: item.chapter,
        [latestHighlightTextFieldId]: item.latestHighlightText,
        [latestNoteTextFieldId]: item.latestNoteText,
        [latestHighlightIdFieldId]: item.latestHighlightId,
        [highlightCountFieldId]: item.highlightCount,
        [noteCountFieldId]: item.noteCount,
        [earliestHighlightedAtFieldId]: item.earliestHighlightedAt ?? syncTime,
        [earliestUpdatedAtFieldId]: item.earliestUpdatedAt ?? syncTime,
        [latestHighlightedAtFieldId]: item.latestHighlightedAt ?? syncTime,
        [latestUpdatedAtFieldId]: item.latestUpdatedAt ?? syncTime,
        [rawMetaFieldId]: item.rawMetaJson,
        [syncTimeFieldId]: syncTime,
        [sourceFieldId]: '微信读书'
      }
    }));
    await table.addRecords(records);
    const progress = ((batchIndex + 1) / totalBatches) * 100;
    onProgress?.(progress, `已写入 ${end}/${books.length} 条书籍记录`);
  }
}

export async function writeWereadNoteRecords(
  table: ITable,
  notes: WereadNoteRecord[],
  onProgress?: ProgressHandler
): Promise<void> {
  if (!notes.length) {
    return;
  }

  const fieldMap = await getFieldMap(table, NOTE_FIELDS);
  const noteIdFieldId = requireFieldId(fieldMap, '笔记ID');
  const bookIdFieldId = requireFieldId(fieldMap, '书籍ID');
  const bookTitleFieldId = requireFieldId(fieldMap, '书名');
  const authorFieldId = requireFieldId(fieldMap, '作者');
  const chapterFieldId = requireFieldId(fieldMap, '章节');
  const highlightIdFieldId = requireFieldId(fieldMap, '关联划线ID');
  const highlightTextFieldId = requireFieldId(fieldMap, '关联划线内容');
  const noteTextFieldId = requireFieldId(fieldMap, '笔记内容');
  const tagsFieldId = requireFieldId(fieldMap, '标签');
  const highlightedAtFieldId = requireFieldId(fieldMap, '划线时间');
  const updatedAtFieldId = requireFieldId(fieldMap, '更新时间');
  const syncTimeFieldId = requireFieldId(fieldMap, '同步时间');
  const sourceFieldId = requireFieldId(fieldMap, '来源');
  const syncTime = Date.now();
  const batchSize = 500;
  const totalBatches = Math.ceil(notes.length / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * batchSize;
    const end = Math.min(start + batchSize, notes.length);
    const batch = notes.slice(start, end);
    const records = batch.map((item) => ({
      fields: {
        [noteIdFieldId]: item.noteId,
        [bookIdFieldId]: item.bookId,
        [bookTitleFieldId]: item.bookTitle,
        [authorFieldId]: item.author,
        [chapterFieldId]: item.chapter,
        [highlightIdFieldId]: item.highlightId,
        [highlightTextFieldId]: item.highlightText,
        [noteTextFieldId]: item.noteText,
        [tagsFieldId]: item.tags,
        [highlightedAtFieldId]: item.highlightedAt ?? syncTime,
        [updatedAtFieldId]: item.updatedAt ?? syncTime,
        [syncTimeFieldId]: syncTime,
        [sourceFieldId]: '微信读书'
      }
    }));
    await table.addRecords(records);
    const progress = ((batchIndex + 1) / totalBatches) * 100;
    onProgress?.(progress, `已写入 ${end}/${notes.length} 条笔记记录`);
  }
}
