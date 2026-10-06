import { record } from 'rrweb';
import { expect, test } from 'vitest';

test('blocks credential-bearing text and image attributes in snapshots and mutations', async () => {
  const container = document.createElement('section');
  container.innerHTML = `
    <div>Visible analytics content</div>
    <div class="rr-block">
      <img src="data:image/png;base64,SYNTHETIC-TOTP-QR" alt="QR code" />
      <code>SYNTHETIC-TOTP-KEY</code>
      <code>SYNTHETIC-RECOVERY-CODE</code>
    </div>
  `;
  document.body.append(container);

  const events: unknown[] = [];
  const stop = record({
    emit: event => events.push(event),
    blockClass: 'rr-block',
    blockSelector: '.custom-block',
    maskAllInputs: true,
  });

  try {
    const initialSnapshot = JSON.stringify(events);
    expect(initialSnapshot).toContain('Visible analytics content');
    expect(initialSnapshot).not.toContain('SYNTHETIC-TOTP-QR');
    expect(initialSnapshot).not.toContain('SYNTHETIC-TOTP-KEY');
    expect(initialSnapshot).not.toContain('SYNTHETIC-RECOVERY-CODE');

    const laterDialog = document.createElement('div');
    laterDialog.className = 'rr-block';
    laterDialog.innerHTML = '<code>SYNTHETIC-LATE-RECOVERY-CODE</code>';
    container.append(laterDialog);

    const privateElement = container.querySelector('.rr-block');
    const code = privateElement?.querySelector('code');
    const image = privateElement?.querySelector('img');
    if (!code || !image) throw new Error('Missing synthetic private content');
    code.textContent = 'SYNTHETIC-UPDATED-KEY';
    image.src = 'data:image/png;base64,SYNTHETIC-UPDATED-QR';
    await new Promise(resolve => setTimeout(resolve, 20));

    const mutatedSnapshot = JSON.stringify(events);
    expect(mutatedSnapshot).not.toContain('SYNTHETIC-LATE-RECOVERY-CODE');
    expect(mutatedSnapshot).not.toContain('SYNTHETIC-UPDATED-KEY');
    expect(mutatedSnapshot).not.toContain('SYNTHETIC-UPDATED-QR');
  } finally {
    stop?.();
    container.remove();
  }
});
