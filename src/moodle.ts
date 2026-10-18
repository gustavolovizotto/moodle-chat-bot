import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';

export type ChatMsg = { id: string; mine: boolean; text: string };

// Duas formas de falar com a conversa:
// - api: chama os web services AJAX do próprio Moodle de dentro da página logada (rápido, IDs e autor confiáveis)
// - dom: lê e digita na tela de mensagens usando os seletores do .env
export interface ChatChannel {
  name: 'api' | 'dom';
  read(): Promise<ChatMsg[]>;
  send(text: string): Promise<void>;
}

const SEL = config.sel;
const moodleOrigin = new URL(config.chatUrl).origin;

// O cookie MoodleSession não tem validade e o Chromium o apaga ao fechar; guardamos à parte para não pedir login sempre
const cookiesFile = join(config.profileDir, 'moodle-cookies.json');

export async function openBrowser() {
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    channel: config.browserChannel,
    viewport: null,
  });
  if (existsSync(cookiesFile)) await context.addCookies(JSON.parse(readFileSync(cookiesFile, 'utf8'))).catch(() => {});
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

export async function saveSession(context: BrowserContext) {
  writeFileSync(cookiesFile, JSON.stringify(await context.cookies(moodleOrigin)));
}

export const sessionCookiesFile = cookiesFile;

// Salva a sessão só se o cookie mudou (ex.: o usuário saiu e entrou de novo na janela do bot)
let lastSession: string | undefined;
export async function saveSessionIfChanged(context: BrowserContext): Promise<boolean> {
  const current = (await context.cookies(moodleOrigin)).find((c) => c.name === 'MoodleSession')?.value;
  if (!current) return false;
  if (lastSession === undefined && existsSync(cookiesFile)) {
    lastSession = (JSON.parse(readFileSync(cookiesFile, 'utf8')) as { name: string; value: string }[]).find((c) => c.name === 'MoodleSession')?.value;
  }
  if (current === lastSession) return false;
  await saveSession(context);
  lastSession = current;
  return true;
}

export function onLoginScreen(url: string): boolean {
  const u = new URL(url);
  return (
    u.origin !== moodleOrigin ||
    u.pathname.startsWith('/login/') ||
    u.pathname.startsWith('/auth/') ||
    u.pathname.startsWith('/admin/oauth2callback')
  );
}

export async function openChat(page: Page) {
  await page.goto(config.chatUrl, { waitUntil: 'domcontentloaded' });
  if (!onLoginScreen(page.url())) return saveSession(page.context());
  if (config.headless) throw new Error('Sessão do Moodle expirada: rode com HEADLESS=false e faça login na janela.');
  console.log('>> Faça login no Moodle na janela do navegador. Aguardando...');
  console.log('   (prefira usuário e senha: o botão do Google costuma recusar navegador automatizado)');
  await page.waitForURL((u) => !onLoginScreen(u.href), { timeout: 0 });
  await saveSession(page.context());
  await page.goto(config.chatUrl, { waitUntil: 'domcontentloaded' });
}

// Escolhe api ou dom conforme MODE (auto tenta a api e cai para a tela)
export async function connect(page: Page): Promise<ChatChannel> {
  if (config.mode !== 'dom') {
    try {
      const channel = await apiChannel(page);
      await channel.read();
      return channel;
    } catch (err) {
      if (config.mode === 'api') throw err;
      console.warn(`>> API do Moodle indisponível (${(err as Error).message}); usando a leitura da tela.`);
    }
  }
  await settle(page);
  return domChannel(page);
}

