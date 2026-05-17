type Row = Record<string, any>;

const TABLES = [
  'projects',
  'templates',
  'conversations',
  'messages',
  'preview_comments',
  'tabs',
  'deployments',
  'routines',
  'routine_runs',
  'critique_runs',
  'media_tasks',
];

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function rowWithAliases(row: Row): Row {
  const out: Row = { ...row };
  for (const [key, value] of Object.entries(row)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

function parseInsert(sql: string): { table: string; columns: string[] } | null {
  const match = /INSERT\s+INTO\s+([a-z_]+)\s*\(([^)]+)\)/i.exec(sql);
  if (!match) return null;
  const [, table, columns] = match;
  if (!table || !columns) return null;
  return {
    table,
    columns: columns.split(',').map((column) => column.trim()),
  };
}

function parseUpdate(sql: string): { table: string; columns: string[]; where: string[] } | null {
  const match = /UPDATE\s+([a-z_]+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i.exec(normalizeSql(sql));
  if (!match) return null;
  const [, table, setClause, whereClause] = match;
  if (!table || !setClause || !whereClause) return null;
  return {
    table,
    columns: [...setClause.matchAll(/([a-z_]+)\s*=/gi)].map((item) => item[1]).filter((item): item is string => Boolean(item)),
    where: [...whereClause.matchAll(/([a-z_]+)\s*=\s*\?/gi)].map((item) => item[1]).filter((item): item is string => Boolean(item)),
  };
}

function parseDelete(sql: string): { table: string; where: string[] } | null {
  const match = /DELETE\s+FROM\s+([a-z_]+)(?:\s+WHERE\s+(.+))?/i.exec(normalizeSql(sql));
  if (!match) return null;
  const [, table, whereClause = ''] = match;
  if (!table) return null;
  return {
    table,
    where: [...whereClause.matchAll(/([a-z_]+)\s*=\s*\?/gi)].map((item) => item[1]).filter((item): item is string => Boolean(item)),
  };
}

function tableFromSelect(sql: string): string | null {
  const normalized = normalizeSql(sql);
  if (/WITH project_conversations AS/i.test(normalized)) return 'conversations';
  return /FROM\s+([a-z_]+)/i.exec(normalized)?.[1] ?? null;
}

function compareByNumber(key: string, direction: 'asc' | 'desc') {
  return (left: Row, right: Row) => {
    const a = Number(left[key] ?? 0);
    const b = Number(right[key] ?? 0);
    return direction === 'asc' ? a - b : b - a;
  };
}

class MemoryStatement {
  constructor(
    private readonly db: MemoryDatabase,
    private readonly sql: string,
  ) {}

  all(...args: any[]): Row[] {
    return this.select(args);
  }

  get(...args: any[]): Row | undefined {
    return this.select(args)[0];
  }

  run(...args: any[]) {
    const insert = parseInsert(this.sql);
    if (insert) return this.runInsert(insert.table, insert.columns, args);

    const update = parseUpdate(this.sql);
    if (update) return this.runUpdate(update.table, update.columns, update.where, args);

    const del = parseDelete(this.sql);
    if (del) return this.runDelete(del.table, del.where, args);

    return { changes: 0 };
  }

  private runInsert(table: string, columns: string[], args: any[]) {
    const row: Row = {};
    columns.forEach((column, index) => {
      row[column] = args[index] ?? null;
    });
    const rows = this.db.rows(table);
    const conflict = this.findInsertConflict(table, row, rows);
    if (conflict) Object.assign(conflict, row);
    else rows.push(row);
    return { changes: 1, lastInsertRowid: row.id ?? rows.length };
  }

  private findInsertConflict(table: string, row: Row, rows: Row[]): Row | undefined {
    if (row.id != null) return rows.find((item) => item.id === row.id);
    if (table === 'tabs') return rows.find((item) => item.project_id === row.project_id && item.name === row.name);
    if (table === 'deployments') {
      return rows.find((item) => item.project_id === row.project_id && item.file_name === row.file_name && item.provider_id === row.provider_id);
    }
    if (table === 'preview_comments') {
      return rows.find((item) => item.project_id === row.project_id && item.conversation_id === row.conversation_id && item.file_path === row.file_path && item.element_id === row.element_id);
    }
    return undefined;
  }

  private runUpdate(table: string, columns: string[], where: string[], args: any[]) {
    const rows = this.db.rows(table);
    const whereValues = args.slice(columns.length);
    let changes = 0;
    for (const row of rows) {
      if (!where.every((column, index) => row[column] === whereValues[index])) continue;
      columns.forEach((column, index) => {
        row[column] = args[index] ?? null;
      });
      changes += 1;
    }
    return { changes };
  }

  private runDelete(table: string, where: string[], args: any[]) {
    const rows = this.db.rows(table);
    const before = rows.length;
    if (where.length === 0) {
      rows.splice(0, rows.length);
    } else {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row && where.every((column, columnIndex) => row[column] === args[columnIndex])) rows.splice(index, 1);
      }
    }
    return { changes: before - rows.length };
  }

  private select(args: any[]): Row[] {
    const normalized = normalizeSql(this.sql);
    if (/^PRAGMA table_info/i.test(normalized)) return [];
    if (/sqlite_master/i.test(normalized)) return [];

    if (/COALESCE\(MAX\(position\), -1\) AS m/i.test(normalized)) {
      const conversationId = args[0];
      const positions = this.db.rows('messages').filter((row) => row.conversation_id === conversationId).map((row) => Number(row.position ?? -1));
      return [{ m: positions.length ? Math.max(...positions) : -1 }];
    }

    if (/WITH project_conversations AS/i.test(normalized)) {
      const projectId = args[0];
      return this.db.rows('conversations')
        .filter((row) => row.project_id === projectId)
        .sort(compareByNumber('updated_at', 'desc'))
        .map(rowWithAliases);
    }

    const table = tableFromSelect(this.sql);
    if (!table || !TABLES.includes(table)) return [];

    let rows = [...this.db.rows(table)];
    rows = this.applyWhere(rows, normalized, args);
    rows = this.applyOrder(rows, normalized);
    rows = this.applyLimit(rows, normalized, args);
    return rows.map(rowWithAliases);
  }

  private applyWhere(rows: Row[], sql: string, args: any[]): Row[] {
    if (/WHERE id = \?/i.test(sql)) return rows.filter((row) => row.id === args[0]);
    if (/WHERE project_id = \? AND file_name = \? AND provider_id = \?/i.test(sql)) {
      return rows.filter((row) => row.project_id === args[0] && row.file_name === args[1] && row.provider_id === args[2]);
    }
    if (/WHERE project_id = \? AND id = \?/i.test(sql)) return rows.filter((row) => row.project_id === args[0] && row.id === args[1]);
    if (/WHERE id = \? AND project_id = \? AND conversation_id = \?/i.test(sql)) {
      return rows.filter((row) => row.id === args[0] && row.project_id === args[1] && row.conversation_id === args[2]);
    }
    if (/WHERE project_id = \? AND conversation_id = \? AND file_path = \? AND element_id = \?/i.test(sql)) {
      return rows.filter((row) => row.project_id === args[0] && row.conversation_id === args[1] && row.file_path === args[2] && row.element_id === args[3]);
    }
    if (/WHERE project_id = \? AND conversation_id = \?/i.test(sql)) return rows.filter((row) => row.project_id === args[0] && row.conversation_id === args[1]);
    if (/WHERE routine_id = \?/i.test(sql)) return rows.filter((row) => row.routine_id === args[0]);
    if (/WHERE conversation_id = \?/i.test(sql)) return rows.filter((row) => row.conversation_id === args[0]);
    if (/WHERE project_id = \?/i.test(sql)) return rows.filter((row) => row.project_id === args[0]);
    if (/WHERE name = \? AND source_project_id = \?/i.test(sql)) return rows.filter((row) => row.name === args[0] && row.source_project_id === args[1]);
    if (/WHERE status IN \('queued','running'\)/i.test(sql)) return rows.filter((row) => row.status === 'queued' || row.status === 'running');
    if (/WHERE status = 'running'/i.test(sql)) return rows.filter((row) => row.status === 'running');
    return rows;
  }

  private applyOrder(rows: Row[], sql: string): Row[] {
    if (/ORDER BY position ASC/i.test(sql)) return rows.sort(compareByNumber('position', 'asc'));
    if (/ORDER BY updated_at DESC|ORDER BY c\.updatedAt DESC/i.test(sql)) return rows.sort(compareByNumber('updated_at', 'desc'));
    if (/ORDER BY created_at DESC/i.test(sql)) return rows.sort(compareByNumber('created_at', 'desc'));
    if (/ORDER BY created_at ASC/i.test(sql)) return rows.sort(compareByNumber('created_at', 'asc'));
    if (/ORDER BY started_at DESC/i.test(sql)) return rows.sort(compareByNumber('started_at', 'desc'));
    return rows;
  }

  private applyLimit(rows: Row[], sql: string, args: any[]): Row[] {
    if (!/LIMIT \?/i.test(sql) && !/LIMIT 1/i.test(sql)) return rows;
    const limit = /LIMIT 1/i.test(sql) ? 1 : Number(args.at(-1));
    return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  }
}

class MemoryDatabase {
  private readonly data = new Map<string, Row[]>();

  constructor(readonly name = ':memory:') {
    for (const table of TABLES) this.data.set(table, []);
  }

  rows(table: string): Row[] {
    if (!this.data.has(table)) this.data.set(table, []);
    return this.data.get(table)!;
  }

  prepare(sql: string) {
    return new MemoryStatement(this, sql);
  }

  exec(_sql: string) {}

  pragma(_sql: string) {}

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: Parameters<T>) => fn(...args)) as T;
  }

  close() {}
}

export function createW3KitsMemoryDatabase(name?: string) {
  return new MemoryDatabase(name);
}
