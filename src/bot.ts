import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { askClaude, askClaudeWithMaterial, EXPLANATION_SENTINEL, FETCH_SENTINEL, type Turn } from './claude.js';
import { config } from './config.js';
import { estudosAvailable, fetchActivity } from './estudos.js';
import { connect, isSelfChat, onLoginScreen, openBrowser, openChat, saveSessionIfChanged, type ChatMsg } from './moodle.js';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const marker = config.replyPrefix.trim();
const sentByBot = new Set<string>();
const replyTimes: number[] = [];
let selfChat = false;

// Trava contra loop: ignora qualquer texto com a marca do bot ou que o bot enviou
function isFromBot(m: ChatMsg): boolean {
  return (marker !== '' && m.text.startsWith(marker)) || sentByBot.has(norm(m.text));
}

// Na conversa consigo mesmo tudo é "seu", então só a marca separa o que o bot escreveu
function isIncoming(m: ChatMsg): boolean {
  return (selfChat || !m.mine) && !isFromBot(m);
}

function toTurn(m: ChatMsg): Turn {
  if (isIncoming(m)) return { from: 'contato', text: m.text };
  return { from: 'voce', text: m.text.replace(marker, '').trim() };
}

function overRateLimit(): boolean {
  const now = Date.now();
  while (replyTimes.length && now - replyTimes[0] > 60_000) replyTimes.shift();
  return replyTimes.length >= config.maxRepliesPerMin;
}

