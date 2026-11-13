const scenarios = {
  share: { prompt: '使用已安装的 wm-cli（WeMedia 自媒体发布工具，npm 包名 @ganzhibin/wemedia-cli，命令为 wm）。先读取本机 wm Skill 和目标平台的使用指导，再把我提供的文章和图片准备到公众号与掘金。先检查内容、排版和目标账号，把预览给我看；等我确认后再发表，并告诉我各平台的结果。', steps: ['检查文章和图片是否齐全', '分别准备公众号与掘金的内容预览', '按确认后的安排发表，并返回结果'] },
  draft: { prompt: '使用已安装的 wm-cli（WeMedia 自媒体发布工具，npm 包名 @ganzhibin/wemedia-cli，命令为 wm）。先读取本机 wm Skill 和目标平台的使用指导，再把我提供的文章和配图保存到公众号草稿箱。先确认是我的目标账号，保留文章的排版，并把草稿结果给我查看。这次只存草稿，暂不发表。', steps: ['确认目标公众号，检查文章与配图', '准备排版，上传内容并保存为草稿', '返回草稿结果，留给你继续审阅'] },
  update: { prompt: '使用已安装的 wm-cli（WeMedia 自媒体发布工具，npm 包名 @ganzhibin/wemedia-cli，命令为 wm）。先读取本机 wm Skill 和目标平台的使用指导，再帮我修改公众号里的一篇已有草稿。先让我指定草稿和需要修改的内容，再核对当前版本。保留原来的草稿，按我的要求更新后给我查看，暂不发表。', steps: ['找到你指定的草稿，查看现有内容', '核对修改范围，准备更新后的预览', '更新原草稿，并告诉你保存结果'] },
};
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  const scenario = scenarios[button.dataset.scenario];
  document.querySelectorAll('[data-scenario]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  document.getElementById('scenario-prompt').textContent = scenario.prompt;
  document.getElementById('scenario-steps').replaceChildren(...scenario.steps.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
}));
// Measure the combined banner and navigation so anchors also work after mobile reflow.
const siteHeader = document.querySelector('.site-header');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--site-header-height', `${siteHeader.getBoundingClientRect().height}px`);
}).observe(siteHeader);

const promptDialog = document.getElementById('prompt-dialog');
const dialogContent = document.getElementById('prompt-dialog-content');
const dialogStatus = document.getElementById('prompt-dialog-status');
function openPrompt(source) {
  document.getElementById('prompt-dialog-title').textContent = source.dataset.title;
  dialogContent.textContent = source.textContent;
  dialogStatus.textContent = '复制给你的 AI 助手，并提供文章和图片。';
  promptDialog.showModal();
  document.querySelector('.prompt-dialog-body').scrollTop = 0;
}
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  openPrompt(document.getElementById(button.dataset.prompt));
}));
document.querySelector('.dialog-close').addEventListener('click', () => promptDialog.close());
promptDialog.addEventListener('click', event => {
  // The backdrop targets the dialog too; clicks within its padded surface must stay open.
  if (event.target !== promptDialog) return;
  const bounds = promptDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) promptDialog.close();
});

let toastTimer;
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  let element = document.getElementById(button.dataset.copy);
  let message = '已复制，粘贴给你的 AI 助手即可。';
  try { await navigator.clipboard.writeText(element.textContent); }
  catch {
    // Hidden platform prompts must be shown before selecting them for manual copying.
    if (element.hidden) {
      openPrompt(element);
      element = dialogContent;
    }
    const details = element.closest('details');
    if (details) details.open = true;
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    message = '已选中文本，请手动复制。';
  }
  if (promptDialog.open) dialogStatus.textContent = message;
  const toast = document.getElementById('copy-status'); toast.textContent = message; toast.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}));
