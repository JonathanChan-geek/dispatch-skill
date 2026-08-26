#!/usr/bin/env node
// lane.mjs — worktree lane 管理 + 触碰集对账(派单纪律的强制力层)
//
// 用法(在目标仓库任意目录下执行):
//   node lane.mjs new <slice> <file-or-dir>... [--base <ref>] [--protect <path>]...
//       建 worktree .lanes/<slice>(分支 lane/<slice>),声明允许触碰的文件集,写 manifest
//   node lane.mjs audit <slice>
//       对账:HEAD 未动(worker 禁 commit)+ 改动全在声明集内 + 保护路径未碰。FAIL 时 exit 1
//   node lane.mjs list
//   node lane.mjs drop <slice>
//       删 worktree + lane 分支 + manifest(验收合并后、或弃 lane 时用)
//
// 设计约定:
//   - worktree 放在 <repo>/.lanes/ 下,自动写入 .git/info/exclude,不污染 tracked .gitignore
//   - 声明集条目:目录以 / 结尾或本身是目录 → 前缀匹配;含 * → 简单 glob;否则精确匹配
//   - docs/gates/ 永远是保护路径(worker 改验收门 = 自动 FAIL)
//   - 合并不归本脚本:audit PASS 后由监工在 lane 目录逐行读 diff、自己 commit 到 lane 分支再 merge

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function die(msg) { console.error(`[lane] FAIL: ${msg}`); process.exit(1); }

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (!cmd || !['new', 'audit', 'list', 'drop'].includes(cmd)) {
  console.error('用法: node lane.mjs new|audit|list|drop ...(见文件头注释)');
  process.exit(2);
}

// 主仓库根:不能用 --show-toplevel(在 worktree 内会返回 worktree 自身路径),
// 用 --git-common-dir 定位主 .git 再取其父目录
const gitCommonDir = path.resolve(process.cwd(), git(['rev-parse', '--git-common-dir'], process.cwd()));
const root = path.dirname(gitCommonDir);
const lanesDir = path.join(root, '.lanes');
const manifestPath = (slice) => path.join(lanesDir, `${slice}.manifest.json`);
const wtPath = (slice) => path.join(lanesDir, slice);

function ensureExcluded() {
  const excl = path.join(gitCommonDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(excl), { recursive: true });
  const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes('.lanes/')) {
    fs.writeFileSync(excl, cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + '.lanes/\n');
  }
}

function loadManifest(slice) {
  if (!fs.existsSync(manifestPath(slice))) die(`找不到 manifest: ${manifestPath(slice)}`);
  return JSON.parse(fs.readFileSync(manifestPath(slice), 'utf8'));
}

// 声明集匹配:dir/ 前缀 | *glob | 精确
function makeMatcher(entries) {
  const rules = entries.map((e) => {
    const n = e.replace(/\\/g, '/').replace(/^\.\//, '');
    if (n.includes('*')) {
      const re = new RegExp('^' + n.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^]*') + '$');
      return (p) => re.test(p);
    }
    if (n.endsWith('/')) return (p) => p.startsWith(n);
    return (p) => p === n || p.startsWith(n + '/'); // 允许把目录写成不带斜杠
  });
  return (p) => rules.some((r) => r(p));
}

function changedFiles(wt) {
  const out = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: wt, encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // rename 取新路径
    return p.replace(/^"|"$/g, '').replace(/\\/g, '/');
  });
}

