// Native confirm() is blocked in plotter-extension sandboxes. An HTML dialog
// works there, traps focus, supports Escape, and keeps the same confirmation
// in the standalone app. Text is never interpreted as HTML.
export function confirmAction(message, t) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirmation-dialog';
    dialog.setAttribute('aria-label', message);
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'sheet';
    const text = document.createElement('p');
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'sheet-row';
    for (const [value, label, className] of [
      ['cancel', t('common.cancel'), 'big-button'],
      ['confirm', t('common.delete'), 'big-button danger']
    ]) {
      const button = document.createElement('button');
      button.type = 'submit';
      button.value = value;
      button.textContent = label;
      button.className = className;
      button.autofocus = value === 'cancel';
      actions.append(button);
    }
    form.append(text, actions);
    dialog.append(form);
    dialog.addEventListener(
      'close',
      () => {
        const confirmed = dialog.returnValue === 'confirm';
        dialog.remove();
        resolve(confirmed);
      },
      { once: true }
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}
