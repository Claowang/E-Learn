import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig, writeConfig } from './config.js';
import { hashPassword, randomPassword } from './util.js';
import { offlineStatus } from './providers/offline.js';

const [, , command, ...args] = process.argv;

function setPassword() {
  const config = loadConfig();
  const password = args[0] || randomPassword(12);
  const { salt, hash } = hashPassword(password);
  config.auth.salt = salt;
  config.auth.passwordHash = hash;
  config.auth.secret = config.auth.secret || '';
  writeConfig(config);
  console.log(`密码已重置为：${password}`);
}

function info() {
  const config = loadConfig();
  console.log('数据目录      ', DATA_DIR);
  console.log('服务端口      ', config.port);
  const offline = offlineStatus(config.providers.offline);
  console.log('大模型        ', config.providers.llm.apiKey ? `已配置 ${config.providers.llm.model}` : '未配置 API Key');
  console.log('在线词典      ', config.providers.dict.enabled ? `已启用 (${config.providers.dict.engine})` : '未启用');
  console.log(
    '离线词库      ',
    offline.installed ? `已安装，${offline.entries} 条 (${offline.path})` : `未安装 (${offline.path})`
  );
  console.log('发音          ', config.tts.engine);
}

function token() {
  const config = loadConfig();
  console.log(config.auth.secret);
}

function dbPath() {
  console.log(path.join(DATA_DIR, 'english-learn.db'));
  if (fs.existsSync(path.join(DATA_DIR, 'english-learn.db'))) {
    console.log('（已存在）');
  }
}

const commands = {
  'set-password': setPassword,
  info,
  token,
  'db-path': dbPath
};

const handler = commands[command];
if (!handler) {
  console.log(`用法：node src/cli.js <${Object.keys(commands).join('|')}> [参数]`);
  process.exit(1);
}
handler();