if (cmd === 'new') {
  const slice = argv.shift();
  if (!slice || !/^[\w][\w.-]*$/.test(slice)) die('slice 名必须是 [A-Za-z0-9_.-]+');
  let base = 'HEAD';
  const files = [];
  const protect = ['docs/gates/'];
  while (argv.length) {
    const a = argv.shift();
    if (a === '--base') base = argv.shift();
    else if (a === '--protect') protect.push(argv.shift().replace(/\\/g, '/'));
    else files.push(a.replace(/\\/g, '/'));
  }
  if (!files.length) die('必须声明至少一个允许触碰的文件/目录');
  if (fs.existsSync(wtPath(slice)) || fs.existsSync(manifestPath(slice))) die(`lane "${slice}" 已存在`);

  // 派活前工作树必须干净(与 mutate.mjs 同源纪律)
  if (git(['status', '--porcelain'], root)) die('主工作树不干净,先提交或 stash 再开 lane');

  ensureExcluded();
  fs.mkdirSync(lanesDir, { recursive: true });
  const baseSha = git(['rev-parse', base], root);
  git(['worktree', 'add', '-b', `lane/${slice}`, wtPath(slice), baseSha], root);
  const manifest = { slice, base: baseSha, branch: `lane/${slice}`, files, protect, createdAt: new Date().toISOString() };
  fs.writeFileSync(manifestPath(slice), JSON.stringify(manifest, null, 2));
  console.log(`[lane] OK: ${wtPath(slice)}`);
  console.log(`[lane] 分支 lane/${slice} @ ${baseSha.slice(0, 10)}`);
  console.log(`[lane] 触碰集: ${files.join(', ')}`);
  console.log(`[lane] 保护路径: ${protect.join(', ')}`);
}

if (cmd === 'audit') {
  const slice = argv.shift();
  const m = loadManifest(slice);
  const wt = wtPath(slice);
  if (!fs.existsSync(wt)) die(`worktree 不存在: ${wt}`);

  const problems = [];
  const head = git(['rev-parse', 'HEAD'], wt);
  if (head !== m.base) problems.push(`HEAD 被移动(worker 疑似 commit 过): ${m.base.slice(0, 10)} → ${head.slice(0, 10)}`);

  const changed = changedFiles(wt);
  const inScope = makeMatcher(m.files);
  const isProtected = makeMatcher(m.protect || []);
  const outOfScope = changed.filter((p) => !inScope(p));
  const touchedProtected = changed.filter((p) => isProtected(p));

  if (touchedProtected.length) problems.push(`碰了保护路径(自动 FAIL): ${touchedProtected.join(', ')}`);
  if (outOfScope.length) problems.push(`声明集外的改动: ${outOfScope.join(', ')}`);

  console.log(`[lane] audit "${slice}" — 改动 ${changed.length} 个文件:`);
  for (const p of changed) console.log(`  ${outOfScope.includes(p) ? '✗' : '✓'} ${p}`);
  if (problems.length) {
    for (const p of problems) console.error(`[lane] FAIL: ${p}`);
    process.exit(1);
  }
  console.log('[lane] PASS: HEAD 未动,改动全部在声明集内,保护路径未碰');
}

if (cmd === 'list') {
  if (!fs.existsSync(lanesDir)) { console.log('[lane] 无活动 lane'); process.exit(0); }
  const ms = fs.readdirSync(lanesDir).filter((f) => f.endsWith('.manifest.json'));
  if (!ms.length) { console.log('[lane] 无活动 lane'); process.exit(0); }
  for (const f of ms) {
    const m = JSON.parse(fs.readFileSync(path.join(lanesDir, f), 'utf8'));
    console.log(`${m.slice}  @${m.base.slice(0, 10)}  ${m.createdAt}  [${m.files.join(', ')}]`);
  }
}

if (cmd === 'drop') {
  const slice = argv.shift();
  const m = loadManifest(slice);
  try { git(['worktree', 'remove', '--force', wtPath(slice)], root); } catch { /* Windows 句柄残留或已手动删,走下面兜底 */ }
  // Windows 下 git 删目录常因文件句柄失败:fs 重试兜底 + prune 清注册表
  if (fs.existsSync(wtPath(slice))) fs.rmSync(wtPath(slice), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try { git(['worktree', 'prune'], root); } catch { /* ignore */ }
  try { git(['branch', '-D', m.branch], root); } catch { /* 分支可能已合并删除 */ }
  fs.rmSync(manifestPath(slice), { force: true });
  if (fs.existsSync(wtPath(slice))) die(`worktree 目录删不掉(句柄被占用?): ${wtPath(slice)} — 关掉占用进程后重跑 drop`);
  console.log(`[lane] dropped: ${slice}`);
}
