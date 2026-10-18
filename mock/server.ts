// Moodle de mentira para ensaiar o bot sem a UTFPR. Imita a tela /message/index.php e os 3 web services usados.
// Só prova que o bot funciona contra ESTA imitação; os seletores reais se confirmam com `npm run check`.
//   npm run mock
//   MOODLE_CHAT_URL=http://localhost:4747/message/index.php?id=3
//   curl -X POST localhost:4747/mock/receive -d "Oi, tudo bem?"   (simula o contato escrevendo)
import { createServer, type IncomingMessage } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4747);
const ME = 2;
const OTHER = 3;
const CONV = 1;

type Msg = { id: number; useridfrom: number; text: string; timecreated: number };
let nextId = 100;
const messages: Msg[] = [];

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Igual ao Moodle com texto puro: escapa e troca quebra de linha por <br>
const add = (from: number, text: string) => {
  const m = { id: nextId++, useridfrom: from, text: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`, timecreated: Date.now() / 1000 };
  messages.push(m);
  console.log(`[mock] #${m.id} de ${from === ME ? 'bot' : 'contato'}: ${text}`);
  return m;
};
add(OTHER, 'Mensagem antiga: o bot NÃO deve responder esta.');
add(ME, 'Resposta antiga minha.');

const body = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => ok(data));
  });

function service(methodname: string, args: any): unknown {
  switch (methodname) {
    case 'core_message_get_conversation_between_users':
      if (args.userid !== ME || args.otheruserid !== OTHER) throw new Error('conversa inexistente');
      return { id: CONV, members: [], messages: [] };
    case 'core_message_get_self_conversation':
      if (args.userid !== ME) throw new Error('parâmetros inválidos');
      return { id: CONV, members: [], messages: [] };
    case 'core_message_get_conversation_messages': {
      if (args.currentuserid !== ME || args.convid !== CONV) throw new Error('parâmetros inválidos');
      const list = [...messages].sort((a, b) => (args.newest ? b.id - a.id : a.id - b.id));
      return { id: CONV, members: [], messages: list.slice(args.limitfrom ?? 0, (args.limitfrom ?? 0) + (args.limitnum || list.length)) };
    }
    case 'core_message_send_messages_to_conversation':
      if (args.conversationid !== CONV) throw new Error('conversa inexistente');
      return args.messages.map((m: { text: string }) => add(ME, m.text));
    default:
      throw new Error(`método desconhecido: ${methodname}`);
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Mensagens (mock)</title>
<style>body{font-family:sans-serif;max-width:640px;margin:2rem auto}.message{padding:.5rem;margin:.3rem 0;border-radius:8px;max-width:80%}
.send{background:#dbeafe;margin-left:auto}.received{background:#eee}textarea{width:100%;height:4rem}</style>
<script>
  window.M = { cfg: { wwwroot: location.origin, sesskey: 'mock', userId: ${ME}, theme: 'mock' } };
  // Imita o RequireJS do Moodle só para o módulo core/ajax
  window.require = (deps, ok) => ok({
    call: (reqs) => reqs.map((r) =>
      fetch('/lib/ajax/service.php?sesskey=mock&info=' + r.methodname, { method: 'POST', body: JSON.stringify([{ index: 0, methodname: r.methodname, args: r.args }]) })
        .then((res) => res.json())
        .then(([first]) => { if (first.error) throw first.exception; return first.data; })),
  });
</script></head><body>
<h3>Conversa com Contato (mock)</h3>
<div data-region="content-message-container"></div>
<textarea data-region="send-message-txt"></textarea>
<button data-action="send-message">Enviar</button>
<script>
  const box = document.querySelector('[data-region="content-message-container"]');
  async function render() {
    const msgs = await fetch('/mock/state').then((r) => r.json());
    box.innerHTML = msgs.map((m) => '<div class="message ' + (m.useridfrom === ${ME} ? 'send' : 'received') +
      '" data-region="message" data-message-id="' + m.id + '"><div data-region="text-container">' + m.text + '</div></div>').join('');
  }
  setTimeout(() => { render(); setInterval(render, 1000); }, 1500); // atraso inicial imita o carregamento do Moodle
  document.querySelector('[data-action="send-message"]').onclick = async () => {
    const input = document.querySelector('[data-region="send-message-txt"]');
    await fetch('/mock/send', { method: 'POST', body: input.value });
    input.value = '';
    render();
  };
</script></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const json = (data: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET' && url.pathname === '/message/index.php') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && url.pathname === '/mock/state') return json(messages);
  // Também simula você escrevendo na conversa consigo mesmo
  if (req.method === 'POST' && url.pathname === '/mock/send') return json(add(ME, await body(req)));
  if (req.method === 'POST' && url.pathname === '/mock/receive') return json(add(OTHER, await body(req)));
  if (req.method === 'POST' && url.pathname === '/lib/ajax/service.php') {
    const [call] = JSON.parse(await body(req));
    try {
      return json([{ error: false, data: service(call.methodname, call.args) }]);
    } catch (err) {
      return json([{ error: true, exception: { message: (err as Error).message, errorcode: 'mock' } }]);
    }
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`[mock] Moodle falso em http://localhost:${PORT}/message/index.php?id=${OTHER}`));
