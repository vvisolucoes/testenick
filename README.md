# Nicolaus English Platform — versão Firebase

Ferramenta de gestão de aulas particulares de inglês, com duas áreas: **Professor**
(alunos, atividades, aulas, financeiro) e **Aluno** (nivelamento, prática, tarefas).

Front-end estático (GitHub Pages) + Firebase (Auth + Firestore + Cloud Functions).
Sem build step — é só HTML/CSS/JS puro, abre direto no navegador.

## Estrutura

```
index.html             → TUDO do front-end (HTML + CSS + JS + config), um arquivo só —
                          igual ao padrão que vocês já usam nos outros produtos.
                          A config do Firebase fica logo no topo do <script>, em um
                          bloco fácil de achar e editar (mesma lógica do CONFIG do VVILink).
firestore.rules         → regras de segurança (quem pode ler/escrever o quê)
firestore.indexes.json  → índices do Firestore (vazio por enquanto)
firebase.json           → config do Firebase CLI (rules + functions)
functions/               → ESTA continua sendo uma pasta de verdade — é uma exigência
  index.js                do Firebase, não uma escolha minha. Cloud Functions rodam no
  package.json            servidor do Google, não no navegador, então não têm como
                           entrar dentro do index.html. Essa pasta nem vai pro GitHub
                           Pages (ver "Como isso tudo se conecta" abaixo).
```

**Onde cada coisa mexe:** só existem dois lugares para editar. (1) O bloco `firebaseConfig`
no topo do `<script>` do `index.html` — as chaves públicas do seu projeto. (2) Dentro de
`functions/index.js`, se um dia precisar mudar a lógica das Cloud Functions.

## Como isso tudo se conecta (leia antes de começar)

Tem duas coisas completamente separadas acontecendo aqui, e é fácil confundir:

1. **GitHub Pages** só serve arquivos estáticos. Ele lê o `index.html` da raiz do
   repositório e pronto — é só isso que ele sabe fazer. Um `git push` (ou arrastar o
   arquivo pela interface do GitHub) já é suficiente pra esse arquivo ficar no ar.
2. **Firebase** (Auth + Firestore + Cloud Functions) é outra infraestrutura, hospedada
   pelo Google, e **não é publicada via GitHub**. Ela é publicada rodando comandos do
   Firebase CLI no seu computador (`firebase deploy`), que enviam o conteúdo de
   `firestore.rules` e da pasta `functions/` direto pros servidores do Google.

Ou seja: o repositório no GitHub é só onde o código *mora e fica versionado*. Colocar
os arquivos lá não "ativa" nada sozinho — o `index.html` fica no ar assim que você
liga o GitHub Pages, mas as regras e as functions só passam a valer depois que você
roda os comandos `firebase deploy` (passo 5 abaixo), a partir do seu computador.

## 1. Criar o projeto Firebase

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) → **Criar projeto**.
2. Ative o **plano Blaze** (pago sob uso) — necessário porque as Cloud Functions
   fazem chamadas de rede externas (para a API da Anthropic). O uso de uma
   tutoria particular deve ficar dentro (ou muito próximo) da faixa gratuita
   do Blaze; confira os preços atuais em firebase.google.com/pricing.
3. **Authentication** → aba "Sign-in method" → ative **E-mail/senha**.
4. **Firestore Database** → **Criar banco de dados** → modo produção → escolha
   a região (ex: `southamerica-east1` para o Brasil).

## 2. Preencher a config do Firebase dentro do `index.html`

Abra `index.html`, procure por `const firebaseConfig = {` (fica logo no topo do
`<script>`, é o primeiro bloco). Em **Configurações do projeto → Geral → Seus apps →
</> (Web)** no Firebase Console, registre um app e copie os valores para dentro
desse bloco. Esses valores **não são segredos** — podem ficar públicos no repositório.

## 3. Instalar o Firebase CLI e logar

```bash
npm install -g firebase-tools
firebase login
```

Na pasta do projeto:

```bash
firebase use --add
# selecione o projeto que você criou
```

