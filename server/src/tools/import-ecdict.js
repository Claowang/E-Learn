#!/usr/bin/env node
/**
 * 把 ECDICT 的 CSV 转换成离线查词用的 SQLite 数据库（ecdict.db）。
 *
 *   node src/tools/import-ecdict.js D:\downloads\ecdict.csv
 *
 * 也可以直接把官方发布的 stardict.db 复制成 server/data/ecdict.db 使用，
 * 两种格式服务端都能读。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, ensureDataDir } from '../config.js';

const BATCH = 5000;

function parseArgs(argv) {
  const args = argv.slice(2);
  const input = args.find((value) => !value.startsWith('--'));
  const outputFlag = args.find((value) => value.startsWith('--out='));
  return {
    input,
    output: outputFlag ? outputFlag.slice('--out='.length) : path.join(DATA_DIR, 'ecdict.db')
  };
}

/** RFC4180-ish CSV row splitter that understands quotes and escaped quotes. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      out.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  out.push(field);
  return out;
}

const COLUMNS = ['word', 'phonetic', 'definition', 'translation', 'pos', 'collins', 'oxford', 'tag', 'bnc', 'frq', 'exchange', 'detail', 'audio'];

async function main() {
  const { input, output } = parseArgs(process.argv);
  if (!input) {
    console.log('用法：node src/tools/import-ecdict.js <ecdict.csv 路径> [--out=目标.db]');
    process.exit(1);
  }
  const source = path.resolve(input);
  if (!fs.existsSync(source)) {
    console.error(`找不到文件：${source}`);
    process.exit(1);
  }

  ensureDataDir();
  const target = path.resolve(output);
  if (fs.existsSync(target)) {
    console.log(`目标文件已存在，将覆盖：${target}`);
    fs.rmSync(target);
  }

  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = OFF');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(`CREATE TABLE stardict (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    sw TEXT,
    phonetic TEXT,
    definition TEXT,
    translation TEXT,
    pos TEXT,
    collins INTEGER,
    oxford INTEGER,
    tag TEXT,
    bnc INTEGER,
    frq INTEGER,
    exchange TEXT,
    detail TEXT,
    audio TEXT
  )`);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO stardict
      (word, sw, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, detail, audio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const stream = fs.createReadStream(source, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header = null;
  let index = COLUMNS.map((_, position) => position);
  let count = 0;
  let skipped = 0;
  let batch = [];
  let pending = '';
  let pendingLines = 0;
  const startedAt = Date.now();

  const flush = () => {
    if (!batch.length) return;
    db.exec('BEGIN');
    for (const row of batch) insert.run(...row);
    db.exec('COMMIT');
    batch = [];
  };

  for await (const rawLine of rl) {
    // Fields may contain embedded newlines inside quotes; keep reading until quotes balance.
    const line = pending ? `${pending}\n${rawLine}` : rawLine;
    pending = '';
    const quotes = (line.match(/"/g) || []).length;
    if (quotes % 2 === 1) {
      pending = line;
      pendingLines += 1;
      continue;
    }
    // A quoted field may hold a newline, or a dump may wrap one record over several
    // physical lines. Treat a short record as "not finished yet" as well.
    if (header && splitCsvLine(line).length < header.length && pendingLines < 10) {
      pending = line;
      pendingLines += 1;
      continue;
    }
    pendingLines = 0;
    if (!line) continue;
    if (!header) {
      const fields = splitCsvLine(line).map((value) => value.trim().toLowerCase());
      if (fields.includes('word') && fields.includes('translation')) {
        header = fields;
        index = COLUMNS.map((name) => fields.indexOf(name));
        continue;
      }
      // No header: assume the official column order.
    }
    const values = splitCsvLine(line);
    const word = (values[index[0]] || '').trim();
    if (!word) {
      skipped += 1;
      continue;
    }
    const cell = (position) => {
      const at = index[position];
      return at >= 0 ? (values[at] || '').trim() || null : null;
    };
    batch.push([
      word,
      word.toLowerCase(),
      cell(1),
      cell(2),
      cell(3),
      cell(4),
      Number(cell(5)) || 0,
      Number(cell(6)) || 0,
      cell(7),
      Number(cell(8)) || 0,
      Number(cell(9)) || 0,
      cell(10),
      cell(11),
      cell(12)
    ]);
    count += 1;
    if (batch.length >= BATCH) {
      flush();
      const seconds = (Date.now() - startedAt) / 1000;
      process.stdout.write(`\r已导入 ${count} 条（${seconds.toFixed(0)}s）`);
    }
  }
  flush();

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_stardict_word ON stardict(word)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stardict_sw ON stardict(sw)');
  db.exec('ANALYZE');
  const total = db.prepare('SELECT COUNT(*) AS n FROM stardict').get().n;
  db.close();

  const size = fs.statSync(target).size;
  console.log(`\n完成：${total} 条词条，跳过 ${skipped} 行，文件 ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`目标文件：${target}`);
}

main().catch((err) => {
  console.error('导入失败：', err);
  process.exit(1);
});
