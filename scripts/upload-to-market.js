#!/usr/bin/env node
// upload-to-market.js —— 构建产物自动上传到自建插件市场（SmartGin）
// 读取 release/*.zip → 解压 plugin.json → 按插件名分组取最高版本 →
// 分类匹配（catKey→categoryId）→ logo 转 URL → 创建/更新插件 → 上传版本包。
// 认证使用单一预置管理端 token（MARKET_ADMIN_TOKEN），不做账号密码/验证码流程。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import unzipper from "unzipper";

// ---- 配置默认值 ----
const DEFAULT_BASE_URL = "http://ijoy.store";
const DEFAULT_PLATFORM = "win32";
const DEFAULT_RELEASE_DIR = "release";
const CATEGORIES_MAPPING_FILE = "categories-mapping.json";

/**
 * 比较两个语义化版本号
 * @param {string} v1 版本号
 * @param {string} v2 版本号
 * @returns {number} v1>v2 返回 1，v1<v2 返回 -1，相等返回 0
 */
function compareVersions(v1, v2) {
  const parts1 = String(v1).split(".").map(Number);
  const parts2 = String(v2).split(".").map(Number);
  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const n1 = parts1[i] || 0;
    const n2 = parts2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

/**
 * 从 zip 目录项中按路径找文件
 * @param {object} dir unzipper 打开后的目录
 * @param {string} target 目标文件路径
 * @returns {object|undefined} 匹配的文件项
 */
function findFile(dir, target) {
  const norm = target.replace(/\\/g, "/");
  return dir.files.find((f) => f.path === norm || f.path.endsWith(`/${norm}`));
}

/**
 * 解压 zip 读取 plugin.json
 * @param {Buffer} zipBuffer zip 文件内容
 * @returns {Promise<{plugin: object, dir: object}>} plugin.json 解析结果与解压目录
 */
async function readPluginJson(zipBuffer) {
  const dir = await unzipper.Open.buffer(zipBuffer);
  const pjFile = findFile(dir, "plugin.json");
  if (!pjFile) throw new Error("zip 内未找到 plugin.json");
  const plugin = JSON.parse((await pjFile.buffer()).toString("utf8"));
  return { plugin, dir };
}

/**
 * 读取 release/changelog.txt 中指定插件版本的发布说明
 * 行格式：<name> v<version>: <desc>
 * @param {string} releaseDir 产物目录
 * @param {string} name 插件名
 * @param {string} version 插件版本
 * @returns {string} 发布说明（未找到返回空字符串）
 */
function loadReleaseNotes(releaseDir, name, version) {
  const file = join(releaseDir, "changelog.txt");
  if (!existsSync(file)) return "";
  const prefix = `${name} v${version}:`;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return "";
}

/**
 * 调市场 API 并解包 {code,msg,data} 响应
 * @param {string} baseUrl 市场基址
 * @param {string} token 管理端 token
 * @param {string} method HTTP 方法
 * @param {string} path API 路径（含 query）
 * @param {object} [options] 请求选项：json（JSON body）/ form（FormData body）
 * @returns {Promise<*>} 解包后的 data
 * @throws {Error} 响应非 00000 或 HTTP 非 2xx 时抛错
 */
async function api(baseUrl, token, method, path, { json, form } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { code: "error", msg: text };
  }
  if (!res.ok || payload.code !== "00000") {
    throw new Error(
      `API ${method} ${path} 失败: HTTP ${res.status} code=${payload.code} msg=${payload.msg || text}`,
    );
  }
  return payload.data;
}

/**
 * 把 zip 内 logo 文件上传为市场可用的 URL
 * @param {object} ctx 上传上下文（baseUrl/token/dir/plugin）
 * @returns {Promise<string>} logo URL；logo 文件缺失时返回空字符串
 */
async function uploadLogo({ baseUrl, token, dir, plugin }) {
  if (!plugin.logo) return "";
  const logoFile = findFile(dir, plugin.logo);
  if (!logoFile) return "";
  const form = new FormData();
  form.append(
    "file",
    new Blob([await logoFile.buffer()]),
    plugin.logo.split("/").pop(),
  );
  form.append("path", "logos");
  const data = await api(baseUrl, token, "POST", "/api/v1/files", { form });
  return data?.url || "";
}

/**
 * 加载 categories-mapping.json，构建「插件名 → catKey 列表」兜底映射
 * @param {string} releaseDir 产物目录（映射文件位于仓库根，向上回溯查找）
 * @returns {Map<string, string[]>} 插件名 → catKey 列表
 */