## 4. Configurar a chave da Anthropic (segredo, NUNCA vai pro repositório)

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
# cole a chave quando solicitado
```

Isso guarda a chave no Secret Manager do Google Cloud — só a Cloud Function
`gradeWriting` consegue lê-la, em tempo de execução, no servidor.

## 5. Instalar dependências e publicar

```bash
cd functions
npm install
cd ..

firebase deploy --only firestore:rules
firebase deploy --only functions
```

## 6. Publicar o front-end no GitHub Pages

1. Crie um repositório novo no GitHub e envie todos os arquivos deste projeto
   (menos `functions/node_modules`, já coberto pelo `.gitignore`).
2. Em **Settings → Pages**, escolha a branch `main` e a pasta raiz (`/`).
3. Acesse a URL gerada pelo GitHub Pages.

## 7. Primeiro acesso (configurar o professor)

Abra o site publicado → **Área do Professor**. Como nenhum professor existe
ainda, a tela vai pedir para você criar essa conta (e-mail + senha) — essa é
a **única vez** que existe um formulário de "criar conta" na ferramenta; a
partir daí, só login. Guarde essa senha — não há recuperação automática por
aqui (sem servidor de e-mail configurado).

## 8. Cadastrando alunos

Dentro da Área do Professor → **Alunos → Novo aluno**. Você define o nome e
uma senha inicial. O campo de e-mail é opcional:

- **Deixe em branco** (recomendado para a maioria dos casos): a ferramenta
  gera um identificador de login interno automaticamente. O aluno nunca
  precisa saber ou digitar esse valor — ele só escolhe o próprio nome na
  tela de login e digita a senha.
- **Preencha com o e-mail real do aluno** apenas se quiser habilitar
  recuperação de senha por e-mail no futuro (ainda não implementada nesta
  versão, mas deixa o caminho aberto). Lembre-se: esse e-mail fica visível
  publicamente no "diretório" usado pela tela de login (ver seção de
  segurança abaixo) — avalie se isso é aceitável para o seu contexto.

No primeiro login, o aluno é obrigado a trocar a senha.

## Segurança — o que muda em relação à versão em artefato

- **Isolamento real entre alunos**: aplicado no servidor via
  `firestore.rules` (não só na tela). Um aluno autenticado só lê/escreve os
  próprios documentos; o professor (identificado por uma *custom claim*
  `role: 'professor'`, atribuída apenas pela Cloud Function `bootstrapProfessor`)
  tem acesso completo.
- **Coleção pública `directory`**: contém só `name`, `level` e o e-mail de
  login de cada aluno (sintético ou real, conforme você escolheu no
  cadastro) — usada exclusivamente para montar a lista "quem é você?" antes
  do login. Não expõe pagamentos, aulas ou atividades.
- **A config do Firebase dentro do `index.html` fica pública** — isso é esperado e
  não é uma falha: esses valores identificam o projeto, não autenticam nada sozinhos.
- **A chave da Anthropic nunca chega ao navegador** — fica só no Secret
  Manager, usada pela Cloud Function `gradeWriting`.
- **Sem recuperação de senha automática** ainda (nem para professor, nem
  para aluno com e-mail sintético). Se alguém esquecer a senha:
  - Professor esqueceu: resete manualmente pelo Firebase Console
    (Authentication → usuário → "Redefinir senha") ou me chame para ajudar.
  - Aluno esqueceu: professor usa **Alunos → editar → Redefinir senha**.

## Limitações conhecidas (trade-offs conscientes)

- Sem "esqueci minha senha" via e-mail (ver acima).
- Um aluno pode, tecnicamente, inflar o próprio resultado de nivelamento
  editando o próprio documento (a regra permite `isSelf` escrever em
  `students/{uid}`) — não é uma falha de privacidade entre alunos (cada um
  só toca o próprio documento), só um limite de integridade dos dados que o
  professor sempre pode conferir e corrigir.
- Sem atualização em tempo real (a tela recarrega os dados após cada ação,
  não usa `onSnapshot`) — suficiente para o volume de uma tutoria particular,
  mas pode ser adicionado depois se fizer falta.
