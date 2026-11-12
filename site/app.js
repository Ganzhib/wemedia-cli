for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    const text = source instanceof HTMLTextAreaElement ? source.value : source.textContent;
    try {
      await navigator.clipboard.writeText(text);
      document.querySelector('#copy-status').textContent = '已复制，可以粘贴到终端或 Agent。';
    } catch {
      if (source instanceof HTMLTextAreaElement) {
        source.focus();
        source.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.querySelector('#copy-status').textContent = '浏览器未允许复制，已选中文本，请手动复制。';
    }
  });
}