// Mensagens longas viram várias, cortadas em parágrafos (o chat do Moodle não lida bem com textos enormes)
function chunks(text: string, max = 3000): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${para}` : para;
    while (cur.length > max) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Link de atividade ou de tentativa do próprio Moodle colado na mensagem: busca direto, sem perguntar ao Claude
function moodleLink(text: string): string | undefined {
  const origin = config.estudosMoodleUrl.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  const re = new RegExp(`${origin}/mod/(\\w+/view|quiz/attempt|quiz/review)\\.php\\?[^\\s]+`);
  return re.exec(text)?.[0];
}

async function main() {
  const { context, page } = await openBrowser();
  // Fechar a janela do navegador encerra o bot (em vez de ficar rodando sem conseguir ler o chat)
  context.on('close', () => {
    console.log('>> Janela do navegador fechada. Bot encerrado.');
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    console.log('\n>> Encerrando...');
    await context.close().catch(() => {});
    process.exit(0);
  });

  await openChat(page);
  selfChat = await isSelfChat(page);
  if (selfChat && !marker) throw new Error('Na conversa consigo mesmo o REPLY_PREFIX não pode ser vazio (é ele que evita o loop).');
  let chat = await connect(page);

  async function reply(text: string) {
    // Respostas e explicação viram mensagens separadas: primeiro as respostas, depois a explicação
    const [answers, ...rest] = text.split(new RegExp(`^\\s*${EXPLANATION_SENTINEL}\\s*$`, 'm'));
    const explanation = rest.join('\n').trim();
    if (explanation) {
      await reply(`Respostas:\n${answers.trim()}`);
      return reply(`Explicação:\n${explanation}`);
    }
    for (const part of chunks(text.replaceAll(EXPLANATION_SENTINEL, '').trim())) {
      const msg = config.replyPrefix + part;
      sentByBot.add(norm(msg));
      await chat.send(msg);
      console.log(`>> ${msg}`);
    }
  }

  // Busca a atividade e responde com o material; quem decide e executa a busca é este código, não o Claude
  async function answerWithActivity(query: string, history: Turn[]): Promise<string> {
    await reply(`Buscando "${query}" no Moodle (leva uns 30 segundos)...`);
    const res = await fetchActivity(query);
    console.log(`>> busca "${query}": ${res.status}`);
    if (res.status === 'nenhum') return `Não achei nenhuma atividade visível com "${query}". Me mande outra parte do nome ou o link da atividade.`;
    if (res.status === 'erro') return `Não consegui buscar a atividade: ${res.mensagem}`;
    if (res.status === 'varios') {
      const list = res.opcoes.map((o) => `- [${o.tipo}] ${o.nome} (${o.disciplina})\n  ${o.link}`).join('\n');
      return `Achei ${res.opcoes.length} atividades com "${query}". Qual delas? Pode mandar o link:\n${list}`;
    }
    const answer = await askClaudeWithMaterial(history, { titulo: res.titulo, texto: readFileSync(res.md, 'utf8'), imagens: res.imagens });
    // O texto da atividade não pode disparar outra busca
    return answer.trim().startsWith(FETCH_SENTINEL) ? 'Não consegui responder com o conteúdo da atividade. Tente reformular o pedido.' : answer;
  }

  // Ignora o que já estava no chat ao iniciar. Na conversa consigo mesmo, a última mensagem sua que ficou sem
  // resposta (mandada com o bot parado) é respondida; numa conversa com outra pessoa, nada antigo é respondido.
  const initial = await chat.read();
  const last = initial.at(-1);
  const pending = selfChat && last && last.text && isIncoming(last) ? last : undefined;
  const seen = new Set(initial.filter((m) => m !== pending).map((m) => m.id));
  console.log(`>> Conectado ao chat via ${chat.name} (${seen.size} mensagens antigas ignoradas). Modelo: ${config.model}.`);
  if (pending) console.log('>> A última mensagem ficou sem resposta: respondendo agora.');
  if (selfChat) console.log('>> Conversa consigo mesmo: responde toda mensagem sem a marca do bot.');
  if (selfChat) console.log(estudosAvailable() ? `>> Busca de atividades ligada (${config.estudosDir}).` : '>> Busca de atividades desligada (moodle-estudos não encontrado; ESTUDOS_DIR).');

  while (true) {
    try {
      if (onLoginScreen(page.url())) {
        console.warn('!! A sessão do Moodle caiu. Refaça o login na janela.');
        await openChat(page);
        chat = await connect(page);
      }

      const msgs = await chat.read();
      // Login refeito na janela troca o cookie de sessão: salva, senão o próximo início volta com a sessão antiga
      if (await saveSessionIfChanged(context)) console.log('>> Sessão do Moodle renovada e salva.');
      const fresh = msgs.filter((m) => !seen.has(m.id));
      fresh.forEach((m) => seen.add(m.id));

      // Várias mensagens recebidas no mesmo ciclo viram uma única resposta
      const incoming = fresh.filter((m) => m.text && isIncoming(m));
      if (incoming.length) {
        incoming.forEach((m) => console.log(`<< ${m.text}`));
        if (overRateLimit()) {
          console.warn(`!! Mais de ${config.maxRepliesPerMin} respostas no último minuto: ignorando para evitar loop/spam.`);
        } else {
          const started = Date.now();
          replyTimes.push(Date.now());
          const history = msgs.slice(-config.historySize).map(toTurn);
          // Busca de atividades só na conversa consigo mesmo: ninguém mais consegue puxar o conteúdo das suas disciplinas
          const allowFetch = selfChat && estudosAvailable();
          const link = allowFetch ? moodleLink(incoming.map((m) => m.text).join('\n')) : undefined;
          let answer: string;
          if (link) {
            answer = await answerWithActivity(link, history);
          } else {
            answer = await askClaude(history, { allowFetch });
            const asked = answer.trim();
            // Só a primeira resposta pode pedir busca, e só uma vez por mensagem
            if (allowFetch && asked.startsWith(FETCH_SENTINEL)) {
              const query = asked.slice(FETCH_SENTINEL.length).split('\n')[0].trim().slice(0, 300);
              answer = query ? await answerWithActivity(query, history) : 'Qual atividade? Me mande o nome ou o link.';
            } else if (asked.startsWith(FETCH_SENTINEL)) {
              answer = 'A busca de atividades só funciona na conversa consigo mesmo.';
            }
          }
          await reply(answer);
          console.log(`>> [${((Date.now() - started) / 1000).toFixed(1)}s]`);
        }
      }
    } catch (err) {
      // Sem nova tentativa: a mensagem já está marcada como vista, então uma falha não vira rajada de respostas
      console.error('!! Erro no ciclo:', (err as Error).message);
    }
    await sleep(config.pollMs);
  }
}

main().catch((err) => {
  console.error('!! Falha ao iniciar:', err.message);
  process.exit(1);
});
