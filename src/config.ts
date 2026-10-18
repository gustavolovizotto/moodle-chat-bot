import 'dotenv/config';
import { resolve } from 'node:path';

function num(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} precisa ser um número`);
  return value;
}

const chatUrl = process.env.MOODLE_CHAT_URL;
if (!chatUrl) throw new Error('Defina MOODLE_CHAT_URL no .env (copie de .env.example)');

const mode = process.env.MODE ?? 'auto';
if (!['auto', 'api', 'dom'].includes(mode)) throw new Error('MODE deve ser auto, api ou dom');

const DEFAULT_PERSONA =
  'Você responde mensagens recebidas em um chat do Moodle da UTFPR. ' +
  'Responda em português, de forma clara, educada e curta (no máximo 3 frases, a menos que peçam detalhes). ' +
  'Escreva texto simples, sem Markdown.';

// PERSONA=tutor: ajuda a estudar em vez de entregar a resposta
const TUTOR_PERSONA =
  'Você é um tutor de estudos conversando por um chat do Moodle da UTFPR, em português, com texto simples e sem Markdown. ' +
  'O aluno não consegue copiar as opções de questões de arrastar/selecionar, então nunca peça a lista de opções. ' +
  'Lacunas aparecem como "Em branco 1", "Em branco 2"... ' +
  'Se ele mandar a questão já com a resposta dele, avalie direto. Se mandar só a questão, não entregue a resposta: dê uma pista curta e peça a resposta dele. ' +
  'Quando o aluno responder, diga claramente se cada parte está certa ou errada. Se errou, explique o porquê e qual é a resposta correta, de forma breve. ' +
  'Se ele pedir só a resposta, incentive-o a tentar primeiro, mas depois de uma tentativa pode explicar.';

const PERSONAS: Record<string, string> = { padrao: DEFAULT_PERSONA, tutor: TUTOR_PERSONA };
const personaName = process.env.PERSONA ?? 'padrao';
if (!PERSONAS[personaName]) throw new Error(`PERSONA deve ser ${Object.keys(PERSONAS).join(' ou ')}`);

export const config = {
  chatUrl,
  mode: mode as 'auto' | 'api' | 'dom',
  model: process.env.CLAUDE_MODEL ?? 'haiku',
  // low | medium | high | xhigh | max (vazio = padrão do modelo)
  effort: process.env.CLAUDE_EFFORT || undefined,
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  claudeTimeoutMs: num('CLAUDE_TIMEOUT_MS', 120_000),
  pollMs: num('POLL_MS', 3000),
  reloadMs: num('RELOAD_MS', 20_000),
  historySize: num('HISTORY_SIZE', 12),
  headless: process.env.HEADLESS === 'true',
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
  profileDir: resolve(process.env.PROFILE_DIR ?? '.moodle-profile'),
  // Pasta vazia como diretório de trabalho do Claude Code (não expõe seus arquivos)
  sandboxDir: resolve('.claude-sandbox'),
  // Marca as respostas do bot: deixa claro que é IA e impede o bot de responder a si mesmo
  replyPrefix: process.env.REPLY_PREFIX ?? '🤖 ',
  // Conversa consigo mesmo: detectada sozinha quando o ?id= da URL é o seu; SELF_CHAT=true/false força
  selfChat: process.env.SELF_CHAT ? process.env.SELF_CHAT === 'true' : undefined,
  // Cinto de segurança contra loop/spam: acima disso o bot pausa as respostas por um minuto
  maxRepliesPerMin: num('MAX_REPLIES_PER_MIN', 6),
  userIdOverride: process.env.MOODLE_USER_ID ? Number(process.env.MOODLE_USER_ID) : undefined,
  // Busca de atividades pelo chat (só na conversa consigo mesmo): pasta do moodle-estudos; vazio desliga
  estudosDir: process.env.ESTUDOS_DIR === '' ? undefined : resolve(process.env.ESTUDOS_DIR ?? '../moodle-estudos'),
  // Moodle que o moodle-estudos deve usar (normalmente o mesmo do chat; o ensaio com mock aponta para outro)
  estudosMoodleUrl: process.env.ESTUDOS_MOODLE_URL ?? new URL(chatUrl).origin,
  // Perfil e pasta de saída do moodle-estudos (o ensaio com mock usa outros, para não tocar na sessão real)
  estudosProfileDir: process.env.ESTUDOS_PROFILE_DIR,
  estudosOutDir: process.env.ESTUDOS_OUT_DIR,
  fetchTimeoutMs: num('FETCH_TIMEOUT_MS', 240_000),
  // Resposta com o material da atividade: imagens e texto longo pedem mais tempo
  materialTimeoutMs: num('MATERIAL_TIMEOUT_MS', 300_000),
  maxImages: num('MAX_IMAGES', 8),
  persona: process.env.SYSTEM_PROMPT ?? PERSONAS[personaName],
  // Seletores da tela de mensagens do Moodle (só usados no modo dom; confira com `npm run check`)
  sel: {
    message: process.env.SEL_MESSAGE ?? '[data-region="message"]',
    idAttr: process.env.SEL_ID_ATTR ?? 'data-message-id',
    text: process.env.SEL_TEXT ?? '[data-region="text-container"]',
    input: process.env.SEL_INPUT ?? '[data-region="send-message-txt"]',
    send: process.env.SEL_SEND ?? '[data-action="send-message"]',
    receivedClass: process.env.RECEIVED_CLASS ?? 'received',
  },
};
