/* The catalog is generated from the CLI registry during the same build as this page. */
const state = { platforms: [], filter: 'all', evidence: 'uncertain', resumed: false, expanded: false };
const byId = id => document.getElementById(id);
const platformGuides = {
  juejin: '分类、标签使用平台 ID；可查询专栏，再决定保存草稿或提交。',
  xiaohongshu: '图文笔记需要本地图片，标题最多 20 字、正文最多 1000 字。当前未注册草稿能力。',
  wechat: '公众号保留排版并上传图片。发表与群发是不同操作；平台要求时仍需管理员验证。',
  zhihu: '使用专栏原生编辑器和自动保存。草稿、图片与发表分别记录，公开展示单独回查。',
};
const intentLabels = { 'draft.create': '保存为草稿', 'content.publish': '提交发表', 'draft.update': '更新已有草稿', 'draft.publish': '从已有草稿发表', 'article.list': '查询自己的文章' };
// Shell output is text only. Quote user-entered filenames and aliases as literal POSIX arguments.
const quote = value => /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
function commandStudio() {
  const platform = state.platforms.find(platform => platform.id === byId('platform-choice').value);
  if (!platform) return;
  const intent = byId('intent-choice').value;
  const capability = platform.capabilities.find(capability => capability.id === intent);
  const account = byId('account-input').value.trim() || 'main';
  const file = byId('file-input').value.trim() || 'article.md';
  const base = byId('base-input').value.trim() || 'base.json';
  const existing = ['draft.update', 'draft.publish'].includes(intent);
  const hasFile = ['draft.create', 'content.publish', 'draft.update'].includes(intent);
  byId('file-field').hidden = !hasFile;
  byId('base-field').hidden = !existing;
  byId('platform-tip').textContent = platformGuides[platform.id] ?? platform.name + '：通过能力契约了解支持的操作。';
  byId('effect-label').textContent = intent === 'article.list' ? '只读查询' : '远端写入';
  byId('schema-command').textContent = `wm schema --platform ${quote(platform.id)} --capability ${intent} --json`;
  const status = byId('command-status');
  const copyButtons = document.querySelectorAll('.command-result [data-copy]');
  if (!capability) {
    byId('natural-prompt').textContent = `${platform.name}当前没有注册“${intentLabels[intent]}”能力。请改选该平台支持的操作。`;
    byId('generated-command').textContent = `wm platform capabilities ${quote(platform.id)} --account ${quote(account)} --json`;
    status.textContent = '此组合不可执行。能力列表中的“查看契约”可查看实际支持范围。';
    status.classList.add('unavailable'); copyButtons.forEach(button => { button.disabled = true; }); return;
  }
  copyButtons.forEach(button => { button.disabled = false; }); status.classList.remove('unavailable');
  const auth = `wm auth login ${quote(platform.id)} --account ${quote(account)}`;
  let command;
  if (intent === 'draft.create') command = `wm draft create ${quote(file)} --platform ${quote(platform.id)} --account ${quote(account)} --json`;
  else if (intent === 'content.publish') command = `wm article publish ${quote(file)} --to ${quote(platform.id + ':' + account)} --json`;
  else if (intent === 'article.list') command = `wm article list --platform ${quote(platform.id)} --account ${quote(account)} --json`;
  else {
    command = `wm draft ${intent.split('.')[1]}${hasFile ? ' ' + quote(file) : ''} --platform ${quote(platform.id)} --account ${quote(account)} --base ${quote(base)} --json`;
  }
  byId('generated-command').textContent = `# 首次使用先登录\n${auth}\n\n${command}`;
  const content = hasFile ? `将 ${file} ` : '';
  const baseline = existing ? `先用 resource.get 读取目标草稿，将完整快照保存到 ${base}，核对远端变更。` : '';
  const intentGuard = intent === 'draft.create' || intent === 'draft.update' ? '只保存草稿。' : '';
  byId('natural-prompt').textContent = `使用 wm，${content}${intentLabels[intent]}，目标是${platform.name}的 ${account} 账号。先读取平台能力与指导，核对登录身份。${baseline}${hasFile ? '检查内容和图片，准备平台预览。' : ''}${intentGuard}返回资源 ID、执行回执和需要我处理的下一步。`;
  status.textContent = intent === 'article.list' ? '查询自己的内容，不创建文章。' : existing ? '更新沿用原资源。发现版本冲突时返回差异，重新核对后再建立计划。' : '命令在本机执行。先向 AI 说明内容与意图，再由它按实际契约补齐平台选项。';
}
function renderCatalog() {
  const search = byId('capability-search').value.trim().toLowerCase();
  const entries = state.platforms.flatMap(platform => platform.capabilities.map(capability => ({ platform, capability })))
    .filter(({ platform, capability }) => (state.filter === 'all' || state.filter === platform.id) && `${platform.name} ${platform.id} ${capability.id} ${capability.description}`.toLowerCase().includes(search));
  byId('capability-count').textContent = `${entries.length} 项能力 · 来自源码 {{VERSION}} 的注册契约`;
  const grid = byId('capability-grid'); grid.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '没有匹配的能力，试试其他关键词或平台。'; grid.append(empty); return;
  }
  const more = byId('expand-capabilities'); more.hidden = entries.length <= 6;
  more.textContent = state.expanded ? '收起能力 ↑' : `展开全部 ${entries.length} 项能力 ↓`;
  for (const { platform, capability } of state.expanded ? entries : entries.slice(0, 6)) {
    const card = document.createElement('article'); card.className = 'capability-card';
    const top = document.createElement('div'); top.className = 'capability-top';
    const name = document.createElement('span'); name.textContent = platform.name;
    const effect = document.createElement('span'); effect.className = 'effect'; effect.textContent = capability.effect === 'read' ? '只读' : '远端写入'; top.append(name, effect);
    const title = document.createElement('h3'); title.textContent = capability.id;
    const description = document.createElement('p'); description.textContent = capability.description;
    const foot = document.createElement('div'); foot.className = 'card-foot';
    const acceptance = document.createElement('span'); acceptance.className = 'acceptance';
    const flags = capability.acceptance;
    acceptance.textContent = [flags.offline ? '离线测试 ✓' : '离线待验收', flags.liveRead ? '线上读 ✓' : null, flags.liveWrite ? '线上写 ✓' : null].filter(Boolean).join(' · ');
    const inspect = document.createElement('button'); inspect.type = 'button'; inspect.textContent = '查看契约 ↗'; inspect.setAttribute('aria-label', `${platform.name} ${capability.id} 查看契约`);
    inspect.addEventListener('click', () => {
      byId('schema-title').textContent = `${platform.name} / ${capability.id}`;
      byId('schema-description').textContent = capability.description;
      byId('schema-json').textContent = JSON.stringify(capability, null, 2); byId('schema-dialog').showModal();
    });
    foot.append(acceptance, inspect); card.append(top, title, description, foot); grid.append(card);
  }
}
function recoveryDemo() {
  const { evidence, resumed } = state;
  document.querySelectorAll('[data-evidence]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.evidence === evidence)));
  const writeStep = byId('demo-write-step'); const observeStep = byId('demo-observe-step');
  writeStep.className = evidence === 'confirmed' || resumed ? 'done' : 'uncertain';
  writeStep.querySelector('span').textContent = evidence === 'confirmed' || resumed ? '✓' : '?';
  observeStep.className = resumed ? 'done' : ''; observeStep.querySelector('span').textContent = resumed ? '✓' : '4';
  byId('resume-demo').disabled = evidence === 'uncertain' || resumed;
  byId('resume-demo').textContent = resumed ? '已完成演示 ✓' : '继续原任务 →';
  const explanation = {
    uncertain: '缺少证据时保持 unknown。恢复不会重发这一步；草稿存在，也不能证明已经发表。',
    confirmed: '原提交已受理。将本步骤标为成功并跳过，只继续查询当前展示状态。',
    absent: '只有驱动提供明确的 not_applied 证据，才允许这一步重新执行。列表里暂时找不到文章不算证据。',
  };
  byId('recovery-explanation').textContent = resumed ? '演示完成：沿用原草稿和操作记录，历史提交事实与最新远端观察各自保存。' : explanation[evidence];
  byId('demo-write-label').textContent = resumed ? (evidence === 'confirmed' ? '已确认原文章 ID，跳过提交' : '按未应用证据继续该步骤') : evidence === 'confirmed' ? '回查确认原请求已受理' : evidence === 'absent' ? '明确未应用，允许继续该步骤' : '请求发出后断线，结果未知';
  byId('demo-observe-label').textContent = resumed ? '演示观察：文章已展示；保留历史回执' : '历史执行与当前观察分别记录';
}
let toastTimer;
function notify(message) {
  const toast = byId('copy-status'); toast.textContent = message; toast.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}
async function copyText(id) {
  const element = byId(id); const text = element.value ?? element.textContent;
  try { await navigator.clipboard.writeText(text); notify('已复制，可以交给你的 AI 了。'); }
  catch {
    // Clipboard permission can be denied. Select the exact output for an explicit manual copy.
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    notify('浏览器未允许复制，已选中文本，请手动复制。');
  }
}
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', () => copyText(button.dataset.copy)));
byId('command-form').addEventListener('submit', event => event.preventDefault());
byId('command-form').addEventListener('input', commandStudio);
byId('capability-search').addEventListener('input', renderCatalog);
byId('expand-capabilities').addEventListener('click', () => { state.expanded = !state.expanded; renderCatalog(); });
byId('close-schema').addEventListener('click', () => byId('schema-dialog').close());
document.querySelectorAll('[data-evidence]').forEach(button => button.addEventListener('click', () => { state.evidence = button.dataset.evidence; state.resumed = false; recoveryDemo(); }));
byId('resume-demo').addEventListener('click', () => { state.resumed = true; recoveryDemo(); });
byId('reset-demo').addEventListener('click', () => { state.evidence = 'uncertain'; state.resumed = false; recoveryDemo(); });
recoveryDemo();
async function loadCatalog() {
  try {
    const response = await fetch('./catalog.json');
    if (!response.ok) throw new Error('catalog ' + response.status);
    state.platforms = (await response.json()).platforms;
    const select = byId('platform-choice'); select.replaceChildren();
    for (const platform of state.platforms) { const option = document.createElement('option'); option.value = platform.id; option.textContent = platform.name; select.append(option); }
    select.disabled = false;
    for (const platform of [{ id: 'all', name: '全部平台' }, ...state.platforms]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = platform.name; button.dataset.platform = platform.id;
      button.setAttribute('aria-pressed', String(platform.id === state.filter));
      button.addEventListener('click', () => { state.filter = platform.id; document.querySelectorAll('[data-platform]').forEach(filter => filter.setAttribute('aria-pressed', String(filter.dataset.platform === state.filter))); renderCatalog(); });
      byId('platform-filters').append(button);
    }
    commandStudio(); renderCatalog();
  } catch {
    byId('natural-prompt').textContent = '能力契约暂时无法加载，请刷新页面或直接运行 wm schema --json。';
    byId('capability-count').textContent = '能力契约加载失败。页面需要通过 HTTP(S) 访问。';
  }
}
loadCatalog();
