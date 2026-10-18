import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { config } from './config.js';
import { sessionCookiesFile } from './moodle.js';

// Busca uma atividade com o "npm run atividade" do moodle-estudos (outro projeto, outro perfil de navegador).
// Quem decide buscar é o código do bot; o Claude continua sem ferramentas e só recebe o resultado como dado.

export type Resultado =
  | { status: 'ok'; titulo: string; md: string; imagens: string[]; arquivos: string[] }
  | { status: 'varios'; opcoes: { nome: string; tipo: string; disciplina: string; link: string }[] }
  | { status: 'nenhum' }
  | { status: 'erro'; mensagem: string };

export function estudosAvailable(): boolean {
  return !!config.estudosDir && existsSync(join(config.estudosDir, 'src', 'atividade.ts'));
}

// Ambiente do processo filho: o do sistema, sem as variáveis do .env do bot (o dotenv do moodle-estudos
// não sobrescreve variáveis que já existem, então um HEADLESS=false ou MODE=dom do bot vazaria para ele)
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const botEnv = join(process.cwd(), '.env');
  if (existsSync(botEnv)) for (const key of Object.keys(parse(readFileSync(botEnv)))) delete env[key];
  delete env.ANTHROPIC_API_KEY;
  return {
    ...env,
    MOODLE_URL: config.estudosMoodleUrl,
    HEADLESS: 'true',
    OUT_DIR: config.estudosOutDir ?? join(config.estudosDir!, 'materias'),
    PROFILE_DIR: config.estudosProfileDir ?? join(config.estudosDir!, '.moodle-profile'),
  };
}

// A busca usa outro perfil de navegador; leva junto a sessão atual do bot (que é salva quando muda),
// para um login refeito na janela do bot valer também para a busca. O ensaio com mock usa perfil próprio.
function shareSession() {
  if (config.estudosProfileDir || !existsSync(sessionCookiesFile)) return;
  const target = join(config.estudosDir!, '.moodle-profile');
  mkdirSync(target, { recursive: true });
  copyFileSync(sessionCookiesFile, join(target, 'moodle-cookies.json'));
}

export function fetchActivity(query: string): Promise<Resultado> {
  const dir = config.estudosDir!;
  shareSession();
  // node + cli do tsx com lista de argumentos: sem shell, então o texto vindo do chat não vira comando
  const tsxCli = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxCli)) return Promise.resolve({ status: 'erro', mensagem: `rode "npm install" em ${dir}` });

  return new Promise((ok) => {
    const child = spawn(process.execPath, [tsxCli, 'src/atividade.ts', '--json', query], { cwd: dir, env: childEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      ok({ status: 'erro', mensagem: `a busca passou de ${config.fetchTimeoutMs / 1000}s` });
    }, config.fetchTimeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      ok({ status: 'erro', mensagem: err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('@@RESULTADO '));
      if (!line) return ok({ status: 'erro', mensagem: (stderr || stdout).trim().split('\n').pop() || 'a busca terminou sem resultado' });
      try {
        ok(JSON.parse(line.slice('@@RESULTADO '.length)));
      } catch {
        ok({ status: 'erro', mensagem: 'resultado da busca ilegível' });
      }
    });
  });
}
