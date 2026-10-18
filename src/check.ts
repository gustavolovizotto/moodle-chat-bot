// Diagnóstico somente leitura: confere seletores e API do Moodle na conversa do .env. Não envia nada.
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { apiChannel, isSelfChat, openBrowser, openChat, readDom, settle } from './moodle.js';

const SEL = config.sel;
const short = (s: string) => (s.length > 70 ? `${s.slice(0, 70)}…` : s).replace(/\s+/g, ' ');

async function main() {
  const { context, page } = await openBrowser();
  await openChat(page);
  const self = await isSelfChat(page);
  console.log(`\nPágina: ${page.url()}${self ? '  (conversa consigo mesmo)' : ''}`);

  try {
    await settle(page);
  } catch {
    console.log(`!! O campo de digitar (${SEL.input}) não apareceu em 30s.`);
  }

  console.log('\n== Seletores (modo dom) ==');
  for (const [name, sel] of Object.entries({ message: SEL.message, text: SEL.text, input: SEL.input, send: SEL.send })) {
    const all = await page.locator(sel).count();
    const visible = await page.locator(`${sel}:visible`).count();
    console.log(`${all ? 'ok ' : 'XX '} ${name.padEnd(8)} ${sel}  ->  ${all} na página, ${visible} visíveis`);
  }
  const received = await page.locator(`${SEL.message}.${SEL.receivedClass}`).count();
  console.log(`${received ? 'ok ' : self ? '-- ' : 'XX '} received .${SEL.receivedClass}  ->  ${received} mensagens recebidas`);

  const dom = await readDom(page);
  console.log(`\n${dom.length} mensagens com ID numérico em "${SEL.idAttr}". Últimas:`);
  for (const m of dom.slice(-5)) console.log(`   #${m.id} ${m.mine ? 'enviada ' : 'recebida'}  ${short(m.text)}`);

  // Amostra do HTML para ajustar seletores à mão (fica só no seu PC, em debug/)
  const sample = await page.$$eval(SEL.message, (els) => els.slice(-3).map((el) => el.outerHTML).join('\n\n'));
  const container = await page.evaluate((sel) => {
    const first = document.querySelector(sel);
    return (first?.closest('[data-region="content-message-container"]') ?? first?.parentElement?.parentElement)?.outerHTML ?? document.body.outerHTML;
  }, SEL.message);
  mkdirSync('debug', { recursive: true });
  writeFileSync('debug/mensagens.html', sample || '(nenhuma mensagem encontrada)');
  writeFileSync('debug/conversa.html', container.slice(0, 300_000));
  console.log('\nHTML salvo em debug/mensagens.html e debug/conversa.html');

  console.log('\n== API do Moodle (modo api) ==');
  const cfg = await page.evaluate(() => {
    const c = (window as any).M?.cfg ?? {};
    return { userId: c.userId, theme: c.theme, hasRequire: typeof (window as any).require === 'function' };
  });
  console.log(`M.cfg.userId=${cfg.userId ?? '(ausente)'}  tema=${cfg.theme}  require=${cfg.hasRequire}`);
  let apiOk = false;
  try {
    const api = await apiChannel(page);
    const msgs = await api.read();
    apiOk = true;
    console.log(`ok  leitura pela API: ${msgs.length} mensagens. Últimas:`);
    for (const m of msgs.slice(-5)) console.log(`   #${m.id} ${m.mine ? 'enviada ' : 'recebida'}  ${short(m.text)}`);
  } catch (err) {
    console.log(`XX  API indisponível: ${(err as Error).message}`);
  }

  // Na conversa consigo mesmo não existe mensagem recebida; basta ler os balões
  const domOk = dom.length > 0 && (self || received > 0);
  console.log('\n== Resultado ==');
  if (apiOk) console.log('Use MODE=api (ou deixe auto).');
  else if (domOk) console.log('API falhou, mas a tela funciona: use MODE=dom.');
  else console.log('Nenhum modo confirmado. Mande uma mensagem de teste para esta conversa e rode de novo, ou ajuste os seletores no .env.');

  await context.close();
}

main().catch((err) => {
  console.error('!! Falha:', err.message);
  process.exit(1);
});