// ---------- Modo api ----------
async function moodleAjax<T>(page: Page, methodname: string, args: object): Promise<T> {
  return page.evaluate(
    async ({ methodname, args }) => {
      const w = window as any;
      const ajax: any = await new Promise((ok, fail) => w.require(['core/ajax'], ok, fail));
      try {
        return await ajax.call([{ methodname, args }])[0];
      } catch (e: any) {
        throw new Error(`${methodname}: ${e?.message ?? e?.errorcode ?? JSON.stringify(e)}`);
      }
    },
    { methodname, args },
  );
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

async function loggedUserId(page: Page): Promise<number | null> {
  return config.userIdOverride ?? (await page.evaluate(() => (window as any).M?.cfg?.userId ?? null));
}

// Conversa consigo mesmo (espaço pessoal do Moodle): todas as mensagens são "suas"
export async function isSelfChat(page: Page): Promise<boolean> {
  if (config.selfChat !== undefined) return config.selfChat;
  const me = await loggedUserId(page);
  return !!me && Number(new URL(config.chatUrl).searchParams.get('id')) === me;
}

export async function apiChannel(page: Page): Promise<ChatChannel> {
  const me = await loggedUserId(page);
  if (!me) throw new Error('não achei o id do usuário logado (M.cfg.userId); defina MOODLE_USER_ID');

  const url = new URL(config.chatUrl);
  let convid = Number(url.searchParams.get('convid'));
  if (!convid) {
    const otheruserid = Number(url.searchParams.get('id'));
    if (!otheruserid) throw new Error('MOODLE_CHAT_URL precisa ter ?id=<usuário> ou ?convid=<conversa>');
    const conv =
      otheruserid === me
        ? await moodleAjax<{ id: number } | null>(page, 'core_message_get_self_conversation', { userid: me })
        : await moodleAjax<{ id: number }>(page, 'core_message_get_conversation_between_users', { userid: me, otheruserid });
    if (!conv?.id) throw new Error('conversa não encontrada');
    convid = conv.id;
  }

  return {
    name: 'api',
    async read() {
      const res = await moodleAjax<{ messages: { id: number; useridfrom: number; text: string }[] }>(
        page,
        'core_message_get_conversation_messages',
        { currentuserid: me, convid, limitfrom: 0, limitnum: config.historySize, newest: true },
      );
      return res.messages
        .sort((a, b) => a.id - b.id)
        .map((m) => ({ id: String(m.id), mine: m.useridfrom === me, text: htmlToText(m.text) }));
    },
    async send(text) {
      // textformat 2 = texto puro (o Moodle não interpreta HTML da resposta)
      await moodleAjax(page, 'core_message_send_messages_to_conversation', {
        conversationid: convid,
        messages: [{ text, textformat: 2 }],
      });
    },
  };
}

// ---------- Modo dom ----------
export async function readDom(page: Page): Promise<ChatMsg[]> {
  const raw = await page.$$eval(
    SEL.message,
    (els, s) =>
      els.map((el) => ({
        id: el.getAttribute(s.idAttr) ?? '',
        received: el.classList.contains(s.receivedClass),
        text: (el.querySelector(s.text)?.textContent ?? '').trim(),
      })),
    SEL,
  );
  // Só IDs numéricos reais: mensagens ainda sendo enviadas (sem ID) ou duplicadas na tela são ignoradas.
  // Se a classe de "recebida" não bater, tudo vira "minha" e o bot fica quieto em vez de entrar em loop.
  const byId = new Map<string, ChatMsg>();
  for (const m of raw) if (/^\d+$/.test(m.id)) byId.set(m.id, { id: m.id, mine: !m.received, text: m.text });
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

// Espera a conversa terminar de carregar (quantidade de mensagens estável por alguns segundos)
export async function settle(page: Page) {
  await page.locator(`${SEL.input}:visible`).first().waitFor({ timeout: 30_000 });
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 15 && stable < 3; i++) {
    const count = await page.locator(SEL.message).count();
    stable = count === last && count > 0 ? stable + 1 : 0;
    last = count;
    await page.waitForTimeout(1000);
  }
}

function domChannel(page: Page): ChatChannel {
  let lastReload = Date.now();
  return {
    name: 'dom',
    async read() {
      // A tela do Moodle espaça a própria atualização (back-off de minutos); recarregar garante as novas
      if (Date.now() - lastReload > config.reloadMs) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        lastReload = Date.now();
        if (onLoginScreen(page.url())) return [];
        await settle(page);
      }
      return readDom(page);
    },
    async send(text) {
      await page.locator(`${SEL.input}:visible`).first().fill(text);
      await page.locator(`${SEL.send}:visible`).first().click();
      // O Moodle limpa o campo quando a mensagem foi aceita
      await page.waitForFunction(
        (sel) => [...document.querySelectorAll<HTMLTextAreaElement>(sel)].every((el) => !el.value),
        SEL.input,
        { timeout: 15_000 },
      );
    },
  };
}