function loadCategoryFallback() {
  const map = new Map();
  const file = resolve(process.cwd(), CATEGORIES_MAPPING_FILE);
  if (!existsSync(file)) return map;
  let mapping;
  try {
    mapping = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return map;
  }
  for (const cat of mapping || []) {
    for (const name of cat.list || []) {
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(cat.key);
    }
  }
  return map;
}

/**
 * 解析插件最终用于匹配市场的 catKey 列表：
 * 优先用 plugin.json 显式声明的 categories，否则按插件名回退 categories-mapping.json
 * @param {object} plugin plugin.json 解析结果
 * @param {Map<string, string[]>} fallback 名字兜底映射
 * @returns {string[]} catKey 列表
 */
function resolvePluginCategories(plugin, fallback) {
  const explicit = Array.isArray(plugin.categories)
    ? plugin.categories
    : plugin.categories
      ? [plugin.categories]
      : [];
  if (explicit.length > 0) return explicit;
  return fallback.get(plugin.name) || [];
}

/**
 * 按 catKey 匹配市场分类 ID；匹配不到回退默认 ID，仍无默认则抛错
 * @param {Array<{id:number, catKey:string}>} categories 市场分类列表
 * @param {string[]} pluginCategories 插件分类 catKey 列表
 * @param {number} defaultCategoryId 兜底分类 ID（0 表示未提供）
 * @returns {number} 分类 ID
 * @throws {Error} 未匹配且未提供默认分类时抛错
 */
function matchCategoryId(categories, pluginCategories, defaultCategoryId) {
  for (const cat of pluginCategories || []) {
    const found = categories.find((c) => c.catKey === cat);
    if (found) return found.id;
  }
  if (defaultCategoryId) return defaultCategoryId;
  throw new Error(
    `插件分类 ${JSON.stringify(pluginCategories)} 未匹配到市场分类，且未设置 MARKET_DEFAULT_CATEGORY_ID`,
  );
}

/**
 * 生成插件创建/更新表单
 * @param {object} plugin plugin.json 解析结果
 * @param {number} categoryId 分类 ID
 * @param {string} logoUrl logo URL
 * @param {string} platform 市场平台
 * @returns {object} PluginForm 表单
 */
function buildForm(plugin, categoryId, logoUrl, platform) {
  return {
    name: plugin.name,
    title: plugin.title,
    description: plugin.description || "",
    version: plugin.version,
    logo: logoUrl,
    author: plugin.author || "",
    homepage: plugin.homepage || "",
    platforms: [platform],
    categoryId,
    sourceType: "open_source",
    featured: 0,
    enabled: 1,
  };
}

/**
 * 上传单个插件到市场（创建或更新 + 上传版本包）
 * @param {object} ctx 上传上下文
 * @param {object} entry 插件条目（plugin/dir/zipBuffer/zipFile/releaseDir）
 * @returns {Promise<{id: number, action: 'created'|'updated'|'skipped'}>} 处理结果
 */
async function uploadOne(ctx, entry) {
  const { baseUrl, token, platform, defaultCategoryId, categories, categoryFallback } = ctx;
  const { plugin, dir, zipBuffer, zipFile, releaseDir } = entry;

  // 查找市场上同名插件，精确匹配 name
  const pageData = await api(
    baseUrl,
    token,
    "GET",
    `/api/v1/market/plugins?keywords=${encodeURIComponent(plugin.name)}&pageNum=1&pageSize=50`,
  );
  const list = pageData?.list || [];
  const existing = list.find((item) => item.name === plugin.name);

  // 同版本已发布：跳过，不重复上传
  if (existing && compareVersions(existing.version, plugin.version) === 0) {
    return { id: existing.id, action: "skipped" };
  }

  const categoryId = matchCategoryId(
    categories,
    resolvePluginCategories(plugin, categoryFallback),
    defaultCategoryId,
  );
  const logoUrl = await uploadLogo({ baseUrl, token, dir, plugin });
  const form = buildForm(plugin, categoryId, logoUrl, platform);
  const releaseNotes = loadReleaseNotes(
    releaseDir,
    plugin.name,
    plugin.version,
  );

  let id;
  let action;
  if (existing) {
    // 已存在：更新元数据
    await api(baseUrl, token, "PUT", `/api/v1/market/plugins/${existing.id}`, {
      json: form,
    });
    id = existing.id;
    action = "updated";
  } else {
    // 不存在：创建
    const created = await api(
      baseUrl,
      token,
      "POST",
      "/api/v1/market/plugins",
      { json: form },
    );
    id = created?.id;
    action = "created";
  }
  if (!id) throw new Error(`创建/更新插件 ${plugin.name} 后未拿到 id`);

  // 上传版本包（multipart：file=zip + version + releaseNotes）
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([zipBuffer]), zipFile);
  uploadForm.append("version", plugin.version);
  uploadForm.append("releaseNotes", releaseNotes);
  await api(baseUrl, token, "POST", `/api/v1/market/plugins/${id}/upload`, {
    form: uploadForm,
  });

  return { id, action };
}

/**
 * 读取产物目录 zip，按插件名分组并取每组最高版本
 * @param {string} releaseDir 产物目录
 * @returns {Promise<Map<string, object>>} 插件名 → 最高版本条目
 */
async function collectHighestPerPlugin(releaseDir) {
  const zipFiles = readdirSync(releaseDir).filter((f) => f.endsWith(".zip"));
  const groups = new Map();
  for (const zipFile of zipFiles) {
    const zipPath = join(releaseDir, zipFile);
    const zipBuffer = readFileSync(zipPath);
    let plugin;
    let dir;
    try {
      ({ plugin, dir } = await readPluginJson(zipBuffer));
    } catch {
      continue; // 非插件 zip（如历史资产）跳过
    }
    if (!plugin.name) continue;
    const entry = { plugin, dir, zipBuffer, zipFile, releaseDir };
    const group = groups.get(plugin.name) || [];
    group.push(entry);
    groups.set(plugin.name, group);
  }
  const result = new Map();
  for (const [name, group] of groups) {
    group.sort((a, b) => compareVersions(b.plugin.version, a.plugin.version));
    result.set(name, group[0]);
  }
  return result;
}

/**
 * 上传全部插件到自建市场
 * @param {object} opts 配置
 * @param {string} [opts.baseUrl] 市场基址（默认 http://dev.991788.xyz）
 * @param {string} opts.token 管理端 token（必填）
 * @param {string} [opts.releaseDir] 产物目录（默认 release）
 * @param {string} [opts.platform] 市场平台（默认 win32）
 * @param {number} [opts.defaultCategoryId] 分类匹配不到时的兜底 ID（0 表示报错）
 * @returns {Promise<Array<{name:string, id:number, action:string}>>} 每个插件的处理结果
 */
export async function uploadMarketPlugins({
  baseUrl = DEFAULT_BASE_URL,
  token,
  releaseDir = DEFAULT_RELEASE_DIR,
  platform = DEFAULT_PLATFORM,
  defaultCategoryId = 0,
} = {}) {
  if (!token) throw new Error("缺少 MARKET_ADMIN_TOKEN，无法认证市场管理端");

  // 拉取市场分类（每个插件的 catKey 映射都依赖它）
  const categories =
    (await api(baseUrl, token, "GET", "/api/v1/market/categories")) || [];
  const categoryFallback = loadCategoryFallback();
  const ctx = {
    baseUrl,
    token,
    platform,
    defaultCategoryId,
    categories,
    categoryFallback,
  };

  const entries = await collectHighestPerPlugin(releaseDir);
  const results = [];
  for (const [name, entry] of entries) {
    const { id, action } = await uploadOne(ctx, entry);
    results.push({ name, id, action });
    console.log(
      `[market] ${name}@${entry.plugin.version} -> ${action} (id=${id})`,
    );
  }
  return results;
}

/**
 * main：读取环境变量并执行上传
 * 环境变量：MARKET_BASE_URL / MARKET_ADMIN_TOKEN / MARKET_PLATFORM /
 *           MARKET_DEFAULT_CATEGORY_ID / RELEASE_DIR
 */
function main() {
  const baseUrl = process.env.MARKET_BASE_URL || DEFAULT_BASE_URL;
  const token = process.env.MARKET_ADMIN_TOKEN;
  const platform = process.env.MARKET_PLATFORM || DEFAULT_PLATFORM;
  const releaseDir = process.env.RELEASE_DIR || DEFAULT_RELEASE_DIR;
  const defaultCategoryId = Number(process.env.MARKET_DEFAULT_CATEGORY_ID || 8);

  uploadMarketPlugins({
    baseUrl,
    token,
    releaseDir,
    platform,
    defaultCategoryId,
  })
    .then((results) => {
      console.log(`[market] 完成，共处理 ${results.length} 个插件`);
    })
    .catch((err) => {
      console.error(`[market] 上传失败: ${err.message}`);
      process.exitCode = 1;
    });
}

// 直接运行脚本时执行 main；被 import（测试）时不执行
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
